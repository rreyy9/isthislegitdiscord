import { createReadStream } from 'node:fs';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { extname } from 'node:path';
import { newId } from '../common/ids';
import { imageSize } from './image-size';

/**
 * Files on local disk, named by id.
 *
 * Only images are accepted. That is partly the feature people asked for
 * (pasting a screenshot) and partly a decision: this server speaks plain HTTP
 * on a box with ports open, and a general-purpose file host that anyone with
 * an invite can write to is a bigger thing to own than a screenshot pipe.
 */

export const ALLOWED_TYPES: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

export const UPLOAD_DIR = path.resolve(
  process.env.UPLOAD_DIR ?? path.join(process.cwd(), '..', '..', 'data', 'uploads'),
);

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
}

/** Write one uploaded buffer to disk and describe it. */
export async function store(file: {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
}): Promise<StoredFile> {
  const ext = ALLOWED_TYPES[file.mimetype];
  if (!ext) throw new Error(`Unsupported file type: ${file.mimetype}`);

  await mkdir(UPLOAD_DIR, { recursive: true });

  const id = newId();
  const storedName = id + ext;
  await writeFile(path.join(UPLOAD_DIR, storedName), file.buffer);

  const dims = imageSize(file.buffer);

  return {
    id,
    storedName,
    // The original name is only ever shown or used as a download filename, so
    // strip any path from it: it is attacker-controlled text.
    fileName: path.basename(file.originalname || 'image' + ext).slice(0, 200),
    contentType: file.mimetype,
    size: file.buffer.length,
    width: dims?.width ?? null,
    height: dims?.height ?? null,
  };
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
  if (!Object.values(ALLOWED_TYPES).includes(extname(full))) {
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
