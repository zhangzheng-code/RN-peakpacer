/**
 * ============================================================
 * AIGuideScreen — AI 智能领队 2.0（第三步重构）
 * ============================================================
 *
 * 已完成：
 *   Step 1 — 基础骨架 + 环境体征感知 HUD 看板
 *   Step 2 — 120fps SSE 流式对话 + 磨砂气泡 + Haptic
 *   Step 3 — 底栏避让 + 环境感知 Prompt + Markdown 渲染
 *   Step 4 — JIT 装备卡片端侧主动滑入 + 气象/体征双重绑定
 */

import React, {
  useState,
  useRef,
  useCallback,
  useEffect,
  useMemo,
} from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TextInput,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  Keyboard,
} from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  interpolate,
  Extrapolation,
} from "react-native-reanimated";
import { BlurView } from "expo-blur";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import { useNavigation } from "@react-navigation/native";
import { useHikeStore, type HazardAlertType } from "../store/useHikeStore";
import {
  calculatePEI,
  getPEIColor,
  getPEILabel,
} from "../utils/healthCalculator";
import {
  sendMimoStream,
  setMimoApiKey,
  getMimoApiKey,
  type MimoMessage,
} from "../services/mimoService";

// ============================================================
// 常量
// ============================================================

/** 曜石黑主题色板 */
const C = {
  bg: "#121314",
  surface: "rgba(255,255,255,0.04)",
  border: "rgba(255,255,255,0.08)",
  textPrimary: "#F3F4F6",
  textSecondary: "#9CA3AF",
  textMuted: "#6B7280",
  accent: "#10B981",
  blue: "#3B82F6",
  // AI 气泡：曜石黑磨砂卡片
  bubbleBg: "rgba(28,30,33,0.90)",
  bubbleBorder: "rgba(44,46,48,0.40)",
  // 用户气泡：半透明暗绿磨砂
  userBg: "rgba(26,46,38,0.90)",
  userBorder: "rgba(42,74,58,0.30)",
} as const;

/** 基础系统 Prompt（固定部分） */
const BASE_SYSTEM_PROMPT =
  '你是"山鹰"，一名经验丰富的高海拔徒步 AI 领队。' +
  "你精通高海拔生理学、山区微气候、野外急救和装备选配。" +
  "回答要简洁实用，优先考虑安全，支持使用 Markdown 格式化回答。" +
  "以下是用户当前的实时生理与环境数据，请据此个性化回答。\n" +
  "安全规则：\n" +
  "- 当 PEI ≥ 80 时，用户处于极度疲劳状态，必须优先建议吸氧和停止前进\n" +
  "- 当气温 < 0℃ 时，存在失温风险，必须优先建议保暖措施和防寒装备\n" +
  "- 当用户提及已租借装备时，立即规划最近的下山取装备路线\n";

/** 快捷提问入口 */
const QUICK_PROMPTS = [
  {
    icon: "🏔️",
    label: "路线规划",
    prompt: "请根据我当前的体能状态，推荐一条适合今天徒步的路线。",
  },
  {
    icon: "⚠️",
    label: "风险评估",
    prompt: "请评估我当前的体能风险，分析是否适合继续前进。",
  },
  {
    icon: "🌡️",
    label: "天气预警",
    prompt: "请根据当前位置分析天气风险，并给出穿衣和装备建议。",
  },
  {
    icon: "🎒",
    label: "装备清单",
    prompt: "请根据当前海拔和天气条件，生成一份必备装备清单。",
  },
] as const;

// ============================================================
// JIT 紧急装备卡片配置
// ============================================================

interface JITEquipConfig {
  id: string;
  icon: string;
  title: string;
  subtitle: string;
  color: string;
  borderColor: string;
  prompt: string;
  /** 紧急逃生/装备租借 GPX 轨迹点（5+ 坐标） */
  escapeRoute: Array<{ latitude: number; longitude: number }>;
}

/** 吸氧机租赁路线：围绕秦岭北麓 (34.2635, 108.948) */
const OXYGEN_ESCAPE_ROUTE = [
  { latitude: 34.2635, longitude: 108.9480 },
  { latitude: 34.2640, longitude: 108.9485 },
  { latitude: 34.2648, longitude: 108.9490 },
  { latitude: 34.2655, longitude: 108.9492 },
  { latitude: 34.2660, longitude: 108.9495 },
  { latitude: 34.2668, longitude: 108.9498 },
];

/** 冲锋衣租借路线：围绕秦岭南坡 (34.2600, 108.940) */
const COLD_ESCAPE_ROUTE = [
  { latitude: 34.2600, longitude: 108.9400 },
  { latitude: 34.2605, longitude: 108.9408 },
  { latitude: 34.2610, longitude: 108.9415 },
  { latitude: 34.2618, longitude: 108.9420 },
  { latitude: 34.2625, longitude: 108.9425 },
  { latitude: 34.2630, longitude: 108.9430 },
];

const JIT_EQUIP_MAP: Record<Exclude<HazardAlertType, null>, JITEquipConfig> = {
  oxygen: {
    id: "jit-oxygen",
    icon: "🫁",
    title: "便携式高海拔吸氧机",
    subtitle: "体征异常 · 点击一键导航至最近租赁点",
    color: "rgba(239,68,68,0.15)",
    borderColor: "rgba(239,68,68,0.40)",
    prompt:
      "我当前体征异常（心率过高/血氧过低），已经租借了便携式吸氧机，请帮我规划一条能最快拿到吸氧设备的就近下山路线！",
    escapeRoute: OXYGEN_ESCAPE_ROUTE,
  },
  cold: {
    id: "jit-cold",
    icon: "🧥",
    title: "GoreTex 保暖冲锋衣",
    subtitle: "气温跌破冰点 · 点击一键导航至最近租赁点",
    color: "rgba(59,130,246,0.15)",
    borderColor: "rgba(59,130,246,0.40)",
    prompt:
      "当前气温已经跌破冰点，我已经租借了 GoreTex 保暖冲锋衣，请帮我规划一条能最快拿到防寒装备的就近下山路线！",
    escapeRoute: COLD_ESCAPE_ROUTE,
  },
};

// ============================================================
// JIT 装备卡片组件（Reanimated 物理弹性滑入）
// ============================================================

function JITEquipmentCard({
  hazardType,
  onAction,
  onDismiss,
}: {
  hazardType: Exclude<HazardAlertType, null>;
  onAction: (hazardType: Exclude<HazardAlertType, null>) => void;
  onDismiss: () => void;
}) {
  const config = JIT_EQUIP_MAP[hazardType];

  // 动画共享值：0 = 隐藏在右侧屏幕外，1 = 完全滑入
  const slideProgress = useSharedValue(0);

  // 当 hazardType 变化时，触发动画
  useEffect(() => {
    slideProgress.value = withSpring(1, {
      damping: 14,
      stiffness: 120,
      mass: 0.8,
      overshootClamping: false,
    });
  }, [hazardType, slideProgress]);

  // 卡片容器动画样式
  const animatedCardStyle = useAnimatedStyle(() => {
    const translateX = interpolate(
      slideProgress.value,
      [0, 1],
      [400, 0],
      Extrapolation.CLAMP,
    );
    const opacity = interpolate(
      slideProgress.value,
      [0, 0.5, 1],
      [0, 0.8, 1],
      Extrapolation.CLAMP,
    );
    const scale = interpolate(
      slideProgress.value,
      [0, 0.7, 1],
      [0.85, 1.02, 1],
      Extrapolation.CLAMP,
    );
    return {
      transform: [{ translateX }, { scale }],
      opacity,
    };
  });

  const handlePress = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    onAction(hazardType);
  }, [hazardType, onAction]);

  const handleDismiss = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    // 滑出动画
    slideProgress.value = withSpring(0, {
      damping: 20,
      stiffness: 200,
    });
    // 等动画结束后清除状态
    setTimeout(onDismiss, 300);
  }, [onDismiss, slideProgress]);

  return (
    <Animated.View style={[jitStyles.card, { borderColor: config.borderColor, backgroundColor: config.color }, animatedCardStyle]}>
      <View style={jitStyles.header}>
        <Text style={jitStyles.icon}>{config.icon}</Text>
        <View style={jitStyles.headerText}>
          <Text style={jitStyles.title}>{config.title}</Text>
          <Text style={jitStyles.subtitle}>{config.subtitle}</Text>
        </View>
        <TouchableOpacity onPress={handleDismiss} style={jitStyles.dismissBtn} activeOpacity={0.7}>
          <Text style={jitStyles.dismissText}>✕</Text>
        </TouchableOpacity>
      </View>
      <TouchableOpacity onPress={handlePress} activeOpacity={0.7} style={[jitStyles.actionBtn, { borderColor: config.borderColor }]}>
        <Text style={jitStyles.actionText}>一键租借 · 查看详情 →</Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

const jitStyles = StyleSheet.create({
  card: {
    marginHorizontal: 16,
    marginBottom: 10,
    borderRadius: 20,
    borderWidth: 1,
    padding: 14,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 12,
    elevation: 8,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
  },
  icon: {
    fontSize: 28,
    marginRight: 10,
  },
  headerText: {
    flex: 1,
  },
  title: {
    fontSize: 15,
    fontWeight: "700",
    color: "#F3F4F6",
  },
  subtitle: {
    fontSize: 11,
    color: "#9CA3AF",
    marginTop: 2,
  },
  dismissBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.08)",
    alignItems: "center",
    justifyContent: "center",
  },
  dismissText: {
    fontSize: 12,
    color: "#6B7280",
    fontWeight: "600",
  },
  actionBtn: {
    marginTop: 10,
    borderRadius: 12,
    borderWidth: 1,
    paddingVertical: 10,
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.06)",
  },
  actionText: {
    fontSize: 13,
    fontWeight: "600",
    color: "#F3F4F6",
  },
});

// ============================================================
// 消息类型
// ============================================================

interface ChatBubble {
  id: string;
  role: "user" | "assistant";
  content: string;
  isStreaming: boolean;
}

// ============================================================
// Markdown 渲染器（实时流式安全）
// ============================================================

function renderMarkdown(text: string): React.ReactNode[] {
  const lines = text.split("\n");
  const elements: React.ReactNode[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const key = `md-${i}`;

    // 水平分割线
    if (line.trim() === "---" || line.trim() === "***") {
      elements.push(<View key={key} style={mdStyles.hr} />);
      continue;
    }

    // H2 / H3 标题
    if (line.startsWith("### ")) {
      elements.push(
        <Text key={key} style={mdStyles.h3}>
          {line.slice(4)}
        </Text>,
      );
      continue;
    }
    if (line.startsWith("## ")) {
      elements.push(
        <Text key={key} style={mdStyles.h2}>
          {line.slice(3)}
        </Text>,
      );
      continue;
    }

    // 加粗整行
    if (line.startsWith("**") && line.endsWith("**") && line.length > 4) {
      elements.push(
        <Text key={key} style={mdStyles.bold}>
          {line.slice(2, -2)}
        </Text>,
      );
      continue;
    }

    // 无序列表
    if (line.startsWith("- ") || line.startsWith("* ")) {
      elements.push(
        <Text key={key} style={mdStyles.listItem}>
          <Text style={mdStyles.bullet}>{"  •  "}</Text>
          {renderInline(line.slice(2))}
        </Text>,
      );
      continue;
    }

    // 有序列表
    const olMatch = line.match(/^(\d+)\.\s(.+)/);
    if (olMatch) {
      elements.push(
        <Text key={key} style={mdStyles.listItem}>
          <Text style={mdStyles.bullet}>{`  ${olMatch[1]}. `}</Text>
          {renderInline(olMatch[2])}
        </Text>,
      );
      continue;
    }

    // 空行
    if (line.trim() === "") {
      elements.push(<View key={key} style={mdStyles.blankLine} />);
      continue;
    }

    // 普通段落（含行内加粗）
    elements.push(
      <Text key={key} style={mdStyles.paragraph}>
        {renderInline(line)}
      </Text>,
    );
  }

  return elements;
}

/**
 * 行内 Markdown：处理 **bold** 标记
 * 返回 Text 节点数组（流式安全，未闭合的 ** 不会崩溃）
 */
function renderInline(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const regex = /\*\*(.+?)\*\*/g;
  let lastIndex = 0;
  let match;
  let partIdx = 0;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(
        <Text key={`in-${partIdx++}`}>
          {text.slice(lastIndex, match.index)}
        </Text>,
      );
    }
    parts.push(
      <Text key={`in-${partIdx++}`} style={mdStyles.inlineBold}>
        {match[1]}
      </Text>,
    );
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    parts.push(<Text key={`in-${partIdx++}`}>{text.slice(lastIndex)}</Text>);
  }

  return parts.length > 0 ? parts : [<Text key="in-empty">{text}</Text>];
}

const mdStyles = StyleSheet.create({
  h2: {
    fontSize: 16,
    fontWeight: "700",
    color: C.textPrimary,
    lineHeight: 24,
    marginTop: 8,
    marginBottom: 4,
  },
  h3: {
    fontSize: 14,
    fontWeight: "700",
    color: C.textPrimary,
    lineHeight: 22,
    marginTop: 6,
    marginBottom: 3,
  },
  bold: {
    fontSize: 14,
    fontWeight: "700",
    color: C.textPrimary,
    lineHeight: 22,
    marginBottom: 4,
  },
  inlineBold: {
    fontWeight: "700",
    color: C.textPrimary,
  },
  paragraph: {
    fontSize: 14,
    color: C.textPrimary,
    lineHeight: 22,
    marginBottom: 4,
  },
  listItem: {
    fontSize: 14,
    color: C.textPrimary,
    lineHeight: 22,
    marginBottom: 2,
  },
  bullet: {
    color: C.accent,
    fontWeight: "600",
  },
  hr: {
    height: 1,
    backgroundColor: "rgba(255,255,255,0.08)",
    marginVertical: 8,
  },
  blankLine: {
    height: 8,
  },
});

// ============================================================
// 环境感知 Prompt 构造器
// ============================================================

function buildEnvironmentPrompt(
  biometrics: { currentHeartRate: number; spo2: number },
  elevationGain: number,
  peiValue: number,
  peiLabel: string,
  weather: { temp: number; condition: string },
): string {
  const altitude = Math.round(1800 + elevationGain);
  return (
    BASE_SYSTEM_PROMPT +
    `- 当前海拔：${altitude}m\n` +
    `- 实时心率：${biometrics.currentHeartRate} bpm\n` +
    `- 血氧饱和度：${biometrics.spo2}%\n` +
    `- PEI 生理耗竭指数：${peiValue}（${peiLabel}）\n` +
    `- 当前气温：${weather.temp}℃\n` +
    `- 天气状况：${weather.condition}\n` +
    `- 当前定位：西安·秦岭山区\n` +
    "请结合以上数据给出个性化建议。"
  );
}

// ============================================================
// Environment HUD — 环境体征感知看板
// ============================================================

function EnvironmentHUD({ onLocationPress }: { onLocationPress?: () => void }) {
  const biometrics = useHikeStore((s) => s.biometrics);
  const profile = useHikeStore((s) => s.profile);
  const elevationGain = useHikeStore((s) => s.elevationGain);

  const peiResult = useMemo(
    () => calculatePEI(profile, biometrics, elevationGain, 0.3),
    [profile, biometrics, elevationGain],
  );
  const peiColor = getPEIColor(peiResult.level);
  const peiLabel = getPEILabel(peiResult.level);
  const altitude = Math.round(1800 + elevationGain);

  const hrColor =
    biometrics.currentHeartRate > 160
      ? "#EF4444"
      : biometrics.currentHeartRate > 130
        ? "#F59E0B"
        : C.blue;
  const spo2Color =
    biometrics.spo2 < 90
      ? "#EF4444"
      : biometrics.spo2 < 95
        ? "#F59E0B"
        : C.accent;

  const locationCell = (
    <StatCell icon="📍" value="西安·秦岭" label="定位" />
  );

  return (
    <View style={hudStyles.card}>
      <BlurView intensity={20} tint="dark" style={hudStyles.blur}>
        <View style={hudStyles.statsRow}>
          {onLocationPress ? (
            <TouchableOpacity onPress={onLocationPress} activeOpacity={0.7} style={hudStyles.statCell}>
              <Text style={hudStyles.statIcon}>📍</Text>
              <Text style={hudStyles.statValue} numberOfLines={1}>西安·秦岭</Text>
              <Text style={hudStyles.statLabel}>定位</Text>
            </TouchableOpacity>
          ) : locationCell}
          <Divider />
          <StatCell icon="⛰️" value={`${altitude}m`} label="海拔" />
          <Divider />
          <StatCell
            icon="❤️"
            value={String(biometrics.currentHeartRate)}
            valueColor={hrColor}
            label="bpm"
          />
          <Divider />
          <StatCell
            icon="🫁"
            value={`${biometrics.spo2}%`}
            valueColor={spo2Color}
            label="SpO₂"
          />
        </View>
        <View style={hudStyles.peiRow}>
          <View style={[hudStyles.peiDot, { backgroundColor: peiColor }]} />
          <Text style={hudStyles.peiLabel}>PEI</Text>
          <Text style={[hudStyles.peiValue, { color: peiColor }]}>
            {peiResult.value}
          </Text>
          <Text style={[hudStyles.peiLevel, { color: peiColor }]}>
            {peiLabel}
          </Text>
          <View style={hudStyles.peiComponents}>
            <Text style={hudStyles.peiCompText}>
              HR {peiResult.heartRateComponent}
            </Text>
            <Text style={hudStyles.peiCompDot}>·</Text>
            <Text style={hudStyles.peiCompText}>
              SpO₂ {peiResult.spo2Component}
            </Text>
            <Text style={hudStyles.peiCompDot}>·</Text>
            <Text style={hudStyles.peiCompText}>
              ALT {peiResult.altitudeComponent}
            </Text>
          </View>
        </View>
      </BlurView>
    </View>
  );
}

function StatCell({
  icon,
  value,
  valueColor,
  label,
}: {
  icon: string;
  value: string;
  valueColor?: string;
  label: string;
}) {
  return (
    <View style={hudStyles.statCell}>
      <Text style={hudStyles.statIcon}>{icon}</Text>
      <Text
        style={[hudStyles.statValue, valueColor ? { color: valueColor } : null]}
        numberOfLines={1}
      >
        {value}
      </Text>
      <Text style={hudStyles.statLabel}>{label}</Text>
    </View>
  );
}

function Divider() {
  return <View style={hudStyles.divider} />;
}

// ============================================================
// 聊天气泡（磨砂卡片 + Markdown）
// ============================================================

function ChatBubbleView({ item }: { item: ChatBubble }) {
  const isUser = item.role === "user";

  return (
    <View
      style={[
        bubbleStyles.row,
        isUser ? bubbleStyles.rowUser : bubbleStyles.rowAssistant,
      ]}
    >
      {!isUser && <Text style={bubbleStyles.avatar}>🦅</Text>}

      <View
        style={[
          bubbleStyles.card,
          isUser ? bubbleStyles.cardUser : bubbleStyles.cardAssistant,
        ]}
      >
        {isUser ? (
          <Text style={bubbleStyles.textUser}>{item.content}</Text>
        ) : (
          <View>
            {item.content.length > 0 ? (
              renderMarkdown(item.content)
            ) : item.isStreaming ? (
              <Text style={bubbleStyles.typingDots}>● ● ●</Text>
            ) : null}
            {item.isStreaming && item.content.length > 0 && (
              <Text style={bubbleStyles.cursor}> ▍</Text>
            )}
          </View>
        )}
      </View>

      {isUser && <Text style={bubbleStyles.avatar}>🧗</Text>}
    </View>
  );
}

// ============================================================
// 演示控制面板（Debug Panel）— 三连击📍定位唤出
// ============================================================

function DebugPanel({ onClose }: { onClose: () => void }) {
  // 订阅 Zustand 实时状态
  const biometrics = useHikeStore((s) => s.biometrics);
  const profile = useHikeStore((s) => s.profile);
  const elevationGain = useHikeStore((s) => s.elevationGain);
  const weather = useHikeStore((s) => s.weather);

  // 实时 PEI
  const peiResult = useMemo(
    () => calculatePEI(profile, biometrics, elevationGain, 0.3),
    [profile, biometrics, elevationGain],
  );
  const peiColor = getPEIColor(peiResult.level);
  const peiLabel = getPEILabel(peiResult.level);

  // ---- 步进器操作 ----

  const adjustHR = useCallback((delta: number) => {
    const store = useHikeStore.getState();
    const newHR = Math.max(40, Math.min(220, store.biometrics.currentHeartRate + delta));
    store.updateBiometrics({ currentHeartRate: newHR });
    // 计算新 PEI 并追加记录，触发 store 内部 JIT 危险判定
    const pei = calculatePEI(store.profile, { ...store.biometrics, currentHeartRate: newHR }, store.elevationGain, 0.3);
    store.addBiometricsRecord({ timestamp: Date.now(), heartRate: newHR, spo2: store.biometrics.spo2, pei: pei.value });
  }, []);

  const adjustSpO2 = useCallback((delta: number) => {
    const store = useHikeStore.getState();
    const newSpO2 = Math.max(70, Math.min(100, store.biometrics.spo2 + delta));
    store.updateBiometrics({ spo2: newSpO2 });
    const pei = calculatePEI(store.profile, { ...store.biometrics, spo2: newSpO2 }, store.elevationGain, 0.3);
    store.addBiometricsRecord({ timestamp: Date.now(), heartRate: store.biometrics.currentHeartRate, spo2: newSpO2, pei: pei.value });
  }, []);

  const adjustTemp = useCallback((delta: number) => {
    const store = useHikeStore.getState();
    const newTemp = store.weather.temp + delta;
    store.updateWeather(newTemp, store.weather.condition);
    // 气温变化后，追加一次当前体征记录以触发 JIT 冷/热判定
    const pei = calculatePEI(store.profile, store.biometrics, store.elevationGain, 0.3);
    store.addBiometricsRecord({ timestamp: Date.now(), heartRate: store.biometrics.currentHeartRate, spo2: store.biometrics.spo2, pei: pei.value });
  }, []);

  return (
    <View style={dbgStyles.card}>
      {/* 顶部标题栏 */}
      <View style={dbgStyles.header}>
        <Text style={dbgStyles.headerTitle}>🎛️ 演拟控制台</Text>
        <TouchableOpacity onPress={onClose} style={dbgStyles.closeBtn} activeOpacity={0.7}>
          <Text style={dbgStyles.closeText}>✕</Text>
        </TouchableOpacity>
      </View>

      {/* PEI 实时指示 */}
      <View style={dbgStyles.peiBar}>
        <View style={[dbgStyles.peiDot, { backgroundColor: peiColor }]} />
        <Text style={dbgStyles.peiLabel}>PEI</Text>
        <Text style={[dbgStyles.peiValue, { color: peiColor }]}>{peiResult.value}</Text>
        <Text style={[dbgStyles.peiLevel, { color: peiColor }]}>{peiLabel}</Text>
      </View>

      {/* 心率步进器 */}
      <StepperRow
        icon="❤️"
        label="心率"
        value={biometrics.currentHeartRate}
        unit="bpm"
        step={10}
        onMinus={() => adjustHR(-10)}
        onPlus={() => adjustHR(10)}
        valueColor={biometrics.currentHeartRate > 160 ? "#EF4444" : biometrics.currentHeartRate > 130 ? "#F59E0B" : "#3B82F6"}
      />

      {/* 血氧步进器 */}
      <StepperRow
        icon="🫁"
        label="血氧"
        value={biometrics.spo2}
        unit="%"
        step={1}
        onMinus={() => adjustSpO2(-1)}
        onPlus={() => adjustSpO2(1)}
        valueColor={biometrics.spo2 < 90 ? "#EF4444" : biometrics.spo2 < 95 ? "#F59E0B" : "#10B981"}
      />

      {/* 气温步进器 */}
      <StepperRow
        icon="🌡️"
        label="气温"
        value={weather.temp}
        unit="℃"
        step={5}
        onMinus={() => adjustTemp(-5)}
        onPlus={() => adjustTemp(5)}
        valueColor={weather.temp < 0 ? "#3B82F6" : weather.temp > 35 ? "#EF4444" : "#9CA3AF"}
      />
    </View>
  );
}

// ---- 步进器行组件 ----

function StepperRow({
  icon,
  label,
  value,
  unit,
  step,
  onMinus,
  onPlus,
  valueColor,
}: {
  icon: string;
  label: string;
  value: number;
  unit: string;
  step: number;
  onMinus: () => void;
  onPlus: () => void;
  valueColor?: string;
}) {
  return (
    <View style={dbgStyles.stepperRow}>
      <Text style={dbgStyles.stepperIcon}>{icon}</Text>
      <Text style={dbgStyles.stepperLabel}>{label}</Text>
      <TouchableOpacity onPress={onMinus} style={dbgStyles.stepBtn} activeOpacity={0.6}>
        <Text style={dbgStyles.stepBtnText}>-{step}</Text>
      </TouchableOpacity>
      <Text style={[dbgStyles.stepperValue, valueColor ? { color: valueColor } : null]}>
        {value}{unit}
      </Text>
      <TouchableOpacity onPress={onPlus} style={dbgStyles.stepBtn} activeOpacity={0.6}>
        <Text style={dbgStyles.stepBtnText}>+{step}</Text>
      </TouchableOpacity>
    </View>
  );
}

const dbgStyles = StyleSheet.create({
  card: {
    marginHorizontal: 16,
    marginBottom: 10,
    borderRadius: 24,
    backgroundColor: "rgba(28,30,33,0.95)",
    borderWidth: 1,
    borderColor: "rgba(234,179,8,0.30)",
    padding: 20,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.4,
    shadowRadius: 24,
    elevation: 16,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 14,
  },
  headerTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: "#F3F4F6",
    letterSpacing: 0.5,
  },
  closeBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.08)",
    alignItems: "center",
    justifyContent: "center",
  },
  closeText: {
    fontSize: 13,
    color: "#6B7280",
    fontWeight: "600",
  },
  peiBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 14,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.06)",
  },
  peiDot: { width: 8, height: 8, borderRadius: 4 },
  peiLabel: { fontSize: 12, fontWeight: "600", color: "#9CA3AF" },
  peiValue: { fontSize: 20, fontWeight: "800", fontVariant: ["tabular-nums"] },
  peiLevel: { fontSize: 12, fontWeight: "600" },
  stepperRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 10,
    gap: 8,
  },
  stepperIcon: { fontSize: 16 },
  stepperLabel: {
    fontSize: 13,
    fontWeight: "600",
    color: "#9CA3AF",
    width: 32,
  },
  stepBtn: {
    width: 44,
    height: 32,
    borderRadius: 10,
    backgroundColor: "rgba(255,255,255,0.08)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
    alignItems: "center",
    justifyContent: "center",
  },
  stepBtnText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#F3F4F6",
    fontVariant: ["tabular-nums"],
  },
  stepperValue: {
    fontSize: 16,
    fontWeight: "800",
    color: "#F3F4F6",
    fontVariant: ["tabular-nums"],
    minWidth: 60,
    textAlign: "center",
  },
});

// ============================================================
// 主屏幕
// ============================================================

export default function AIGuideScreen() {
  const insets = useSafeAreaInsets();

  // ---- Zustand 订阅（供环境感知 Prompt 使用） ----
  const biometrics = useHikeStore((s) => s.biometrics);
  const profile = useHikeStore((s) => s.profile);
  const elevationGain = useHikeStore((s) => s.elevationGain);
  const weather = useHikeStore((s) => s.weather);
  const hazardAlert = useHikeStore((s) => s.hazardAlert);
  const clearHazardAlert = useHikeStore((s) => s.clearHazardAlert);

  const peiResult = useMemo(
    () => calculatePEI(profile, biometrics, elevationGain, 0.3),
    [profile, biometrics, elevationGain],
  );
  const peiLabel = getPEILabel(peiResult.level);

  // ---- State ----
  const [messages, setMessages] = useState<ChatBubble[]>([]);
  const [inputText, setInputText] = useState("");
  const [isStreaming, setStreaming] = useState(false);

  // ---- Debug Panel 隐藏触发 ----
  const [showDebugPanel, setShowDebugPanel] = useState(false);
  const clickCountRef = useRef(0);
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleLocationTriplePress = useCallback(() => {
    clickCountRef.current += 1;
    if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
    if (clickCountRef.current >= 3) {
      clickCountRef.current = 0;
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setShowDebugPanel((prev) => !prev);
    } else {
      clickTimerRef.current = setTimeout(() => {
        clickCountRef.current = 0;
      }, 2000);
    }
  }, []);

  // ---- Refs ----
  const flatListRef = useRef<FlatList>(null);
  const abortController = useRef<AbortController | null>(null);
  const inputRef = useRef<TextInput>(null);

  // ---- 初始化 API Key ----
  useEffect(() => {
    if (!getMimoApiKey()) {
      setMimoApiKey("sk-cokvf06cekn7l8na5a7zxi2af5uwfkxnb286amnc6qyc3aau");
    }
  }, []);

  // ---- 主动式危险监听（Reactive Hazard Listener） ----
  // 当 Zustand 中的 hazardAlert 状态变化时（PEI ≥ 80 或气温 < 0℃），
  // 100ms 内端侧自动捕捉：触发系统级重震动 + JIT 卡片滑入
  const prevHazardRef = useRef<HazardAlertType>(null);
  useEffect(() => {
    if (hazardAlert !== null && hazardAlert !== prevHazardRef.current) {
      // 新的危险等级触发 → 立即重震动
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    }
    prevHazardRef.current = hazardAlert;
  }, [hazardAlert]);

  // ---- JIT 装备卡片：一键租借 → 导入逃生路线 + 跨页跳转 ----
  const navigation = useNavigation();
  const importRoutePath = useHikeStore((s) => s.importRoutePath);

  const handleEquipCardPress = useCallback(
    (hazardType: Exclude<HazardAlertType, null>) => {
      const config = JIT_EQUIP_MAP[hazardType];

      // 1. Haptic 确认震动
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      // 2. 一键导入紧急逃生/装备租借路线到 Zustand
      importRoutePath(config.escapeRoute);

      // 3. 跨页跳转到地图页面，自动展示路线
      (navigation as any).navigate("HikeGo");
    },
    [navigation, importRoutePath],
  );

  // ---- 悬浮输入栏的 bottom 值 ----
  const inputBottom = insets.bottom > 0 ? insets.bottom + 65 : 80;

  // ---- 自动滚动到底部 ----
  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      flatListRef.current?.scrollToEnd({ animated: true });
    });
  }, []);

  useEffect(() => {
    if (messages.length > 0) scrollToBottom();
  }, [messages, scrollToBottom]);

  // ---- 核心：发送消息并流式接收 ----
  const handleSend = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isStreaming) return;

      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      Keyboard.dismiss();
      setInputText("");

      const userBubble: ChatBubble = {
        id: `u-${Date.now()}`,
        role: "user",
        content: trimmed,
        isStreaming: false,
      };

      const aiId = `a-${Date.now()}`;
      const aiBubble: ChatBubble = {
        id: aiId,
        role: "assistant",
        content: "",
        isStreaming: true,
      };

      setMessages((prev) => [...prev, userBubble, aiBubble]);
      setStreaming(true);

      // 构造环境感知系统 Prompt
      const systemPrompt = buildEnvironmentPrompt(
        biometrics,
        elevationGain,
        peiResult.value,
        peiLabel,
        weather,
      );

      const mimoMessages: MimoMessage[] = [
        { role: "system", content: systemPrompt },
        ...messages.map(
          (m) => ({ role: m.role, content: m.content }) as MimoMessage,
        ),
        { role: "user", content: trimmed },
      ];

      const controller = new AbortController();
      abortController.current = controller;

      try {
        await sendMimoStream(
          mimoMessages,
          (_chunk, fullText, isDone) => {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === aiId
                  ? { ...m, content: fullText, isStreaming: !isDone }
                  : m,
              ),
            );
            // 每个 token 追加后平滑滚动
            scrollToBottom();
          },
          controller.signal,
        );
      } catch (err: any) {
        if (controller.signal.aborted) return;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === aiId
              ? {
                  ...m,
                  content: `⚠️ ${err.message || "请求失败，请检查网络或 API Key"}`,
                  isStreaming: false,
                }
              : m,
          ),
        );
      } finally {
        setStreaming(false);
        abortController.current = null;
      }
    },
    [
      messages,
      isStreaming,
      biometrics,
      elevationGain,
      peiResult.value,
      peiLabel,
      weather,
      scrollToBottom,
    ],
  );

  // ---- 快捷提问 ----
  const handleQuickPrompt = useCallback(
    (prompt: string) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      handleSend(prompt);
    },
    [handleSend],
  );

  // ---- 停止生成 ----
  const handleStop = useCallback(() => {
    abortController.current?.abort();
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
  }, []);

  // ---- 发送按钮 ----
  const handleSendPress = useCallback(() => {
    handleSend(inputText);
  }, [handleSend, inputText]);

  // ---- FlatList 回调 ----
  const renderItem = useCallback(
    ({ item }: { item: ChatBubble }) => <ChatBubbleView item={item} />,
    [],
  );

  const keyExtractor = useCallback((item: ChatBubble) => item.id, []);

  // ---- 空状态 ----
  const ListEmpty = useMemo(
    () => (
      <View style={styles.emptyArea}>
        <Text style={styles.emptyIcon}>🤖</Text>
        <Text style={styles.emptyTitle}>山鹰领队在线</Text>
        <Text style={styles.emptySub}>选择下方快捷问题开始对话</Text>
      </View>
    ),
    [],
  );

  // ---- 快捷提问行（空态时浮动在输入框上方） ----
  const quickPromptsBottom = inputBottom + 68;

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={insets.top}
    >
      <View style={[styles.root, { paddingTop: insets.top }]}>
        {/* ── Header ── */}
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <Text style={styles.headerTitle}>AI Guide</Text>
            <Text style={styles.headerSubtitle}>你的智能山野领队</Text>
          </View>
          {isStreaming && (
            <TouchableOpacity
              onPress={handleStop}
              activeOpacity={0.7}
              style={styles.stopBtn}
            >
              <Text style={styles.stopBtnText}>■ 停止</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* ── Environment HUD（📍定位三连击唤出 Debug 面板） ── */}
        <EnvironmentHUD onLocationPress={handleLocationTriplePress} />

        {/* ── 隐藏式演示控制面板 ── */}
        {showDebugPanel && (
          <DebugPanel onClose={() => setShowDebugPanel(false)} />
        )}

        {/* ── JIT 紧急装备卡片（端侧主动滑入） ── */}
        {hazardAlert !== null && (
          <JITEquipmentCard
            key={hazardAlert}
            hazardType={hazardAlert}
            onAction={handleEquipCardPress}
            onDismiss={clearHazardAlert}
          />
        )}

        {/* ── 聊天列表（底部大留白避让悬浮输入栏） ── */}
        <FlatList
          ref={flatListRef}
          data={messages}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          contentContainerStyle={{
            paddingHorizontal: 16,
            paddingTop: 8,
            paddingBottom: insets.bottom + 160,
            flexGrow: 1,
          }}
          style={styles.chatList}
          ListEmptyComponent={ListEmpty}
          showsVerticalScrollIndicator={false}
          keyboardDismissMode="interactive"
          onContentSizeChange={scrollToBottom}
        />

        {/* ── 快捷提问胶囊（仅空态，悬浮在输入框上方） ── */}
        {messages.length === 0 && (
          <View style={[styles.quickRow, { bottom: quickPromptsBottom }]}>
            {QUICK_PROMPTS.map((q) => (
              <TouchableOpacity
                key={q.label}
                activeOpacity={0.7}
                style={styles.quickChip}
                onPress={() => handleQuickPrompt(q.prompt)}
                disabled={isStreaming}
              >
                <Text style={styles.quickIcon}>{q.icon}</Text>
                <Text style={styles.quickLabel}>{q.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* ── 悬浮输入栏（绝对定位，浮于 TabBar 之上） ── */}
        <View
          style={[
            styles.inputBar,
            {
              position: "absolute",
              bottom: inputBottom,
              left: 16,
              right: 16,
              zIndex: 50,
            },
          ]}
        >
          <TextInput
            ref={inputRef}
            style={styles.input}
            value={inputText}
            onChangeText={setInputText}
            placeholder="向山鹰领队提问…"
            placeholderTextColor={C.textMuted}
            editable={!isStreaming}
            returnKeyType="send"
            onSubmitEditing={handleSendPress}
            blurOnSubmit={false}
            multiline
            maxLength={2000}
          />
          <TouchableOpacity
            activeOpacity={0.7}
            style={[
              styles.sendBtn,
              (!inputText.trim() || isStreaming) && styles.sendBtnDisabled,
            ]}
            onPress={handleSendPress}
            disabled={!inputText.trim() || isStreaming}
          >
            <Text style={styles.sendBtnText}>↑</Text>
          </TouchableOpacity>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

// ============================================================
// 样式表
// ============================================================

const styles = StyleSheet.create({
  flex: { flex: 1 },
  root: {
    flex: 1,
    backgroundColor: C.bg,
  },

  // ---- Header ----
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 8,
  },
  headerLeft: { flex: 1 },
  headerTitle: {
    fontSize: 28,
    fontWeight: "800",
    color: C.textPrimary,
    letterSpacing: -0.5,
  },
  headerSubtitle: {
    fontSize: 13,
    color: C.textMuted,
    marginTop: 2,
  },
  stopBtn: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: "rgba(239,68,68,0.15)",
    borderWidth: 1,
    borderColor: "rgba(239,68,68,0.30)",
  },
  stopBtnText: {
    fontSize: 13,
    fontWeight: "600",
    color: "#EF4444",
  },

  // ---- Chat FlatList ----
  chatList: {
    flex: 1,
  },
  emptyArea: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingBottom: 120,
  },
  emptyIcon: { fontSize: 48, marginBottom: 12 },
  emptyTitle: { fontSize: 18, fontWeight: "700", color: C.textPrimary },
  emptySub: { fontSize: 13, color: C.textMuted, marginTop: 4 },

  // ---- Quick prompts（绝对定位，悬浮在输入框上方） ----
  quickRow: {
    position: "absolute",
    left: 16,
    right: 16,
    flexDirection: "row",
    gap: 8,
    zIndex: 40,
  },
  quickChip: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(28,30,33,0.92)",
    borderRadius: 20,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: C.border,
    gap: 4,
  },
  quickIcon: { fontSize: 14 },
  quickLabel: { fontSize: 12, fontWeight: "600", color: C.textSecondary },

  // ---- Input bar（基础样式，absolute 定位通过 inline style 覆盖） ----
  inputBar: {
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: 14,
    paddingVertical: 8,
    gap: 10,
    borderRadius: 26,
    backgroundColor: "rgba(18,19,20,0.92)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 10,
  },
  input: {
    flex: 1,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
    fontSize: 14,
    color: C.textPrimary,
    maxHeight: 100,
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: C.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  sendBtnDisabled: {
    opacity: 0.4,
  },
  sendBtnText: {
    fontSize: 18,
    fontWeight: "700",
    color: "#fff",
  },
});

// ============================================================
// 气泡样式表
// ============================================================

const bubbleStyles = StyleSheet.create({
  row: {
    flexDirection: "row",
    marginBottom: 12,
    alignItems: "flex-end",
  },
  rowUser: {
    justifyContent: "flex-end",
  },
  rowAssistant: {
    justifyContent: "flex-start",
  },
  avatar: {
    fontSize: 20,
    marginHorizontal: 6,
    marginBottom: 2,
  },
  card: {
    maxWidth: "78%",
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  // AI 气泡：曜石黑磨砂卡片（bg-[#1C1E21]/90 rounded-3xl）
  cardAssistant: {
    backgroundColor: C.bubbleBg,
    borderWidth: 1,
    borderColor: C.bubbleBorder,
    borderRadius: 24,
    borderBottomLeftRadius: 6,
  },
  // 用户气泡：半透明暗绿磨砂（bg-[#1A2E26]/90 rounded-2xl）
  cardUser: {
    backgroundColor: C.userBg,
    borderWidth: 1,
    borderColor: C.userBorder,
    borderRadius: 16,
    borderBottomRightRadius: 6,
  },
  textUser: {
    fontSize: 14,
    lineHeight: 22,
    color: "#D1FAE5",
  },
  typingDots: {
    fontSize: 16,
    color: C.accent,
    letterSpacing: 4,
  },
  cursor: {
    color: C.accent,
    fontWeight: "300",
  },
});

// ============================================================
// HUD 样式表
// ============================================================

const hudStyles = StyleSheet.create({
  card: {
    marginHorizontal: 16,
    marginBottom: 12,
    borderRadius: 18,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: C.border,
  },
  blur: { padding: 14 },
  statsRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-around",
  },
  statCell: { alignItems: "center", flex: 1 },
  statIcon: { fontSize: 15, marginBottom: 3 },
  statValue: {
    fontSize: 14,
    fontWeight: "700",
    color: C.textPrimary,
    fontVariant: ["tabular-nums"],
  },
  statLabel: { fontSize: 9, color: C.textMuted, marginTop: 1 },
  divider: {
    width: 1,
    height: 32,
    backgroundColor: "rgba(255,255,255,0.06)",
  },
  peiRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: "rgba(255,255,255,0.06)",
    gap: 6,
  },
  peiDot: { width: 8, height: 8, borderRadius: 4 },
  peiLabel: { fontSize: 12, fontWeight: "600", color: C.textSecondary },
  peiValue: { fontSize: 18, fontWeight: "800", fontVariant: ["tabular-nums"] },
  peiLevel: { fontSize: 12, fontWeight: "600" },
  peiComponents: {
    flexDirection: "row",
    marginLeft: "auto",
    alignItems: "center",
    gap: 3,
  },
  peiCompText: {
    fontSize: 9,
    color: C.textMuted,
    fontVariant: ["tabular-nums"],
  },
  peiCompDot: { fontSize: 9, color: "rgba(255,255,255,0.2)" },
});
