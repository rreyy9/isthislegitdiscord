import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
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
 * Open a stored file for streaming. `storedName` comes from our own database,
 * but it is still resolved and checked against the upload directory — a path
 * traversal here would serve arbitrary files off the disk.
 */
export function openStored(storedName: string) {
  const full = path.resolve(UPLOAD_DIR, storedName);
  if (!full.startsWith(UPLOAD_DIR + path.sep)) {
    throw new Error('Refusing to read outside the upload directory.');
  }
  // Belt and braces: only ever stream back one of the types we accept, so a
  // bad database row cannot turn this route into a general file server.
  const known = Object.values(ALLOWED_TYPES).includes(extname(full));
  if (!known) throw new Error('Refusing to read an unexpected file type.');

  return createReadStream(full);
}
