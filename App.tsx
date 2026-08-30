import React from 'react';
import { StyleSheet, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Font from 'expo-font';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Ionicons } from '@expo/vector-icons';
import { PlayerProvider } from './src/player/PlayerProvider';
import { ToastProvider } from './src/components/Toast';
import { MiniPlayer } from './src/components/MiniPlayer';
import { HomeScreen } from './src/screens/HomeScreen';
import { SearchScreen } from './src/screens/SearchScreen';
import { AIScreen } from './src/screens/AIScreen';
import { LibraryScreen } from './src/screens/LibraryScreen';
import { PremiumScreen } from './src/screens/PremiumScreen';
import { CollectionScreen } from './src/screens/CollectionScreen';
import { PlaylistScreen } from './src/screens/PlaylistScreen';
import { StatsScreen } from './src/screens/StatsScreen';
import { TasteScreen } from './src/screens/TasteScreen';
import { PlayerScreen } from './src/screens/PlayerScreen';
import { DynamicThemeProvider } from './src/theme/DynamicThemeProvider';
import { WhatsNewDialog } from './src/components/WhatsNewDialog';
import { Onboarding } from './src/components/Onboarding';
import type { RootStackParamList, TabParamList } from './src/screens/navigation';
import { colors } from './src/theme';

const navTheme = {
  ...DefaultTheme,
  dark: true,
  colors: {
    ...DefaultTheme.colors,
    primary: colors.accentBright,
    background: colors.bg,
    card: colors.bg,
    text: colors.text,
    border: colors.border,
    notification: colors.accent,
  },
};

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator<TabParamList>();

/**
 * Tabs — authentic Spotify Android shell: full-width pure-black bottom bar
 * (4 tabs incl. Premium), content on #121212, mini player card floating
 * above the bar. Bar height is insets-aware so gesture-nav devices (and
 * any future edge-to-edge mode) get the labels lifted clear of the system
 * nav area instead of colliding with it.
 */
function TabsScreen() {
  const insets = useSafeAreaInsets();
  return (
    <View style={styles.tabsWrap}>
      <Tab.Navigator
        screenOptions={({ route }) => ({
          headerShown: false,
          sceneContainerStyle: { backgroundColor: colors.bg },
          tabBarActiveTintColor: colors.text,
          tabBarInactiveTintColor: colors.inactiveTab,
          tabBarTestID: `tab-${route.name.toLowerCase()}`,
          tabBarStyle: {
            backgroundColor: colors.bgDeep, // Spotify: pure black bar
            borderTopWidth: 0,
            elevation: 0,
            height: 58 + insets.bottom,
            paddingBottom: 6 + insets.bottom,
            paddingTop: 4,
          },
          tabBarLabelStyle: styles.tabLabel,
          tabBarIcon: ({ color, focused }) => {
            if (route.name === 'Premium') return <SpotifyMark size={22} color={color} />;
            const icons: Record<string, keyof typeof Ionicons.glyphMap> = {
              Home: focused ? 'home' : 'home-outline',
              Search: 'search',
              Library: focused ? 'library' : 'library-outline',
            };
            return <Ionicons name={icons[route.name] ?? 'home'} size={23} color={color} />;
          },
        })}
      >
        <Tab.Screen name="Home" component={HomeScreen} options={{ tabBarLabel: 'Home' }} />
        <Tab.Screen name="Search" component={SearchScreen} options={{ tabBarLabel: 'Search' }} />
        <Tab.Screen
          name="Library"
          component={LibraryScreen}
          options={{ tabBarLabel: 'Your Library' }}
        />
        <Tab.Screen
          name="Premium"
          component={PremiumScreen}
          options={{ tabBarLabel: 'Premium' }}
        />
      </Tab.Navigator>
      {/* Spotify mini player: rounded #282828 card floating above the bar
          (offset mirrors the insets-aware bar height above) */}
      <View style={[styles.miniWrap, { bottom: 58 + insets.bottom + 6 }]}>
        <MiniPlayer />
      </View>
    </View>
  );
}

/** Spotify-style logo mark for the Premium tab (circle + 3 arcs). */
function SpotifyMark({ size, color }: { size: number; color: string }) {
  const barW = [size * 0.52, size * 0.38, size * 0.26];
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        alignItems: 'center',
        justifyContent: 'center',
        gap: Math.max(1.5, size * 0.09),
      }}
    >
      {barW.map((w, i) => (
        <View
          key={i}
          style={{
            width: w,
            height: Math.max(1.6, size * 0.11),
            borderRadius: 99,
            backgroundColor: color,
            alignSelf: 'center',
          }}
        />
      ))}
    </View>
  );
}

export default function App() {
  const [fontsReady, setFontsReady] = React.useState(false);

  React.useEffect(() => {
    Font.loadAsync({
      'Figtree-400': require('./assets/fonts/Figtree-400.ttf'),
      'Figtree-500': require('./assets/fonts/Figtree-500.ttf'),
      'Figtree-600': require('./assets/fonts/Figtree-600.ttf'),
      'Figtree-700': require('./assets/fonts/Figtree-700.ttf'),
      'Figtree-800': require('./assets/fonts/Figtree-800.ttf'),
      'Figtree-900': require('./assets/fonts/Figtree-900.ttf'),
    })
      .then(() => setFontsReady(true))
      .catch(() => setFontsReady(true)); // render with system font if load fails
  }, []);

  if (!fontsReady) return null;

  return (
    <SafeAreaProvider>
      <ToastProvider>
        <PlayerProvider>
          <DynamicThemeProvider>
            <NavigationContainer theme={navTheme}>
              <StatusBar style="light" backgroundColor={colors.bg} />
              <WhatsNewDialog />
              <Onboarding onDone={() => undefined} />
              <Stack.Navigator
                screenOptions={{
                  headerShown: false,
                  contentStyle: { backgroundColor: colors.bg },
                }}
              >
                <Stack.Screen name="Tabs" component={TabsScreen} />
                <Stack.Screen
                  name="Collection"
                  component={CollectionScreen}
                  options={{ animation: 'slide_from_right' }}
                />
                <Stack.Screen
                  name="Playlist"
                  component={PlaylistScreen}
                  options={{ animation: 'slide_from_right' }}
                />
                <Stack.Screen
                  name="Stats"
                  component={StatsScreen}
                  options={{ animation: 'slide_from_right' }}
                />
                <Stack.Screen
                  name="Taste"
                  component={TasteScreen}
                  options={{ animation: 'slide_from_right' }}
                />
                <Stack.Screen
                  name="AI"
                  component={AIScreen}
                  options={{ animation: 'slide_from_right' }}
                />
                <Stack.Screen
                  name="Player"
                  component={PlayerScreen}
                  options={{ presentation: 'modal', animation: 'slide_from_bottom' }}
                />
              </Stack.Navigator>
            </NavigationContainer>
          </DynamicThemeProvider>
        </PlayerProvider>
      </ToastProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  tabsWrap: { flex: 1, backgroundColor: colors.bg },
  tabLabel: { fontSize: 10, fontFamily: 'Figtree-500', letterSpacing: 0.2 },
  miniWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    zIndex: 20,
    elevation: 12,
  },
});
