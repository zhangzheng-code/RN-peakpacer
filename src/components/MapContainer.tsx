/**
 * ============================================================
 * MapContainer — WebView + Leaflet.js（单点视口坍塌修复版）
 * ============================================================
 *
 * 修复要点：
 * 1. drawTrack 单点降级：1 个点 → setView(lat, 16)，绝不 fitBounds
 * 2. drawTrack 多点兜底：fitBounds + maxZoom:16 + padding
 * 3. setUserLocation / flyTo 全部使用 setView，不用 fitBounds
 * 4. 保留 invalidateSize 延迟注入 + resize 监听
 * 5. 静态 HTML 常量 + 固定 key + absoluteFillObject
 * 6. injectCall 使用 JSON.stringify 安全序列化
 */

import React, { useState, useEffect, useCallback, useRef, memo } from 'react';
import { StyleSheet, View, Text, ActivityIndicator, Pressable, Alert } from 'react-native';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  runOnJS,
} from 'react-native-reanimated';
import { BlurView } from 'expo-blur';
import * as Location from 'expo-location';
import * as Haptics from 'expo-haptics';
import { processTrail } from '../utils/gpsFilter';
import {
  getTrailBuffer,
  getTotalDistance,
} from '../tasks/backgroundLocationTask';
import { useHikeStore } from '../store/useHikeStore';
import { useShallow } from 'zustand/shallow';
import type { UserLocation, TrailPoint, TileSourceType } from '../types';

// ---- Constants ----

const INITIAL_LAT = 34.2635;
const INITIAL_LNG = 108.948;
const INITIAL_ZOOM = 13;
const GRID_SIZE = 0.001;

const AMAP_STANDARD_URL =
  'https://webrd01.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=7&x={x}&y={y}&z={z}';
const AMAP_SATELLITE_URL =
  'https://webst01.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}';

const POLL_INTERVAL_MS = 1000;
const RDP_EPSILON = 10;
const GPS_TIMEOUT_MS = 5000;
const DEBUG_DEFAULT_LOCATION: UserLocation = { latitude: 30.25, longitude: 120.15 };

const TRAIL_COLOR = '#1890ff';
const TRAIL_WEIGHT = 5;
const GRID_FILL_COLOR = 'rgba(16, 185, 129, 0.22)';
const USER_MARKER_COLOR = '#3B82F6';

/**
 * 完全静态的 Leaflet HTML 模板。
 * 不含任何动态变量，确保 WebView 永不因 source 变化而重载。
 */
const LEAFLET_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"><\/script>
  <style>
    html, body, #map {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      margin: 0;
      padding: 0;
      overflow: hidden;
      background: #121314;
    }
    .leaflet-control-attribution { display: none !important; }
    .leaflet-control-zoom { display: none !important; }
    .leaflet-tile-pane { opacity: 1; }
  </style>
</head>
<body>
  <div id="map"></div>
  <script>
    (function() {
      // ---- Initialize map ----
      var map = L.map('map', {
        center: [${INITIAL_LAT}, ${INITIAL_LNG}],
        zoom: ${INITIAL_ZOOM},
        zoomControl: false,
        attributionControl: false,
        preferCanvas: true,
        trackResize: true,
        zoomAnimation: true,
        markerZoomAnimation: false,
      });

      // ---- Tile layers ----
      var standardTile = L.tileLayer('${AMAP_STANDARD_URL}', {
        maxZoom: 18,
        tileSize: 256,
        updateWhenIdle: true,
        updateWhenZooming: false,
      });

      var satelliteTile = L.tileLayer('${AMAP_SATELLITE_URL}', {
        maxZoom: 18,
        tileSize: 256,
        updateWhenIdle: true,
        updateWhenZooming: false,
      });

      standardTile.addTo(map);
      var currentTileType = 'standard';

      // ---- Trail polyline (created once, updated in-place) ----
      var trailPolyline = null;

      // ---- Fog-of-war canvas overlay ----
      var fogCanvas = null;
      var fogCtx = null;
      var exploredGridKeys = {};

      var FogOverlay = L.Layer.extend({
        onAdd: function(map) {
          fogCanvas = L.DomUtil.create('canvas', 'fog-overlay');
          var pane = map.getPane('overlayPane');
          pane.appendChild(fogCanvas);
          fogCtx = fogCanvas.getContext('2d');
          this._map = map;
          this._update();
          map.on('moveend zoomend resize', this._update, this);
        },
        onRemove: function(map) {
          map.off('moveend zoomend resize', this._update, this);
          if (fogCanvas && fogCanvas.parentNode) fogCanvas.parentNode.removeChild(fogCanvas);
          fogCanvas = null;
          fogCtx = null;
        },
        _update: function() {
          if (!fogCanvas || !fogCtx) return;
          var map = this._map;
          var size = map.getSize();
          fogCanvas.width = size.x;
          fogCanvas.height = size.y;
          var topLeft = map.containerPointToLayerPoint([0, 0]);
          L.DomUtil.setPosition(fogCanvas, topLeft);
          // Fill entire canvas with dark fog
          fogCtx.fillStyle = 'rgba(18, 19, 20, 0.60)';
          fogCtx.fillRect(0, 0, size.x, size.y);
          // Punch holes for explored grids
          fogCtx.globalCompositeOperation = 'destination-out';
          for (var key in exploredGridKeys) {
            var parts = key.split(',');
            var latIdx = parseInt(parts[0], 10);
            var lngIdx = parseInt(parts[1], 10);
            var south = latIdx * 0.001;
            var north = south + 0.001;
            var west = lngIdx * 0.001;
            var east = west + 0.001;
            var nw = map.latLngToContainerPoint([north, west]);
            var se = map.latLngToContainerPoint([south, east]);
            fogCtx.fillStyle = 'rgba(0,0,0,1)';
            fogCtx.fillRect(nw.x, se.y, se.x - nw.x, nw.y - se.y);
          }
          fogCtx.globalCompositeOperation = 'source-over';
        },
        redraw: function() {
          this._update();
        }
      });

      var fogOverlay = new FogOverlay();
      fogOverlay.addTo(map);

      // ---- User location marker ----
      var userMarker = null;
      var userCircle = null;

      // ---- 核心修复：延迟 invalidateSize 确保视口同步 ----
      setTimeout(function() { map.invalidateSize({ animate: false }); }, 100);
      setTimeout(function() { map.invalidateSize({ animate: false }); }, 300);
      setTimeout(function() { map.invalidateSize({ animate: false }); }, 800);

      // ---- 监听窗口尺寸变化，动态刷新 ----
      window.addEventListener('resize', function() {
        map.invalidateSize({ animate: false });
      });

      // ---- 通知 RN 端 map 已就绪 ----
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'mapReady' }));

      // ================================================================
      // 全局 API：RN 端通过 injectJavaScript 调用以下函数
      // ================================================================

      /**
       * 绘制/更新轨迹线
       *
       * 核心修复：
       * - points.length === 1 → setView（单点降级，绝不 fitBounds）
       * - points.length >= 2 → setLatLngs + fitBounds（maxZoom 兜底）
       * - points.length === 0 → 不做任何操作
       */
      window.drawTrack = function(pointsJson) {
        try {
          var points = JSON.parse(pointsJson);
          if (!points || points.length === 0) return;

          if (points.length === 1) {
            // ---- 单点降级：setView，保持高清缩放 ----
            var pt = points[0];
            if (trailPolyline) {
              trailPolyline.setLatLngs([pt]);
            } else {
              trailPolyline = L.polyline([pt], {
                color: '${TRAIL_COLOR}',
                weight: ${TRAIL_WEIGHT},
                lineCap: 'round',
                lineJoin: 'round',
                smoothFactor: 1,
              }).addTo(map);
            }
            // 绝不 fitBounds 单点！使用 setView 保持稳定缩放
            map.setView(pt, 16, { animate: true, duration: 0.5 });
            return;
          }

          // ---- 多点：原地更新 + fitBounds 兜底 ----
          if (trailPolyline) {
            trailPolyline.setLatLngs(points);
          } else {
            trailPolyline = L.polyline(points, {
              color: '${TRAIL_COLOR}',
              weight: ${TRAIL_WEIGHT},
              lineCap: 'round',
              lineJoin: 'round',
              smoothFactor: 1,
            }).addTo(map);
          }

          // fitBounds 兜底：maxZoom:16 防止过度缩放
          var bounds = L.latLngBounds(points);
          if (bounds.isValid()) {
            map.fitBounds(bounds, {
              maxZoom: 16,
              padding: [40, 40],
              animate: true,
              duration: 0.5,
            });
          }
        } catch (e) {
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'error', data: 'drawTrack: ' + e.message }));
        }
      };

      /**
       * 更新迷雾探索网格（Canvas Fog-of-War）
       * 接收已探索网格 key 数组，更新 fog overlay 并重绘
       */
      window.updateExploredGrids = function(keysArray) {
        try {
          exploredGridKeys = {};
          for (var i = 0; i < keysArray.length; i++) {
            exploredGridKeys[keysArray[i]] = true;
          }
          if (fogOverlay && fogOverlay.redraw) {
            fogOverlay.redraw();
          }
        } catch (e) {
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'error', data: 'updateExploredGrids: ' + e.message }));
        }
      };

      /**
       * 切换底图图源
       */
      window.setTileSource = function(source) {
        try {
          if (source === 'satellite' && currentTileType !== 'satellite') {
            map.removeLayer(standardTile);
            satelliteTile.addTo(map);
            currentTileType = 'satellite';
          } else if (source === 'standard' && currentTileType !== 'standard') {
            map.removeLayer(satelliteTile);
            standardTile.addTo(map);
            currentTileType = 'standard';
          }
        } catch (e) {}
      };

      /**
       * 设置地图中心（单点定位专用，绝不 fitBounds）
       */
      window.setView = function(lat, lng, zoom) {
        try {
          map.setView([lat, lng], zoom || 16, { animate: true, duration: 0.5 });
        } catch (e) {}
      };

      /**
       * 飞行到指定坐标（封装 setView，兼容旧调用）
       */
      window.flyTo = function(lat, lng, zoom) {
        try {
          map.setView([lat, lng], zoom || 16, { animate: true, duration: 0.5 });
        } catch (e) {}
      };

      /**
       * 设置/更新用户位置标记（使用 setView，不用 fitBounds）
       */
      window.setUserLocation = function(lat, lng) {
        try {
          var latlng = [lat, lng];
          if (userMarker) {
            userMarker.setLatLng(latlng);
          } else {
            userMarker = L.circleMarker(latlng, {
              radius: 8,
              fillColor: '${USER_MARKER_COLOR}',
              fillOpacity: 0.9,
              color: '#ffffff',
              weight: 2,
            }).addTo(map);
          }
          if (userCircle) {
            userCircle.setLatLng(latlng);
          } else {
            userCircle = L.circleMarker(latlng, {
              radius: 20,
              fillColor: '${USER_MARKER_COLOR}',
              fillOpacity: 0.12,
              color: '${USER_MARKER_COLOR}',
              weight: 1,
              opacity: 0.4,
            }).addTo(map);
          }
          // 单点定位：setView，绝不 fitBounds
          map.setView(latlng, 16, { animate: true, duration: 0.5 });
        } catch (e) {}
      };

      /**
       * 强制刷新视口
       */
      window.refreshView = function() {
        map.invalidateSize({ animate: false });
      };
    })();
  <\/script>
</body>
</html>`;

// ---- Timeout helper ----

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

// ---- Safe inject helper ----

function injectCall(
  webViewRef: React.RefObject<WebView | null>,
  fnName: string,
  ...args: unknown[]
) {
  const safeArgs = args.map((a) => JSON.stringify(a)).join(',');
  const js = `try { ${fnName}(${safeArgs}); } catch(e) {} void(0);`;
  webViewRef.current?.injectJavaScript(js);
}

// ---- Props ----

interface MapContainerProps {
  tileSource?: TileSourceType;
}

// ---- Main Component ----

function MapContainer({ tileSource = 'standard' }: MapContainerProps) {
  // ---- Zustand 精细 Selector 订阅（shallow 浅比较，防止无关状态触发重绘） ----
  const hikeStatus = useHikeStore((s) => s.hikeStatus);
  const currentPath = useHikeStore((s) => s.currentPath);
  const exploredGrids = useHikeStore(useShallow((s) => s.exploredGrids));
  const appendTrailPoints = useHikeStore((s) => s.appendTrailPoints);
  const setTotalDistance = useHikeStore((s) => s.setTotalDistance);
  const setElevationGain = useHikeStore((s) => s.setElevationGain);
  const exploreGridsBatch = useHikeStore((s) => s.exploreGridsBatch);

  const [userLocation, setUserLocation] = useState<UserLocation | null>(null);
  const [hasLocationPermission, setHasLocationPermission] = useState(false);
  const [displayPoints, setDisplayPoints] = useState<TrailPoint[]>([]);
  const [loadingDismissed, setLoadingDismissed] = useState(false);
  const [mapReady, setMapReady] = useState(false);

  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const webViewRef = useRef<WebView>(null);
  const isMountedRef = useRef(true);

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

  // ---- Handle messages from WebView ----
  const handleWebViewMessage = useCallback((event: WebViewMessageEvent) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      switch (msg.type) {
        case 'mapReady':
          if (isMountedRef.current) {
            setMapReady(true);
          }
          break;
        case 'error':
          console.warn('Leaflet error:', msg.data);
          break;
      }
    } catch {
      // ignore
    }
  }, []);

  // ---- Sync trail to WebView ----
  useEffect(() => {
    if (!mapReady || displayPoints.length === 0) return;

    const coords: Array<[number, number]> = displayPoints.map((p) => [
      p.latitude,
      p.longitude,
    ]);
    // drawTrack 内部处理单点 vs 多点逻辑
    injectCall(webViewRef, 'window.drawTrack', JSON.stringify(coords));
  }, [displayPoints, mapReady]);

  // ---- Sync explored grids to fog-of-war overlay ----
  useEffect(() => {
    if (!mapReady) return;
    // 直接发送 key 数组，Leaflet 端用 canvas 裁剪实现迷雾开图
    injectCall(webViewRef, 'window.updateExploredGrids', exploredGrids);
  }, [exploredGrids, mapReady]);

  // ---- Sync tile source to WebView ----
  useEffect(() => {
    if (!mapReady) return;
    injectCall(webViewRef, 'window.setTileSource', tileSource);
  }, [tileSource, mapReady]);

  // ---- Debug bypass: double-tap loading overlay ----
  const lastTapRef = useRef(0);
  const handleLoadingDoubleTap = useCallback(() => {
    const now = Date.now();
    if (now - lastTapRef.current < 300) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setUserLocation(DEBUG_DEFAULT_LOCATION);
      dismissLoadingOverlay();
      if (mapReady) {
        injectCall(webViewRef, 'window.setView', DEBUG_DEFAULT_LOCATION.latitude, DEBUG_DEFAULT_LOCATION.longitude, 15);
      }
    }
    lastTapRef.current = now;
  }, [dismissLoadingOverlay, mapReady]);

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

        let coords: UserLocation | null = null;
        try {
          const loc = await withTimeout(
            Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
            GPS_TIMEOUT_MS,
          );
          coords = { latitude: loc.coords.latitude, longitude: loc.coords.longitude };
        } catch {
          try {
            const loc = await withTimeout(
              Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Low }),
              GPS_TIMEOUT_MS,
            );
            coords = { latitude: loc.coords.latitude, longitude: loc.coords.longitude };
          } catch {
            const last = await Location.getLastKnownPositionAsync();
            if (last) {
              coords = { latitude: last.coords.latitude, longitude: last.coords.longitude };
            }
          }
        }

        if (cancelled) return;

        if (coords) {
          setUserLocation(coords);
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

  // ---- Send user location to map when known (setView, not fitBounds) ----
  useEffect(() => {
    if (!mapReady || !userLocation) return;
    injectCall(webViewRef, 'window.setUserLocation', userLocation.latitude, userLocation.longitude);
  }, [userLocation, mapReady]);

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
        setTotalDistance(getTotalDistance());

        let gain = 0;
        for (let i = 1; i < bufferedPoints.length; i++) {
          const prev = bufferedPoints[i - 1];
          const curr = bufferedPoints[i];
          if (prev.altitude != null && curr.altitude != null) {
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
  }, [isRecording, currentPath.length, appendTrailPoints, setTotalDistance, setElevationGain, exploreGridsBatch]);

  // ---- Cleanup ----
  useEffect(() => {
    return () => { isMountedRef.current = false; };
  }, []);

  return (
    <View style={styles.root}>
      <WebView
        key="smarthike-leaflet-map"
        ref={webViewRef}
        source={{ html: LEAFLET_HTML }}
        style={StyleSheet.absoluteFillObject}
        onMessage={handleWebViewMessage}
        javaScriptEnabled
        domStorageEnabled
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        scrollEnabled={false}
        bounces={false}
        overScrollMode="never"
        originWhitelist={['*']}
        setSupportMultipleWindows={false}
      />

      {/* GPS Loading Overlay */}
      {!loadingDismissed && (
        <Animated.View
          style={[StyleSheet.absoluteFillObject, loadingAnimatedStyle, { zIndex: 50 }]}
          pointerEvents={userLocation ? 'none' : 'auto'}
        >
          <BlurView intensity={60} tint="dark" style={StyleSheet.absoluteFillObject}>
            <Pressable
              style={[StyleSheet.absoluteFillObject, { backgroundColor: 'rgba(18,19,20,0.6)' }]}
              onPress={handleLoadingDoubleTap}
            >
              <View style={styles.loadingCenter}>
                <View style={styles.loadingCard}>
                  <ActivityIndicator size="large" color="#10B981" />
                  <Text style={styles.loadingTitle}>正在搜星定位...</Text>
                  <Text style={styles.loadingSubtitle}>Acquiring GPS signal</Text>
                  <Text style={styles.loadingHint}>双击跳过 · Double-tap to skip</Text>
                </View>
              </View>
            </Pressable>
          </BlurView>
        </Animated.View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFillObject,
    bottom: 80, // 留出 TabBar 高度空间，防止 WebView 原生层遮挡底栏
    overflow: 'hidden',
    backgroundColor: '#121314',
  },
  loadingCenter: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingCard: {
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
  },
  loadingTitle: {
    marginTop: 16,
    fontSize: 14,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.7)',
    letterSpacing: 1,
  },
  loadingSubtitle: {
    marginTop: 6,
    fontSize: 11,
    color: 'rgba(255,255,255,0.35)',
  },
  loadingHint: {
    marginTop: 10,
    fontSize: 9,
    color: 'rgba(255,255,255,0.2)',
  },
});

export default memo(MapContainer);
