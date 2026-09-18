import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useNavigation, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api, ApiError } from '../src/api';
import { Avatar } from '../src/components/Avatar';
import { MessageContent } from '../src/components/MessageContent';
import { personName, stamp } from '../src/format';
import { useSession } from '../src/session';
import { radius, spacing, TAP_TARGET, theme } from '../src/theme';
import type { Message } from '../src/types';

/**
 * Finding a message.
 *
 * The desktop client puts this in a popover under the header, because there is a
 * header with room in it. Here it is a screen: the results are a list of
 * messages with their channel and date, each of them several lines high, and a
 * popover over a phone-sized conversation would show two of them.
 *
 * The server decides what this account may read; there is no client-side
 * filtering to forget. Results carry the channel id, and this app already holds
 * the channel list, so "in #general" is drawn without asking.
 */

/**
 * How long after the last keystroke before a search goes out.
 *
 * Longer than a desktop's would be. Every search is a request over a mobile
 * radio, and a query typed at thumb speed would otherwise fire six of them for
 * one word -- five of which are answers nobody will read.
 */
const DEBOUNCE_MS = 400;

/** Below this the server's tokeniser has nothing useful to match on. */
const MIN_QUERY = 2;

export default function Search() {
  const navigation = useNavigation();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { guilds, channelById, nameFor, me } = useSession();

  const [text, setText] = useState('');
  const [results, setResults] = useState<Message[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const input = useRef<TextInput>(null);

  useLayoutEffect(() => {
    navigation.setOptions({ title: 'Search' });
  }, [navigation]);

  // Opened to be typed in. Anything else is a screen to navigate to and then a
  // tap to focus, for a box with exactly one use.
  useEffect(() => {
    const timer = setTimeout(() => input.current?.focus(), 250);
    return () => clearTimeout(timer);
  }, []);

  const guildId = guilds[0]?.id;

  useEffect(() => {
    const query = text.trim();
    if (query.length < MIN_QUERY) {
      setResults(null);
      setError(null);
      setBusy(false);
      return;
    }

    let cancelled = false;
    setBusy(true);
    const timer = setTimeout(async () => {
      try {
        const page = await api.search({ q: query, guildId, limit: 30 });
        if (!cancelled) {
          setResults(page.results);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setResults(null);
          setError(
            e instanceof ApiError ? e.message : 'That search could not be run.',
          );
        }
      } finally {
        if (!cancelled) setBusy(false);
      }
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [text, guildId]);

  /**
   * Go to the message.
   *
   * `replace` rather than `push`: the search screen has done its job the moment
   * a result is chosen, and leaving it on the stack means the back gesture out
   * of the channel lands on a list of results nobody wants to see again.
   */
  const open = useCallback(
    (message: Message) => {
      router.replace(
        `/channel/${message.channelId}?jump=${encodeURIComponent(message.id)}` as never,
      );
    },
    [router],
  );

  const lookupMention = useCallback(
    (id: string) => {
      const name = nameFor(id);
      return name ? { name, self: id === me?.id } : null;
    },
    [nameFor, me],
  );

  return (
    <View style={styles.screen}>
      <View style={styles.searchBar}>
        <TextInput
          ref={input}
          style={styles.input}
          value={text}
          onChangeText={setText}
          placeholder="Search this server"
          placeholderTextColor={theme.textFaint}
          returnKeyType="search"
          autoCorrect={false}
          // The box holds one query and is cleared by hand far more often than
          // it is edited, so the platform's own clear button earns its place.
          clearButtonMode="while-editing"
        />
        {busy && <ActivityIndicator size="small" color={theme.textMuted} />}
      </View>

      <FlatList
        data={results ?? []}
        keyExtractor={(m) => m.id}
        contentContainerStyle={{ paddingBottom: insets.bottom + spacing.xl }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        ListEmptyComponent={
          <View style={styles.emptyBox}>
            {error ? (
              <Text style={styles.bad}>{error}</Text>
            ) : text.trim().length < MIN_QUERY ? (
              <>
                <Text style={styles.emptyMark}>🔍</Text>
                <Text style={styles.empty}>Type at least two characters.</Text>
                <Text style={styles.hint}>
                  Whole words. Quote a phrase to keep it together, and put a minus
                  in front of a word to leave it out.
                </Text>
              </>
            ) : busy ? null : results ? (
              <>
                <Text style={styles.emptyMark}>🔍</Text>
                <Text style={styles.empty}>Nothing matched “{text.trim()}”.</Text>
              </>
            ) : null}
          </View>
        }
        renderItem={({ item }) => (
          <Pressable
            onPress={() => open(item)}
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            accessibilityRole="button"
            accessibilityLabel={`Go to ${personName(item.author)}'s message`}
          >
            <Avatar
              userId={item.author.id}
              name={personName(item.author)}
              image={item.author.image}
              size={32}
            />
            <View style={styles.body}>
              <View style={styles.head}>
                <Text style={styles.author} numberOfLines={1}>
                  {personName(item.author)}
                </Text>
                {/* Which channel and when, because that is what the reader is
                    matching against -- a result stripped of its context is a
                    sentence with no way to judge whether it is the one. */}
                <Text style={styles.where}>
                  #{channelById(item.channelId)?.name ?? 'unknown'}
                </Text>
              </View>
              <Text style={styles.when}>{stamp(item.createdAt)}</Text>
              <MessageContent
                content={item.content}
                attachments={item.attachments}
                edited={Boolean(item.editedAt)}
                textOnly
                lookupMention={lookupMention}
              />
            </View>
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
  },
  input: {
    flex: 1,
    minHeight: TAP_TARGET,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    backgroundColor: theme.surfaceAlt,
    color: theme.text,
    fontSize: 15,
  },
  row: {
    flexDirection: 'row',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
  },
  rowPressed: { backgroundColor: theme.surfaceAlt },
  body: { flex: 1 },
  head: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm },
  author: { color: theme.text, fontSize: 14, fontWeight: '600', flexShrink: 1 },
  where: { color: theme.accent, fontSize: 12 },
  when: { color: theme.textFaint, fontSize: 11, marginBottom: 2 },
  emptyBox: { alignItems: 'center', paddingTop: spacing.xl * 2, paddingHorizontal: spacing.xl },
  emptyMark: { fontSize: 32, marginBottom: spacing.sm },
  empty: { color: theme.textMuted, fontSize: 15, textAlign: 'center' },
  hint: {
    color: theme.textFaint,
    fontSize: 12,
    textAlign: 'center',
    marginTop: spacing.sm,
    lineHeight: 17,
  },
  bad: { color: theme.danger, fontSize: 14, textAlign: 'center' },
});
