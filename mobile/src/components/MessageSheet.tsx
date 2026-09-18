import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { EMOJI_GROUPS, QUICK_REACTIONS } from '../emoji';
import { plainMentions, quoteLine } from '../format';
import { radius, spacing, theme } from '../theme';
import type { Message } from '../types';
import { Sheet, SheetDivider, SheetRow } from './Sheet';

/**
 * Everything you can do to one message.
 *
 * The desktop client puts these on a toolbar that appears when the pointer is
 * over a message. There is no pointer here, so they are behind a long press --
 * which is both the platform's convention for exactly this and the reason the
 * row itself needs no extra chrome at all.
 *
 * Reactions come first, as a row of six across the top, because adding a
 * reaction is the most common thing anybody does to somebody else's message and
 * because a row of faces is the fastest thing on the sheet to aim at. Everything
 * else is a labelled row underneath.
 */

export interface MessageActions {
  onReply: (message: Message) => void;
  onEdit: (message: Message) => void;
  onDelete: (message: Message) => void;
  onForward: (message: Message) => void;
  onPin: (message: Message, pinned: boolean) => void;
  onReact: (message: Message, emoji: string, mine: boolean) => void;
}

export interface MessageSheetProps extends MessageActions {
  /** The message the sheet is about, or null when it is closed. */
  message: Message | null;
  meId: string;
  /** Whether this account may pin and may delete other people's messages. */
  iAmAdmin: boolean;
  nameFor: (userId: string) => string | null;
  onClose: () => void;
}

export function MessageSheet({
  message,
  meId,
  iAmAdmin,
  nameFor,
  onClose,
  onReply,
  onEdit,
  onDelete,
  onForward,
  onPin,
  onReact,
}: MessageSheetProps) {
  const [picking, setPicking] = useState(false);
  const [copied, setCopied] = useState(false);

  function close() {
    setPicking(false);
    setCopied(false);
    onClose();
  }

  /** Every action closes the sheet: none of them is something you do twice. */
  function run(action: () => void) {
    action();
    close();
  }

  // Nothing long-pressed: no sheet at all. `Sheet` unmounts its contents with
  // the modal anyway, so a hidden one would preserve nothing worth keeping --
  // and the two pieces of state above are reset on the way out regardless.
  if (!message) return null;
  const target = message;

  const mine = target.author.id === meId;
  const pinned = Boolean(target.pinnedAt);
  const reactions = target.reactions ?? [];
  const isMineReaction = (emoji: string) =>
    reactions.some((r) => r.emoji === emoji && r.userIds.includes(meId));

  return (
    <Sheet visible onClose={close} tall={picking}>
      {/* What the sheet is about, in one line. On a phone the message that was
          long-pressed is usually behind the sheet and out of sight, and a menu
          of destructive verbs with no subject is how the wrong message gets
          deleted. */}
      <Text style={styles.subject} numberOfLines={2}>
        {quoteLine(
          plainMentions(target.content, nameFor),
          target.attachments.length,
          false,
          120,
        )}
      </Text>

      {picking ? (
        <EmojiGrid
          onPick={(emoji) => run(() => onReact(target, emoji, isMineReaction(emoji)))}
          onBack={() => setPicking(false)}
        />
      ) : (
        <>
          <View style={styles.quickRow}>
            {QUICK_REACTIONS.map((emoji) => (
              <Pressable
                key={emoji}
                onPress={() => run(() => onReact(target, emoji, isMineReaction(emoji)))}
                style={({ pressed }) => [
                  styles.quick,
                  isMineReaction(emoji) && styles.quickMine,
                  pressed && styles.quickPressed,
                ]}
                accessibilityRole="button"
                accessibilityLabel={`React with ${emoji}`}
              >
                <Text style={styles.quickGlyph}>{emoji}</Text>
              </Pressable>
            ))}
            <Pressable
              onPress={() => setPicking(true)}
              style={({ pressed }) => [styles.quick, pressed && styles.quickPressed]}
              accessibilityRole="button"
              accessibilityLabel="More reactions"
            >
              <Text style={styles.quickMore}>＋</Text>
            </Pressable>
          </View>

          <SheetDivider />

          <SheetRow
            icon="↩"
            label="Reply"
            onPress={() => run(() => onReply(target))}
          />
          <SheetRow
            icon="↪"
            label="Forward"
            onPress={() => run(() => onForward(target))}
          />
          <SheetRow
            icon="⧉"
            label={copied ? 'Copied' : 'Copy text'}
            // Not closed on press, unlike everything else: the label turning to
            // "Copied" is the only confirmation there is, and a sheet that
            // vanished at the same instant would take it with it.
            disabled={!target.content}
            onPress={() => {
              void Clipboard.setStringAsync(
                plainMentions(target.content, nameFor),
              );
              setCopied(true);
            }}
          />

          {mine && (
            <SheetRow
              icon="✎"
              label="Edit"
              onPress={() => run(() => onEdit(target))}
            />
          )}

          {iAmAdmin && (
            <SheetRow
              icon="📌"
              label={pinned ? 'Unpin' : 'Pin to channel'}
              onPress={() => run(() => onPin(target, pinned))}
            />
          )}

          {(mine || iAmAdmin) && (
            <>
              <SheetDivider />
              <SheetRow
                icon="🗑"
                label="Delete"
                danger
                hint={
                  mine ? undefined : 'Deleting someone else’s message, as an admin.'
                }
                onPress={() => run(() => onDelete(target))}
              />
            </>
          )}
        </>
      )}
    </Sheet>
  );
}

/* --------------------------------------------------------- the picker */

/**
 * The reaction picker.
 *
 * Short and curated rather than every emoji in Unicode -- see the note atop
 * `emoji.ts`. What is here is what people react with; anything else is a
 * message, and the system keyboard is better at those than this would be.
 */
function EmojiGrid({
  onPick,
  onBack,
}: {
  onPick: (emoji: string) => void;
  onBack: () => void;
}) {
  return (
    <>
      <Pressable onPress={onBack} hitSlop={8} style={styles.back}>
        <Text style={styles.backLabel}>‹ Back</Text>
      </Pressable>
      <ScrollView
        style={styles.grid}
        contentContainerStyle={styles.gridContent}
        keyboardShouldPersistTaps="handled"
      >
        {EMOJI_GROUPS.map((group) => (
          <View key={group.label}>
            <Text style={styles.groupLabel}>{group.label}</Text>
            <View style={styles.groupGrid}>
              {group.emoji.map((emoji) => (
                <Pressable
                  key={emoji}
                  onPress={() => onPick(emoji)}
                  style={({ pressed }) => [
                    styles.cell,
                    pressed && styles.quickPressed,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel={`React with ${emoji}`}
                >
                  <Text style={styles.cellGlyph}>{emoji}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        ))}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  subject: {
    color: theme.textMuted,
    fontSize: 12,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
  },
  quickRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
  },
  quick: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.surfaceAlt,
  },
  quickMine: { backgroundColor: '#2b2f5e', borderWidth: 1, borderColor: theme.accent },
  quickPressed: { opacity: 0.6 },
  quickGlyph: { fontSize: 22 },
  quickMore: { color: theme.textMuted, fontSize: 20, fontWeight: '700' },
  back: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
  backLabel: { color: theme.accent, fontSize: 14, fontWeight: '600' },
  grid: { flex: 1 },
  gridContent: { paddingHorizontal: spacing.md, paddingBottom: spacing.lg },
  groupLabel: {
    color: theme.textMuted,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.md,
    paddingBottom: spacing.xs,
  },
  groupGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cellGlyph: { fontSize: 24 },
});
