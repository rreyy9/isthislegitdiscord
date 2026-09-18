import { useEffect } from 'react';
import { ActivityIndicator, View, StyleSheet } from 'react-native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { DrawerProvider } from '../src/components/Drawer';
import { ImageViewerProvider } from '../src/components/ImageViewer';
import { MentionNotice } from '../src/components/Banners';
import { SessionProvider, useSession } from '../src/session';
import { theme } from '../src/theme';

/**
 * The shell: the providers, and the one rule that decides whether somebody is
 * looking at the sign-in screen or at their channels.
 *
 * A `Stack` with a drawer *over* it, rather than `expo-router`'s drawer
 * navigator. That navigator wants `react-native-gesture-handler` and
 * `react-native-reanimated`, and the first of those is excluded from this app's
 * native build on purpose -- its C++ codegen produces object-file paths past the
 * 260 characters ninja refuses. See the note in package.json, and the one atop
 * `components/Drawer.tsx` for what the hand-rolled panel costs instead.
 *
 * Three providers, in an order that is not arbitrary:
 *
 * - `SessionProvider` outermost, because everything below reads from it.
 * - `ImageViewerProvider` next, so the lightbox is above every screen. A modal
 *   opened from inside a message row would be a modal inside an inverted
 *   `FlatList` cell, which is upside down.
 * - `DrawerProvider` innermost, so its panel draws over the navigator -- and so
 *   a picture opened from the member list is still above the drawer.
 */

function Gate() {
  const { me, loading } = useSession();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    // Nothing is decided until the stored token has been read and checked.
    // Redirecting during that window flashes the sign-in screen at somebody who
    // is already signed in, every single launch.
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
    <>
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: theme.surface },
          headerTintColor: theme.text,
          headerTitleStyle: { fontWeight: '600' },
          contentStyle: { backgroundColor: theme.bg },
          // The back gesture is still the primary way out of a channel, so it
          // stays on even where the header carries the menu button instead of
          // an arrow.
          gestureEnabled: true,
        }}
      >
        <Stack.Screen name="index" options={{ title: 'Channels' }} />
        <Stack.Screen name="sign-in" options={{ headerShown: false }} />
        <Stack.Screen name="channel/[id]" options={{ title: '' }} />
        <Stack.Screen name="settings" options={{ title: 'Settings' }} />
        <Stack.Screen name="search" options={{ title: 'Search' }} />
      </Stack>

      {/* Above the navigator rather than inside a screen: a tag can arrive
          while any of them is open, and a strip that belonged to one screen
          would vanish the moment somebody navigated. */}
      <MentionNotice />
    </>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <SessionProvider>
        <ImageViewerProvider>
          <DrawerProvider>
            {/* No `backgroundColor`: with edge-to-edge on, Android draws the app
                behind the status bar and the property was removed rather than
                silently ignored. The bar's backdrop is whatever is underneath
                it, which is why the screens below own their own safe-area
                padding. */}
            <StatusBar style="light" />
            <Gate />
          </DrawerProvider>
        </ImageViewerProvider>
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
