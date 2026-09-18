import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Avatar } from './Avatar';
import { MessageContent } from './MessageContent';
import { personName, plainMentions, quoteLine, timeOf } from '../format';
import { radius, spacing, theme } from '../theme';
import type { Message, MessageRef } from '../types';

/**
 * One message.
 *
 * `memo`, and it earns it: the list re-renders whenever anybody types, and a
 * channel holds a few hundred of these. Every prop is a primitive, a stable
 * callback or the message object itself -- which is replaced rather than
 * mutated whenever the server sends a new version -- so the shallow compare is
 * exactly right.
 *
 * Grouping is decided by the caller and arrives as `grouped`, because it is a
 * fact about the message *above* this one and a row cannot see its neighbour.
 *
 * Every action on a message is behind a long press. There is no hover on a
 * phone, so the desktop client's toolbar-on-hover has nowhere to live; a long
 * press is the gesture people already use for exactly this, in every messaging
 * app they have.
 */

export interface MessageRowProps {
  message: Message;
  /** Same author, same day, within five minutes: drop the header. */
  grouped: boolean;
  /** Tagged this reader. Draws the highlight down the side. */
  highlighted: boolean;
  /** Not yet acknowledged by the server. Drawn dimmed. */
  pending?: boolean;
  /** Failed to send. Drawn with a note rather than removed. */
  failed?: boolean;
  /** How far a send with files has got, 0..1. Absent for a plain message. */
  progress?: number | null;
  /** The message is the one a jump landed on, and is briefly lit. */
  flashing?: boolean;
  meId: string;
  nameFor: (userId: string) => string | null;
  /** Preferences, so an embed is drawn only where the reader asked for one. */
  showEmbeds: boolean;
  autoplayEmbeds: boolean;

  /** Opens the action sheet. The only way to reach anything on a message. */
  onLongPress: (message: Message) => void;
  /** Add or take back a reaction from the row under the message. */
  onToggleReaction: (message: Message, emoji: string, mine: boolean) => void;
  /** Go to a quoted message. Null where there is nowhere to go. */
  onJumpToRef?: (ref: MessageRef) => void;
  /** Send it again. Only ever offered on a failed message. */
  onRetry?: (message: Message) => void;
}

export const MessageRow = memo(function MessageRow({
  message,
  grouped,
  highlighted,
  pending,
  failed,
  progress,
  flashing,
  meId,
  nameFor,
  showEmbeds,
  autoplayEmbeds,
  onLongPress,
  onToggleReaction,
  onJumpToRef,
  onRetry,
}: MessageRowProps) {
  const author = message.author;
  const reactions = message.reactions ?? [];

  /**
   * How a tagged id becomes a name, handed down rather than looked up inside
   * the content component -- that one has no session and is drawn in four
   * different places, only some of which have a member list at all.
   */
  const lookupMention = (id: string) => {
    const name = nameFor(id);
    return name ? { name, self: id === meId } : null;
  };

  return (
    <Pressable
      onLongPress={() => onLongPress(message)}
      // Long enough not to fire while somebody is scrolling with a thumb
      // resting on a message, short enough to feel deliberate.
      delayLongPress={320}
      style={({ pressed }) => [
        styles.row,
        grouped && styles.rowGrouped,
        highlighted && styles.rowHighlighted,
        flashing && styles.rowFlashing,
        pending && styles.rowPending,
        pressed && styles.rowPressed,
      ]}
    >
      <View style={styles.gutter}>
        {!grouped && (
          <Avatar
            userId={author.id}
            name={personName(author)}
            image={author.image}
            size={38}
          />
        )}
      </View>

      <View style={styles.body}>
        {!grouped && (
          <View style={styles.header}>
            <Text style={styles.author} numberOfLines={1}>
              {personName(author)}
            </Text>
            <Text style={styles.time}>{timeOf(message.createdAt)}</Text>
            {message.pinnedAt && <Text style={styles.pinMark}>📌</Text>}
          </View>
        )}

        {/* A reply's quote: one line, whatever is in it. The same rule the
            desktop client's `quoteLine` applies, and the same reason -- a
            four-thousand-character message quoted in full is carried around by
            a control that shows fifty characters of it. */}
        {message.replyTo && (
          <RefLine
            refMessage={message.replyTo}
            nameFor={nameFor}
            onPress={onJumpToRef}
          />
        )}

        {message.forwardedFrom && (
          <View style={styles.forward}>
            <Text style={styles.forwardLabel}>
              ↪ Forwarded from {personName(message.forwardedFrom.author)}
            </Text>
            <MessageContent
              content={message.forwardedFrom.content}
              attachments={message.forwardedFrom.attachments}
              lookupMention={lookupMention}
              showEmbeds={showEmbeds}
              autoplayEmbeds={autoplayEmbeds}
            />
          </View>
        )}

        <MessageContent
          content={message.content}
          attachments={message.attachments}
          edited={Boolean(message.editedAt)}
          lookupMention={lookupMention}
          showEmbeds={showEmbeds}
          autoplayEmbeds={autoplayEmbeds}
        />

        {reactions.length > 0 && (
          <View style={styles.reactions}>
            {reactions.map((r) => {
              const mine = r.userIds.includes(meId);
              return (
                <Pressable
                  key={r.emoji}
                  onPress={() => onToggleReaction(message, r.emoji, mine)}
                  hitSlop={4}
                  style={[styles.reaction, mine && styles.reactionMine]}
                  accessibilityRole="button"
                  accessibilityLabel={`${r.userIds.length} reacted with ${r.emoji}`}
                >
                  <Text style={styles.reactionGlyph}>{r.emoji}</Text>
                  <Text
                    style={[styles.reactionCount, mine && styles.reactionCountMine]}
                  >
                    {r.userIds.length}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        )}

        {/* A bar rather than a percentage: the number is not information
            anybody acts on, and a bar that is two thirds across says the same
            thing without asking to be read. */}
        {typeof progress === 'number' && progress < 1 && (
          <View style={styles.progressTrack}>
            <View
              style={[styles.progressFill, { width: `${Math.round(progress * 100)}%` }]}
            />
          </View>
        )}

        {failed && (
          <Pressable
            onPress={() => onRetry?.(message)}
            hitSlop={8}
            accessibilityRole="button"
          >
            <Text style={styles.failed}>Not sent — tap to try again</Text>
          </Pressable>
        )}
      </View>
    </Pressable>
  );
});

/* ------------------------------------------------------------ the quote */

/**
 * The line above a reply, naming what it answers.
 *
 * Tappable when the caller can go there. A reply to a message far up the
 * channel is the most common reason anybody wants to jump, and making the quote
 * itself the control means there is nothing extra to draw.
 */
function RefLine({
  refMessage,
  nameFor,
  onPress,
}: {
  refMessage: MessageRef;
  nameFor: (userId: string) => string | null;
  onPress?: (ref: MessageRef) => void;
}) {
  const line = quoteLine(
    plainMentions(refMessage.content, nameFor),
    refMessage.attachments.length,
    refMessage.deleted,
  );

  return (
    <Pressable
      onPress={onPress ? () => onPress(refMessage) : undefined}
      disabled={!onPress || refMessage.deleted}
      style={styles.quote}
      accessibilityRole={onPress ? 'button' : undefined}
    >
      {!refMessage.deleted && (
        <Text style={styles.quoteAuthor} numberOfLines={1}>
          {personName(refMessage.author)}{' '}
        </Text>
      )}
      <Text style={styles.quoteText} numberOfLines={1}>
        {line}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.xs,
  },
  rowGrouped: { paddingTop: 1 },
  rowPressed: { backgroundColor: theme.surfaceAlt },
  rowHighlighted: {
    backgroundColor: theme.mention,
    borderLeftWidth: 2,
    borderLeftColor: theme.mentionBorder,
  },
  rowFlashing: {
    backgroundColor: theme.surfaceAlt,
    borderLeftWidth: 2,
    borderLeftColor: theme.accent,
  },
  rowPending: { opacity: 0.55 },
  gutter: { width: 38, marginRight: spacing.md },
  body: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'baseline', marginBottom: 2 },
  author: { color: theme.text, fontWeight: '600', fontSize: 15, flexShrink: 1 },
  time: { color: theme.textFaint, fontSize: 11, marginLeft: spacing.sm },
  pinMark: { fontSize: 10, marginLeft: spacing.xs },
  quote: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 3,
    paddingLeft: spacing.sm,
    borderLeftWidth: 2,
    borderLeftColor: theme.border,
  },
  quoteAuthor: {
    color: theme.textMuted,
    fontSize: 12,
    fontWeight: '600',
    flexShrink: 0,
  },
  quoteText: { color: theme.textFaint, fontSize: 12, flexShrink: 1 },
  forward: {
    marginTop: spacing.xs,
    marginBottom: spacing.xs,
    paddingLeft: spacing.sm,
    borderLeftWidth: 2,
    borderLeftColor: theme.border,
  },
  forwardLabel: {
    color: theme.textMuted,
    fontSize: 11,
    fontWeight: '600',
    marginBottom: 2,
  },
  reactions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    marginTop: spacing.xs,
  },
  reaction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    backgroundColor: theme.surfaceAlt,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
  },
  reactionMine: {
    backgroundColor: '#2b2f5e',
    borderColor: theme.accent,
  },
  reactionGlyph: { fontSize: 14 },
  reactionCount: { color: theme.textMuted, fontSize: 12, fontWeight: '600' },
  reactionCountMine: { color: theme.text },
  progressTrack: {
    height: 3,
    marginTop: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: theme.surfaceAlt,
    overflow: 'hidden',
  },
  progressFill: { height: 3, backgroundColor: theme.accent },
  failed: { color: theme.danger, fontSize: 12, marginTop: 2 },
});
