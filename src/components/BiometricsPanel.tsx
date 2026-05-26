/**
 * ============================================================
 * 体征模拟控制面板（BiometricsPanel）
 * ============================================================
 *
 * Glassmorphism 风格的可折叠控制面板。
 * 提供 Slider 滑动条模拟心率和血氧输入，
 * 实时显示 PEI 数值和各分量。
 *
 * 设计风格：
 * - 磨砂半透明背景（rgba + blur）
 * - 圆角卡片阴影
 * - 动态颜色指示风险等级
 */

import React, { useState, useMemo, useCallback } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  Animated,
  PanResponder,
  Dimensions,
} from 'react-native';
import { useHikeStore } from '../store/useHikeStore';
import { calculatePEI, getPEIColor, getPEILabel } from '../utils/healthCalculator';

/**
 * 屏幕宽度，用于 Slider 布局计算
 */
const SCREEN_WIDTH = Dimensions.get('window').width;

/**
 * Slider 组件属性
 */
interface SliderProps {
  /** 当前值 */
  value: number;
  /** 最小值 */
  minimumValue: number;
  /** 最大值 */
  maximumValue: number;
  /** 步长 */
  step?: number;
  /** 左侧标签 */
  label: string;
  /** 单位 */
  unit: string;
  /** 轨道颜色 */
  trackColor?: string;
  /** 值变化回调 */
  onValueChange: (value: number) => void;
}

/**
 * 自定义 Slider 组件
 *
 * 使用 PanResponder 实现手势拖动，
 * 避免依赖 @react-native-community/slider 等额外包。
 */
function CustomSlider({
  value,
  minimumValue,
  maximumValue,
  step = 1,
  label,
  unit,
  trackColor = '#1890ff',
  onValueChange,
}: SliderProps) {
  const [trackWidth, setTrackWidth] = useState(0);

  /** 当前值在轨道上的百分比位置 */
  const percentage = (value - minimumValue) / (maximumValue - minimumValue);

  /** 手势响应器 */
  const panResponder = PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: () => {},
    onPanResponderMove: (_, gestureState) => {
      if (trackWidth <= 0) return;
      const clampedX = Math.max(0, Math.min(gestureState.moveX - 32, trackWidth));
      const ratio = clampedX / trackWidth;
      const rawValue = minimumValue + ratio * (maximumValue - minimumValue);
      const steppedValue = Math.round(rawValue / step) * step;
      const clampedValue = Math.max(minimumValue, Math.min(maximumValue, steppedValue));
      onValueChange(clampedValue);
    },
    onPanResponderRelease: () => {},
  });

  return (
    <View style={sliderStyles.container}>
      <View style={sliderStyles.labelRow}>
        <Text style={sliderStyles.label}>{label}</Text>
        <Text style={[sliderStyles.valueText, { color: trackColor }]}>
          {Math.round(value)} {unit}
        </Text>
      </View>
      <View
        style={sliderStyles.trackContainer}
        onLayout={(e) => setTrackWidth(e.nativeEvent.layout.width)}
        {...panResponder.panHandlers}
      >
        <View style={sliderStyles.trackBackground}>
          <View
            style={[
              sliderStyles.trackFill,
              {
                width: `${percentage * 100}%`,
                backgroundColor: trackColor,
              },
            ]}
          />
        </View>
        <View
          style={[
            sliderStyles.thumb,
            {
              left: `${percentage * 100}%`,
              backgroundColor: trackColor,
            },
          ]}
        />
      </View>
    </View>
  );
}

/**
 * BiometricsPanel 主组件
 */
export default function BiometricsPanel() {
  const [isExpanded, setIsExpanded] = useState(false);

  const { profile, biometrics, updateBiometrics, hikeStatus } = useHikeStore();

  /** 计算当前 PEI */
  const peiResult = useMemo(
    () => calculatePEI(profile, biometrics, 0, 0.3),
    [profile, biometrics],
  );

  /** PEI 对应颜色 */
  const peiColor = useMemo(() => getPEIColor(peiResult.level), [peiResult.level]);

  /** PEI 对应标签 */
  const peiLabel = useMemo(() => getPEILabel(peiResult.level), [peiResult.level]);

  /** 切换展开/折叠 */
  const handleToggle = useCallback(() => {
    setIsExpanded((prev) => !prev);
  }, []);

  /** 更新心率 */
  const handleHeartRateChange = useCallback(
    (value: number) => {
      updateBiometrics({ currentHeartRate: value });
    },
    [updateBiometrics],
  );

  /** 更新血氧 */
  const handleSpo2Change = useCallback(
    (value: number) => {
      updateBiometrics({ spo2: value });
    },
    [updateBiometrics],
  );

  /** 仅在录制时显示 */
  if (hikeStatus !== 'recording') {
    return null;
  }

  return (
    <View style={styles.wrapper}>
      {/* 折叠态：PEI 摘要条 */}
      <TouchableOpacity
        style={[styles.summaryBar, { borderLeftColor: peiColor }]}
        onPress={handleToggle}
        activeOpacity={0.8}
      >
        <View style={styles.summaryLeft}>
          <Text style={styles.summaryLabel}>PEI</Text>
          <Text style={[styles.summaryValue, { color: peiColor }]}>
            {peiResult.value}
          </Text>
          <Text style={[styles.summaryLevel, { color: peiColor }]}>
            {peiLabel}
          </Text>
        </View>
        <Text style={styles.expandIcon}>{isExpanded ? '▼' : '▲'}</Text>
      </TouchableOpacity>

      {/* 展开态：完整控制面板 */}
      {isExpanded && (
        <View style={styles.panel}>
          {/* 心率 Slider */}
          <CustomSlider
            value={biometrics.currentHeartRate}
            minimumValue={60}
            maximumValue={200}
            step={1}
            label="心率"
            unit="bpm"
            trackColor={
              biometrics.currentHeartRate > 160
                ? '#ff4d4f'
                : biometrics.currentHeartRate > 130
                ? '#faad14'
                : '#1890ff'
            }
            onValueChange={handleHeartRateChange}
          />

          {/* 血氧 Slider */}
          <CustomSlider
            value={biometrics.spo2}
            minimumValue={80}
            maximumValue={100}
            step={1}
            label="血氧饱和度"
            unit="%"
            trackColor={
              biometrics.spo2 < 90
                ? '#ff4d4f'
                : biometrics.spo2 < 95
                ? '#faad14'
                : '#52c41a'
            }
            onValueChange={handleSpo2Change}
          />

          {/* PEI 分量详情 */}
          <View style={styles.componentSection}>
            <Text style={styles.componentTitle}>PEI 分量构成</Text>
            <View style={styles.componentRow}>
              <View style={styles.componentItem}>
                <View
                  style={[styles.componentDot, { backgroundColor: '#1890ff' }]}
                />
                <Text style={styles.componentLabel}>心率</Text>
                <Text style={styles.componentValue}>
                  {peiResult.heartRateComponent}
                </Text>
              </View>
              <View style={styles.componentItem}>
                <View
                  style={[styles.componentDot, { backgroundColor: '#52c41a' }]}
                />
                <Text style={styles.componentLabel}>血氧</Text>
                <Text style={styles.componentValue}>
                  {peiResult.spo2Component}
                </Text>
              </View>
              <View style={styles.componentItem}>
                <View
                  style={[styles.componentDot, { backgroundColor: '#722ed1' }]}
                />
                <Text style={styles.componentLabel}>海拔</Text>
                <Text style={styles.componentValue}>
                  {peiResult.altitudeComponent}
                </Text>
              </View>
            </View>
          </View>

          {/* PEI 公式说明 */}
          <View style={styles.formulaSection}>
            <Text style={styles.formulaText}>
              PEI = 0.50 × HR分量 + 0.35 × SpO₂分量 + 0.15 × 海拔分量
            </Text>
          </View>
        </View>
      )}
    </View>
  );
}

// ---- 样式定义 ----

const styles = StyleSheet.create({
  wrapper: {
    position: 'absolute',
    bottom: 120,
    left: 16,
    right: 16,
    zIndex: 20,
  },
  summaryBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: 'rgba(255, 255, 255, 0.85)',
    borderRadius: 16,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderLeftWidth: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 5,
  },
  summaryLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  summaryLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#666',
  },
  summaryValue: {
    fontSize: 22,
    fontWeight: '800',
  },
  summaryLevel: {
    fontSize: 13,
    fontWeight: '600',
  },
  expandIcon: {
    fontSize: 12,
    color: '#999',
  },
  panel: {
    marginTop: 8,
    backgroundColor: 'rgba(255, 255, 255, 0.92)',
    borderRadius: 20,
    padding: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 16,
    elevation: 8,
  },
  componentSection: {
    marginTop: 16,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: '#f0f0f0',
  },
  componentTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#666',
    marginBottom: 10,
  },
  componentRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
  },
  componentItem: {
    alignItems: 'center',
    gap: 4,
  },
  componentDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  componentLabel: {
    fontSize: 12,
    color: '#999',
  },
  componentValue: {
    fontSize: 16,
    fontWeight: '700',
    color: '#333',
  },
  formulaSection: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#f0f0f0',
  },
  formulaText: {
    fontSize: 11,
    color: '#aaa',
    textAlign: 'center',
    fontFamily: 'monospace',
  },
});

const sliderStyles = StyleSheet.create({
  container: {
    marginBottom: 16,
  },
  labelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    color: '#333',
  },
  valueText: {
    fontSize: 16,
    fontWeight: '700',
  },
  trackContainer: {
    height: 32,
    justifyContent: 'center',
    position: 'relative',
  },
  trackBackground: {
    height: 6,
    borderRadius: 3,
    backgroundColor: '#e8e8e8',
    overflow: 'hidden',
  },
  trackFill: {
    height: '100%',
    borderRadius: 3,
  },
  thumb: {
    position: 'absolute',
    width: 24,
    height: 24,
    borderRadius: 12,
    top: 4,
    marginLeft: -12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 4,
  },
});
