import {
  isInlineType,
  type Message,
  type MessageRef,
  type Reaction,
} from '@isthislegit/shared';

/**
 * One message, on the wire.
 *
 * Here rather than in `messages.controller.ts` because two controllers answer
 * with messages -- history and search -- and they used to hold two copies of
 * this, which is a duplication that costs nothing right up until a field is
 * added to one of them. Replies and forwards were that field.
 *
 * `withAuthor` is the Prisma include that feeds `toDto`; the two belong
 * together and are exported together, so a caller cannot select less than the
 * mapper reads.
 */

export const authorSelect = {
  select: { id: true, username: true, name: true, image: true },
} as const;

export const attachmentSelect = {
  select: {
    id: true,
    fileName: true,
    contentType: true,
    size: true,
    width: true,
    height: true,
    expiresAt: true,
    expiredAt: true,
  },
} as const;

/**
 * What a quote needs, and deliberately nothing that would let it quote another
 * quote: neither `replyTo` nor `forwardedFrom` is selected here, so the shape
 * cannot recurse however deep the chain of replies goes.
 *
 * `deletedAt` comes back so the DTO can say the original is gone; the content
 * is dropped at that point rather than filtered in the query, because the
 * pointer still has to be drawn -- a reply whose quote silently vanished reads
 * as an answer to nothing.
 */
export const refSelect = {
  select: {
    id: true,
    channelId: true,
    content: true,
    createdAt: true,
    editedAt: true,
    deletedAt: true,
    author: authorSelect,
    attachments: attachmentSelect,
  },
} as const;

export const withAuthor = {
  author: authorSelect,
  attachments: attachmentSelect,
  replyTo: refSelect,
  forwardedFrom: refSelect,
  // Who the message tagged. Read from the rows rather than re-parsed out of
  // the text, because the rows are the validated answer -- a `<@id>` naming
  // somebody who is not in the guild was never stored and must not come back
  // out of history looking like it was.
  mentions: { select: { userId: true } },
  // What people reacted with. One more join on the hot path -- every history
  // page, every search result, every socket echo -- which is affordable
  // because the table is empty for most messages and `[messageId]` is indexed.
  //
  // Ordered so the names under a pile are in the order people arrived at it,
  // which is the only order that means anything.
  reactions: {
    select: { emoji: true, userId: true },
    orderBy: { createdAt: 'asc' },
  },
} as const;

export function toAttachmentDto(a: any) {
  return {
    id: a.id,
    fileName: a.fileName,
    contentType: a.contentType,
    size: a.size,
    width: a.width ?? null,
    height: a.height ?? null,
    // A path, not a full URL: the client already knows its server address,
    // and baking one in would break the moment that address changed.
    url: `/api/attachments/${a.id}`,
    expiresAt: a.expiresAt ? a.expiresAt.toISOString() : null,
    expiredAt: a.expiredAt ? a.expiredAt.toISOString() : null,
    // Told, not inferred. The client must not decide for itself that
    // something is safe to put in an <img> -- this is the same answer the
    // download route gives, from the same function.
    inline: isInlineType(a.contentType),
  };
}

/**
 * A quoted message, for a reply's strip or a forward's card.
 *
 * A deleted original keeps its pointer and loses everything else. The row is
 * still there -- deletion is soft -- so the content has to be dropped here
 * rather than relied on to be absent, or a moderator's removal would come back
 * out through a reply somebody wrote before it.
 */
export function toRefDto(row: any): MessageRef | null {
  if (!row) return null;
  const deleted = Boolean(row.deletedAt);
  return {
    id: row.id,
    channelId: row.channelId,
    author: {
      id: row.author.id,
      username: row.author.username ?? row.author.id,
      displayName: row.author.name ?? null,
      image: row.author.image ?? null,
    },
    content: deleted ? '' : row.content,
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt ? row.editedAt.toISOString() : null,
    attachments: deleted ? [] : (row.attachments ?? []).map(toAttachmentDto),
    deleted,
  };
}

/**
 * The reaction rows on one message, gathered into one pile per emoji.
 *
 * A Map rather than a plain object, because insertion order is what puts the
 * piles in the order they were first added -- an object with emoji for keys is
 * not guaranteed to keep that, and "reactions jump around between renders" is
 * the kind of bug that is noticed long after it is introduced.
 *
 * Exported so the gateway can build one pile the same way when it broadcasts a
 * change, rather than assembling the same shape slightly differently.
 */
export function toReactionDtos(rows: any[]): Reaction[] {
  const piles = new Map<string, string[]>();
  for (const row of rows ?? []) {
    const users = piles.get(row.emoji);
    if (users) users.push(row.userId);
    else piles.set(row.emoji, [row.userId]);
  }
  return [...piles].map(([emoji, userIds]) => ({ emoji, userIds }));
}

export function toDto(row: any): Message {
  return {
    id: row.id,
    channelId: row.channelId,
    author: {
      id: row.author.id,
      username: row.author.username ?? row.author.id,
      displayName: row.author.name ?? null,
      image: row.author.image ?? null,
    },
    content: row.content,
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt ? row.editedAt.toISOString() : null,
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    clientNonce: row.clientNonce ?? null,
    pinnedAt: row.pinnedAt ? row.pinnedAt.toISOString() : null,
    mentions: (row.mentions ?? []).map((m: any) => m.userId),
    attachments: (row.attachments ?? []).map(toAttachmentDto),
    replyTo: toRefDto(row.replyTo),
    forwardedFrom: toRefDto(row.forwardedFrom),
    reactions: toReactionDtos(row.reactions),
  };
}
