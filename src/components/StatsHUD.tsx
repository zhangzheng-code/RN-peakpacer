import React, { useMemo } from 'react';
import { View, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface StatsHUDProps {
  elapsedSeconds: number;
  totalDistance: number;
  elevationGain: number;
}

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatDistance(meters: number): string {
  if (meters >= 1000) {
    return `${(meters / 1000).toFixed(2)} km`;
  }
  return `${Math.round(meters)} m`;
}

function formatSpeed(meters: number, seconds: number): string {
  if (seconds <= 0 || meters <= 0) return '0.0';
  const kmPerHour = (meters / 1000) / (seconds / 3600);
  return kmPerHour.toFixed(1);
}

export default function StatsHUD({ elapsedSeconds, totalDistance, elevationGain }: StatsHUDProps) {
  const insets = useSafeAreaInsets();

  const speed = useMemo(
    () => formatSpeed(totalDistance, elapsedSeconds),
    [totalDistance, elapsedSeconds],
  );

  return (
    <View
      className="absolute left-4 right-4 z-10 rounded-2xl border border-white/20 bg-white/90 px-5 py-3"
      style={{
        top: insets.top + 8,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.12,
        shadowRadius: 16,
        elevation: 8,
      }}
    >
      <View className="flex-row items-center justify-between">
        {/* Left: Time */}
        <View className="flex-1 items-center">
          <Text className="text-xs text-muted mb-1">&#x23F1;&#xFE0F; 用时</Text>
          <Text className="text-xl font-bold text-dark font-mono tracking-wider">
            {formatTime(elapsedSeconds)}
          </Text>
        </View>

        {/* Divider */}
        <View className="w-px h-8 bg-gray-200 mx-2" />

        {/* Middle: Elevation */}
        <View className="flex-1 items-center">
          <Text className="text-xs text-muted mb-1">&#x1F3D4;&#xFE0F; 爬升</Text>
          <Text className="text-xl font-bold text-dark">
            {Math.round(elevationGain)}
            <Text className="text-sm text-muted"> m</Text>
          </Text>
        </View>

        {/* Divider */}
        <View className="w-px h-8 bg-gray-200 mx-2" />

        {/* Right: Speed */}
        <View className="flex-1 items-center">
          <Text className="text-xs text-muted mb-1">&#x26A1; 速度</Text>
          <Text className="text-xl font-bold text-dark">
            {speed}
            <Text className="text-sm text-muted"> km/h</Text>
          </Text>
        </View>
      </View>
    </View>
  );
}
