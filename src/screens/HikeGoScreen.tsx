import React, { useCallback, useMemo, useRef, useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert, Modal } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import BottomSheet, { BottomSheetScrollView } from '@gorhom/bottom-sheet';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  interpolate,
  Extrapolation,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import MapContainer from '../components/MapContainer';
import BiometricsChart from '../components/BiometricsChart';
import StatsHUD from '../components/StatsHUD';
import PEIOrb from '../components/PEIOrb';
import FloatingButtons from '../components/FloatingButtons';
import SafetyAlert from '../components/SafetyAlert';
import AIChatScreen from './AIChatScreen';
import { useHikeStore } from '../store/useHikeStore';
import { calculatePEI, getPEIColor, getPEILabel } from '../utils/healthCalculator';
import { startHealthDataStream, stopHealthDataStream } from '../services/healthService';
import {
  startBackgroundLocation,
  stopBackgroundLocation,
  resetTrailBuffer,
} from '../tasks/backgroundLocationTask';
import type { TileSourceType } from '../types';

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
  const storeStartHike = useHikeStore((s) => s.startHike);
  const storeStopHike = useHikeStore((s) => s.stopHike);
  const updateBiometrics = useHikeStore((s) => s.updateBiometrics);
  const addBiometricsRecord = useHikeStore((s) => s.addBiometricsRecord);
  const biometricsHistory = useHikeStore((s) => s.biometricsHistory);
  const clearBiometricsHistory = useHikeStore((s) => s.clearBiometricsHistory);

  const isRecording = hikeStatus === 'recording';

  // ---- Tile source state ----
  const [activeSource, setActiveSource] = useState<TileSourceType>('standard');
  const [isAIChatVisible, setIsAIChatVisible] = useState(false);

  // ---- Health data stream lifecycle ----
  useEffect(() => {
    if (!isRecording) {
      stopHealthDataStream();
      return;
    }

    clearBiometricsHistory();

    startHealthDataStream((data) => {
      updateBiometrics({ currentHeartRate: data.heartRate, spo2: data.spO2 });

      const peiResult = calculatePEI(
        useHikeStore.getState().profile,
        { currentHeartRate: data.heartRate, spo2: data.spO2 },
        useHikeStore.getState().elevationGain,
        0.3,
      );

      addBiometricsRecord({
        timestamp: Date.now(),
        heartRate: data.heartRate,
        pei: peiResult.value,
      });
    });

    return () => {
      stopHealthDataStream();
    };
  }, [isRecording, updateBiometrics, addBiometricsRecord, clearBiometricsHistory]);

  // ---- PEI computation ----
  const peiResult = useMemo(
    () => calculatePEI(profile, biometrics, elevationGain, 0.3),
    [profile, biometrics, elevationGain],
  );
  const peiColor = useMemo(() => getPEIColor(peiResult.level), [peiResult.level]);
  const peiLabel = useMemo(() => getPEILabel(peiResult.level), [peiResult.level]);

  // ---- Elapsed time ----
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

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

  // ---- Start hike (with background location) ----
  const handleStartHike = useCallback(async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    resetTrailBuffer();
    storeStartHike();

    const started = await startBackgroundLocation();
    if (!started) {
      Alert.alert('后台定位启动失败', '请检查是否已授予"始终允许"定位权限。', [
        { text: '知道了' },
      ]);
    }
  }, [storeStartHike]);

  // ---- Stop hike (with background location) ----
  const handleStopHike = useCallback(async () => {
    Alert.alert('结束徒步', '确定要结束本次徒步记录吗？', [
      { text: '取消', style: 'cancel' },
      {
        text: '确定结束',
        style: 'destructive',
        onPress: async () => {
          await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          await stopBackgroundLocation();
          storeStopHike();
        },
      },
    ]);
  }, [storeStopHike]);

  // ---- Floating button handlers ----
  const handleSwitchSource = useCallback(() => {
    setActiveSource((prev) => (prev === 'standard' ? 'satellite' : 'standard'));
  }, []);

  const handleOpenAI = useCallback(() => setIsAIChatVisible(true), []);
  const handleCloseAI = useCallback(() => setIsAIChatVisible(false), []);

  // ---- Sheet header animated style (fade + translate on expand) ----
  const sheetHeaderStyle = useAnimatedStyle(() => {
    const opacity = interpolate(
      animatedIndex.value,
      [0, 1],
      [1, 0.3],
      Extrapolation.CLAMP,
    );
    return { opacity };
  });

  return (
    <GestureHandlerRootView style={styles.root}>
      {/* Background: pure map (absoluteFill, sibling) */}
      <MapContainer tileSource={activeSource} />

      {/* Absolute overlay: HUD + Orb + Floating buttons (siblings of map) */}
      {isRecording && (
        <StatsHUD
          elapsedSeconds={elapsedSeconds}
          totalDistance={totalDistance}
          elevationGain={elevationGain}
        />
      )}

      {isRecording && <PEIOrb />}

      <FloatingButtons
        activeSource={activeSource}
        onSwitchSource={handleSwitchSource}
        onOpenAI={handleOpenAI}
      />

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
          {/* PEI Safety Bar (always visible at collapsed 16%) */}
          <Animated.View style={sheetHeaderStyle}>
            <View style={styles.peiBar}>
              <View style={styles.peiRow}>
                <View style={[styles.peiDot, { backgroundColor: peiColor }]} />
                <Text style={styles.peiLabelText}>PEI</Text>
                <Text style={[styles.peiValue, { color: peiColor }]}>{peiResult.value}</Text>
                <Text style={[styles.peiLevel, { color: peiColor }]}>{peiLabel}</Text>
              </View>

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
          </Animated.View>

          {/* Start / Stop Button — THE ONLY stop button in the entire app */}
          <View style={styles.actionButtonWrapper}>
            {isRecording ? (
              <TouchableOpacity activeOpacity={0.85} onPress={handleStopHike}>
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
              <TouchableOpacity activeOpacity={0.85} onPress={handleStartHike}>
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

          {/* PEI Breakdown */}
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

          {/* Real-time Biometrics Trend Chart */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>实时趋势</Text>
            <BiometricsChart data={biometricsHistory} />
          </View>

          {/* Biometrics Cards (simulation) */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>体征模拟</Text>
            <View style={styles.biometricsRow}>
              <View style={styles.biometricCard}>
                <Text style={styles.biometricLabel}>心率</Text>
                <Text
                  style={[
                    styles.biometricValue,
                    { color: biometrics.currentHeartRate > 160 ? '#ff4d4f' : '#3B82F6' },
                  ]}
                >
                  {biometrics.currentHeartRate}
                </Text>
                <Text style={styles.biometricUnit}>bpm</Text>
              </View>
              <View style={styles.biometricCard}>
                <Text style={styles.biometricLabel}>血氧</Text>
                <Text
                  style={[
                    styles.biometricValue,
                    { color: biometrics.spo2 < 90 ? '#ff4d4f' : '#10B981' },
                  ]}
                >
                  {biometrics.spo2}
                </Text>
                <Text style={styles.biometricUnit}>%</Text>
              </View>
            </View>
          </View>

          <View style={{ height: 40 }} />
        </BottomSheetScrollView>
      </BottomSheet>

      {/* SafetyAlert modal */}
      <SafetyAlert />

      {/* AI Chat fullscreen modal */}
      <Modal
        visible={isAIChatVisible}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={handleCloseAI}
      >
        <AIChatScreen visible={isAIChatVisible} onClose={handleCloseAI} />
      </Modal>
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
