import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Image } from 'expo-image';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import type { UploadFile } from '../api';
import { describeBytes, MAX_MESSAGE_CHARS, personName } from '../format';
import {
  applyMention,
  matchUsers,
  mentionName,
  mentionQuery,
  toMarkup,
  type MentionQuery,
  type MentionUser,
} from '../mention-utils';
import { radius, spacing, TAP_TARGET, theme } from '../theme';
import { Avatar } from './Avatar';
import { Icon, type IconName } from './Icon';
import { Sheet } from './Sheet';

/**
 * The box at the bottom, and everything attached to it.
 *
 * Still a plain `TextInput`, and it stays one -- the same constraint the desktop
 * client set for its textarea. A rich editor would let a tag hold an invisible
 * id, and it would also mean re-implementing selection, undo and paste on a
 * platform where all three are the system's job and are better than anything
 * written here would be.
 *
 * So the box holds names and the conversion to `<@id>` happens once, on the way
 * out, through `toMarkup`. That is the whole of what the README described as
 * missing: reading tags always worked, and writing them needed the longest-match
 * rules ported rather than approximated.
 */

/** What is staged for upload, before it has a message to belong to. */
export interface StagedFile extends UploadFile {
  /** Stable across renders, so the preview strip has a key that is not the uri. */
  key: string;
  /** Bytes, when the picker knew. Null for a document that did not say. */
  size: number | null;
  /** Whether to draw a thumbnail rather than a file card. */
  isImage: boolean;
}

export interface ReplyTarget {
  id: string;
  authorName: string;
  /** One line of the message being answered, tags already resolved. */
  preview: string;
}

export interface EditTarget {
  id: string;
  /** The message as text, with `<@id>` already turned back into names. */
  text: string;
}

export interface ComposerProps {
  /** Placeholder, so the box says which channel it will post to. */
  channelName: string;
  disabled?: boolean;
  /** Everyone who can be tagged. The member list, as the picker wants it. */
  people: MentionUser[];
  /** Return sends instead of inserting a newline. The `enterSends` preference. */
  enterSends: boolean;
  /** The server's upload cap, so a file too big is refused here rather than there. */
  maxUploadBytes: number | null;

  reply: ReplyTarget | null;
  onCancelReply: () => void;
  edit: EditTarget | null;
  onCancelEdit: () => void;

  /**
   * Send. `content` already carries `<@id>` markers; `files` is what was staged.
   * `replyPing` is false when the reply's @ was switched off.
   */
  onSend: (content: string, files: StagedFile[], replyPing: boolean) => void;
  /** Save an edit. Separate from `onSend` because it is a different request. */
  onSaveEdit: (id: string, content: string) => void;

  onTypingStart: () => void;
  onTypingStop: () => void;
}

/** How long after the last keystroke before "typing" is taken back. */
const TYPING_IDLE_MS = 3000;

export function Composer({
  channelName,
  disabled,
  people,
  enterSends,
  maxUploadBytes,
  reply,
  onCancelReply,
  edit,
  onCancelEdit,
  onSend,
  onSaveEdit,
  onTypingStart,
  onTypingStop,
}: ComposerProps) {
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [files, setFiles] = useState<StagedFile[]>([]);
  const [picking, setPicking] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState<MentionQuery | null>(null);

  const input = useRef<TextInput>(null);
  const typing = useRef(false);
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Ids chosen from the picker, rather than typed.
   *
   * It matters only when two people answer to the same string -- then the one
   * actually tapped wins, which is the only way the reader can resolve an
   * ambiguity the app cannot. A ref, because it is read once at send and
   * nothing on screen depends on it.
   */
  const picked = useRef<Set<string>>(new Set());

  /** Switched off by the @ button on the reply bar. Reset with every reply. */
  const [replyPing, setReplyPing] = useState(true);
  useEffect(() => {
    setReplyPing(true);
  }, [reply?.id]);

  /**
   * Going into edit mode loads the message into the box, and coming out of it
   * clears it.
   *
   * Keyed on the id rather than the text: re-running when the text changes would
   * put the original back under somebody in the middle of rewriting it.
   */
  useEffect(() => {
    if (edit) {
      setText(edit.text);
      setCaret(edit.text.length);
      setFiles([]);
      input.current?.focus();
    } else {
      setText('');
      setQuery(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edit?.id]);

  const tooLong = text.length > MAX_MESSAGE_CHARS;
  const hasContent = text.trim().length > 0 || files.length > 0;
  const canSend = hasContent && !tooLong && !disabled;

  /* ----------------------------------------------------------- typing */

  /**
   * One `typing:start` per burst, not one per keystroke.
   *
   * The desktop client sends on a timer for the same reason, and it matters more
   * here: every emit is a radio wake-up, and a phone that transmits on every
   * character typed is a phone whose battery is noticeably worse for a feature
   * nobody asked for.
   */
  const noteTyping = useCallback(() => {
    if (disabled || edit) return;
    if (!typing.current) {
      typing.current = true;
      onTypingStart();
    }
    if (idle.current) clearTimeout(idle.current);
    idle.current = setTimeout(stopTyping, TYPING_IDLE_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled, edit, onTypingStart]);

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

  useEffect(() => stopTyping, []);

  /* ---------------------------------------------------------- mentions */

  function onChange(next: string) {
    setText(next);
    if (next.length > 0) noteTyping();
    // The caret has not been reported yet for this keystroke, so the query is
    // worked out against where it will be: one past the end of what changed.
    // `onSelectionChange` fires straight after and corrects it either way.
    syncPicker(next, caretAfter(text, next, caret));
  }

  function syncPicker(value: string, at: number) {
    const found = mentionQuery(value, at);
    // Closed as soon as nothing matches, which is what stops "@ " from leaving a
    // list open over the rest of a sentence.
    if (found && matchUsers(people, found.query, 1).length > 0) setQuery(found);
    else setQuery(null);
  }

  function chooseMention(user: MentionUser) {
    if (!query) return;
    const next = applyMention(text, query, user);
    picked.current.add(user.id);
    setText(next.text);
    setCaret(next.caret);
    setQuery(null);
    // The caret has to be put back by hand: React Native does not move it for a
    // controlled value change, so without this it sits wherever it was and the
    // next thing typed lands in the middle of the name just inserted.
    input.current?.setNativeProps({
      selection: { start: next.caret, end: next.caret },
    });
  }

  const matches = query ? matchUsers(people, query.query) : [];

  /* -------------------------------------------------------- attachments */

  function stage(next: StagedFile[]) {
    setError(null);
    const tooBig = maxUploadBytes
      ? next.find((f) => f.size !== null && f.size > maxUploadBytes)
      : undefined;
    if (tooBig) {
      // Refused here rather than by the server, because the server's refusal
      // arrives after the whole file has been uploaded over a mobile connection.
      setError(
        `${tooBig.name} is ${describeBytes(tooBig.size ?? 0)}. ` +
          `This server accepts up to ${describeBytes(maxUploadBytes!)}.`,
      );
      return;
    }
    setFiles((current) => [...current, ...next]);
  }

  async function pickMedia() {
    setPicking(true);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images', 'videos'],
        allowsMultipleSelection: true,
        selectionLimit: 10,
        // No re-encode. The desktop client uploads the file it was given, and a
        // phone quietly recompressing every photo to 70% would mean the same
        // picture looks worse depending on which client sent it.
        quality: 1,
      });
      if (result.canceled) return;
      stage(
        result.assets.map((asset, i) => ({
          key: `${Date.now()}-${i}`,
          uri: asset.uri,
          name: asset.fileName || fallbackName(asset.uri, asset.mimeType),
          type: asset.mimeType || 'application/octet-stream',
          size: asset.fileSize ?? null,
          isImage: !asset.mimeType || asset.mimeType.startsWith('image/'),
        })),
      );
    } catch {
      setError('The photo picker could not be opened.');
    } finally {
      setPicking(false);
    }
  }

  async function pickFile() {
    setPicking(true);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        multiple: true,
        // Copied into this app's cache first. A content:// URI handed straight
        // to the uploader can be revoked the moment the picker closes, which
        // shows up as an upload that fails on some phones and not others.
        copyToCacheDirectory: true,
      });
      if (result.canceled) return;
      stage(
        result.assets.map((asset, i) => ({
          key: `${Date.now()}-${i}`,
          uri: asset.uri,
          name: asset.name,
          type: asset.mimeType || 'application/octet-stream',
          size: asset.size ?? null,
          isImage: Boolean(asset.mimeType?.startsWith('image/')),
        })),
      );
    } catch {
      setError('The file picker could not be opened.');
    } finally {
      setPicking(false);
    }
  }

  /**
   * Run something from the attach sheet once the sheet has gone.
   *
   * The sheet is a `Modal`, and the photo and file pickers are activities of
   * their own. Launching one while the modal is still being torn down leaves
   * Android deciding which window gets focus back afterwards, and on some builds
   * it picks the dead modal -- the picker returns and the app ignores taps until
   * the back button is pressed. A short wait past the dismissal avoids the race.
   */
  function fromSheet(action: () => void) {
    setAttachOpen(false);
    setTimeout(action, 220);
  }

  /** "@" at the caret, with a space before it if it would touch a word. */
  function startMention() {
    const before = text.slice(0, caret);
    const glue = before.length > 0 && !/\s$/.test(before) ? ' ' : '';
    const next = `${before}${glue}@${text.slice(caret)}`;
    const at = caret + glue.length + 1;
    setText(next);
    setCaret(at);
    input.current?.focus();
    input.current?.setNativeProps({ selection: { start: at, end: at } });
    syncPicker(next, at);
  }

  function unstage(key: string) {
    setFiles((current) => current.filter((f) => f.key !== key));
  }

  /* ------------------------------------------------------------- send */

  function submit() {
    const raw = text.trim();
    if (edit) {
      // An edit to nothing is a delete, and a delete is a different decision
      // with a different confirmation. The desktop client refuses this too.
      if (!raw) return;
      onSaveEdit(edit.id, toMarkup(raw, people, picked.current));
      picked.current.clear();
      return;
    }

    if (!canSend) return;
    const content = toMarkup(raw, people, picked.current);
    const staged = files;

    // Cleared before the send rather than after it. The message is delivered
    // optimistically by the caller, so the box emptying is what says "gone";
    // waiting for the server would leave the text sitting there over a slow
    // connection and invite a second tap.
    setText('');
    setFiles([]);
    setQuery(null);
    picked.current.clear();
    stopTyping();
    onSend(content, staged, replyPing);
  }

  return (
    <View style={styles.wrap}>
      {/* ------------------------------------------------- mention picker */}
      {matches.length > 0 && (
        <ScrollView
          style={styles.picker}
          keyboardShouldPersistTaps="always"
          // Newest at the bottom, nearest the box being typed in -- which on a
          // phone is where the thumb already is.
        >
          {matches.map((user) => (
            <Pressable
              key={user.id}
              onPress={() => chooseMention(user)}
              style={({ pressed }) => [styles.pickerRow, pressed && styles.pressed]}
              accessibilityRole="button"
              accessibilityLabel={`Tag ${mentionName(user)}`}
            >
              <Avatar
                userId={user.id}
                name={mentionName(user)}
                image={user.image ?? null}
                size={24}
              />
              <Text style={styles.pickerName} numberOfLines={1}>
                {mentionName(user)}
              </Text>
              {user.username !== user.displayName && (
                <Text style={styles.pickerHandle} numberOfLines={1}>
                  @{user.username}
                </Text>
              )}
            </Pressable>
          ))}
        </ScrollView>
      )}

      {/* ---------------------------------------------------- reply / edit */}
      {edit ? (
        <View style={styles.bar}>
          <Text style={styles.barLabel} numberOfLines={1}>
            Editing message
          </Text>
          <Pressable
            onPress={onCancelEdit}
            hitSlop={10}
            style={styles.barX}
            accessibilityRole="button"
            accessibilityLabel="Cancel edit"
          >
            <Icon name="close" size={18} />
          </Pressable>
        </View>
      ) : reply ? (
        <View style={styles.bar}>
          <Text style={styles.barLabel} numberOfLines={1}>
            <Text style={styles.barWho}>Replying to {reply.authorName}</Text>
            {'  '}
            {reply.preview}
          </Text>
          {/* The @ switch. Replying tags the person by default, because that is
              what replying is for -- but answering four of somebody's messages
              in a row should not ping them four times. */}
          <Pressable
            onPress={() => setReplyPing((on) => !on)}
            hitSlop={10}
            style={[styles.pingToggle, !replyPing && styles.pingOff]}
            accessibilityRole="switch"
            accessibilityState={{ checked: replyPing }}
            accessibilityLabel="Tag the person being replied to"
          >
            <Text style={[styles.pingLabel, !replyPing && styles.pingLabelOff]}>
              @
            </Text>
          </Pressable>
          <Pressable
            onPress={onCancelReply}
            hitSlop={10}
            style={styles.barX}
            accessibilityRole="button"
            accessibilityLabel="Cancel reply"
          >
            <Icon name="close" size={18} />
          </Pressable>
        </View>
      ) : null}

      {/* ------------------------------------------------------- staged */}
      {files.length > 0 && (
        <ScrollView
          horizontal
          style={styles.staged}
          contentContainerStyle={styles.stagedContent}
          showsHorizontalScrollIndicator={false}
        >
          {files.map((file) => (
            <View key={file.key} style={styles.chip}>
              {file.isImage ? (
                <Image
                  style={styles.chipImage}
                  source={file.uri}
                  contentFit="cover"
                />
              ) : (
                <View style={styles.chipFile}>
                  <Icon name="file-outline" size={22} />
                  <Text style={styles.chipName} numberOfLines={2}>
                    {file.name}
                  </Text>
                </View>
              )}
              <Pressable
                onPress={() => unstage(file.key)}
                hitSlop={8}
                style={styles.chipX}
                accessibilityRole="button"
                accessibilityLabel={`Remove ${file.name}`}
              >
                <Icon name="close" size={14} color="#fff" />
              </Pressable>
            </View>
          ))}
        </ScrollView>
      )}

      {error && <Text style={styles.error}>{error}</Text>}
      {tooLong && (
        <Text style={styles.error}>
          {text.length - MAX_MESSAGE_CHARS} characters over the limit
        </Text>
      )}

      {/* ---------------------------------------------------------- box */}
      <View style={styles.row}>
        {!edit && (
          <Pressable
            onPress={() => setAttachOpen(true)}
            disabled={picking || disabled}
            hitSlop={6}
            style={({ pressed }) => [
              styles.plus,
              (picking || disabled) && styles.plusDisabled,
              pressed && styles.pressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel="Add a photo, file or mention"
          >
            {picking ? (
              <ActivityIndicator size="small" color={theme.textMuted} />
            ) : (
              <Icon name="plus" size={24} color={theme.text} />
            )}
          </Pressable>
        )}

        <TextInput
          ref={input}
          style={styles.input}
          value={text}
          onChangeText={onChange}
          onSelectionChange={(e) => {
            const at = e.nativeEvent.selection.start;
            setCaret(at);
            syncPicker(text, at);
          }}
          onBlur={stopTyping}
          placeholder={
            disabled
              ? 'Reconnecting…'
              : edit
                ? 'Edit your message'
                : `Message #${channelName}`
          }
          placeholderTextColor={theme.textFaint}
          editable={!disabled}
          multiline
          // Over the limit rather than at it: the count above says by how much,
          // which somebody can act on, where a box that silently stops taking
          // characters cannot be told from a broken keyboard.
          maxLength={MAX_MESSAGE_CHARS + 500}
          // `enterSends` is off by default, and deliberately the opposite of the
          // desktop client -- a soft keyboard has no shift for the return key,
          // so an app that sends on return is one in which a two-line message
          // cannot be typed at all.
          blurOnSubmit={false}
          returnKeyType={enterSends ? 'send' : 'default'}
          onSubmitEditing={enterSends ? submit : undefined}
          textAlignVertical="center"
        />

        <Pressable
          onPress={submit}
          disabled={edit ? !text.trim() : !canSend}
          hitSlop={8}
          style={({ pressed }) => [
            styles.send,
            (edit ? !text.trim() : !canSend) && styles.sendDisabled,
            pressed && styles.pressed,
          ]}
          accessibilityRole="button"
          accessibilityLabel={edit ? 'Save edit' : 'Send message'}
        >
          <Icon
            name={edit ? 'check' : 'send'}
            size={20}
            color={(edit ? !text.trim() : !canSend) ? theme.textFaint : theme.accentText}
          />
        </Pressable>
      </View>

      {/* -------------------------------------------------- attach sheet */}
      <Sheet visible={attachOpen} onClose={() => setAttachOpen(false)}>
        <View style={styles.tiles}>
          <Tile
            icon="image-multiple-outline"
            label="Photos and videos"
            onPress={() => fromSheet(() => void pickMedia())}
          />
          <Tile
            icon="file-outline"
            label="File"
            onPress={() => fromSheet(() => void pickFile())}
          />
          <Tile
            icon="at"
            label="Mention someone"
            onPress={() => fromSheet(startMention)}
          />
        </View>
      </Sheet>
    </View>
  );
}

/** One of the big square buttons in the attach sheet. */
function Tile({
  icon,
  label,
  onPress,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.tile, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <View style={styles.tileIcon}>
        <Icon name={icon} size={26} color={theme.text} />
      </View>
      <Text style={styles.tileLabel} numberOfLines={2}>
        {label}
      </Text>
    </Pressable>
  );
}

/* ---------------------------------------------------------------- bits */

/**
 * Where the caret will be after a change React has not reported yet.
 *
 * `onChangeText` fires before `onSelectionChange`, so the mention picker would
 * otherwise be one keystroke behind -- typing "@a" would query for "@". Working
 * it out from the length difference is exact for the ordinary cases (typing,
 * deleting, pasting at the caret) and no worse than the old caret for the
 * unusual ones, which the selection event corrects a moment later anyway.
 */
function caretAfter(before: string, after: string, caret: number): number {
  return Math.max(0, Math.min(after.length, caret + (after.length - before.length)));
}

/**
 * A name for something the picker did not name.
 *
 * Android's photo picker often returns a `content://` URI and no file name at
 * all. The server stores whatever it is told, and an attachment called
 * "content://media/external/..." is one nobody can identify in a channel a week
 * later.
 */
function fallbackName(uri: string, mimeType?: string): string {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const extension =
    mimeType?.split('/')[1]?.replace(/[^a-z0-9]/gi, '') ||
    uri.split('.').pop()?.slice(0, 5) ||
    'bin';
  return `${mimeType?.startsWith('video/') ? 'video' : 'photo'}-${stamp}.${extension}`;
}

const styles = StyleSheet.create({
  wrap: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.border,
    backgroundColor: theme.bg,
  },
  pressed: { opacity: 0.7 },

  picker: {
    maxHeight: 200,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
    backgroundColor: theme.surface,
  },
  pickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: TAP_TARGET,
    paddingHorizontal: spacing.md,
  },
  pickerName: { color: theme.text, fontSize: 14, flexShrink: 1 },
  pickerHandle: { color: theme.textFaint, fontSize: 12, flexShrink: 1 },

  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: theme.surface,
  },
  barLabel: { color: theme.textFaint, fontSize: 12, flex: 1 },
  barWho: { color: theme.textMuted, fontWeight: '600' },
  barX: { paddingHorizontal: spacing.xs },
  pingToggle: {
    width: 26,
    height: 26,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.accent,
  },
  pingOff: { backgroundColor: theme.surfaceAlt },
  pingLabel: { color: theme.accentText, fontSize: 13, fontWeight: '700' },
  pingLabelOff: { color: theme.textFaint },

  staged: { maxHeight: 92 },
  stagedContent: { gap: spacing.sm, padding: spacing.sm },
  chip: {
    width: 72,
    height: 72,
    borderRadius: radius.sm,
    overflow: 'hidden',
    backgroundColor: theme.surfaceAlt,
  },
  chipImage: { width: '100%', height: '100%' },
  chipFile: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xs,
    gap: 2,
  },
  chipName: { color: theme.textFaint, fontSize: 9, textAlign: 'center' },
  chipX: {
    position: 'absolute',
    top: 2,
    right: 2,
    width: 20,
    height: 20,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(0,0,0,0.65)',
    alignItems: 'center',
    justifyContent: 'center',
  },

  error: {
    color: theme.danger,
    fontSize: 12,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.xs,
  },

  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
  },
  // The round buttons either side are a little smaller than the box between
  // them, and `hitSlop` makes up the difference to a full tap target. Drawn
  // at 44 they crowd the box; drawn at 40 with slop they read as part of it.
  plus: {
    width: 40,
    height: 40,
    marginBottom: 2,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.surfaceAlt,
  },
  plusDisabled: { opacity: 0.5 },
  input: {
    flex: 1,
    minHeight: TAP_TARGET,
    // Four lines, then it scrolls. Enough for a paragraph without the keyboard
    // and the box between them swallowing the conversation.
    maxHeight: 120,
    paddingHorizontal: spacing.lg,
    paddingTop: 11,
    paddingBottom: 11,
    // Half the single-line height: a pill while it is one line, and a rounded
    // box rather than a lozenge once it grows.
    borderRadius: TAP_TARGET / 2,
    backgroundColor: theme.surfaceAlt,
    color: theme.text,
    fontSize: 15,
  },
  send: {
    width: 40,
    height: 40,
    marginBottom: 2,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.accent,
  },
  sendDisabled: { backgroundColor: theme.surfaceAlt },

  tiles: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
  },
  tile: {
    flex: 1,
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
  },
  tileIcon: {
    width: 56,
    height: 56,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.surfaceAlt,
  },
  tileLabel: { color: theme.text, fontSize: 13, textAlign: 'center' },
});
