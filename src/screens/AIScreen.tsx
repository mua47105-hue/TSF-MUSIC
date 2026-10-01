/**
 * AI screen — the stack route to the MINDBEAT Wire (v4.0).
 * The Wire is the single generator surface now (also the 4th tab);
 * this wrapper keeps the legacy "AI" deep links alive with a back
 * header, rendering the exact same PULSE dispatch desk.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { MindbeatWireScreen } from './MindbeatWireScreen';
import { Brutal } from '../components/Brutal';
import { colors } from '../theme';
import type { RootStackParamList } from './navigation';

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
        <MindbeatWireScreen />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.paper },
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
