import { z } from 'zod';

/**
 * Shared contracts. Imported by both the server and the desktop client so the
 * two cannot drift: one declaration gives the server its runtime validator and
 * the client its static type.
 */

/* ------------------------------------------------------------------ enums */

export const ChannelKind = z.enum(['TEXT', 'VOICE']);
export type ChannelKind = z.infer<typeof ChannelKind>;

export const MemberRole = z.enum(['ADMIN', 'MEMBER']);
export type MemberRole = z.infer<typeof MemberRole>;

/* ------------------------------------------------------------------ models */

export const PublicUser = z.object({
  id: z.string(),
  username: z.string(),
  displayName: z.string().nullable(),
  image: z.string().nullable(),
});
export type PublicUser = z.infer<typeof PublicUser>;

export const Channel = z.object({
  id: z.string(),
  guildId: z.string(),
  name: z.string(),
  kind: ChannelKind,
  position: z.number().int(),
  /**
   * A voice channel nobody may speak in — somewhere to be parked rather than
   * somewhere to talk. People join it, hear each other's absence, and their
   * microphone is never granted.
   *
   * Not called `muted`, which is taken twice over and means neither of these
   * things: a member has a `mutedUntil`, which is a punishment aimed at one
   * person, and "mute channel" in every other chat client means silencing its
   * notifications for yourself. This is a property of the room, it applies to
   * everyone in it including admins, and it says exactly what it does.
   *
   * Always false on a text channel. Speaking is not something a text channel
   * does, so the flag has nothing to say about one.
   */
  listenOnly: z.boolean(),
});
export type Channel = z.infer<typeof Channel>;

export const Guild = z.object({
  id: z.string(),
  name: z.string(),
  channels: z.array(Channel),
});
export type Guild = z.infer<typeof Guild>;

export const Attachment = z.object({
  id: z.string(),
  fileName: z.string(),
  contentType: z.string(),
  size: z.number().int(),
  /** Null when the format was not recognised; the list then cannot reserve space. */
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  /** Path on the API, not a full URL — the client knows its own server address. */
  url: z.string(),
  /**
   * When this file will be removed from the server, or null for one that is
   * kept indefinitely.
   *
   * Only pictures are kept. Everything else is a courier: it is here so
   * somebody can hand a file to somebody else, not so this box becomes the
   * place that file lives. The client is told the deadline at the moment of
   * upload and shows it on the message, because a file that disappears
   * without warning is worse than one that was never accepted.
   */
  expiresAt: z.string().nullable(),
  /**
   * Set once the deadline passed and the bytes were removed. The row survives
   * so the message still says what was there -- deleting it would leave a
   * message that was only a file rendering as a blank gap.
   */
  expiredAt: z.string().nullable(),
  /**
   * Whether this build should try to draw the file inline. False for
   * everything the server will only ever hand back as a download.
   */
  inline: z.boolean(),
});
export type Attachment = z.infer<typeof Attachment>;

/**
 * How long a non-image upload lives.
 *
 * Two days: long enough to cover "I will grab it tomorrow", short enough that
 * nobody starts treating the server as a file share. Shared rather than kept
 * on the server so the client can say "expires in 47 hours" without being
 * told the policy separately.
 */
export const EPHEMERAL_FILE_HOURS = 48;

/**
 * Pictures. Drawn in the message list, and the only uploads kept indefinitely.
 */
export const INLINE_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const;

/**
 * Video that plays in the message list rather than being saved first.
 *
 * The two formats Chromium plays everywhere without a codec question: MP4
 * (H.264/AAC) and WebM (VP8/VP9). Deliberately not a `video/*` wildcard --
 * this list decides what the server labels as itself on the way back out, and
 * an open-ended one would put types nobody has thought about on that side of
 * the boundary.
 *
 * Video is drawn but not kept: see `isKeptType`. A video is the largest thing
 * anyone sends, and the deal on the upload button is that anything which is
 * not a picture is being handed over rather than stored.
 */
export const INLINE_VIDEO_TYPES = ['video/mp4', 'video/webm'] as const;

/**
 * The types drawn in the message list rather than offered as a download.
 *
 * This is the whole safety boundary for accepting arbitrary uploads: anything
 * not on this list is served as an octet-stream attachment that no browser
 * will render, so an uploaded page cannot become script running against the
 * API's own origin.
 *
 * The rule for adding to it is not "the client can show it" but "the browser
 * treats it as media, never as a document": an <img> or a <video> decodes
 * these into pixels, and there is no shape of MP4 or PNG that becomes script
 * on this origin. Anything with a document nature -- HTML, SVG, PDF -- stays
 * off it however convenient inline would be.
 */
export const INLINE_TYPES = [
  ...INLINE_IMAGE_TYPES,
  ...INLINE_VIDEO_TYPES,
] as const;

export const isInlineType = (contentType: string): boolean =>
  (INLINE_TYPES as readonly string[]).includes(contentType);

export const isInlineVideoType = (contentType: string): boolean =>
  (INLINE_VIDEO_TYPES as readonly string[]).includes(contentType);

/**
 * Whether an upload is kept indefinitely rather than given a deadline.
 *
 * Pictures, and nothing else. Separate from `isInlineType` on purpose, because
 * the two questions came apart the moment video was drawn inline: "can this be
 * shown" is about what a browser does with the bytes, "is this kept" is about
 * whose disk they sit on. A ten-minute screen recording is the conversation
 * while people are reading it and a permanent tenant afterwards.
 */
export const isKeptType = (contentType: string): boolean =>
  (INLINE_IMAGE_TYPES as readonly string[]).includes(contentType);

/**
 * One message pointing at another: what a reply quotes above itself, and what
 * a forward carries into the channel it was sent to.
 *
 * One type for both, deliberately. They are the same thing — a bounded,
 * one-level-deep pointer to another message — and writing two would be
 * inventing a distinction that is not there and then maintaining it.
 *
 * It is `Message` minus the fields that would make it recursive, so a chain of
 * replies cannot nest: a ref never carries a ref. That is a property of the
 * shape rather than of a depth check somewhere, which is the point.
 *
 * Derived on every read from a join, never stored. A copy of the text taken at
 * send time would say something the original no longer says the moment it is
 * edited, and would keep a name its author has since changed — the same reason
 * tags travel as ids. The parent row is looked up by primary key, so the join
 * costs nothing worth denormalising for.
 */
export const MessageRef = z.object({
  id: z.string(),
  /**
   * Where the original lives. A reply's is always this channel; a forward's is
   * wherever it was taken from, and it is what makes the card clickable.
   */
  channelId: z.string(),
  author: PublicUser,
  /** Empty when `deleted` — a removed message must not come back out here. */
  content: z.string(),
  createdAt: z.string(),
  editedAt: z.string().nullable(),
  attachments: z.array(Attachment),
  /**
   * The original was deleted. The pointer survives, because a reply with its
   * quote silently removed reads as an answer to nothing; what goes is the
   * content, which the client replaces with a line saying so.
   */
  deleted: z.boolean(),
});
export type MessageRef = z.infer<typeof MessageRef>;

/* --------------------------------------------------------------- reactions */

/**
 * How many distinct emoji one message may carry.
 *
 * A cap for the reason `MAX_PINS_PER_CHANNEL` is one: the row is drawn under
 * every message, and an unbounded one stops being a reaction and becomes a
 * second message. Twenty is Discord's number and is well past what anybody
 * uses. One person may add as many of those twenty as they like; what is
 * capped is the number of different emoji on the message, not the number of
 * people who agreed with one.
 */
export const MAX_REACTIONS_PER_MESSAGE = 20;

/**
 * Whether a string is one emoji, by Unicode's own definition of the set that
 * is meant to be displayable everywhere.
 *
 * The `v` flag is ES2024, which is why this package targets it. Matching a
 * property *of strings* rather than of characters is what makes a family of
 * five codepoints and four joiners one match instead of nine.
 */
const RGI_EMOJI = /^\p{RGI_Emoji}$/v;

/**
 * One spelling per emoji, or null for anything that is not one.
 *
 * Reactions arrive from a client, in a URL, so this is the same rule tags get:
 * what turns up is a claim, not a fact. `\p{RGI_Emoji}` answers the "is it an
 * emoji" half on its own and needs no table to do it -- it accepts ZWJ
 * families, skin tones and flags, and refuses `a`, `👍👍` and `:smile:`.
 *
 * The other half is the one that bites. RGI is strict about U+FE0F, the
 * variation selector, in *both* directions and by emoji:
 *
 *     👍  (1F44D)       matches      👍️ (1F44D FE0F)  does NOT
 *     ❤️  (2764 FE0F)   matches      ❤  (2764)        does NOT
 *
 * A character that is already emoji-presentation must not carry the selector;
 * one that defaults to text presentation must. Emoji datasets hand out the
 * fully-qualified form, which is the wrong one for about two thirds of them --
 * so a bare RGI test refuses characters a picker itself produced. And without
 * a rule that settles on one form, `👍` and `👍️` are two different strings,
 * two different rows, and two reaction piles on one message that look
 * identical and cannot be merged.
 *
 * So: drop the selector where it is not wanted, keep it where it is, add it
 * where it is missing. Verified over the whole emojibase set including every
 * skin-tone variant -- 3,953 sequences, none rejected, no two collapsing onto
 * one another, and running it twice changes nothing.
 *
 * One thing to know before upgrading Node: `\p{RGI_Emoji}` is tied to the
 * *runtime's* Unicode tables, not to any dataset. A server on an older Node
 * than the client's emoji data will refuse the newest handful of emoji, and
 * the refusal is a 400 rather than anything mysterious -- but it is worth
 * knowing that the fix is the server, not the client.
 */
export function canonicalEmoji(input: string): string | null {
  const bare = input.replace(/️/g, '');
  if (RGI_EMOJI.test(bare)) return bare;
  if (RGI_EMOJI.test(input)) return input;
  const qualified = bare + '️';
  return RGI_EMOJI.test(qualified) ? qualified : null;
}

/**
 * One pile of reactions on a message: the emoji, and everyone who added it.
 *
 * The ids rather than a count and a `me` flag, and that is deliberate. One
 * `Message` object is broadcast to everybody in the channel, so a per-viewer
 * field on it would be wrong for all but one of them -- the same problem
 * `mentions` has and the same answer: send the list, and let each client ask
 * whether it is in it. It also hands the tooltip its names for nothing, which
 * a bare count cannot do.
 *
 * Bounded by `MAX_REACTIONS_PER_MESSAGE` times the size of the guild, which
 * for the deployment this is built for is a few hundred short strings on the
 * busiest message anyone will ever send.
 */
export const Reaction = z.object({
  emoji: z.string(),
  /** Everyone who added it, oldest first. */
  userIds: z.array(z.string()),
});
export type Reaction = z.infer<typeof Reaction>;

export const Message = z.object({
  id: z.string(),
  channelId: z.string(),
  author: PublicUser,
  content: z.string(),
  createdAt: z.string(),
  editedAt: z.string().nullable(),
  deletedAt: z.string().nullable(),
  /** Echoed back so a client can match its optimistic copy and drop the duplicate. */
  clientNonce: z.string().nullable(),
  attachments: z.array(Attachment),
  /**
   * Who this message tagged, resolved by the server from the `<@id>` markers
   * in `content`.
   *
   * Sent rather than left for the client to re-parse because the server has
   * already had to work it out: it checks every id against the guild before
   * storing it, so this is the validated list and the text is only a claim.
   * The author is never in it -- tagging yourself is not a tag.
   */
  mentions: z.array(z.string()),
  /**
   * When an admin pinned this message, or null. A field on the message rather
   * than a separate list, because that is what it is -- one message is pinned
   * or it is not, and every place that already carries a message (history, the
   * socket echo, the pin list itself) then carries its pin state for free.
   */
  pinnedAt: z.string().nullable(),
  /**
   * The message this one answers, or null. Always in the same channel: a reply
   * is part of a conversation, and one that pointed somewhere else would be a
   * quote wearing the wrong word.
   */
  replyTo: MessageRef.nullable(),
  /**
   * The message this one carries into this channel from elsewhere, or null.
   *
   * A forward is a pointer, not a copy: the card draws the original's author,
   * text and files, so nobody's words can be re-posted under somebody else's
   * name. Forwarding a forward follows the chain at the moment it is sent, so
   * this is always the original and never another forward.
   */
  forwardedFrom: MessageRef.nullable(),
  /**
   * What people have reacted with, and who. Empty for the overwhelming
   * majority of messages, which is why it costs nothing to carry here rather
   * than to fetch separately.
   *
   * On the message rather than on its own endpoint for the reason `pinnedAt`
   * is: every place that already hands over a message -- history, a window
   * around a search result, the socket echo -- then hands over its reactions
   * for free, and there is no second call that can disagree with the first.
   */
  reactions: z.array(Reaction),
});
export type Message = z.infer<typeof Message>;

/* -------------------------------------------------------------- pins */

/**
 * How many messages one channel may hold pinned.
 *
 * A cap rather than none, and a low one on purpose: the list is meant to be
 * the handful of things worth reading before you say anything, and a pin board
 * of two hundred messages is just the channel again. Discord settles on fifty
 * for the same reason, and fifty is also small enough that the list is one
 * query with no paging.
 */
export const MAX_PINS_PER_CHANNEL = 50;

/* ---------------------------------------------------------------- mentions */

/**
 * A tag, on the wire.
 *
 * Message text carries `<@userId>`, not the name that was typed. Names are the
 * one thing about a person that changes -- somebody sets a nicer display name
 * and every message that ever tagged them would otherwise be tagging a string
 * that now belongs to nobody, or worse, to someone else who has since taken
 * it. The id never moves, so the client resolves it against the member list at
 * the moment it draws the message and a rename rewrites history for free.
 *
 * The angle brackets are not decoration: `@` alone appears in ordinary text
 * (email addresses, "@ 3pm"), and a delimiter with a closing half is what lets
 * a name containing spaces be one token.
 */
export const MENTION_RE = /<@([A-Za-z0-9_-]{1,64})>/g;

/** The marker for one user id. The only place the format is written down. */
export function mentionRef(userId: string): string {
  return `<@${userId}>`;
}

/**
 * Every id tagged in a piece of text, in order, without repeats.
 *
 * Used by the server to work out who to notify; the ids are unvalidated at
 * this point, because anyone can type angle brackets. Whether they name a real
 * member of the guild is a database question, and the server asks it before it
 * stores or notifies anything.
 */
export function parseMentionIds(content: string): string[] {
  const seen = new Set<string>();
  // The regex is module-level and global, so `matchAll` is what keeps this
  // reentrant -- `exec` in a loop would share `lastIndex` between callers.
  for (const m of content.matchAll(MENTION_RE)) seen.add(m[1]);
  return [...seen];
}

/**
 * Unread tags, per channel. Separate from the unread dot on purpose: a channel
 * with new messages is worth a look eventually, and a channel where somebody
 * has said your name is worth a look now. Discord draws one as a dot and the
 * other as a number, and it is the number people actually respond to.
 */
export const ChannelMentions = z.object({
  channelId: z.string(),
  count: z.number().int(),
});
export type ChannelMentions = z.infer<typeof ChannelMentions>;

/* ------------------------------------------------------------- http inputs */

export const RegisterInput = z.object({
  username: z
    .string()
    .min(2)
    .max(32)
    .regex(/^[a-z0-9_.]+$/i, 'letters, numbers, underscore and dot only'),
  password: z.string().min(8).max(200),
  inviteCode: z.string().min(4).max(64),
  displayName: z.string().min(1).max(64).optional(),
});
export type RegisterInput = z.infer<typeof RegisterInput>;

/**
 * Editing your own profile. Both fields are optional and applied only when
 * present, so the settings screen can send the one thing that changed.
 *
 * `image` is write-cleared rather than write-set: an avatar arrives as bytes
 * on the upload route, and the only thing the client may say about it here is
 * that it should go away. Letting a client put an arbitrary string in the
 * column would make it a place to store a URL the app then renders.
 */
export const UpdateProfileInput = z.object({
  displayName: z.string().trim().min(1).max(64).optional(),
  removeAvatar: z.literal(true).optional(),
});
export type UpdateProfileInput = z.infer<typeof UpdateProfileInput>;

/** How big an avatar may be, before it is scaled down in the client. */
export const MAX_AVATAR_BYTES = 4 * 1024 * 1024;

export const LoginInput = z.object({
  username: z.string().min(2).max(32),
  password: z.string().min(1).max(200),
});
export type LoginInput = z.infer<typeof LoginInput>;

/**
 * How long one message may be.
 *
 * Named rather than repeated as a literal because the client checks it too:
 * the composer refusing an over-long message with a count in the message is a
 * far better answer than a 400 the sender has to guess at.
 */
export const MAX_MESSAGE_CHARS = 4000;

export const SendMessageInput = z.object({
  channelId: z.string(),
  // Empty content is allowed when there are attachments: a pasted screenshot
  // with nothing typed is a normal thing to send.
  content: z.string().max(MAX_MESSAGE_CHARS),
  clientNonce: z.string().max(64).optional(),
  attachmentIds: z.array(z.string()).max(10).optional(),
  /**
   * The message being answered. Must be in the channel being sent to; the
   * server checks rather than trusts, since this arrives from a client.
   */
  replyToId: z.string().optional(),
  /**
   * Whether the reply tags whoever wrote the message it answers.
   *
   * Defaults to true, because that is what replying is for and a reply nobody
   * hears about is a message that happens to sit under another one. The switch
   * exists for the second and third message of a back-and-forth, where the
   * other person is already reading.
   *
   * Not stored anywhere: it decides whether one `MessageMention` row is
   * written, and that row is the record. An edit re-resolves the text and
   * leaves the row alone either way, so this cannot be changed afterwards --
   * which is right, since the ping has either already happened or already not.
   *
   * Preprocessed rather than a plain boolean because a reply with a file on it
   * is sent as multipart, and every field of a multipart body is a string. The
   * two spellings accepted here are what a `FormData` append of a boolean
   * produces; anything else falls through to the boolean check and is refused.
   */
  replyPing: z
    .preprocess(
      (v) => (v === 'true' ? true : v === 'false' ? false : v),
      z.boolean(),
    )
    .optional(),
  /**
   * A message to carry into this channel from elsewhere in the same guild.
   *
   * Sent through the ordinary send route rather than one of its own, because
   * that is exactly what a forward is: a message in the target channel. It
   * gets the same broadcast, the same optimistic echo and the same nonce.
   */
  forwardedFromId: z.string().optional(),
});
export type SendMessageInput = z.infer<typeof SendMessageInput>;

export const EditMessageInput = z.object({
  content: z.string().max(MAX_MESSAGE_CHARS),
});
export type EditMessageInput = z.infer<typeof EditMessageInput>;

export const MessageHistoryQuery = z.object({
  /** Cursor: return messages older than this id. Omit for the newest page. */
  before: z.string().optional(),
  /**
   * Cursor the other way: messages newer than this id, oldest first. Used to
   * fill in the gap after landing somewhere in the middle of a channel.
   */
  after: z.string().optional(),
  /**
   * A window centred on one message, which is what jumping to a search result
   * or a pin needs.
   *
   * Paging backwards cannot express it: `before` walks from the newest message
   * and would have to fetch everything in between to reach something said in
   * March. This asks for that message with half a page either side of it.
   *
   * Takes precedence over `before` and `after` when more than one is sent,
   * rather than erroring -- the three are cursors into the same list and a
   * client that sends two has a bug worth surviving.
   */
  around: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type MessageHistoryQuery = z.infer<typeof MessageHistoryQuery>;

/* ------------------------------------------------------------------ search */

export const SearchQuery = z.object({
  /** What was typed. Parsed by Postgres, not by us. */
  q: z.string().trim().min(1).max(200),
  /** Narrow to one guild; omitted, it searches everywhere the caller can read. */
  guildId: z.string().optional(),
  channelId: z.string().optional(),
  authorId: z.string().optional(),
  /** Cursor: results older than this message id. */
  before: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
});
export type SearchQuery = z.infer<typeof SearchQuery>;

export const SearchPage = z.object({
  /** Newest first -- the opposite of history, because a search is a list. */
  results: z.array(Message),
  nextCursor: z.string().nullable(),
});
export type SearchPage = z.infer<typeof SearchPage>;

export const CreateInviteInput = z.object({
  maxUses: z.number().int().min(1).max(100).default(1),
  expiresInHours: z.number().int().min(1).max(24 * 365).default(24 * 7),
});
export type CreateInviteInput = z.infer<typeof CreateInviteInput>;

/* ------------------------------------------------------- moderation inputs */

/**
 * A mute takes away one thing: the microphone.
 *
 * It is not a removal and not a gag on the whole app. A muted person stays in
 * the voice channel they are sitting in, keeps hearing everyone, and keeps
 * typing in text channels — the only difference is that nothing they say into
 * a microphone is published. That is what "mute" means everywhere else people
 * have used it, and the earlier reading of it (ejected from voice, refused
 * entry back, unable to send messages) was three punishments wearing one name.
 *
 * A deadline, not a flag: it expires on its own, so nothing has to remember to
 * lift it. `durationMinutes: null` means indefinite — stored as a date far
 * enough out that it will never arrive.
 */
export const MuteMemberInput = z.object({
  durationMinutes: z.number().int().min(1).max(60 * 24 * 28).nullable(),
  reason: z.string().max(200).optional(),
});
export type MuteMemberInput = z.infer<typeof MuteMemberInput>;

export const RemoveMemberInput = z.object({
  reason: z.string().max(200).optional(),
});
export type RemoveMemberInput = z.infer<typeof RemoveMemberInput>;

/* ------------------------------------------------------------ admin inputs */

export const AdminCreateUserInput = z.object({
  username: z
    .string()
    .min(2)
    .max(32)
    .regex(/^[a-z0-9_.]+$/i, 'letters, numbers, underscore and dot only'),
  password: z.string().min(8).max(200),
  displayName: z.string().min(1).max(64).optional(),
  role: MemberRole.default('MEMBER'),
  guildId: z.string(),
});
export type AdminCreateUserInput = z.infer<typeof AdminCreateUserInput>;

export const AdminUpdateUserInput = z.object({
  displayName: z.string().min(1).max(64).optional(),
  role: MemberRole.optional(),
  guildId: z.string().optional(),
});
export type AdminUpdateUserInput = z.infer<typeof AdminUpdateUserInput>;

export const AdminSetPasswordInput = z.object({
  password: z.string().min(8).max(200),
});
export type AdminSetPasswordInput = z.infer<typeof AdminSetPasswordInput>;

export const CreateChannelInput = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[^\s#@]+$/, 'no spaces or # @ characters'),
  kind: ChannelKind.default('TEXT'),
  position: z.number().int().min(0).max(999).optional(),
  /**
   * Make this an AFK room: joinable, audible, with nobody able to talk. See
   * `Channel.listenOnly`.
   *
   * Accepted on a text channel and ignored there rather than refused — the
   * kind decides, and `ChannelsService` is where that is written down, so a
   * caller cannot get a text channel that claims to be listen-only whichever
   * way it asks.
   */
  listenOnly: z.boolean().default(false),
});
export type CreateChannelInput = z.infer<typeof CreateChannelInput>;

export const UpdateChannelInput = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[^\s#@]+$/, 'no spaces or # @ characters')
    .optional(),
  position: z.number().int().min(0).max(999).optional(),
});
export type UpdateChannelInput = z.infer<typeof UpdateChannelInput>;

export const CreateGuildInput = z.object({
  name: z.string().min(1).max(64),
});
export type CreateGuildInput = z.infer<typeof CreateGuildInput>;

/* ------------------------------------------------------------ http outputs */

/**
 * Opus settings, decided by the server rather than each client.
 *
 * Audio quality is a property of the deployment, not of a person's preferences:
 * the bitrate everyone publishes at is what the host's uplink has to carry, and
 * one person quietly picking "studio" costs bandwidth for the whole room. So it
 * is set once in the server's environment and handed to clients, the same way
 * `livekitUrl` is — a shipped desktop app would otherwise need a reinstall to
 * change a constant.
 */
export const VoiceQuality = z.enum(['voice', 'balanced', 'high', 'studio']);
export type VoiceQuality = z.infer<typeof VoiceQuality>;

export const VoiceAudioConfig = z.object({
  quality: VoiceQuality,
  /** Opus target, bits per second. */
  maxBitrate: z.number().int(),
  /**
   * Two channels. Only meaningful with echo cancellation off — Chromium
   * forces a mono capture whenever AEC is on — so the client treats this as a
   * request rather than a promise.
   */
  stereo: z.boolean(),
  /**
   * Discontinuous transmission: stop sending during silence. Saves bandwidth
   * but can clip the start of a word, so it is on only for the lowest preset.
   */
  dtx: z.boolean(),
  /**
   * Redundant audio data. Costs a little bandwidth and buys a lot of
   * resilience to packet loss — the single biggest quality win on a bad link.
   */
  red: z.boolean(),
});
export type VoiceAudioConfig = z.infer<typeof VoiceAudioConfig>;

export const ServerConfig = z.object({
  /** e.g. ws://203.0.113.10:7880 — never baked into the shipped client. */
  livekitUrl: z.string(),
  maxUploadBytes: z.number().int(),
  appVersion: z.string(),
  voiceAudio: VoiceAudioConfig,
  /**
   * The newest desktop build published to this server, or null when none has
   * been. A client compares it with its own version and offers an update; it
   * is never a reason to refuse service.
   */
  latestClientVersion: z.string().nullable(),
  /**
   * A floor, and expected to stay null. Set only for a change that genuinely
   * cannot be made compatible — an auth change, a security fix. Blocking ten
   * people until each notices a dialog is worse than the skew it avoids, so
   * reaching for this is evidence the additive rules were not followed.
   */
  minClientVersion: z.string().nullable(),
});
export type ServerConfig = z.infer<typeof ServerConfig>;

/**
 * A row in the member list. `mutedUntil` is sent to everyone, not just admins:
 * the marker next to a name is what tells people why someone has gone quiet.
 */
export const GuildMemberDto = z.object({
  guildId: z.string(),
  role: MemberRole,
  online: z.boolean(),
  mutedUntil: z.string().nullable(),
  /**
   * When this person's last connection was seen, or null for an account that
   * has never signed in from a build that recorded it.
   *
   * Sent as an instant rather than as "3 hours ago", because the phrasing is a
   * rendering decision and the two machines disagree about the time anyway:
   * a duration computed on the server is already stale by the time it is
   * drawn, and stays stale until the next fetch. The client subtracts from its
   * own clock and re-renders on a timer.
   *
   * Meaningful mainly while `online` is false. For somebody connected right
   * now it is the start of the session they are still in, which nothing draws.
   */
  lastSeenAt: z.string().nullable(),
  user: PublicUser,
});
export type GuildMemberDto = z.infer<typeof GuildMemberDto>;

export const MessagePage = z.object({
  messages: z.array(Message),
  /** Pass as `before` to fetch the next older page. Null when fully scrolled back. */
  nextCursor: z.string().nullable(),
  /**
   * Pass as `after` to fetch the next newer page. Null at the live end of the
   * channel, which is where every page used to start -- so this is null for
   * every request that does not use `around`, and an older client that never
   * reads it is unaffected.
   */
  prevCursor: z.string().nullable(),
});
export type MessagePage = z.infer<typeof MessagePage>;

export const VoiceTokenResponse = z.object({
  token: z.string(),
  livekitUrl: z.string(),
  room: z.string(),
  /**
   * Sent with the token, not just from `/api/config`, because this is the
   * moment the client is about to publish. Changing the server's setting
   * therefore takes effect on everyone's next join, with no app restart.
   */
  audio: VoiceAudioConfig,
  /**
   * The room this token is for is listen-only, so the grant above carries no
   * microphone. See `Channel.listenOnly`.
   *
   * Told to the client rather than left to be discovered, and told *here*
   * rather than read off the channel list, because this is the one moment the
   * answer is needed before anything happens: the client is about to open a
   * capture device for audio the server would refuse. The channel list arrives
   * separately and can be a render behind, which is long enough to light
   * somebody's microphone indicator for a track that goes nowhere.
   */
  listenOnly: z.boolean(),
});
export type VoiceTokenResponse = z.infer<typeof VoiceTokenResponse>;

/**
 * Who is sitting in a voice channel. Kept server-side from LiveKit's webhooks
 * so the sidebar can show occupants to people who have not joined the room —
 * a client only learns about participants in rooms it is actually connected to.
 */
export const VoiceChannelState = z.object({
  channelId: z.string(),
  userIds: z.array(z.string()),
});
export type VoiceChannelState = z.infer<typeof VoiceChannelState>;

/**
 * How far each channel has been read. `lastReadMessageId` is compared against
 * message ids directly — they are UUIDv7, so id order is time order and
 * "anything newer than this" needs no timestamp column.
 */
export const ChannelRead = z.object({
  channelId: z.string(),
  lastReadMessageId: z.string().nullable(),
});
export type ChannelRead = z.infer<typeof ChannelRead>;

export const MarkReadInput = z.object({
  lastReadMessageId: z.string(),
});
export type MarkReadInput = z.infer<typeof MarkReadInput>;

/* --------------------------------------------------- storage and retention */

/**
 * The retention policy. Every field is nullable and null means "keep", so an
 * unset policy — which is what a fresh install has — deletes nothing at all.
 * Turning retention on is an explicit act, and it has to be, because this is
 * the one feature whose job is to destroy data nobody has a second copy of.
 */
export const RetentionPolicy = z.object({
  /**
   * Media is nearly all of the bytes, so it gets its own knob. Expiring
   * images while the text of the conversation lives forever is the policy
   * most people actually want.
   */
  attachmentsMaxAgeDays: z.number().int().positive().nullable(),
  messagesMaxAgeDays: z.number().int().positive().nullable(),
  /** Soft-deleted messages: the row and its files outlive the deletion. */
  softDeletedMaxAgeDays: z.number().int().positive().nullable(),
  /**
   * The one that actually bounds the disk. Age limits nothing if ten people
   * paste two hundred screenshots in a week; over the cap, oldest goes first.
   */
  uploadsMaxTotalBytes: z.number().int().positive().nullable(),
  /** The sweeper does nothing at all while this is false. */
  enabled: z.boolean(),
});
export type RetentionPolicy = z.infer<typeof RetentionPolicy>;

export const RETENTION_DEFAULTS: RetentionPolicy = {
  attachmentsMaxAgeDays: null,
  messagesMaxAgeDays: null,
  /**
   * Thirty days rather than null, alone among these.
   *
   * A tombstone is a message somebody already chose to delete; it is kept only
   * so the deletion can be looked into, and a month is longer than anyone
   * looks. The others destroy things people still expect to have, so they stay
   * null. None of it happens until `enabled` is switched on -- this is what
   * the switch does when it is, not something it does by itself.
   */
  softDeletedMaxAgeDays: 30,
  uploadsMaxTotalBytes: null,
  enabled: false,
};

/** What a policy would remove if it ran now. Shown before anything is saved. */
export const RetentionPreview = z.object({
  messages: z.number().int(),
  attachments: z.number().int(),
  bytes: z.number().int(),
});
export type RetentionPreview = z.infer<typeof RetentionPreview>;

export const PURGE_KINDS = [
  /**
   * The one the console offers, and the only one somebody has to understand:
   * everything that was already deleted, actually removed.
   *
   * Deleting a message hides it and keeps the row, so the images stay on the
   * disk and nothing is freed — which is right, because it is what lets a
   * deletion be looked into afterwards, and wrong as a permanent state. This
   * finishes the job: the rows go, their files go, and the space is handed
   * back to the operating system rather than left inside the tables.
   *
   * `tombstones` below does the same selection with an age filter. This one
   * takes no age on purpose: "remove what I deleted" is not a question about
   * dates, and an operator who wants one has the retention policy.
   */
  'deleted',
  'orphaned-files',
  'orphaned-rows',
  'tombstones',
  'retention',
] as const;

export const PurgeInput = z.object({
  kind: z.enum(PURGE_KINDS),
  /** Only for `tombstones`; null means every tombstone regardless of age. */
  olderThanDays: z.number().int().nonnegative().nullable().optional(),
  /**
   * Default true, and the caller has to say `false` on purpose. A destructive
   * endpoint whose safe mode is opt-in is a destructive endpoint that runs by
   * accident.
   */
  dryRun: z.boolean().optional(),
});
export type PurgeInput = z.infer<typeof PurgeInput>;

export const PurgeResult = z.object({
  kind: z.enum(PURGE_KINDS),
  dryRun: z.boolean(),
  messages: z.number().int(),
  attachments: z.number().int(),
  files: z.number().int(),
  bytes: z.number().int(),
});
export type PurgeResult = z.infer<typeof PurgeResult>;

export const TableSize = z.object({
  table: z.string(),
  rows: z.number().int(),
  totalBytes: z.number().int(),
  indexBytes: z.number().int(),
});
export type TableSize = z.infer<typeof TableSize>;

export const StorageReport = z.object({
  database: z.object({
    bytes: z.number().int(),
    tables: z.array(TableSize),
  }),
  uploads: z.object({
    files: z.number().int(),
    bytes: z.number().int(),
    directory: z.string(),
  }),
  /** Null when the volume could not be read; the page still renders. */
  disk: z
    .object({ freeBytes: z.number().int(), totalBytes: z.number().int() })
    .nullable(),
  orphans: z.object({
    /** Rows whose file is gone: a broken image, and unrecoverable. */
    rowsWithoutFile: z.number().int(),
    /** Files no row points at: wasted bytes, and safe to sweep. */
    filesWithoutRow: z.number().int(),
    bytesWithoutRow: z.number().int(),
  }),
  tombstones: z.object({
    messages: z.number().int(),
    attachments: z.number().int(),
    bytes: z.number().int(),
  }),
});
export type StorageReport = z.infer<typeof StorageReport>;

/* ------------------------------------------------------------ client skew */

/**
 * Compare two dotted versions. Positive when `a` is newer than `b`.
 *
 * Written out rather than compared as strings, because "0.10.0" < "0.9.0" is
 * true of strings and false of versions -- and the first time that matters is
 * the tenth release, by which point the wrong answer looks like a client that
 * refuses to update.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    // Build metadata (1.2.3+abc) is not part of ordering at all.
    const [core, ...rest] = v.trim().replace(/^v/i, '').split('+')[0].split('-');
    const nums = (t: string) =>
      t.split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : 0));
    return {
      core: nums(core),
      // A prerelease sorts BELOW the release it precedes: 1.2.3-beta.1 is
      // older than 1.2.3, not newer. Treating the suffix as just more numbers
      // gets this backwards, which would offer a beta as an upgrade over the
      // final build and refuse to publish the final build over the beta.
      pre: rest.length ? nums(rest.join('-')) : null,
    };
  };

  const pa = parse(a);
  const pb = parse(b);

  for (let i = 0; i < Math.max(pa.core.length, pb.core.length); i += 1) {
    const d = (pa.core[i] ?? 0) - (pb.core[i] ?? 0);
    if (d !== 0) return d;
  }

  if (!pa.pre && !pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;

  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i += 1) {
    const d = (pa.pre[i] ?? 0) - (pb.pre[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}


/**
 * What one connected client says it is. Reported by the client on connect and
 * kept only in memory — this is telemetry for deciding when compatibility code
 * is safe to delete, not a record worth a table.
 */
export const ConnectedClient = z.object({
  userId: z.string(),
  username: z.string().nullable(),
  version: z.string().nullable(),
  connections: z.number().int(),
});
export type ConnectedClient = z.infer<typeof ConnectedClient>;

/** The header a REST call carries its version in. */
export const CLIENT_VERSION_HEADER = 'x-client-version';

/* ------------------------------------------------------- socket.io events */

/** Server -> client. */
export interface ServerToClientEvents {
  'message:new': (message: Message) => void;
  'message:updated': (message: Message) => void;
  'message:deleted': (payload: { id: string; channelId: string }) => void;
  /**
   * A member's moderation state changed — today that means muted or unmuted.
   * Everyone gets it, because everyone's member list shows the mute marker.
   */
  'member:updated': (payload: {
    guildId: string;
    userId: string;
    mutedUntil: string | null;
  }) => void;
  /**
   * Sent only to the person it happened to. Their client has just lost access
   * and has to stop pretending otherwise.
   */
  'moderation:removed': (payload: {
    guildId: string;
    kind: 'kick' | 'ban';
    reason: string | null;
  }) => void;
  /**
   * Somebody tagged you.
   *
   * Sent to `user:<id>` rather than to the channel room, because that is the
   * whole point of a tag: it has to reach you in a channel you are not looking
   * at, which is exactly the case `message:new` cannot cover -- a client only
   * joins the room for the channel on screen.
   *
   * Carries the message so the client can raise a notification with the text
   * in it without going back to the server for a channel it has never opened.
   */
  'mention:new': (payload: {
    message: Message;
    /** For the notification's title; the client may not know this channel. */
    channelName: string;
    /**
     * Why they are being told. A reply is a tag by another route -- same row
     * in the same table, same badge, same sound -- and the only thing that
     * differs is the sentence on the toast, which is what this is for.
     *
     * Optional, because a server older than replies sends no such field and a
     * client reading it with `??` gets the only thing that server could have
     * meant.
     */
    kind?: 'mention' | 'reply';
  }) => void;
  /**
   * A message in this channel was pinned or unpinned.
   *
   * Sent to the channel room, which is exactly the reach it needs: the pin
   * marker and the pin list are both drawn for the channel on screen, and a
   * client only joins the room for that one. Nothing off-screen changes when
   * somebody pins something, so there is nobody else to tell.
   *
   * Carries the state rather than the message: every client in that room
   * already has the message, and the ones that do not -- scrolled far back --
   * ask for the pin list when they open it.
   */
  'pin:changed': (payload: {
    channelId: string;
    messageId: string;
    /** ISO date when it was pinned, null when it was just unpinned. */
    pinnedAt: string | null;
  }) => void;
  /**
   * Somebody added or removed a reaction.
   *
   * A new event rather than a `message:updated` carrying the whole message,
   * which is the cheap way to ship anything additive: a client too old to know
   * about reactions never registered a handler and drops it, where a changed
   * `message:updated` would reach every client whether or not it understood.
   * It also keeps a click on an emoji from re-broadcasting a message and every
   * quote of it.
   *
   * To the channel room, like `pin:changed` and for the same reason -- the only
   * thing that changes is what is drawn for the channel on screen, and that is
   * the one room a client joins. A reaction to a message in a channel nobody
   * here is looking at is missed, which costs nothing: history carries
   * reactions, so opening that channel asks for and gets the current state.
   *
   * Carries the whole pile for that one emoji rather than a delta. A client
   * applying "+1 to 👍" has to have had the right number to start with, and
   * one that has been asleep has not; a pile it can drop in place is correct
   * however far behind it was. An empty `userIds` means the last person took
   * theirs back and the pile is gone.
   */
  'reaction:changed': (payload: {
    channelId: string;
    messageId: string;
    emoji: string;
    userIds: string[];
  }) => void;
  /**
   * Somebody came online or went offline.
   *
   * `lastSeenAt` rides along so the member list can put "last seen a moment
   * ago" under a name the instant it dims, rather than showing nothing there
   * until the next `/api/members`. On the way up it is the previous session's
   * mark, which the client stops drawing anyway once the dot turns green.
   */
  'presence:changed': (payload: {
    userId: string;
    online: boolean;
    lastSeenAt: string | null;
  }) => void;
  'typing:changed': (payload: {
    channelId: string;
    userId: string;
    typing: boolean;
  }) => void;
  'voice:participants': (payload: {
    channelId: string;
    userIds: string[];
  }) => void;
  /**
   * A newer desktop build has been published. Sent on connect to a client that
   * is already behind, and broadcast when one is published so an app that has
   * been open all evening finds out without reconnecting.
   *
   * Additive by construction: a client too old to have registered a handler
   * drops it, which is the whole reason new features arrive as new events.
   */
  'client:update-available': (payload: { version: string }) => void;
}

/** Client -> server. */
export interface ClientToServerEvents {
  'channel:join': (payload: { channelId: string }) => void;
  'channel:leave': (payload: { channelId: string }) => void;
  'typing:start': (payload: { channelId: string }) => void;
  'typing:stop': (payload: { channelId: string }) => void;
}

export const SOCKET_PATH = '/socket.io';
