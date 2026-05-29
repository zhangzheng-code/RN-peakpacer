import React, { useCallback, useMemo, useRef, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import BottomSheet, { BottomSheetScrollView } from '@gorhom/bottom-sheet';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  useAnimatedReaction,
  interpolate,
  Extrapolation,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import MapContainer from '../components/MapContainer';
import { useHikeStore } from '../store/useHikeStore';
import { calculatePEI, getPEIColor, getPEILabel } from '../utils/healthCalculator';

export default function HikeGoScreen() {
  const insets = useSafeAreaInsets();
  const bottomSheetRef = useRef<BottomSheet>(null);

  const snapPoints = useMemo(() => ['16%', '55%', '90%'], []);

  // ---- Zustand ----
  const hikeStatus = useHikeStore((s) => s.hikeStatus);
  const profile = useHikeStore((s) => s.profile);
  const biometrics = useHikeStore((s) => s.biometrics);
  const elevationGain = useHikeStore((s) => s.elevationGain);
  const totalDistance = useHikeStore((s) => s.totalDistance);
  const startTime = useHikeStore((s) => s.startTime);
  const setTabBarVisible = useHikeStore((s) => s.setTabBarVisible);
  const startHike = useHikeStore((s) => s.startHike);
  const stopHike = useHikeStore((s) => s.stopHike);

  const isRecording = hikeStatus === 'recording';

  // ---- PEI computation ----
  const peiResult = useMemo(
    () => calculatePEI(profile, biometrics, elevationGain, 0.3),
    [profile, biometrics, elevationGain],
  );
  const peiColor = useMemo(() => getPEIColor(peiResult.level), [peiResult.level]);
  const peiLabel = useMemo(() => getPEILabel(peiResult.level), [peiResult.level]);

  // ---- Elapsed time (for display inside drawer) ----
  const [elapsedSeconds, setElapsedSeconds] = React.useState(0);

  useEffect(() => {
    if (!isRecording || startTime === null) {
      setElapsedSeconds(0);
      return;
    }
    const timer = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [isRecording, startTime]);

  const formatTime = (seconds: number): string => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  };

  const formatDistance = (meters: number): string => {
    if (meters >= 1000) return `${(meters / 1000).toFixed(2)} km`;
    return `${Math.round(meters)} m`;
  };

  // ---- BottomSheet animated index for tab bar avoidance ----
  const animatedIndex = useSharedValue(0);

  const handleSheetChange = useCallback(
    (index: number) => {
      if (index > 0) {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        setTabBarVisible(false);
      } else {
        setTabBarVisible(true);
      }
    },
    [setTabBarVisible],
  );

  // ---- Handle start/stop from drawer ----
  const handleToggleHike = useCallback(async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    if (isRecording) {
      stopHike();
    } else {
      startHike();
    }
  }, [isRecording, startHike, stopHike]);

  return (
    <GestureHandlerRootView style={styles.root}>
      {/* Full-screen map underneath */}
      <MapContainer />

      {/* Bottom Sheet Drawer */}
      <BottomSheet
        ref={bottomSheetRef}
        index={0}
        snapPoints={snapPoints}
        onChange={handleSheetChange}
        animatedIndex={animatedIndex}
        backgroundStyle={styles.sheetBackground}
        handleIndicatorStyle={styles.handleIndicator}
        enableOverDrag={false}
        enablePanDownToClose={false}
      >
        <BottomSheetScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          {/* ---- PEI Safety Bar (always visible at collapsed 16%) ---- */}
          <View style={styles.peiBar}>
            <View style={styles.peiRow}>
              <View style={[styles.peiDot, { backgroundColor: peiColor }]} />
              <Text style={styles.peiLabelText}>PEI</Text>
              <Text style={[styles.peiValue, { color: peiColor }]}>{peiResult.value}</Text>
              <Text style={[styles.peiLevel, { color: peiColor }]}>{peiLabel}</Text>
            </View>

            {/* Compact stats row */}
            <View style={styles.statsRow}>
              <View style={styles.statItem}>
                <Text style={styles.statValue}>{formatTime(elapsedSeconds)}</Text>
                <Text style={styles.statLabel}>用时</Text>
              </View>
              <View style={styles.statDivider} />
              <View style={styles.statItem}>
                <Text style={styles.statValue}>{formatDistance(totalDistance)}</Text>
                <Text style={styles.statLabel}>距离</Text>
              </View>
              <View style={styles.statDivider} />
              <View style={styles.statItem}>
                <Text style={styles.statValue}>{Math.round(elevationGain)}m</Text>
                <Text style={styles.statLabel}>爬升</Text>
              </View>
            </View>
          </View>

          {/* ---- Start / Stop Button ---- */}
          <View style={styles.actionButtonWrapper}>
            {isRecording ? (
              <TouchableOpacity activeOpacity={0.85} onPress={handleToggleHike}>
                <LinearGradient
                  colors={['#ff4d4f', '#cf1322']}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 0 }}
                  style={styles.actionButton}
                >
                  <Text style={styles.actionButtonText}>⏹ 停止记录</Text>
                </LinearGradient>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity activeOpacity={0.85} onPress={handleToggleHike}>
                <LinearGradient
                  colors={['#10B981', '#059669']}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 0 }}
                  style={styles.actionButton}
                >
                  <Text style={styles.actionButtonText}>🥾 开始徒步</Text>
                </LinearGradient>
              </TouchableOpacity>
            )}
          </View>

          {/* ---- PEI Breakdown ---- */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>体能指数分解</Text>
            <View style={styles.peiBreakdownRow}>
              <View style={styles.peiComponent}>
                <View style={[styles.peiComponentDot, { backgroundColor: '#3B82F6' }]} />
                <Text style={styles.peiComponentLabel}>心率</Text>
                <Text style={styles.peiComponentValue}>{peiResult.heartRateComponent}</Text>
              </View>
              <View style={styles.peiComponent}>
                <View style={[styles.peiComponentDot, { backgroundColor: '#10B981' }]} />
                <Text style={styles.peiComponentLabel}>血氧</Text>
                <Text style={styles.peiComponentValue}>{peiResult.spo2Component}</Text>
              </View>
              <View style={styles.peiComponent}>
                <View style={[styles.peiComponentDot, { backgroundColor: '#8B5CF6' }]} />
                <Text style={styles.peiComponentLabel}>海拔</Text>
                <Text style={styles.peiComponentValue}>{peiResult.altitudeComponent}</Text>
              </View>
            </View>
            <Text style={styles.formula}>PEI = 0.50 x HR + 0.35 x SpO2 + 0.15 x Alt</Text>
          </View>

          {/* ---- Trend Chart Placeholder ---- */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>趋势图</Text>
            <View style={styles.chartPlaceholder}>
              {/* SVG trend chart placeholder */}
              <View style={styles.chartPlaceholderInner}>
                <Text style={styles.chartPlaceholderIcon}>📈</Text>
                <Text style={styles.chartPlaceholderText}>心率 / PEI 趋势图</Text>
                <Text style={styles.chartPlaceholderSubtext}>数据积累后自动绘制</Text>
              </View>
            </View>
          </View>

          {/* ---- Biometrics Sliders (for simulation) ---- */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>体征模拟</Text>
            <View style={styles.biometricsRow}>
              <View style={styles.biometricCard}>
                <Text style={styles.biometricLabel}>心率</Text>
                <Text style={[styles.biometricValue, { color: biometrics.currentHeartRate > 160 ? '#ff4d4f' : '#3B82F6' }]}>
                  {biometrics.currentHeartRate}
                </Text>
                <Text style={styles.biometricUnit}>bpm</Text>
              </View>
              <View style={styles.biometricCard}>
                <Text style={styles.biometricLabel}>血氧</Text>
                <Text style={[styles.biometricValue, { color: biometrics.spo2 < 90 ? '#ff4d4f' : '#10B981' }]}>
                  {biometrics.spo2}
                </Text>
                <Text style={styles.biometricUnit}>%</Text>
              </View>
            </View>
          </View>

          {/* Bottom padding for safe area */}
          <View style={{ height: 40 }} />
        </BottomSheetScrollView>
      </BottomSheet>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#121314',
  },
  sheetBackground: {
    backgroundColor: '#1A1B1E',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
  },
  handleIndicator: {
    backgroundColor: 'rgba(255,255,255,0.2)',
    width: 40,
    height: 4,
  },
  scrollContent: {
    paddingHorizontal: 20,
    paddingTop: 4,
  },
  // ---- PEI Safety Bar ----
  peiBar: {
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    padding: 14,
    marginBottom: 12,
  },
  peiRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
  },
  peiDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: 8,
  },
  peiLabelText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#9CA3AF',
    marginRight: 8,
  },
  peiValue: {
    fontSize: 26,
    fontWeight: '800',
    marginRight: 6,
  },
  peiLevel: {
    fontSize: 13,
    fontWeight: '600',
  },
  statsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
  },
  statItem: {
    alignItems: 'center',
    flex: 1,
  },
  statValue: {
    fontSize: 18,
    fontWeight: '700',
    color: '#F3F4F6',
    fontVariant: ['tabular-nums'],
  },
  statLabel: {
    fontSize: 11,
    color: '#6B7280',
    marginTop: 2,
  },
  statDivider: {
    width: 1,
    height: 28,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  // ---- Action Button ----
  actionButtonWrapper: {
    alignItems: 'center',
    marginBottom: 16,
  },
  actionButton: {
    paddingHorizontal: 56,
    paddingVertical: 16,
    borderRadius: 32,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 8,
  },
  actionButtonText: {
    fontSize: 17,
    fontWeight: '700',
    color: '#fff',
    letterSpacing: 1,
  },
  // ---- Sections ----
  section: {
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.05)',
    padding: 16,
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#D1D5DB',
    marginBottom: 12,
  },
  // ---- PEI Breakdown ----
  peiBreakdownRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginBottom: 12,
  },
  peiComponent: {
    alignItems: 'center',
  },
  peiComponentDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginBottom: 4,
  },
  peiComponentLabel: {
    fontSize: 12,
    color: '#6B7280',
  },
  peiComponentValue: {
    fontSize: 18,
    fontWeight: '700',
    color: '#F3F4F6',
    marginTop: 2,
  },
  formula: {
    fontSize: 10,
    color: '#4B5563',
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
  // ---- Chart Placeholder ----
  chartPlaceholder: {
    height: 160,
    borderRadius: 12,
    backgroundColor: 'rgba(16,185,129,0.04)',
    borderWidth: 1,
    borderColor: 'rgba(16,185,129,0.1)',
    overflow: 'hidden',
  },
  chartPlaceholderInner: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chartPlaceholderIcon: {
    fontSize: 36,
    marginBottom: 8,
  },
  chartPlaceholderText: {
    fontSize: 14,
    fontWeight: '600',
    color: 'rgba(16,185,129,0.5)',
  },
  chartPlaceholderSubtext: {
    fontSize: 11,
    color: '#4B5563',
    marginTop: 4,
  },
  // ---- Biometrics ----
  biometricsRow: {
    flexDirection: 'row',
    gap: 12,
  },
  biometricCard: {
    flex: 1,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 12,
    padding: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  biometricLabel: {
    fontSize: 12,
    color: '#6B7280',
    marginBottom: 4,
  },
  biometricValue: {
    fontSize: 28,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  biometricUnit: {
    fontSize: 11,
    color: '#4B5563',
    marginTop: 2,
  },
});
