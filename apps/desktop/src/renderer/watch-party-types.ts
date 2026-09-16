/**
 * What a watch party looks like on the wire, declared here rather than
 * imported from `@isthislegit/shared`.
 *
 * That is not an oversight. This app imports nothing from the shared package
 * and redeclares the DTOs it needs -- see `version.ts`, `mention-utils.ts` and
 * the note in the README's decisions list. A workspace dependency for a
 * handful of pure interfaces is a worse trade than the copy, and the copy is
 * what keeps the desktop build independent of the server's.
 *
 * The cost is the usual one: **change one, change both.** The originals are
 * `WatchPartyState`, `WatchPartyVideo` and `WatchPartyChatLine` in
 * `packages/shared/src/index.ts`.
 *
 * Nothing here is runtime-validated, which is deliberate and is most of this
 * app's forward compatibility: a field the server adds arrives and is ignored,
 * and an event this build never registered is dropped on the floor.
 */

export interface WatchPartyVideoDto {
  id: string;
  /** The eleven-character YouTube id. */
  videoId: string;
  /** Often just the video id: the title is best effort. See `fetchVideoTitle`. */
  title: string;
  /** Seconds, or null when nobody has managed to find out. */
  duration: number | null;
  addedBy: string;
  addedAt: string;
}

export interface WatchPartyStateDto {
  id: string;
  guildId: string;
  title: string;
  hostId: string;
  /** Arrival order, which is also the order the host is inherited in. */
  watchers: string[];
  /** `queue[0]` is on screen; the rest are up next. */
  queue: WatchPartyVideoDto[];
  playing: boolean;
  /** Where the video was at `positionAt`, in seconds. */
  position: number;
  /** The server's clock, in milliseconds, when `position` was true. */
  positionAt: number;
  /** The server's clock when it sent this, for measuring skew. */
  serverTime: number;
  startedAt: string;
}

export interface WatchPartyChatDto {
  partyId: string;
  id: string;
  userId: string;
  content: string;
  at: string;
}

export type WatchPartyActionName = 'play' | 'pause' | 'seek' | 'skip';

/** Every party emit is acked, so the caller learns a refusal rather than guessing. */
export interface PartyAck {
  ok: boolean;
  state?: WatchPartyStateDto;
}
