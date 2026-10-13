import { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { spacing, theme } from '../theme';

/**
 * "Somebody is typing", above the composer.
 *
 * Always the same height, whether anybody is typing or not. It used to be a
 * line that appeared and vanished, and every time it did the whole
 * conversation jumped up or down by a line under the reader's thumb -- several
 * times a minute in a busy channel. A strip that is always there and only
 * sometimes has words in it costs fifteen points and moves nothing.
 *
 * The dots are three `Animated` opacities on a loop with the native driver, so
 * they keep going while the JavaScript thread is busy drawing messages.
 */
export function TypingIndicator({ label }: { label: string | null }) {
  return (
    <View
      style={styles.strip}
      accessibilityLiveRegion="polite"
      accessibilityLabel={label ?? undefined}
    >
      {label && (
        <>
          <Dots />
          <Text style={styles.label} numberOfLines={1}>
            {label}
          </Text>
        </>
      )}
    </View>
  );
}

const DOT_MS = 300;

function Dots() {
  const values = useRef([0, 1, 2].map(() => new Animated.Value(0.3))).current;

  useEffect(() => {
    const pulse = (v: Animated.Value) =>
      Animated.sequence([
        Animated.timing(v, { toValue: 1, duration: DOT_MS, useNativeDriver: true }),
        Animated.timing(v, { toValue: 0.3, duration: DOT_MS, useNativeDriver: true }),
      ]);
    const loop = Animated.loop(
      Animated.stagger(DOT_MS / 2, values.map(pulse)),
    );
    loop.start();
    return () => loop.stop();
  }, [values]);

  return (
    <View style={styles.dots}>
      {values.map((v, i) => (
        <Animated.View key={i} style={[styles.dot, { opacity: v }]} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  strip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    height: 20,
    paddingHorizontal: spacing.md,
  },
  dots: { flexDirection: 'row', gap: 3 },
  dot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: theme.textMuted,
  },
  label: { color: theme.textMuted, fontSize: 12, flex: 1 },
});
