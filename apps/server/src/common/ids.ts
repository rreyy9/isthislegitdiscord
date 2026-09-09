import { randomInt } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';

/**
 * All application ids are UUIDv7: random-looking but time-ordered, so a plain
 * `ORDER BY id` is chronological order and message paging needs no extra
 * column or index.
 */
export function newId(): string {
  return uuidv7();
}

/**
 * Short, human-typable invite code. Avoids characters that misread aloud.
 *
 * `randomInt` and not `Math.random()`, which is what this was: V8 seeds its
 * PRNG from a source an attacker does not see, but the generator is not one --
 * given enough output from the same process its internal state is solvable and
 * every subsequent draw is predictable. An invite code is the entire perimeter
 * around registration on this server, and codes are handed out by the same
 * process that would be leaking the state.
 *
 * `randomInt(max)` is also rejection-sampled inside Node, so the alphabet does
 * not have to be a power of two to stay uniform -- the `% alphabet.length` this
 * would otherwise need biases toward the first character every time the two do
 * not divide evenly, and 31 divides nothing.
 */
export function newInviteCode(length = 8): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < length; i++) {
    out += alphabet[randomInt(alphabet.length)];
  }
  return out;
}
