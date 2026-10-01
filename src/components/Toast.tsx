/**
 * Toast — PULSE ink bar notification: hard orange shadow, mono
 * uppercase text with the acid accent. Sits above the mini player,
 * auto-dismisses with a rise+fade.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { colors, fonts, orangeShadow } from '../theme';

type IconName = keyof typeof Ionicons.glyphMap;

interface ToastSpec {
  message: string;
  icon?: IconName;
  duration?: number;
}

interface ToastContextValue {
  show: (spec: ToastSpec) => void;
}

const ToastContext = createContext<ToastContextValue>({ show: () => undefined });

export function useToast(): ToastContextValue {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastSpec | null>(null);
  const anim = useRef(new Animated.Value(0)).current;
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const insets = useSafeAreaInsets();

  const hide = useCallback(() => {
    Animated.timing(anim, {
      toValue: 0,
      duration: 220,
      useNativeDriver: true,
    }).start(() => setToast(null));
  }, [anim]);

  const show = useCallback(
    (spec: ToastSpec) => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      setToast(spec);
      Animated.spring(anim, {
        toValue: 1,
        speed: 20,
        bounciness: 8,
        useNativeDriver: true,
      }).start();
      hideTimer.current = setTimeout(hide, spec.duration ?? 2200);
    },
    [anim, hide],
  );

  useEffect(() => {
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, []);

  const translateY = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [60, 0],
  });

  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      {toast ? (
        <Animated.View
          pointerEvents="none"
          style={[styles.wrap, { bottom: 148 + insets.bottom, opacity: anim, transform: [{ translateY }] }]}
        >
          <View style={styles.pill}>
            {toast.icon ? (
              <Ionicons name={toast.icon} size={17} color={colors.accentDeep} />
            ) : null}
            <Text style={styles.text} numberOfLines={2}>
              {toast.message}
            </Text>
          </View>
        </Animated.View>
      ) : null}
    </ToastContext.Provider>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 18,
    right: 18,
    alignItems: 'center',
    zIndex: 100,
    elevation: 30,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.ink,
    paddingHorizontal: 17,
    paddingVertical: 11,
    maxWidth: 340,
    ...orangeShadow(3),
  },
  text: {
    color: colors.onInk,
    fontSize: 11,
    fontFamily: fonts.monoBold,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    flexShrink: 1,
  },
});
