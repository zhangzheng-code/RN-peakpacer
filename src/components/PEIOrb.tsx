import React, { useEffect, useMemo, useRef } from 'react';
import { View, Text, Animated, Easing } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useHikeStore } from '../store/useHikeStore';
import { calculatePEI, getPEIColor, getPEILabel } from '../utils/healthCalculator';

const LEVEL_CONFIG = {
  safe: { scale: 1.08, duration: 2000 },
  warning: { scale: 1.12, duration: 1200 },
  danger: { scale: 1.15, duration: 500 },
} as const;

export default function PEIOrb() {
  const insets = useSafeAreaInsets();
  const { profile, biometrics, elevationGain } = useHikeStore();

  const peiResult = useMemo(
    () => calculatePEI(profile, biometrics, elevationGain, 0.3),
    [profile, biometrics, elevationGain],
  );

  const peiColor = useMemo(() => getPEIColor(peiResult.level), [peiResult.level]);
  const peiLabel = useMemo(() => getPEILabel(peiResult.level), [peiResult.level]);
  const config = LEVEL_CONFIG[peiResult.level];

  const scaleAnim = useRef(new Animated.Value(1)).current;
  const animRef = useRef<Animated.CompositeAnimation | null>(null);

  useEffect(() => {
    animRef.current?.stop();
    animRef.current = Animated.loop(
      Animated.sequence([
        Animated.timing(scaleAnim, {
          toValue: config.scale,
          duration: config.duration,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(scaleAnim, {
          toValue: 1,
          duration: config.duration,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    animRef.current.start();
    return () => { animRef.current?.stop(); };
  }, [peiResult.level, config.scale, config.duration]);

  return (
    <View
      style={{ position: 'absolute', left: 16, top: insets.top + 90, zIndex: 20, alignItems: 'center' }}
    >
      <Animated.View
        style={{
          width: 72,
          height: 72,
          borderRadius: 36,
          backgroundColor: 'rgba(255,255,255,0.85)',
          borderWidth: 3,
          borderColor: peiColor,
          alignItems: 'center',
          justifyContent: 'center',
          shadowColor: peiColor,
          shadowOffset: { width: 0, height: 2 },
          shadowOpacity: 0.3,
          shadowRadius: 12,
          elevation: 8,
          transform: [{ scale: scaleAnim }],
        }}
      >
        <Text style={{ fontSize: 22, fontWeight: '800', color: peiColor, includeFontPadding: false }}>
          {peiResult.value}
        </Text>
        <Text style={{ fontSize: 9, fontWeight: '600', color: peiColor, opacity: 0.8, includeFontPadding: false }}>
          PEI
        </Text>
      </Animated.View>

      <Text style={{ fontSize: 12, fontWeight: '600', color: peiColor, marginTop: 4, textAlign: 'center' }}>
        {peiLabel}
      </Text>
    </View>
  );
}
