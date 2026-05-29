import './global.css';

import React, { useEffect, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Animated,
  Platform,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { BlurView } from 'expo-blur';
import {
  NavigationContainer,
  createNavigationContainerRef,
} from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import * as Haptics from 'expo-haptics';

import ExploreScreen from './src/screens/ExploreScreen';
import AIGuideScreen from './src/screens/AIGuideScreen';
import HikeGoScreen from './src/screens/HikeGoScreen';
import PartnerScreen from './src/screens/PartnerScreen';
import FootprintsScreen from './src/screens/FootprintsScreen';
import CustomCurvedTabBar from './src/components/CustomCurvedTabBar';
import { useHikeStore } from './src/store/useHikeStore';

const Tab = createBottomTabNavigator();
const navigationRef = createNavigationContainerRef();

/**
 * Global suspended capsule pill
 * Renders when: hikeStatus === 'recording' && currentTab !== 'HikeGo'
 */
function SuspendedPill() {
  const insets = useSafeAreaInsets();
  const hikeStatus = useHikeStore((s) => s.hikeStatus);
  const currentTab = useHikeStore((s) => s.currentTab);
  const pulseAnim = useRef(new Animated.Value(0)).current;

  const isTracking = hikeStatus === 'recording';
  const isOnHikeGo = currentTab === 'HikeGo';
  const shouldShow = isTracking && !isOnHikeGo;

  // Breathing pulse animation
  useEffect(() => {
    if (shouldShow) {
      const anim = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 1200,
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 0,
            duration: 1200,
            useNativeDriver: true,
          }),
        ]),
      );
      anim.start();
      return () => anim.stop();
    } else {
      pulseAnim.setValue(0);
    }
  }, [shouldShow, pulseAnim]);

  const glowOpacity = pulseAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0.15, 0.45],
  });

  const glowScale = pulseAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 1.08],
  });

  const handlePress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    if (navigationRef.isReady()) {
      navigationRef.navigate('HikeGo' as never);
    }
  };

  if (!shouldShow) return null;

  return (
    <View
      style={[
        pillStyles.wrapper,
        { top: insets.top + 8 },
      ]}
      pointerEvents="box-none"
    >
      {/* Breathing glow behind the pill */}
      <Animated.View
        style={[
          pillStyles.glow,
          {
            opacity: glowOpacity,
            transform: [{ scale: glowScale }],
          },
        ]}
      />

      <TouchableOpacity
        activeOpacity={0.85}
        onPress={handlePress}
        style={pillStyles.touchable}
      >
        <BlurView intensity={30} tint="dark" style={pillStyles.blurContainer}>
          <View style={pillStyles.inner}>
            {/* Pulsing green dot */}
            <Animated.View
              style={[
                pillStyles.dot,
                {
                  opacity: pulseAnim.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0.6, 1],
                  }),
                  transform: [{ scale: glowScale }],
                },
              ]}
            />
            <Text style={pillStyles.label}>徒步记录中</Text>
            <Text style={pillStyles.arrow}>返回地图 ›</Text>
          </View>
        </BlurView>
      </TouchableOpacity>
    </View>
  );
}

const pillStyles = StyleSheet.create({
  wrapper: {
    position: 'absolute',
    left: 20,
    right: 20,
    zIndex: 9999,
    elevation: 99,
    alignItems: 'center',
  },
  glow: {
    position: 'absolute',
    top: -4,
    left: -8,
    right: -8,
    bottom: -4,
    borderRadius: 28,
    backgroundColor: '#10B981',
  },
  touchable: {
    width: '100%',
    borderRadius: 24,
    overflow: 'hidden',
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 12,
      },
      android: {
        elevation: 16,
      },
    }),
  },
  blurContainer: {
    borderRadius: 24,
    overflow: 'hidden',
  },
  inner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 12,
    backgroundColor: 'rgba(0,0,0,0.7)',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: 'rgba(16,185,129,0.3)',
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#10B981',
    marginRight: 10,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    color: '#F3F4F6',
    flex: 1,
  },
  arrow: {
    fontSize: 13,
    fontWeight: '500',
    color: '#10B981',
  },
});

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <NavigationContainer ref={navigationRef}>
        <Tab.Navigator
          tabBar={(props) => <CustomCurvedTabBar {...props} />}
          screenOptions={{
            headerShown: false,
          }}
          sceneContainerStyle={{ backgroundColor: '#121314' }}
        >
          <Tab.Screen name="Explore" component={ExploreScreen} />
          <Tab.Screen name="AIGuide" component={AIGuideScreen} />
          <Tab.Screen
            name="HikeGo"
            component={HikeGoScreen}
            options={{ lazy: false }}
          />
          <Tab.Screen name="Partner" component={PartnerScreen} />
          <Tab.Screen name="Footprints" component={FootprintsScreen} />
        </Tab.Navigator>

        {/* Global suspended pill overlay */}
        <SuspendedPill />
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
