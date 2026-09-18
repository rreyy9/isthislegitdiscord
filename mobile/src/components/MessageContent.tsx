import { memo, useMemo } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';
import { emojiOnly } from '../emoji';
import { MENTION_RE } from '../format';
import { firstEmbed, URL_RE } from '../link-utils';
import { theme } from '../theme';
import type { Attachment } from '../types';
import { AttachmentView } from './Attachments';
import { EmbedView } from './Embeds';

/**
 * A message's words, and everything they turn into.
 *
 * Deliberately not a markdown renderer, for the reason the desktop client is
 * not one: message text is written by other people, and the whole job here is
 * splitting on a pattern and building elements. There is no path by which
 * message content becomes markup, because there is no markup.
 *
 * The one structural difference from the desktop version is that links open
 * through `Linking` rather than `window.open`. Same rule behind it -- a link in
 * a message goes to the real browser, never inside the app -- but here it also
 * means a YouTube link opens the YouTube app, which is what somebody tapping it
 * was hoping for.
 */

/**
 * Both patterns in one pass.
 *
 * Two passes would mean the second walking over text the first has already
 * turned into elements -- the classic way a link inside a name, or a name
 * inside a link, comes out mangled. One alternation means every character
 * belongs to exactly one token. Group 1 is the mention's id; the URL half
 * captures nothing, so its presence is what tells the two apart.
 */
const TOKEN_RE = new RegExp(`${URL_RE.source}|${MENTION_RE.source}`, 'gi');

/** How a `<@id>` becomes a name, supplied by whoever has the member list. */
export interface MentionLookup {
  (id: string): { name: string; self: boolean } | null;
}

export interface MessageContentProps {
  content: string;
  attachments: Attachment[];
  /** Adds the small "(edited)" mark, inline at the end of the text. */
  edited?: boolean;
  /**
   * Resolves a tagged id to a name. Omitted -- as it is anywhere without a
   * member list -- tags draw as "@unknown" rather than as raw markers.
   */
  lookupMention?: MentionLookup;
  /** Draw link embeds at all. The `showEmbeds` preference. */
  showEmbeds?: boolean;
  /** Load a player without waiting for a tap. The `autoplayEmbeds` preference. */
  autoplayEmbeds?: boolean;
  /**
   * Suppress embeds and attachments, leaving only the words.
   *
   * What the pin board, the search results and the reply strip want: all three
   * are lists you read to find a message and then jump to it, and a video
   * player inside a row that is really a link is a control nobody can use.
   */
  textOnly?: boolean;
}

export const MessageContent = memo(function MessageContent({
  content,
  attachments,
  edited = false,
  lookupMention,
  showEmbeds = true,
  autoplayEmbeds = false,
  textOnly = false,
}: MessageContentProps) {
  /**
   * The runs of the message, worked out once per content change rather than
   * per render. The list re-renders whenever anybody types, and re-scanning
   * every message on screen for URLs each time is the difference between a list
   * that scrolls and one that stutters.
   */
  const parts = useMemo(() => {
    const out: {
      kind: 'text' | 'link' | 'mention';
      text: string;
      id?: string;
    }[] = [];
    let last = 0;

    for (const match of content.matchAll(TOKEN_RE)) {
      const whole = match[0];
      const mentionId = match[1];
      const at = match.index ?? 0;

      if (at > last) out.push({ kind: 'text', text: content.slice(last, at) });
      last = at + whole.length;

      if (mentionId !== undefined) out.push({ kind: 'mention', text: whole, id: mentionId });
      else out.push({ kind: 'link', text: whole });
    }
    if (last < content.length) out.push({ kind: 'text', text: content.slice(last) });
    return out;
  }, [content]);

  const embed = useMemo(
    () => (showEmbeds && !textOnly ? firstEmbed(content) : null),
    [content, showEmbeds, textOnly],
  );

  /**
   * A message that is nothing but emoji is drawn large. It is not the same kind
   * of message as a paragraph, and at body size it is a line of specks.
   *
   * Read off `content` rather than off `parts`, because a tag or a link in
   * there is exactly what makes it ordinary text again -- and `emojiOnly` says
   * so by finding something that is not an emoji.
   */
  const big = useMemo(() => emojiOnly(content), [content]);

  return (
    <View>
      {(content.length > 0 || edited) && (
        <Text
          style={[styles.body, big ? bigStyle(big) : null]}
          // Long-press to select is the platform's own gesture and would fight
          // the message's own long-press menu, so selection is off and copying
          // is an entry in that menu instead.
          selectable={false}
        >
          {parts.map((part, i) => {
            if (part.kind === 'mention') {
              const who = lookupMention?.(part.id!) ?? null;
              return (
                <Text
                  key={i}
                  style={[
                    styles.mention,
                    who?.self && styles.mentionSelf,
                    !who && styles.mentionUnknown,
                  ]}
                >
                  {/* A tag naming somebody this client cannot identify --
                      usually a member who has since been removed. Named rather
                      than left as a raw marker, which is an id and tells the
                      reader nothing, and not hidden, which would quietly
                      rewrite what was said. */}
                  @{who?.name ?? 'unknown'}
                </Text>
              );
            }
            if (part.kind === 'link') {
              return (
                <Text
                  key={i}
                  style={styles.link}
                  onPress={() => {
                    // A URL that no app will take is not worth an error: the
                    // pattern only ever matches http and https, so a refusal
                    // here means the phone has no browser, which is not a
                    // situation this app can improve.
                    void Linking.openURL(part.text).catch(() => {});
                  }}
                >
                  {part.text}
                </Text>
              );
            }
            return <Text key={i}>{part.text}</Text>;
          })}
          {edited && <Text style={styles.edited}> (edited)</Text>}
        </Text>
      )}

      {!textOnly &&
        attachments.map((file) => <AttachmentView key={file.id} file={file} />)}

      {embed && <EmbedView embed={embed} autoplay={autoplayEmbeds} />}
    </View>
  );
});

/**
 * How large "large" is, by how many there are.
 *
 * Three sizes rather than a formula: one emoji on its own is a reply and gets
 * the biggest; a handful is a reaction in message form; more than that is a
 * row, and shrinking it is what keeps it on one line instead of filling the
 * screen with a wall the reader has to scroll past.
 */
function bigStyle(count: number) {
  if (count === 1) return styles.big1;
  if (count <= 3) return styles.big2;
  return styles.big3;
}

const styles = StyleSheet.create({
  body: {
    color: theme.text,
    fontSize: 15,
    lineHeight: 21,
  },
  big1: { fontSize: 40, lineHeight: 48 },
  big2: { fontSize: 32, lineHeight: 40 },
  big3: { fontSize: 24, lineHeight: 30 },
  link: {
    color: theme.accent,
    // No underline: on a dark background the accent colour is already the whole
    // signal, and an underline under a URL that wraps across three lines is
    // three underlined fragments.
    textDecorationLine: 'none',
  },
  mention: {
    color: theme.accent,
    fontWeight: '600',
  },
  mentionSelf: {
    color: theme.mentionBorder,
  },
  mentionUnknown: {
    color: theme.textMuted,
    fontWeight: '400',
  },
  edited: {
    color: theme.textFaint,
    fontSize: 11,
  },
});
