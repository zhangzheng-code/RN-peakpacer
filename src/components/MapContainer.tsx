import React, { useState, useEffect, useCallback, useRef, useMemo, memo } from 'react';
import { StyleSheet, View, Text, ActivityIndicator, Pressable, Alert } from 'react-native';
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
import { processTrail } from '../utils/gpsFilter';
import {
  getTrailBuffer,
  getTotalDistance,
} from '../tasks/backgroundLocationTask';
import { useHikeStore } from '../store/useHikeStore';
import ExplorationGrids from './ExplorationGrids';
import type { UserLocation, TrailPoint } from '../types';

const INITIAL_REGION = {
  latitude: 34.2635,
  longitude: 108.948,
  latitudeDelta: 0.0922,
  longitudeDelta: 0.0421,
};

const AMAP_TILE_URL =
  'https://webrd01.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=7&x={x}&y={y}&z={z}';

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
  const hikeStatus = useHikeStore((s) => s.hikeStatus);
  const currentPath = useHikeStore((s) => s.currentPath);
  const appendTrailPoints = useHikeStore((s) => s.appendTrailPoints);
  const setTotalDistance = useHikeStore((s) => s.setTotalDistance);
  const setElevationGain = useHikeStore((s) => s.setElevationGain);
  const exploreGridsBatch = useHikeStore((s) => s.exploreGridsBatch);

  const [userLocation, setUserLocation] = useState<UserLocation | null>(null);
  const [hasLocationPermission, setHasLocationPermission] = useState(false);
  const [displayPoints, setDisplayPoints] = useState<TrailPoint[]>([]);
  const [loadingDismissed, setLoadingDismissed] = useState(false);

  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mapRef = useRef<MapView>(null);

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
      mapRef.current?.animateToRegion(
        { ...DEBUG_DEFAULT_LOCATION, latitudeDelta: 0.0922, longitudeDelta: 0.0421 },
        500,
      );
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
          mapRef.current?.animateToRegion(
            { ...coords, latitudeDelta: 0.0922, longitudeDelta: 0.0421 },
            500,
          );
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
          if (
            prev.altitude != null &&
            curr.altitude != null
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
  }, [isRecording, currentPath.length, appendTrailPoints, setTotalDistance, setElevationGain, exploreGridsBatch]);

  const polylineCoordinates = useMemo(
    () => displayPoints.map((p) => ({ latitude: p.latitude, longitude: p.longitude })),
    [displayPoints],
  );

  return (
    <View style={styles.root}>
      {/* MapView — absoluteFillObject ensures it never collapses */}
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFillObject}
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
        <UrlTile urlTemplate={AMAP_TILE_URL} maximumZ={18} tileSize={256} flipY={false} />
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
