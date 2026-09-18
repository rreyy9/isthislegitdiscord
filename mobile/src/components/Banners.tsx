import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { downloadUpdate } from '../updates';
import { useSession } from '../session';
import { radius, spacing, theme } from '../theme';
import type { Status } from '../session';

/**
 * The two strips that appear above everything: the connection, and a newer
 * build.
 *
 * Both are deliberately strips rather than dialogs. Neither is something the
 * person has to act on before they can carry on reading, and a modal over a
 * conversation because the train went into a tunnel is the wrong shape of
 * interruption entirely.
 */

export function ConnectionBanner({
  status,
  restarting,
}: {
  status: Status;
  restarting: boolean;
}) {
  // Connected is the overwhelmingly common case and says nothing worth a row
  // of screen. On a phone that row is a meaningful fraction of the messages
  // visible at once.
  if (status === 'connected') return null;

  // "Updating" rather than "offline" when the server said it was going down
  // to be updated. The gap is the same few seconds either way; the difference
  // is whether ten people ask at once whether the server is broken.
  const text = restarting
    ? 'Server is updating — back in a moment'
    : status === 'connecting'
      ? 'Reconnecting…'
      : 'Offline';

  return (
    <View style={[styles.bar, restarting ? styles.info : styles.warn]}>
      {status === 'connecting' && (
        <ActivityIndicator size="small" color={theme.text} />
      )}
      <Text style={styles.text}>{text}</Text>
    </View>
  );
}

export function UpdateBanner({
  version,
  onDismiss,
}: {
  version: string;
  onDismiss: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download() {
    setBusy(true);
    setError(null);
    const result = await downloadUpdate();
    setBusy(false);

    if (result.ok) {
      // The browser has it now. Leaving the strip up would be claiming the
      // update had failed for as long as the download takes.
      onDismiss();
    } else {
      setError(result.error);
    }
  }

  return (
    <View style={[styles.bar, styles.update]}>
      <View style={styles.updateText}>
        <Text style={styles.text}>Version {version} is available</Text>
        {error ? (
          <Text style={styles.error}>{error}</Text>
        ) : (
          <Text style={styles.hint}>
            Downloads in your browser — tap it when it finishes to install.
          </Text>
        )}
      </View>

      <Pressable onPress={download} disabled={busy} hitSlop={8} style={styles.action}>
        {busy ? (
          <ActivityIndicator size="small" color={theme.accentText} />
        ) : (
          <Text style={styles.actionLabel}>Get it</Text>
        )}
      </Pressable>

      <Pressable onPress={onDismiss} hitSlop={12} style={styles.dismiss}>
        <Text style={styles.dismissLabel}>✕</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  warn: {
    backgroundColor: '#4a2b10',
  },
  info: {
    backgroundColor: '#1f3a5f',
  },
  update: {
    backgroundColor: theme.accent,
  },
  text: {
    color: theme.text,
    fontSize: 13,
    fontWeight: '600',
  },
  hint: {
    color: 'rgba(255,255,255,0.8)',
    fontSize: 11,
    marginTop: 1,
  },
  error: {
    color: '#ffd7d7',
    fontSize: 11,
    marginTop: 1,
  },
  updateText: {
    flex: 1,
  },
  action: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.25)',
    minWidth: 62,
    alignItems: 'center',
  },
  actionLabel: {
    color: theme.accentText,
    fontWeight: '700',
    fontSize: 13,
  },
  dismiss: {
    paddingHorizontal: spacing.xs,
  },
  dismissLabel: {
    color: 'rgba(255,255,255,0.75)',
    fontSize: 15,
  },

  notice: {
    // Absolute, over whatever screen is showing. A tag can arrive while any of
    // them is open, and a strip that pushed the conversation down would move
    // the message somebody is in the middle of reading.
    position: 'absolute',
    left: spacing.sm,
    right: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: theme.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.mentionBorder,
    // Android draws nothing for a shadow without this, and a card floating over
    // a conversation with no separation from it reads as part of the page.
    elevation: 8,
  },
  noticeBody: { flex: 1 },
  noticeHead: {
    color: theme.mentionBorder,
    fontSize: 12,
    fontWeight: '700',
  },
  noticeText: {
    color: theme.text,
    fontSize: 13,
    marginTop: 2,
  },
});

/* ---------------------------------------------------------- the notice */

/** How long a tag notice stays before it takes itself away. */
const NOTICE_MS = 6000;

/**
 * The strip that says somebody tagged you, in a channel you are not reading.
 *
 * This is the phone's answer to the desktop client's ping: a sound and a
 * flashing taskbar entry have no equivalent here, and a real push notification
 * needs server infrastructure that does not exist yet -- a device-token table, a
 * registration route, and a hook in `notifyMentions`. So this only ever happens
 * while the app is open, which is exactly when the desktop ping happens too.
 *
 * Tapping it goes to the message, not just the channel. Being told somebody said
 * your name and then having to find where is the half-feature worth avoiding.
 *
 * It dismisses itself, and that is the difference between this and every other
 * strip in this file. The connection banner describes a state and goes when the
 * state does; this describes an event that has already happened, and a strip
 * about a message from four minutes ago sitting over the conversation is
 * clutter that has to be cleared by hand.
 */
export function MentionNotice() {
  const { notice, dismissNotice } = useSession();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const slide = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!notice) return;

    slide.setValue(0);
    Animated.timing(slide, {
      toValue: 1,
      duration: 180,
      useNativeDriver: true,
    }).start();

    const timer = setTimeout(dismissNotice, NOTICE_MS);
    // Cleared on the way out, so a second tag arriving four seconds into the
    // first one's life does not inherit its two remaining seconds.
    return () => clearTimeout(timer);
  }, [notice, dismissNotice, slide]);

  if (!notice) return null;

  return (
    <Animated.View
      style={[
        styles.notice,
        {
          top: insets.top + spacing.sm,
          opacity: slide,
          transform: [
            {
              translateY: slide.interpolate({
                inputRange: [0, 1],
                outputRange: [-16, 0],
              }),
            },
          ],
        },
      ]}
    >
      <Pressable
        style={styles.noticeBody}
        onPress={() => {
          dismissNotice();
          router.push(
            `/channel/${notice.channelId}?jump=${encodeURIComponent(
              notice.messageId,
            )}` as never,
          );
        }}
        accessibilityRole="button"
        accessibilityLabel={`${notice.authorName} tagged you in ${notice.channelName}`}
      >
        <Text style={styles.noticeHead} numberOfLines={1}>
          {notice.authorName} {notice.kind === 'reply' ? 'replied' : 'tagged you'} in #
          {notice.channelName}
        </Text>
        <Text style={styles.noticeText} numberOfLines={2}>
          {notice.preview}
        </Text>
      </Pressable>
      <Pressable onPress={dismissNotice} hitSlop={12} style={styles.dismiss}>
        <Text style={styles.dismissLabel}>✕</Text>
      </Pressable>
    </Animated.View>
  );
}
