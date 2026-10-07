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
import { MindbeatWireScreen } from './src/screens/MindbeatWireScreen';
import { LibraryScreen } from './src/screens/LibraryScreen';
import { PremiumScreen } from './src/screens/PremiumScreen';
import { CollectionScreen } from './src/screens/CollectionScreen';
import { PlaylistScreen } from './src/screens/PlaylistScreen';
import { StatsScreen } from './src/screens/StatsScreen';
import { TasteScreen } from './src/screens/TasteScreen';
import { AIScreen } from './src/screens/AIScreen';
import { PlayerScreen } from './src/screens/PlayerScreen';
import { DynamicThemeProvider } from './src/theme/DynamicThemeProvider';
import { WhatsNewDialog } from './src/components/WhatsNewDialog';
import { Onboarding } from './src/components/Onboarding';
import { MonoText } from './src/components/Brutal';
import type { RootStackParamList, TabParamList } from './src/screens/navigation';
import { colors } from './src/theme';
import { perfMark } from './src/perf/perf';

perfMark('js-boot');

const navTheme = {
  ...DefaultTheme,
  dark: false,
  colors: {
    ...DefaultTheme.colors,
    primary: colors.ink,
    background: colors.paper,
    card: colors.paper,
    text: colors.ink,
    border: colors.ink,
    notification: colors.orange,
  },
};

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator<TabParamList>();

/* Tab icons — 1.9px stroke line glyphs, squared. */
const TAB_ICONS: Record<string, keyof typeof Ionicons.glyphMap> = {
  Home: 'home-outline',
  Search: 'search-outline',
  Library: 'library-outline',
  Wire: 'sparkles-outline',
};

/**
 * Tabs — the PULSE broadsheet shell: paper bar with a 2px ink top
 * border, Space Mono uppercase labels, orange navdot under the active
 * tab. Front · Index · Crates · Wire. Mini player (ink bar) floats
 * above.
 */
function TabsScreen() {
  const insets = useSafeAreaInsets();
  return (
    <View style={styles.tabsWrap}>
      <Tab.Navigator
        screenOptions={({ route }) => ({
          headerShown: false,
          sceneContainerStyle: { backgroundColor: colors.paper },
          tabBarActiveTintColor: colors.ink,
          tabBarInactiveTintColor: colors.ink40,
          tabBarTestID: `tab-${route.name.toLowerCase()}`,
          tabBarStyle: {
            backgroundColor: colors.paper,
            borderTopWidth: 2,
            borderTopColor: colors.ink,
            elevation: 0,
            height: 66 + insets.bottom,
            paddingBottom: 8 + insets.bottom,
            paddingTop: 6,
          },
          tabBarLabel: ({ focused, color }) => (
            <View style={styles.tabLabelWrap}>
              <MonoText size={9.5} bold color={focused ? colors.ink : colors.ink40} style={{ letterSpacing: 1.2 }}>
                {TAB_LABELS[route.name] ?? route.name}
              </MonoText>
              {focused ? <View style={styles.navdot} /> : null}
            </View>
          ),
          tabBarIcon: ({ color }) => (
            <Ionicons name={TAB_ICONS[route.name] ?? 'home-outline'} size={20} color={color} />
          ),
        })}
      >
        <Tab.Screen name="Home" component={HomeScreen} />
        <Tab.Screen name="Search" component={SearchScreen} />
        <Tab.Screen name="Library" component={LibraryScreen} />
        <Tab.Screen name="Wire" component={MindbeatWireScreen} />
      </Tab.Navigator>
      {/* PULSE mini player: ink bar floating above the tab bar */}
      <View style={[styles.miniWrap, { bottom: 66 + insets.bottom + 6 }]}>
        <MiniPlayer />
      </View>
    </View>
  );
}

const TAB_LABELS: Record<string, string> = {
  Home: 'Front',
  Search: 'Index',
  Library: 'Crates',
  Wire: 'Wire',
};

export default function App() {
  const [fontsReady, setFontsReady] = React.useState(false);

  React.useEffect(() => {
    Font.loadAsync({
      'Archivo-400': require('./assets/fonts/Archivo-400.ttf'),
      'Archivo-500': require('./assets/fonts/Archivo-500.ttf'),
      'Archivo-600': require('./assets/fonts/Archivo-600.ttf'),
      'Archivo-700': require('./assets/fonts/Archivo-700.ttf'),
      'ArchivoBlack-400': require('./assets/fonts/ArchivoBlack-400.ttf'),
      'SpaceMono-400': require('./assets/fonts/SpaceMono-400.ttf'),
      'SpaceMono-700': require('./assets/fonts/SpaceMono-700.ttf'),
      'Figtree-400': require('./assets/fonts/Figtree-400.ttf'),
      'Figtree-500': require('./assets/fonts/Figtree-500.ttf'),
      'Figtree-600': require('./assets/fonts/Figtree-600.ttf'),
      'Figtree-700': require('./assets/fonts/Figtree-700.ttf'),
      'Figtree-800': require('./assets/fonts/Figtree-800.ttf'),
      'Figtree-900': require('./assets/fonts/Figtree-900.ttf'),
    })
      .then(() => {
        setFontsReady(true);
        perfMark('fonts-ready');
      })
      .catch(() => {
        setFontsReady(true);
        perfMark('fonts-ready', 'fallback-fonts');
      }); // render with system font if load fails
  }, []);

  if (!fontsReady) return null;

  return (
    <SafeAreaProvider>
      <ToastProvider>
        <PlayerProvider>
          <DynamicThemeProvider>
            <NavigationContainer theme={navTheme}>
              <StatusBar style="dark" backgroundColor={colors.paper} />
              <WhatsNewDialog />
              <Onboarding onDone={() => undefined} />
              <Stack.Navigator
                screenOptions={{
                  headerShown: false,
                  contentStyle: { backgroundColor: colors.paper },
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
                  name="Premium"
                  component={PremiumScreen}
                  options={{ animation: 'slide_from_right' }}
                />
                {/* MAGNUM OPUS F19 — the genre map (seeded, deterministic).
                    LAZY on purpose: getComponent defers the module's
                    evaluation to first navigation — the cold path gains
                    the registration, never the work (bar X5). */}
                <Stack.Screen
                  name="GenreExplorer"
                  getComponent={() => require('./src/screens/GenreExplorer').GenreExplorer}
                  options={{ animation: 'slide_from_right' }}
                />
                <Stack.Screen
                  name="Player"
                  component={PlayerScreen}
                  options={{ presentation: 'fullScreenModal', animation: 'slide_from_bottom' }}
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
  tabsWrap: { flex: 1, backgroundColor: colors.paper },
  tabLabelWrap: { alignItems: 'center', marginTop: 1, minHeight: 16 },
  navdot: {
    width: 5,
    height: 5,
    backgroundColor: colors.orange,
    marginTop: 2,
  },
  miniWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    zIndex: 20,
    elevation: 12,
  },
});
