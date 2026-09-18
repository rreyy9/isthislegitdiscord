import { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { absoluteUrl, authHeaders } from '../api';
import { radius, theme } from '../theme';

/**
 * Somebody's picture, or their initial.
 *
 * `expo-image` with an explicit `headers` on the source is the whole reason
 * this is three lines rather than the object-URL cache the desktop client
 * carries: avatars are behind the bearer token, an `<img src>` cannot send a
 * header, and on the web that forces every picture to be fetched by hand and
 * handed over as a blob. Here the header goes on the request and the platform
 * does its own disk caching, which also means the picture is still there after
 * the app is killed and reopened.
 *
 * The fallback is an initial on a colour derived from the user id, so two
 * people without pictures are still told apart at a glance -- and so the
 * circle is never an empty grey hole, which reads as a failed load rather than
 * as somebody who has not set a picture.
 */

/**
 * A colour per person, stable across launches and across devices.
 *
 * Hashing the id rather than the name: a display name changes, and an avatar
 * that changes colour when somebody renames themselves looks like a different
 * person arriving.
 */
const PALETTE = [
  '#5865f2',
  '#3ba55d',
  '#faa61a',
  '#ed4245',
  '#eb459e',
  '#9b59b6',
  '#1abc9c',
  '#e67e22',
] as const;

function colourFor(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i += 1) {
    hash = (hash * 31 + userId.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

export interface AvatarProps {
  userId: string;
  name: string;
  /** The `image` field from the API: a path, not a URL. Null for none. */
  image: string | null;
  size?: number;
  /** Draws the green dot. Omitted where presence is not being shown. */
  online?: boolean;
}

export const Avatar = memo(function Avatar({
  userId,
  name,
  image,
  size = 40,
  online,
}: AvatarProps) {
  const box = {
    width: size,
    height: size,
    borderRadius: radius.pill,
  };

  return (
    <View>
      {image ? (
        <Image
          style={[box, styles.image]}
          source={{ uri: absoluteUrl(image), headers: authHeaders() }}
          // The picture is immutable: changing it writes a new file under a
          // new name, so the old URL is simply never asked for again. That
          // makes an indefinite disk cache correct rather than merely fast.
          cachePolicy="memory-disk"
          contentFit="cover"
          transition={120}
        />
      ) : (
        <View style={[box, styles.fallback, { backgroundColor: colourFor(userId) }]}>
          <Text style={[styles.initial, { fontSize: size * 0.42 }]}>
            {/* `Array.from`, not `[0]`: an emoji or an accented letter is
                several code units, and slicing one in half renders a box. */}
            {(Array.from(name.trim())[0] ?? '?').toUpperCase()}
          </Text>
        </View>
      )}

      {online !== undefined && (
        <View
          style={[
            styles.dot,
            {
              width: size * 0.3,
              height: size * 0.3,
              borderRadius: radius.pill,
              backgroundColor: online ? theme.online : theme.textFaint,
            },
          ]}
        />
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  image: {
    backgroundColor: theme.surfaceAlt,
  },
  fallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  initial: {
    color: '#ffffff',
    fontWeight: '700',
  },
  dot: {
    position: 'absolute',
    right: -1,
    bottom: -1,
    // The ring is what keeps a green dot legible over a green avatar.
    borderWidth: 2,
    borderColor: theme.bg,
  },
});
