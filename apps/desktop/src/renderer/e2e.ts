import {
  api,
  type AttachmentDto,
  type DmDeviceDto,
  type MessageDto,
  type MessageRefDto,
} from './api';
import { bridge } from './bridge';

/**
 * End-to-end encryption for direct messages.
 *
 * Each device has two P-256 key pairs, made here with WebCrypto the first time
 * it signs in to an account: ECDH for receiving and ECDSA for signing what it
 * sends. The private halves are stored by main with `safeStorage` and never
 * leave the machine; the public halves are registered with the server, which
 * is a directory and nothing more.
 *
 * A message is sealed like this:
 *
 * 1. A fresh AES-GCM key encrypts the body.
 * 2. A fresh ephemeral ECDH key is agreed with every recipient device. HKDF
 *    turns each agreement into an AES-KW key, salted with that device's id,
 *    and that wraps the body key once per device -- the sender's own devices
 *    included, so its other machines can read what it sent.
 * 3. The sending device signs the channel, the author, and everything above.
 *    The server sets `authorId` and could otherwise move a message between
 *    conversations or put it in somebody else's mouth.
 *
 * What this does not do, and is not pretending to:
 *
 * - **No forward secrecy.** A device's private key opens everything ever sent
 *   to it. A ratchet is a protocol's worth of state to keep in step across
 *   devices, and the threat it answers -- a stolen key reading old traffic --
 *   is also answered by the disk encryption the key is stored under.
 * - **A new device cannot read the past.** Nothing was sealed to it.
 * - **The directory is trusted once.** A device's keys are remembered the
 *   first time they are seen, and a different key under the same id later is
 *   refused, not used. A server that invents a whole new device for somebody
 *   is not caught by this; the device list in the conversation header is what
 *   lets a person notice one.
 * - **Metadata is not hidden.** Who talks to whom and when, reactions, pins
 *   and edit times are all visible to the server, as they must be for it to
 *   deliver anything.
 */

/** What goes inside an envelope. An object so there is room to grow. */
export interface SealedBody {
  content: string;
  /** The files that went with it, each encrypted under a key of its own. */
  files?: SealedFile[];
}

/**
 * One encrypted file, as the envelope describes it. The server stores the
 * bytes under `name` -- a random token -- and knows nothing else about them:
 * not the real name, not the type, not that it is a picture.
 */
export interface SealedFile {
  name: string;
  fileName: string;
  contentType: string;
  size: number;
  width: number | null;
  height: number | null;
  /** AES-GCM, raw, base64. Only ever inside a sealed envelope. */
  key: string;
  iv: string;
}

/**
 * Encrypt one file for upload. What goes up is opaque bytes under a random
 * name; what it really is goes into the envelope as a `SealedFile`.
 *
 * A picture's size is measured here, before encryption, because the server
 * cannot -- and without it the message list jumps as each one decrypts.
 */
export async function encryptFile(file: File): Promise<{ upload: File; meta: SealedFile }> {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
  ]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, await file.arrayBuffer());

  let width: number | null = null;
  let height: number | null = null;
  if (file.type.startsWith('image/')) {
    try {
      const bmp = await createImageBitmap(file);
      width = bmp.width;
      height = bmp.height;
      bmp.close();
    } catch {
      /* not decodable here; it is drawn without a reserved size */
    }
  }

  const name = `sealed-${crypto.randomUUID()}.bin`;
  return {
    upload: new File([ct], name, { type: 'application/octet-stream' }),
    meta: {
      name,
      fileName: file.name || 'file',
      contentType: file.type || 'application/octet-stream',
      size: file.size,
      width,
      height,
      key: b64(await crypto.subtle.exportKey('raw', key)),
      iv: b64(iv),
    },
  };
}

/** Open the bytes of one encrypted file, fetched as they were stored. */
export async function decryptFile(
  bytes: ArrayBuffer,
  sealed: { key: string; iv: string },
): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', unb64(sealed.key), 'AES-GCM', false, [
    'decrypt',
  ]);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(sealed.iv) }, key, bytes);
}

interface Envelope {
  v: 1;
  /** The sending device. */
  dev: string;
  /** Ephemeral ECDH public key, raw. */
  eph: string;
  iv: string;
  ct: string;
  /** Device id -> the body key, wrapped for that device. */
  keys: Record<string, string>;
  sig: string;
}

interface StoredIdentity {
  v: 1;
  deviceId: string;
  encPrivate: JsonWebKey;
  encPublic: string;
  sigPrivate: JsonWebKey;
  sigPublic: string;
}

interface Identity {
  userId: string;
  deviceId: string;
  encPrivate: CryptoKey;
  encPublic: string;
  sigPrivate: CryptoKey;
  sigPublic: string;
}

const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const;
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const WRAP_INFO = new TextEncoder().encode('isthislegit e2e v1 wrap');

let identity: Identity | null = null;
let ready: Promise<Identity | null> | null = null;

/* -------------------------------------------------------------- identity */

/**
 * Load this device's keys for the account, making them the first time, and
 * make sure the server has the public halves. Safe to call more than once.
 *
 * Resolves to null rather than throwing when something fails: DMs then say
 * they cannot be read on this device, and the rest of the app carries on.
 */
export function initE2e(userId: string): Promise<Identity | null> {
  if (identity?.userId === userId) return Promise.resolve(identity);
  if (ready) return ready;
  ready = (async () => {
    try {
      const stored = await bridge.getE2eIdentity(userId);
      const id = stored
        ? await importIdentity(userId, JSON.parse(stored) as StoredIdentity)
        : await createIdentity(userId);
      // Kept even if the server cannot be told right now: the keys still open
      // everything already sealed to this device, and `seal` tries again.
      identity = id;
      await ensureRegistered();
      return id;
    } catch (err) {
      console.warn('e2e: could not set up this device', err);
      return null;
    } finally {
      ready = null;
    }
  })();
  return ready;
}

let registered = false;

/** Tell the server this device's public keys, once per session. */
async function ensureRegistered(): Promise<void> {
  const me = identity;
  if (!me || registered) return;
  try {
    await api.registerDevice(me.deviceId, {
      encryptionKey: me.encPublic,
      signingKey: me.sigPublic,
    });
    registered = true;
  } catch (err) {
    console.warn('e2e: could not register this device yet', err);
  }
}

/** This device's id, for drawing "this device" in a list of them. */
export function myDeviceId(): string | null {
  return identity?.deviceId ?? null;
}

async function createIdentity(userId: string): Promise<Identity> {
  const enc = await crypto.subtle.generateKey(ECDH, true, ['deriveBits']);
  const sig = await crypto.subtle.generateKey(ECDSA, true, ['sign', 'verify']);
  const stored: StoredIdentity = {
    v: 1,
    deviceId: crypto.randomUUID(),
    encPrivate: await crypto.subtle.exportKey('jwk', enc.privateKey),
    encPublic: b64(await crypto.subtle.exportKey('spki', enc.publicKey)),
    sigPrivate: await crypto.subtle.exportKey('jwk', sig.privateKey),
    sigPublic: b64(await crypto.subtle.exportKey('spki', sig.publicKey)),
  };
  // Saved before it is registered. The other order could leave the server
  // sealing messages to a device whose key never reached the disk.
  if (!(await bridge.setE2eIdentity(userId, JSON.stringify(stored)))) {
    throw new Error('could not store the keys');
  }
  return importIdentity(userId, stored);
}

async function importIdentity(userId: string, s: StoredIdentity): Promise<Identity> {
  return {
    userId,
    deviceId: s.deviceId,
    encPrivate: await crypto.subtle.importKey('jwk', s.encPrivate, ECDH, false, ['deriveBits']),
    encPublic: s.encPublic,
    sigPrivate: await crypto.subtle.importKey('jwk', s.sigPrivate, ECDSA, false, ['sign']),
    sigPublic: s.sigPublic,
  };
}

/* --------------------------------------------------------------- devices */

/**
 * The devices of a DM's participants, after the trust-on-first-use check.
 * Cached per conversation for reading; sealing always asks again, so a device
 * somebody added a minute ago is not left out of what is sent next.
 */
const deviceCache = new Map<string, Promise<TrustedDevice[]>>();

interface TrustedDevice extends DmDeviceDto {
  /** False when this id was seen before with different keys. */
  trusted: boolean;
}

function devicesFor(channelId: string, fresh = false): Promise<TrustedDevice[]> {
  const cached = deviceCache.get(channelId);
  if (cached && !fresh) return cached;
  const pending = api.dmDevices(channelId).then(pinDevices);
  deviceCache.set(channelId, pending);
  pending.catch(() => deviceCache.delete(channelId));
  return pending;
}

/** Forget what is known about a conversation's devices: its people changed. */
export function forgetDevices(channelId: string) {
  deviceCache.delete(channelId);
}

/** Every device in a conversation, for the header's device list. */
export async function conversationDevices(channelId: string): Promise<TrustedDevice[]> {
  return devicesFor(channelId, true);
}

function pinKey(): string {
  return `e2e-pins:${identity?.userId ?? ''}`;
}

/**
 * Remember every device's keys the first time they are seen, and flag any
 * that come back different. Public keys, so `localStorage` is enough: what
 * matters is that the server cannot change them, and it cannot reach here.
 */
function pinDevices(devices: DmDeviceDto[]): TrustedDevice[] {
  let pins: Record<string, string> = {};
  try {
    pins = JSON.parse(localStorage.getItem(pinKey()) ?? '{}');
  } catch {
    pins = {};
  }
  let changed = false;
  const out = devices.map((d) => {
    const fingerprint = `${d.userId}|${d.encryptionKey}|${d.signingKey}`;
    const known = pins[d.deviceId];
    if (!known) {
      pins[d.deviceId] = fingerprint;
      changed = true;
      return { ...d, trusted: true };
    }
    return { ...d, trusted: known === fingerprint };
  });
  if (changed) {
    try {
      localStorage.setItem(pinKey(), JSON.stringify(pins));
    } catch {
      /* the next fetch pins them again */
    }
  }
  return out;
}

/* ------------------------------------------------------------ seal, open */

/**
 * Seal a message body for everybody in a conversation who can still receive
 * one. Throws when this device has no keys -- sending in the clear is never
 * the fallback.
 */
export async function seal(channelId: string, body: SealedBody): Promise<string> {
  const me = identity;
  if (!me) throw new Error('This device has no encryption keys, so it cannot send direct messages.');
  // Until the server knows this device, nobody else can seal replies to it.
  await ensureRegistered();

  const devices = (await devicesFor(channelId, true)).filter((d) => d.recipient && d.trusted);
  // Always this device, even before the directory has caught up with it.
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

  const cek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    cek,
    new TextEncoder().encode(JSON.stringify(body)),
  );

  const eph = await crypto.subtle.generateKey(ECDH, true, ['deriveBits']);
  const keys: Record<string, string> = {};
  for (const d of devices) {
    const pub = await crypto.subtle.importKey('spki', unb64(d.encryptionKey), ECDH, false, []);
    const kek = await wrapKeyFor(eph.privateKey, pub, d.deviceId, 'wrapKey');
    keys[d.deviceId] = b64(await crypto.subtle.wrapKey('raw', cek, kek, 'AES-KW'));
  }

  const unsigned = {
    v: 1 as const,
    dev: me.deviceId,
    eph: b64(await crypto.subtle.exportKey('raw', eph.publicKey)),
    iv: b64(iv),
    ct: b64(ct),
    keys,
  };
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    me.sigPrivate,
    signedBytes(channelId, me.userId, unsigned),
  );
  return JSON.stringify({ ...unsigned, sig: b64(sig) } satisfies Envelope);
}

/** Why an envelope could not be opened, as the sentence drawn in its place. */
export class SealedError extends Error {}

/**
 * Open and verify one envelope. The signature is checked before anything is
 * decrypted, against a device the directory says belongs to the author.
 */
export async function open(
  channelId: string,
  authorId: string,
  sealed: string,
): Promise<SealedBody> {
  const me = identity;
  if (!me) throw new SealedError('This device has no encryption keys.');

  let env: Envelope;
  try {
    env = JSON.parse(sealed);
    if (env.v !== 1) throw new Error();
  } catch {
    throw new SealedError('This message is in a format this version cannot read.');
  }
  const wrapped = env.keys?.[me.deviceId];
  if (!wrapped) {
    throw new SealedError('This message was sent before this device could read it.');
  }

  let sender = (await devicesFor(channelId)).find((d) => d.deviceId === env.dev);
  // A device that registered after the list was cached.
  if (!sender) sender = (await devicesFor(channelId, true)).find((d) => d.deviceId === env.dev);
  if (!sender || sender.userId !== authorId) {
    throw new SealedError('This message could not be verified as coming from its sender.');
  }
  if (!sender.trusted) {
    throw new SealedError('The sender’s keys changed, so this message was not trusted.');
  }

  const { sig, ...unsigned } = env;
  const sigKey = await crypto.subtle.importKey('spki', unb64(sender.signingKey), ECDSA, false, [
    'verify',
  ]);
  const ok = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    sigKey,
    unb64(sig),
    signedBytes(channelId, authorId, unsigned),
  );
  if (!ok) throw new SealedError('This message could not be verified as coming from its sender.');

  try {
    const eph = await crypto.subtle.importKey('raw', unb64(env.eph), ECDH, false, []);
    const kek = await wrapKeyFor(me.encPrivate, eph, me.deviceId, 'unwrapKey');
    const cek = await crypto.subtle.unwrapKey(
      'raw',
      unb64(wrapped),
      kek,
      'AES-KW',
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt'],
    );
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(env.iv) },
      cek,
      unb64(env.ct),
    );
    const body = JSON.parse(new TextDecoder().decode(plain)) as SealedBody;
    return {
      content: typeof body.content === 'string' ? body.content : '',
      files: Array.isArray(body.files) ? body.files : [],
    };
  } catch {
    throw new SealedError('This message could not be decrypted.');
  }
}

/**
 * A message, with its envelope -- and any quoted one's -- opened into
 * `content`. Never throws: a message that will not open draws the reason in
 * its place, through `sealedError`.
 */
export async function unsealMessage(m: MessageDto): Promise<MessageDto> {
  if (!m.sealed && !m.replyTo?.sealed) return m;
  const out: MessageDto = { ...m };
  if (m.sealed) {
    try {
      const body = await open(m.channelId, m.author.id, m.sealed);
      out.content = body.content;
      out.attachments = m.attachments.map((a) => withSealedFile(a, body.files ?? []));
    } catch (err) {
      out.content = '';
      out.sealedError = err instanceof SealedError ? err.message : 'This message could not be decrypted.';
    }
  }
  if (m.replyTo?.sealed) out.replyTo = await unsealRef(m.replyTo);
  return out;
}

export function unsealMessages(ms: MessageDto[]): Promise<MessageDto[]> {
  return Promise.all(ms.map(unsealMessage));
}

/**
 * An attachment as the envelope says it really is. The key rides along so the
 * view can decrypt the bytes when it fetches them; an attachment the envelope
 * does not describe is left as the server sent it, which draws as a file
 * card nobody can open -- the truth about it.
 */
function withSealedFile(a: AttachmentDto, files: SealedFile[]): AttachmentDto {
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

async function unsealRef(ref: MessageRefDto): Promise<MessageRefDto> {
  try {
    return { ...ref, content: (await open(ref.channelId, ref.author.id, ref.sealed!)).content };
  } catch {
    return { ...ref, content: '🔒 Encrypted message' };
  }
}

/* --------------------------------------------------------------- helpers */

/**
 * The AES-KW key for one device: ECDH between an ephemeral key and the
 * device's, through HKDF salted with the device id so two devices never
 * share a wrapping key even if they somehow shared an encryption key.
 */
async function wrapKeyFor(
  priv: CryptoKey,
  pub: CryptoKey,
  deviceId: string,
  use: 'wrapKey' | 'unwrapKey',
): Promise<CryptoKey> {
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256);
  const hkdf = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode(deviceId),
      info: WRAP_INFO,
    },
    hkdf,
    { name: 'AES-KW', length: 256 },
    false,
    [use],
  );
}

/**
 * What the signature covers, as one unambiguous string. The wrapped keys are
 * sorted so the order JSON happens to put them in cannot change the bytes.
 */
function signedBytes(
  channelId: string,
  authorId: string,
  e: Omit<Envelope, 'sig'>,
): Uint8Array<ArrayBuffer> {
  const keys = Object.keys(e.keys)
    .sort()
    .map((id) => `${id}=${e.keys[id]}`);
  return new Uint8Array(
    new TextEncoder().encode(
      ['isthislegit-e2e-v1', channelId, authorId, e.dev, e.eph, e.iv, e.ct, ...keys].join('\n'),
    ),
  );
}

function b64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function unb64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
