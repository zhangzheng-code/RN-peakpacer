/**
 * ============================================================
 * ToolCallWell — 工具调用卡片组件
 * ============================================================
 *
 * 渲染 AI 工具调用的可视化卡片：
 *   - 品牌渐变标题栏（颜色由工具类型决定）
 *   - 状态指示器（⏳ → 🔄 → ✅ / ❌）
 *   - 可展开/收起的结果详情（Animated 动效）
 *   - 结构化数据渲染（路线、装备、天气、危险评估）
 */

import React, { useState, useCallback } from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  interpolate,
} from "react-native-reanimated";
import { LinearGradient } from "expo-linear-gradient";
import * as Haptics from "expo-haptics";

// ============================================================
// 类型
// ============================================================

export type ToolCallStatus = "pending" | "executing" | "done" | "error";

export interface ToolCallState {
  id: string;
  name: string;
  arguments: Record<string, any>;
  status: ToolCallStatus;
  result?: object;
  error?: string;
  gradientColors: [string, string];
  label: string;
  icon: string;
}

// ============================================================
// 状态映射
// ============================================================

const STATUS_CONFIG: Record<
  ToolCallStatus,
  { color: string; label: string; icon: string }
> = {
  pending: { color: "#6B7280", label: "等待中", icon: "⏳" },
  executing: { color: "#3B82F6", label: "执行中...", icon: "🔄" },
  done: { color: "#10B981", label: "完成", icon: "✅" },
  error: { color: "#EF4444", label: "失败", icon: "❌" },
};

// ============================================================
// 结果渲染器
// ============================================================

function renderResult(toolName: string, result: any): React.ReactNode {
  if (!result) return null;

  // ---- 路线推荐 ----
  if (toolName === "get_route_advice" && result.recommended_routes) {
    return (
      <View style={resultStyles.container}>
        {result.recommended_routes.map(
          (route: any, i: number) => (
            <View key={i} style={resultStyles.routeRow}>
              <View style={resultStyles.routeLeft}>
                <Text style={resultStyles.routeName}>{route.name}</Text>
                <Text style={resultStyles.routeMeta}>
                  {route.distance_km}km · ↑{route.elevation_m}m ·{" "}
                  {route.difficulty === "easy"
                    ? "休闲"
                    : route.difficulty === "medium"
                      ? "中等"
                      : "挑战"}
                </Text>
              </View>
              <View style={resultStyles.scoreBadge}>
                <Text style={resultStyles.scoreText}>
                  {Math.round(route.match_score * 100)}%
                </Text>
              </View>
            </View>
          ),
        )}
        {result.current_fitness && (
          <Text style={resultStyles.footer}>
            当前 PEI: {result.current_fitness.pei}（
            {result.current_fitness.level === "safe"
              ? "状态良好"
              : result.current_fitness.level === "warning"
                ? "轻度疲劳"
                : "极度危险"}
            ）
          </Text>
        )}
      </View>
    );
  }

  // ---- 装备推荐 ----
  if (toolName === "get_gear_recommendation" && result.gear_list) {
    return (
      <View style={resultStyles.container}>
        {result.gear_list.length === 0 ? (
          <Text style={resultStyles.emptyText}>
            当前状态良好，无需特殊装备 ✅
          </Text>
        ) : (
          result.gear_list.map((gear: any, i: number) => (
            <View key={i} style={resultStyles.gearRow}>
              <Text style={resultStyles.gearIcon}>{gear.icon}</Text>
              <View style={resultStyles.gearInfo}>
                <Text style={resultStyles.gearName}>{gear.name}</Text>
                <Text style={resultStyles.gearDesc}>{gear.description}</Text>
              </View>
            </View>
          ))
        )}
      </View>
    );
  }

  // ---- 天气查询 ----
  if (toolName === "check_weather") {
    return (
      <View style={resultStyles.container}>
        <View style={resultStyles.weatherMain}>
          <Text style={resultStyles.weatherTemp}>{result.temperature}℃</Text>
          <Text style={resultStyles.weatherCondition}>{result.condition}</Text>
        </View>
        <Text style={resultStyles.weatherImpact}>{result.hiking_impact}</Text>
        {result.warnings &&
          result.warnings.length > 0 &&
          result.warnings.map((w: string, i: number) => (
            <Text key={i} style={resultStyles.warningItem}>
              ⚠️ {w}
            </Text>
          ))}
      </View>
    );
  }

  // ---- 危险评估 ----
  if (toolName === "assess_danger" && result.risks) {
    return (
      <View style={resultStyles.container}>
        <Text
          style={[
            resultStyles.dangerSummary,
            {
              color:
                result.overall_risk === "critical"
                  ? "#EF4444"
                  : result.overall_risk === "elevated"
                    ? "#F59E0B"
                    : "#10B981",
            },
          ]}
        >
          {result.summary}
        </Text>
        {result.risks.map((risk: any, i: number) => (
          <View key={i} style={resultStyles.riskRow}>
            <View
              style={[
                resultStyles.riskDot,
                {
                  backgroundColor:
                    risk.level === "danger"
                      ? "#EF4444"
                      : risk.level === "warning"
                        ? "#F59E0B"
                        : "#10B981",
                },
              ]}
            />
            <Text style={resultStyles.riskDetail}>{risk.detail}</Text>
          </View>
        ))}
      </View>
    );
  }

  // ---- 通用 fallback ----
  return (
    <View style={resultStyles.container}>
      <Text style={resultStyles.genericText}>
        {JSON.stringify(result, null, 2).slice(0, 300)}
      </Text>
    </View>
  );
}

// ============================================================
// 主组件
// ============================================================

interface ToolCallWellProps {
  tool: ToolCallState;
}

export function ToolCallWell({ tool }: ToolCallWellProps) {
  const [expanded, setExpanded] = useState(false);
  const progress = useSharedValue(0);

  const statusCfg = STATUS_CONFIG[tool.status];

  const toggleExpand = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const next = !expanded;
    setExpanded(next);
    progress.value = withTiming(next ? 1 : 0, { duration: 250 });
  }, [expanded, progress]);

  const animatedContentStyle = useAnimatedStyle(() => ({
    maxHeight: interpolate(progress.value, [0, 1], [0, 500]),
    opacity: interpolate(progress.value, [0, 1], [0, 1]),
  }));

  return (
    <View style={styles.wrapper}>
      {/* 渐变标题栏 */}
      <LinearGradient
        colors={tool.gradientColors}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={styles.header}
      >
        <View style={styles.headerLeft}>
          <Text style={styles.headerIcon}>{tool.icon}</Text>
          <Text style={styles.headerLabel}>{tool.label}</Text>
        </View>
        <View style={styles.headerRight}>
          <Text style={styles.statusIcon}>{statusCfg.icon}</Text>
          <Text style={[styles.statusText, { color: "#fff" }]}>
            {statusCfg.label}
          </Text>
        </View>
      </LinearGradient>

      {/* 可展开区域 */}
      {tool.status === "done" && tool.result && (
        <TouchableOpacity
          activeOpacity={0.8}
          onPress={toggleExpand}
          style={styles.body}
        >
          <View style={styles.expandHeader}>
            <Text style={styles.expandText}>
              {expanded ? "收起详情 ▲" : "展开详情 ▼"}
            </Text>
          </View>

          <Animated.View style={[styles.animatedContent, animatedContentStyle]}>
            {renderResult(tool.name, tool.result)}
          </Animated.View>
        </TouchableOpacity>
      )}

      {/* 错误信息 */}
      {tool.status === "error" && tool.error && (
        <View style={styles.body}>
          <Text style={styles.errorText}>❌ {tool.error}</Text>
        </View>
      )}

      {/* 执行中动画 */}
      {tool.status === "executing" && (
        <View style={styles.body}>
          <Text style={styles.executingText}>正在调用工具...</Text>
        </View>
      )}
    </View>
  );
}

// ============================================================
// 样式
// ============================================================

const styles = StyleSheet.create({
  wrapper: {
    borderRadius: 14,
    overflow: "hidden",
    backgroundColor: "rgba(28,30,33,0.95)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
    marginVertical: 6,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
  },
  headerIcon: {
    fontSize: 16,
    marginRight: 8,
  },
  headerLabel: {
    fontSize: 13,
    fontWeight: "700",
    color: "#fff",
    letterSpacing: 0.5,
  },
  headerRight: {
    flexDirection: "row",
    alignItems: "center",
  },
  statusIcon: {
    fontSize: 12,
    marginRight: 4,
  },
  statusText: {
    fontSize: 11,
    fontWeight: "600",
  },
  body: {
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  expandHeader: {
    alignItems: "center",
    paddingVertical: 2,
  },
  expandText: {
    fontSize: 11,
    color: "#9CA3AF",
    letterSpacing: 0.3,
  },
  animatedContent: {
    overflow: "hidden",
  },
  executingText: {
    fontSize: 12,
    color: "#3B82F6",
    textAlign: "center",
  },
  errorText: {
    fontSize: 12,
    color: "#EF4444",
  },
});

// ============================================================
// 结果渲染样式
// ============================================================

const resultStyles = StyleSheet.create({
  container: {
    paddingTop: 8,
  },
  // 路线
  routeRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(255,255,255,0.06)",
  },
  routeLeft: {
    flex: 1,
  },
  routeName: {
    fontSize: 13,
    fontWeight: "600",
    color: "#F3F4F6",
  },
  routeMeta: {
    fontSize: 11,
    color: "#9CA3AF",
    marginTop: 2,
  },
  scoreBadge: {
    backgroundColor: "rgba(59,130,246,0.15)",
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  scoreText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#3B82F6",
  },
  footer: {
    fontSize: 11,
    color: "#6B7280",
    marginTop: 8,
    fontStyle: "italic",
  },
  // 装备
  gearRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(255,255,255,0.06)",
  },
  gearIcon: {
    fontSize: 18,
    marginRight: 10,
  },
  gearInfo: {
    flex: 1,
  },
  gearName: {
    fontSize: 13,
    fontWeight: "600",
    color: "#F3F4F6",
  },
  gearDesc: {
    fontSize: 11,
    color: "#9CA3AF",
    marginTop: 1,
  },
  emptyText: {
    fontSize: 12,
    color: "#10B981",
    textAlign: "center",
    paddingVertical: 8,
  },
  // 天气
  weatherMain: {
    flexDirection: "row",
    alignItems: "baseline",
    marginBottom: 6,
  },
  weatherTemp: {
    fontSize: 24,
    fontWeight: "800",
    color: "#F59E0B",
    marginRight: 8,
  },
  weatherCondition: {
    fontSize: 14,
    color: "#F3F4F6",
  },
  weatherImpact: {
    fontSize: 12,
    color: "#9CA3AF",
    marginBottom: 4,
  },
  warningItem: {
    fontSize: 11,
    color: "#F59E0B",
    marginTop: 2,
  },
  // 危险
  dangerSummary: {
    fontSize: 13,
    fontWeight: "700",
    marginBottom: 8,
  },
  riskRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 4,
  },
  riskDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 8,
  },
  riskDetail: {
    fontSize: 12,
    color: "#D1D5DB",
    flex: 1,
  },
  // 通用
  genericText: {
    fontSize: 11,
    color: "#9CA3AF",
    fontFamily: "monospace",
  },
});
