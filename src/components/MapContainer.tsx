import React, { useState, useEffect, useCallback, useRef, useMemo, memo } from 'react';
import { StyleSheet, View, Text, TouchableOpacity, Alert, ActivityIndicator, Modal, Pressable } from 'react-native';
import MapView, { UrlTile, Polyline } from 'react-native-maps';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  runOnJS,
} from 'react-native-reanimated';
import { BlurView } from 'expo-blur';
import * as Location from 'expo-location';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GpsKalmanFilter, processTrail } from '../utils/gpsFilter';
import {
  startBackgroundLocation,
  stopBackgroundLocation,
  getTrailBuffer,
  resetTrailBuffer,
  getTotalDistance,
} from '../tasks/backgroundLocationTask';
import { useHikeStore } from '../store/useHikeStore';
import BiometricsPanel from './BiometricsPanel';
import SafetyAlert from './SafetyAlert';
import StatsHUD from './StatsHUD';
import PEIOrb from './PEIOrb';
import FloatingButtons from './FloatingButtons';
import ExplorationGrids from './ExplorationGrids';
import AIChatScreen from '../screens/AIChatScreen';
import type { TileSourceConfig, TileSourceType, UserLocation, TrailPoint } from '../types';

const TILE_SOURCES: Record<TileSourceType, TileSourceConfig> = {
  standard: {
    urlTemplate:
      'https://webrd01.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=7&x={x}&y={y}&z={z}',
    label: '标准路网',
    type: 'standard',
  },
  satellite: {
    urlTemplate:
      'https://webst01.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}',
    label: '卫星图',
    type: 'satellite',
  },
};

const INITIAL_REGION = {
  latitude: 34.2635,
  longitude: 108.948,
  latitudeDelta: 0.0922,
  longitudeDelta: 0.0421,
};

const POLL_INTERVAL_MS = 1000;
const RDP_EPSILON = 10;
const GPS_TIMEOUT_MS = 5000;
const DEBUG_DEFAULT_LOCATION: UserLocation = { latitude: 30.25, longitude: 120.15 };

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

function MapContainer() {
  const insets = useSafeAreaInsets();

  // ---- Zustand selector subscriptions ----
  const hikeStatus = useHikeStore((s) => s.hikeStatus);
  const currentPath = useHikeStore((s) => s.currentPath);
  const totalDistance = useHikeStore((s) => s.totalDistance);
  const startTime = useHikeStore((s) => s.startTime);
  const elevationGain = useHikeStore((s) => s.elevationGain);
  const storeStartHike = useHikeStore((s) => s.startHike);
  const storeStopHike = useHikeStore((s) => s.stopHike);
  const appendTrailPoints = useHikeStore((s) => s.appendTrailPoints);
  const setTotalDistance = useHikeStore((s) => s.setTotalDistance);
  const setElevationGain = useHikeStore((s) => s.setElevationGain);
  const exploreGridsBatch = useHikeStore((s) => s.exploreGridsBatch);

  const [activeSource, setActiveSource] = useState<TileSourceType>('standard');
  const [userLocation, setUserLocation] = useState<UserLocation | null>(null);
  const [hasLocationPermission, setHasLocationPermission] = useState(false);
  const [displayPoints, setDisplayPoints] = useState<TrailPoint[]>([]);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [isAIChatVisible, setIsAIChatVisible] = useState(false);
  const [loadingDismissed, setLoadingDismissed] = useState(false);

  const foregroundFilterRef = useRef<GpsKalmanFilter>(new GpsKalmanFilter());
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mapRef = useRef<MapView>(null);

  // ---- Reanimated loading overlay fade ----
  const loadingOpacity = useSharedValue(1);

  const loadingAnimatedStyle = useAnimatedStyle(() => ({
    opacity: loadingOpacity.value,
    pointerEvents: loadingOpacity.value > 0.01 ? 'auto' : 'none',
  }));

  const dismissLoadingOverlay = useCallback(() => {
    loadingOpacity.value = withTiming(0, { duration: 300 }, (finished) => {
      if (finished) {
        runOnJS(setLoadingDismissed)(true);
      }
    });
  }, [loadingOpacity]);

  const isRecording = hikeStatus === 'recording';

  // ---- Debug bypass: double-tap loading overlay to mock location ----
  const lastTapRef = useRef(0);
  const handleLoadingDoubleTap = useCallback(() => {
    const now = Date.now();
    if (now - lastTapRef.current < 300) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setUserLocation(DEBUG_DEFAULT_LOCATION);
      dismissLoadingOverlay();
      mapRef.current?.animateToRegion({
        ...DEBUG_DEFAULT_LOCATION,
        latitudeDelta: 0.0922,
        longitudeDelta: 0.0421,
      }, 500);
    }
    lastTapRef.current = now;
  }, [dismissLoadingOverlay]);

  // ---- Location permission with timeout & fallback ----
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (cancelled) return;

        if (status !== 'granted') {
          Alert.alert('定位权限未授予', '请在系统设置中允许 SmartHike 访问您的位置。', [
            { text: '知道了' },
          ]);
          dismissLoadingOverlay();
          return;
        }

        setHasLocationPermission(true);

        // Try balanced accuracy with 5s timeout
        let coords: UserLocation | null = null;
        try {
          const location = await withTimeout(
            Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
            GPS_TIMEOUT_MS,
          );
          coords = { latitude: location.coords.latitude, longitude: location.coords.longitude };
        } catch {
          // Fallback: low-power network triangulation
          try {
            const location = await withTimeout(
              Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Low }),
              GPS_TIMEOUT_MS,
            );
            coords = { latitude: location.coords.latitude, longitude: location.coords.longitude };
          } catch {
            // Both failed — use last known location if available
            const last = await Location.getLastKnownPositionAsync();
            if (last) {
              coords = { latitude: last.coords.latitude, longitude: last.coords.longitude };
            }
          }
        }

        if (cancelled) return;

        if (coords) {
          setUserLocation(coords);
          mapRef.current?.animateToRegion({
            ...coords,
            latitudeDelta: 0.0922,
            longitudeDelta: 0.0421,
          }, 500);
        }
        dismissLoadingOverlay();
      } catch (error) {
        if (!cancelled) {
          console.warn('获取定位失败:', error);
          dismissLoadingOverlay();
        }
      }
    })();

    return () => { cancelled = true; };
  }, [dismissLoadingOverlay]);

  // ---- Foreground polling ----
  useEffect(() => {
    if (!isRecording) {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      return;
    }

    pollTimerRef.current = setInterval(() => {
      const bufferedPoints = getTrailBuffer();
      if (bufferedPoints.length > 0) {
        const simplified = processTrail(bufferedPoints, RDP_EPSILON);
        setDisplayPoints(simplified);
        const dist = getTotalDistance();
        setTotalDistance(dist);

        let gain = 0;
        for (let i = 1; i < bufferedPoints.length; i++) {
          const prev = bufferedPoints[i - 1];
          const curr = bufferedPoints[i];
          if (
            prev.altitude !== null &&
            prev.altitude !== undefined &&
            curr.altitude !== null &&
            curr.altitude !== undefined
          ) {
            const delta = curr.altitude - prev.altitude;
            if (delta > 0) gain += delta;
          }
        }
        setElevationGain(gain);

        const newPoints = bufferedPoints.slice(currentPath.length);
        appendTrailPoints(newPoints);

        if (newPoints.length > 0) {
          exploreGridsBatch(newPoints);
        }
      }
    }, POLL_INTERVAL_MS);

    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [isRecording, currentPath.length, exploreGridsBatch]);

  // ---- Elapsed timer ----
  useEffect(() => {
    if (!isRecording || startTime === null) {
      if (elapsedTimerRef.current) {
        clearInterval(elapsedTimerRef.current);
        elapsedTimerRef.current = null;
      }
      return;
    }

    elapsedTimerRef.current = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);

    return () => {
      if (elapsedTimerRef.current) {
        clearInterval(elapsedTimerRef.current);
        elapsedTimerRef.current = null;
      }
    };
  }, [isRecording, startTime]);

  // ---- Start hike ----
  const handleStartHike = useCallback(async () => {
    if (!hasLocationPermission) {
      Alert.alert('权限不足', '请先授予定位权限后再开始徒步。');
      return;
    }

    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    resetTrailBuffer();
    foregroundFilterRef.current.reset();
    setDisplayPoints([]);
    setElapsedSeconds(0);

    const started = await startBackgroundLocation();
    if (!started) {
      Alert.alert('后台定位启动失败', '请检查是否已授予"始终允许"定位权限。', [
        { text: '知道了' },
      ]);
      return;
    }

    storeStartHike();
  }, [hasLocationPermission, storeStartHike]);

  // ---- Stop hike ----
  const handleStopHike = useCallback(async () => {
    Alert.alert('结束徒步', '确定要结束本次徒步记录吗？', [
      { text: '取消', style: 'cancel' },
      {
        text: '确定结束',
        style: 'destructive',
        onPress: async () => {
          await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          await stopBackgroundLocation();

          if (pollTimerRef.current) {
            clearInterval(pollTimerRef.current);
            pollTimerRef.current = null;
          }
          if (elapsedTimerRef.current) {
            clearInterval(elapsedTimerRef.current);
            elapsedTimerRef.current = null;
          }

          const finalPoints = getTrailBuffer();
          const simplified = processTrail(finalPoints, RDP_EPSILON);
          setDisplayPoints(simplified);
          setTotalDistance(getTotalDistance());

          if (finalPoints.length > 0) {
            exploreGridsBatch(finalPoints);
          }

          storeStopHike();
        },
      },
    ]);
  }, [storeStopHike, setTotalDistance, exploreGridsBatch]);

  // ---- Switch tile source ----
  const handleSwitchSource = useCallback(() => {
    setActiveSource((prev) => (prev === 'standard' ? 'satellite' : 'standard'));
  }, []);

  // ---- AI Chat ----
  const handleOpenAI = useCallback(() => {
    setIsAIChatVisible(true);
  }, []);

  const handleCloseAI = useCallback(() => {
    setIsAIChatVisible(false);
  }, []);

  const currentSource = TILE_SOURCES[activeSource];

  const polylineCoordinates = useMemo(
    () =>
      displayPoints.map((p) => ({
        latitude: p.latitude,
        longitude: p.longitude,
      })),
    [displayPoints],
  );

  return (
    <View className="flex-1 bg-[#121314]">
      {/* Full-screen immersive map — always mounted, never blocked */}
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        initialRegion={
          userLocation
            ? { ...userLocation, latitudeDelta: 0.0922, longitudeDelta: 0.0421 }
            : INITIAL_REGION
        }
        showsUserLocation={hasLocationPermission}
        showsMyLocationButton={false}
        showsCompass={false}
        showsScale={false}
        rotateEnabled
        scrollEnabled
        zoomEnabled
      >
        <UrlTile
          urlTemplate={currentSource.urlTemplate}
          maximumZ={18}
          tileSize={256}
          flipY={false}
        />
        <ExplorationGrids />
        {polylineCoordinates.length >= 2 && (
          <Polyline
            coordinates={polylineCoordinates}
            strokeColor="#1890ff"
            strokeWidth={5}
            lineCap="round"
            lineJoin="round"
          />
        )}
      </MapView>

      {/* Glass Loading Overlay — fades out on first GPS fix; double-tap to bypass */}
      {!loadingDismissed && (
        <Animated.View
          style={[
            StyleSheet.absoluteFill,
            loadingAnimatedStyle,
            { zIndex: 50 },
          ]}
          pointerEvents={userLocation ? 'none' : 'auto'}
        >
          <BlurView intensity={60} tint="dark" style={StyleSheet.absoluteFill}>
            <Pressable
              style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(18,19,20,0.6)' }]}
              onPress={handleLoadingDoubleTap}
            >
              <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                <View
                  style={{
                    width: 200,
                    paddingVertical: 28,
                    borderRadius: 24,
                    backgroundColor: 'rgba(255,255,255,0.06)',
                    borderWidth: 1,
                    borderColor: 'rgba(255,255,255,0.1)',
                    alignItems: 'center',
                    shadowColor: '#000',
                    shadowOffset: { width: 0, height: 8 },
                    shadowOpacity: 0.3,
                    shadowRadius: 24,
                    elevation: 16,
                  }}
                >
                  <ActivityIndicator size="large" color="#10B981" />
                  <Text
                    style={{
                      marginTop: 16,
                      fontSize: 14,
                      fontWeight: '600',
                      color: 'rgba(255,255,255,0.7)',
                      letterSpacing: 1,
                    }}
                  >
                    正在搜星定位...
                  </Text>
                  <Text
                    style={{
                      marginTop: 6,
                      fontSize: 11,
                      color: 'rgba(255,255,255,0.35)',
                    }}
                  >
                    Acquiring GPS signal
                  </Text>
                  <Text
                    style={{
                      marginTop: 10,
                      fontSize: 9,
                      color: 'rgba(255,255,255,0.2)',
                    }}
                  >
                    双击跳过 · Double-tap to skip
                  </Text>
                </View>
              </View>
            </Pressable>
          </BlurView>
        </Animated.View>
      )}

      {/* Top Glassmorphic HUD */}
      {isRecording && (
        <StatsHUD
          elapsedSeconds={elapsedSeconds}
          totalDistance={totalDistance}
          elevationGain={elevationGain}
        />
      )}

      {/* PEI Breathing Orb */}
      {isRecording && <PEIOrb />}

      {/* Right floating buttons */}
      <FloatingButtons
        activeSource={activeSource}
        onSwitchSource={handleSwitchSource}
        onOpenAI={handleOpenAI}
      />

      {/* BiometricsPanel drawer */}
      <BiometricsPanel />

      {/* Bottom pill control button */}
      <View
        className="absolute left-0 right-0 items-center z-40"
        style={{ bottom: insets.bottom + 16 }}
      >
        {hikeStatus === 'idle' ? (
          <TouchableOpacity onPress={handleStartHike} activeOpacity={0.85}>
            <LinearGradient
              colors={['#52c41a', '#389e0d']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={{
                paddingHorizontal: 48,
                paddingVertical: 18,
                borderRadius: 32,
                shadowColor: '#52c41a',
                shadowOffset: { width: 0, height: 4 },
                shadowOpacity: 0.35,
                shadowRadius: 12,
                elevation: 8,
              }}
            >
              <Text className="text-lg font-bold text-white tracking-wide">
                &#x1F97E; 开始徒步
              </Text>
            </LinearGradient>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity onPress={handleStopHike} activeOpacity={0.85}>
            <LinearGradient
              colors={['#ff4d4f', '#cf1322']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={{
                paddingHorizontal: 48,
                paddingVertical: 18,
                borderRadius: 32,
                shadowColor: '#ff4d4f',
                shadowOffset: { width: 0, height: 4 },
                shadowOpacity: 0.35,
                shadowRadius: 12,
                elevation: 8,
              }}
            >
              <Text className="text-lg font-bold text-white tracking-wide">
                &#x23F9;&#xFE0F; 停止记录
              </Text>
            </LinearGradient>
          </TouchableOpacity>
        )}
      </View>

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
    </View>
  );
}

export default memo(MapContainer);
