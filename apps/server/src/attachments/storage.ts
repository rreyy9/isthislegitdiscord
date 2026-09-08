import { createReadStream } from 'node:fs';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { extname } from 'node:path';
import { newId } from '../common/ids';
import { imageSize } from './image-size';

/**
 * Files on local disk, named by id.
 *
 * Anything may be uploaded. Only pictures are kept: everything else is given a
 * deadline at upload time, because the point is handing a file to somebody,
 * not becoming the place that file lives.
 *
 * Two rules make accepting arbitrary bytes safe on a server that speaks plain
 * HTTP on a box with ports open, and neither may be relaxed without thinking
 * about the other:
 *
 *  1. Nothing is stored under an extension this file does not choose. A
 *     picture keeps a real one; everything else is `.bin`. `resolveStored`
 *     below checks that extension before opening or deleting anything, and
 *     that check is what stops a bad row turning the download route into a
 *     general file server. It stays a closed set.
 *  2. Nothing but a picture is ever served in a form a browser would render.
 *     See the attachments controller: an uploaded page handed back inline
 *     would be script running against this API's own origin.
 */

/** Pictures: kept indefinitely, drawn in the message list, real extension. */
export const IMAGE_TYPES: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

/**
 * Avatars are still pictures only, and this is the map that says so.
 *
 * Kept under the old name because the profile routes gate on it and mean
 * exactly this: the crop editor produces a PNG, and an avatar is drawn inline
 * for every signed-in member, which is the one thing rule 2 above forbids for
 * anything else.
 */
export const ALLOWED_TYPES = IMAGE_TYPES;

/** What everything else is stored as, whatever it claims to be. */
const OPAQUE_EXT = '.bin';

/** Every extension this server will open or delete. A closed set, by design. */
const STORED_EXTENSIONS = new Set([...Object.values(IMAGE_TYPES), OPAQUE_EXT]);

export const UPLOAD_DIR = path.resolve(
  process.env.UPLOAD_DIR ?? path.join(process.cwd(), '..', '..', 'data', 'uploads'),
);

/**
 * The prefix `user.image` holds for an avatar this server stores.
 *
 * Here rather than beside the route that serves them, because it is the only
 * way anything outside the profile controller can tell which files in
 * UPLOAD_DIR are avatars — and the file sweeper has to know. It got this
 * wrong once: counting only Attachment rows made every avatar look like a
 * file nothing pointed at, which is a stray, which is something the sweeper
 * deletes.
 */
export const AVATAR_PATH = '/api/avatars/';

/** The stored file name inside a `user.image`, or null if it is not one of ours. */
export function avatarStoredName(image: string | null): string | null {
  if (!image || !image.startsWith(AVATAR_PATH)) return null;
  const name = image.slice(AVATAR_PATH.length);
  // The column has held a plain URL in the past — Better Auth writes one for
  // an OAuth account — so a value that is not one of ours must not reach the
  // file layer.
  return /^[A-Za-z0-9_-]+\.[a-z]{3,4}$/.test(name) ? name : null;
}

export const maxUploadBytes = () =>
  Number(process.env.MAX_UPLOAD_BYTES ?? 26214400);

export interface StoredFile {
  id: string;
  storedName: string;
  fileName: string;
  contentType: string;
  size: number;
  width: number | null;
  height: number | null;
  /** True for the picture types. Decides both how it is served and whether it is kept. */
  isImage: boolean;
}

/**
 * Write one uploaded buffer to disk and describe it.
 *
 * `imagesOnly` is what the avatar route passes: an avatar is drawn inline for
 * every signed-in member, so it is the one upload path that cannot accept
 * arbitrary bytes.
 */
export async function store(
  file: { originalname: string; mimetype: string; buffer: Buffer },
  opts: { imagesOnly?: boolean } = {},
): Promise<StoredFile> {
  const imageExt = IMAGE_TYPES[file.mimetype];
  if (opts.imagesOnly && !imageExt) {
    throw new Error(`Unsupported file type: ${file.mimetype}`);
  }

  // A picture keeps a real extension because something may legitimately want
  // to look at it as one. Everything else is stored opaque -- the name on
  // disk says nothing about what is inside, which is the point: the row
  // carries the real name and type, and the file layer keeps a closed set of
  // extensions it is willing to touch.
  const ext = imageExt ?? OPAQUE_EXT;

  await mkdir(UPLOAD_DIR, { recursive: true });

  const id = newId();
  const storedName = id + ext;
  await writeFile(path.join(UPLOAD_DIR, storedName), file.buffer);

  // Only meaningful for pictures, and it reads the header rather than
  // trusting the type -- so something claiming to be a PNG and not being one
  // simply has no dimensions rather than breaking the list.
  const dims = imageExt ? imageSize(file.buffer) : null;

  return {
    id,
    storedName,
    // The original name is only ever shown, or offered as a download
    // filename, so strip any path from it: it is attacker-controlled text.
    // Separators of both kinds, because a name typed on one platform arrives
    // on the other and `path.basename` on Linux keeps backslashes.
    fileName: sanitiseName(file.originalname) || 'file' + ext,
    contentType: file.mimetype,
    size: file.buffer.length,
    width: dims?.width ?? null,
    height: dims?.height ?? null,
    isImage: Boolean(imageExt),
  };
}

/**
 * An uploaded name reduced to something safe to show and to save as.
 *
 * Never used to open anything -- the file on disk is named by id -- but it is
 * handed to the client as a download filename, so it must not carry a path,
 * and it must not carry the control characters that would let it lie about
 * its own extension in a list.
 */
function sanitiseName(name: string): string {
  // Separators of both kinds. A name typed on Windows arrives on a Linux
  // server, where `path.basename` keeps backslashes and would hand back the
  // whole "C:\Users\me\thing.exe" as the filename.
  const base = path.basename(String(name ?? '').replace(/\\/g, '/'));

  // Written as a scan rather than one regular expression on purpose: the
  // interesting characters here are invisible ones, and a character class
  // full of literal control codes is unreadable and easy to get wrong.
  let out = '';
  for (const ch of base) {
    const code = ch.codePointAt(0)!;
    // Control characters, including DEL.
    if (code < 0x20 || code === 0x7f) continue;
    // What Windows refuses in a filename, so a save dialog cannot be handed
    // something it will reject.
    if ('<>:"/\\|?*'.includes(ch)) continue;
    // The bidirectional overrides. One of these is how a file genuinely
    // named "annexe<RLO>txt.exe" is drawn in a list as "annexe.exe.txt" --
    // the reader sees a text file and downloads a program.
    if (code >= 0x202a && code <= 0x202e) continue;
    if (code >= 0x2066 && code <= 0x2069) continue;
    out += ch;
  }

  return out.trim().slice(0, 200);
}

/**
 * A stored name to a path inside the upload directory.
 *
 * `storedName` comes from our own database, but it is still resolved and
 * checked here — a path traversal would turn any of the routes below into a
 * general file server — and the extension is checked too, so a bad row cannot
 * make one serve or delete something that was never an upload.
 */
function resolveStored(storedName: string): string {
  const full = path.resolve(UPLOAD_DIR, storedName);
  if (!full.startsWith(UPLOAD_DIR + path.sep)) {
    throw new Error('Refusing to touch a file outside the upload directory.');
  }
  if (!STORED_EXTENSIONS.has(extname(full))) {
    throw new Error('Refusing to touch an unexpected file type.');
  }
  return full;
}

/**
 * Whether a stored file is actually on disk.
 *
 * Worth asking before opening one, because `createReadStream` does not fail
 * until something reads it: by then the response has been handed to the
 * framework, and a file that is simply not there comes back as a stream error
 * rather than the 404 it is. An avatar reaches that state normally — replacing
 * your picture deletes the old file, and anything still holding the old path
 * will ask for it.
 */
export async function storedExists(storedName: string): Promise<boolean> {
  try {
    await access(resolveStored(storedName));
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete a stored file, if there is one and it is one of ours.
 *
 * Best effort on purpose: this runs after the row that pointed at the file has
 * already been updated, so the caller has nothing useful to do with a failure
 * and an unreferenced file on disk is not worth failing a request over.
 */
export async function discardStored(storedName: string | null): Promise<void> {
  if (!storedName) return;
  try {
    await rm(resolveStored(storedName), { force: true });
  } catch {
    // Left on disk. Nothing referenced it, and nothing will.
  }
}

/** Open a stored file for streaming. Throws if the name is not one of ours. */
export function openStored(storedName: string) {
  return createReadStream(resolveStored(storedName));
}
