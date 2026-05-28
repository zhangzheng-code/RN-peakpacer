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
 * - expo-haptics 系统级连续震动（前台每 2 秒一次）
 * - expo-notifications 本地常驻通知（后台每 2 秒重复推送）
 *
 * 后台策略：
 *   iOS 进入后台后 setInterval 会被系统挂起，
 *   因此使用重复本地通知作为后台唤醒手段，
 *   每 2 秒推送一次带震动音效的通知，确保用户即使锁屏也能感知。
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
  AppState,
  Platform,
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
 * 当 App 在前台时也展示通知横幅 + 播放声音
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
 * Android 通知渠道 ID
 */
const ALERT_CHANNEL_ID = 'smarthike-safety-alert';

/**
 * 连续触发预警所需的次数
 * 避免单次偶发高 PEI 就触发警报
 */
const CONSECUTIVE_THRESHOLD = 3;

/**
 * 震动 / 通知间隔（毫秒）
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

  /** 是否已创建 Android 通知渠道 */
  const channelCreatedRef = useRef(false);

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

  /**
   * 创建 Android 通知渠道（仅需执行一次）
   * 设置为最高重要性 + 长震动模式，确保不被系统静默
   */
  const ensureChannel = useCallback(async () => {
    if (Platform.OS !== 'android' || channelCreatedRef.current) return;
    try {
      if (typeof Notifications.setNotificationChannelAsync === 'function') {
        await Notifications.setNotificationChannelAsync(ALERT_CHANNEL_ID, {
          name: '安全预警',
          importance: Notifications.AndroidImportance?.MAX ?? 5,
          vibrationPattern: [0, 250, 250, 250],
          lightColor: '#FF0000',
          sound: 'default',
          bypassDnd: true,
        });
        channelCreatedRef.current = true;
      }
    } catch (e) {
      console.warn('[SafetyAlert] 创建通知渠道失败:', e);
    }
  }, []);

  /** 触发系统震动（仅前台有效） */
  const triggerHapticFeedback = useCallback(async () => {
    try {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } catch (error) {
      console.warn('[SafetyAlert] 震动触发失败:', error);
    }
  }, []);

  /**
   * 推送单条本地通知
   * - Android: 走自建渠道，最高优先级，绕勿扰
   * - iOS: interruptionLevel = timeSensitive，突破专注模式
   */
  const sendAlertNotification = useCallback(async () => {
    try {
      await Notifications.scheduleNotificationAsync({
        content: {
          title: '⚠️ SmartHike 安全预警',
          body: `您的生理耗竭指数已达 ${peiResult.value}，请立即停止前进并休息！`,
          sound: true,
          priority: Notifications.AndroidNotificationPriority?.MAX ?? 'max',
          ...(Platform.OS === 'android' ? { channelId: ALERT_CHANNEL_ID } : {}),
          ...(Platform.OS === 'ios' ? { interruptionLevel: 'timeSensitive' as const } : {}),
        },
        trigger: null,
      });
    } catch (error) {
      console.warn('[SafetyAlert] 通知推送失败:', error);
    }
  }, [peiResult.value]);

  /**
   * 启动重复通知循环（后台持续唤醒手段）
   * 每 2 秒推送一条本地通知，带震动 + 音效
   * iOS 进入后台后 setInterval 会被挂起，但本地通知由系统调度，不受影响
   */
  const startNotificationLoop = useCallback(() => {
    sendAlertNotification();
    const id = setInterval(() => {
      sendAlertNotification();
    }, HAPTIC_INTERVAL_MS);
    return id;
  }, [sendAlertNotification]);

  /** 停止通知循环 */
  const stopNotificationLoop = useCallback((id: ReturnType<typeof setInterval> | null) => {
    if (id !== null) {
      clearInterval(id);
    }
  }, []);

  /** 启动前台震动循环 */
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

  /** 取消所有已发出的安全预警通知 */
  const cancelAllAlertNotifications = useCallback(async () => {
    try {
      const presented = await Notifications.getPresentedNotificationsAsync();
      for (const n of presented) {
        if (n.request.content.title?.includes('SmartHike')) {
          await Notifications.dismissNotificationAsync(n.request.identifier);
        }
      }
    } catch (error) {
      console.warn('[SafetyAlert] 取消通知失败:', error);
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
   * 初始化：创建 Android 通知渠道 + 请求通知权限
   */
  useEffect(() => {
    ensureChannel();
    Notifications.requestPermissionsAsync();
  }, []);

  /**
   * 通知循环定时器引用
   * 与 hapticTimerRef 分开，因为通知循环独立于震动循环
   */
  const notifTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /**
   * PEI 监控效果
   * 每次 biometrics 或 elevationGain 变化时检查是否需要触发/解除警报
   */
  useEffect(() => {
    if (hikeStatus !== 'recording') {
      resetAlertCount();
      setAlertActive(false);
      stopHapticLoop();
      stopNotificationLoop(notifTimerRef.current);
      notifTimerRef.current = null;
      return;
    }

    if (isDanger) {
      incrementAlertCount();
    } else {
      resetAlertCount();
      if (isAlertActive) {
        setAlertActive(false);
        stopHapticLoop();
        stopNotificationLoop(notifTimerRef.current);
        notifTimerRef.current = null;
        cancelAllAlertNotifications();
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
      notifTimerRef.current = startNotificationLoop();
      startPulseAnimation();
    }
  }, [consecutiveAlertCount]);

  /**
   * 监听 AppState：App 从后台回到前台时重启震动循环
   *
   * 问题：iOS 后台会挂起 setInterval，导致震动定时器停止。
   * 通知由系统调度不受影响，但震动只在前台有效。
   * 因此在 app 回到前台时立即重启震动循环。
   */
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && isAlertActive) {
        stopHapticLoop();
        startHapticLoop();
      }
    });
    return () => sub.remove();
  }, [isAlertActive]);

  /** 组件卸载时清理所有定时器和通知 */
  useEffect(() => {
    return () => {
      stopHapticLoop();
      stopNotificationLoop(notifTimerRef.current);
      notifTimerRef.current = null;
      cancelAllAlertNotifications();
    };
  }, []);

  /** 关闭警报（用户点击"我已知晓"） */
  const handleDismiss = useCallback(async () => {
    setAlertActive(false);
    stopHapticLoop();
    stopNotificationLoop(notifTimerRef.current);
    notifTimerRef.current = null;
    resetAlertCount();
    await cancelAllAlertNotifications();
  }, [cancelAllAlertNotifications, resetAlertCount, stopHapticLoop, stopNotificationLoop]);

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
            <Text style={styles.headerIcon}>{"\u{1F6A8}"}</Text>
            <View style={styles.headerTextContainer}>
              <Text style={styles.headerTitle}>{"极限耗竭警报"}</Text>
              <Text style={styles.headerSubtitle}>
                PEI {peiResult.value} {"·"} {getPEILabel(peiResult.level)}
              </Text>
            </View>
          </View>

          <ScrollView
            style={styles.scrollContent}
            showsVerticalScrollIndicator={false}
          >
            {/* PEI 分量分解 */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>{"体征分析"}</Text>
              <View style={styles.metricsRow}>
                <View style={styles.metricItem}>
                  <Text style={styles.metricValue}>
                    {Math.round(biometrics.currentHeartRate)}
                  </Text>
                  <Text style={styles.metricLabel}>{"心率 bpm"}</Text>
                </View>
                <View style={styles.metricItem}>
                  <Text style={styles.metricValue}>{biometrics.spo2}%</Text>
                  <Text style={styles.metricLabel}>{"血氧 SpO₂"}</Text>
                </View>
                <View style={styles.metricItem}>
                  <Text style={styles.metricValue}>
                    {Math.round(elevationGain)}m
                  </Text>
                  <Text style={styles.metricLabel}>{"累计爬升"}</Text>
                </View>
              </View>
            </View>

            {/* 应急自救方案 */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>{"应急自救方案"}</Text>
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
                <Text style={styles.sectionTitle}>{"推荐应急装备"}</Text>
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
            <Text style={styles.dismissButtonText}>{"我已知晓，立即休息"}</Text>
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
