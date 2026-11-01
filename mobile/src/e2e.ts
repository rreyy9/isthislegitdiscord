import * as ExpoCrypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { p256 } from '@noble/curves/nist.js';
import { gcm, aeskw } from '@noble/ciphers/aes.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { api } from './api';
import type { Attachment, DmDevice, Message, MessageRef } from './types';

/**
 * End-to-end encryption for direct messages, on the phone.
 *
 * The same scheme, byte for byte, as the desktop client's `e2e.ts` -- which
 * is where the reasoning lives. This side has no WebCrypto, so the primitives
 * come from the `@noble` libraries instead, and each one is matched to what
 * WebCrypto produces:
 *
 * - ECDH: WebCrypto's `deriveBits` is the shared point's x coordinate; noble
 *   hands back the compressed point, whose first byte is dropped.
 * - Public keys: WebCrypto exports SPKI DER, which for P-256 is a fixed
 *   26-byte header in front of the 65-byte uncompressed point.
 * - ECDSA: both are raw r||s over SHA-256. WebCrypto does not normalise `s`
 *   and noble refuses a high `s` by default, so verifying allows both.
 * - AES-KW and AES-GCM are the standard constructions on both sides, the GCM
 *   tag appended to the ciphertext.
 *
 * The phone is its own device with its own keys, kept in SecureStore -- the
 * Android Keystore -- so it reads what was sent after it was set up, and
 * messages from before then say so.
 */

// noble draws its randomness from `crypto.getRandomValues`, which Hermes does
// not have. expo-crypto's comes from the platform's secure generator.
const g = globalThis as { crypto?: { getRandomValues?: unknown } };
if (!g.crypto?.getRandomValues) {
  g.crypto = { ...(g.crypto ?? {}), getRandomValues: ExpoCrypto.getRandomValues };
}

export interface SealedFile {
  name: string;
  fileName: string;
  contentType: string;
  size: number;
  width: number | null;
  height: number | null;
  key: string;
  iv: string;
}

export interface SealedBody {
  content: string;
  files?: SealedFile[];
}

interface Envelope {
  v: 1;
  dev: string;
  eph: string;
  iv: string;
  ct: string;
  keys: Record<string, string>;
  sig: string;
}

interface Identity {
  userId: string;
  deviceId: string;
  encPrivate: Uint8Array;
  encPublic: string;
  sigPrivate: Uint8Array;
  sigPublic: string;
}

const WRAP_INFO = utf8('isthislegit e2e v1 wrap');
const SPKI_P256 = hex('3059301306072a8648ce3d020106082a8648ce3d030107034200');

let identity: Identity | null = null;
let ready: Promise<Identity | null> | null = null;
let registered = false;

/* -------------------------------------------------------------- identity */

/** Load this phone's keys for the account, making them the first time. */
export function initE2e(userId: string): Promise<Identity | null> {
  if (identity?.userId === userId) return Promise.resolve(identity);
  if (ready) return ready;
  ready = (async () => {
    try {
      const key = `e2e-identity-${userId.replace(/[^A-Za-z0-9._-]/g, '_')}`;
      const stored = await SecureStore.getItemAsync(key);
      let id: Identity;
      if (stored) {
        const s = JSON.parse(stored);
        id = {
          userId,
          deviceId: s.deviceId,
          encPrivate: unb64(s.encPrivate),
          encPublic: s.encPublic,
          sigPrivate: unb64(s.sigPrivate),
          sigPublic: s.sigPublic,
        };
      } else {
        const encPrivate = p256.utils.randomSecretKey();
        const sigPrivate = p256.utils.randomSecretKey();
        id = {
          userId,
          deviceId: ExpoCrypto.randomUUID(),
          encPrivate,
          encPublic: b64(spki(p256.getPublicKey(encPrivate, false))),
          sigPrivate,
          sigPublic: b64(spki(p256.getPublicKey(sigPrivate, false))),
        };
        // Saved before it is registered, as on the desktop: the other order
        // could leave messages sealed to a key that never reached the disk.
        await SecureStore.setItemAsync(
          key,
          JSON.stringify({
            deviceId: id.deviceId,
            encPrivate: b64(id.encPrivate),
            encPublic: id.encPublic,
            sigPrivate: b64(id.sigPrivate),
            sigPublic: id.sigPublic,
          }),
        );
      }
      identity = id;
      registered = false;
      await ensureRegistered();
      return id;
    } catch (err) {
      console.warn('e2e: could not set up this phone', err);
      return null;
    } finally {
      ready = null;
    }
  })();
  return ready;
}

/** Forget the identity in memory on sign-out. The stored keys stay. */
export function resetE2e() {
  identity = null;
  registered = false;
  deviceCache.clear();
}

async function ensureRegistered() {
  const me = identity;
  if (!me || registered) return;
  try {
    await api.registerDevice(me.deviceId, {
      encryptionKey: me.encPublic,
      signingKey: me.sigPublic,
    });
    registered = true;
  } catch (err) {
    console.warn('e2e: could not register this phone yet', err);
  }
}

/* --------------------------------------------------------------- devices */

interface TrustedDevice extends DmDevice {
  trusted: boolean;
}

const deviceCache = new Map<string, Promise<TrustedDevice[]>>();
/** Keys seen before, per device id. Public keys, so memory plus SecureStore. */
let pins: Record<string, string> | null = null;

async function loadPins(): Promise<Record<string, string>> {
  if (pins) return pins;
  try {
    pins = JSON.parse((await SecureStore.getItemAsync(pinKey())) ?? '{}');
  } catch {
    pins = {};
  }
  return pins!;
}

function pinKey() {
  return `e2e-pins-${(identity?.userId ?? '').replace(/[^A-Za-z0-9._-]/g, '_')}`;
}

function devicesFor(channelId: string, fresh = false): Promise<TrustedDevice[]> {
  const cached = deviceCache.get(channelId);
  if (cached && !fresh) return cached;
  const pending = api.dmDevices(channelId).then(async (devices) => {
    const known = await loadPins();
    let changed = false;
    const out = devices.map((d) => {
      const fingerprint = `${d.userId}|${d.encryptionKey}|${d.signingKey}`;
      if (!known[d.deviceId]) {
        known[d.deviceId] = fingerprint;
        changed = true;
        return { ...d, trusted: true };
      }
      return { ...d, trusted: known[d.deviceId] === fingerprint };
    });
    if (changed) {
      void SecureStore.setItemAsync(pinKey(), JSON.stringify(known)).catch(() => undefined);
    }
    return out;
  });
  deviceCache.set(channelId, pending);
  pending.catch(() => deviceCache.delete(channelId));
  return pending;
}

/** The people in a conversation changed: ask again before the next seal. */
export function forgetDevices(channelId: string) {
  deviceCache.delete(channelId);
}

/* ------------------------------------------------------------ seal, open */

export async function seal(channelId: string, body: SealedBody): Promise<string> {
  // A DM opened in the first moment after launch, before the keys are read.
  if (!identity && ready) await ready;
  const me = identity;
  if (!me) throw new Error('This phone has no encryption keys, so it cannot send direct messages.');
  await ensureRegistered();

  const devices = (await devicesFor(channelId, true)).filter((d) => d.recipient && d.trusted);
  if (!devices.some((d) => d.deviceId === me.deviceId)) {
    devices.push({
      userId: me.userId,
      deviceId: me.deviceId,
      encryptionKey: me.encPublic,
      signingKey: me.sigPublic,
      recipient: true,
      trusted: true,
    });
  }

  const cek = random(32);
  const iv = random(12);
  const ct = gcm(cek, iv).encrypt(utf8(JSON.stringify(body)));

  const ephPrivate = p256.utils.randomSecretKey();
  const ephPublic = p256.getPublicKey(ephPrivate, false);
  const keys: Record<string, string> = {};
  for (const d of devices) {
    const kek = wrapKeyFor(ephPrivate, fromSpki(unb64(d.encryptionKey)), d.deviceId);
    keys[d.deviceId] = b64(aeskw(kek).encrypt(cek));
  }

  const unsigned = {
    v: 1 as const,
    dev: me.deviceId,
    eph: b64(ephPublic),
    iv: b64(iv),
    ct: b64(ct),
    keys,
  };
  const sig = p256.sign(signedBytes(channelId, me.userId, unsigned), me.sigPrivate, {
    prehash: true,
  });
  return JSON.stringify({ ...unsigned, sig: b64(sig) } satisfies Envelope);
}

export class SealedError extends Error {}

export async function open(
  channelId: string,
  authorId: string,
  sealed: string,
): Promise<SealedBody> {
  if (!identity && ready) await ready;
  const me = identity;
  if (!me) throw new SealedError('This phone has no encryption keys.');

  let env: Envelope;
  try {
    env = JSON.parse(sealed);
    if (env.v !== 1) throw new Error();
  } catch {
    throw new SealedError('This message is in a format this version cannot read.');
  }
  const wrapped = env.keys?.[me.deviceId];
  if (!wrapped) {
    throw new SealedError('This message was sent before this phone could read it.');
  }

  let sender = (await devicesFor(channelId)).find((d) => d.deviceId === env.dev);
  if (!sender) sender = (await devicesFor(channelId, true)).find((d) => d.deviceId === env.dev);
  if (!sender || sender.userId !== authorId) {
    throw new SealedError('This message could not be verified as coming from its sender.');
  }
  if (!sender.trusted) {
    throw new SealedError('The sender’s keys changed, so this message was not trusted.');
  }

  const { sig, ...unsigned } = env;
  let ok = false;
  try {
    ok = p256.verify(
      unb64(sig),
      signedBytes(channelId, authorId, unsigned),
      fromSpki(unb64(sender.signingKey)),
      { prehash: true, lowS: false },
    );
  } catch {
    ok = false;
  }
  if (!ok) throw new SealedError('This message could not be verified as coming from its sender.');

  try {
    const kek = wrapKeyFor(me.encPrivate, unb64(env.eph), me.deviceId);
    const cek = aeskw(kek).decrypt(unb64(wrapped));
    const plain = gcm(cek, unb64(env.iv)).decrypt(unb64(env.ct));
    const body = JSON.parse(fromUtf8(plain)) as SealedBody;
    return {
      content: typeof body.content === 'string' ? body.content : '',
      files: Array.isArray(body.files) ? body.files : [],
    };
  } catch {
    throw new SealedError('This message could not be decrypted.');
  }
}

/** A message with its envelope -- and a quoted one's -- opened. Never throws. */
export async function unsealMessage(m: Message): Promise<Message> {
  if (!m.sealed && !m.replyTo?.sealed) return m;
  const out: Message = { ...m };
  if (m.sealed) {
    try {
      const body = await open(m.channelId, m.author.id, m.sealed);
      out.content = body.content;
      out.attachments = m.attachments.map((a) => withSealedFile(a, body.files ?? []));
    } catch (err) {
      out.content = '';
      out.sealedError =
        err instanceof SealedError ? err.message : 'This message could not be decrypted.';
    }
  }
  if (m.replyTo?.sealed) out.replyTo = await unsealRef(m.replyTo);
  return out;
}

export function unsealMessages(ms: Message[]): Promise<Message[]> {
  return Promise.all(ms.map(unsealMessage));
}

function withSealedFile(a: Attachment, files: SealedFile[]): Attachment {
  const f = files.find((x) => x.name === a.fileName);
  if (!f) return a;
  const { inline: _serverSaid, ...rest } = a;
  return {
    ...rest,
    fileName: f.fileName,
    contentType: f.contentType,
    size: f.size,
    width: f.width,
    height: f.height,
    sealed: { key: f.key, iv: f.iv },
  };
}

async function unsealRef(ref: MessageRef): Promise<MessageRef> {
  try {
    return { ...ref, content: (await open(ref.channelId, ref.author.id, ref.sealed!)).content };
  } catch {
    return { ...ref, content: '🔒 Encrypted message' };
  }
}

/** Open one encrypted file's bytes. */
export function decryptFile(bytes: Uint8Array, sealed: { key: string; iv: string }): Uint8Array {
  return gcm(unb64(sealed.key), unb64(sealed.iv)).decrypt(bytes);
}

/* --------------------------------------------------------------- helpers */

function wrapKeyFor(priv: Uint8Array, pubPoint: Uint8Array, deviceId: string): Uint8Array {
  // x coordinate only, to match WebCrypto's ECDH `deriveBits`.
  const shared = p256.getSharedSecret(priv, pubPoint, true).slice(1);
  return hkdf(sha256, shared, utf8(deviceId), WRAP_INFO, 32);
}

function signedBytes(channelId: string, authorId: string, e: Omit<Envelope, 'sig'>): Uint8Array {
  const keys = Object.keys(e.keys)
    .sort()
    .map((id) => `${id}=${e.keys[id]}`);
  return utf8(
    ['isthislegit-e2e-v1', channelId, authorId, e.dev, e.eph, e.iv, e.ct, ...keys].join('\n'),
  );
}

function spki(point: Uint8Array): Uint8Array {
  const out = new Uint8Array(SPKI_P256.length + point.length);
  out.set(SPKI_P256);
  out.set(point, SPKI_P256.length);
  return out;
}

/** The uncompressed point out of a P-256 SPKI, which is always its last 65 bytes. */
function fromSpki(der: Uint8Array): Uint8Array {
  return der.slice(der.length - 65);
}

function random(n: number): Uint8Array {
  return ExpoCrypto.getRandomValues(new Uint8Array(n));
}

function hex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function utf8(s: string): Uint8Array {
  const out: number[] = [];
  for (const ch of s) {
    let c = ch.codePointAt(0)!;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else {
      out.push(
        0xf0 | (c >> 18),
        0x80 | ((c >> 12) & 63),
        0x80 | ((c >> 6) & 63),
        0x80 | (c & 63),
      );
    }
  }
  return new Uint8Array(out);
}

function fromUtf8(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; ) {
    const x = b[i++];
    let c: number;
    if (x < 0x80) c = x;
    else if (x < 0xe0) c = ((x & 31) << 6) | (b[i++] & 63);
    else if (x < 0xf0) c = ((x & 15) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63);
    else {
      c =
        ((x & 7) << 18) | ((b[i++] & 63) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63);
    }
    s += String.fromCodePoint(c);
  }
  return s;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function b64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    s += i + 1 < b.length ? B64[(n >> 6) & 63] : '=';
    s += i + 2 < b.length ? B64[n & 63] : '=';
  }
  return s;
}

function unb64(s: string): Uint8Array {
  const clean = s.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n =
      (B64.indexOf(clean[i]) << 18) |
      (B64.indexOf(clean[i + 1]) << 12) |
      ((i + 2 < clean.length ? B64.indexOf(clean[i + 2]) : 0) << 6) |
      (i + 3 < clean.length ? B64.indexOf(clean[i + 3]) : 0);
    out[o++] = (n >> 16) & 255;
    if (i + 2 < clean.length) out[o++] = (n >> 8) & 255;
    if (i + 3 < clean.length) out[o++] = n & 255;
  }
  return out;
}
