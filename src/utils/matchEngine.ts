/**
 * ============================================================
 * 智能匹配评分引擎（Match Engine）
 * ============================================================
 *
 * 多维度加权评分系统，根据用户体征档案、路线难度、
 * 出发时间和历史经验计算推荐度。
 *
 * 评分公式：
 *   overall = 0.35·bodyFit + 0.25·difficultyFit
 *           + 0.20·timeFit + 0.20·historyPref
 *
 * 设计文档：第三阶段白皮书 §2.1.3
 */

import type { UserProfile, HistoryTrack } from '../types';

// ============================================================
// 类型定义
// ============================================================

/**
 * 难度等级枚举
 */
export type DifficultyLevel = '休闲' | '进阶' | '挑战' | '硬核';

/**
 * 单项评分结果
 */
export interface MatchScore {
  /** 综合推荐度 0~100 */
  overall: number;
  /** 体征匹配度 0~100 */
  bodyFit: number;
  /** 难度适配度 0~100 */
  difficultyFit: number;
  /** 时间匹配度 0~100 */
  timeFit: number;
  /** 历史经验匹配 0~100 */
  historyPref: number;
}

/**
 * 气压估算结果
 */
export interface PressureEstimate {
  /** 气压值（hPa） */
  value: number;
  /** 是否触发预警 */
  isWarning: boolean;
  /** 预警描述 */
  warningText: string | null;
}

/**
 * 预计用时结果
 */
export interface TimeEstimate {
  /** 预计用时（分钟） */
  minutes: number;
  /** 格式化字符串 如 "6h 42min" */
  formatted: string;
  /** 置信区间下限（分钟） */
  minMinutes: number;
  /** 置信区间上限（分钟） */
  maxMinutes: number;
  /** 格式化置信区间 如 "±23min" */
  confidenceRange: string;
}

/**
 * 路况组成
 */
export interface TerrainComposition {
  /** 各地形百分比 */
  segments: Array<{
    type: string;
    percent: number;
    color: string;
  }>;
}

// ============================================================
// 常量
// ============================================================

/** 难度 → 体能等级映射（0~1） */
const DIFFICULTY_FITNESS_MAP: Record<DifficultyLevel, number> = {
  '休闲': 0.25,
  '进阶': 0.50,
  '挑战': 0.75,
  '硬核': 0.95,
};

/** 难度 → 颜色映射 */
const DIFFICULTY_COLOR_MAP: Record<DifficultyLevel, string> = {
  '休闲': '#10B981',
  '进阶': '#F59E0B',
  '挑战': '#F97316',
  '硬核': '#EF4444',
};

/** 评分权重 */
const WEIGHTS = {
  bodyFit: 0.35,
  difficultyFit: 0.25,
  timeFit: 0.20,
  historyPref: 0.20,
} as const;

// ============================================================
// 工具函数
// ============================================================

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// ============================================================
// 体能评估
// ============================================================

/**
 * 根据用户档案估算体能等级（0~1）
 *
 * 考虑因素：
 * - 年龄（年轻人体能上限更高）
 * - 静息心率（低静息心率 = 更好的心肺功能）
 * - 经验（历史轨迹数量）
 */
export function estimateFitnessLevel(profile: UserProfile, trackCount: number): number {
  // 年龄因子：20~35 岁满分，之后缓慢衰减
  const ageFactor = profile.age <= 35
    ? 1.0
    : Math.max(0.4, 1.0 - (profile.age - 35) * 0.015);

  // 静息心率因子：55 bpm → 1.0，85 bpm → 0.4
  const hrFactor = clamp(1.0 - (profile.restingHeartRate - 55) / 75, 0.3, 1.0);

  // 经验因子：0 次 → 0.3，10 次 → 0.8，30+ 次 → 1.0
  const expFactor = clamp(0.3 + trackCount * 0.035, 0.3, 1.0);

  return clamp(ageFactor * 0.35 + hrFactor * 0.35 + expFactor * 0.30, 0, 1);
}

// ============================================================
// 核心匹配评分
// ============================================================

/**
 * 计算用户与活动的综合匹配度
 *
 * @param profile - 用户生理档案
 * @param historyTracks - 历史轨迹记录
 * @param difficulty - 活动难度等级
 * @param departDate - 出发日期字符串（如 "06.15"）
 * @returns 完整评分结果
 */
export function scoreMatch(
  profile: UserProfile,
  historyTracks: HistoryTrack[],
  difficulty: DifficultyLevel,
  departDate: string,
): MatchScore {
  const trackCount = historyTracks.length;
  const fitnessLevel = estimateFitnessLevel(profile, trackCount);

  // ---- 体征匹配度 ----
  // 用户体能与活动难度的差距越小分越高
  const difficultyValue = DIFFICULTY_FITNESS_MAP[difficulty];
  const bodyGap = Math.abs(fitnessLevel - difficultyValue);
  const bodyFit = clamp(100 - bodyGap * 200, 0, 100);

  // ---- 难度适配度 ----
  // 休闲活动对新手高分，硬核活动对老手高分
  // 用 sigmoid 曲线平滑过渡
  const difficultyFit = clamp(
    100 * (1 / (1 + Math.exp(-8 * (fitnessLevel - difficultyValue + 0.1)))),
    0,
    100,
  );

  // ---- 时间匹配度 ----
  // 出发日期越近分越高
  const timeFit = calcTimeFit(departDate);

  // ---- 历史经验匹配 ----
  // 有越多历史轨迹，匹配度越高（但有上限）
  const historyPref = clamp(trackCount * 12, 0, 100);

  // ---- 加权综合 ----
  const overall = Math.round(
    WEIGHTS.bodyFit * bodyFit +
    WEIGHTS.difficultyFit * difficultyFit +
    WEIGHTS.timeFit * timeFit +
    WEIGHTS.historyPref * historyPref,
  );

  return {
    overall: clamp(overall, 0, 100),
    bodyFit: Math.round(bodyFit),
    difficultyFit: Math.round(difficultyFit),
    timeFit: Math.round(timeFit),
    historyPref: Math.round(historyPref),
  };
}

/**
 * 时间匹配度计算
 * 7 天内满分，之后指数衰减，30 天后趋近 0
 */
function calcTimeFit(departDate: string): number {
  try {
    const now = new Date();
    const currentYear = now.getFullYear();
    const [month, day] = departDate.split('.').map(Number);
    const depart = new Date(currentYear, month - 1, day);

    // 如果日期已过，假设是明年
    if (depart.getTime() < now.getTime()) {
      depart.setFullYear(currentYear + 1);
    }

    const daysUntil = (depart.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);

    if (daysUntil <= 0) return 100;
    if (daysUntil <= 7) return 100;
    if (daysUntil <= 14) return 85;
    if (daysUntil <= 30) return Math.round(85 * Math.exp(-(daysUntil - 14) / 20));
    return Math.max(10, Math.round(30 * Math.exp(-(daysUntil - 30) / 40)));
  } catch {
    return 50;
  }
}

// ============================================================
// 气压估算
// ============================================================

/**
 * 根据海拔高度估算大气压
 * 使用国际标准大气压公式（ISA）
 *
 * @param elevationMeters - 海拔高度（米）
 * @returns 气压估算结果
 */
export function calcPressure(elevationMeters: number): PressureEstimate {
  // ISA 公式：P = P0 · (1 - L·h/T0)^(g·M/(R·L))
  // 简化版：P = 1013.25 · (1 - 0.0000225577·h)^5.25588
  const pressure = 1013.25 * Math.pow(1 - 0.0000225577 * elevationMeters, 5.25588);
  const rounded = Math.round(pressure);

  if (elevationMeters >= 4000) {
    return {
      value: rounded,
      isWarning: true,
      warningText: `极端高海拔 · ${rounded} hPa`,
    };
  }
  if (elevationMeters >= 3000) {
    return {
      value: rounded,
      isWarning: true,
      warningText: `高海拔低压区 · ${rounded} hPa`,
    };
  }
  return {
    value: rounded,
    isWarning: false,
    warningText: null,
  };
}

// ============================================================
// 预计用时估算
// ============================================================

/**
 * 根据距离和海拔估算徒步用时
 *
 * 基础公式：
 *   time = distance / avgSpeed + elevation / climbRate + restTime
 *
 * @param distanceKm - 距离（公里）
 * @param elevationGainM - 累计爬升（米）
 * @returns 用时估算结果
 */
export function estimateTime(distanceKm: number, elevationGainM: number): TimeEstimate {
  // 平均徒步速度 3.5~4.5 km/h（平路）
  const avgSpeedKmh = 4.0;
  const flatTimeHours = distanceKm / avgSpeedKmh;

  // 爬升率 300~500 m/h
  const climbRateMh = 400;
  const climbTimeHours = elevationGainM / climbRateMh;

  // 休息时间（每 2 小时休息 15 分钟）
  const totalMoveHours = flatTimeHours + climbTimeHours;
  const restTimeHours = Math.floor(totalMoveHours / 2) * 0.25;

  const totalHours = totalMoveHours + restTimeHours;
  const totalMinutes = Math.round(totalHours * 60);

  // 置信区间 ±15%
  const minMinutes = Math.round(totalMinutes * 0.85);
  const maxMinutes = Math.round(totalMinutes * 1.15);
  const confidenceMin = Math.round(totalMinutes * 0.85);

  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  const formatted = `${hours}h ${mins}min`;

  const rangeMin = Math.round(totalMinutes - confidenceMin);

  return {
    minutes: totalMinutes,
    formatted,
    minMinutes,
    maxMinutes,
    confidenceRange: `±${rangeMin}min`,
  };
}

// ============================================================
// 路况组成（Mock 数据生成）
// ============================================================

/**
 * 根据难度等级生成模拟路况组成
 */
export function generateTerrain(difficulty: DifficultyLevel): TerrainComposition {
  const terrainMap: Record<DifficultyLevel, TerrainComposition> = {
    '休闲': {
      segments: [
        { type: '步道', percent: 60, color: '#8B7355' },
        { type: '草地', percent: 30, color: '#4ADE80' },
        { type: '石阶', percent: 10, color: '#9CA3AF' },
      ],
    },
    '进阶': {
      segments: [
        { type: '岩石', percent: 35, color: '#9CA3AF' },
        { type: '泥土', percent: 40, color: '#8B7355' },
        { type: '碎石', percent: 25, color: '#D4A574' },
      ],
    },
    '挑战': {
      segments: [
        { type: '岩石', percent: 40, color: '#9CA3AF' },
        { type: '碎石', percent: 25, color: '#D4A574' },
        { type: '雪地', percent: 20, color: '#E0E7FF' },
        { type: '泥土', percent: 15, color: '#8B7355' },
      ],
    },
    '硬核': {
      segments: [
        { type: '岩石', percent: 40, color: '#9CA3AF' },
        { type: '雪地', percent: 25, color: '#E0E7FF' },
        { type: '碎石', percent: 20, color: '#D4A574' },
        { type: '冰川', percent: 15, color: '#7DD3FC' },
      ],
    },
  };

  return terrainMap[difficulty];
}

// ============================================================
// 导出工具
// ============================================================

export { DIFFICULTY_COLOR_MAP };
