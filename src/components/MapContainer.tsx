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
import type {
  TileSourceConfig,
  TileSourceType,
  UserLocation,
  TrailPoint,
  HikeStatus,
} from '../types';

/**
 * ============================================================
 * 高德在线瓦片源配置
 * ============================================================
 *
 * 高德瓦片 URL 模板说明：
 * - webrd01~04: 路网瓦片服务器集群（多节点负载均衡）
 * - webst01~04: 卫星瓦片服务器集群
 * - lang=zh_cn: 中文标注
 * - size=1: 256px 标准尺寸
 * - scale=1: 1x 分辨率（scale=2 为高清 Retina）
 * - style=7: 标准路网样式（含等高线、POI 标注）
 * - style=6: 卫星底图样式
 * - {x}/{y}/{z}: 标准 Web 墨卡托投影瓦片坐标
 *   x: 列号（从左到右）
 *   y: 行号（从上到下）
 *   z: 缩放级别（0-18）
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
 * 地图初始中心点（北京天安门）
 * 后续会被用户实际定位覆盖
 */
const INITIAL_REGION = {
  latitude: 39.9042,
  longitude: 116.4074,
  latitudeDelta: 0.0922,
  longitudeDelta: 0.0421,
};

/**
 * 前台轮询间隔（毫秒）
 * 每隔此时间从后台任务缓冲区读取最新轨迹点
 */
const POLL_INTERVAL_MS = 1000;

/**
 * RDP 抽稀容差（米）
 * 值越大抽稀越激进，渲染点越少，帧率越高
 */
const RDP_EPSILON = 10;

/**
 * MapContainer 地图容器组件
 *
 * 功能：
 * 1. 使用 react-native-maps 的 MapView 渲染地图底图
 * 2. 通过 UrlTile 加载高德在线瓦片（路网/卫星双图源）
 * 3. 支持图源一键切换
 * 4. 请求定位权限并显示用户当前位置蓝点
 * 5. 集成后台定位任务，实时渲染徒步轨迹 Polyline
 * 6. 提供开始/停止徒步的控制按钮
 */
function MapContainer() {
  // ---- 图源状态 ----

  /** 当前激活的图源类型，默认为标准路网 */
  const [activeSource, setActiveSource] = useState<TileSourceType>('standard');

  // ---- 定位状态 ----

  /** 用户当前坐标 */
  const [userLocation, setUserLocation] = useState<UserLocation | null>(null);

  /** 定位权限是否已授予 */
  const [hasLocationPermission, setHasLocationPermission] = useState(false);

  /** 是否正在加载定位 */
  const [isLoadingLocation, setIsLoadingLocation] = useState(true);

  // ---- 徒步记录状态 ----

  /** 当前徒步状态 */
  const [hikeStatus, setHikeStatus] = useState<HikeStatus>('idle');

  /** 经卡尔曼滤波 + RDP 抽稀后用于渲染的轨迹点 */
  const [displayPoints, setDisplayPoints] = useState<TrailPoint[]>([]);

  /** 累计距离（米） */
  const [totalDistance, setTotalDistance] = useState(0);

  /** 徒步开始时间 */
  const [startTime, setStartTime] = useState<number | null>(null);

  /** 已用时间（秒） */
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  // ---- Refs ----

  /** 前台卡尔曼滤波器实例（用于前台实时定位滤波） */
  const foregroundFilterRef = useRef<GpsKalmanFilter>(new GpsKalmanFilter());

  /** 轮询定时器 ID */
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /** 计时器定时器 ID */
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /** MapView 引用，用于编程式控制地图视角 */
  const mapRef = useRef<MapView>(null);

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
            '请在系统设置中允许 SmartHike 访问您的位置，以便在地图上显示您的当前位置。',
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

  // ---- 前台轮询：从后台任务缓冲区读取轨迹数据 ----

  useEffect(() => {
    if (hikeStatus !== 'recording') {
      // 非录制状态清除定时器
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      return;
    }

    // 每秒从后台缓冲区读取最新轨迹，经过 RDP 抽稀后更新渲染
    pollTimerRef.current = setInterval(() => {
      const bufferedPoints = getTrailBuffer();
      if (bufferedPoints.length > 0) {
        // 对轨迹进行 RDP 抽稀，减少渲染点数保障 60fps
        const simplified = processTrail(bufferedPoints, RDP_EPSILON);
        setDisplayPoints(simplified);
        setTotalDistance(getTotalDistance());
      }
    }, POLL_INTERVAL_MS);

    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [hikeStatus]);

  // ---- 计时器：记录徒步已用时间 ----

  useEffect(() => {
    if (hikeStatus !== 'recording' || startTime === null) {
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
  }, [hikeStatus, startTime]);

  // ---- 开始徒步 ----

  const handleStartHike = useCallback(async () => {
    if (!hasLocationPermission) {
      Alert.alert('权限不足', '请先授予定位权限后再开始徒步。');
      return;
    }

    // 重置轨迹缓冲区和滤波器状态
    resetTrailBuffer();
    foregroundFilterRef.current.reset();
    setDisplayPoints([]);
    setTotalDistance(0);
    setElapsedSeconds(0);

    // 启动后台定位服务
    const started = await startBackgroundLocation();
    if (!started) {
      Alert.alert(
        '后台定位启动失败',
        '请检查是否已授予"始终允许"定位权限。Android 用户请确保在系统设置中开启后台定位。',
        [{ text: '知道了' }],
      );
      return;
    }

    setStartTime(Date.now());
    setHikeStatus('recording');
  }, [hasLocationPermission]);

  // ---- 停止徒步 ----

  const handleStopHike = useCallback(async () => {
    Alert.alert('结束徒步', '确定要结束本次徒步记录吗？', [
      { text: '取消', style: 'cancel' },
      {
        text: '确定结束',
        style: 'destructive',
        onPress: async () => {
          // 停止后台定位
          await stopBackgroundLocation();

          // 清除定时器
          if (pollTimerRef.current) {
            clearInterval(pollTimerRef.current);
            pollTimerRef.current = null;
          }
          if (elapsedTimerRef.current) {
            clearInterval(elapsedTimerRef.current);
            elapsedTimerRef.current = null;
          }

          // 最终抽稀一次
          const finalPoints = getTrailBuffer();
          const simplified = processTrail(finalPoints, RDP_EPSILON);
          setDisplayPoints(simplified);
          setTotalDistance(getTotalDistance());

          setHikeStatus('idle');
          setStartTime(null);
        },
      },
    ]);
  }, []);

  // ---- 图源切换 ----

  const handleSwitchSource = useCallback(() => {
    setActiveSource((prev) => (prev === 'standard' ? 'satellite' : 'standard'));
  }, []);

  // ---- 格式化时间 ----

  const formatTime = (seconds: number): string => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) {
      return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return `${m}:${String(s).padStart(2, '0')}`;
  };

  // ---- 格式化距离 ----

  const formatDistance = (meters: number): string => {
    if (meters >= 1000) {
      return `${(meters / 1000).toFixed(2)} km`;
    }
    return `${Math.round(meters)} m`;
  };

  // ---- 当前图源配置 ----

  const currentSource = TILE_SOURCES[activeSource];

  // ---- 是否正在录制 ----

  const isRecording = hikeStatus === 'recording';

  // ---- 渲染 ----

  return (
    <View style={styles.container}>
      {/* 地图主体 */}
      <MapView
        ref={mapRef}
        style={styles.map}
        initialRegion={
          userLocation
            ? {
                ...userLocation,
                latitudeDelta: 0.0922,
                longitudeDelta: 0.0421,
              }
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
        {/* 高德瓦片图层 */}
        <UrlTile
          urlTemplate={currentSource.urlTemplate}
          maximumZ={18}
          tileSize={256}
          flipY={false}
        />

        {/* 徒步轨迹 Polyline 图层 */}
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

      {/* 图源切换按钮（右上角） */}
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

      {/* 定位加载指示器（左上角） */}
      {isLoadingLocation && (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator size="small" color="#1890ff" />
          <Text style={styles.loadingText}>正在获取定位...</Text>
        </View>
      )}

      {/* 徒步统计面板（顶部居中，录制时显示） */}
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
    </View>
  );
}

/**
 * 使用 React.memo 包装组件，避免父组件重渲染时
 * 触发 MapView 不必要的重新挂载（MapView 重挂载开销极大）
 */
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
