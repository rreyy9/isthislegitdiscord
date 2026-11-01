import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Two people's devices, end to end, against a fake server.
 *
 * The module keeps one identity -- the device it is running on -- so each
 * person is a fresh import of it, with what main would have stored and what
 * the server's directory holds kept here in between. WebCrypto is Node's own,
 * which is the same implementation family Electron's renderer uses.
 */

const stored = new Map<string, string>();
type Device = {
  userId: string;
  deviceId: string;
  encryptionKey: string;
  signingKey: string;
  recipient: boolean;
};
let directory: Device[] = [];
let registering = '';

vi.mock('./bridge', () => ({
  bridge: {
    getE2eIdentity: async (userId: string) => stored.get(userId) ?? null,
    setE2eIdentity: async (userId: string, json: string) => {
      stored.set(userId, json);
      return true;
    },
  },
}));

vi.mock('./api', () => ({
  api: {
    registerDevice: async (deviceId: string, keys: { encryptionKey: string; signingKey: string }) => {
      if (!directory.some((d) => d.deviceId === deviceId)) {
        directory.push({ userId: registering, deviceId, ...keys, recipient: true });
      }
      return { ok: true };
    },
    dmDevices: async () => directory.map((d) => ({ ...d })),
  },
}));

/** A per-test `localStorage`, for the pinned keys. */
function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  };
}

async function as(userId: string) {
  vi.resetModules();
  registering = userId;
  const e2e = await import('./e2e');
  expect(await e2e.initE2e(userId)).not.toBeNull();
  return e2e;
}

describe('e2e', () => {
  beforeEach(() => {
    stored.clear();
    directory = [];
    (globalThis as any).localStorage = memoryStorage();
  });

  it('opens what was sealed to it, and nobody else can', async () => {
    await as('bob');
    await as('carol');
    const alice = await as('alice');
    const sealed = await alice.seal('dm1', { content: 'see you at 8' });

    // The server sees no plaintext.
    expect(sealed).not.toContain('see you');

    const bob = await as('bob');
    expect(await bob.open('dm1', 'alice', sealed)).toEqual({ content: 'see you at 8', files: [] });
    // The sender's own device can read its own message back.
    const aliceAgain = await as('alice');
    expect((await aliceAgain.open('dm1', 'alice', sealed)).content).toBe('see you at 8');
  });

  it('refuses a message the server reattributes or moves', async () => {
    await as('bob');
    const alice = await as('alice');
    const sealed = await alice.seal('dm1', { content: 'hi' });
    const bob = await as('bob');
    await expect(bob.open('dm1', 'bob', sealed)).rejects.toThrow(/verified/);
    await expect(bob.open('dm2', 'alice', sealed)).rejects.toThrow(/verified/);
  });

  it('refuses a message whose ciphertext was changed', async () => {
    await as('bob');
    const alice = await as('alice');
    const env = JSON.parse(await alice.seal('dm1', { content: 'hi' }));
    env.ct = env.ct.slice(0, -4) + (env.ct.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    const bob = await as('bob');
    await expect(bob.open('dm1', 'alice', JSON.stringify(env))).rejects.toThrow(/verified/);
  });

  it('cannot read what was sent before the device existed', async () => {
    await as('bob');
    const alice = await as('alice');
    const sealed = await alice.seal('dm1', { content: 'hi' });
    const dave = await as('dave');
    await expect(dave.open('dm1', 'alice', sealed)).rejects.toThrow(/before this device/);
  });

  it('does not seal to somebody who is no longer a recipient', async () => {
    await as('bob');
    const alice = await as('alice');
    directory = directory.map((d) => (d.userId === 'bob' ? { ...d, recipient: false } : d));
    const sealed = await alice.seal('dm1', { content: 'hi' });
    const bob = await as('bob');
    await expect(bob.open('dm1', 'alice', sealed)).rejects.toThrow(/before this device/);
  });

  it('stops trusting a device whose keys change under the same id', async () => {
    await as('bob');
    const alice = await as('alice');
    const sealed = await alice.seal('dm1', { content: 'hi' });

    const bob = await as('bob');
    expect((await bob.open('dm1', 'alice', sealed)).content).toBe('hi');

    // The server swaps in different keys for Alice's device.
    await as('mallory');
    const mallory = directory.find((d) => d.userId === 'mallory')!;
    directory = directory.map((d) =>
      d.userId === 'alice' ? { ...d, signingKey: mallory.signingKey } : d,
    );
    const bobAgain = await as('bob');
    await expect(bobAgain.open('dm1', 'alice', sealed)).rejects.toThrow(/keys changed/);
  });

  it('puts an encrypted file back to what it really is, with its key', async () => {
    await as('bob');
    const alice = await as('alice');
    const photo = new File([new Uint8Array([9, 8, 7])], 'beach.png', { type: 'image/png' });
    const { upload, meta } = await alice.encryptFile(photo);
    // What the server is given says nothing about the picture.
    expect(upload.name).toMatch(/^sealed-.+\.bin$/);
    expect(upload.type).toBe('application/octet-stream');
    const sealed = await alice.seal('dm1', { content: '', files: [meta] });

    const bob = await as('bob');
    const m = await bob.unsealMessage({
      id: 'm2',
      channelId: 'dm1',
      author: { id: 'alice', username: 'alice', displayName: null, image: null },
      content: '',
      sealed,
      createdAt: '',
      editedAt: null,
      deletedAt: null,
      clientNonce: null,
      attachments: [
        {
          id: 'a1',
          fileName: upload.name,
          contentType: 'application/octet-stream',
          size: 3,
          width: null,
          height: null,
          url: '/api/attachments/a1',
          inline: false,
        },
      ],
    });
    const [a] = m.attachments;
    expect(a.fileName).toBe('beach.png');
    expect(a.contentType).toBe('image/png');
    // The server's "not drawable" was about ciphertext; the real type decides.
    expect(a.inline).toBeUndefined();
    const bytes = await bob.decryptFile(await upload.arrayBuffer(), a.sealed!);
    expect([...new Uint8Array(bytes)]).toEqual([9, 8, 7]);
  });

  it('turns a failure into a line to draw, never an exception', async () => {
    await as('bob');
    const alice = await as('alice');
    const sealed = await alice.seal('dm1', { content: 'hi' });
    const dave = await as('dave');
    const m = await dave.unsealMessage({
      id: 'm1',
      channelId: 'dm1',
      author: { id: 'alice', username: 'alice', displayName: null, image: null },
      content: '',
      sealed,
      createdAt: '',
      editedAt: null,
      deletedAt: null,
      clientNonce: null,
      attachments: [],
    });
    expect(m.content).toBe('');
    expect(m.sealedError).toMatch(/before this device/);
  });
});
