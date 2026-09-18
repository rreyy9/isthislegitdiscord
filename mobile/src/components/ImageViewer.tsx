import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  ActivityIndicator,
  Animated,
  Modal,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { Image } from 'expo-image';
import { saveAttachment } from '../download';
import { spacing, theme } from '../theme';

/**
 * The lightbox: a picture on its own, over everything else.
 *
 * A provider at the root rather than a component per picture, for the reason
 * the desktop client has one: any picture anywhere -- a message attachment, a
 * linked image, an avatar -- should open into the same thing, and a modal
 * rendered inside a message row is a modal inside an inverted `FlatList` cell,
 * which is upside down.
 *
 * Pinch and drag are hand-rolled on `PanResponder`, which is in React Native
 * itself. The obvious alternative is `react-native-gesture-handler`, and it is
 * excluded from this app's native build on purpose -- see the note in
 * package.json about ninja's 260-character path limit. A pinch is two touches
 * and some arithmetic; it is not worth bringing that back for.
 */

export interface ViewerImage {
  /** An absolute URL. Attachments go through `absoluteUrl` before they arrive. */
  uri: string;
  /** Bearer header for anything behind the token. Omitted for a linked image. */
  headers?: Record<string, string>;
  /** What it is called, shown along the top and used for the saved file. */
  name: string;
  /**
   * The path on the API, for the Save button. Absent for a picture somebody
   * merely linked to -- the share sheet is for files this server holds, and a
   * link to somebody else's server is better handed to the browser.
   */
  attachmentPath?: string;
}

interface ViewerValue {
  open: (image: ViewerImage) => void;
}

const ViewerContext = createContext<ViewerValue | null>(null);

/**
 * Opening a picture, from anywhere under the provider.
 *
 * Returns a no-op outside one rather than throwing. Every caller is a picture
 * that can perfectly well be drawn without being tappable, and a provider
 * forgotten around some future screen should cost the lightbox, not the screen.
 */
export function useImageViewer(): ViewerValue {
  return useContext(ViewerContext) ?? { open: () => {} };
}

export function ImageViewerProvider({ children }: { children: ReactNode }) {
  const [image, setImage] = useState<ViewerImage | null>(null);
  const open = useCallback((next: ViewerImage) => setImage(next), []);
  const value = useMemo(() => ({ open }), [open]);

  return (
    <ViewerContext.Provider value={value}>
      {children}
      {image && <Lightbox image={image} onClose={() => setImage(null)} />}
    </ViewerContext.Provider>
  );
}

/* --------------------------------------------------------------- the box */

/** How far in a pinch may go. Past this it is pixels, not detail. */
const MAX_SCALE = 4;

function Lightbox({
  image,
  onClose,
}: {
  image: ViewerImage;
  onClose: () => void;
}) {
  const { width, height } = useWindowDimensions();
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * The transform, as `Animated.Value`s written straight from the responder.
   *
   * Not React state: a pinch produces a touch event per frame, and routing
   * sixty renders a second through the reconciler to move one picture is how a
   * gesture comes out juddering on exactly the phones that can least afford it.
   */
  const scale = useRef(new Animated.Value(1)).current;
  const translateX = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(0)).current;

  /**
   * Where the gesture started, and where the picture was when it did.
   *
   * `Animated.Value` has no synchronous getter worth relying on, so the current
   * transform is mirrored here on every change. One object rather than three
   * refs because every field is read and written together, at the start and end
   * of a gesture.
   */
  const gesture = useRef({
    scale: 1,
    x: 0,
    y: 0,
    startDistance: 0,
    startScale: 1,
    startX: 0,
    startY: 0,
  }).current;

  const responder = useMemo(
    () =>
      PanResponder.create({
        // Claimed on move rather than on touch, so a single tap still reaches
        // the backdrop's press handler and closes the viewer.
        onMoveShouldSetPanResponder: (_e, g) =>
          g.numberActiveTouches === 2 ||
          // One finger only pans a picture that has been zoomed into. At 1x
          // there is nothing to pan to, and swallowing the drag would mean a
          // swipe on a full-screen picture doing nothing at all.
          (gesture.scale > 1 &&
            (Math.abs(g.dx) > 4 || Math.abs(g.dy) > 4)),

        onPanResponderGrant: (e) => {
          gesture.startScale = gesture.scale;
          gesture.startX = gesture.x;
          gesture.startY = gesture.y;
          gesture.startDistance = distanceOf(e.nativeEvent.touches);
        },

        onPanResponderMove: (e, g) => {
          const touches = e.nativeEvent.touches;

          if (touches.length >= 2) {
            const distance = distanceOf(touches);
            // A pinch that began before both fingers were down has no start
            // distance to divide by; taking this one as the start instead is
            // what stops the picture jumping to infinity on the first frame.
            if (gesture.startDistance <= 0) {
              gesture.startDistance = distance;
              gesture.startScale = gesture.scale;
              return;
            }
            const next = clamp(
              (gesture.startScale * distance) / gesture.startDistance,
              1,
              MAX_SCALE,
            );
            gesture.scale = next;
            scale.setValue(next);
          }

          // Panning happens during a pinch too: two fingers moving together is
          // a drag, and refusing it would make the picture feel pinned down.
          const limitX = ((gesture.scale - 1) * width) / 2;
          const limitY = ((gesture.scale - 1) * height) / 2;
          gesture.x = clamp(gesture.startX + g.dx, -limitX, limitX);
          gesture.y = clamp(gesture.startY + g.dy, -limitY, limitY);
          translateX.setValue(gesture.x);
          translateY.setValue(gesture.y);
        },

        onPanResponderRelease: () => {
          gesture.startDistance = 0;
          // Back to fitting the screen if the pinch ended near 1x. Without it a
          // picture left at 1.02 is slightly off-centre and slightly croppable,
          // which reads as the viewer having lost its place.
          if (gesture.scale <= 1.05) reset();
        },
        onPanResponderTerminate: () => {
          gesture.startDistance = 0;
        },
      }),
    [gesture, scale, translateX, translateY, width, height],
  );

  function reset() {
    gesture.scale = 1;
    gesture.x = 0;
    gesture.y = 0;
    Animated.parallel([
      Animated.spring(scale, { toValue: 1, useNativeDriver: true }),
      Animated.spring(translateX, { toValue: 0, useNativeDriver: true }),
      Animated.spring(translateY, { toValue: 0, useNativeDriver: true }),
    ]).start();
  }

  async function save() {
    if (!image.attachmentPath) return;
    setSaving(true);
    setError(null);
    const result = await saveAttachment(image.attachmentPath, image.name);
    setSaving(false);
    if (!result.ok) setError(result.error);
  }

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      // Android's back button closes it, which is the gesture people will
      // reach for first and the one a modal without this silently ignores.
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={styles.backdrop}>
        {/* The backdrop takes the tap, so a tap anywhere that is not a control
            closes the viewer -- including on the picture itself, which at 1x
            is most of the screen. */}
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onClose}
          accessibilityLabel="Close image"
        />

        <Animated.View
          style={[
            styles.stage,
            { transform: [{ translateX }, { translateY }, { scale }] },
          ]}
          {...responder.panHandlers}
        >
          {failed ? (
            <Text style={styles.failed}>That picture could not be loaded.</Text>
          ) : (
            <Image
              style={styles.image}
              source={{ uri: image.uri, headers: image.headers }}
              contentFit="contain"
              cachePolicy="memory-disk"
              onLoadEnd={() => setLoading(false)}
              onError={() => {
                setLoading(false);
                setFailed(true);
              }}
            />
          )}
        </Animated.View>

        {loading && !failed && (
          <ActivityIndicator
            style={styles.spinner}
            size="large"
            color={theme.text}
          />
        )}

        <View style={styles.bar} pointerEvents="box-none">
          <Text style={styles.name} numberOfLines={1}>
            {image.name}
          </Text>
          {image.attachmentPath && (
            <Pressable
              onPress={save}
              disabled={saving}
              hitSlop={10}
              style={styles.action}
            >
              <Text style={styles.actionLabel}>
                {saving ? 'Saving…' : 'Save'}
              </Text>
            </Pressable>
          )}
          <Pressable onPress={onClose} hitSlop={12} style={styles.action}>
            <Text style={styles.actionLabel}>Close</Text>
          </Pressable>
        </View>

        {error && <Text style={styles.error}>{error}</Text>}
      </View>
    </Modal>
  );
}

/* ---------------------------------------------------------------- maths */

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** How far apart the first two fingers are. Zero for fewer than two. */
function distanceOf(touches: readonly { pageX: number; pageY: number }[]): number {
  if (touches.length < 2) return 0;
  const [a, b] = touches;
  return Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    // Nearly opaque rather than fully: the sliver of the conversation showing
    // through is what says this is a layer over the channel rather than a
    // screen the back gesture has to be found a way out of.
    backgroundColor: 'rgba(0,0,0,0.94)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  stage: {
    // Written out rather than spread from `StyleSheet.absoluteFillObject`,
    // which React Native 0.86 no longer declares -- only `absoluteFill`, and
    // that one is a registered style rather than an object, so it cannot be
    // spread into a rule that adds to it. Four properties are clearer than a
    // constant that has to be looked up anyway.
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  image: { width: '100%', height: '100%' },
  spinner: { position: 'absolute' },
  failed: { color: theme.textMuted, fontSize: 14 },
  bar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingTop: spacing.xl + spacing.md,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  name: { color: theme.text, fontSize: 13, flex: 1 },
  action: { paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
  actionLabel: { color: theme.text, fontSize: 14, fontWeight: '600' },
  error: {
    position: 'absolute',
    bottom: spacing.xl,
    color: theme.danger,
    fontSize: 13,
    paddingHorizontal: spacing.lg,
    textAlign: 'center',
  },
});
