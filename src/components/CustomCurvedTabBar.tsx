import React, { useEffect, useRef } from 'react';
import {
  View,
  TouchableOpacity,
  Text,
  StyleSheet,
  Animated,
  Dimensions,
  Platform,
} from 'react-native';
import { BlurView } from 'expo-blur';
import Svg, { Path } from 'react-native-svg';
import * as Haptics from 'expo-haptics';
import { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useHikeStore } from '../store/useHikeStore';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

const BAR_HEIGHT = 70;
const CORNER_RADIUS = 20;
const NOTCH_RADIUS = 28;
const NOTCH_DEPTH = 30;
const FAB_RADIUS = 28;
const ICON_SIZE = 22;
const LABEL_FONT = 10;

const ACCENT = '#10B981';
const BG_COLOR = 'rgba(24, 26, 27, 0.85)';
const INACTIVE_COLOR = '#6B7280';

const TAB_CONFIG = [
  { key: 'Explore', label: '探索', icon: '🧭' },
  { key: 'AIGuide', label: 'AI 领队', icon: '🤖' },
  { key: 'HikeGo', label: 'Hike', icon: '🥾' },
  { key: 'Partner', label: '约伴', icon: '🤝' },
  { key: 'Footprints', label: '足迹', icon: '👣' },
];

const HIDE_TRANSLATE_Y = 120;

export default function CustomCurvedTabBar({
  state,
  descriptors,
  navigation,
}: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  const glowAnim = useRef(new Animated.Value(0)).current;
  const hideAnim = useRef(new Animated.Value(0)).current;

  const W = SCREEN_WIDTH;
  const H = BAR_HEIGHT;
  const R = CORNER_RADIUS;
  const NR = NOTCH_RADIUS;
  const ND = NOTCH_DEPTH;
  const cx = W / 2;

  // ---- Subscribe to Zustand isTabBarVisible ----
  const isTabBarVisible = useHikeStore((s) => s.isTabBarVisible);
  const setCurrentTab = useHikeStore((s) => s.setCurrentTab);

  // ---- Animate tab bar hide/show ----
  useEffect(() => {
    Animated.spring(hideAnim, {
      toValue: isTabBarVisible ? 0 : HIDE_TRANSLATE_Y,
      useNativeDriver: true,
      tension: 60,
      friction: 10,
    }).start();
  }, [isTabBarVisible, hideAnim]);

  // ---- Track current tab in Zustand ----
  useEffect(() => {
    const currentRoute = state.routes[state.index];
    if (currentRoute) {
      setCurrentTab(currentRoute.name);
    }
  }, [state.index, state.routes, setCurrentTab]);

  // Notch geometry: semicircle dip at the top edge center
  const notchLeftX = cx - NR;
  const notchRightX = cx + NR;
  const cpOffset = NR * 0.5523;

  // SVG path: bar outline with notch cut out of the top edge
  const barPath = [
    `M ${R} 0`,
    `L ${notchLeftX} 0`,
    `C ${notchLeftX - cpOffset} 0, ${notchLeftX - cpOffset} ${ND}, ${cx} ${ND}`,
    `C ${notchRightX + cpOffset} ${ND}, ${notchRightX + cpOffset} 0, ${notchRightX} 0`,
    `L ${W - R} 0`,
    `Q ${W} 0, ${W} ${R}`,
    `L ${W} ${H}`,
    `L 0 ${H}`,
    `L 0 ${R}`,
    `Q ${R} 0, ${R} 0`,
    'Z',
  ].join(' ');

  // FAB position: center of semicircle, overlapping the bar top
  const fabCenterY = ND;

  // Breathing glow animation for HikeGo active state
  const activeIndex = state.index;
  const isHikeActive = state.routes[activeIndex]?.name === 'HikeGo';

  useEffect(() => {
    if (isHikeActive) {
      const animation = Animated.loop(
        Animated.sequence([
          Animated.timing(glowAnim, {
            toValue: 1,
            duration: 1000,
            useNativeDriver: true,
          }),
          Animated.timing(glowAnim, {
            toValue: 0,
            duration: 1000,
            useNativeDriver: true,
          }),
        ]),
      );
      animation.start();
      return () => animation.stop();
    } else {
      glowAnim.setValue(0);
    }
  }, [isHikeActive, glowAnim]);

  const glowOpacity = glowAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0.3, 0.8],
  });

  const glowScale = glowAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 1.35],
  });

  const handleTabPress = (
    routeName: string,
    routeKey: string,
    isFocused: boolean,
  ) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (!isFocused) {
      navigation.navigate(routeName);
    }
  };

  // Split tabs: left 2, center FAB, right 2
  const leftTabs = TAB_CONFIG.slice(0, 2);
  const rightTabs = TAB_CONFIG.slice(3);

  const renderTab = (config: (typeof TAB_CONFIG)[number], index: number) => {
    const route = state.routes.find((r) => r.name === config.key);
    if (!route) return null;
    const isFocused = state.routes[state.index]?.name === config.key;

    return (
      <TouchableOpacity
        key={config.key}
        activeOpacity={0.7}
        onPress={() => handleTabPress(route.name, route.key, isFocused)}
        style={styles.tabButton}
      >
        <Text style={[styles.tabIcon, { opacity: isFocused ? 1 : 0.5 }]}>
          {config.icon}
        </Text>
        <Text
          style={[
            styles.tabLabel,
            { color: isFocused ? ACCENT : INACTIVE_COLOR },
          ]}
        >
          {config.label}
        </Text>
      </TouchableOpacity>
    );
  };

  const hikeRoute = state.routes.find((r) => r.name === 'HikeGo');
  const isHikeFocused = state.routes[state.index]?.name === 'HikeGo';

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[
        styles.container,
        {
          paddingBottom: insets.bottom,
          height: H + insets.bottom,
          transform: [{ translateY: hideAnim }],
        },
      ]}
    >
      {/* Bar background with SVG notch */}
      <Svg width={W} height={H} style={styles.svgBackground} pointerEvents="none">
        <Path d={barPath} fill={BG_COLOR} />
      </Svg>

      {/* Glass blur overlay */}
      <BlurView
        intensity={40}
        tint="dark"
        pointerEvents="none"
        style={[styles.blurOverlay, { width: W, height: H }]}
      />

      {/* Tab buttons row: left 2 | spacer | right 2 */}
      <View style={[styles.tabsRow, { width: W, height: H }]}>
        <View style={styles.sideGroup}>
          {leftTabs.map((cfg, i) => renderTab(cfg, i))}
        </View>
        <View style={styles.centerSpacer} />
        <View style={styles.sideGroup}>
          {rightTabs.map((cfg, i) => renderTab(cfg, i + 3))}
        </View>
      </View>

      {/* Floating Action Button — centered in notch */}
      <View
        style={[
          styles.fabWrapper,
          {
            left: cx - FAB_RADIUS,
            top: fabCenterY - FAB_RADIUS,
          },
        ]}
      >
        {/* Breathing glow ring (only when HikeGo active) */}
        <Animated.View
          style={[
            styles.fabGlow,
            {
              opacity: glowOpacity,
              transform: [{ scale: glowScale }],
            },
          ]}
        />
        <TouchableOpacity
          activeOpacity={0.8}
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            if (hikeRoute && !isHikeFocused) {
              navigation.navigate(hikeRoute.name);
            }
          }}
          style={[
            styles.fabButton,
            isHikeFocused && styles.fabButtonActive,
          ]}
        >
          <Text style={styles.fabIcon}>🥾</Text>
          <Text style={styles.fabLabel}>Hike</Text>
        </TouchableOpacity>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: 'transparent',
    zIndex: 999,
    elevation: 100,
  },
  svgBackground: {
    position: 'absolute',
    top: 0,
    left: 0,
  },
  blurOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    overflow: 'hidden',
    borderTopLeftRadius: CORNER_RADIUS,
    borderTopRightRadius: CORNER_RADIUS,
  },
  tabsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    position: 'absolute',
    top: 0,
    left: 0,
  },
  sideGroup: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
  },
  centerSpacer: {
    width: FAB_RADIUS * 2 + 16,
  },
  tabButton: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    flex: 1,
  },
  tabIcon: {
    fontSize: ICON_SIZE,
  },
  tabLabel: {
    fontSize: LABEL_FONT,
    marginTop: 2,
    fontWeight: '500',
  },
  fabWrapper: {
    position: 'absolute',
    width: FAB_RADIUS * 2,
    height: FAB_RADIUS * 2,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
  },
  fabGlow: {
    position: 'absolute',
    width: FAB_RADIUS * 2 + 20,
    height: FAB_RADIUS * 2 + 20,
    borderRadius: FAB_RADIUS + 10,
    backgroundColor: ACCENT,
    ...Platform.select({
      ios: {
        shadowColor: ACCENT,
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.6,
        shadowRadius: 16,
      },
      android: {
        elevation: 12,
      },
    }),
  },
  fabButton: {
    width: FAB_RADIUS * 2,
    height: FAB_RADIUS * 2,
    borderRadius: FAB_RADIUS,
    backgroundColor: ACCENT,
    alignItems: 'center',
    justifyContent: 'center',
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 8,
      },
      android: {
        elevation: 8,
      },
    }),
  },
  fabButtonActive: {
    backgroundColor: '#059669',
  },
  fabIcon: {
    fontSize: 20,
  },
  fabLabel: {
    fontSize: 9,
    color: '#fff',
    fontWeight: '700',
    marginTop: 1,
  },
});
