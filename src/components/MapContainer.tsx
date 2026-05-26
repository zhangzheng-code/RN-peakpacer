import React, { useState, useEffect, useCallback, useRef, memo } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
} from 'react-native';
import MapView, { UrlTile, Polyline } from 'react-native-maps';
import * as Location from 'expo-location';
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
import type {
  TileSourceConfig,
  TileSourceType,
  UserLocation,
  TrailPoint,
} from '../types';

/**
 * 高德在线瓦片源配置
 */
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

/**
 * 地图初始中心点
 */
const INITIAL_REGION = {
  latitude: 39.9042,
  longitude: 116.4074,
  latitudeDelta: 0.0922,
  longitudeDelta: 0.0421,
};

/** 前台轮询间隔 */
const POLL_INTERVAL_MS = 1000;

/** RDP 抽稀容差 */
const RDP_EPSILON = 10;

/**
 * MapContainer 地图容器组件
 *
 * 集成：高德瓦片 + 轨迹记录 + 体征面板 + 安全预警
 */
function MapContainer() {
  // ---- Zustand Store ----
  const {
    hikeStatus,
    currentPath,
    totalDistance,
    startTime,
    startHike: storeStartHike,
    stopHike: storeStopHike,
    appendTrailPoints,
    setTotalDistance,
    setElevationGain,
  } = useHikeStore();

  // ---- 本地 UI 状态 ----

  const [activeSource, setActiveSource] = useState<TileSourceType>('standard');
  const [userLocation, setUserLocation] = useState<UserLocation | null>(null);
  const [hasLocationPermission, setHasLocationPermission] = useState(false);
  const [isLoadingLocation, setIsLoadingLocation] = useState(true);
  const [displayPoints, setDisplayPoints] = useState<TrailPoint[]>([]);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  // ---- Refs ----

  const foregroundFilterRef = useRef<GpsKalmanFilter>(new GpsKalmanFilter());
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mapRef = useRef<MapView>(null);

  const isRecording = hikeStatus === 'recording';

  // ---- 定位权限请求 ----

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
          Alert.alert(
            '定位权限未授予',
            '请在系统设置中允许 SmartHike 访问您的位置。',
            [{ text: '知道了' }],
          );
        }
      } catch (error) {
        console.warn('获取定位失败:', error);
      } finally {
        setIsLoadingLocation(false);
      }
    })();
  }, []);

  // ---- 前台轮询：从后台缓冲区读取轨迹 ----

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

        // 计算累计海拔
        let gain = 0;
        for (let i = 1; i < bufferedPoints.length; i++) {
          const prev = bufferedPoints[i - 1];
          const curr = bufferedPoints[i];
          if (prev.altitude !== null && prev.altitude !== undefined &&
              curr.altitude !== null && curr.altitude !== undefined) {
            const delta = curr.altitude - prev.altitude;
            if (delta > 0) gain += delta;
          }
        }
        setElevationGain(gain);

        // 同步到 Zustand store（用于持久化）
        appendTrailPoints(bufferedPoints.slice(currentPath.length));
      }
    }, POLL_INTERVAL_MS);

    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [isRecording, currentPath.length]);

  // ---- 计时器 ----

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

  // ---- 开始徒步 ----

  const handleStartHike = useCallback(async () => {
    if (!hasLocationPermission) {
      Alert.alert('权限不足', '请先授予定位权限后再开始徒步。');
      return;
    }

    resetTrailBuffer();
    foregroundFilterRef.current.reset();
    setDisplayPoints([]);
    setElapsedSeconds(0);

    const started = await startBackgroundLocation();
    if (!started) {
      Alert.alert(
        '后台定位启动失败',
        '请检查是否已授予"始终允许"定位权限。',
        [{ text: '知道了' }],
      );
      return;
    }

    storeStartHike();
  }, [hasLocationPermission, storeStartHike]);

  // ---- 停止徒步 ----

  const handleStopHike = useCallback(async () => {
    Alert.alert('结束徒步', '确定要结束本次徒步记录吗？', [
      { text: '取消', style: 'cancel' },
      {
        text: '确定结束',
        style: 'destructive',
        onPress: async () => {
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

          storeStopHike();
        },
      },
    ]);
  }, [storeStopHike, setTotalDistance]);

  // ---- 图源切换 ----

  const handleSwitchSource = useCallback(() => {
    setActiveSource((prev) => (prev === 'standard' ? 'satellite' : 'standard'));
  }, []);

  // ---- 格式化工具 ----

  const formatTime = (seconds: number): string => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) {
      return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return `${m}:${String(s).padStart(2, '0')}`;
  };

  const formatDistance = (meters: number): string => {
    if (meters >= 1000) {
      return `${(meters / 1000).toFixed(2)} km`;
    }
    return `${Math.round(meters)} m`;
  };

  const currentSource = TILE_SOURCES[activeSource];

  // ---- 渲染 ----

  return (
    <View style={styles.container}>
      {/* 地图主体 */}
      <MapView
        ref={mapRef}
        style={styles.map}
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

        {displayPoints.length >= 2 && (
          <Polyline
            coordinates={displayPoints.map((p) => ({
              latitude: p.latitude,
              longitude: p.longitude,
            }))}
            strokeColor="#1890ff"
            strokeWidth={4}
            lineCap="round"
            lineJoin="round"
          />
        )}
      </MapView>

      {/* 图源切换按钮 */}
      <View style={styles.switchButtonContainer}>
        <TouchableOpacity
          style={styles.switchButton}
          onPress={handleSwitchSource}
          activeOpacity={0.7}
        >
          <Text style={styles.switchButtonText}>
            {activeSource === 'standard' ? '🛰️ 卫星图' : '🗺️ 路网图'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* 定位加载指示器 */}
      {isLoadingLocation && (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator size="small" color="#1890ff" />
          <Text style={styles.loadingText}>正在获取定位...</Text>
        </View>
      )}

      {/* 徒步统计面板 */}
      {isRecording && (
        <View style={styles.statsPanel}>
          <View style={styles.statsRow}>
            <View style={styles.statItem}>
              <Text style={styles.statValue}>{formatTime(elapsedSeconds)}</Text>
              <Text style={styles.statLabel}>用时</Text>
            </View>
            <View style={styles.statDivider} />
            <View style={styles.statItem}>
              <Text style={styles.statValue}>{formatDistance(totalDistance)}</Text>
              <Text style={styles.statLabel}>距离</Text>
            </View>
            <View style={styles.statDivider} />
            <View style={styles.statItem}>
              <Text style={styles.statValue}>{displayPoints.length}</Text>
              <Text style={styles.statLabel}>轨迹点</Text>
            </View>
          </View>
        </View>
      )}

      {/* 体征控制面板（录制时显示） */}
      <BiometricsPanel />

      {/* 底部控制按钮 */}
      <View style={styles.controlContainer}>
        {hikeStatus === 'idle' ? (
          <TouchableOpacity
            style={[styles.controlButton, styles.startButton]}
            onPress={handleStartHike}
            activeOpacity={0.8}
          >
            <Text style={styles.controlButtonText}>🥾 开始徒步</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={[styles.controlButton, styles.stopButton]}
            onPress={handleStopHike}
            activeOpacity={0.8}
          >
            <Text style={styles.controlButtonText}>⏹️ 停止记录</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* 安全预警弹窗（全局覆盖） */}
      <SafetyAlert />
    </View>
  );
}

export default memo(MapContainer);

// ---- 样式定义 ----

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f0f0f0',
  },
  map: {
    flex: 1,
    width: '100%',
    height: '100%',
  },
  switchButtonContainer: {
    position: 'absolute',
    top: 60,
    right: 16,
    zIndex: 10,
  },
  switchButton: {
    backgroundColor: 'rgba(255, 255, 255, 0.95)',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 5,
  },
  switchButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#333',
  },
  loadingOverlay: {
    position: 'absolute',
    top: 60,
    left: 16,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.9)',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  loadingText: {
    marginLeft: 8,
    fontSize: 13,
    color: '#666',
  },
  statsPanel: {
    position: 'absolute',
    top: 60,
    left: 16,
    right: 16,
    backgroundColor: 'rgba(255, 255, 255, 0.95)',
    borderRadius: 16,
    paddingVertical: 14,
    paddingHorizontal: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.12,
    shadowRadius: 8,
    elevation: 5,
  },
  statsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
  },
  statItem: {
    alignItems: 'center',
    flex: 1,
  },
  statValue: {
    fontSize: 20,
    fontWeight: '700',
    color: '#1a1a1a',
  },
  statLabel: {
    fontSize: 12,
    color: '#888',
    marginTop: 2,
  },
  statDivider: {
    width: 1,
    height: 30,
    backgroundColor: '#e8e8e8',
  },
  controlContainer: {
    position: 'absolute',
    bottom: 48,
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 10,
  },
  controlButton: {
    paddingHorizontal: 40,
    paddingVertical: 16,
    borderRadius: 32,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 12,
    elevation: 8,
  },
  startButton: {
    backgroundColor: '#52c41a',
  },
  stopButton: {
    backgroundColor: '#ff4d4f',
  },
  controlButtonText: {
    fontSize: 18,
    fontWeight: '700',
    color: '#fff',
  },
});
