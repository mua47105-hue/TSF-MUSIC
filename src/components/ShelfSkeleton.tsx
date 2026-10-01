import React from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { colors } from '../theme';

/** Shimmering placeholder blocks for home shelves while charts load. */
export function ShelfSkeleton() {
  const opacity = React.useRef(new Animated.Value(0.35)).current;

  React.useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.7, duration: 700, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.35, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);

  return (
    <View style={styles.wrap}>
      {[0, 1].map((row) => (
        <View key={row} style={styles.row}>
          {[0, 1, 2].map((i) => (
            <Animated.View key={i} style={[styles.block, { opacity }]} />
          ))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 18, gap: 13, marginBottom: 16 },
  row: { flexDirection: 'row', gap: 13 },
  block: {
    width: 150,
    height: 150,
    borderWidth: 1.5,
    borderColor: colors.ink,
    backgroundColor: colors.paper2,
  },
});
