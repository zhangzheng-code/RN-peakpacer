/**
 * ============================================================
 * HikeSummaryModal — 徒步结束战报弹窗
 * ============================================================
 *
 * 5 层结构（白皮书 §4.2）：
 *   1. Hero 区 — 距离大数字 + 高程剖面 SVG + 时间/爬升/卡路里
 *   2. 数据仪表盘 — 2×3 网格：均心率/均血氧/峰PEI/坡度/气温/轨迹点
 *   3. FI 圆环仪表盘 — SVG stroke-dasharray 圆环 + 分项条形图
 *   4. AI 恢复建议 — 5 张卡片按紧急度排序
 *   5. 成就徽章 — 解锁展示 + 返回按钮
 */

import React, { useMemo } from 'react';
import {
  Modal,
  View,
  Text,
  ScrollView,
  Pressable,
  StyleSheet,
} from 'react-native';
import Svg, {
  Path,
  Circle,
  Defs,
  LinearGradient,
  Stop,
  Text as SvgText,
} from 'react-native-svg';
import * as Haptics from 'expo-haptics';
import { useHikeStore } from '../store/useHikeStore';
import { useShallow } from 'zustand/shallow';
import {
  calculateFatigueIndex,
  generateRecoveryAdvice,
  getUrgencyColor,
  getUrgencyLabel,
  type FatigueInput,
  type FatigueResult,
  type RecoveryAdvice,
} from '../utils/fatigueIndex';
import type { HistoryTrack } from '../types';

// ============================================================
// 工具函数
// ============================================================

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h${m.toString().padStart(2, '0')}min`;
  return `${m}min`;
}

function formatDist(meters: number): string {
  return meters >= 1000 ? (meters / 1000).toFixed(1) : Math.round(meters).toString();
}

function distUnit(meters: number): string {
  return meters >= 1000 ? 'km' : 'm';
}

// ============================================================
// 高程剖面 SVG
// ============================================================

function ElevationProfile({ points }: { points: { altitude?: number | null }[] }) {
  const alts = points.map((p) => p.altitude).filter((a): a is number => a != null);
  if (alts.length < 2) {
    return (
      <View style={{ height: 60, justifyContent: 'center', alignItems: 'center' }}>
        <Text style={{ color: '#6B7280', fontSize: 11 }}>无高程数据</Text>
      </View>
    );
  }
  const W = 280, H = 60, P = 4;
  const lo = Math.min(...alts), hi = Math.max(...alts), rng = hi - lo || 1;
  const step = Math.max(1, Math.floor(alts.length / 70));
  const sampled: number[] = [];
  for (let i = 0; i < alts.length; i += step) sampled.push(alts[i]);
  if (sampled[sampled.length - 1] !== alts[alts.length - 1]) sampled.push(alts[alts.length - 1]);
  const sx = (W - P * 2) / (sampled.length - 1);
  let line = '', area = '';
  sampled.forEach((a, i) => {
    const x = P + i * sx;
    const y = P + (1 - (a - lo) / rng) * (H - P * 2);
    line += i === 0 ? `M${x},${y}` : `L${x},${y}`;
    area += i === 0 ? `M${x},${H}L${x},${y}` : `L${x},${y}`;
  });
  area += `L${P + (sampled.length - 1) * sx},${H}Z`;
  return (
    <Svg width={W} height={H} style={{ alignSelf: 'center' }}>
      <Defs>
        <LinearGradient id="eG" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor="#10B981" stopOpacity="0.4" />
          <Stop offset="1" stopColor="#10B981" stopOpacity="0.02" />
        </LinearGradient>
      </Defs>
      <Path d={area} fill="url(#eG)" />
      <Path d={line} fill="none" stroke="#10B981" strokeWidth="2" />
      <SvgText x={P + 2} y={P + 10} fontSize="8" fill="#6B7280">{Math.round(hi)}m</SvgText>
      <SvgText x={P + 2} y={H - 2} fontSize="8" fill="#6B7280">{Math.round(lo)}m</SvgText>
    </Svg>
  );
}

// ============================================================
// FI 圆环仪表盘
// ============================================================

function FIRingGauge({ result }: { result: FatigueResult }) {
  const S = 140, ST = 12, R = (S - ST) / 2, C = 2 * Math.PI * R;
  const offset = C * (1 - result.score / 100);
  const dims = [
    { label: '心率', v: result.components.hrLoad },
    { label: '时长', v: result.components.durationLoad },
    { label: '爬升', v: result.components.elevationLoad },
    { label: '强度', v: result.components.intensityLoad },
    { label: '恢复', v: result.components.recoveryLoad },
  ];
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16, marginTop: 8 }}>
      <Svg width={S} height={S}>
        <Circle cx={S / 2} cy={S / 2} r={R} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={ST} />
        <Circle cx={S / 2} cy={S / 2} r={R} fill="none" stroke={result.gradeColor} strokeWidth={ST}
          strokeDasharray={`${C}`} strokeDashoffset={offset} strokeLinecap="round"
          transform={`rotate(-90 ${S / 2} ${S / 2})`} />
        <SvgText x={S / 2} y={S / 2 - 8} textAnchor="middle" fontSize="28" fontWeight="800" fill={result.gradeColor}>{result.grade}</SvgText>
        <SvgText x={S / 2} y={S / 2 + 12} textAnchor="middle" fontSize="11" fill="#9CA3AF">FI {result.score}</SvgText>
      </Svg>
      <View style={{ flex: 1, gap: 6 }}>
        {dims.map((d) => (
          <View key={d.label} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text style={{ width: 28, fontSize: 10, color: '#9CA3AF' }}>{d.label}</Text>
            <View style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.06)' }}>
              <View style={{ width: `${d.v}%`, height: 6, borderRadius: 3, backgroundColor: d.v > 70 ? '#EF4444' : d.v > 40 ? '#F59E0B' : '#10B981' }} />
            </View>
            <Text style={{ width: 24, fontSize: 10, color: '#6B7280', textAlign: 'right' }}>{d.v}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

// ============================================================
// 数据格子
// ============================================================

function StatCell({ label, value, unit, color }: { label: string; value: string; unit?: string; color?: string }) {
  return (
    <View style={st.cell}>
      <Text style={[st.cellVal, color ? { color } : undefined]}>{value}{unit ? <Text style={{ fontSize: 11, fontWeight: '400', color: 'rgba(255,255,255,0.5)' }}>{unit}</Text> : null}</Text>
      <Text style={st.cellLbl}>{label}</Text>
    </View>
  );
}

// ============================================================
// 恢复建议卡片
// ============================================================

function AdviceCard({ a }: { a: RecoveryAdvice }) {
  const c = getUrgencyColor(a.urgency);
  return (
    <View style={[st.advCard, { borderLeftColor: c }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6 }}>
        <Text style={{ fontSize: 20, marginRight: 8 }}>{a.icon}</Text>
        <View style={{ flex: 1 }}>
          <Text style={st.advTitle}>{a.title}</Text>
        </View>
        <View style={[st.urgBadge, { backgroundColor: c + '20' }]}>
          <Text style={{ fontSize: 9, fontWeight: '700', color: c }}>{getUrgencyLabel(a.urgency)}</Text>
        </View>
      </View>
      <Text style={st.advBody}>{a.body}</Text>
      <Text style={st.advTime}>⏰ {a.timeWindow}</Text>
      <Text style={st.advSci}>📖 {a.scienceNote}</Text>
    </View>
  );
}

// ============================================================
// 成就徽章
// ============================================================

function Badges({ fi, track }: { fi: FatigueResult; track: HistoryTrack }) {
  const list = [
    { icon: '🏔️', label: '千米攀登', ok: track.elevationGain >= 1000 },
    { icon: '🦾', label: '铁人耐力', ok: track.duration >= 14400 },
    { icon: '⚡', label: '极限挑战', ok: fi.score >= 70 },
    { icon: '🌿', label: '悠闲漫步', ok: fi.score < 20 },
    { icon: '🎯', label: '精准配速', ok: fi.components.hrLoad >= 30 && fi.components.hrLoad <= 60 },
    { icon: '🔥', label: '首战告捷', ok: true },
  ];
  return (
    <View style={{ marginTop: 20 }}>
      <Text style={st.secTitle}>成就徽章</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        {list.map((b) => (
          <View key={b.label} style={[st.badge, !b.ok && { opacity: 0.3 }]}>
            <Text style={{ fontSize: 24 }}>{b.icon}</Text>
            <Text style={{ fontSize: 9, color: 'rgba(255,255,255,0.6)', marginTop: 4 }}>{b.label}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

// ============================================================
// 主组件
// ============================================================

export default function HikeSummaryModal() {
  const vis = useHikeStore((s) => s.isSummaryVisible);
  const dismiss = useHikeStore((s) => s.dismissSummary);
  const tracks = useHikeStore(useShallow((s) => s.historyTracks));
  const bio = useHikeStore(useShallow((s) => s.biometricsHistory));
  const profile = useHikeStore((s) => s.profile);
  const weather = useHikeStore((s) => s.weather);

  const track = useMemo(() => (tracks.length > 0 ? tracks[tracks.length - 1] : null), [tracks]);

  const agg = useMemo(() => {
    if (bio.length === 0) return { avgHR: 0, peakHR: 0, finalHR: 0, avgSpO2: 0, peakPEI: 0, z45: 0 };
    const hrs = bio.map((r) => r.heartRate);
    const spo2s = bio.map((r) => r.spo2);
    const peis = bio.map((r) => r.pei);
    const avg = (arr: number[]) => Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
    const maxHR = 220 - profile.age;
    const z45t = maxHR * 0.85;
    return {
      avgHR: avg(hrs), peakHR: Math.max(...hrs), finalHR: hrs[hrs.length - 1],
      avgSpO2: avg(spo2s), peakPEI: Math.max(...peis),
      z45: bio.filter((r) => r.heartRate > z45t).length * 2,
    };
  }, [bio, profile.age]);

  const fi = useMemo<FatigueResult | null>(() => {
    if (!track || track.duration < 10) return null;
    const maxHR = 220 - profile.age;
    return calculateFatigueIndex({
      averageHR: agg.avgHR || 80, restingHR: profile.restingHeartRate, maxHR,
      peakHR: agg.peakHR || 100, finalHR: agg.finalHR || 80,
      durationSeconds: track.duration, elevationGain: track.elevationGain,
      highIntensitySeconds: agg.z45, averageSpO2: agg.avgSpO2 || 97,
      averageSpeed: track.totalDistance / track.duration,
      temperature: weather.temp, weightKg: 70,
    });
  }, [track, agg, profile, weather]);

  const advice = useMemo<RecoveryAdvice[]>(() => {
    if (!fi || !track) return [];
    const maxHR = 220 - profile.age;
    return generateRecoveryAdvice(fi, {
      averageHR: agg.avgHR || 80, restingHR: profile.restingHeartRate, maxHR,
      peakHR: agg.peakHR || 100, finalHR: agg.finalHR || 80,
      durationSeconds: track.duration, elevationGain: track.elevationGain,
      highIntensitySeconds: agg.z45, averageSpO2: agg.avgSpO2 || 97,
      averageSpeed: track.totalDistance / track.duration,
      temperature: weather.temp, weightKg: 70,
    });
  }, [fi, track, agg, profile, weather]);

  const cal = useMemo(() => track ? Math.round(5 * 70 * (track.duration / 3600)) : 0, [track]);
  const slope = useMemo(() => track && track.totalDistance > 0 ? Math.round((track.elevationGain / track.totalDistance) * 100) : 0, [track]);

  const onClose = async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    dismiss();
  };

  if (!vis || !track) return null;

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={st.overlay}>
        <View style={st.card}>
          <View style={st.dragBar} />
          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 8 }}>

            {/* ====== L1: Hero ====== */}
            <View style={st.hero}>
              <Text style={st.heroLabel}>徒步完成</Text>
              <View style={{ flexDirection: 'row', alignItems: 'baseline' }}>
                <Text style={st.heroDist}>{formatDist(track.totalDistance)}</Text>
                <Text style={st.heroUnit}>{distUnit(track.totalDistance)}</Text>
              </View>
              <ElevationProfile points={track.trailPoints} />
              <View style={st.heroRow}>
                <View style={st.heroItem}><Text style={st.heroVal}>{formatDuration(track.duration)}</Text><Text style={st.heroLbl}>用时</Text></View>
                <View style={st.heroDiv} />
                <View style={st.heroItem}><Text style={st.heroVal}>{Math.round(track.elevationGain)}m</Text><Text style={st.heroLbl}>爬升</Text></View>
                <View style={st.heroDiv} />
                <View style={st.heroItem}><Text style={st.heroVal}>{cal}</Text><Text style={st.heroLbl}>千卡</Text></View>
              </View>
            </View>

            {/* ====== L2: 数据仪表盘 ====== */}
            <Text style={st.secTitle}>数据总览</Text>
            <View style={st.grid}>
              <StatCell label="均心率" value={`${agg.avgHR || '--'}`} unit="bpm" color="#3B82F6" />
              <StatCell label="均血氧" value={`${agg.avgSpO2 || '--'}`} unit="%" color="#10B981" />
              <StatCell label="峰PEI" value={`${agg.peakPEI || '--'}`} color="#F59E0B" />
              <StatCell label="坡度" value={`${slope}`} unit="%" />
              <StatCell label="气温" value={`${weather.temp}`} unit="℃" />
              <StatCell label="轨迹点" value={`${track.trailPoints.length}`} />
            </View>

            {/* ====== L3: FI 圆环 ====== */}
            {fi && (
              <View style={{ marginTop: 20 }}>
                <Text style={st.secTitle}>疲劳指数</Text>
                <Text style={{ color: '#9CA3AF', fontSize: 12, marginBottom: 4 }}>{fi.gradeDesc}</Text>
                <FIRingGauge result={fi} />
              </View>
            )}

            {/* ====== L4: 恢复建议 ====== */}
            {advice.length > 0 && (
              <View style={{ marginTop: 20 }}>
                <Text style={st.secTitle}>恢复建议</Text>
                {advice.map((a, i) => <AdviceCard key={i} a={a} />)}
              </View>
            )}

            {/* ====== L5: 成就徽章 ====== */}
            {fi && <Badges fi={fi} track={track} />}

            <View style={{ height: 20 }} />
          </ScrollView>

          {/* 底部按钮 */}
          <View style={st.bottomBar}>
            <Pressable style={st.returnBtn} onPress={onClose}>
              <Text style={st.returnTxt}>返回地图</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

// ============================================================
// 样式
// ============================================================

const st = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },
  card: { height: '92%', backgroundColor: '#121314', borderTopLeftRadius: 24, borderTopRightRadius: 24, overflow: 'hidden' },
  dragBar: { width: 36, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.2)', alignSelf: 'center', marginTop: 10, marginBottom: 6 },
  secTitle: { fontSize: 15, fontWeight: '700', color: 'rgba(255,255,255,0.9)', marginBottom: 12 },

  // Hero
  hero: { alignItems: 'center', paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.06)', marginBottom: 20 },
  heroLabel: { fontSize: 12, color: '#10B981', fontWeight: '600', letterSpacing: 2, marginBottom: 4 },
  heroDist: { fontSize: 56, fontWeight: '800', color: '#fff' },
  heroUnit: { fontSize: 18, fontWeight: '600', color: 'rgba(255,255,255,0.5)', marginLeft: 4 },
  heroRow: { flexDirection: 'row', alignItems: 'center', marginTop: 16, width: '100%' },
  heroItem: { flex: 1, alignItems: 'center' },
  heroVal: { fontSize: 18, fontWeight: '700', color: '#fff' },
  heroLbl: { fontSize: 10, color: 'rgba(255,255,255,0.4)', marginTop: 2 },
  heroDiv: { width: 1, height: 28, backgroundColor: 'rgba(255,255,255,0.08)' },

  // Dashboard
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  cell: { width: '31%', backgroundColor: 'rgba(255,255,255,0.04)', borderRadius: 12, padding: 12, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)' },
  cellVal: { fontSize: 20, fontWeight: '800', color: '#fff' },
  cellLbl: { fontSize: 10, color: 'rgba(255,255,255,0.4)', marginTop: 2 },

  // Advice
  advCard: { backgroundColor: 'rgba(255,255,255,0.04)', borderRadius: 12, padding: 14, marginBottom: 10, borderLeftWidth: 3, borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)' },
  advTitle: { fontSize: 13, fontWeight: '700', color: '#fff', flex: 1 },
  advBody: { fontSize: 12, color: 'rgba(255,255,255,0.7)', lineHeight: 20, marginBottom: 8 },
  advTime: { fontSize: 11, color: '#9CA3AF', marginBottom: 4 },
  advSci: { fontSize: 10, color: '#6B7280', fontStyle: 'italic', lineHeight: 16 },
  urgBadge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },

  // Badge
  badge: { width: '30%', backgroundColor: 'rgba(255,255,255,0.04)', borderRadius: 12, padding: 12, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)' },

  // Bottom
  bottomBar: { padding: 16, paddingBottom: 24, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.06)' },
  returnBtn: { backgroundColor: '#10B981', borderRadius: 14, paddingVertical: 14, alignItems: 'center' },
  returnTxt: { fontSize: 15, fontWeight: '700', color: '#fff' },
});
