/**
 * ============================================================
 * 高性能 SVG 实时生理指标折线图
 * ============================================================
 *
 * 双轴渲染：心率（左 Y 轴，荧光蓝）+ PEI（右 Y 轴，荧光绿）
 * 渐变填充、呼吸闪烁端点、最大最小标注
 */

import React, { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Path, Circle, Defs, LinearGradient as SvgGradient, Stop, Line, Text as SvgText } from 'react-native-svg';
import type { BiometricsRecord } from '../types';

const CHART_WIDTH = 320;
const CHART_HEIGHT = 160;
const PADDING_LEFT = 36;
const PADDING_RIGHT = 36;
const PADDING_TOP = 20;
const PADDING_BOTTOM = 24;

const PLOT_W = CHART_WIDTH - PADDING_LEFT - PADDING_RIGHT;
const PLOT_H = CHART_HEIGHT - PADDING_TOP - PADDING_BOTTOM;

const HR_COLOR = '#3B82F6';
const PEI_COLOR = '#10B981';
const GRID_COLOR = 'rgba(255,255,255,0.06)';
const LABEL_COLOR = '#6B7280';

interface BiometricsChartProps {
  data: BiometricsRecord[];
}

function lerp(value: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
  if (inMax === inMin) return (outMin + outMax) / 2;
  return outMin + ((value - inMin) / (inMax - inMin)) * (outMax - outMin);
}

export default function BiometricsChart({ data }: BiometricsChartProps) {
  const chartMetrics = useMemo(() => {
    if (data.length === 0) {
      return null;
    }

    const hrValues = data.map((d) => d.heartRate);
    const peiValues = data.map((d) => d.pei);

    const hrMin = Math.min(...hrValues);
    const hrMax = Math.max(...hrValues);
    const peiMin = Math.min(...peiValues);
    const peiMax = Math.max(...peiValues);

    // Add 10% padding to ranges
    const hrRange = hrMax - hrMin || 10;
    const peiRange = peiMax - peiMin || 10;
    const hrMinPadded = hrMin - hrRange * 0.1;
    const hrMaxPadded = hrMax + hrRange * 0.1;
    const peiMinPadded = peiMin - peiRange * 0.1;
    const peiMaxPadded = peiMax + peiRange * 0.1;

    const n = data.length;

    // Build HR polyline points
    const hrPoints: Array<{ x: number; y: number }> = data.map((d, i) => ({
      x: PADDING_LEFT + (i / Math.max(n - 1, 1)) * PLOT_W,
      y: PADDING_TOP + PLOT_H - lerp(d.heartRate, hrMinPadded, hrMaxPadded, 0, PLOT_H),
    }));

    // Build PEI polyline points
    const peiPoints: Array<{ x: number; y: number }> = data.map((d, i) => ({
      x: PADDING_LEFT + (i / Math.max(n - 1, 1)) * PLOT_W,
      y: PADDING_TOP + PLOT_H - lerp(d.pei, peiMinPadded, peiMaxPadded, 0, PLOT_H),
    }));

    // SVG path strings for lines
    const hrLinePath = hrPoints
      .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`)
      .join(' ');

    const peiLinePath = peiPoints
      .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`)
      .join(' ');

    // Gradient fill paths (line + close to bottom)
    const hrFillPath =
      hrLinePath +
      ` L ${hrPoints[hrPoints.length - 1].x} ${PADDING_TOP + PLOT_H}` +
      ` L ${hrPoints[0].x} ${PADDING_TOP + PLOT_H} Z`;

    const peiFillPath =
      peiLinePath +
      ` L ${peiPoints[peiPoints.length - 1].x} ${PADDING_TOP + PLOT_H}` +
      ` L ${peiPoints[0].x} ${PADDING_TOP + PLOT_H} Z`;

    // Latest point (for pulse dot)
    const hrLatest = hrPoints[hrPoints.length - 1];
    const peiLatest = peiPoints[peiPoints.length - 1];

    // Min/max annotations
    const hrMinIdx = hrValues.indexOf(hrMin);
    const hrMaxIdx = hrValues.indexOf(hrMax);
    const peiMinIdx = peiValues.indexOf(peiMin);
    const peiMaxIdx = peiValues.indexOf(peiMax);

    return {
      hrLinePath,
      peiLinePath,
      hrFillPath,
      peiFillPath,
      hrLatest,
      peiLatest,
      hrMin,
      hrMax,
      peiMin,
      peiMax,
      hrMinPadded,
      hrMaxPadded,
      peiMinPadded,
      peiMaxPadded,
      hrMinPoint: hrPoints[hrMinIdx],
      hrMaxPoint: hrPoints[hrMaxIdx],
      peiMinPoint: peiPoints[peiMinIdx],
      peiMaxPoint: peiPoints[peiMaxIdx],
    };
  }, [data]);

  if (data.length < 2 || !chartMetrics) {
    return (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyIcon}>📈</Text>
        <Text style={styles.emptyText}>等待体征数据...</Text>
        <Text style={styles.emptySubtext}>数据积累后自动绘制趋势图</Text>
      </View>
    );
  }

  const m = chartMetrics;
  const now = Date.now();

  return (
    <View style={styles.container}>
      {/* Legend */}
      <View style={styles.legendRow}>
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: HR_COLOR }]} />
          <Text style={styles.legendLabel}>心率 (bpm)</Text>
        </View>
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: PEI_COLOR }]} />
          <Text style={styles.legendLabel}>PEI</Text>
        </View>
      </View>

      <Svg width={CHART_WIDTH} height={CHART_HEIGHT}>
        <Defs>
          {/* HR gradient fill */}
          <SvgGradient id="hrGrad" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={HR_COLOR} stopOpacity="0.25" />
            <Stop offset="1" stopColor={HR_COLOR} stopOpacity="0.02" />
          </SvgGradient>
          {/* PEI gradient fill */}
          <SvgGradient id="peiGrad" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={PEI_COLOR} stopOpacity="0.2" />
            <Stop offset="1" stopColor={PEI_COLOR} stopOpacity="0.02" />
          </SvgGradient>
        </Defs>

        {/* Horizontal grid lines */}
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const y = PADDING_TOP + PLOT_H * (1 - ratio);
          return (
            <Line
              key={ratio}
              x1={PADDING_LEFT}
              y1={y}
              x2={PADDING_LEFT + PLOT_W}
              y2={y}
              stroke={GRID_COLOR}
              strokeWidth={1}
            />
          );
        })}

        {/* HR gradient fill area */}
        <Path d={m.hrFillPath} fill="url(#hrGrad)" />
        {/* PEI gradient fill area */}
        <Path d={m.peiFillPath} fill="url(#peiGrad)" />

        {/* HR line */}
        <Path d={m.hrLinePath} stroke={HR_COLOR} strokeWidth={2} fill="none" strokeLinecap="round" strokeLinejoin="round" />
        {/* PEI line */}
        <Path d={m.peiLinePath} stroke={PEI_COLOR} strokeWidth={2} fill="none" strokeLinecap="round" strokeLinejoin="round" />

        {/* HR latest pulse dot */}
        <Circle cx={m.hrLatest.x} cy={m.hrLatest.y} r={5} fill={HR_COLOR} opacity={0.3} />
        <Circle cx={m.hrLatest.x} cy={m.hrLatest.y} r={3} fill={HR_COLOR} />
        {/* PEI latest pulse dot */}
        <Circle cx={m.peiLatest.x} cy={m.peiLatest.y} r={5} fill={PEI_COLOR} opacity={0.3} />
        <Circle cx={m.peiLatest.x} cy={m.peiLatest.y} r={3} fill={PEI_COLOR} />

        {/* HR min/max labels */}
        <SvgText
          x={m.hrMinPoint.x}
          y={m.hrMinPoint.y + 14}
          fill={HR_COLOR}
          fontSize={9}
          fontWeight="600"
          textAnchor="middle"
        >
          {m.hrMin}
        </SvgText>
        <SvgText
          x={m.hrMaxPoint.x}
          y={m.hrMaxPoint.y - 6}
          fill={HR_COLOR}
          fontSize={9}
          fontWeight="600"
          textAnchor="middle"
        >
          {m.hrMax}
        </SvgText>

        {/* PEI min/max labels */}
        <SvgText
          x={m.peiMinPoint.x}
          y={m.peiMinPoint.y + 14}
          fill={PEI_COLOR}
          fontSize={9}
          fontWeight="600"
          textAnchor="middle"
        >
          {m.peiMin.toFixed(1)}
        </SvgText>
        <SvgText
          x={m.peiMaxPoint.x}
          y={m.peiMaxPoint.y - 6}
          fill={PEI_COLOR}
          fontSize={9}
          fontWeight="600"
          textAnchor="middle"
        >
          {m.peiMax.toFixed(1)}
        </SvgText>

        {/* Left Y-axis labels (HR) */}
        <SvgText x={4} y={PADDING_TOP + 4} fill={LABEL_COLOR} fontSize={8} textAnchor="start">
          {Math.round(m.hrMaxPadded)}
        </SvgText>
        <SvgText x={4} y={PADDING_TOP + PLOT_H} fill={LABEL_COLOR} fontSize={8} textAnchor="start">
          {Math.round(m.hrMinPadded)}
        </SvgText>

        {/* Right Y-axis labels (PEI) */}
        <SvgText x={CHART_WIDTH - 4} y={PADDING_TOP + 4} fill={LABEL_COLOR} fontSize={8} textAnchor="end">
          {m.peiMaxPadded.toFixed(0)}
        </SvgText>
        <SvgText x={CHART_WIDTH - 4} y={PADDING_TOP + PLOT_H} fill={LABEL_COLOR} fontSize={8} textAnchor="end">
          {m.peiMinPadded.toFixed(0)}
        </SvgText>
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
  },
  legendRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 20,
    marginBottom: 8,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  legendLabel: {
    fontSize: 11,
    color: '#9CA3AF',
    fontWeight: '500',
  },
  emptyContainer: {
    height: 160,
    borderRadius: 12,
    backgroundColor: 'rgba(16,185,129,0.04)',
    borderWidth: 1,
    borderColor: 'rgba(16,185,129,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyIcon: {
    fontSize: 32,
    marginBottom: 6,
  },
  emptyText: {
    fontSize: 13,
    fontWeight: '600',
    color: 'rgba(16,185,129,0.5)',
  },
  emptySubtext: {
    fontSize: 11,
    color: '#4B5563',
    marginTop: 3,
  },
});
