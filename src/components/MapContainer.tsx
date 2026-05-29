/**
 * ============================================================
 * MapContainer — WebView + Leaflet.js 地图引擎
 * ============================================================
 *
 * 100% 免费、免配置、多端一致的高帧率地图方案。
 * 用 react-native-webview 渲染本地自闭环 HTML + Leaflet，
 * 通过 postMessage / injectJavaScript 双向桥接通信。
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
import type { UserLocation, TrailPoint, TileSourceType } from '../types';

// ---- Constants ----

const INITIAL_CENTER: UserLocation = { latitude: 34.2635, longitude: 108.948 };
const INITIAL_ZOOM = 13;

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

// ---- Leaflet HTML Template ----

function buildLeafletHTML(): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"><\/script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body, #map { width: 100%; height: 100%; background: #121314; }
    .leaflet-control-attribution { display: none !important; }
    .leaflet-control-zoom { display: none !important; }
  </style>
</head>
<body>
  <div id="map"></div>
  <script>
    (function() {
      // ---- Initialize map ----
      var map = L.map('map', {
        center: [${INITIAL_CENTER.latitude}, ${INITIAL_CENTER.longitude}],
        zoom: ${INITIAL_ZOOM},
        zoomControl: false,
        attributionControl: false,
        preferCanvas: true,
      });

      // ---- Tile layers ----
      var standardTile = L.tileLayer('${AMAP_STANDARD_URL}', {
        maxZoom: 18,
        tileSize: 256,
      });

      var satelliteTile = L.tileLayer('${AMAP_SATELLITE_URL}', {
        maxZoom: 18,
        tileSize: 256,
      });

      standardTile.addTo(map);
      var currentTileType = 'standard';

      // ---- Trail polyline ----
      var trailLayer = L.layerGroup().addTo(map);
      var trailPolyline = null;

      // ---- Exploration grids ----
      var gridLayer = L.layerGroup().addTo(map);
      var gridRectangles = {};

      // ---- User location marker ----
      var userMarker = null;
      var userCircle = null;

      // ---- Helpers ----
      function sendMessage(type, data) {
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: type, data: data }));
      }

      // ---- Message handler ----
      window.handleRNMessage = function(msg) {
        try {
          var cmd = JSON.parse(msg);

          switch (cmd.type) {
            case 'updateTrail':
              if (trailPolyline) {
                trailLayer.removeLayer(trailPolyline);
              }
              if (cmd.coords && cmd.coords.length >= 2) {
                trailPolyline = L.polyline(cmd.coords, {
                  color: '${TRAIL_COLOR}',
                  weight: ${TRAIL_WEIGHT},
                  lineCap: 'round',
                  lineJoin: 'round',
                  smoothFactor: 1,
                });
                trailLayer.addLayer(trailPolyline);
              }
              break;

            case 'updateGrids':
              // Remove old grids not in new set
              var newKeys = {};
              if (cmd.keys) {
                for (var i = 0; i < cmd.keys.length; i++) {
                  newKeys[cmd.keys[i]] = true;
                }
              }
              // Remove stale
              for (var oldKey in gridRectangles) {
                if (!newKeys[oldKey]) {
                  gridLayer.removeLayer(gridRectangles[oldKey]);
                  delete gridRectangles[oldKey];
                }
              }
              // Add new
              if (cmd.grids) {
                for (var j = 0; j < cmd.grids.length; j++) {
                  var g = cmd.grids[j];
                  if (!gridRectangles[g.key]) {
                    var rect = L.rectangle(
                      [[g.south, g.west], [g.north, g.east]],
                      {
                        fillColor: '${GRID_FILL_COLOR}',
                        fillOpacity: 1,
                        stroke: false,
                        interactive: false,
                      }
                    );
                    gridLayer.addLayer(rect);
                    gridRectangles[g.key] = rect;
                  }
                }
              }
              break;

            case 'setTileSource':
              if (cmd.source === 'satellite' && currentTileType !== 'satellite') {
                map.removeLayer(standardTile);
                satelliteTile.addTo(map);
                currentTileType = 'satellite';
              } else if (cmd.source === 'standard' && currentTileType !== 'standard') {
                map.removeLayer(satelliteTile);
                standardTile.addTo(map);
                currentTileType = 'standard';
              }
              break;

            case 'flyTo':
              map.flyTo([cmd.lat, cmd.lng], cmd.zoom || ${INITIAL_ZOOM}, { duration: 0.8 });
              break;

            case 'setUserLocation':
              var latlng = [cmd.lat, cmd.lng];
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
              break;

            case 'centerOnUser':
              if (userMarker) {
                var pos = userMarker.getLatLng();
                map.flyTo(pos, cmd.zoom || 15, { duration: 0.5 });
              }
              break;
          }
        } catch (e) {
          sendMessage('error', e.message);
        }
      };

      // ---- Notify RN that map is ready ----
      sendMessage('mapReady', {});
    })();
  <\/script>
</body>
</html>`;
}

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

// ---- Props ----

interface MapContainerProps {
  tileSource?: TileSourceType;
}

// ---- Main Component ----

function MapContainer({ tileSource = 'standard' }: MapContainerProps) {
  const hikeStatus = useHikeStore((s) => s.hikeStatus);
  const currentPath = useHikeStore((s) => s.currentPath);
  const exploredGrids = useHikeStore((s) => s.exploredGrids);
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
  const trailCoordsRef = useRef<Array<[number, number]>>([]);

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

  // ---- Inject JS helper ----
  const injectJS = useCallback((js: string) => {
    if (webViewRef.current) {
      webViewRef.current.injectJavaScript(js);
    }
  }, []);

  // ---- Send message to WebView ----
  const sendToMap = useCallback((type: string, data: Record<string, unknown>) => {
    const payload = JSON.stringify({ type, ...data });
    injectJS(`window.handleRNMessage('${payload.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}');`);
  }, [injectJS]);

  // ---- Handle messages from WebView ----
  const handleWebViewMessage = useCallback((event: WebViewMessageEvent) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      switch (msg.type) {
        case 'mapReady':
          setMapReady(true);
          break;
        case 'error':
          console.warn('Leaflet error:', msg.data);
          break;
      }
    } catch {
      // ignore parse errors
    }
  }, []);

  // ---- Sync trail polyline to WebView ----
  useEffect(() => {
    if (!mapReady) return;

    const coords: Array<[number, number]> = displayPoints.map((p) => [
      p.latitude,
      p.longitude,
    ]);
    trailCoordsRef.current = coords;

    if (coords.length >= 2) {
      sendToMap('updateTrail', { coords });
    }
  }, [displayPoints, mapReady, sendToMap]);

  // ---- Sync exploration grids to WebView ----
  useEffect(() => {
    if (!mapReady) return;

    const GRID_SIZE = 0.001;
    const grids = exploredGrids.map((key) => {
      const parts = key.split(',');
      const latIndex = parseInt(parts[0], 10);
      const lngIndex = parseInt(parts[1], 10);
      const south = latIndex * GRID_SIZE;
      const north = south + GRID_SIZE;
      const west = lngIndex * GRID_SIZE;
      const east = west + GRID_SIZE;
      return { key, south, north, west, east };
    });

    sendToMap('updateGrids', { grids, keys: exploredGrids });
  }, [exploredGrids, mapReady, sendToMap]);

  // ---- Sync tile source to WebView ----
  useEffect(() => {
    if (!mapReady) return;
    sendToMap('setTileSource', { source: tileSource });
  }, [tileSource, mapReady, sendToMap]);

  // ---- Debug bypass: double-tap loading overlay ----
  const lastTapRef = useRef(0);
  const handleLoadingDoubleTap = useCallback(() => {
    const now = Date.now();
    if (now - lastTapRef.current < 300) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setUserLocation(DEBUG_DEFAULT_LOCATION);
      dismissLoadingOverlay();
      if (mapReady) {
        sendToMap('flyTo', { lat: DEBUG_DEFAULT_LOCATION.latitude, lng: DEBUG_DEFAULT_LOCATION.longitude });
      }
    }
    lastTapRef.current = now;
  }, [dismissLoadingOverlay, mapReady, sendToMap]);

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

  // ---- Send user location to map when known ----
  useEffect(() => {
    if (!mapReady || !userLocation) return;
    sendToMap('setUserLocation', { lat: userLocation.latitude, lng: userLocation.longitude });
    sendToMap('flyTo', { lat: userLocation.latitude, lng: userLocation.longitude, zoom: 15 });
  }, [userLocation, mapReady, sendToMap]);

  // ---- Foreground polling: read trail buffer, update display + store ----
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

  // ---- HTML source (memoized, never changes) ----
  const htmlSource = useRef({ html: buildLeafletHTML() }).current;

  return (
    <View style={styles.root}>
      {/* WebView Leaflet Map — absoluteFill ensures it never collapses */}
      <WebView
        ref={webViewRef}
        source={htmlSource}
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
      />

      {/* GPS Loading Overlay — double-tap to bypass */}
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
