import { useEffect } from 'react';
import { ActivityIndicator, View, StyleSheet } from 'react-native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SessionProvider, useSession } from '../src/session';
import { theme } from '../src/theme';

/**
 * The shell: the session provider, and the one rule that decides whether
 * somebody is looking at the sign-in screen or at their channels.
 *
 * A `Stack` rather than a drawer. A drawer is the more obvious shape for a
 * chat client and is what this should probably become -- but it brings
 * `react-native-reanimated` and `react-native-gesture-handler` with it, and
 * every native module in the tree is one more thing that can go wrong in the
 * first Gradle build on a machine that has never built an Android app. A stack
 * of two screens needs none of that, and the back gesture people already use
 * does the navigating.
 */

function Gate() {
  const { me, loading } = useSession();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    // Nothing is decided until the stored token has been read and checked.
    // Redirecting during that window flashes the sign-in screen at somebody
    // who is already signed in, every single launch.
    if (loading) return;

    const onSignIn = segments[0] === 'sign-in';

    if (!me && !onSignIn) router.replace('/sign-in');
    else if (me && onSignIn) router.replace('/');
  }, [me, loading, segments, router]);

  if (loading) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color={theme.accent} />
      </View>
    );
  }

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: theme.surface },
        headerTintColor: theme.text,
        headerTitleStyle: { fontWeight: '600' },
        contentStyle: { backgroundColor: theme.bg },
        // The back gesture is the primary way out of a channel, so it stays on
        // even where a header button also exists.
        gestureEnabled: true,
      }}
    >
      <Stack.Screen name="index" options={{ title: 'Channels' }} />
      <Stack.Screen name="sign-in" options={{ headerShown: false }} />
      <Stack.Screen name="channel/[id]" options={{ title: '' }} />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <SessionProvider>
        {/* No `backgroundColor`: with edge-to-edge on, Android draws the app
            behind the status bar and the property was removed rather than
            silently ignored. The bar's backdrop is whatever is underneath it,
            which is why the screens below own their own safe-area padding. */}
        <StatusBar style="light" />
        <Gate />
      </SessionProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.bg,
  },
});
