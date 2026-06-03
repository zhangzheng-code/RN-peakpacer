/**
 * ============================================================
 * MatchScanOverlay — 全屏雷达扫描智能匹配动画
 * ============================================================
 *
 * 4 阶段科幻动效：
 *   Phase 1 (0~800ms)   : 空域扫描 — 旋转雷达环 + 坐标数字流
 *   Phase 2 (800~1600ms): 体征分析 — PPG 脉搏波形 + 数据卡片弹入
 *   Phase 3 (1600~2600ms): 智能匹配 — 终端风格逐字符打印
 *   Phase 4 (2600~3200ms): 结果揭晓 — 匹配结果卡片弹簧弹入
 *
 * 设计文档：第三阶段白皮书 §2.1.2
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  Dimensions,
  TouchableOpacity,
  ScrollView,
  Platform,
} from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withSpring,
  withDelay,
  withSequence,
  Easing,
  runOnJS,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { BlurView } from 'expo-blur';
import type { MatchScore } from '../utils/matchEngine';

// ============================================================
// 常量
// ============================================================

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

/** 动画阶段时长（ms） */
const PHASE_1_DURATION = 800;
const PHASE_2_DURATION = 800;
const PHASE_3_DURATION = 1000;
const PHASE_4_DELAY = 2600;

/** 终端日志文案 */
const SCAN_LINES = [
  '> SCAN SECTOR 07-ALPHA',
  '> LOCKING GPS CONSTELLATION',
  '> 12 SATELLITES ACQUIRED',
];

const MATCH_LINES = [
  'ANALYZING 2,847 ACTIVE HIKERS...',
  'FILTERING: HR_compatibility > 0.85',
  'FILTERING: pace_deviation < 15%',
  'MATCHING: route_gradient_affinity ✓',
];

// ============================================================
// 类型定义
// ============================================================

export interface MatchResult {
  id: string;
  trailName: string;
  leaderName: string;
  leaderAvatar: string;
  score: MatchScore;
  difficulty: string;
  elevationGain: number;
  distance: number;
  path: Array<{ latitude: number; longitude: number }>;
}

interface MatchScanOverlayProps {
  visible: boolean;
  onClose: () => void;
  results: MatchResult[];
  onCardPress?: (result: MatchResult) => void;
}

// ============================================================
// 子组件：旋转雷达环
// ============================================================

function RadarRing({ phase }: { phase: number }) {
  const rotation = useSharedValue(0);
  const scale = useSharedValue(0.5);
  const opacity = useSharedValue(0);

  useEffect(() => {
    if (phase >= 1) {
      opacity.value = withTiming(1, { duration: 300 });
      scale.value = withSpring(1, { damping: 12, stiffness: 100 });
      rotation.value = withTiming(360, {
        duration: 1200,
        easing: Easing.linear,
      });
    }
  }, [phase, opacity, scale, rotation]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [
      { scale: scale.value },
      { rotate: `${rotation.value}deg` },
    ],
  }));

  return (
    <Animated.View style={[styles.radarOuter, animatedStyle]}>
      <View style={styles.radarRing} />
      <View style={styles.radarInnerRing} />
      <View style={styles.radarCenter} />
      {/* 十字准线 */}
      <View style={[styles.crosshair, styles.crosshairH]} />
      <View style={[styles.crosshair, styles.crosshairV]} />
    </Animated.View>
  );
}

// ============================================================
// 子组件：数据卡片
// ============================================================

function MetricCard({
  label,
  value,
  unit,
  delay,
  visible,
}: {
  label: string;
  value: string;
  unit: string;
  delay: number;
  visible: boolean;
}) {
  const translateY = useSharedValue(20);
  const opacity = useSharedValue(0);

  useEffect(() => {
    if (visible) {
      translateY.value = withDelay(
        delay,
        withSpring(0, { damping: 15, stiffness: 150 }),
      );
      opacity.value = withDelay(delay, withTiming(1, { duration: 200 }));
    }
  }, [visible, delay, translateY, opacity]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: translateY.value }],
  }));

  return (
    <Animated.View style={[styles.metricCard, animatedStyle]}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue}>{value}</Text>
      <Text style={styles.metricUnit}>{unit}</Text>
    </Animated.View>
  );
}

// ============================================================
// 子组件：终端文字流
// ============================================================

function TerminalStream({
  lines,
  active,
  onComplete,
}: {
  lines: string[];
  active: boolean;
  onComplete?: () => void;
}) {
  const [displayedLines, setDisplayedLines] = useState<string[]>([]);
  const [currentLine, setCurrentLine] = useState('');
  const lineIndexRef = useRef(0);
  const charIndexRef = useRef(0);

  useEffect(() => {
    if (!active) return;

    lineIndexRef.current = 0;
    charIndexRef.current = 0;
    setDisplayedLines([]);
    setCurrentLine('');

    const interval = setInterval(() => {
      const lineIdx = lineIndexRef.current;
      if (lineIdx >= lines.length) {
        clearInterval(interval);
        onComplete?.();
        return;
      }

      const line = lines[lineIdx];
      const charIdx = charIndexRef.current;

      if (charIdx < line.length) {
        setCurrentLine(line.slice(0, charIdx + 1));
        charIndexRef.current += 1;
      } else {
        setDisplayedLines((prev) => [...prev, line]);
        setCurrentLine('');
        lineIndexRef.current += 1;
        charIndexRef.current = 0;

        // 每行完成时轻微触觉反馈
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      }
    }, 35);

    return () => clearInterval(interval);
  }, [active, lines, onComplete]);

  return (
    <View style={styles.terminalContainer}>
      {displayedLines.map((line, i) => (
        <Text key={i} style={styles.terminalLine}>
          {line}
        </Text>
      ))}
      {currentLine.length > 0 && (
        <Text style={styles.terminalLineActive}>
          {currentLine}
          <Text style={styles.cursor}>▌</Text>
        </Text>
      )}
    </View>
  );
}

// ============================================================
// 子组件：匹配结果卡片
// ============================================================

function ResultCard({
  result,
  index,
  visible,
  onPress,
}: {
  result: MatchResult;
  index: number;
  visible: boolean;
  onPress?: (result: MatchResult) => void;
}) {
  const scale = useSharedValue(0.8);
  const opacity = useSharedValue(0);
  const translateY = useSharedValue(30);

  useEffect(() => {
    if (visible) {
      const delay = index * 120;
      scale.value = withDelay(
        delay,
        withSpring(1, { damping: 14, stiffness: 140 }),
      );
      opacity.value = withDelay(delay, withTiming(1, { duration: 250 }));
      translateY.value = withDelay(
        delay,
        withSpring(0, { damping: 15, stiffness: 150 }),
      );
    }
  }, [visible, index, scale, opacity, translateY]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [
      { scale: scale.value },
      { translateY: translateY.value },
    ],
  }));

  const scoreColor =
    result.score.overall >= 80
      ? '#10B981'
      : result.score.overall >= 60
        ? '#F59E0B'
        : '#6B7280';

  const handlePress = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onPress?.(result);
  }, [onPress, result]);

  return (
    <Animated.View style={[styles.resultCard, animatedStyle]}>
      <TouchableOpacity activeOpacity={0.85} onPress={handlePress} style={styles.resultTouchable}>
      <View style={styles.resultHeader}>
        <Text style={styles.resultAvatar}>{result.leaderAvatar}</Text>
        <View style={styles.resultInfo}>
          <Text style={styles.resultTrail}>{result.trailName}</Text>
          <Text style={styles.resultLeader}>领队：{result.leaderName}</Text>
        </View>
        <View style={[styles.scoreBadge, { borderColor: scoreColor }]}>
          <Text style={[styles.scoreValue, { color: scoreColor }]}>
            {result.score.overall}%
          </Text>
          <Text style={styles.scoreLabel}>推荐</Text>
        </View>
      </View>

      <View style={styles.resultTags}>
        <View style={[styles.tag, { backgroundColor: 'rgba(16,185,129,0.12)' }]}>
          <Text style={[styles.tagText, { color: '#10B981' }]}>
            ↑{result.elevationGain}m
          </Text>
        </View>
        <View style={[styles.tag, { backgroundColor: 'rgba(59,130,246,0.12)' }]}>
          <Text style={[styles.tagText, { color: '#3B82F6' }]}>
            {result.distance}km
          </Text>
        </View>
        <View style={[styles.tag, { backgroundColor: 'rgba(245,158,11,0.12)' }]}>
          <Text style={[styles.tagText, { color: '#F59E0B' }]}>
            {result.difficulty}
          </Text>
        </View>
      </View>
      </TouchableOpacity>
    </Animated.View>
  );
}
// ============================================================

export default function MatchScanOverlay({
  visible,
  onClose,
  results,
  onCardPress,
}: MatchScanOverlayProps) {
  const [phase, setPhase] = useState(0);
  const [showResults, setShowResults] = useState(false);
  const [matchCount, setMatchCount] = useState(0);

  // 背景渐入
  const bgOpacity = useSharedValue(0);

  // Phase 1: 雷达旋转由 RadarRing 内部管理

  // Phase 2: 数据卡片
  const [showMetrics, setShowMetrics] = useState(false);

  // Phase 3: 匹配日志
  const [showMatchLog, setShowMatchLog] = useState(false);

  // Phase 2 → 3 的日志完成回调
  const handleScanComplete = useCallback(() => {
    // Phase 2 扫描完成后进入 Phase 3
  }, []);

  const handleMatchComplete = useCallback(() => {
    setMatchCount(results.length);
    setShowResults(true);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }, [results.length]);

  useEffect(() => {
    if (!visible) {
      setPhase(0);
      setShowMetrics(false);
      setShowMatchLog(false);
      setShowResults(false);
      setMatchCount(0);
      bgOpacity.value = 0;
      return;
    }

    // 背景淡入
    bgOpacity.value = withTiming(1, { duration: 300 });

    // Phase 1: 雷达扫描
    setPhase(1);

    // Phase 2: 体征分析
    const t1 = setTimeout(() => {
      setPhase(2);
      setShowMetrics(true);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }, PHASE_1_DURATION);

    // Phase 3: 智能匹配日志
    const t2 = setTimeout(() => {
      setPhase(3);
      setShowMatchLog(true);
    }, PHASE_1_DURATION + PHASE_2_DURATION);

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [visible, bgOpacity]);

  const bgAnimatedStyle = useAnimatedStyle(() => ({
    opacity: bgOpacity.value,
  }));

  if (!visible) return null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <Animated.View style={[styles.overlay, bgAnimatedStyle]}>
        <BlurView intensity={40} tint="dark" style={StyleSheet.absoluteFillObject} />

        <View style={styles.content}>
          {/* Phase 1: 雷达扫描 */}
          {phase >= 1 && (
            <View style={styles.radarSection}>
              <RadarRing phase={phase} />

              {/* 坐标数字流 */}
              <View style={styles.coordStream}>
                <Text style={styles.coordText}>34.2635°N  108.9480°E</Text>
                <Text style={styles.coordTextDim}>扫描空域中...</Text>
              </View>
            </View>
          )}

          {/* Phase 2: 体征数据卡片 */}
          {phase >= 2 && (
            <View style={styles.metricsSection}>
              <MetricCard
                label="♥ HR CURRENT"
                value="98"
                unit="bpm"
                delay={0}
                visible={showMetrics}
              />
              <MetricCard
                label="🫁 SpO2 SCAN"
                value="96"
                unit="%"
                delay={200}
                visible={showMetrics}
              />
              <MetricCard
                label="📊 PEI CALC"
                value="42.7"
                unit=""
                delay={400}
                visible={showMetrics}
              />
              <MetricCard
                label="⚡ FITNESS"
                value="A+"
                unit="INDEX"
                delay={600}
                visible={showMetrics}
              />
            </View>
          )}

          {/* Phase 2 → 3: 扫描日志 */}
          {phase >= 2 && phase < 3 && (
            <TerminalStream
              lines={SCAN_LINES}
              active={phase === 2}
              onComplete={handleScanComplete}
            />
          )}

          {/* Phase 3: 匹配日志 */}
          {phase >= 3 && (
            <View style={styles.matchSection}>
              <Text style={styles.matchTitle}>
                {'>'} SMART MATCH ENGINE
              </Text>
              <TerminalStream
                lines={MATCH_LINES}
                active={showMatchLog}
                onComplete={handleMatchComplete}
              />
              {matchCount > 0 && (
                <Text style={styles.matchCountText}>
                  {matchCount} COMPANIONS FOUND ◉
                </Text>
              )}
            </View>
          )}

          {/* Phase 4: 结果列表（可滚动） */}
          {showResults && (
            <ScrollView
              style={styles.resultsSection}
              contentContainerStyle={styles.resultsScrollContent}
              showsVerticalScrollIndicator={false}
              bounces={true}
            >
              {results.slice(0, 5).map((result, i) => (
                <ResultCard
                  key={result.id}
                  result={result}
                  index={i}
                  visible={showResults}
                  onPress={onCardPress}
                />
              ))}

              <TouchableOpacity
                activeOpacity={0.8}
                onPress={onClose}
                style={styles.closeButton}
              >
                <Text style={styles.closeButtonText}>关闭 · CLOSE</Text>
              </TouchableOpacity>
            </ScrollView>
          )}
        </View>
      </Animated.View>
    </Modal>
  );
}

// ============================================================
// 样式
// ============================================================

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(10, 10, 11, 0.95)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  content: {
    flex: 1,
    width: '100%',
    paddingTop: Platform.OS === 'ios' ? 80 : 60,
    paddingHorizontal: 24,
    paddingBottom: 40,
    alignItems: 'center',
  },

  // ---- Phase 1: Radar ----
  radarSection: {
    alignItems: 'center',
    marginBottom: 32,
  },
  radarOuter: {
    width: 180,
    height: 180,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radarRing: {
    position: 'absolute',
    width: 180,
    height: 180,
    borderRadius: 90,
    borderWidth: 2,
    borderColor: 'rgba(16, 185, 129, 0.4)',
  },
  radarInnerRing: {
    position: 'absolute',
    width: 110,
    height: 110,
    borderRadius: 55,
    borderWidth: 1,
    borderColor: 'rgba(16, 185, 129, 0.2)',
  },
  radarCenter: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: '#10B981',
  },
  crosshair: {
    position: 'absolute',
    backgroundColor: 'rgba(16, 185, 129, 0.15)',
  },
  crosshairH: {
    width: 180,
    height: 1,
  },
  crosshairV: {
    width: 1,
    height: 180,
  },
  coordStream: {
    marginTop: 20,
    alignItems: 'center',
  },
  coordText: {
    fontSize: 12,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.5)',
    fontVariant: ['tabular-nums'],
    letterSpacing: 1,
  },
  coordTextDim: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.25)',
    marginTop: 4,
  },

  // ---- Phase 2: Metrics ----
  metricsSection: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 10,
    marginBottom: 24,
    paddingHorizontal: 8,
  },
  metricCard: {
    width: (SCREEN_W - 48 - 30) / 2,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    padding: 14,
    alignItems: 'center',
  },
  metricLabel: {
    fontSize: 10,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.4)',
    letterSpacing: 1,
    marginBottom: 6,
  },
  metricValue: {
    fontSize: 28,
    fontWeight: '800',
    color: '#F3F4F6',
    fontVariant: ['tabular-nums'],
  },
  metricUnit: {
    fontSize: 10,
    color: 'rgba(255,255,255,0.3)',
    marginTop: 2,
  },

  // ---- Phase 3: Match log ----
  matchSection: {
    width: '100%',
    marginBottom: 20,
  },
  matchTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#10B981',
    letterSpacing: 2,
    marginBottom: 12,
    textAlign: 'center',
  },
  matchCountText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#10B981',
    textAlign: 'center',
    marginTop: 12,
    letterSpacing: 1,
  },

  // ---- Terminal ----
  terminalContainer: {
    width: '100%',
    backgroundColor: 'rgba(0,0,0,0.4)',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(16,185,129,0.15)',
    padding: 14,
  },
  terminalLine: {
    fontSize: 12,
    fontWeight: '500',
    color: 'rgba(16,185,129,0.7)',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    lineHeight: 20,
    letterSpacing: 0.5,
  },
  terminalLineActive: {
    fontSize: 12,
    fontWeight: '600',
    color: '#10B981',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    lineHeight: 20,
    letterSpacing: 0.5,
  },
  cursor: {
    color: '#10B981',
    opacity: 0.8,
  },

  // ---- Phase 4: Results ----
  resultsSection: {
    width: '100%',
    flex: 1,
    marginTop: 8,
  },
  resultsScrollContent: {
    paddingBottom: 20,
  },
  resultTouchable: {
    flex: 1,
  },
  resultCard: {
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    padding: 14,
    marginBottom: 10,
  },
  resultHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  resultAvatar: {
    fontSize: 28,
    marginRight: 10,
  },
  resultInfo: {
    flex: 1,
  },
  resultTrail: {
    fontSize: 14,
    fontWeight: '700',
    color: '#F3F4F6',
  },
  resultLeader: {
    fontSize: 11,
    color: '#9CA3AF',
    marginTop: 2,
  },
  scoreBadge: {
    alignItems: 'center',
    borderWidth: 1.5,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  scoreValue: {
    fontSize: 18,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  scoreLabel: {
    fontSize: 9,
    color: '#9CA3AF',
    fontWeight: '600',
  },
  resultTags: {
    flexDirection: 'row',
    marginTop: 10,
    gap: 6,
  },
  tag: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
  },
  tagText: {
    fontSize: 11,
    fontWeight: '600',
  },

  // ---- Close button ----
  closeButton: {
    marginTop: 16,
    alignSelf: 'center',
    paddingHorizontal: 32,
    paddingVertical: 12,
    borderRadius: 24,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  closeButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.6)',
    letterSpacing: 1,
  },
});
