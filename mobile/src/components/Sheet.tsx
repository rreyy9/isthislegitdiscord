import { useEffect, useRef, type ReactNode } from 'react';
import {
  Animated,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { radius, spacing, TAP_TARGET, theme } from '../theme';

/**
 * A panel that comes up from the bottom.
 *
 * The shape every menu in this app takes, and the reason there is no
 * right-click menu anywhere: a phone has one gesture for "tell me about this
 * thing" -- a long press -- and one place the answer can go without a thumb
 * having to travel, which is the bottom of the screen. The desktop client's
 * menus open at the pointer because the pointer is already there; here that
 * would put a menu under the reader's hand, at the top of a six-inch screen,
 * reachable by nobody.
 *
 * Built on React Native's own `Modal` and `Animated`. The obvious alternative
 * is a bottom-sheet library, and every one of them depends on
 * `react-native-gesture-handler` and `react-native-reanimated` -- both of which
 * this app keeps out of its native build on purpose. See package.json.
 *
 * There is no drag-to-dismiss for that reason. Tapping away closes it, the back
 * button closes it, and the sheet has a cancel row; a drag handle that did
 * nothing would be worse than not drawing one.
 */

export interface SheetProps {
  visible: boolean;
  onClose: () => void;
  /** Drawn along the top, above the divider. Omitted for a bare menu. */
  title?: string;
  children: ReactNode;
  /**
   * Fill the screen rather than sitting at the bottom.
   *
   * What the member list and the search results want: both are long, both are
   * scrolled, and a half-height panel holding a scroll view is a list somebody
   * reads four rows of at a time.
   */
  tall?: boolean;
}

export function Sheet({ visible, onClose, title, children, tall }: SheetProps) {
  const insets = useSafeAreaInsets();
  const slide = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    // Only on the way in. The way out is instant, because `Modal` unmounts its
    // contents when `visible` goes false and there is nothing left to animate --
    // faking it would mean holding the sheet open past the tap that dismissed
    // it, which reads as lag rather than as polish.
    if (!visible) {
      slide.setValue(0);
      return;
    }
    Animated.timing(slide, {
      toValue: 1,
      duration: 180,
      useNativeDriver: true,
    }).start();
  }, [visible, slide]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      // Android's back button. A modal without this swallows it silently, which
      // is the single most common way a sheet traps somebody.
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={styles.wrap}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onClose}
          accessibilityLabel="Close"
        />
        <Animated.View
          style={[
            styles.sheet,
            tall && styles.sheetTall,
            { paddingBottom: insets.bottom + spacing.sm },
            {
              transform: [
                {
                  translateY: slide.interpolate({
                    inputRange: [0, 1],
                    outputRange: [24, 0],
                  }),
                },
              ],
              opacity: slide,
            },
          ]}
        >
          <View style={styles.grip} />
          {title && <Text style={styles.title}>{title}</Text>}
          {children}
        </Animated.View>
      </View>
    </Modal>
  );
}

/* --------------------------------------------------------------- rows */

export interface SheetRowProps {
  label: string;
  /** One character drawn in the gutter. Keeps every row the same height. */
  icon?: string;
  onPress: () => void;
  /** Red, for the ones that remove something. */
  danger?: boolean;
  disabled?: boolean;
  /** Second line under the label, for anything that needs a caveat. */
  hint?: string;
}

export function SheetRow({
  label,
  icon,
  onPress,
  danger,
  disabled,
  hint,
}: SheetRowProps) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.row,
        pressed && !disabled && styles.rowPressed,
        disabled && styles.rowDisabled,
      ]}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      {icon && <Text style={styles.rowIcon}>{icon}</Text>}
      <View style={styles.rowText}>
        <Text style={[styles.rowLabel, danger && styles.rowDanger]}>{label}</Text>
        {hint && <Text style={styles.rowHint}>{hint}</Text>}
      </View>
    </Pressable>
  );
}

export function SheetDivider() {
  return <View style={styles.divider} />;
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  sheet: {
    backgroundColor: theme.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingTop: spacing.sm,
    // Never more than most of the screen: the strip of conversation still
    // showing is what says the sheet is over the channel rather than a screen
    // somebody has navigated to.
    maxHeight: '85%',
  },
  sheetTall: { height: '85%' },
  grip: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: radius.pill,
    backgroundColor: theme.border,
    marginBottom: spacing.sm,
  },
  title: {
    color: theme.textMuted,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: TAP_TARGET + 4,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  rowPressed: { backgroundColor: theme.surfaceAlt },
  rowDisabled: { opacity: 0.4 },
  rowIcon: { fontSize: 16, width: 22, textAlign: 'center' },
  rowText: { flex: 1 },
  rowLabel: { color: theme.text, fontSize: 15 },
  rowDanger: { color: theme.danger },
  rowHint: { color: theme.textFaint, fontSize: 11, marginTop: 1 },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: theme.border,
    marginVertical: spacing.xs,
  },
});
