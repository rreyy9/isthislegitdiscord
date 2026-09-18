import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The publish gate, which is the only part of this service with a decision in
 * it. Everything else is a read of a directory.
 *
 * `UPDATES_DIR` is resolved once when `updates.service.ts` is first imported,
 * from an environment variable -- which is the trap documented at the top of
 * `main.ts`, and here it is useful: setting the variable and then importing
 * the module dynamically is what lets each test own a real directory rather
 * than mock the filesystem. Mocking it would be testing the mock: every
 * failure this gate exists to catch is a fact about bytes on disk.
 */

type Service = import('./android-updates.service').AndroidUpdatesService;

let dir: string;
let service: Service;

/** The APK bytes never matter, only that the hash agrees with the manifest. */
const APK_BODY = Buffer.from('not really an apk, but it hashes the same way');
const APK_SHA = createHash('sha256').update(APK_BODY).digest('hex');

interface ManifestPatch {
  version?: string;
  versionCode?: number;
  apk?: string;
  sha256?: string;
  notes?: string;
}

/** Write a complete, valid staged release, then apply the patch over it. */
async function stage(patch: ManifestPatch = {}, body = APK_BODY) {
  const staging = path.join(dir, 'android-staging');
  await mkdir(staging, { recursive: true });

  const manifest = {
    version: '0.1.0',
    versionCode: 10000,
    apk: 'isthislegit-0.1.0.apk',
    sha256: APK_SHA,
    ...patch,
  };
  await writeFile(
    path.join(staging, 'latest.json'),
    JSON.stringify(manifest, null, 2),
  );
  await writeFile(path.join(staging, manifest.apk), body);
  return manifest;
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'itl-android-'));
  process.env.UPDATES_DIR = dir;

  // Fresh module registry per test, so the directory constant is recomputed
  // against this test's temporary directory rather than the first one's. The
  // import path has to be a literal -- Vite resolves these statically and
  // refuses a computed one, so cache-busting with a query string does not work
  // here and `resetModules` is what does the same job.
  vi.resetModules();
  const mod = await import('./android-updates.service');
  service = new mod.AndroidUpdatesService();
});

afterEach(async () => {
  delete process.env.UPDATES_DIR;
  await rm(dir, { recursive: true, force: true });
});

describe('AndroidUpdatesService', () => {
  describe('an empty feed', () => {
    it('has no release, which is not an error', async () => {
      expect(await service.latest(true)).toBeNull();
      expect(await service.latestVersion()).toBeNull();
    });

    it('refuses to publish nothing', async () => {
      await expect(service.publishStaged()).rejects.toThrow(
        /Nothing publishable/,
      );
    });
  });

  describe('publishing', () => {
    it('promotes a valid staged release and stamps it', async () => {
      await stage();
      const release = await service.publishStaged();

      expect(release.manifest.version).toBe('0.1.0');
      expect(release.manifest.versionCode).toBe(10000);
      expect(release.manifest.size).toBe(APK_BODY.length);
      expect(Date.parse(release.manifest.publishedAt)).not.toBeNaN();
      expect(release.files).toEqual(['isthislegit-0.1.0.apk', 'latest.json']);
    });

    it('empties staging afterwards, so a publish cannot happen twice', async () => {
      await stage();
      await service.publishStaged();

      expect(await service.staged()).toBeNull();
      await expect(service.publishStaged()).rejects.toThrow(
        /Nothing publishable/,
      );
    });

    it('serves the manifest it wrote, not the one uploaded', async () => {
      await stage({ notes: 'First build.' });
      await service.publishStaged();

      const raw = await readFile(
        path.join(dir, 'android', 'latest.json'),
        'utf8',
      );
      const written = JSON.parse(raw);
      expect(written.notes).toBe('First build.');
      expect(written.size).toBe(APK_BODY.length);
    });
  });

  describe('the gate', () => {
    it('refuses a manifest naming an APK that was not uploaded', async () => {
      await stage();
      await rm(path.join(dir, 'android-staging', 'isthislegit-0.1.0.apk'));

      await expect(service.publishStaged()).rejects.toThrow(/was not uploaded/);
    });

    /**
     * The one that matters most in practice: an upload cut short by a dropped
     * uplink leaves a file that exists, is named correctly, and is wrong.
     */
    it('refuses an APK whose bytes do not match the sha256', async () => {
      await stage({}, Buffer.from('truncated'));
      await expect(service.publishStaged()).rejects.toThrow(/does not match/);
    });

    it('refuses a version that is not newer', async () => {
      await stage();
      await service.publishStaged();

      await stage({ versionCode: 10001 });
      await expect(service.publishStaged()).rejects.toThrow(/is not newer/);
    });

    /**
     * The failure with no symptom: Android compares `versionCode` and nothing
     * else, so a build with a bumped semver and a forgotten code is refused by
     * every phone with a message none of them shows anybody.
     */
    it('refuses a versionCode that has not risen, even with a newer version', async () => {
      await stage();
      await service.publishStaged();

      await stage({ version: '0.2.0', versionCode: 10000 });
      await expect(service.publishStaged()).rejects.toThrow(
        /versionCode 10000 is not above/,
      );
    });

    it('accepts a build that moves both', async () => {
      await stage();
      await service.publishStaged();

      await stage({
        version: '0.2.0',
        versionCode: 20000,
        apk: 'isthislegit-0.2.0.apk',
      });
      const release = await service.publishStaged();

      expect(release.manifest.version).toBe('0.2.0');
      // The superseded APK goes, or the directory grows by 60 MB per release.
      expect(release.files).toEqual(['isthislegit-0.2.0.apk', 'latest.json']);
    });

    it('treats a prerelease as older than its release', async () => {
      await stage({ version: '0.2.0', versionCode: 20000 });
      await service.publishStaged();

      await stage({
        version: '0.2.0-beta.1',
        versionCode: 20001,
        apk: 'isthislegit-0.2.0-beta.1.apk',
      });
      await expect(service.publishStaged()).rejects.toThrow(/is not newer/);
    });
  });

  describe('a manifest that does not validate', () => {
    const bad: Array<[string, ManifestPatch | string]> = [
      ['no version', { version: '' }],
      ['a versionCode that is not an integer', { versionCode: 1.5 }],
      ['a versionCode of zero', { versionCode: 0 }],
      ['a file that is not an APK', { apk: 'isthislegit.exe' }],
      ['a sha256 that is not one', { sha256: 'nope' }],
    ];

    for (const [what, patch] of bad) {
      it(`refuses ${what}`, async () => {
        await stage(patch as ManifestPatch);
        await expect(service.publishStaged()).rejects.toThrow();
      });
    }

    /**
     * The manifest is uploaded, so its `apk` field is attacker-controlled in
     * the sense that matters: it is joined onto a directory path and then read
     * back out by an unauthenticated route.
     */
    it('refuses a path traversal in the APK name', async () => {
      await stage({ apk: '../../../.env' });
      await expect(service.publishStaged()).rejects.toThrow(/does not name/);
    });

    it('refuses JSON that is not JSON', async () => {
      const staging = path.join(dir, 'android-staging');
      await mkdir(staging, { recursive: true });
      await writeFile(path.join(staging, 'latest.json'), '{ nope');

      await expect(service.publishStaged()).rejects.toThrow(/not valid JSON/);
      expect(await service.staged()).toBeNull();
    });
  });

  describe('the served path', () => {
    beforeEach(async () => {
      await stage();
      await service.publishStaged();
    });

    it('opens a published file', async () => {
      expect(await service.size('isthislegit-0.1.0.apk')).toBe(APK_BODY.length);
    });

    it('refuses to read outside the feed directory', () => {
      expect(() => service.open('../../.env')).toThrow(/outside/);
    });

    it('refuses a file type the feed does not serve', () => {
      expect(() => service.open('secrets.txt')).toThrow(/that file type/);
    });
  });

  describe('staging hygiene', () => {
    it('refuses to store a name that is not its own basename', async () => {
      await expect(service.openStaged('../evil.apk')).rejects.toThrow(
        /Refusing to store/,
      );
    });

    it('refuses to store a file type the feed will not serve', async () => {
      await expect(service.openStaged('payload.exe')).rejects.toThrow(
        /Refusing to store/,
      );
    });

    it('reports what is waiting without publishing it', async () => {
      await stage();
      const staged = await service.staged();

      expect(staged?.manifest.version).toBe('0.1.0');
      // Still nothing live: staging and publishing are two steps on purpose.
      expect(await service.latest(true)).toBeNull();
    });
  });
});
