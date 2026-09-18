import { memo, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Image } from 'expo-image';
import { WebView } from 'react-native-webview';
import { fileNameOf, type Embed } from '../link-utils';
import { Player } from './Attachments';
import { useImageViewer } from './ImageViewer';
import { radius, spacing, theme } from '../theme';

/**
 * What a link turns into when it is worth more than its own text.
 *
 * The same four the desktop client draws -- YouTube, TikTok, a linked picture,
 * a linked video -- and on the same click-to-play deal. That deal matters more
 * here than it does there: a player is a `WebView`, which on Android is a whole
 * browser process, and a channel full of links that each spawned one is a
 * channel that cannot be scrolled.
 *
 * So nothing loads until somebody asks for it. What is drawn instead is a still
 * where one can be built from the link alone, and a card where it cannot.
 */

/** Which player is allowed to hold the screen at once. */
const PLAYER_MAX_HEIGHT = 420;

export interface EmbedViewProps {
  embed: Embed;
  /**
   * Load the frame immediately rather than after a tap. The `autoplayEmbeds`
   * preference; off by default, and the reason the stills exist.
   */
  autoplay: boolean;
}

export const EmbedView = memo(function EmbedView({
  embed,
  autoplay,
}: EmbedViewProps) {
  switch (embed.kind) {
    case 'youtube':
      return <YouTube id={embed.id} start={embed.start} autoplay={autoplay} />;
    case 'tiktok':
      return <TikTok id={embed.id} url={embed.url} autoplay={autoplay} />;
    case 'image':
      return <LinkedImage url={embed.url} />;
    case 'video':
      return <LinkedVideo url={embed.url} />;
  }
});

/* ------------------------------------------------------------- youtube */

function YouTube({
  id,
  start,
  autoplay,
}: {
  id: string;
  start: number | null;
  autoplay: boolean;
}) {
  const [playing, setPlaying] = useState(autoplay);

  if (playing) {
    const params = new URLSearchParams({
      autoplay: '1',
      rel: '0',
      // Without this Android hands the video to its own fullscreen player the
      // instant it starts, which drops the reader out of the conversation to
      // watch a thirty-second clip.
      playsinline: '1',
    });
    if (start) params.set('start', String(start));

    return (
      <Frame
        uri={`https://www.youtube-nocookie.com/embed/${id}?${params}`}
        ratio={16 / 9}
        label="YouTube video"
      />
    );
  }

  // A still until somebody asks for the video. YouTube publishes one at a URL
  // anyone can build from the id, so this costs one picture rather than a
  // browser -- and it is the same bargain the desktop client strikes.
  return (
    <Pressable
      style={[styles.embed, { aspectRatio: 16 / 9 }]}
      onPress={() => setPlaying(true)}
      accessibilityRole="button"
      accessibilityLabel="Play YouTube video"
    >
      <Image
        style={StyleSheet.absoluteFill}
        source={`https://i.ytimg.com/vi/${id}/hqdefault.jpg`}
        contentFit="cover"
        cachePolicy="memory-disk"
        transition={120}
      />
      <View style={styles.ytPlay}>
        <Text style={styles.ytGlyph}>▶</Text>
      </View>
    </Pressable>
  );
}

/* -------------------------------------------------------------- tiktok */

/**
 * A TikTok post, on the same deal.
 *
 * There is no still to show first. YouTube publishes a thumbnail at a URL
 * anyone can build from the id; TikTok's is only reachable through an oEmbed
 * call, which is a request to TikTok for every link in the channel -- exactly
 * what the poster pattern exists to avoid. So the placeholder is drawn out of
 * nothing, and the frame is loaded when somebody asks for it.
 */
function TikTok({
  id,
  url,
  autoplay,
}: {
  id: string;
  url: string;
  autoplay: boolean;
}) {
  const [playing, setPlaying] = useState(autoplay);

  if (playing) {
    return (
      <Frame
        uri={`https://www.tiktok.com/embed/v2/${id}`}
        // Portrait, which is what the format is, capped so one post is not the
        // entire screen on a tall phone.
        ratio={9 / 16}
        maxHeight={PLAYER_MAX_HEIGHT}
        label="TikTok video"
      />
    );
  }

  return (
    <Pressable
      style={[styles.embed, styles.ttPoster]}
      onPress={() => setPlaying(true)}
      onLongPress={() => void Linking.openURL(url)}
      accessibilityRole="button"
      accessibilityLabel="Play TikTok video"
    >
      <Text style={styles.ttMark}>♪</Text>
      <Text style={styles.ttLabel}>Watch on TikTok</Text>
    </Pressable>
  );
}

/* --------------------------------------------------------------- frame */

/**
 * One third-party player, in a WebView.
 *
 * Two rules on it, and both are about what a page inside somebody else's frame
 * is allowed to do with this app:
 *
 * - Navigation away from the embed host is handed to the real browser rather
 *   than followed. Both players carry links out to their own site, and a tap on
 *   one would otherwise replace the video with a full web page inside a chat
 *   message, with no address bar and no way back.
 * - No file access and no third-party cookies. A player needs neither, and this
 *   is a frame loading a URL out of a stranger's message.
 */
function Frame({
  uri,
  ratio,
  maxHeight,
  label,
}: {
  uri: string;
  ratio: number;
  maxHeight?: number;
  label: string;
}) {
  const [loading, setLoading] = useState(true);
  const host = hostOf(uri);

  return (
    <View
      style={[
        styles.embed,
        { aspectRatio: ratio },
        maxHeight ? { maxHeight, aspectRatio: undefined, height: maxHeight } : null,
      ]}
    >
      <WebView
        style={styles.frame}
        source={{ uri }}
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        allowsFullscreenVideo
        javaScriptEnabled
        domStorageEnabled
        allowFileAccess={false}
        allowUniversalAccessFromFileURLs={false}
        thirdPartyCookiesEnabled={false}
        onLoadEnd={() => setLoading(false)}
        accessibilityLabel={label}
        onShouldStartLoadWithRequest={(request) => {
          // The first load is the embed itself and has to be allowed. Anything
          // afterwards that leaves the host is a link the player drew, and
          // belongs in the browser.
          if (hostOf(request.url) === host) return true;
          void Linking.openURL(request.url).catch(() => {});
          return false;
        }}
      />
      {loading && (
        <View style={styles.frameLoading} pointerEvents="none">
          <ActivityIndicator color={theme.textMuted} />
        </View>
      )}
    </View>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/* ------------------------------------------------------- linked image */

/** A picture somebody linked to, rather than uploaded. */
function LinkedImage({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  const viewer = useImageViewer();

  if (failed) return null;

  return (
    <Pressable
      style={styles.embed}
      onPress={() => viewer.open({ uri: url, name: fileNameOf(url) })}
      accessibilityRole="imagebutton"
      accessibilityLabel={fileNameOf(url)}
    >
      <Image
        style={styles.linkedImage}
        source={url}
        contentFit="cover"
        cachePolicy="memory-disk"
        transition={120}
        // A link that is not really a picture is not a failure worth a message:
        // the URL itself is already drawn above as a tappable link, so dropping
        // the embed leaves the message saying exactly what was sent.
        onError={() => setFailed(true)}
      />
    </Pressable>
  );
}

/* ------------------------------------------------------- linked video */

/**
 * A video somebody linked to directly.
 *
 * The player is created with no source at all and given one on the first tap,
 * which is this platform's version of the desktop's `preload="none"`: the view
 * exists, ExoPlayer exists, and not a byte is fetched until somebody presses
 * play. A channel of links costs nothing to scroll past.
 */
function LinkedVideo({ url }: { url: string }) {
  const [started, setStarted] = useState(false);
  const [failed, setFailed] = useState(false);

  // Nothing is said when a linked video turns out not to be one: the URL itself
  // is already drawn above as a tappable link, so dropping the embed leaves the
  // message saying exactly what was sent.
  if (failed) return null;

  // The player is mounted only once somebody presses play -- see the note on
  // `Player`. A channel of links costs nothing to scroll past.
  if (started) {
    return (
      <View style={[styles.embed, { aspectRatio: 16 / 9 }]}>
        <Player uri={url} onFailed={() => setFailed(true)} />
      </View>
    );
  }

  return (
    <Pressable
      style={[styles.embed, styles.videoPoster]}
      onPress={() => setStarted(true)}
      accessibilityRole="button"
      accessibilityLabel={`Play ${fileNameOf(url)}`}
    >
      <Text style={styles.videoGlyph}>▶</Text>
      <Text style={styles.videoName} numberOfLines={1}>
        {fileNameOf(url)}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  embed: {
    marginTop: spacing.sm,
    // Wide enough to be worth drawing, never wider than the column. The cap is
    // on the container rather than the picture so a 4000-pixel-wide photo and a
    // 200-pixel one are laid out the same way.
    maxWidth: 420,
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: theme.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  frame: { flex: 1, width: '100%', backgroundColor: '#000' },
  frameLoading: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ytPlay: {
    width: 56,
    height: 40,
    borderRadius: 8,
    // YouTube's own red, so the control reads as what it is before the
    // thumbnail behind it has even loaded.
    backgroundColor: 'rgba(255,0,0,0.92)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  ytGlyph: { color: '#fff', fontSize: 18, marginLeft: 2 },
  ttPoster: {
    height: 120,
    width: '100%',
    gap: spacing.xs,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
  },
  ttMark: { color: theme.text, fontSize: 30 },
  ttLabel: { color: theme.textMuted, fontSize: 12, fontWeight: '600' },
  linkedImage: {
    width: '100%',
    // A fixed frame rather than the picture's own shape. The height of a linked
    // image is not known until it arrives, and a message list that re-lays
    // itself out as each one loads is one nobody can read while it happens.
    height: 220,
  },
  videoPoster: {
    height: 92,
    width: '100%',
    flexDirection: 'row',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
  },
  videoGlyph: { color: theme.text, fontSize: 22 },
  videoName: { color: theme.textMuted, fontSize: 13, flexShrink: 1 },
});
