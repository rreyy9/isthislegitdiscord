import { useEffect, useLayoutEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useNavigation } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api, ApiError } from '../src/api';
import { store } from '../src/store';
import { Avatar } from '../src/components/Avatar';
import { downloadUpdate } from '../src/updates';
import { useSession } from '../src/session';
import { CLIENT_VERSION } from '../src/version';
import { radius, spacing, TAP_TARGET, theme } from '../src/theme';

/**
 * Settings, as a screen.
 *
 * The desktop client's settings window has six pages, and four of them are
 * about voice: input and output devices, push-to-talk, keybindings, audio
 * quality. None of that exists on a phone -- there are no devices to choose
 * between, no global hotkeys, and no voice in this build -- so what is left is
 * the profile page, the notification switches, and the "about" page that says
 * what this build is.
 *
 * What has been added instead are the three that only a phone needs: whether to
 * fetch embeds at all, whether to load a player without being asked, and what
 * the return key does. All three are about being on a metered connection with a
 * soft keyboard, which is a situation the desktop client never has to consider.
 *
 * A screen rather than a modal because it is somewhere you go, not something
 * that interrupts -- and because the back gesture is then the way out, with no
 * close button to find.
 */

export default function Settings() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const {
    me,
    config,
    serverUrl,
    status,
    update,
    prefs,
    setPrefs,
    applyMe,
    signOut,
  } = useSession();

  const [name, setName] = useState(me?.displayName ?? '');
  const [saving, setSaving] = useState(false);
  const [savedNote, setSavedNote] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyAvatar, setBusyAvatar] = useState(false);
  const [downloading, setDownloading] = useState(false);
  /**
   * Whether a password is remembered on this phone.
   *
   * Read once, on the way in. The only way to turn it *on* is the tick box on
   * the sign-in screen, which is not reachable while signed in -- so without a
   * way to turn it off here, the only way to forget a remembered password would
   * be to sign out first, which is the opposite of what somebody worried about
   * it wants to do.
   */
  const [remembered, setRemembered] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void store.getLogin().then((saved) => {
      if (!cancelled) setRemembered(Boolean(saved));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useLayoutEffect(() => {
    navigation.setOptions({ title: 'Settings' });
  }, [navigation]);

  // The name can also change from under this screen -- an admin renaming you, or
  // the same account signed in on another device -- and the field has to follow,
  // or saving here would quietly put the old name back.
  useEffect(() => {
    setName(me?.displayName ?? '');
  }, [me?.displayName]);

  const trimmed = name.trim();
  const dirty = trimmed !== (me?.displayName ?? '');

  async function saveName() {
    if (!dirty || !trimmed) return;
    setSaving(true);
    setError(null);
    setSavedNote(false);
    try {
      applyMe(await api.updateProfile({ displayName: trimmed }));
      setSavedNote(true);
    } catch (e) {
      setError(
        e instanceof ApiError
          ? e.message
          : 'That did not save. Check the connection and try again.',
      );
    } finally {
      setSaving(false);
    }
  }

  /**
   * Change the picture.
   *
   * `allowsEditing` with a square aspect is the whole of the crop. The desktop
   * client draws its own framing dialog -- a canvas, a drag handle and a zoom
   * slider -- because a browser has no cropper to call. Android does, it is the
   * one people already know, and the picture that comes back is exactly the
   * square the server wants. The server has no image codec and stores what it is
   * given, so cropping has to happen on this side either way.
   */
  async function changeAvatar() {
    setError(null);
    setBusyAvatar(true);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.9,
      });
      if (result.canceled) return;

      const asset = result.assets[0];
      applyMe(
        await api.uploadAvatar({
          uri: asset.uri,
          name: asset.fileName || 'avatar.jpg',
          type: asset.mimeType || 'image/jpeg',
        }),
      );
    } catch (e) {
      setError(
        e instanceof ApiError ? e.message : 'That picture could not be uploaded.',
      );
    } finally {
      setBusyAvatar(false);
    }
  }

  async function removeAvatar() {
    setBusyAvatar(true);
    setError(null);
    try {
      applyMe(await api.updateProfile({ removeAvatar: true }));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That did not save.');
    } finally {
      setBusyAvatar(false);
    }
  }

  async function getUpdate() {
    setDownloading(true);
    const result = await downloadUpdate();
    setDownloading(false);
    if (!result.ok) Alert.alert('The update could not be fetched', result.error);
  }

  function confirmSignOut() {
    Alert.alert(
      'Sign out?',
      'You will need your password to sign back in on this phone.',
      [
        { text: 'Stay signed in', style: 'cancel' },
        { text: 'Sign out', style: 'destructive', onPress: () => void signOut() },
      ],
    );
  }

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={{ paddingBottom: insets.bottom + spacing.xl }}
      keyboardShouldPersistTaps="handled"
    >
      {/* ------------------------------------------------------- profile */}
      <Section title="Profile">
        <View style={styles.avatarRow}>
          {me && (
            <Avatar
              userId={me.id}
              name={me.displayName || me.username || '?'}
              image={me.image}
              size={72}
            />
          )}
          <View style={styles.avatarActions}>
            <SmallButton
              label={me?.image ? 'Change picture' : 'Upload a picture'}
              onPress={changeAvatar}
              busy={busyAvatar}
            />
            {me?.image && (
              <SmallButton label="Remove" onPress={removeAvatar} danger />
            )}
          </View>
        </View>
        <Text style={styles.hint}>
          Avatars are round and square-cropped. The picker lets you choose which
          part shows.
        </Text>

        <Text style={styles.label}>Display name</Text>
        <View style={styles.nameRow}>
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={(next) => {
              setName(next);
              setSavedNote(false);
            }}
            maxLength={64}
            placeholder={me?.username ?? 'Your name'}
            placeholderTextColor={theme.textFaint}
            returnKeyType="done"
            onSubmitEditing={saveName}
          />
          <Pressable
            onPress={saveName}
            disabled={!dirty || !trimmed || saving}
            style={({ pressed }) => [
              styles.save,
              (!dirty || !trimmed || saving) && styles.saveDisabled,
              pressed && styles.pressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel="Save display name"
          >
            {saving ? (
              <ActivityIndicator size="small" color={theme.accentText} />
            ) : (
              <Text style={styles.saveLabel}>Save</Text>
            )}
          </Pressable>
        </View>
        <Text style={styles.hint}>
          What people see next to your messages. Your handle stays{' '}
          <Text style={styles.strong}>{me?.username}</Text> — that is what an @
          mention matches, and it does not change.
        </Text>

        {/* Saved explicitly rather than as you type. Every other setting here is
            yours alone and applies the moment you touch it; this one is
            broadcast to everybody the instant it lands, and half a name arriving
            in eight other people's member lists is not a thing to do quietly. */}
        {error && <Text style={styles.bad}>{error}</Text>}
        {savedNote && !error && <Text style={styles.ok}>Saved.</Text>}
      </Section>

      {/* ------------------------------------------------- notifications */}
      <Section title="When somebody tags you">
        <Toggle
          label="Show a banner"
          hint="Only while the app is open — this server has no push notifications yet."
          value={prefs.mentionAlerts}
          onChange={(mentionAlerts) => setPrefs({ mentionAlerts })}
        />
        <Toggle
          label="Vibrate"
          hint="One short buzz with the banner."
          value={prefs.vibrate}
          disabled={!prefs.mentionAlerts}
          onChange={(vibrate) => setPrefs({ vibrate })}
        />
      </Section>

      {/* --------------------------------------------------- the messages */}
      <Section title="Messages">
        <Toggle
          label="Show link previews"
          hint="Pictures, videos and the YouTube thumbnail. Off leaves the link itself."
          value={prefs.showEmbeds}
          onChange={(showEmbeds) => setPrefs({ showEmbeds })}
        />
        <Toggle
          label="Load players without asking"
          hint="Off means a YouTube or TikTok post waits for a tap before it loads."
          value={prefs.autoplayEmbeds}
          disabled={!prefs.showEmbeds}
          onChange={(autoplayEmbeds) => setPrefs({ autoplayEmbeds })}
        />
        <Toggle
          label="Return key sends"
          hint="Off means return starts a new line, and the arrow sends."
          value={prefs.enterSends}
          onChange={(enterSends) => setPrefs({ enterSends })}
        />
      </Section>

      {/* -------------------------------------------------------- about */}
      <Section title="About">
        <Row label="This app" value={CLIENT_VERSION} />
        <Row label="Server" value={config?.appVersion ?? '—'} />
        <Row
          label="Address"
          value={serverUrl.replace(/^https?:\/\//, '')}
        />
        <Row
          label="Connection"
          value={
            status === 'connected'
              ? 'Connected'
              : status === 'connecting'
                ? 'Reconnecting…'
                : 'Offline'
          }
        />
        {update && (
          <View style={styles.updateBox}>
            <Text style={styles.updateText}>
              Version {update.version} is available.
            </Text>
            <Text style={styles.hint}>
              It downloads in your browser; tap the finished file to install.
            </Text>
            <SmallButton
              label={downloading ? 'Opening…' : 'Get it'}
              onPress={getUpdate}
              busy={downloading}
            />
          </View>
        )}
      </Section>

      {/* ------------------------------------------------------ sign out */}
      {remembered && (
        <Section title="This phone">
          <View style={styles.toggleRow}>
            <View style={styles.toggleText}>
              <Text style={styles.toggleLabel}>Password is remembered</Text>
              <Text style={styles.hint}>
                Kept in the Android keystore so signing back in is one tap when
                the session lapses. Forgetting it does not sign you out.
              </Text>
            </View>
          </View>
          <SmallButton
            label="Forget it"
            danger
            onPress={() => {
              void store.clearLogin();
              setRemembered(false);
            }}
          />
        </Section>
      )}

      <View style={styles.signOutWrap}>
        <Pressable
          onPress={confirmSignOut}
          style={({ pressed }) => [styles.signOut, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel="Sign out"
        >
          <Text style={styles.signOutLabel}>Sign out</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

/* ---------------------------------------------------------------- bits */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.card}>{children}</View>
    </View>
  );
}

/**
 * One switch and what it does.
 *
 * The hint is not optional in practice: every setting here changes something
 * that happens somewhere else in the app, and a bare label leaves somebody
 * toggling it to find out.
 */
function Toggle({
  label,
  hint,
  value,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  value: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <View style={[styles.toggleRow, disabled && styles.disabled]}>
      <View style={styles.toggleText}>
        <Text style={styles.toggleLabel}>{label}</Text>
        {hint && <Text style={styles.hint}>{hint}</Text>}
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        trackColor={{ false: theme.border, true: theme.accent }}
        thumbColor={theme.text}
      />
    </View>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

function SmallButton({
  label,
  onPress,
  busy,
  danger,
}: {
  label: string;
  onPress: () => void;
  busy?: boolean;
  danger?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={busy}
      style={({ pressed }) => [styles.smallButton, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      {busy ? (
        <ActivityIndicator size="small" color={theme.text} />
      ) : (
        <Text style={[styles.smallLabel, danger && styles.smallDanger]}>{label}</Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.45 },

  section: { paddingHorizontal: spacing.md, paddingTop: spacing.lg },
  sectionTitle: {
    color: theme.textMuted,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    paddingHorizontal: spacing.sm,
    paddingBottom: spacing.sm,
  },
  card: {
    backgroundColor: theme.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.sm,
  },

  avatarRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg },
  avatarActions: { flex: 1, gap: spacing.sm },

  label: {
    color: theme.textMuted,
    fontSize: 12,
    fontWeight: '600',
    marginTop: spacing.md,
  },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  input: {
    flex: 1,
    minHeight: TAP_TARGET,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    backgroundColor: theme.surfaceAlt,
    color: theme.text,
    fontSize: 15,
  },
  save: {
    minWidth: 68,
    height: TAP_TARGET,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    backgroundColor: theme.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveDisabled: { backgroundColor: theme.surfaceAlt },
  saveLabel: { color: theme.accentText, fontSize: 14, fontWeight: '700' },

  hint: { color: theme.textFaint, fontSize: 12, lineHeight: 17 },
  strong: { color: theme.textMuted, fontWeight: '700' },
  bad: { color: theme.danger, fontSize: 13 },
  ok: { color: theme.online, fontSize: 13 },

  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.xs,
  },
  toggleText: { flex: 1, gap: 2 },
  toggleLabel: { color: theme.text, fontSize: 15 },

  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingVertical: spacing.xs,
  },
  infoLabel: { color: theme.textMuted, fontSize: 13 },
  infoValue: { color: theme.text, fontSize: 13, flexShrink: 1 },

  updateBox: {
    marginTop: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.sm,
    backgroundColor: theme.surfaceAlt,
    gap: spacing.sm,
  },
  updateText: { color: theme.text, fontSize: 14, fontWeight: '600' },

  smallButton: {
    minHeight: TAP_TARGET,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    backgroundColor: theme.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  smallLabel: { color: theme.text, fontSize: 14, fontWeight: '600' },
  smallDanger: { color: theme.danger },

  signOutWrap: { padding: spacing.md, paddingTop: spacing.xl },
  signOut: {
    minHeight: TAP_TARGET,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.danger,
    alignItems: 'center',
    justifyContent: 'center',
  },
  signOutLabel: { color: theme.danger, fontSize: 15, fontWeight: '600' },
});
