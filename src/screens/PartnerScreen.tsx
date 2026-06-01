/**
 * ============================================================
 * PartnerScreen — 曜石黑磨砂约伴卡片 + Reanimated 物理弹性交互
 * ============================================================
 *
 * Dribbble 级暗黑森林风约伴广场
 * - 领队星级资质面板
 * - 按压微弹性缩放（withSpring 阻尼物理）
 * - 一键入队 + GPX 轨迹导入数据闭环
 */

import React, { useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Platform,
} from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import * as Haptics from 'expo-haptics';
import { useHikeStore } from '../store/useHikeStore';

// ---- Types ----

interface RoutePoint {
  latitude: number;
  longitude: number;
}

interface PartnerActivity {
  id: string;
  // Leader info
  leaderName: string;
  leaderAvatar: string;
  leaderTitle: string;
  leaderRating: number;
  leaderTrips: number;
  // Activity info
  trailName: string;
  subtitle: string;
  departDate: string;
  status: '招募中' | '已满员' | '即将出发';
  currentCount: number;
  maxCount: number;
  elevationGain: number;
  distance: number;
  difficulty: '休闲' | '进阶' | '挑战' | '硬核';
  difficultyColor: string;
  // Route data
  path: RoutePoint[];
}

// ---- Mock 约伴数据库（真实多点坐标） ----

const MOCK_PARTNERS: PartnerActivity[] = [
  {
    id: 'yubeng-team',
    leaderName: '野狼',
    leaderAvatar: '🐺',
    leaderTitle: '中登协认证领队',
    leaderRating: 4.9,
    leaderTrips: 42,
    trailName: '雨崩村神瀑周末搭子组',
    subtitle: '穿越原始森林，朝圣梅里雪山神瀑',
    departDate: '06.15',
    status: '招募中',
    currentCount: 4,
    maxCount: 6,
    elevationGain: 1200,
    distance: 28,
    difficulty: '进阶',
    difficultyColor: '#F59E0B',
    path: [
      { latitude: 28.4312, longitude: 98.7821 },
      { latitude: 28.4335, longitude: 98.7845 },
      { latitude: 28.4358, longitude: 98.7862 },
      { latitude: 28.4381, longitude: 98.7879 },
      { latitude: 28.4405, longitude: 98.7891 },
      { latitude: 28.4428, longitude: 98.7905 },
      { latitude: 28.4450, longitude: 98.7918 },
      { latitude: 28.4472, longitude: 98.7930 },
    ],
  },
  {
    id: 'gongga-team',
    leaderName: '阿强',
    leaderAvatar: '🏔️',
    leaderTitle: '国家级领队',
    leaderRating: 5.0,
    leaderTrips: 78,
    trailName: '贡嘎西南坡重装徒步搭子组',
    subtitle: '蜀山之王脚下，冰川与云海的极致交响',
    departDate: '07.01',
    status: '招募中',
    currentCount: 3,
    maxCount: 8,
    elevationGain: 2200,
    distance: 65,
    difficulty: '硬核',
    difficultyColor: '#EF4444',
    path: [
      { latitude: 29.5701, longitude: 101.7612 },
      { latitude: 29.5728, longitude: 101.7635 },
      { latitude: 29.5755, longitude: 101.7658 },
      { latitude: 29.5782, longitude: 101.7680 },
      { latitude: 29.5810, longitude: 101.7702 },
      { latitude: 29.5837, longitude: 101.7725 },
      { latitude: 29.5865, longitude: 101.7748 },
      { latitude: 29.5892, longitude: 101.7770 },
    ],
  },
  {
    id: 'taibai-team',
    leaderName: '飞雪',
    leaderAvatar: '❄️',
    leaderTitle: '秦岭资深向导',
    leaderRating: 4.8,
    leaderTrips: 35,
    trailName: '太白山铁甲坪轻装穿越',
    subtitle: '秦岭之巅，一日看尽四季风光',
    departDate: '06.22',
    status: '即将出发',
    currentCount: 5,
    maxCount: 6,
    elevationGain: 1500,
    distance: 32,
    difficulty: '挑战',
    difficultyColor: '#F97316',
    path: [
      { latitude: 33.9501, longitude: 107.7612 },
      { latitude: 33.9525, longitude: 107.7638 },
      { latitude: 33.9548, longitude: 107.7661 },
      { latitude: 33.9572, longitude: 107.7685 },
      { latitude: 33.9596, longitude: 107.7708 },
      { latitude: 33.9620, longitude: 107.7730 },
    ],
  },
  {
    id: 'wugong-team',
    leaderName: '云海',
    leaderAvatar: '☁️',
    leaderTitle: '草甸露营达人',
    leaderRating: 4.7,
    leaderTrips: 28,
    trailName: '武功山云海星空露营',
    subtitle: '万亩高山草甸，仰望银河的最佳营地',
    departDate: '06.08',
    status: '已满员',
    currentCount: 6,
    maxCount: 6,
    elevationGain: 1100,
    distance: 24,
    difficulty: '休闲',
    difficultyColor: '#10B981',
    path: [
      { latitude: 27.4501, longitude: 114.1812 },
      { latitude: 27.4525, longitude: 114.1838 },
      { latitude: 27.4548, longitude: 114.1861 },
      { latitude: 27.4572, longitude: 114.1885 },
      { latitude: 27.4596, longitude: 114.1908 },
      { latitude: 27.4620, longitude: 114.1930 },
    ],
  },
];

// ---- Animated card wrapper ----

const AnimatedTouchable = Animated.createAnimatedComponent(TouchableOpacity);

function PartnerCard({ activity }: { activity: PartnerActivity }) {
  const importRoutePath = useHikeStore((s) => s.importRoutePath);
  const navigation = useNavigation();

  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePressIn = useCallback(() => {
    scale.value = withSpring(0.97, {
      damping: 15,
      stiffness: 400,
      mass: 0.5,
    });
  }, [scale]);

  const handlePressOut = useCallback(() => {
    scale.value = withSpring(1, {
      damping: 12,
      stiffness: 300,
      mass: 0.8,
    });
  }, [scale]);

  const handleJoin = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    importRoutePath(activity.path);
    setTimeout(() => {
      navigation.navigate('HikeGo' as never);
    }, 150);
  }, [activity.path, importRoutePath, navigation]);

  const isFull = activity.currentCount >= activity.maxCount;
  const statusColor =
    activity.status === '招募中'
      ? '#10B981'
      : activity.status === '即将出发'
        ? '#F59E0B'
        : '#6B7280';

  // Render star rating
  const fullStars = Math.floor(activity.leaderRating);
  const hasHalf = activity.leaderRating % 1 >= 0.5;

  return (
    <AnimatedTouchable
      activeOpacity={0.9}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={[styles.card, animatedStyle]}
    >
      {/* Top: Leader info */}
      <View style={styles.cardHeader}>
        <View style={styles.avatarContainer}>
          <Text style={styles.avatarEmoji}>{activity.leaderAvatar}</Text>
        </View>

        <View style={styles.leaderInfo}>
          <View style={styles.leaderNameRow}>
            <Text style={styles.leaderName}>{activity.leaderName}</Text>
            <View style={styles.titleBadge}>
              <Text style={styles.titleBadgeText}>{activity.leaderTitle}</Text>
            </View>
          </View>

          {/* Star rating */}
          <View style={styles.ratingRow}>
            <Text style={styles.stars}>
              {'★'.repeat(fullStars)}
              {hasHalf ? '☆' : ''}
            </Text>
            <Text style={styles.ratingValue}>{activity.leaderRating}</Text>
            <Text style={styles.tripCount}>{activity.leaderTrips}次带队</Text>
          </View>
        </View>
      </View>

      {/* Middle: Trail info */}
      <View style={styles.cardBody}>
        <Text style={styles.trailName}>{activity.trailName}</Text>
        <Text style={styles.trailSubtitle}>{activity.subtitle}</Text>

        {/* Stats row */}
        <View style={styles.statsRow}>
          <View style={styles.statItem}>
            <Text style={styles.statIcon}>⛰️</Text>
            <Text style={styles.statValue}>{activity.elevationGain}m</Text>
            <Text style={styles.statLabel}>爬升</Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.statItem}>
            <Text style={styles.statIcon}>📏</Text>
            <Text style={styles.statValue}>{activity.distance}km</Text>
            <Text style={styles.statLabel}>距离</Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.statItem}>
            <Text style={styles.statIcon}>📅</Text>
            <Text style={styles.statValue}>{activity.departDate}</Text>
            <Text style={styles.statLabel}>出发</Text>
          </View>
        </View>
      </View>

      {/* Bottom: Status + action */}
      <View style={styles.cardFooter}>
        <View style={styles.statusContainer}>
          <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
          <Text style={[styles.statusText, { color: statusColor }]}>
            {activity.status}
          </Text>
          <Text style={styles.slotText}>
            {activity.currentCount}/{activity.maxCount}人
          </Text>

          {/* Difficulty badge */}
          <View style={[styles.diffBadge, { backgroundColor: activity.difficultyColor + '20' }]}>
            <Text style={[styles.diffBadgeText, { color: activity.difficultyColor }]}>
              {activity.difficulty}
            </Text>
          </View>
        </View>

        {/* Join button */}
        <TouchableOpacity
          activeOpacity={0.8}
          onPress={handleJoin}
          disabled={isFull}
          style={[styles.joinButton, isFull && styles.joinButtonDisabled]}
        >
          <Text style={[styles.joinButtonText, isFull && styles.joinButtonTextDisabled]}>
            {isFull ? '已满员' : '加入同队'}
          </Text>
        </TouchableOpacity>
      </View>
    </AnimatedTouchable>
  );
}

// ---- Main component ----

export default function PartnerScreen() {
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Partner</Text>
        <Text style={styles.headerSubtitle}>找到你的山野搭子</Text>
      </View>

      {/* Smart match banner */}
      <View style={styles.matchBanner}>
        <Text style={styles.matchIcon}>🤝</Text>
        <View style={styles.matchInfo}>
          <Text style={styles.matchTitle}>智能匹配</Text>
          <Text style={styles.matchDesc}>根据体能、偏好、时间自动推荐搭子</Text>
        </View>
      </View>

      {/* Section title */}
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>正在约伴</Text>
        <Text style={styles.sectionAction}>查看全部</Text>
      </View>

      {/* Partner cards */}
      <Animated.ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          { paddingBottom: insets.bottom + 120 },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {MOCK_PARTNERS.map((activity) => (
          <PartnerCard key={activity.id} activity={activity} />
        ))}
      </Animated.ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#121314',
  },
  // ---- Header ----
  header: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 8,
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: '800',
    color: '#F3F4F6',
    letterSpacing: -0.5,
  },
  headerSubtitle: {
    fontSize: 13,
    color: '#6B7280',
    marginTop: 2,
  },
  // ---- Match banner ----
  matchBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 20,
    marginVertical: 12,
    padding: 16,
    borderRadius: 16,
    backgroundColor: 'rgba(16,185,129,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(16,185,129,0.15)',
  },
  matchIcon: {
    fontSize: 28,
    marginRight: 14,
  },
  matchInfo: {
    flex: 1,
  },
  matchTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#10B981',
  },
  matchDesc: {
    fontSize: 12,
    color: '#6B7280',
    marginTop: 2,
  },
  // ---- Section ----
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    marginBottom: 8,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#F3F4F6',
  },
  sectionAction: {
    fontSize: 12,
    color: '#10B981',
    fontWeight: '500',
  },
  // ---- Scroll ----
  scrollContent: {
    paddingHorizontal: 16,
    paddingTop: 4,
  },
  // ---- Card ----
  card: {
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 20,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    overflow: 'hidden',
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.2,
        shadowRadius: 12,
      },
      android: {
        elevation: 6,
      },
    }),
  },
  // ---- Card header (leader) ----
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    paddingBottom: 12,
  },
  avatarContainer: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: 'rgba(255,255,255,0.06)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  avatarEmoji: {
    fontSize: 24,
  },
  leaderInfo: {
    flex: 1,
    marginLeft: 12,
  },
  leaderNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  leaderName: {
    fontSize: 16,
    fontWeight: '700',
    color: '#F3F4F6',
  },
  titleBadge: {
    backgroundColor: 'rgba(16,185,129,0.12)',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(16,185,129,0.2)',
  },
  titleBadgeText: {
    fontSize: 10,
    fontWeight: '600',
    color: '#10B981',
  },
  ratingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
    gap: 4,
  },
  stars: {
    fontSize: 12,
    color: '#F59E0B',
  },
  ratingValue: {
    fontSize: 13,
    fontWeight: '700',
    color: '#F59E0B',
  },
  tripCount: {
    fontSize: 11,
    color: '#6B7280',
    marginLeft: 8,
  },
  // ---- Card body (trail) ----
  cardBody: {
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  trailName: {
    fontSize: 15,
    fontWeight: '700',
    color: '#F3F4F6',
    lineHeight: 22,
  },
  trailSubtitle: {
    fontSize: 12,
    color: '#6B7280',
    marginTop: 3,
    lineHeight: 18,
  },
  statsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    marginTop: 12,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.04)',
  },
  statItem: {
    alignItems: 'center',
    flex: 1,
  },
  statIcon: {
    fontSize: 14,
    marginBottom: 2,
  },
  statValue: {
    fontSize: 15,
    fontWeight: '700',
    color: '#E5E7EB',
    fontVariant: ['tabular-nums'],
  },
  statLabel: {
    fontSize: 10,
    color: '#6B7280',
    marginTop: 1,
  },
  statDivider: {
    width: 1,
    height: 28,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  // ---- Card footer ----
  cardFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 16,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.04)',
  },
  statusContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  statusText: {
    fontSize: 12,
    fontWeight: '600',
  },
  slotText: {
    fontSize: 12,
    color: '#9CA3AF',
    fontVariant: ['tabular-nums'],
  },
  diffBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
    marginLeft: 4,
  },
  diffBadgeText: {
    fontSize: 10,
    fontWeight: '700',
  },
  // ---- Join button ----
  joinButton: {
    backgroundColor: '#10B981',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 20,
    ...Platform.select({
      ios: {
        shadowColor: '#10B981',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.3,
        shadowRadius: 6,
      },
      android: {
        elevation: 4,
      },
    }),
  },
  joinButtonDisabled: {
    backgroundColor: 'rgba(107,114,128,0.2)',
  },
  joinButtonText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  joinButtonTextDisabled: {
    color: '#6B7280',
  },
});
