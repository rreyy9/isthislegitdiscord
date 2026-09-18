import { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Avatar } from './Avatar';
import { describeBytes, personName, splitMentions, timeOf } from '../format';
import { radius, spacing, theme } from '../theme';
import type { Message } from '../types';

/**
 * One message.
 *
 * `memo`, and it earns it: the list re-renders whenever anybody types, and a
 * channel holds a few hundred of these. The props are all primitives or the
 * message object itself, which is replaced rather than mutated whenever the
 * server sends a new version -- so the shallow compare is exactly right.
 *
 * Grouping is decided by the caller and arrives as `grouped`, because it is a
 * fact about the message *above* this one and a row cannot see its neighbour.
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
  meId: string;
  nameFor: (userId: string) => string | null;
}

export const MessageRow = memo(function MessageRow({
  message,
  grouped,
  highlighted,
  pending,
  failed,
  meId,
  nameFor,
}: MessageRowProps) {
  const author = message.author;
  const parts = splitMentions(message.content, nameFor, meId);

  return (
    <View
      style={[
        styles.row,
        grouped && styles.rowGrouped,
        highlighted && styles.rowHighlighted,
        pending && styles.rowPending,
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
          </View>
        )}

        {/* A reply's quote. One line, because the strip above a reply is one
            line high whatever is in it -- the same rule the desktop client's
            `quoteLine` applies, and the same reason: a four-thousand-character
            message quoted in full is carried around by a control that shows
            forty characters of it. */}
        {message.replyTo && (
          <View style={styles.quote}>
            <Text style={styles.quoteAuthor} numberOfLines={1}>
              {message.replyTo.deleted
                ? ''
                : `${personName(message.replyTo.author)} `}
            </Text>
            <Text style={styles.quoteText} numberOfLines={1}>
              {message.replyTo.deleted
                ? 'Message deleted'
                : message.replyTo.content.replace(/\s+/g, ' ').trim() ||
                  '📎 Attachment'}
            </Text>
          </View>
        )}

        {parts.length > 0 && (
          <Text style={styles.content} selectable>
            {parts.map((part, i) =>
              part.kind === 'mention' ? (
                <Text
                  key={i}
                  style={[styles.mention, part.isMe && styles.mentionMe]}
                >
                  {part.text}
                </Text>
              ) : (
                <Text key={i}>{part.text}</Text>
              ),
            )}
            {message.editedAt && <Text style={styles.edited}> (edited)</Text>}
          </Text>
        )}

        {/* Attachments are listed, not drawn. Sending and viewing files is
            phase 2; a message that was only a screenshot still has to say so
            rather than render as a blank gap, which is the placeholder rule
            the README sets out -- unrecognised content renders as a
            placeholder, never as nothing. */}
        {message.attachments.map((a) => (
          <View key={a.id} style={styles.attachment}>
            <Text style={styles.attachmentName} numberOfLines={1}>
              📎 {a.fileName}
            </Text>
            <Text style={styles.attachmentMeta}>
              {a.expiredAt ? 'expired' : describeBytes(a.size)}
            </Text>
          </View>
        ))}

        {failed && <Text style={styles.failed}>Not sent — tap to retry</Text>}
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.xs,
  },
  rowGrouped: {
    paddingTop: 1,
  },
  rowHighlighted: {
    backgroundColor: theme.mention,
    borderLeftWidth: 2,
    borderLeftColor: theme.mentionBorder,
  },
  rowPending: {
    opacity: 0.55,
  },
  gutter: {
    width: 38,
    marginRight: spacing.md,
  },
  body: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'baseline',
    marginBottom: 2,
  },
  author: {
    color: theme.text,
    fontWeight: '600',
    fontSize: 15,
    flexShrink: 1,
  },
  time: {
    color: theme.textFaint,
    fontSize: 11,
    marginLeft: spacing.sm,
  },
  content: {
    color: theme.text,
    fontSize: 15,
    lineHeight: 21,
  },
  edited: {
    color: theme.textFaint,
    fontSize: 11,
  },
  mention: {
    color: theme.accent,
    fontWeight: '600',
  },
  mentionMe: {
    color: theme.mentionBorder,
  },
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
  quoteText: {
    color: theme.textFaint,
    fontSize: 12,
    flexShrink: 1,
  },
  attachment: {
    marginTop: spacing.xs,
    padding: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: theme.surfaceAlt,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
  },
  attachmentName: {
    color: theme.text,
    fontSize: 13,
  },
  attachmentMeta: {
    color: theme.textFaint,
    fontSize: 11,
    marginTop: 1,
  },
  failed: {
    color: theme.danger,
    fontSize: 12,
    marginTop: 2,
  },
});
