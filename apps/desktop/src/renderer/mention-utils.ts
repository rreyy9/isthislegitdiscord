/**
 * Turning what somebody types into tags, and tags back into something
 * somebody can read.
 *
 * The composer is a plain textarea and stays one. That is the whole design
 * constraint here: a rich editor would hold the ids invisibly and there would
 * be nothing to convert, but it would also mean re-implementing selection,
 * undo, and paste — which is how a chat box becomes a project.
 *
 * So the textarea holds names, exactly as they are read, and the conversion to
 * `<@id>` happens once on the way out. Everything in this file is pure, and
 * split out from the component for the same reason `link-utils.ts` is: name
 * matching is the kind of thing that looks right and quietly is not.
 */

/**
 * A tag, on the wire: `<@userId>`.
 *
 * Declared here rather than imported from `@isthislegit/shared`, for the same
 * reason the DTOs in `api.ts` are — the renderer is an ESM bundle and the
 * shared package is CommonJS, so nothing in it is imported at runtime. This is
 * a copy of one line of that contract and has to stay in step with it; the
 * server is the side that validates, and it reads the original.
 *
 * The angle brackets are not decoration. `@` alone appears in ordinary text —
 * email addresses, "@ 3pm" — and a delimiter with a closing half is what lets
 * a display name containing spaces be a single token.
 */
export const MENTION_RE = /<@([A-Za-z0-9_-]{1,64})>/g;

/** The marker for one user id. The only place the format is written out. */
export function mentionRef(userId: string): string {
  return `<@${userId}>`;
}

/** Every id tagged in a piece of text, in order, without repeats. */
export function parseMentionIds(content: string): string[] {
  const seen = new Set<string>();
  // `matchAll` rather than `exec` in a loop: the pattern is module-level and
  // global, so a shared `lastIndex` would make two callers interfere.
  for (const m of content.matchAll(MENTION_RE)) seen.add(m[1]);
  return [...seen];
}

export interface MentionUser {
  id: string;
  username: string;
  displayName: string | null;
  /**
   * Optional because the interesting part of a MentionUser is the name: the
   * picker draws a picture beside it when there is one, and a caller that only
   * has ids and names is still a perfectly good MentionUser.
   */
  image?: string | null;
}

/** What a person is called. Display name if they set one, handle otherwise. */
export function mentionName(user: MentionUser): string {
  return user.displayName || user.username;
}

/**
 * How far back from an `@` a name is allowed to run.
 *
 * Names contain spaces, so the search cannot stop at one — but without a
 * bound, an `@` typed at the start of a paragraph would treat everything after
 * it as a possible name, and every keystroke would re-scan it.
 */
const MAX_NAME_LEN = 64;

/** Only at a word boundary, so an email address is never a tag. */
function startsToken(text: string, at: number): boolean {
  return at === 0 || /[\s([{"'`]/.test(text[at - 1]);
}

/** And a name must end at one, so "@Jon" cannot match inside "@Jonathan". */
function endsToken(text: string, at: number): boolean {
  return at >= text.length || !/[\w]/.test(text[at]);
}

/* --------------------------------------------------------- names -> ids */

interface Candidate {
  id: string;
  text: string;
  /** A display name beats a handle when two people answer to the same string. */
  preferred: boolean;
}

/**
 * Every string that names somebody, longest first.
 *
 * Both the display name and the handle are offered, because `@bob` is a
 * reasonable thing to type for someone whose display name is "Bob Smith", and
 * because somebody who has set no display name has only a handle.
 *
 * Longest first is what makes "@John Smith" tag John Smith rather than John:
 * the first match wins, so the more specific string has to be tried first.
 */
function candidates(users: MentionUser[], picked: ReadonlySet<string>): Candidate[] {
  const out: Candidate[] = [];
  for (const u of users) {
    if (u.displayName) {
      out.push({ id: u.id, text: u.displayName, preferred: picked.has(u.id) });
    }
    // Only when it is not the same string, or "@bob" would offer two
    // identical rows for one person.
    if (u.username && u.username !== u.displayName) {
      out.push({
        id: u.id,
        text: u.username,
        // A handle loses a tie with a display name, but not with nothing:
        // picking someone from the list is the strongest signal there is.
        preferred: picked.has(u.id) && !u.displayName,
      });
    }
  }
  return out.sort(
    (a, b) =>
      b.text.length - a.text.length ||
      Number(b.preferred) - Number(a.preferred) ||
      // Ties among people who genuinely share a name resolve the same way
      // every time rather than by whatever order the member list arrived in.
      a.id.localeCompare(b.id),
  );
}

/**
 * Rewrite the names in a draft as `<@id>` markers, ready to send.
 *
 * `picked` holds the ids chosen from the autocomplete list. It matters only
 * when two people answer to the same string — then the one actually clicked
 * wins, which is the only way the reader can resolve an ambiguity the app
 * cannot.
 */
export function toMarkup(
  text: string,
  users: MentionUser[],
  picked: ReadonlySet<string> = new Set(),
): string {
  if (!text.includes('@') || users.length === 0) return text;

  const options = candidates(users, picked);
  let out = '';
  let i = 0;

  while (i < text.length) {
    const at = text.indexOf('@', i);
    if (at < 0) break;

    if (!startsToken(text, at)) {
      // Not a tag position: copy the `@` and keep going from after it, so an
      // email address is passed through rather than re-examined.
      out += text.slice(i, at + 1);
      i = at + 1;
      continue;
    }

    const window = text.slice(at + 1, at + 1 + MAX_NAME_LEN).toLowerCase();
    const hit = options.find(
      (c) =>
        window.startsWith(c.text.toLowerCase()) &&
        endsToken(text, at + 1 + c.text.length),
    );

    if (!hit) {
      out += text.slice(i, at + 1);
      i = at + 1;
      continue;
    }

    out += text.slice(i, at) + mentionRef(hit.id);
    i = at + 1 + hit.text.length;
  }

  return out + text.slice(i);
}

/* --------------------------------------------------------- ids -> names */

/**
 * The inverse, for the edit box: markers back into the names they stand for.
 *
 * A marker naming somebody the client cannot identify — a member who has since
 * been removed — is left exactly as it is rather than blanked, so editing a
 * message cannot silently drop a tag that is still in it.
 */
export function toPlain(
  content: string,
  resolve: (id: string) => MentionUser | null,
): string {
  return content.replace(MENTION_RE, (whole, id: string) => {
    const user = resolve(id);
    return user ? `@${mentionName(user)}` : whole;
  });
}

/* ------------------------------------------------------------ the picker */

export interface MentionQuery {
  /** Index of the `@` itself, so the replacement knows what to overwrite. */
  start: number;
  /** What has been typed after it, which may contain spaces. */
  query: string;
}

/**
 * The tag being typed at the caret, if there is one.
 *
 * Walks back from the caret to the nearest `@` on that line. Spaces are
 * allowed, because names have them — the list narrows as you type and closes
 * on its own once nothing matches, which is what stops "@ " from leaving a
 * popup open over the rest of a sentence.
 */
export function mentionQuery(text: string, caret: number): MentionQuery | null {
  const from = Math.max(0, caret - MAX_NAME_LEN);
  const before = text.slice(from, caret);
  const at = before.lastIndexOf('@');
  if (at < 0) return null;

  const start = from + at;
  if (!startsToken(text, start)) return null;

  const query = text.slice(start + 1, caret);
  // A newline ends it: the tag being typed is on this line or it is not being
  // typed at all.
  if (query.includes('\n')) return null;
  return { start, query };
}

/** Who the list should offer for a query, best first. */
export function matchUsers(
  users: MentionUser[],
  query: string,
  limit = 8,
): MentionUser[] {
  const q = query.trim().toLowerCase();
  const scored: { user: MentionUser; score: number }[] = [];

  for (const user of users) {
    const name = mentionName(user).toLowerCase();
    const handle = user.username.toLowerCase();
    // An empty query — the moment `@` is typed — offers everybody.
    if (!q) {
      scored.push({ user, score: 2 });
      continue;
    }
    // A name that starts with what was typed is what somebody meant; one that
    // merely contains it is a guess, and sorts below.
    if (name.startsWith(q) || handle.startsWith(q)) scored.push({ user, score: 2 });
    else if (name.includes(q) || handle.includes(q)) scored.push({ user, score: 1 });
  }

  return scored
    .sort(
      (a, b) =>
        b.score - a.score ||
        mentionName(a.user).localeCompare(mentionName(b.user)),
    )
    .slice(0, limit)
    .map((s) => s.user);
}

/**
 * Put a chosen name into the draft, and say where the caret goes after it.
 *
 * A name is always followed by exactly one space — that is the separator the
 * matcher needs to find the next tag, and it is what lets you carry on typing.
 * Exactly one: picking a name in the middle of a sentence, where a space is
 * already sitting after the half-typed query, must not leave two.
 */
export function applyMention(
  text: string,
  query: MentionQuery,
  user: MentionUser,
): { text: string; caret: number } {
  const tail = text.slice(query.start + 1 + query.query.length);
  const name = `@${mentionName(user)}`;
  // A space or tab, but not a newline: a tag at the end of a line still wants
  // its own separator rather than butting against the break.
  const spaced = /^[^\S\n]/.test(tail);

  return {
    text: text.slice(0, query.start) + name + (spaced ? '' : ' ') + tail,
    // Past the space, whether it was already there or has just been added.
    caret: query.start + name.length + 1,
  };
}
