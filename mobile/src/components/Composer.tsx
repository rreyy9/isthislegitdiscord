import { useRef, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { MAX_MESSAGE_CHARS } from '../format';
import { radius, spacing, TAP_TARGET, theme } from '../theme';

/**
 * The box at the bottom.
 *
 * A plain `TextInput`, and it stays one -- the same constraint the desktop
 * client set for its textarea. A rich editor would let a tag hold an invisible
 * id, and it would also mean re-implementing selection, undo and paste on a
 * platform where all three are the system's job and are better than anything
 * written here would be.
 *
 * Which is why this build sends plain text and does not compose tags. Reading
 * them works -- `splitMentions` draws an incoming `<@id>` as a name -- but
 * turning a typed `@Someone` back into an id needs the longest-match rules in
 * the desktop client's `mention-utils.ts`, and a half-working version of that
 * silently sends the wrong person's name as ordinary text. Better to not offer
 * it than to offer it wrong.
 */

export interface ComposerProps {
  /** Placeholder, so the box says which channel it will post to. */
  channelName: string;
  disabled?: boolean;
  onSend: (content: string) => void;
  onTypingStart: () => void;
  onTypingStop: () => void;
}

/** How long after the last keystroke before "typing" is taken back. */
const TYPING_IDLE_MS = 3000;

export function Composer({
  channelName,
  disabled,
  onSend,
  onTypingStart,
  onTypingStop,
}: ComposerProps) {
  const [text, setText] = useState('');
  const typing = useRef(false);
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null);

  const tooLong = text.length > MAX_MESSAGE_CHARS;
  const canSend = text.trim().length > 0 && !tooLong && !disabled;

  /**
   * One `typing:start` per burst, not one per keystroke.
   *
   * The desktop client sends on a timer for the same reason, and it matters
   * more here: every emit is a radio wake-up, and a phone that transmits on
   * every character typed is a phone whose battery is noticeably worse for a
   * feature nobody asked for.
   */
  function noteTyping(next: string) {
    setText(next);
    if (disabled) return;

    if (!typing.current && next.length > 0) {
      typing.current = true;
      onTypingStart();
    }

    if (idle.current) clearTimeout(idle.current);
    idle.current = setTimeout(stopTyping, TYPING_IDLE_MS);
  }

  function stopTyping() {
    if (idle.current) {
      clearTimeout(idle.current);
      idle.current = null;
    }
    if (typing.current) {
      typing.current = false;
      onTypingStop();
    }
  }

  function send() {
    const content = text.trim();
    if (!content || tooLong || disabled) return;

    // Cleared before the send rather than after it. The message is delivered
    // optimistically by the caller, so the box emptying is what says "gone";
    // waiting for the server would leave the text sitting there over a slow
    // connection and invite a second tap.
    setText('');
    stopTyping();
    onSend(content);
  }

  return (
    <View style={styles.wrap}>
      {tooLong && (
        <Text style={styles.overflow}>
          {text.length - MAX_MESSAGE_CHARS} characters over the limit
        </Text>
      )}

      <View style={styles.bar}>
        <TextInput
          style={styles.input}
          value={text}
          onChangeText={noteTyping}
          onBlur={stopTyping}
          placeholder={disabled ? 'Reconnecting…' : `Message #${channelName}`}
          placeholderTextColor={theme.textFaint}
          editable={!disabled}
          multiline
          // Four lines, then it scrolls. Enough for a paragraph without the
          // keyboard and the box between them swallowing the conversation.
          maxLength={MAX_MESSAGE_CHARS + 500}
          textAlignVertical="center"
        />

        <Pressable
          onPress={send}
          disabled={!canSend}
          hitSlop={8}
          style={({ pressed }) => [
            styles.send,
            !canSend && styles.sendDisabled,
            pressed && canSend && styles.sendPressed,
          ]}
          accessibilityRole="button"
          accessibilityLabel="Send message"
        >
          <Text style={styles.sendLabel}>↑</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.border,
    backgroundColor: theme.bg,
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: spacing.sm,
    gap: spacing.sm,
  },
  input: {
    flex: 1,
    minHeight: TAP_TARGET,
    maxHeight: 120,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.lg,
    backgroundColor: theme.surfaceAlt,
    color: theme.text,
    fontSize: 15,
  },
  send: {
    width: TAP_TARGET,
    height: TAP_TARGET,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.accent,
  },
  sendDisabled: {
    backgroundColor: theme.surfaceAlt,
  },
  sendPressed: {
    opacity: 0.75,
  },
  sendLabel: {
    color: theme.accentText,
    fontSize: 20,
    fontWeight: '700',
    lineHeight: 22,
  },
  overflow: {
    color: theme.danger,
    fontSize: 12,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.xs,
  },
});
