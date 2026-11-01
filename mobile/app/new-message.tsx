import { useLayoutEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useNavigation, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ApiError } from '../src/api';
import { Avatar } from '../src/components/Avatar';
import { Icon } from '../src/components/Icon';
import { useSession } from '../src/session';
import { radius, spacing, TAP_TARGET, theme } from '../src/theme';

/** People in a group, counting yourself. Mirrors `MAX_GROUP_DM`. */
const MAX_GROUP = 10;

/**
 * Pick who to message. One person opens your DM with them; more than one
 * starts a group.
 */
export default function NewMessage() {
  const { me, members, onlineIds, openDm } = useSession();
  const router = useRouter();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const people = useMemo(() => {
    const q = query.trim().toLowerCase();
    const seen = new Set<string>();
    return members
      .filter((m) => m.user.id !== me?.id && !seen.has(m.user.id) && seen.add(m.user.id))
      .filter(
        (m) =>
          !q ||
          m.user.username.toLowerCase().includes(q) ||
          (m.user.displayName ?? '').toLowerCase().includes(q),
      )
      .sort((a, b) =>
        (a.user.displayName || a.user.username).localeCompare(
          b.user.displayName || b.user.username,
        ),
      );
  }, [members, me?.id, query]);

  async function start() {
    if (picked.length === 0 || busy) return;
    setBusy(true);
    try {
      const dm = await openDm(picked);
      router.replace(`/channel/${dm.channelId}` as never);
    } catch (e) {
      setBusy(false);
      Alert.alert(
        'That conversation could not be opened',
        e instanceof ApiError ? e.message : 'Check the connection and try again.',
      );
    }
  }

  useLayoutEffect(() => {
    navigation.setOptions({
      headerTitle: 'New message',
      headerRight: () =>
        busy ? (
          <ActivityIndicator color={theme.accent} style={styles.headerButton} />
        ) : (
          <Pressable
            onPress={() => void start()}
            disabled={picked.length === 0}
            hitSlop={12}
            style={styles.headerButton}
            accessibilityRole="button"
          >
            <Text style={[styles.go, picked.length === 0 && styles.goOff]}>
              {picked.length >= 2 ? 'Create' : 'Open'}
            </Text>
          </Pressable>
        ),
    });
  });

  const toggle = (id: string) =>
    setPicked((current) =>
      current.includes(id)
        ? current.filter((x) => x !== id)
        : current.length >= MAX_GROUP - 1
          ? current
          : [...current, id],
    );

  return (
    <View style={styles.flex}>
      <View style={styles.searchWrap}>
        <Icon name="magnify" size={18} color={theme.textFaint} />
        <TextInput
          style={styles.search}
          value={query}
          onChangeText={setQuery}
          placeholder="Find someone"
          placeholderTextColor={theme.textFaint}
          autoFocus
        />
      </View>
      <FlatList
        data={people}
        keyExtractor={(m) => m.user.id}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item: m }) => {
          const on = picked.includes(m.user.id);
          const name = m.user.displayName || m.user.username;
          return (
            <Pressable
              style={({ pressed }) => [styles.row, (pressed || on) && styles.rowOn]}
              onPress={() => toggle(m.user.id)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on }}
            >
              <Avatar
                userId={m.user.id}
                name={name}
                image={m.user.image}
                size={38}
                online={onlineIds.has(m.user.id)}
              />
              <View style={styles.rowText}>
                <Text style={styles.name} numberOfLines={1}>
                  {name}
                </Text>
                <Text style={styles.handle} numberOfLines={1}>
                  @{m.user.username}
                </Text>
              </View>
              <Icon
                name={on ? 'checkbox-marked-circle' : 'checkbox-blank-circle-outline'}
                size={24}
                color={on ? theme.accent : theme.textFaint}
              />
            </Pressable>
          );
        }}
      />
      <Text style={[styles.note, { paddingBottom: insets.bottom + spacing.md }]}>
        🔒 Direct messages are end-to-end encrypted. Only the people in the conversation can
        read them.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: theme.bg },
  headerButton: {
    minWidth: TAP_TARGET,
    height: TAP_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
  },
  go: { color: theme.accent, fontSize: 16, fontWeight: '700' },
  goOff: { color: theme.textFaint },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    margin: spacing.md,
    paddingHorizontal: spacing.md,
    backgroundColor: theme.surfaceAlt,
    borderRadius: radius.md,
  },
  search: { flex: 1, color: theme.text, fontSize: 15, paddingVertical: spacing.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  rowOn: { backgroundColor: theme.surfaceAlt },
  rowText: { flex: 1, minWidth: 0 },
  name: { color: theme.text, fontSize: 15, fontWeight: '600' },
  handle: { color: theme.textFaint, fontSize: 12 },
  note: {
    color: theme.textFaint,
    fontSize: 12,
    textAlign: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
});
