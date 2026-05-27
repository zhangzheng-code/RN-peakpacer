import React, { useState, useMemo, useCallback, useRef } from 'react';
import {
  View,
  Text,
  Animated,
  PanResponder,
  Dimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useHikeStore } from '../store/useHikeStore';
import { calculatePEI, getPEIColor, getPEILabel } from '../utils/healthCalculator';

const SCREEN_HEIGHT = Dimensions.get('window').height;
const COLLAPSED_HEIGHT = 64;
const EXPANDED_HEIGHT = 440;

interface SliderProps {
  value: number;
  minimumValue: number;
  maximumValue: number;
  step?: number;
  label: string;
  unit: string;
  trackColor?: string;
  onValueChange: (value: number) => void;
}

function CustomSlider({
  value,
  minimumValue,
  maximumValue,
  step = 1,
  label,
  unit,
  trackColor = '#1890ff',
  onValueChange,
}: SliderProps) {
  const [trackWidth, setTrackWidth] = useState(0);
  const percentage = (value - minimumValue) / (maximumValue - minimumValue);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {},
      onPanResponderMove: (_, gestureState) => {
        if (trackWidth <= 0) return;
        const clampedX = Math.max(0, Math.min(gestureState.moveX - 32, trackWidth));
        const ratio = clampedX / trackWidth;
        const rawValue = minimumValue + ratio * (maximumValue - minimumValue);
        const steppedValue = Math.round(rawValue / step) * step;
        const clampedValue = Math.max(minimumValue, Math.min(maximumValue, steppedValue));
        onValueChange(clampedValue);
      },
      onPanResponderRelease: () => {},
    }),
  ).current;

  return (
    <View style={{ marginBottom: 16 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <Text style={{ fontSize: 14, fontWeight: '600', color: '#1a1a1a' }}>{label}</Text>
        <Text style={{ fontSize: 16, fontWeight: '700', color: trackColor }}>
          {Math.round(value)} {unit}
        </Text>
      </View>
      <View
        style={{ height: 32, justifyContent: 'center' }}
        onLayout={(e) => setTrackWidth(e.nativeEvent.layout.width)}
        {...panResponder.panHandlers}
      >
        <View style={{ height: 6, borderRadius: 3, backgroundColor: '#e8e8e8', overflow: 'hidden' }}>
          <View style={{ height: '100%', borderRadius: 3, width: `${percentage * 100}%`, backgroundColor: trackColor }} />
        </View>
        <View
          style={{
            position: 'absolute',
            width: 24,
            height: 24,
            borderRadius: 12,
            top: 4,
            left: `${percentage * 100}%`,
            marginLeft: -12,
            backgroundColor: trackColor,
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 2 },
            shadowOpacity: 0.2,
            shadowRadius: 4,
            elevation: 4,
          }}
        />
      </View>
    </View>
  );
}

export default function BiometricsPanel() {
  const insets = useSafeAreaInsets();
  const { profile, biometrics, updateBiometrics, hikeStatus } = useHikeStore();

  const peiResult = useMemo(
    () => calculatePEI(profile, biometrics, 0, 0.3),
    [profile, biometrics],
  );

  const peiColor = useMemo(() => getPEIColor(peiResult.level), [peiResult.level]);
  const peiLabel = useMemo(() => getPEILabel(peiResult.level), [peiResult.level]);

  const expandedHeight = EXPANDED_HEIGHT - COLLAPSED_HEIGHT;
  const drawerAnim = useRef(new Animated.Value(expandedHeight)).current;
  const isExpanded = useRef(false);

  const drawerResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dy) > 5,
      onPanResponderGrant: () => {},
      onPanResponderMove: (_, gestureState) => {
        const newValue = isExpanded.current
          ? -gestureState.dy
          : expandedHeight - gestureState.dy;
        drawerAnim.setValue(Math.max(0, Math.min(expandedHeight, newValue)));
      },
      onPanResponderRelease: (_, gestureState) => {
        const shouldExpand = gestureState.vy < -0.5 || gestureState.dy < -expandedHeight / 2;
        Animated.spring(drawerAnim, {
          toValue: shouldExpand ? 0 : expandedHeight,
          useNativeDriver: true,
          tension: 100,
          friction: 12,
        }).start();
        isExpanded.current = shouldExpand;
      },
    }),
  ).current;

  const handleHeartRateChange = useCallback(
    (val: number) => { updateBiometrics({ currentHeartRate: val }); },
    [updateBiometrics],
  );

  const handleSpo2Change = useCallback(
    (val: number) => { updateBiometrics({ spo2: val }); },
    [updateBiometrics],
  );

  if (hikeStatus !== 'recording') return null;

  const drawerBottom = insets.bottom + 90;

  return (
    <View
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: drawerBottom,
        height: EXPANDED_HEIGHT,
        zIndex: 30,
        overflow: 'visible',
      }}
    >
      <Animated.View
        style={{
          height: EXPANDED_HEIGHT,
          borderTopLeftRadius: 24,
          borderTopRightRadius: 24,
          backgroundColor: 'rgba(255,255,255,0.94)',
          borderWidth: 1,
          borderColor: 'rgba(255,255,255,0.3)',
          shadowColor: '#000',
          shadowOffset: { width: 0, height: -4 },
          shadowOpacity: 0.1,
          shadowRadius: 16,
          elevation: 12,
          transform: [{ translateY: drawerAnim }],
        }}
      >
        {/* Drag Handle */}
        <View
          style={{ alignItems: 'center', paddingTop: 12, paddingBottom: 8 }}
          {...drawerResponder.panHandlers}
        >
          <View
            style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: peiColor, opacity: 0.6, marginBottom: 8 }}
          />
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', width: '100%', paddingHorizontal: 20 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: peiColor }} />
              <Text style={{ fontSize: 14, fontWeight: '600', color: '#888' }}>PEI</Text>
              <Text style={{ fontSize: 24, fontWeight: '800', color: peiColor }}>{peiResult.value}</Text>
              <Text style={{ fontSize: 12, fontWeight: '600', color: peiColor }}>{peiLabel}</Text>
            </View>
            <Text style={{ fontSize: 12, color: '#888' }}>上滑展开</Text>
          </View>
        </View>

        {/* Expanded Content */}
        <View style={{ paddingHorizontal: 20, paddingTop: 8, flex: 1 }}>
          <CustomSlider
            value={biometrics.currentHeartRate}
            minimumValue={60}
            maximumValue={200}
            step={1}
            label="心率"
            unit="bpm"
            trackColor={
              biometrics.currentHeartRate > 160 ? '#ff4d4f'
                : biometrics.currentHeartRate > 130 ? '#faad14'
                : '#1890ff'
            }
            onValueChange={handleHeartRateChange}
          />

          <CustomSlider
            value={biometrics.spo2}
            minimumValue={80}
            maximumValue={100}
            step={1}
            label="血氧饱和度"
            unit="%"
            trackColor={
              biometrics.spo2 < 90 ? '#ff4d4f'
                : biometrics.spo2 < 95 ? '#faad14'
                : '#52c41a'
            }
            onValueChange={handleSpo2Change}
          />

          {/* PEI Component Breakdown */}
          <View style={{ marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: '#f0f0f0' }}>
            <Text style={{ fontSize: 12, fontWeight: '600', color: '#888', marginBottom: 8 }}>PEI 分量构成</Text>
            <View style={{ flexDirection: 'row', justifyContent: 'space-around' }}>
              <View style={{ alignItems: 'center' }}>
                <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#1890ff', marginBottom: 4 }} />
                <Text style={{ fontSize: 12, color: '#888' }}>心率</Text>
                <Text style={{ fontSize: 16, fontWeight: '700', color: '#1a1a1a' }}>{peiResult.heartRateComponent}</Text>
              </View>
              <View style={{ alignItems: 'center' }}>
                <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#52c41a', marginBottom: 4 }} />
                <Text style={{ fontSize: 12, color: '#888' }}>血氧</Text>
                <Text style={{ fontSize: 16, fontWeight: '700', color: '#1a1a1a' }}>{peiResult.spo2Component}</Text>
              </View>
              <View style={{ alignItems: 'center' }}>
                <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#722ed1', marginBottom: 4 }} />
                <Text style={{ fontSize: 12, color: '#888' }}>海拔</Text>
                <Text style={{ fontSize: 16, fontWeight: '700', color: '#1a1a1a' }}>{peiResult.altitudeComponent}</Text>
              </View>
            </View>
          </View>

          {/* Formula */}
          <View style={{ marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: '#f0f0f0' }}>
            <Text style={{ fontSize: 11, color: '#aaa', textAlign: 'center', fontFamily: 'monospace' }}>
              PEI = 0.50 × HR + 0.35 × SpO₂ + 0.15 × Alt
            </Text>
          </View>
        </View>
      </Animated.View>
    </View>
  );
}
