import { memo, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useVideoPlayer, VideoView } from 'expo-video';
import { absoluteUrl, authHeaders } from '../api';
import { saveAttachment } from '../download';
import { describeBytes } from '../format';
import { radius, spacing, theme } from '../theme';
import type { Attachment } from '../types';
import { useImageViewer } from './ImageViewer';

/**
 * Files that came through the server, drawn.
 *
 * The desktop client fetches every one of these by hand and hands the DOM an
 * object URL, because an `<img src>` cannot send an Authorization header. None
 * of that is needed here: `expo-image` takes headers on the source and
 * `expo-video` takes them on the source too, so the bytes go straight into the
 * view and the caching is the platform's problem rather than ours.
 *
 * That difference is why this file is a third of the size of its desktop
 * counterpart, and it is worth saying out loud -- the temptation when porting
 * is to bring the object-URL cache across as though it were the design rather
 * than a workaround for one platform's limitation.
 */

/** The types this build knows how to put on screen. */
const RENDERABLE = /^image\/(png|jpeg|gif|webp)$/i;

/**
 * Whether to draw an attachment as a picture.
 *
 * The server's answer wins. It is the side that decides what it will hand back
 * as a renderable type and what it will only ever hand back as bytes to save,
 * and those two answers have to be the same one.
 *
 * `inline` is absent from a server older than the feature, where every
 * attachment was a picture. Falling back to the content type is what this build
 * would have done before being told, so an old server behaves as it always did.
 */
const drawInline = (file: Attachment): boolean =>
  file.inline ?? RENDERABLE.test(file.contentType);

/**
 * Which of the two inline shapes an attachment is.
 *
 * Read off the content type rather than off `inline`, because `inline` only
 * answers "may this be drawn" and a server newer than this build could widen it
 * again. Anything inline that is not video is a picture.
 */
const isVideo = (file: Attachment): boolean => /^video\//i.test(file.contentType);

/**
 * How long is left, in the largest unit that is still true.
 *
 * Rounded down, never up: "expires in 1 hour" on something with fifty-nine
 * minutes left is a promise that can be kept, and the reverse is not.
 */
function timeLeft(iso: string): string | null {
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return 'expiring now';
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return `expires in ${days} day${days === 1 ? '' : 's'}`;
  }
  if (hours >= 1) return `expires in ${hours} hour${hours === 1 ? '' : 's'}`;
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  return `expires in ${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/** One attachment, whichever of the three shapes it turns out to be. */
export const AttachmentView = memo(function AttachmentView({
  file,
}: {
  file: Attachment;
}) {
  // Expired is not a failure and gets the same card a file does: the row
  // outlives the bytes, so the message can still say what was there.
  if (file.expiredAt) return <AttachmentFile file={file} />;
  if (!drawInline(file)) return <AttachmentFile file={file} />;
  if (isVideo(file)) return <AttachmentVideo file={file} />;
  return <AttachmentImage file={file} />;
});

/* -------------------------------------------------------------- picture */

function AttachmentImage({ file }: { file: Attachment }) {
  const [failed, setFailed] = useState(false);
  const viewer = useImageViewer();
  const uri = absoluteUrl(file.url);

  if (failed) {
    return (
      <View style={styles.failed}>
        <Text style={styles.failedText}>Could not load {file.fileName}</Text>
      </View>
    );
  }

  /**
   * The shape it will be, before the bytes say so.
   *
   * This is the whole reason the server stores width and height. Without it the
   * message list re-lays itself out as each picture arrives, which on a phone
   * means the conversation jumps under the thumb of somebody reading it. A
   * picture whose dimensions the server never recorded falls back to a fixed
   * frame -- still wrong, but wrong once and in a way that does not move.
   */
  const ratio = file.width && file.height ? file.width / file.height : undefined;

  return (
    <Pressable
      style={[
        styles.picture,
        ratio ? { aspectRatio: ratio } : styles.pictureFallback,
      ]}
      onPress={() =>
        viewer.open({
          uri,
          headers: authHeaders(),
          name: file.fileName,
          attachmentPath: file.url,
        })
      }
      accessibilityRole="imagebutton"
      accessibilityLabel={file.fileName}
    >
      <Image
        style={StyleSheet.absoluteFill}
        source={{ uri, headers: authHeaders() }}
        contentFit="cover"
        // The bytes are immutable -- a new upload is a new id at a new path --
        // which makes an indefinite disk cache correct rather than merely fast.
        cachePolicy="memory-disk"
        transition={120}
        // A fetch that worked and bytes that will not decode is a real state: a
        // server newer than this build may call something inline that this one
        // has no idea how to draw, and a silent empty box is the worst way to
        // say so.
        onError={() => setFailed(true)}
      />
    </Pressable>
  );
}

/* ---------------------------------------------------------------- video */

/**
 * One uploaded video.
 *
 * Played from the server rather than downloaded first, which is the one place
 * this client is straightforwardly better than the desktop one: ExoPlayer takes
 * the bearer header on the request and streams, where the desktop has to pull
 * the whole object into a blob before the first frame can play. Nothing is
 * fetched at all until the card is tapped.
 */
function AttachmentVideo({ file }: { file: Attachment }) {
  const [started, setStarted] = useState(false);
  const [failed, setFailed] = useState(false);

  const left = file.expiresAt ? timeLeft(file.expiresAt) : null;

  if (failed) {
    return (
      <View style={styles.failed}>
        <Text style={styles.failedText}>Could not play {file.fileName}</Text>
      </View>
    );
  }

  // The player is a separate component, and that is the whole reason this one
  // exists: `useVideoPlayer` is a hook, so it cannot be called conditionally,
  // and a channel holding twenty videos would otherwise hold twenty native
  // ExoPlayer instances the moment it scrolled into view. Mounting the player
  // only once somebody presses play is the same bargain as the poster itself.
  if (started) {
    return (
      <View style={styles.video}>
        <Player
          uri={absoluteUrl(file.url)}
          headers={authHeaders()}
          onFailed={() => setFailed(true)}
        />
      </View>
    );
  }

  return (
    <Pressable
      style={styles.videoPoster}
      onPress={() => setStarted(true)}
      accessibilityRole="button"
      accessibilityLabel={`Play ${file.fileName}`}
    >
      <Text style={styles.videoGlyph}>▶</Text>
      <View style={styles.videoMeta}>
        <Text style={styles.fileName} numberOfLines={1}>
          {file.fileName}
        </Text>
        {/* Said on a video as well as on a file, because it is just as true and
            twice as surprising: a video is drawn inline and looks like part of
            the conversation, and it is on the same clock as everything that is
            not a picture. */}
        <Text style={styles.fileMeta}>
          {describeBytes(file.size)}
          {left ? ` · ${left}` : ''}
        </Text>
      </View>
    </Pressable>
  );
}

/**
 * The player itself, mounted only once somebody has asked for it.
 *
 * ExoPlayer takes the bearer header on the request, so the bytes stream
 * straight from the server -- where the desktop client has to pull the whole
 * object into a blob first, because a `<video src>` cannot carry an
 * Authorization header. That is a workaround for one platform's limitation and
 * not a design worth porting.
 */
export function Player({
  uri,
  headers,
  onFailed,
}: {
  uri: string;
  headers?: Record<string, string>;
  onFailed: () => void;
}) {
  const player = useVideoPlayer({ uri, headers }, (p) => {
    p.loop = false;
    // Autoplay only because a tap just asked for it -- this component is not
    // mounted until then.
    p.play();
  });

  useEffect(() => {
    const sub = player.addListener('statusChange', ({ status }) => {
      if (status === 'error') onFailed();
    });
    return () => sub.remove();
  }, [player, onFailed]);

  return (
    <VideoView
      style={styles.videoSurface}
      player={player}
      nativeControls
      contentFit="contain"
    />
  );
}

/* ----------------------------------------------------------------- file */

/**
 * One uploaded file that is not a picture.
 *
 * Save, and only save. The server hands these back as an octet-stream
 * attachment that nothing will render, and this end matches that: there is no
 * open and no preview. Anyone with an invite may upload anything, including an
 * APK, and an app that opened one on the reader's behalf is the thing that ran
 * it. The share sheet is the line -- past it, the choice of what opens the file
 * is the system's and the reader's.
 */
function AttachmentFile({ file }: { file: Attachment }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const expired = Boolean(file.expiredAt);
  const left = file.expiresAt && !expired ? timeLeft(file.expiresAt) : null;

  async function save() {
    setBusy(true);
    setError(null);
    const result = await saveAttachment(file.url, file.fileName);
    setBusy(false);
    if (!result.ok) setError(result.error);
  }

  return (
    <View style={[styles.file, expired && styles.fileExpired]}>
      <Text style={styles.fileIcon}>{expired ? '✕' : '▤'}</Text>
      <View style={styles.fileBody}>
        <Text style={styles.fileName} numberOfLines={1}>
          {file.fileName}
        </Text>
        {expired ? (
          <Text style={styles.fileMeta}>
            No longer on the server — files that are not pictures are kept for a
            limited time.
          </Text>
        ) : (
          <Text style={styles.fileMeta}>
            {describeBytes(file.size)}
            {left ? ` · ${left}` : ''}
          </Text>
        )}
        {error && <Text style={styles.fileError}>{error}</Text>}
      </View>
      {!expired && (
        <Pressable
          onPress={save}
          disabled={busy}
          hitSlop={8}
          style={styles.fileSave}
          accessibilityRole="button"
          accessibilityLabel={`Save ${file.fileName}`}
        >
          {busy ? (
            <ActivityIndicator size="small" color={theme.text} />
          ) : (
            <Text style={styles.fileSaveLabel}>Save</Text>
          )}
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  picture: {
    marginTop: spacing.sm,
    width: '100%',
    maxWidth: 420,
    maxHeight: 400,
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: theme.surfaceAlt,
  },
  pictureFallback: { height: 220 },
  video: {
    marginTop: spacing.sm,
    width: '100%',
    maxWidth: 420,
    aspectRatio: 16 / 9,
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: '#000',
  },
  videoSurface: { flex: 1, width: '100%' },
  videoPoster: {
    marginTop: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    maxWidth: 420,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: theme.surfaceAlt,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
  },
  videoGlyph: { color: theme.text, fontSize: 20 },
  videoMeta: { flex: 1 },
  file: {
    marginTop: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    maxWidth: 420,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: theme.surfaceAlt,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
  },
  fileExpired: { opacity: 0.6 },
  fileIcon: { color: theme.textMuted, fontSize: 18 },
  fileBody: { flex: 1 },
  fileName: { color: theme.text, fontSize: 13, fontWeight: '600' },
  fileMeta: { color: theme.textFaint, fontSize: 11, marginTop: 1 },
  fileError: { color: theme.danger, fontSize: 11, marginTop: 2 },
  fileSave: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: theme.surface,
    minWidth: 58,
    alignItems: 'center',
  },
  fileSaveLabel: { color: theme.text, fontSize: 13, fontWeight: '600' },
  failed: {
    marginTop: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: theme.surfaceAlt,
  },
  failedText: { color: theme.textMuted, fontSize: 12 },
});
