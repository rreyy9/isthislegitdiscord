import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { downloadUpdate } from '../updates';
import { spacing, theme } from '../theme';
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
});
