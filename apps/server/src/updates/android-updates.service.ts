import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { compareVersions } from '@isthislegit/shared';
import { UPDATES_DIR } from './updates.service';

/**
 * The Android client's update feed.
 *
 * Deliberately a separate service from `UpdatesService` rather than a second
 * channel inside it. The two have nothing in common but a parent directory:
 * the desktop feed is electron-updater's `latest.yml` plus a blockmap that
 * makes the next download a delta, and every rule in it exists to satisfy a
 * library we do not control. This one answers a client we wrote, which wants
 * three fields and an APK.
 *
 * Generalising the desktop service to cover both would have meant threading a
 * channel through every method and making its `latest.yml` parsing
 * conditional -- turning a working, load-bearing production path into a shared
 * one for the sake of not having two files. The desktop feed is how ten people
 * get their client; it is not the place to take that risk.
 *
 * Served without authentication, for the reason the desktop feed is: the
 * moment an update matters most is when somebody's session has lapsed and they
 * are stranded on an old build, and a feed that needs a token fails exactly
 * then. The APK carries no secret -- it is the same file everyone who already
 * has the app is running.
 */

/** Published builds. Whatever is here is live to every phone. */
const ANDROID_DIR = path.join(UPDATES_DIR, 'android');

/**
 * Where an upload lands before it is published, on the same reasoning as the
 * desktop staging directory: a 60 MB APK arriving over a domestic uplink is a
 * live feed for as long as it is in flight, and a phone that starts an install
 * from a half-written file gets a parse error rather than an app.
 */
const STAGING_DIR = path.join(UPDATES_DIR, 'android-staging');

/** Refuses an upload long before it can fill the disk. An APK is ~60 MB. */
export const MAX_ANDROID_UPLOAD_BYTES = 256 * 1024 * 1024;

/**
 * Nothing else is served, whatever ends up in the directory. Same rule as the
 * desktop feed: a feed folder is not a file host, and this one is reachable
 * without a token.
 */
const SERVED = /\.(apk|json)$/i;

/** The manifest name, at a fixed path so the client can hardcode one URL. */
export const MANIFEST = 'latest.json';

/**
 * What the phone reads to decide whether to offer an update.
 *
 * `versionCode` is here and not derived from `version` because Android itself
 * uses it: the package manager refuses an install whose code is lower than
 * what is on the device, and it is the only number it will compare. `version`
 * is what a person is shown. The two have to move together, and the publish
 * gate below is what makes sure they do.
 */
export interface AndroidManifest {
  /** Semver, for display and for `compareVersions`. */
  version: string;
  /** Android's own monotonic integer. Must rise with every published build. */
  versionCode: number;
  /** File name only, resolved against this feed's directory by the client. */
  apk: string;
  /** Lowercase hex sha256 of the APK, verified here at publish time. */
  sha256: string;
  size: number;
  /** Set by the server on publish; whatever an upload claims is overwritten. */
  publishedAt: string;
  /** Optional release note, shown on the update banner. */
  notes?: string;
}

/** Everything the admin console needs to describe one side of the feed. */
export interface AndroidRelease {
  manifest: AndroidManifest;
  files: string[];
  bytes: number;
}

@Injectable()
export class AndroidUpdatesService {
  private readonly log = new Logger(AndroidUpdatesService.name);
  private cache: { at: number; release: AndroidRelease | null } | null = null;

  get directory(): string {
    return ANDROID_DIR;
  }

  get stagingDirectory(): string {
    return STAGING_DIR;
  }

  /**
   * Read and validate a manifest out of one directory.
   *
   * Every field is checked rather than trusted, because this same routine
   * reads the staging directory -- where the bytes are whatever was uploaded a
   * moment ago -- and the published one, where a half-finished copy would
   * otherwise be served to every phone as gospel.
   */
  private async readManifest(dir: string): Promise<AndroidManifest> {
    const raw = await readFile(path.join(dir, MANIFEST), 'utf8');

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`${MANIFEST} is not valid JSON.`);
    }
    const m = parsed as Partial<AndroidManifest>;

    if (typeof m.version !== 'string' || !m.version.trim()) {
      throw new Error(`${MANIFEST} has no version.`);
    }
    if (!Number.isInteger(m.versionCode) || (m.versionCode as number) < 1) {
      throw new Error(`${MANIFEST} has no positive integer versionCode.`);
    }
    // The name comes out of a file that was uploaded, and is about to be
    // joined onto a directory path. A manifest naming `../../../.env` would
    // otherwise become a read of that file on the next `open()`.
    if (
      typeof m.apk !== 'string' ||
      m.apk !== path.basename(m.apk) ||
      !/\.apk$/i.test(m.apk)
    ) {
      throw new Error(`${MANIFEST} does not name an .apk file.`);
    }
    if (typeof m.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(m.sha256)) {
      throw new Error(`${MANIFEST} has no sha256.`);
    }

    return {
      version: m.version.trim(),
      versionCode: m.versionCode as number,
      apk: m.apk,
      sha256: m.sha256.toLowerCase(),
      size: Number(m.size ?? 0),
      publishedAt:
        typeof m.publishedAt === 'string'
          ? m.publishedAt
          : new Date().toISOString(),
      ...(typeof m.notes === 'string' && m.notes.trim()
        ? { notes: m.notes.trim() }
        : {}),
    };
  }

  /** Hash a file without holding it in memory. An APK is 60 MB. */
  private async sha256(file: string): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) {
      hash.update(chunk as Buffer);
    }
    return hash.digest('hex');
  }

  private async describe(dir: string): Promise<AndroidRelease | null> {
    try {
      const manifest = await this.readManifest(dir);
      const files = (await readdir(dir)).filter((n) => SERVED.test(n)).sort();
      let bytes = 0;
      for (const n of files) bytes += (await stat(path.join(dir, n))).size;
      return { manifest, files, bytes };
    } catch {
      // Nothing published yet, or a manifest that does not validate. Neither
      // is an error here: the client simply never offers an update, which is
      // the correct behaviour for a feed that cannot vouch for itself.
      return null;
    }
  }

  async latest(force = false): Promise<AndroidRelease | null> {
    if (!force && this.cache && Date.now() - this.cache.at < 10_000) {
      return this.cache.release;
    }
    const release = await this.describe(ANDROID_DIR);
    this.cache = { at: Date.now(), release };
    return release;
  }

  async latestVersion(): Promise<string | null> {
    return (await this.latest())?.manifest.version ?? null;
  }

  /** What is waiting to be published, if anything. */
  staged(): Promise<AndroidRelease | null> {
    return this.describe(STAGING_DIR);
  }

  /* --------------------------------------------------------------- feed */

  /**
   * Resolve one file of the feed for reading.
   *
   * `name` comes off the URL, so it is resolved and checked against the feed
   * directory: a traversal here would serve arbitrary files off the disk to an
   * unauthenticated caller.
   */
  private servedPath(name: string): string {
    const full = path.resolve(ANDROID_DIR, name);
    if (!full.startsWith(ANDROID_DIR + path.sep)) {
      throw new Error('Refusing to read outside the update directory.');
    }
    if (!SERVED.test(full)) {
      throw new Error('Refusing to serve that file type.');
    }
    return full;
  }

  open(name: string) {
    return createReadStream(this.servedPath(name));
  }

  size(name: string): Promise<number> {
    return stat(this.servedPath(name)).then((s) => s.size);
  }

  /* ------------------------------------------------------------ staging */

  /**
   * Resolve one upload's destination.
   *
   * A name has to already be its own basename. Reducing it to one would be
   * safe, but silently storing a file under a different name than the caller
   * asked for is how a release ends up missing the APK its manifest names,
   * with nothing saying why. Refuse instead -- the same call the desktop
   * service makes, for the same reason.
   */
  private stagedPath(name: string): string {
    if (!name || name !== path.basename(name) || !SERVED.test(name)) {
      throw new Error(`Refusing to store ${name}.`);
    }
    const full = path.resolve(STAGING_DIR, name);
    if (!full.startsWith(STAGING_DIR + path.sep)) {
      throw new Error('Refusing to write outside the staging directory.');
    }
    return full;
  }

  async openStaged(name: string) {
    const full = this.stagedPath(name);
    await mkdir(STAGING_DIR, { recursive: true });
    return createWriteStream(full);
  }

  async clearStaging(): Promise<void> {
    await rm(STAGING_DIR, { recursive: true, force: true });
  }

  /**
   * Promote the staged upload to the live feed.
   *
   * This is the gate, and it checks four things because each one has a failure
   * that is invisible until a phone tries to install:
   *
   * - the manifest names an APK that is actually here,
   * - the bytes hash to what the manifest claims, which is what catches an
   *   upload truncated by a dropped uplink,
   * - the version is newer than what is published, and
   * - the versionCode is higher -- separately, because Android compares that
   *   one and nothing else. A build with a bumped version and a forgotten code
   *   installs nowhere and reports no reason why.
   */
  async publishStaged(): Promise<AndroidRelease> {
    const manifest = await this.readManifest(STAGING_DIR).catch((e: Error) => {
      throw new Error(
        `Nothing publishable in staging: ${e.message} ` +
          `Upload ${MANIFEST} and the APK it names first.`,
      );
    });

    const apkPath = path.join(STAGING_DIR, manifest.apk);
    const stats = await stat(apkPath).catch(() => {
      throw new Error(
        `${MANIFEST} names ${manifest.apk}, which was not uploaded.`,
      );
    });

    const actual = await this.sha256(apkPath);
    if (actual !== manifest.sha256) {
      throw new Error(
        `${manifest.apk} does not match the sha256 in ${MANIFEST}. ` +
          'The upload was truncated, or the manifest is from another build.',
      );
    }

    const current = await this.latest(true);
    if (current) {
      if (compareVersions(manifest.version, current.manifest.version) <= 0) {
        throw new Error(
          `${manifest.version} is not newer than the published ` +
            `${current.manifest.version}.`,
        );
      }
      if (manifest.versionCode <= current.manifest.versionCode) {
        throw new Error(
          `versionCode ${manifest.versionCode} is not above the published ` +
            `${current.manifest.versionCode}. Android refuses an install ` +
            'whose code has not risen, so this build would reach nobody.',
        );
      }
    }

    // Written by the server, not taken from the upload: these are facts about
    // publishing rather than about the build.
    const published: AndroidManifest = {
      ...manifest,
      size: stats.size,
      publishedAt: new Date().toISOString(),
    };

    // The old APK goes. Unlike the desktop feed, where electron-updater wants
    // the previous installer beside the new one to compute a delta, nothing
    // here ever asks for a superseded build -- and leaving it would mean the
    // directory grew by 60 MB per release forever.
    await rm(ANDROID_DIR, { recursive: true, force: true });
    await mkdir(ANDROID_DIR, { recursive: true });

    // The APK is moved before the manifest is written, so the feed is never
    // momentarily advertising a file that is not there yet. Rename rather than
    // copy: same volume, so it is atomic and does not re-write 60 MB.
    await rename(apkPath, path.join(ANDROID_DIR, published.apk));
    await this.writeManifest(ANDROID_DIR, published);
    await this.clearStaging();

    this.log.log(
      `published android ${published.version} ` +
        `(versionCode ${published.versionCode}, ${published.apk})`,
    );

    const release = await this.latest(true);
    if (!release) throw new Error('Published, but the feed did not read back.');
    return release;
  }

  private async writeManifest(dir: string, manifest: AndroidManifest) {
    const out = createWriteStream(path.join(dir, MANIFEST));
    await new Promise<void>((resolve, reject) => {
      out.on('error', reject);
      out.end(`${JSON.stringify(manifest, null, 2)}\n`, () => resolve());
    });
  }
}
