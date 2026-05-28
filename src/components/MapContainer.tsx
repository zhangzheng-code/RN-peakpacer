import React, { useState, useEffect, useCallback, useRef, useMemo, memo } from 'react';
import { StyleSheet, View, Text, TouchableOpacity, Alert, ActivityIndicator, Modal } from 'react-native';
import MapView, { UrlTile, Polyline } from 'react-native-maps';
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
  latitude: 39.9042,
  longitude: 116.4074,
  latitudeDelta: 0.0922,
  longitudeDelta: 0.0421,
};

const POLL_INTERVAL_MS = 1000;
const RDP_EPSILON = 10;

function MapContainer() {
  const insets = useSafeAreaInsets();

  // ---- Zustand selector subscriptions（精确订阅，切断无关状态的垃圾重绘） ----
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
  const [isLoadingLocation, setIsLoadingLocation] = useState(true);
  const [displayPoints, setDisplayPoints] = useState<TrailPoint[]>([]);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [isAIChatVisible, setIsAIChatVisible] = useState(false);

  const foregroundFilterRef = useRef<GpsKalmanFilter>(new GpsKalmanFilter());
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mapRef = useRef<MapView>(null);

  const isRecording = hikeStatus === 'recording';

  // ---- Location permission ----
  useEffect(() => {
    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status === 'granted') {
          setHasLocationPermission(true);
          const location = await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Balanced,
          });
          setUserLocation({
            latitude: location.coords.latitude,
            longitude: location.coords.longitude,
          });
        } else {
          Alert.alert('定位权限未授予', '请在系统设置中允许 SmartHike 访问您的位置。', [
            { text: '知道了' },
          ]);
        }
      } catch (error) {
        console.warn('获取定位失败:', error);
      } finally {
        setIsLoadingLocation(false);
      }
    })();
  }, []);

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

        // 批量点亮轨迹经过的网格
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

          // 点亮最后一批网格
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

  /**
   * useMemo 缓存 Polyline 坐标数组
   * 避免每次 render 时重新 map 产生新引用导致 Polyline 重绘
   */
  const polylineCoordinates = useMemo(
    () =>
      displayPoints.map((p) => ({
        latitude: p.latitude,
        longitude: p.longitude,
      })),
    [displayPoints],
  );

  return (
    <View className="flex-1 bg-black">
      {/* Full-screen immersive map */}
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
        {/* 已探索网格迷雾层 */}
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

      {/* Loading indicator */}
      {isLoadingLocation && (
        <View
          className="absolute left-4 flex-row items-center px-3 py-2 rounded-full"
          style={{
            top: insets.top + 8,
            backgroundColor: 'rgba(255,255,255,0.9)',
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 1 },
            shadowOpacity: 0.1,
            shadowRadius: 4,
            elevation: 3,
          }}
        >
          <ActivityIndicator size="small" color="#1890ff" />
          <Text className="ml-2 text-sm text-muted">正在获取定位...</Text>
        </View>
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
