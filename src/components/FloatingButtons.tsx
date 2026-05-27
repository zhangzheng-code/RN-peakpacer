import React, { useCallback } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import type { TileSourceType } from '../types';

interface FloatingButtonsProps {
  activeSource: TileSourceType;
  onSwitchSource: () => void;
  onOpenAI: () => void;
}

export default function FloatingButtons({
  activeSource,
  onSwitchSource,
  onOpenAI,
}: FloatingButtonsProps) {
  const insets = useSafeAreaInsets();

  const handleSwitchPress = useCallback(async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onSwitchSource();
  }, [onSwitchSource]);

  const handleAIPress = useCallback(async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onOpenAI();
  }, [onOpenAI]);

  const buttonBase = {
    width: 44 as const,
    height: 44 as const,
    borderRadius: 22 as const,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    shadowOffset: { width: 0, height: 2 },
    shadowRadius: 8,
    elevation: 5,
    borderWidth: 1,
  };

  return (
    <View
      className="absolute right-4 z-10 items-center"
      style={{ top: insets.top + 8, gap: 12 }}
    >
      {/* 图源切换按钮 */}
      <TouchableOpacity
        onPress={handleSwitchPress}
        activeOpacity={0.7}
        style={{
          ...buttonBase,
          backgroundColor: 'rgba(255,255,255,0.88)',
          shadowColor: '#000',
          shadowOpacity: 0.12,
          borderColor: 'rgba(255,255,255,0.3)',
        }}
      >
        <Text style={{ fontSize: 18 }}>
          {activeSource === 'standard' ? '🛰️' : '🗺️'}
        </Text>
      </TouchableOpacity>

      {/* AI 领队按钮 */}
      <TouchableOpacity
        onPress={handleAIPress}
        activeOpacity={0.7}
        style={{
          ...buttonBase,
          backgroundColor: 'rgba(24, 144, 255, 0.92)',
          shadowColor: '#1890ff',
          shadowOpacity: 0.25,
          borderColor: 'rgba(255,255,255,0.2)',
        }}
      >
        <Text style={{ fontSize: 18 }}>🤖</Text>
      </TouchableOpacity>
    </View>
  );
}
