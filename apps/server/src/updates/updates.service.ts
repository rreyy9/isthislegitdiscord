import { Injectable, Logger } from '@nestjs/common';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { compareVersions } from '@isthislegit/shared';

/**
 * The desktop client's update feed.
 *
 * electron-updater against a `generic` provider, which is a directory holding
 * three files per release: `latest.yml`, the NSIS installer, and the blockmap
 * that turns the second update into a delta rather than another full download.
 *
 * Served without authentication. The build already refuses to ship a `.env` or
 * a real key pair, so the installer carries no secret -- and the moment an
 * update matters most is when somebody's session has lapsed and they are
 * stranded on an old build. A feed that needs a token fails exactly then.
 *
 * The client will only use this over https. The NSIS build is unsigned, so
 * electron-updater cannot check a publisher name; what it can check is the
 * sha512 in latest.yml against the file it downloaded. That makes TLS the root
 * of the chain, and over plain http there is no root at all.
 */

export const UPDATES_DIR = path.resolve(
  process.env.UPDATES_DIR ??
    path.join(process.cwd(), '..', '..', 'data', 'updates'),
);

/** The desktop client's channel. One today; the path leaves room for another. */
const DESKTOP_DIR = path.join(UPDATES_DIR, 'desktop');

/**
 * Where an upload lands before it is published.
 *
 * The client is built on somebody's development machine and the server runs on
 * a different box, so the files have to travel. They arrive here first and are
 * promoted only once the set validates -- otherwise a half-finished upload
 * would be a live feed, and clients would start downloading an installer whose
 * last few megabytes were still in flight.
 */
const STAGING_DIR = path.join(UPDATES_DIR, 'staging');

/** Refuses an upload long before it can fill the disk. */
export const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

/**
 * Nothing else is served, whatever ends up in the directory. A feed folder is
 * not a file host.
 */
const SERVED = /\.(ya?ml|exe|blockmap)$/i;

export interface PublishedRelease {
  version: string;
  files: string[];
  bytes: number;
  publishedAt: string;
}

@Injectable()
export class UpdatesService {
  private readonly log = new Logger(UpdatesService.name);
  private cache: { at: number; release: PublishedRelease | null } | null = null;

  /**
   * The version in latest.yml.
   *
   * Split on newlines and matched per line rather than with a multiline
   * regex. A pattern anchored with `$` against a CRLF file matches nothing,
   * because `\r` is not whitespace to a character class -- which is the same
   * failure that once shipped a placeholder LiveKit key.
   */
  private static versionFrom(yaml: string): string | null {
    for (const line of yaml.split(/\r?\n/)) {
      const m = line.match(/^version:\s*(.+?)\s*$/);
      if (m) return m[1].replace(/^['"]|['"]$/g, '');
    }
    return null;
  }

  async latest(force = false): Promise<PublishedRelease | null> {
    if (!force && this.cache && Date.now() - this.cache.at < 10_000) {
      return this.cache.release;
    }

    let release: PublishedRelease | null = null;
    try {
      const yaml = await readFile(path.join(DESKTOP_DIR, 'latest.yml'), 'utf8');
      const version = UpdatesService.versionFrom(yaml);
      if (version) {
        const names = (await readdir(DESKTOP_DIR)).filter((n) => SERVED.test(n));
        let bytes = 0;
        for (const n of names) {
          bytes += (await stat(path.join(DESKTOP_DIR, n))).size;
        }
        const st = await stat(path.join(DESKTOP_DIR, 'latest.yml'));
        release = {
          version,
          files: names.sort(),
          bytes,
          publishedAt: st.mtime.toISOString(),
        };
      }
    } catch {
      // Nothing published yet. Not an error; the client simply never offers
      // an update.
      release = null;
    }

    this.cache = { at: Date.now(), release };
    return release;
  }

  async latestVersion(): Promise<string | null> {
    return (await this.latest())?.version ?? null;
  }

  /**
   * Open one file from the feed for streaming.
   *
   * `name` comes off the URL, so it is resolved and checked against the feed
   * directory: a traversal here would serve arbitrary files off the disk to
   * an unauthenticated caller.
   */
  open(name: string) {
    const full = path.resolve(DESKTOP_DIR, name);
    if (!full.startsWith(DESKTOP_DIR + path.sep)) {
      throw new Error('Refusing to read outside the update directory.');
    }
    if (!SERVED.test(full)) {
      throw new Error('Refusing to serve that file type.');
    }
    return createReadStream(full);
  }

  size(name: string): Promise<number> {
    const full = path.resolve(DESKTOP_DIR, name);
    if (!full.startsWith(DESKTOP_DIR + path.sep)) {
      throw new Error('Refusing to read outside the update directory.');
    }
    return stat(full).then((s) => s.size);
  }

  /**
   * Copy a built release into the feed.
   *
   * Building and publishing stay two steps, so a half-finished build cannot
   * reach ten machines by landing in the right folder. This is the gate: the
   * three files have to be present and agree with each other, and the version
   * has to be newer than what is already published.
   */
  async publish(sourceDir: string): Promise<PublishedRelease> {
    const src = path.resolve(sourceDir);

    const yamlPath = path.join(src, 'latest.yml');
    let yaml: string;
    try {
      yaml = await readFile(yamlPath, 'utf8');
    } catch {
      throw new Error(`No latest.yml in ${src}. Run the desktop build first.`);
    }

    const version = UpdatesService.versionFrom(yaml);
    if (!version) throw new Error('latest.yml has no version line.');

    // The installer named by latest.yml, not whatever .exe happens to be
    // there: a release folder accumulates old builds, and publishing the
    // wrong one is indistinguishable from publishing the right one until ten
    // machines have installed it.
    const named = new Set<string>();
    for (const line of yaml.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:-\s*)?url:\s*(.+?)\s*$/);
      if (m) named.add(decodeURIComponent(m[1].replace(/^['"]|['"]$/g, '')));
    }
    if (!named.size) throw new Error('latest.yml names no installer file.');

    const wanted = ['latest.yml'];
    for (const n of named) {
      wanted.push(n);
      // The blockmap sits beside the installer and is what makes the next
      // update a delta. Missing, updates still work and simply download in
      // full, so it is wanted but not required.
      const blockmap = `${n}.blockmap`;
      try {
        await stat(path.join(src, blockmap));
        wanted.push(blockmap);
      } catch {
        this.log.warn(`no ${blockmap}; updates will download in full`);
      }
    }

    for (const name of wanted) {
      await stat(path.join(src, name)).catch(() => {
        throw new Error(`latest.yml names ${name}, which is not in ${src}.`);
      });
    }

    const current = await this.latest(true);
    if (current && compareVersions(version, current.version) <= 0) {
      throw new Error(
        `${version} is not newer than the published ${current.version}.`,
      );
    }

    await mkdir(DESKTOP_DIR, { recursive: true });
    for (const name of wanted) {
      await copyFile(path.join(src, name), path.join(DESKTOP_DIR, name));
    }

    this.log.log(`published desktop ${version} (${wanted.length} files)`);
    const published = await this.latest(true);
    if (!published) throw new Error('Published, but the feed did not read back.');
    return published;
  }

  get directory(): string {
    return DESKTOP_DIR;
  }

  /* ------------------------------------------------------------- staging */

  get stagingDirectory(): string {
    return STAGING_DIR;
  }

  /**
   * Resolve one upload's destination.
   *
   * The name comes off the URL, so it is reduced to its basename, checked
   * against the same whitelist the feed serves, and resolved back inside the
   * staging directory. An upload route that can be talked into writing
   * elsewhere is worse than one that can be talked into reading elsewhere.
   */
  private stagedPath(name: string): string {
    // A name has to already be its own basename. Reducing it to one would be
    // safe -- `../evil.exe` becomes `evil.exe` inside staging either way --
    // but silently storing a file under a different name than the caller
    // asked for is how a release ends up missing the file latest.yml names,
    // with nothing saying why. Refuse instead.
    if (!name || name !== path.basename(name) || !SERVED.test(name)) {
      throw new Error(`Refusing to store ${name}.`);
    }
    const full = path.resolve(STAGING_DIR, name);
    if (!full.startsWith(STAGING_DIR + path.sep)) {
      throw new Error('Refusing to write outside the staging directory.');
    }
    return full;
  }

  /** Open one staged file for writing. The caller streams the body into it. */
  async openStaged(name: string) {
    const full = this.stagedPath(name);
    await mkdir(STAGING_DIR, { recursive: true });
    return createWriteStream(full);
  }

  /** What is waiting to be published, if anything. */
  async staged(): Promise<PublishedRelease | null> {
    try {
      const yaml = await readFile(path.join(STAGING_DIR, 'latest.yml'), 'utf8');
      const version = UpdatesService.versionFrom(yaml);
      if (!version) return null;

      const names = (await readdir(STAGING_DIR)).filter((n) => SERVED.test(n));
      let bytes = 0;
      for (const n of names) bytes += (await stat(path.join(STAGING_DIR, n))).size;
      const st = await stat(path.join(STAGING_DIR, 'latest.yml'));
      return {
        version,
        files: names.sort(),
        bytes,
        publishedAt: st.mtime.toISOString(),
      };
    } catch {
      return null;
    }
  }

  async clearStaging(): Promise<void> {
    await rm(STAGING_DIR, { recursive: true, force: true });
  }

  /**
   * Promote what was uploaded.
   *
   * Staging is emptied afterwards so a later upload cannot be published
   * alongside the leftovers of an earlier one -- `latest.yml` names the files
   * that matter, but a stale installer sitting in the feed is confusing at
   * best.
   */
  async publishStaged(): Promise<PublishedRelease> {
    const release = await this.publish(STAGING_DIR);
    await this.clearStaging();
    return release;
  }
}
