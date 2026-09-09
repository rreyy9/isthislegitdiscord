import type { MessageDto } from '../api';

/**
 * The types the chat screen and the pieces split out of it both need.
 *
 * A separate file rather than exports from Chat.tsx, so that a modal importing
 * one type does not import the whole screen -- which is a cycle, and the kind
 * that a bundler resolves silently and at the wrong moment.
 */

export type Status = 'connected' | 'disconnected' | 'connecting';

/**
 * A message plus client-only fields for optimistic rendering: `pending` while
 * the server has not confirmed it, `failed` with the reason if it never got
 * there, and `previews` so a pasted image is visible immediately rather than
 * after the round trip.
 */
export type Msg = MessageDto & {
  pending?: boolean;
  failed?: string;
  previews?: string[];
};

/**
 * A file waiting in the composer.
 *
 * `ready` is the whole reason this is an object rather than a `File`. A file
 * picked from a network share or a drive that has since been unplugged looks
 * perfectly fine until something tries to read it, and the something used to
 * be the upload itself -- so the failure arrived after the message had already
 * left the box, as a send that could not be retried into working. Checking
 * first costs a moment and turns that into a chip that says so while it can
 * still be removed.
 */
export interface Staged {
  /** Stable across removals, unlike the index the list used to be keyed by. */
  id: string;
  file: File;
  preview: string | null;
  ready: boolean;
  /** Why this file cannot be sent, or null. Blocks the send while it is set. */
  problem: string | null;
}

/** What a confirm modal needs to know. Kick, ban and delete all use it. */
export interface Confirmation {
  title: string;
  body: string;
  confirmLabel: string;
  run: () => Promise<void>;
}
