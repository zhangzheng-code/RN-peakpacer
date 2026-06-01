/**
 * ============================================================
 * FootprintsScreen — 个人足迹档案
 * ============================================================
 *
 * 游戏化暗黑风设计：
 * - SVG 圆环进度：已探索网格百分比
 * - 统计胶囊卡片：总里程 / 累计爬升 / 徒步次数
 * - FlashList 历史轨迹列表（60fps）
 * - 点击历史轨迹 → Haptic + 导入路线到地图
 */

import React, { useMemo, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FlashList } from '@shopify/flash-list';
import Svg, { Circle } from 'react-native-svg';
import * as Haptics from 'expo-haptics';
import { useNavigation } from '@react-navigation/native';
import { useHikeStore } from '../store/useHikeStore';
import { useShallow } from 'zustand/shallow';
import type { HistoryTrack } from '../types';

// ============================================================
// 常量
// ============================================================

const C = {
  bg: '#121314',
  card: 'rgba(255,255,255,0.04)',
  cardBorder: 'rgba(255,255,255,0.06)',
  textPrimary: '#F3F4F6',
  textSecondary: '#9CA3AF',
  textMuted: '#6B7280',
  accent: '#10B981',
  accentDim: 'rgba(16,185,129,0.15)',
  blue: '#3B82F6',
  amber: '#F59E0B',
} as const;

/** 圆环 SVG 参数 */
const RING_SIZE = 140;
const RING_STROKE = 10;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** 秦岭核心区大约覆盖的网格数（用于百分比计算） */
const TOTAL_GRIDS_ESTIMATE = 2000;

// ============================================================
// 工具函数
// ============================================================

function formatDistance(meters: number): string {
  if (meters >= 1000) return `${(meters / 1000).toFixed(1)}km`;
  return `${Math.round(meters)}m`;
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatDate(timestamp: number): string {
  const d = new Date(timestamp);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

// ============================================================
// 子组件
// ============================================================

/** SVG 圆环进度条 */
function ProgressRing({ percentage }: { percentage: number }) {
  const clamped = Math.min(100, Math.max(0, percentage));
  const offset = RING_CIRCUMFERENCE * (1 - clamped / 100);

  return (
    <View style={ringStyles.container}>
      <Svg width={RING_SIZE} height={RING_SIZE}>
        {/* 底环 */}
        <Circle
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={RING_RADIUS}
          stroke="rgba(255,255,255,0.06)"
          strokeWidth={RING_STROKE}
          fill="none"
        />
        {/* 进度弧 */}
        <Circle
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={RING_RADIUS}
          stroke={C.accent}
          strokeWidth={RING_STROKE}
          fill="none"
          strokeDasharray={RING_CIRCUMFERENCE}
          strokeDashoffset={offset}
          strokeLinecap="round"
          rotation="-90"
          origin={`${RING_SIZE / 2}, ${RING_SIZE / 2}`}
        />
      </Svg>
      {/* 中心文字 */}
      <View style={ringStyles.center}>
        <Text style={ringStyles.pctValue}>{clamped.toFixed(1)}%</Text>
        <Text style={ringStyles.pctLabel}>已探索</Text>
      </View>
    </View>
  );
}

const ringStyles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  center: {
    position: 'absolute',
    alignItems: 'center',
  },
  pctValue: {
    fontSize: 26,
    fontWeight: '800',
    color: C.accent,
    fontVariant: ['tabular-nums'],
  },
  pctLabel: {
    fontSize: 11,
    color: C.textMuted,
    marginTop: 2,
  },
});

/** 统计胶囊卡片 */
function StatCapsule({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <View style={capsuleStyles.card}>
      <Text style={capsuleStyles.value}>
        {value}
        <Text style={capsuleStyles.unit}> {unit}</Text>
      </Text>
      <Text style={capsuleStyles.label}>{label}</Text>
    </View>
  );
}

const capsuleStyles = StyleSheet.create({
  card: {
    flex: 1,
    backgroundColor: C.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: C.cardBorder,
    paddingVertical: 14,
    paddingHorizontal: 12,
    alignItems: 'center',
  },
  value: {
    fontSize: 20,
    fontWeight: '800',
    color: C.textPrimary,
    fontVariant: ['tabular-nums'],
  },
  unit: {
    fontSize: 11,
    fontWeight: '400',
    color: C.textMuted,
  },
  label: {
    fontSize: 11,
    color: C.textMuted,
    marginTop: 4,
  },
});

/** 历史轨迹卡片 */
function TrackCard({ track, onPress }: { track: HistoryTrack; onPress: () => void }) {
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.7} style={trackStyles.card}>
      <View style={trackStyles.topRow}>
        <View style={trackStyles.dot} />
        <Text style={trackStyles.date}>{formatDate(track.startTime)}</Text>
        <Text style={trackStyles.duration}>{formatDuration(track.duration)}</Text>
      </View>
      <View style={trackStyles.statsRow}>
        <Text style={trackStyles.stat}>🏃 {formatDistance(track.totalDistance)}</Text>
        <Text style={trackStyles.stat}>⛰️ {Math.round(track.elevationGain)}m</Text>
        <Text style={trackStyles.stat}>📍 {track.trailPoints.length} 点</Text>
      </View>
    </TouchableOpacity>
  );
}

const trackStyles = StyleSheet.create({
  card: {
    backgroundColor: C.card,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: C.cardBorder,
    padding: 16,
    marginBottom: 10,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: C.accent,
    marginRight: 8,
  },
  date: {
    fontSize: 14,
    fontWeight: '600',
    color: C.textPrimary,
    flex: 1,
  },
  duration: {
    fontSize: 12,
    fontWeight: '600',
    color: C.textSecondary,
    fontVariant: ['tabular-nums'],
  },
  statsRow: {
    flexDirection: 'row',
    gap: 16,
  },
  stat: {
    fontSize: 12,
    color: C.textMuted,
  },
});

// ============================================================
// 主屏幕
// ============================================================

export default function FootprintsScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();

  // ---- Zustand 精细 Selector 订阅 ----
  const exploredGrids = useHikeStore(useShallow((s) => s.exploredGrids));
  const historyTracks = useHikeStore(useShallow((s) => s.historyTracks));
  const importRoutePath = useHikeStore((s) => s.importRoutePath);

  // ---- 派生统计数据 ----
  const stats = useMemo(() => {
    const totalDistance = historyTracks.reduce((sum, t) => sum + t.totalDistance, 0);
    const totalElevation = historyTracks.reduce((sum, t) => sum + t.elevationGain, 0);
    const hikeCount = historyTracks.length;
    const exploredCount = exploredGrids.length;
    const exploredPct = (exploredCount / TOTAL_GRIDS_ESTIMATE) * 100;
    return { totalDistance, totalElevation, hikeCount, exploredCount, exploredPct };
  }, [historyTracks, exploredGrids]);

  // ---- 点击历史轨迹 → 导入路线 + 跳转地图 ----
  const handleTrackPress = useCallback(
    (track: HistoryTrack) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      const coords = track.trailPoints.map((p) => ({
        latitude: p.latitude,
        longitude: p.longitude,
      }));
      importRoutePath(coords);
      (navigation as any).navigate('HikeGo');
    },
    [navigation, importRoutePath],
  );

  // ---- FlashList 渲染 ----
  const renderTrack = useCallback(
    ({ item }: { item: HistoryTrack }) => (
      <TrackCard track={item} onPress={() => handleTrackPress(item)} />
    ),
    [handleTrackPress],
  );

  const trackKeyExtractor = useCallback((item: HistoryTrack) => item.id, []);

  // ---- 空状态 ----
  const ListEmpty = useMemo(
    () => (
      <View style={styles.emptyArea}>
        <Text style={styles.emptyIcon}>🏔️</Text>
        <Text style={styles.emptyTitle}>尚无徒步记录</Text>
        <Text style={styles.emptySub}>开始你的第一次山野探索吧</Text>
      </View>
    ),
    [],
  );

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Footprints</Text>
        <Text style={styles.headerSub}>你的山野足迹档案</Text>
      </View>

      {/* Stats Dashboard */}
      <View style={styles.dashboard}>
        {/* 圆环进度 */}
        <ProgressRing percentage={stats.exploredPct} />

        {/* 右侧统计胶囊 */}
        <View style={styles.capsuleCol}>
          <StatCapsule
            label="总里程"
            value={formatDistance(stats.totalDistance).replace(/[a-z]+/i, '')}
            unit={formatDistance(stats.totalDistance).match(/[a-z]+/i)?.[0] || ''}
          />
          <StatCapsule
            label="累计爬升"
            value={String(Math.round(stats.totalElevation))}
            unit="m"
          />
          <StatCapsule
            label="徒步次数"
            value={String(stats.hikeCount)}
            unit="次"
          />
        </View>
      </View>

      {/* Section Header */}
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>最近徒步</Text>
        <Text style={styles.sectionCount}>{stats.hikeCount} 条记录</Text>
      </View>

      {/* History List */}
      <FlashList
        data={historyTracks}
        renderItem={renderTrack}
        keyExtractor={trackKeyExtractor}
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingBottom: insets.bottom + 120,
        }}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={ListEmpty}
      />
    </View>
  );
}

// ============================================================
// 样式表
// ============================================================

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: C.bg,
  },
  header: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 8,
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: '800',
    color: C.textPrimary,
    letterSpacing: -0.5,
  },
  headerSub: {
    fontSize: 13,
    color: C.textMuted,
    marginTop: 2,
  },
  dashboard: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 16,
    gap: 20,
  },
  capsuleCol: {
    flex: 1,
    gap: 8,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: C.textPrimary,
  },
  sectionCount: {
    fontSize: 12,
    color: C.textMuted,
  },
  emptyArea: {
    alignItems: 'center',
    paddingTop: 60,
  },
  emptyIcon: {
    fontSize: 48,
    marginBottom: 12,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: C.textPrimary,
  },
  emptySub: {
    fontSize: 13,
    color: C.textMuted,
    marginTop: 4,
  },
});
