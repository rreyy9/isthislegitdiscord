import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api, ApiError } from '../src/api';
import { useSession } from '../src/session';
import { normaliseServerUrl, store } from '../src/store';
import { CLIENT_VERSION } from '../src/version';
import { radius, spacing, TAP_TARGET, theme } from '../src/theme';

/**
 * Sign in, or redeem an invite.
 *
 * The server address is a field, not a constant, because this is a
 * self-hosted application and the whole point is that somebody else can run
 * one. It is prefilled with the last server used, falling back to the
 * deployment most people will want, so the common case is two fields and a
 * button -- or, once remembered, just the button.
 *
 * "Check" is separate from "Sign in" on purpose. A wrong address and a wrong
 * password fail at the same moment and look identical, and the address is the
 * one somebody has no way to verify by memory -- so there is a button that
 * asks the server whether it is there, and answers in the field that would be
 * wrong.
 *
 * "Remember me" keeps the username and password in the keystore so the screen
 * comes back filled in. It is not a second way of staying signed in -- the
 * token already does that, for thirty days -- it is what makes the day the
 * token lapses a single tap instead of a password typed on a phone keyboard.
 * Which is also why it survives Sign out: signing out here means "not right
 * now", not "forget me", and there is a tick box for the second thing.
 */

type Mode = 'sign-in' | 'register';

export default function SignIn() {
  const { signIn, register, serverUrl: sessionServerUrl } = useSession();
  const insets = useSafeAreaInsets();

  const [mode, setMode] = useState<Mode>('sign-in');
  // The address the session already loaded from the store, not the compiled-in
  // default: after a sign-out the field should still say where you were.
  const [serverUrl, setServerUrl] = useState(sessionServerUrl);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [remember, setRemember] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reachable, setReachable] = useState<string | null>(null);

  /**
   * Fill the form from whatever was remembered.
   *
   * The guard matters: reading the keystore is a round trip, and somebody who
   * started typing during it is signing in as somebody else. Their keystrokes
   * win.
   */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const saved = await store.getLogin();
      if (!saved || cancelled) return;
      setRemember(true);
      setUsername((current) => (current ? current : saved.username));
      setPassword((current) => (current ? current : saved.password));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Unticking deletes the stored password now rather than at the next sign-in,
   * which may never come. A box that says it has forgotten something it is
   * still holding is the one behaviour this feature must not have.
   */
  function toggleRemember() {
    const next = !remember;
    setRemember(next);
    if (!next) void store.clearLogin();
  }

  const insecure = /^http:\/\//i.test(serverUrl.trim());

  async function check() {
    setBusy(true);
    setError(null);
    setReachable(null);
    try {
      await api.health(normaliseServerUrl(serverUrl));
      setReachable('That server answered.');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    setBusy(true);
    setError(null);
    setReachable(null);
    try {
      if (mode === 'sign-in') {
        await signIn(serverUrl, username.trim(), password);
      } else {
        await register(serverUrl, {
          username: username.trim(),
          password,
          inviteCode: inviteCode.trim().toUpperCase(),
        });
      }
      // Only after the server has accepted them. Remembering a rejected
      // password means a prefilled form that fails every time it is used.
      if (remember) {
        await store.setLogin({ username: username.trim(), password });
      } else {
        await store.clearLogin();
      }
      // No navigation here: the gate in _layout.tsx watches the session and
      // moves once `me` is set. Routing from both places is how you get two
      // transitions and a screen that flashes.
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const canSubmit =
    !busy &&
    username.trim().length > 0 &&
    password.length > 0 &&
    (mode === 'sign-in' || inviteCode.trim().length > 0);

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          { paddingTop: insets.top + spacing.xl, paddingBottom: insets.bottom + spacing.xl },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.title}>isthislegit</Text>
        <Text style={styles.subtitle}>
          {mode === 'sign-in' ? 'Sign in to your server' : 'Redeem an invite'}
        </Text>

        <Field label="Server">
          <TextInput
            style={styles.input}
            value={serverUrl}
            onChangeText={setServerUrl}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            placeholder="https://example.duckdns.org"
            placeholderTextColor={theme.textFaint}
          />
          <Pressable onPress={check} disabled={busy} hitSlop={8} style={styles.check}>
            <Text style={styles.checkLabel}>Check</Text>
          </Pressable>
        </Field>

        {insecure && (
          <Text style={styles.warning}>
            This address is plain http://. Your password and messages travel
            unencrypted — fine on your own network, not over the internet.
          </Text>
        )}

        <Field label="Username">
          <TextInput
            style={styles.input}
            value={username}
            onChangeText={setUsername}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="username"
            textContentType="username"
          />
        </Field>

        <Field label="Password">
          <TextInput
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoCapitalize="none"
            autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
            onSubmitEditing={() => canSubmit && submit()}
            returnKeyType="go"
          />
        </Field>

        {mode === 'register' && (
          <Field label="Invite code">
            <TextInput
              style={styles.input}
              value={inviteCode}
              onChangeText={setInviteCode}
              autoCapitalize="characters"
              autoCorrect={false}
            />
          </Field>
        )}

        <Pressable
          onPress={toggleRemember}
          style={styles.remember}
          hitSlop={8}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: remember }}
          accessibilityLabel="Remember me"
        >
          <View style={[styles.box, remember && styles.boxChecked]}>
            {remember && <Text style={styles.tick}>✓</Text>}
          </View>
          <Text style={styles.rememberLabel}>
            Remember me on this phone
          </Text>
        </Pressable>

        {error && <Text style={styles.error}>{error}</Text>}
        {reachable && <Text style={styles.ok}>{reachable}</Text>}

        <Pressable
          onPress={submit}
          disabled={!canSubmit}
          style={({ pressed }) => [
            styles.submit,
            !canSubmit && styles.submitDisabled,
            pressed && canSubmit && styles.submitPressed,
          ]}
        >
          {busy ? (
            <ActivityIndicator color={theme.accentText} />
          ) : (
            <Text style={styles.submitLabel}>
              {mode === 'sign-in' ? 'Sign in' : 'Create account'}
            </Text>
          )}
        </Pressable>

        <Pressable
          onPress={() => {
            setMode(mode === 'sign-in' ? 'register' : 'sign-in');
            setError(null);
            setReachable(null);
          }}
          hitSlop={8}
          style={styles.switch}
        >
          <Text style={styles.switchLabel}>
            {mode === 'sign-in'
              ? 'Have an invite code? Create an account'
              : 'Already have an account? Sign in'}
          </Text>
        </Pressable>

        <Text style={styles.version}>Version {CLIENT_VERSION}</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.fieldRow}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: theme.bg },
  scroll: {
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
  },
  title: {
    color: theme.text,
    fontSize: 30,
    fontWeight: '700',
    textAlign: 'center',
  },
  subtitle: {
    color: theme.textMuted,
    fontSize: 14,
    textAlign: 'center',
    marginBottom: spacing.lg,
  },
  field: { gap: spacing.xs },
  fieldRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  label: {
    color: theme.textMuted,
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  input: {
    flex: 1,
    minHeight: TAP_TARGET,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    backgroundColor: theme.surfaceAlt,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    color: theme.text,
    fontSize: 15,
  },
  check: {
    height: TAP_TARGET,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    backgroundColor: theme.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkLabel: { color: theme.textMuted, fontSize: 13, fontWeight: '600' },
  remember: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    // The row is the tap target, not the 22pt square drawn inside it.
    minHeight: TAP_TARGET,
  },
  box: {
    width: 22,
    height: 22,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxChecked: { backgroundColor: theme.accent, borderColor: theme.accent },
  tick: {
    color: theme.accentText,
    fontSize: 14,
    fontWeight: '700',
    lineHeight: 16,
  },
  rememberLabel: { color: theme.text, fontSize: 14 },
  warning: {
    color: theme.warning,
    fontSize: 12,
    lineHeight: 17,
  },
  error: { color: theme.danger, fontSize: 13, lineHeight: 18 },
  ok: { color: theme.online, fontSize: 13 },
  submit: {
    minHeight: TAP_TARGET + 4,
    borderRadius: radius.md,
    backgroundColor: theme.accent,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.sm,
  },
  submitDisabled: { backgroundColor: theme.surfaceAlt },
  submitPressed: { opacity: 0.8 },
  submitLabel: { color: theme.accentText, fontSize: 16, fontWeight: '700' },
  switch: { alignItems: 'center', paddingVertical: spacing.sm },
  switchLabel: { color: theme.accent, fontSize: 13 },
  version: {
    color: theme.textFaint,
    fontSize: 11,
    textAlign: 'center',
    marginTop: spacing.lg,
  },
});
