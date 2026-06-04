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
// 等高线地形图：OpenTopoMap
const TOPO_URL =
  'https://a.tile.opentopomap.org/{z}/{x}/{y}.png';

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

      // 等高线地形图
      var topoTile = createTileLayer('${TOPO_URL}', { maxZoom: 17 });

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

      // ---- 路线渲染状态 ----
      var trailSegments = [];       // 渐变色分段 polyline 数组
      var trailOutline = null;      // 路线描边 polyline
      var startMarker = null;       // 起点标记
      var endMarker = null;         // 终点标记
      var directionArrows = [];     // 方向箭头标记数组

      /**
       * 海拔→颜色插值（绿→黄→红）
       */
      function elevationColor(alt, minAlt, maxAlt) {
        if (maxAlt <= minAlt) return '#10B981';
        var t = Math.max(0, Math.min(1, (alt - minAlt) / (maxAlt - minAlt)));
        // 绿 #10B981 → 黄 #F59E0B → 红 #EF4444
        var r, g, b;
        if (t < 0.5) {
          var t2 = t * 2;
          r = Math.round(16 + (245 - 16) * t2);
          g = Math.round(185 + (158 - 185) * t2);
          b = Math.round(129 + (11 - 129) * t2);
        } else {
          var t2 = (t - 0.5) * 2;
          r = Math.round(245 + (239 - 245) * t2);
          g = Math.round(158 + (68 - 158) * t2);
          b = Math.round(11 + (68 - 11) * t2);
        }
        return 'rgb(' + r + ',' + g + ',' + b + ')';
      }

      /**
       * 清除旧路线元素
       */
      function clearTrack() {
        var i;
        for (i = 0; i < trailSegments.length; i++) {
          map.removeLayer(trailSegments[i]);
        }
        trailSegments = [];
        if (trailOutline) { map.removeLayer(trailOutline); trailOutline = null; }
        if (trailPolyline) { map.removeLayer(trailPolyline); trailPolyline = null; }
        if (startMarker) { map.removeLayer(startMarker); startMarker = null; }
        if (endMarker) { map.removeLayer(endMarker); endMarker = null; }
        for (i = 0; i < directionArrows.length; i++) {
          map.removeLayer(directionArrows[i]);
        }
        directionArrows = [];
      }

      /**
       * 绘制/更新轨迹线（渐变色 + 起终点 + 方向箭头）
       *
       * @param {string} pointsJson - JSON 数组，每个元素 [lat, lng] 或 [lat, lng, altitude]
       */
      window.drawTrack = function(pointsJson) {
        try {
          var points = JSON.parse(pointsJson);
          if (!points || points.length === 0) return;

          clearTrack();

          if (points.length === 1) {
            // ---- 单点降级 ----
            var pt = points[0];
            trailPolyline = L.polyline([pt], {
              color: '#10B981',
              weight: 5,
              lineCap: 'round',
              lineJoin: 'round',
            }).addTo(map);
            // 起点标记
            startMarker = L.marker(pt, {
              icon: L.divIcon({
                className: 'track-marker',
                html: '<div style="width:28px;height:28px;border-radius:50%;background:#10B981;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:800;color:#fff;box-shadow:0 2px 8px rgba(16,185,129,0.5);border:2px solid rgba(255,255,255,0.8);">S</div>',
                iconSize: [28, 28],
                iconAnchor: [14, 14],
              }),
              interactive: false,
            }).addTo(map);
            map.setView(pt, 16, { animate: true, duration: 0.5 });
            return;
          }

          // ---- 多点渐变路线 ----
          // 提取海拔数据（如果有）
          var hasAltitude = points[0].length >= 3 && points[0][2] != null;
          var minAlt = Infinity, maxAlt = -Infinity;
          var i;

          if (hasAltitude) {
            for (i = 0; i < points.length; i++) {
              if (points[i][2] < minAlt) minAlt = points[i][2];
              if (points[i][2] > maxAlt) maxAlt = points[i][2];
            }
          }

          // 描边（底层，营造立体感）
          trailOutline = L.polyline(points, {
            color: 'rgba(0,0,0,0.35)',
            weight: 9,
            lineCap: 'round',
            lineJoin: 'round',
            smoothFactor: 1,
          }).addTo(map);

          // 渐变分段
          if (hasAltitude && maxAlt > minAlt) {
            var segLen = Math.max(2, Math.floor(points.length / 30)); // 约 30 段
            for (i = 0; i < points.length - 1; i += segLen) {
              var end = Math.min(i + segLen + 1, points.length);
              var segPoints = points.slice(i, end);
              var midAlt = (points[i][2] + points[end - 1][2]) / 2;
              var seg = L.polyline(segPoints, {
                color: elevationColor(midAlt, minAlt, maxAlt),
                weight: 5,
                lineCap: 'round',
                lineJoin: 'round',
                smoothFactor: 1,
              }).addTo(map);
              trailSegments.push(seg);
            }
          } else {
            // 无海拔数据：使用单色渐变（从头到尾颜色渐变）
            var segLen2 = Math.max(2, Math.floor(points.length / 30));
            for (i = 0; i < points.length - 1; i += segLen2) {
              var end2 = Math.min(i + segLen2 + 1, points.length);
              var t = i / (points.length - 1);
              var segPoints2 = points.slice(i, end2);
              var seg2 = L.polyline(segPoints2, {
                color: elevationColor(t * 100, 0, 100),
                weight: 5,
                lineCap: 'round',
                lineJoin: 'round',
                smoothFactor: 1,
              }).addTo(map);
              trailSegments.push(seg2);
            }
          }

          // ---- 起点标记（绿色 S）----
          startMarker = L.marker(points[0], {
            icon: L.divIcon({
              className: 'track-marker',
              html: '<div style="width:30px;height:30px;border-radius:50%;background:linear-gradient(135deg,#10B981,#059669);display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:800;color:#fff;box-shadow:0 3px 12px rgba(16,185,129,0.6);border:2.5px solid rgba(255,255,255,0.9);">S</div>',
              iconSize: [30, 30],
              iconAnchor: [15, 15],
            }),
            interactive: false,
          }).addTo(map);

          // ---- 终点标记（红色 E）----
          endMarker = L.marker(points[points.length - 1], {
            icon: L.divIcon({
              className: 'track-marker',
              html: '<div style="width:30px;height:30px;border-radius:50%;background:linear-gradient(135deg,#EF4444,#DC2626);display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:800;color:#fff;box-shadow:0 3px 12px rgba(239,68,68,0.6);border:2.5px solid rgba(255,255,255,0.9);">E</div>',
              iconSize: [30, 30],
              iconAnchor: [15, 15],
            }),
            interactive: false,
          }).addTo(map);

          // ---- 方向箭头（每隔 ~500m 一个小三角）----
          // 估算总距离（粗略，用经纬度差）
          var totalDist = 0;
          for (i = 1; i < points.length; i++) {
            var dlat = points[i][0] - points[i-1][0];
            var dlng = points[i][1] - points[i-1][1];
            totalDist += Math.sqrt(dlat * dlat + dlng * dlng);
          }
          var arrowInterval = Math.max(3, Math.floor(points.length * (0.003 / Math.max(totalDist, 0.001))));
          arrowInterval = Math.min(arrowInterval, Math.floor(points.length / 3));

          for (i = arrowInterval; i < points.length - 1; i += arrowInterval) {
            var p1 = points[i - 1];
            var p2 = points[i];
            var angle = Math.atan2(p2[1] - p1[1], p2[0] - p1[0]) * 180 / Math.PI;
            var arrow = L.marker(points[i], {
              icon: L.divIcon({
                className: 'direction-arrow',
                html: '<div style="width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;border-bottom:8px solid rgba(255,255,255,0.7);transform:rotate(' + (90 - angle) + 'deg);"></div>',
                iconSize: [10, 8],
                iconAnchor: [5, 4],
              }),
              interactive: false,
            }).addTo(map);
            directionArrows.push(arrow);
          }

          // fitBounds
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
          // 移除当前图层
          if (currentTileType === 'standard') map.removeLayer(standardTile);
          else if (currentTileType === 'satellite') map.removeLayer(satelliteTile);
          else if (currentTileType === 'topo') map.removeLayer(topoTile);

          if (source === 'satellite') {
            satelliteTile.addTo(map);
            currentTileType = 'satellite';
          } else if (source === 'topo') {
            topoTile.addTo(map);
            currentTileType = 'topo';
          } else {
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
       * @param {number} lat
       * @param {number} lng
       * @param {boolean} [recenter=true] - 是否自动居中（有路线时传 false）
       */
      window.setUserLocation = function(lat, lng, recenter) {
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
          // 首次定位或跟随模式且无路线 → 自动居中
          var shouldRecenter = recenter !== false && (isFirst || followMode);
          if (shouldRecenter) {
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
       * 心率→颜色（绿/黄/红 区间）
       */
      function hrColor(hr) {
        if (hr < 100) return '#10B981';
        if (hr < 140) return '#F59E0B';
        return '#EF4444';
      }

      /**
       * 初始化队友标记（首次调用）
       */
      window.addTeammates = function(teammatesJson) {
        try {
          var teammates = JSON.parse(teammatesJson);
          for (var i = 0; i < teammates.length; i++) {
            var t = teammates[i];
            if (teammateMarkers[t.id]) continue;
            var hColor = hrColor(t.heartRate);
            var statusIcon = t.isResting ? '🌙' : '🏃';
            var icon = L.divIcon({
              className: 'tm-container',
              html: '<div style="position:relative;width:56px;height:72px;">' +
                    // 脉冲光环
                    '<div style="position:absolute;width:56px;height:56px;top:0;left:0;border-radius:50%;border:2px solid ' + t.color + ';opacity:0.25;animation:tm-pulse 2s ease-in-out infinite;"></div>' +
                    // 主头像圆
                    '<div style="position:absolute;width:38px;height:38px;top:9px;left:9px;border-radius:50%;background:' + t.color + ';display:flex;align-items:center;justify-content:center;border:2.5px solid rgba(255,255,255,0.35);box-shadow:0 3px 14px rgba(0,0,0,0.5);">' +
                    '<span style="font-size:19px;">' + t.emoji + '</span></div>' +
                    // 状态指示（右下角）
                    '<div class="tm-status" style="position:absolute;bottom:14px;right:-2px;font-size:11px;filter:drop-shadow(0 1px 2px rgba(0,0,0,0.5));">' + statusIcon + '</div>' +
                    // 心率徽章（右上角，颜色随心率变化）
                    '<div style="position:absolute;top:-4px;right:-20px;background:rgba(0,0,0,0.82);border-radius:10px;padding:2px 7px;display:flex;align-items:center;gap:3px;border:1px solid ' + hColor + '40;">' +
                    '<span style="color:' + hColor + ';font-size:8px;">♥</span>' +
                    '<span class="tm-hr-val" style="color:' + hColor + ';font-size:10px;font-weight:700;">' + t.heartRate + '</span></div>' +
                    // 名字标签
                    '<div style="position:absolute;bottom:-2px;left:50%;transform:translateX(-50%);font-size:9px;font-weight:600;color:rgba(255,255,255,0.6);white-space:nowrap;text-shadow:0 1px 3px rgba(0,0,0,0.8);">' + t.name + '</div></div>',
              iconSize: [56, 72],
              iconAnchor: [28, 36],
            });
            var marker = L.marker([t.lat, t.lng], { icon: icon, interactive: false }).addTo(map);
            teammateMarkers[t.id] = marker;
          }
        } catch (e) {}
      };

      /**
       * 更新队友位置、心率、状态（每秒调用）
       */
      window.updateTeammates = function(teammatesJson) {
        try {
          var teammates = JSON.parse(teammatesJson);
          for (var i = 0; i < teammates.length; i++) {
            var t = teammates[i];
            var marker = teammateMarkers[t.id];
            if (!marker) continue;
            marker.setLatLng([t.lat, t.lng]);
            var el = marker.getElement();
            if (!el) continue;
            // 更新心率数字 + 颜色
            var hrEl = el.querySelector('.tm-hr-val');
            if (hrEl) {
              var hColor = hrColor(t.heartRate);
              hrEl.textContent = t.heartRate;
              hrEl.style.color = hColor;
            }
            // 更新状态图标
            var statusEl = el.querySelector('.tm-status');
            if (statusEl) {
              statusEl.textContent = t.isResting ? '🌙' : '🏃';
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
  const isRouteActive = useHikeStore((s) => s.isRouteActive);
  const currentPath = useHikeStore(useShallow((s) => s.currentPath));
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

  // ---- Sync trail to WebView (from polling loop) ----
  useEffect(() => {
    if (!mapReady || displayPoints.length === 0) return;

    const coords: Array<[number, number]> = displayPoints.map((p) => [
      p.latitude,
      p.longitude,
    ]);
    // drawTrack 内部处理单点 vs 多点逻辑
    injectCall(webViewRef, 'window.drawTrack', JSON.stringify(coords));
  }, [displayPoints, mapReady]);

  // ---- Sync imported route to WebView (from importRoutePath) ----
  // 当 currentPath 被外部导入时（isRouteActive），直接调用 drawTrack 渲染路线
  const prevCurrentPathLenRef = useRef(0);
  useEffect(() => {
    if (!mapReady || !isRouteActive || currentPath.length === 0) return;
    // 仅当 currentPath 长度变化时触发（避免 GPS 追加点重复渲染）
    if (currentPath.length === prevCurrentPathLenRef.current) return;
    prevCurrentPathLenRef.current = currentPath.length;

    const coords: Array<[number, number]> = currentPath.map((p) => [
      p.latitude,
      p.longitude,
    ]);
    injectCall(webViewRef, 'window.drawTrack', JSON.stringify(coords));
  }, [currentPath, mapReady, isRouteActive]);

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

        // 1d. 全部失败 → 不设默认坐标，地图留在初始视角，无蓝点
        if (!coords) {
          console.log('[Map] GPS 不可用，地图保持初始视角，等待导入路线或真实 GPS');
        }

        if (cancelled) return;

        if (coords) {
          setUserLocation(coords);
        }
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

  // ---- Send user location to map when known ----
  // 有路线时只更新蓝点（recenter=false），无路线时 GPS 驱动地图中心（recenter=true）
  useEffect(() => {
    if (!mapReady || !userLocation) return;
    const shouldRecenter = !isRouteActive;
    injectCall(webViewRef, 'window.setUserLocation', userLocation.latitude, userLocation.longitude, shouldRecenter);
    // 延迟刷新视口，确保 setView 后瓦片正确加载
    const timer = setTimeout(() => {
      injectCall(webViewRef, 'window.refreshView');
    }, 600);
    return () => clearTimeout(timer);
  }, [userLocation, mapReady, isRouteActive]);

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
      // ---- GPS 数据处理（有后台定位数据时） ----
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
      }

      // ---- 队友动画：首次初始化 + 每秒位移更新 ----
      // 独立于 GPS 数据，导入路线时也能初始化队友
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
    }, POLL_INTERVAL_MS);

    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [isRecording, appendTrailPoints, setTotalDistance, setElevationGain, exploreGridsBatch]);

  // ---- Route Info Card (shown when route is active) ----
  const [routeInfo, setRouteInfo] = useState<{
    distance: number;
    elevationGain: number;
    estimatedTime: number; // minutes
    pointCount: number;
  } | null>(null);
  const [routeInfoVisible, setRouteInfoVisible] = useState(false);

  useEffect(() => {
    if (!isRouteActive || currentPath.length < 2) {
      setRouteInfoVisible(false);
      return;
    }
    // 计算路线统计
    let dist = 0;
    let gain = 0;
    for (let i = 1; i < currentPath.length; i++) {
      const prev = currentPath[i - 1];
      const curr = currentPath[i];
      // Haversine 距离
      const R = 6371000;
      const toRad = (d: number) => (d * Math.PI) / 180;
      const dLat = toRad(curr.latitude - prev.latitude);
      const dLon = toRad(curr.longitude - prev.longitude);
      const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(prev.latitude)) * Math.cos(toRad(curr.latitude)) * Math.sin(dLon / 2) ** 2;
      dist += R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      // 海拔增益
      if (prev.altitude != null && curr.altitude != null) {
        const delta = curr.altitude - prev.altitude;
        if (delta > 0) gain += delta;
      }
    }
    // Naismith 估算时间：5km/h + 30min/300m 爬升
    const hours = dist / 5000 + gain / 300 * 0.5;
    setRouteInfo({ distance: dist, elevationGain: gain, estimatedTime: Math.round(hours * 60), pointCount: currentPath.length });
    setRouteInfoVisible(true);
    // 6 秒后自动隐藏
    const timer = setTimeout(() => setRouteInfoVisible(false), 6000);
    return () => clearTimeout(timer);
  }, [isRouteActive, currentPath]);

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

      {/* Route Info Card */}
      {routeInfoVisible && routeInfo && (
        <Pressable
          style={styles.routeInfoCard}
          onPress={() => setRouteInfoVisible(false)}
        >
          <View style={styles.routeInfoRow}>
            <View style={styles.routeInfoItem}>
              <Text style={styles.routeInfoValue}>
                {routeInfo.distance >= 1000
                  ? (routeInfo.distance / 1000).toFixed(1) + ' km'
                  : Math.round(routeInfo.distance) + ' m'}
              </Text>
              <Text style={styles.routeInfoLabel}>距离</Text>
            </View>
            <View style={styles.routeInfoDivider} />
            <View style={styles.routeInfoItem}>
              <Text style={styles.routeInfoValue}>{Math.round(routeInfo.elevationGain)} m</Text>
              <Text style={styles.routeInfoLabel}>爬升</Text>
            </View>
            <View style={styles.routeInfoDivider} />
            <View style={styles.routeInfoItem}>
              <Text style={styles.routeInfoValue}>
                {routeInfo.estimatedTime >= 60
                  ? Math.floor(routeInfo.estimatedTime / 60) + 'h' + (routeInfo.estimatedTime % 60) + 'min'
                  : routeInfo.estimatedTime + ' min'}
              </Text>
              <Text style={styles.routeInfoLabel}>预计</Text>
            </View>
            <View style={styles.routeInfoDivider} />
            <View style={styles.routeInfoItem}>
              <Text style={styles.routeInfoValue}>{routeInfo.pointCount}</Text>
              <Text style={styles.routeInfoLabel}>轨迹点</Text>
            </View>
          </View>
        </Pressable>
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
  // ---- Route Info Card ----
  routeInfoCard: {
    position: 'absolute',
    top: 12,
    left: 12,
    right: 12,
    backgroundColor: 'rgba(18,19,20,0.85)',
    borderRadius: 16,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 8,
    zIndex: 30,
  },
  routeInfoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
  },
  routeInfoItem: {
    alignItems: 'center',
    flex: 1,
  },
  routeInfoValue: {
    fontSize: 16,
    fontWeight: '700',
    color: '#fff',
  },
  routeInfoLabel: {
    fontSize: 10,
    color: 'rgba(255,255,255,0.45)',
    marginTop: 2,
  },
  routeInfoDivider: {
    width: 1,
    height: 28,
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
});

export default memo(MapContainer);
