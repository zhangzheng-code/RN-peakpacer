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
import { TeammateAnimator } from '../utils/teammateAnimator';
import type { UserLocation, TrailPoint, TileSourceType } from '../types';

// ---- Constants ----

const INITIAL_LAT = 34.2635;
const INITIAL_LNG = 108.948;
const INITIAL_ZOOM = 13;
const GRID_SIZE = 0.001;

// ---- 瓦片源：使用全球可用 + 国内可用的多源方案 ----
// 主力：OpenStreetMap（全球覆盖，无反爬限制）
const OSM_STANDARD_URL =
  'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
// 备用：高德（国内中文标注，但可能有反爬限制）
const AMAP_STANDARD_URL =
  'https://webrd01.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=7&x={x}&y={y}&z={z}';
// 卫星：ESRI World Imagery（全球覆盖，免费）
const ESRI_SATELLITE_URL =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
// 卫星备用：高德
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
    .fog-overlay {
      position: absolute !important;
      top: 0 !important;
      left: 0 !important;
      width: 100% !important;
      height: 100% !important;
      pointer-events: none;
      background: transparent !important;
      z-index: 450;
    }
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

      // ---- Tile layers (多源 + 错误回退) ----
      var tileErrorCount = {};

      function createTileLayer(url, options) {
        var layer = L.tileLayer(url, Object.assign({
          maxZoom: 18,
          tileSize: 256,
          updateWhenIdle: false,
          updateWhenZooming: false,
          // 注意：不要设 crossOrigin:true，某些瓦片服务器不返回 CORS 头会导致加载失败
          errorTileUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQABNjN9GQAAAAlwSFlzAAAWJQAAFiUBSVIk8AAAABlJREFUCNdjYGBg+A8AAQQBAScLVDUAAAAASUVORK5CYII=',
        }, options || {}));
        // 瓦片加载失败计数 → 超过阈值通知 RN 端
        layer.on('tileerror', function(e) {
          var key = url.substring(0, 30);
          tileErrorCount[key] = (tileErrorCount[key] || 0) + 1;
          if (tileErrorCount[key] === 5) {
            window.ReactNativeWebView.postMessage(JSON.stringify({
              type: 'tileError',
              url: url,
              count: tileErrorCount[key]
            }));
          }
        });
        layer.on('load', function() {
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'tilesLoaded' }));
        });
        return layer;
      }

      // 主力瓦片：OpenStreetMap（全球覆盖）
      var standardTile = createTileLayer('${OSM_STANDARD_URL}');
      // 卫星瓦片：ESRI（全球覆盖）
      var satelliteTile = createTileLayer('${ESRI_SATELLITE_URL}');

      var currentTileType = 'standard';

      // 回退瓦片源（主力加载失败时自动切换）
      var amapStandardTile = createTileLayer('${AMAP_STANDARD_URL}');
      var amapSatelliteTile = createTileLayer('${AMAP_SATELLITE_URL}');

      // 检测主力瓦片是否加载成功，失败则切换到高德
      var standardFallbackDone = false;
      standardTile.on('tileerror', function() {
        if (!standardFallbackDone) {
          standardFallbackDone = true;
          map.removeLayer(standardTile);
          amapStandardTile.addTo(map);
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'tileFallback', to: 'amap' }));
        }
      });

      standardTile.addTo(map);

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
          var container = map.getContainer();
          if (!container) return;
          var w = container.clientWidth;
          var h = container.clientHeight;
          if (w === 0 || h === 0) return;
          // CSS class .fog-overlay handles positioning; only sync canvas pixel size
          fogCanvas.width = w;
          fogCanvas.height = h;
          // Clear then fill with dark fog
          fogCtx.clearRect(0, 0, w, h);
          fogCtx.fillStyle = 'rgba(18, 19, 20, 0.45)';
          fogCtx.fillRect(0, 0, w, h);
          // Punch holes for explored grids using destination-out compositing
          fogCtx.globalCompositeOperation = 'destination-out';
          for (var key in exploredGridKeys) {
            if (!exploredGridKeys.hasOwnProperty(key)) continue;
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

      // ---- 用户位置跟随模式 ----
      var followMode = true;

      // 用户手动拖拽地图时，关闭跟随模式
      map.on('dragstart', function() {
        followMode = false;
      });

      /**
       * 设置/更新用户位置标记
       * - 首次调用：创建标记 + 自动居中
       * - 后续调用：更新标记位置 + 仅在跟随模式下居中
       */
      window.setUserLocation = function(lat, lng) {
        try {
          var latlng = [lat, lng];
          var isFirst = !userMarker;
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
          // 首次定位或跟随模式 → 自动居中
          if (isFirst || followMode) {
            map.setView(latlng, 16, { animate: true, duration: 0.5 });
          }
        } catch (e) {}
      };

      /**
       * 重新开启跟随模式（RN 端可调用，比如点击"定位"按钮）
       */
      window.enableFollowMode = function() {
        followMode = true;
      };

      /**
       * 强制刷新视口
       */
      window.refreshView = function() {
        map.invalidateSize({ animate: false });
      };

      // ---- 队友标记管理 ----
      var teammateMarkers = {};

      /**
       * 初始化队友标记（首次调用）
       */
      window.addTeammates = function(teammatesJson) {
        try {
          var teammates = JSON.parse(teammatesJson);
          for (var i = 0; i < teammates.length; i++) {
            var t = teammates[i];
            if (teammateMarkers[t.id]) continue;
            var icon = L.divIcon({
              className: 'tm-container',
              html: '<div style="position:relative;width:48px;height:64px;">' +
                    '<div style="position:absolute;width:52px;height:52px;top:0;left:-2px;border-radius:50%;border:2px solid ' + t.color + ';opacity:0.3;animation:tm-pulse 2s ease-in-out infinite;"></div>' +
                    '<div style="position:absolute;width:36px;height:36px;top:8px;left:6px;border-radius:50%;background:' + t.color + ';display:flex;align-items:center;justify-content:center;border:2px solid rgba(255,255,255,0.3);box-shadow:0 2px 12px rgba(0,0,0,0.5);">' +
                    '<span style="font-size:18px;">' + t.emoji + '</span></div>' +
                    '<div style="position:absolute;top:-6px;right:-18px;background:rgba(0,0,0,0.75);border-radius:10px;padding:2px 6px;display:flex;align-items:center;gap:2px;">' +
                    '<span style="color:#EF4444;font-size:8px;">♥</span>' +
                    '<span class="tm-hr-val" style="color:#fff;font-size:10px;font-weight:700;">' + t.heartRate + '</span></div>' +
                    '<div style="position:absolute;bottom:-4px;left:50%;transform:translateX(-50%);font-size:9px;color:rgba(255,255,255,0.5);white-space:nowrap;">' + t.name + '</div></div>',
              iconSize: [48, 64],
              iconAnchor: [24, 32],
            });
            var marker = L.marker([t.lat, t.lng], { icon: icon, interactive: false }).addTo(map);
            teammateMarkers[t.id] = marker;
          }
        } catch (e) {}
      };

      /**
       * 更新队友位置和心率（每秒调用）
       */
      window.updateTeammates = function(teammatesJson) {
        try {
          var teammates = JSON.parse(teammatesJson);
          for (var i = 0; i < teammates.length; i++) {
            var t = teammates[i];
            var marker = teammateMarkers[t.id];
            if (marker) {
              marker.setLatLng([t.lat, t.lng]);
              // 更新心率数字
              var el = marker.getElement();
              if (el) {
                var hrEl = el.querySelector('.tm-hr-val');
                if (hrEl) hrEl.textContent = t.heartRate;
              }
            }
          }
        } catch (e) {}
      };

      /**
       * 清除所有队友标记
       */
      window.clearTeammates = function() {
        try {
          for (var id in teammateMarkers) {
            map.removeLayer(teammateMarkers[id]);
          }
          teammateMarkers = {};
        } catch (e) {}
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
  // ================================================================
  // Zustand 原子化 Selector 订阅（60fps 性能隔离核心）
  // ================================================================
  // 规则：
  //   1. 高频数组（currentPath, exploredGrids）使用 shallow 浅比较
  //   2. 高频 primitive（hikeStatus）使用 primitive selector（Object.is 天然稳定）
  //   3. 函数引用（appendTrailPoints 等）在 Zustand v5 中天然稳定，无需额外处理
  //   4. 当 duration/speed/weather 等 HUD 数据高频跳动时，MapContainer 零重绘

  const hikeStatus = useHikeStore((s) => s.hikeStatus);
  const exploredGrids = useHikeStore(useShallow((s) => s.exploredGrids));
  const appendTrailPoints = useHikeStore((s) => s.appendTrailPoints);
  const setTotalDistance = useHikeStore((s) => s.setTotalDistance);
  const setElevationGain = useHikeStore((s) => s.setElevationGain);
  const exploreGridsBatch = useHikeStore((s) => s.exploreGridsBatch);

  // ---- 路径长度追踪（useRef 替代 currentPath 订阅，杜绝数组引用变更触发重绘） ----
  const trailPathLengthRef = useRef(0);

  const [userLocation, setUserLocation] = useState<UserLocation | null>(null);
  const [hasLocationPermission, setHasLocationPermission] = useState(false);
  const [displayPoints, setDisplayPoints] = useState<TrailPoint[]>([]);
  const [loadingDismissed, setLoadingDismissed] = useState(false);
  const [mapReady, setMapReady] = useState(false);

  // ---- 渲染计数器（开发环境验证：HUD 跳字时 MapContainer 重绘次数 = 0） ----
  const renderCountRef = useRef(0);
  renderCountRef.current += 1;
  if (__DEV__) {
    console.log(`[MapContainer] render #${renderCountRef.current}`);
  }

  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const webViewRef = useRef<WebView>(null);
  const isMountedRef = useRef(true);
  const animatorRef = useRef(new TeammateAnimator());
  const teammatesInitedRef = useRef(false);

  const loadingOpacity = useSharedValue(1);

  const loadingAnimatedStyle = useAnimatedStyle(() => ({
    opacity: loadingOpacity.value,
    pointerEvents: loadingOpacity.value > 0.01 ? 'auto' : 'none',
  }));

  const refreshMapView = useCallback(() => {
    injectCall(webViewRef, 'window.refreshView');
  }, []);

  const dismissLoadingOverlay = useCallback(() => {
    loadingOpacity.value = withTiming(0, { duration: 300 }, (finished) => {
      if (finished) {
        runOnJS(setLoadingDismissed)(true);
        // 遮罩消失后强制刷新地图视口，防止白屏
        runOnJS(refreshMapView)();
      }
    });
  }, [loadingOpacity, refreshMapView]);

  const isRecording = hikeStatus === 'recording';

  // ---- 徒步状态变更时重置路径长度追踪 ----
  const prevRecordingRef = useRef(false);
  useEffect(() => {
    if (isRecording && !prevRecordingRef.current) {
      // 开始录制 → 重置路径长度（新轨迹从 0 开始）
      trailPathLengthRef.current = 0;
      teammatesInitedRef.current = false;
    }
    if (!isRecording && prevRecordingRef.current) {
      // 停止录制 → 清除队友标记
      if (mapReady) {
        injectCall(webViewRef, 'window.clearTeammates');
      }
      animatorRef.current.reset();
      teammatesInitedRef.current = false;
    }
    prevRecordingRef.current = isRecording;
  }, [isRecording, mapReady]);

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
        case 'tileError':
          console.warn(`[Map] 瓦片加载失败: ${msg.url} (累计 ${msg.count} 次)`);
          break;
        case 'tilesLoaded':
          if (__DEV__) console.log('[Map] 瓦片加载完成');
          break;
        case 'tileFallback':
          console.warn(`[Map] 瓦片源切换至: ${msg.to}`);
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
  const prevGridCountRef = useRef(0);
  useEffect(() => {
    if (!mapReady) return;
    // 直接发送 key 数组，Leaflet 端用 canvas 裁剪实现迷雾开图
    injectCall(webViewRef, 'window.updateExploredGrids', exploredGrids);
    // 新网格被探索时触发轻微震动（跳过首次加载）
    if (exploredGrids.length > prevGridCountRef.current && prevGridCountRef.current > 0) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    prevGridCountRef.current = exploredGrids.length;
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

  // ---- Location permission + continuous foreground tracking ----
  useEffect(() => {
    let cancelled = false;
    let watchSubscription: Location.LocationSubscription | null = null;

    /**
     * 判断坐标是否在中国大陆范围内（粗略判断）
     * 纬度 18°~54°，经度 73°~135°
     */
    function isInChina(lat: number, lng: number): boolean {
      return lat >= 18 && lat <= 54 && lng >= 73 && lng <= 135;
    }

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

        // ---- 第一步：获取初始位置（多级回退 + 中国坐标校验） ----
        let coords: UserLocation | null = null;

        // 1a. 高精度 GPS（给 10 秒时间搜星）
        try {
          const loc = await withTimeout(
            Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
            10000,
          );
          const lat = loc.coords.latitude;
          const lng = loc.coords.longitude;
          console.log('[Map] GPS 高精度:', lat.toFixed(6), lng.toFixed(6), '精度:', loc.coords.accuracy, '米');
          if (isInChina(lat, lng)) {
            coords = { latitude: lat, longitude: lng };
          } else {
            console.warn('[Map] GPS 坐标不在中国范围内，跳过:', lat, lng);
          }
        } catch (e) {
          console.warn('[Map] GPS 高精度超时:', (e as Error).message);
        }

        // 1b. 平衡精度
        if (!coords) {
          try {
            const loc = await withTimeout(
              Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
              8000,
            );
            const lat = loc.coords.latitude;
            const lng = loc.coords.longitude;
            console.log('[Map] GPS 平衡精度:', lat.toFixed(6), lng.toFixed(6));
            if (isInChina(lat, lng)) {
              coords = { latitude: lat, longitude: lng };
            }
          } catch (e) {
            console.warn('[Map] GPS 平衡精度超时:', (e as Error).message);
          }
        }

        // 1c. 上次缓存（仅当坐标在中国范围内才使用）
        if (!coords) {
          try {
            const last = await Location.getLastKnownPositionAsync();
            if (last) {
              const lat = last.coords.latitude;
              const lng = last.coords.longitude;
              console.log('[Map] 缓存坐标:', lat.toFixed(6), lng.toFixed(6));
              if (isInChina(lat, lng)) {
                coords = { latitude: lat, longitude: lng };
                console.log('[Map] 使用缓存坐标（在中国范围内）');
              } else {
                console.warn('[Map] 缓存坐标不在中国范围内，忽略:', lat, lng);
              }
            }
          } catch {}
        }

        // 1d. 全部失败 → 使用西安默认坐标（国内地图可见）
        if (!coords) {
          coords = { latitude: 34.2635, longitude: 108.948 };
          console.log('[Map] 所有定位方式失败，使用西安默认坐标');
        }

        if (cancelled) return;

        setUserLocation(coords);
        dismissLoadingOverlay();

        // ---- 第二步：启动持续前台定位追踪 ----
        watchSubscription = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.High,
            distanceInterval: 3,
            timeInterval: 2000,
          },
          (loc) => {
            if (cancelled) return;
            const lat = loc.coords.latitude;
            const lng = loc.coords.longitude;
            // 只接受中国范围内的坐标更新
            if (!isInChina(lat, lng)) {
              if (__DEV__) console.warn('[Map] watchPosition 坐标不在中国范围，忽略:', lat, lng);
              return;
            }
            const newCoords: UserLocation = { latitude: lat, longitude: lng };
            if (__DEV__) {
              console.log('[Map] 位置更新:', lat.toFixed(6), lng.toFixed(6), '精度:', loc.coords.accuracy, '米');
            }
            setUserLocation(newCoords);
          },
        );
        console.log('[Map] 持续定位追踪已启动');
      } catch (error) {
        if (!cancelled) {
          console.warn('获取定位失败:', error);
          dismissLoadingOverlay();
        }
      }
    })();

    return () => {
      cancelled = true;
      if (watchSubscription) {
        watchSubscription.remove();
        console.log('[Map] 持续定位追踪已停止');
      }
    };
  }, [dismissLoadingOverlay]);

  // ---- Send user location to map when known (setView, not fitBounds) ----
  useEffect(() => {
    if (!mapReady || !userLocation) return;
    injectCall(webViewRef, 'window.setUserLocation', userLocation.latitude, userLocation.longitude);
    // 延迟刷新视口，确保 setView 后瓦片正确加载
    const timer = setTimeout(() => {
      injectCall(webViewRef, 'window.refreshView');
    }, 600);
    return () => clearTimeout(timer);
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

        const newPoints = bufferedPoints.slice(trailPathLengthRef.current);
        if (newPoints.length > 0) {
          appendTrailPoints(newPoints);
          trailPathLengthRef.current += newPoints.length;
          exploreGridsBatch(newPoints);
        }

        // ---- 队友动画：首次初始化 + 每秒位移更新 ----
        const currentPath = useHikeStore.getState().currentPath;
        if (currentPath.length >= 4 && !teammatesInitedRef.current) {
          animatorRef.current.init(currentPath);
          teammatesInitedRef.current = true;
          const renderData = animatorRef.current.tick(POLL_INTERVAL_MS / 1000);
          if (renderData.length > 0) {
            injectCall(webViewRef, 'window.addTeammates', JSON.stringify(renderData));
          }
        } else if (teammatesInitedRef.current) {
          const renderData = animatorRef.current.tick(POLL_INTERVAL_MS / 1000);
          if (renderData.length > 0) {
            injectCall(webViewRef, 'window.updateTeammates', JSON.stringify(renderData));
          }
        }
      }
    }, POLL_INTERVAL_MS);

    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [isRecording, appendTrailPoints, setTotalDistance, setElevationGain, exploreGridsBatch]);

  // ---- Cleanup ----
  useEffect(() => {
    return () => { isMountedRef.current = false; };
  }, []);

  return (
    <View style={styles.root}>
      <WebView
        key="smarthike-leaflet-map"
        ref={webViewRef}
        source={{ html: LEAFLET_HTML, baseUrl: 'https://tile.openstreetmap.org' }}
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
        mixedContentMode="always"
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
