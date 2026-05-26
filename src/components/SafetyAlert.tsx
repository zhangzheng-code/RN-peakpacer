/**
 * ============================================================
 * 安全预警组件（SafetyAlert）
 * ============================================================
 *
 * 当 PEI 连续超出安全阈值时，在地图界面中央强制弹出
 * "极限耗竭警报卡片"，展示：
 * - 应急自救方案
 * - 推荐装备清单
 *
 * 同时触发：
 * - expo-haptics 系统级连续震动
 * - expo-notifications 本地常驻通知
 */

import React, { useEffect, useRef, useCallback, useMemo } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  Animated,
  Modal,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import * as Notifications from 'expo-notifications';
import { useHikeStore } from '../store/useHikeStore';
import {
  calculatePEI,
  PEI_DANGER_THRESHOLD,
  getEmergencyTips,
  getRecommendedGear,
  getPEIColor,
  getPEILabel,
} from '../utils/healthCalculator';

/**
 * 配置通知处理器
 * 当 App 在前台时也展示通知横幅
 */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

/**
 * 连续触发预警所需的次数
 * 避免单次偶发高 PEI 就触发警报
 */
const CONSECUTIVE_THRESHOLD = 3;

/**
 * 震动间隔（毫秒）
 */
const HAPTIC_INTERVAL_MS = 2000;

export default function SafetyAlert() {
  const {
    profile,
    biometrics,
    elevationGain,
    isAlertActive,
    consecutiveAlertCount,
    hikeStatus,
    setAlertActive,
    incrementAlertCount,
    resetAlertCount,
  } = useHikeStore();

  /** 震动定时器引用 */
  const hapticTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /** 脉冲动画值 */
  const pulseAnim = useRef(new Animated.Value(1)).current;

  /** 计算当前 PEI */
  const peiResult = useMemo(
    () => calculatePEI(profile, biometrics, elevationGain, 0.3),
    [profile, biometrics, elevationGain],
  );

  /** 当前是否处于危险区间 */
  const isDanger = peiResult.value >= PEI_DANGER_THRESHOLD;

  /** 获取应急提示 */
  const emergencyTips = useMemo(
    () => getEmergencyTips(peiResult.level),
    [peiResult.level],
  );

  /** 获取推荐装备 */
  const recommendedGear = useMemo(
    () => getRecommendedGear(peiResult.level),
    [peiResult.level],
  );

  /** 触发系统震动 */
  const triggerHapticFeedback = useCallback(async () => {
    try {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } catch (error) {
      console.warn('[SafetyAlert] 震动触发失败:', error);
    }
  }, []);

  /** 推送本地通知 */
  const sendAlertNotification = useCallback(async () => {
    try {
      await Notifications.scheduleNotificationAsync({
        content: {
          title: '⚠️ SmartHike 安全预警',
          body: `您的生理耗竭指数已达 ${peiResult.value}，请立即停止前进并休息！`,
          sound: true,
          priority: Notifications.AndroidNotificationPriority.MAX,
          sticky: true,
        },
        trigger: null,
      });
    } catch (error) {
      console.warn('[SafetyAlert] 通知推送失败:', error);
    }
  }, [peiResult.value]);

  /** 启动连续震动循环 */
  const startHapticLoop = useCallback(() => {
    triggerHapticFeedback();
    hapticTimerRef.current = setInterval(() => {
      triggerHapticFeedback();
    }, HAPTIC_INTERVAL_MS);
  }, [triggerHapticFeedback]);

  /** 停止震动循环 */
  const stopHapticLoop = useCallback(() => {
    if (hapticTimerRef.current) {
      clearInterval(hapticTimerRef.current);
      hapticTimerRef.current = null;
    }
  }, []);

  /** 启动脉冲动画 */
  const startPulseAnimation = useCallback(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1.05,
          duration: 600,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 600,
          useNativeDriver: true,
        }),
      ]),
    ).start();
  }, [pulseAnim]);

  /**
   * PEI 监控效果
   * 每次 biometrics 或 elevationGain 变化时检查是否需要触发/解除警报
   */
  useEffect(() => {
    if (hikeStatus !== 'recording') {
      resetAlertCount();
      setAlertActive(false);
      stopHapticLoop();
      return;
    }

    if (isDanger) {
      incrementAlertCount();
    } else {
      resetAlertCount();
      if (isAlertActive) {
        setAlertActive(false);
        stopHapticLoop();
      }
    }
  }, [biometrics, elevationGain, hikeStatus]);

  /**
   * 当连续警报计数达到阈值时，激活警报
   */
  useEffect(() => {
    if (consecutiveAlertCount >= CONSECUTIVE_THRESHOLD && !isAlertActive) {
      setAlertActive(true);
      startHapticLoop();
      sendAlertNotification();
      startPulseAnimation();
    }
  }, [consecutiveAlertCount]);

  /** 组件卸载时清理 */
  useEffect(() => {
    return () => {
      stopHapticLoop();
    };
  }, []);

  /** 关闭警报 */
  const handleDismiss = useCallback(() => {
    setAlertActive(false);
    stopHapticLoop();
    resetAlertCount();
  }, []);

  if (!isAlertActive) {
    return null;
  }

  const peiColor = getPEIColor(peiResult.level);

  return (
    <Modal
      visible={isAlertActive}
      transparent
      animationType="fade"
      onRequestClose={handleDismiss}
    >
      <View style={styles.overlay}>
        <Animated.View
          style={[styles.card, { transform: [{ scale: pulseAnim }] }]}
        >
          {/* 头部警报标题 */}
          <View style={[styles.header, { backgroundColor: peiColor }]}>
            <Text style={styles.headerIcon}>🚨</Text>
            <View style={styles.headerTextContainer}>
              <Text style={styles.headerTitle}>极限耗竭警报</Text>
              <Text style={styles.headerSubtitle}>
                PEI {peiResult.value} · {getPEILabel(peiResult.level)}
              </Text>
            </View>
          </View>

          <ScrollView
            style={styles.scrollContent}
            showsVerticalScrollIndicator={false}
          >
            {/* PEI 分量分解 */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>体征分析</Text>
              <View style={styles.metricsRow}>
                <View style={styles.metricItem}>
                  <Text style={styles.metricValue}>
                    {Math.round(biometrics.currentHeartRate)}
                  </Text>
                  <Text style={styles.metricLabel}>心率 bpm</Text>
                </View>
                <View style={styles.metricItem}>
                  <Text style={styles.metricValue}>{biometrics.spo2}%</Text>
                  <Text style={styles.metricLabel}>血氧 SpO₂</Text>
                </View>
                <View style={styles.metricItem}>
                  <Text style={styles.metricValue}>
                    {Math.round(elevationGain)}m
                  </Text>
                  <Text style={styles.metricLabel}>累计爬升</Text>
                </View>
              </View>
            </View>

            {/* 应急自救方案 */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>应急自救方案</Text>
              {emergencyTips.map((tip, index) => (
                <View key={index} style={styles.tipRow}>
                  <View style={styles.tipNumber}>
                    <Text style={styles.tipNumberText}>{index + 1}</Text>
                  </View>
                  <Text style={styles.tipText}>{tip}</Text>
                </View>
              ))}
            </View>

            {/* 推荐装备 */}
            {recommendedGear.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>推荐应急装备</Text>
                {recommendedGear.map((gear, index) => (
                  <View key={index} style={styles.gearRow}>
                    <Text style={styles.gearIcon}>{gear.icon}</Text>
                    <View style={styles.gearInfo}>
                      <Text style={styles.gearName}>{gear.name}</Text>
                      <Text style={styles.gearDesc}>{gear.description}</Text>
                    </View>
                  </View>
                ))}
              </View>
            )}
          </ScrollView>

          {/* 底部操作按钮 */}
          <TouchableOpacity
            style={[styles.dismissButton, { backgroundColor: peiColor }]}
            onPress={handleDismiss}
            activeOpacity={0.8}
          >
            <Text style={styles.dismissButtonText}>我已知晓，立即休息</Text>
          </TouchableOpacity>
        </Animated.View>
      </View>
    </Modal>
  );
}

// ---- 样式定义 ----

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  card: {
    width: '100%',
    maxHeight: '85%',
    backgroundColor: '#fff',
    borderRadius: 24,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.3,
    shadowRadius: 24,
    elevation: 16,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 20,
    paddingHorizontal: 20,
  },
  headerIcon: {
    fontSize: 32,
    marginRight: 12,
  },
  headerTextContainer: {
    flex: 1,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: '#fff',
  },
  headerSubtitle: {
    fontSize: 14,
    color: 'rgba(255, 255, 255, 0.9)',
    marginTop: 2,
  },
  scrollContent: {
    paddingHorizontal: 20,
    paddingTop: 16,
  },
  section: {
    marginBottom: 20,
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#333',
    marginBottom: 12,
  },
  metricsRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    backgroundColor: '#f8f8f8',
    borderRadius: 12,
    paddingVertical: 14,
  },
  metricItem: {
    alignItems: 'center',
  },
  metricValue: {
    fontSize: 22,
    fontWeight: '800',
    color: '#1a1a1a',
  },
  metricLabel: {
    fontSize: 12,
    color: '#888',
    marginTop: 2,
  },
  tipRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 10,
  },
  tipNumber: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#ff4d4f',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
    marginTop: 1,
  },
  tipNumberText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#fff',
  },
  tipText: {
    flex: 1,
    fontSize: 14,
    color: '#444',
    lineHeight: 20,
  },
  gearRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f8f8f8',
    borderRadius: 12,
    padding: 14,
    marginBottom: 8,
  },
  gearIcon: {
    fontSize: 28,
    marginRight: 14,
  },
  gearInfo: {
    flex: 1,
  },
  gearName: {
    fontSize: 15,
    fontWeight: '600',
    color: '#333',
  },
  gearDesc: {
    fontSize: 13,
    color: '#888',
    marginTop: 2,
  },
  dismissButton: {
    marginHorizontal: 20,
    marginVertical: 16,
    paddingVertical: 16,
    borderRadius: 16,
    alignItems: 'center',
  },
  dismissButtonText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#fff',
  },
});
