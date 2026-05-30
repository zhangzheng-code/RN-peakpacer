/**
 * ============================================================
 * ExploreScreen — 小红书式瀑布流徒步攻略广场
 * ============================================================
 *
 * Shopify FlashList 双列瀑布流 + 一键导入 GPX 轨迹数据闭环
 */

import React, { useCallback, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Image,
  ScrollView,
  Platform,
} from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import * as Haptics from 'expo-haptics';
import { useHikeStore } from '../store/useHikeStore';

// ---- Types ----

interface RoutePoint {
  latitude: number;
  longitude: number;
}

interface TrailRoute {
  id: string;
  name: string;
  subtitle: string;
  imageUrl: string;
  difficulty: '休闲' | '进阶' | '挑战' | '硬核';
  difficultyColor: string;
  elevationGain: number;
  duration: string;
  distance: number;
  rating: number;
  location: string;
  path: RoutePoint[];
}

// ---- Mock 路线数据库（真实多点坐标） ----

const MOCK_ROUTES: TrailRoute[] = [
  {
    id: 'yubeng',
    name: '雨崩神瀑朝圣线',
    subtitle: '穿越原始森林，抵达梅里雪山脚下的神瀑',
    imageUrl: 'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=600&h=800&fit=crop',
    difficulty: '进阶',
    difficultyColor: '#F59E0B',
    elevationGain: 1200,
    duration: '6h',
    distance: 28,
    rating: 4.9,
    location: '云南·雨崩',
    path: [
      { latitude: 28.4312, longitude: 98.7821 },
      { latitude: 28.4335, longitude: 98.7845 },
      { latitude: 28.4358, longitude: 98.7862 },
      { latitude: 28.4381, longitude: 98.7879 },
      { latitude: 28.4405, longitude: 98.7891 },
      { latitude: 28.4428, longitude: 98.7905 },
      { latitude: 28.4450, longitude: 98.7918 },
      { latitude: 28.4472, longitude: 98.7930 },
      { latitude: 28.4495, longitude: 98.7942 },
      { latitude: 28.4518, longitude: 98.7955 },
    ],
  },
  {
    id: 'taibai',
    name: '太白山铁甲坪穿越',
    subtitle: '秦岭之巅，一日看尽四季风光',
    imageUrl: 'https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?w=600&h=800&fit=crop',
    difficulty: '硬核',
    difficultyColor: '#EF4444',
    elevationGain: 1500,
    duration: '8h',
    distance: 32,
    rating: 4.7,
    location: '陕西·太白',
    path: [
      { latitude: 33.9501, longitude: 107.7612 },
      { latitude: 33.9525, longitude: 107.7638 },
      { latitude: 33.9548, longitude: 107.7661 },
      { latitude: 33.9572, longitude: 107.7685 },
      { latitude: 33.9596, longitude: 107.7708 },
      { latitude: 33.9620, longitude: 107.7730 },
      { latitude: 33.9643, longitude: 107.7752 },
      { latitude: 33.9667, longitude: 107.7775 },
      { latitude: 33.9690, longitude: 107.7798 },
      { latitude: 33.9714, longitude: 107.7820 },
    ],
  },
  {
    id: 'yading',
    name: '稻城亚丁三神山短线',
    subtitle: '蓝色星球上最后一片净土',
    imageUrl: 'https://images.unsplash.com/photo-1501785888041-af3ef285b470?w=600&h=800&fit=crop',
    difficulty: '休闲',
    difficultyColor: '#10B981',
    elevationGain: 800,
    duration: '4.5h',
    distance: 18,
    rating: 4.8,
    location: '四川·稻城',
    path: [
      { latitude: 29.1301, longitude: 100.3215 },
      { latitude: 29.1322, longitude: 100.3238 },
      { latitude: 29.1343, longitude: 100.3260 },
      { latitude: 29.1365, longitude: 100.3282 },
      { latitude: 29.1386, longitude: 100.3305 },
      { latitude: 29.1408, longitude: 100.3328 },
      { latitude: 29.1430, longitude: 100.3350 },
      { latitude: 29.1452, longitude: 100.3372 },
    ],
  },
  {
    id: 'gongga',
    name: '贡嘎西南坡穿越',
    subtitle: '蜀山之王，冰川与云海的极致交响',
    imageUrl: 'https://images.unsplash.com/photo-1483728642387-6c3bdd6c93e5?w=600&h=800&fit=crop',
    difficulty: '硬核',
    difficultyColor: '#EF4444',
    elevationGain: 2200,
    duration: '3天',
    distance: 65,
    rating: 4.9,
    location: '四川·贡嘎',
    path: [
      { latitude: 29.5701, longitude: 101.8812 },
      { latitude: 29.5728, longitude: 101.8835 },
      { latitude: 29.5755, longitude: 101.8858 },
      { latitude: 29.5782, longitude: 101.8880 },
      { latitude: 29.5810, longitude: 101.8902 },
      { latitude: 29.5837, longitude: 101.8925 },
      { latitude: 29.5865, longitude: 101.8948 },
      { latitude: 29.5892, longitude: 101.8970 },
      { latitude: 29.5920, longitude: 101.8992 },
      { latitude: 29.5948, longitude: 101.9015 },
      { latitude: 29.5975, longitude: 101.9038 },
      { latitude: 29.6002, longitude: 101.9060 },
    ],
  },
  {
    id: 'huangshan',
    name: '黄山日出速穿',
    subtitle: '云海之上，迎第一缕金光',
    imageUrl: 'https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05?w=600&h=600&fit=crop',
    difficulty: '休闲',
    difficultyColor: '#10B981',
    elevationGain: 600,
    duration: '3h',
    distance: 12,
    rating: 4.6,
    location: '安徽·黄山',
    path: [
      { latitude: 30.1301, longitude: 118.1612 },
      { latitude: 30.1320, longitude: 118.1635 },
      { latitude: 30.1340, longitude: 118.1658 },
      { latitude: 30.1360, longitude: 118.1680 },
      { latitude: 30.1380, longitude: 118.1702 },
      { latitude: 30.1400, longitude: 118.1725 },
    ],
  },
  {
    id: 'wugong',
    name: '武功山云海反穿',
    subtitle: '万亩高山草甸，星空露营圣地',
    imageUrl: 'https://images.unsplash.com/photo-1551632811-561732d1e306?w=600&h=700&fit=crop',
    difficulty: '进阶',
    difficultyColor: '#F59E0B',
    elevationGain: 1100,
    duration: '7h',
    distance: 24,
    rating: 4.8,
    location: '江西·武功山',
    path: [
      { latitude: 27.4501, longitude: 114.1812 },
      { latitude: 27.4525, longitude: 114.1838 },
      { latitude: 27.4548, longitude: 114.1861 },
      { latitude: 27.4572, longitude: 114.1885 },
      { latitude: 27.4596, longitude: 114.1908 },
      { latitude: 27.4620, longitude: 114.1930 },
      { latitude: 27.4643, longitude: 114.1952 },
      { latitude: 27.4667, longitude: 114.1975 },
    ],
  },
];

const HOT_TAGS = ['#雨崩徒步', '#太白山', '#贡嘎雪山', '#武功山', '#稻城亚丁', '#黄山日出'];

// ---- Card item heights for waterfall effect (alternating) ----

function getCardImageHeight(index: number): number {
  return index % 2 === 0 ? 220 : 180;
}

// ---- Component ----

export default function ExploreScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const importRoutePath = useHikeStore((s) => s.importRoutePath);

  const handleImportRoute = useCallback(
    (route: TrailRoute) => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      importRoutePath(route.path);
      setTimeout(() => {
        navigation.navigate('HikeGo' as never);
      }, 150);
    },
    [importRoutePath, navigation],
  );

  const renderRouteCard = useCallback(
    ({ item, index }: { item: TrailRoute; index: number }) => {
      const imageHeight = getCardImageHeight(index);
      const isLeft = index % 2 === 0;

      return (
        <View style={[styles.card, isLeft ? styles.cardLeft : styles.cardRight]}>
          {/* Hero image */}
          <Image
            source={{ uri: item.imageUrl }}
            style={[styles.cardImage, { height: imageHeight }]}
            resizeMode="cover"
          />

          {/* Difficulty badge */}
          <View style={[styles.badge, { backgroundColor: item.difficultyColor + '20' }]}>
            <Text style={[styles.badgeText, { color: item.difficultyColor }]}>
              {item.difficulty}
            </Text>
          </View>

          {/* Card body */}
          <View style={styles.cardBody}>
            <Text style={styles.routeName} numberOfLines={2}>
              {item.name}
            </Text>
            <Text style={styles.routeLocation}>{item.location}</Text>

            {/* Stats row */}
            <View style={styles.statsRow}>
              <View style={styles.statChip}>
                <Text style={styles.statIcon}>⛰️</Text>
                <Text style={styles.statText}>{item.elevationGain}m</Text>
              </View>
              <View style={styles.statChip}>
                <Text style={styles.statIcon}>⏱️</Text>
                <Text style={styles.statText}>{item.duration}</Text>
              </View>
              <View style={styles.statChip}>
                <Text style={styles.statIcon}>📏</Text>
                <Text style={styles.statText}>{item.distance}km</Text>
              </View>
            </View>

            {/* Rating */}
            <View style={styles.ratingRow}>
              <Text style={styles.ratingStars}>
                {'★'.repeat(Math.floor(item.rating))}
              </Text>
              <Text style={styles.ratingValue}>{item.rating}</Text>
            </View>

            {/* Import button */}
            <TouchableOpacity
              activeOpacity={0.8}
              onPress={() => handleImportRoute(item)}
              style={styles.importButton}
            >
              <Text style={styles.importButtonText}>导入轨迹</Text>
            </TouchableOpacity>
          </View>
        </View>
      );
    },
    [handleImportRoute],
  );

  const keyExtractor = useCallback((item: TrailRoute) => item.id, []);

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Explore</Text>
        <Text style={styles.headerSubtitle}>发现你的下一条传奇路线</Text>
      </View>

      {/* Search box */}
      <View style={styles.searchContainer}>
        <View style={styles.searchBox}>
          <Text style={styles.searchIcon}>🔍</Text>
          <TextInput
            style={styles.searchInput}
            placeholder="搜索路线、地点..."
            placeholderTextColor="#6B7280"
          />
        </View>
      </View>

      {/* Hot tags — horizontal pill scroll */}
      <View style={styles.tagsWrapper}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.tagsContainer}
        >
          {HOT_TAGS.map((tag, i) => (
            <TouchableOpacity
              key={tag}
              activeOpacity={0.7}
              style={[styles.tag, i === 0 && styles.tagActive]}
            >
              <Text style={[styles.tagText, i === 0 && styles.tagTextActive]}>
                {tag}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      {/* Waterfall card list */}
      <FlashList
        data={MOCK_ROUTES}
        renderItem={renderRouteCard}
        keyExtractor={keyExtractor}
        numColumns={2}
        contentContainerStyle={[styles.listContent, { paddingBottom: insets.bottom + 120 }]}
        showsVerticalScrollIndicator={false}
      />
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
  // ---- Search ----
  searchContainer: {
    paddingHorizontal: 20,
    paddingVertical: 8,
  },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1C1E21',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(44,46,48,0.3)',
    paddingHorizontal: 14,
    height: 44,
  },
  searchIcon: {
    fontSize: 16,
    marginRight: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    color: '#F3F4F6',
    paddingVertical: 0,
  },
  // ---- Tags ----
  tagsWrapper: {
    height: 48,
    justifyContent: 'center',
  },
  tagsContainer: {
    paddingHorizontal: 20,
    alignItems: 'center',
    gap: 10,
  },
  tag: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: '#1C1E21',
    borderWidth: 1,
    borderColor: 'rgba(44,46,48,0.5)',
  },
  tagActive: {
    backgroundColor: '#10B981',
    borderColor: '#10B981',
  },
  tagText: {
    fontSize: 13,
    color: '#9CA3AF',
    fontWeight: '500',
  },
  tagTextActive: {
    color: '#FFFFFF',
    fontWeight: '700',
  },
  // ---- List ----
  listContent: {
    paddingHorizontal: 12,
  },
  // ---- Card ----
  card: {
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 20,
    marginBottom: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  cardLeft: {
    marginRight: 6,
  },
  cardRight: {
    marginLeft: 6,
  },
  cardImage: {
    width: '100%',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
  },
  // ---- Badge ----
  badge: {
    position: 'absolute',
    top: 10,
    right: 10,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 10,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '700',
  },
  // ---- Card body ----
  cardBody: {
    padding: 12,
  },
  routeName: {
    fontSize: 14,
    fontWeight: '700',
    color: '#F3F4F6',
    lineHeight: 20,
  },
  routeLocation: {
    fontSize: 11,
    color: '#6B7280',
    marginTop: 3,
  },
  // ---- Stats ----
  statsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 8,
  },
  statChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(23,23,23,0.8)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    gap: 4,
  },
  statIcon: {
    fontSize: 10,
  },
  statText: {
    fontSize: 11,
    color: '#D1D5DB',
    fontWeight: '500',
    fontVariant: ['tabular-nums'],
  },
  // ---- Rating ----
  ratingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 6,
    gap: 4,
  },
  ratingStars: {
    fontSize: 10,
    color: '#F59E0B',
  },
  ratingValue: {
    fontSize: 11,
    color: '#9CA3AF',
    fontWeight: '600',
  },
  // ---- Import button ----
  importButton: {
    marginTop: 10,
    backgroundColor: '#10B981',
    borderRadius: 20,
    paddingVertical: 8,
    alignItems: 'center',
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
  importButtonText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#FFFFFF',
    letterSpacing: 0.5,
  },
});
