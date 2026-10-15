/**
 * AI screen — the stack route to the MINDBEAT Wire (v4.0).
 * The Wire is the single generator surface now (also the 4th tab);
 * this wrapper keeps the legacy "AI" deep links alive with a back
 * header, rendering the exact same PULSE dispatch desk.
 */

import React, { Suspense } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { Brutal } from '../components/Brutal';
import { colors } from '../theme';
import type { RootStackParamList } from './navigation';

// v5.2.1 FIX-D3: the Wire rides a LAZY import here too — the static import
// pulled the whole MindbeatWireScreen chunk into the eager bundle and
// defeated the Wave A A3 split for this deep-link route.
const MindbeatWireScreen = React.lazy(() =>
  import('./MindbeatWireScreen').then((m) => ({ default: m.MindbeatWireScreen })),
);

export function AIScreen() {
  const insets = useSafeAreaInsets();
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  return (
    <View style={styles.root}>
      <View style={[styles.backBar, { paddingTop: insets.top + 6 }]}>
        <Brutal haptic shadow={0} pressOffset={1} onPress={() => nav.goBack()} style={styles.chevBtn}>
          <Ionicons name="chevron-back" size={16} color={colors.ink} />
        </Brutal>
      </View>
      <View style={{ flex: 1, paddingTop: insets.top - 2 }}>
        <Suspense
          fallback={
            <View style={styles.fallback}>
              <ActivityIndicator size="large" color={colors.orange} />
            </View>
          }
        >
          <MindbeatWireScreen />
        </Suspense>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.paper },
  fallback: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  backBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    zIndex: 10,
    paddingHorizontal: 18,
    paddingBottom: 6,
    alignItems: 'flex-start',
  },
  chevBtn: {
    width: 38,
    height: 38,
    borderWidth: 2,
    borderColor: colors.ink,
    backgroundColor: colors.paper,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
