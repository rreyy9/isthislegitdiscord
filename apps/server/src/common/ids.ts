import { v7 as uuidv7 } from 'uuid';

/**
 * All application ids are UUIDv7: random-looking but time-ordered, so a plain
 * `ORDER BY id` is chronological order and message paging needs no extra
 * column or index.
 */
export function newId(): string {
  return uuidv7();
}

/** Short, human-typable invite code. Avoids characters that misread aloud. */
export function newInviteCode(length = 8): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < length; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}
