/**
 * ============================================================
 * 疲劳指数（Fatigue Index）与恢复建议引擎
 * ============================================================
 *
 * FI = 0.30·FI_HR + 0.20·FI_duration + 0.20·FI_elevation
 *    + 0.20·FI_intensity + 0.10·FI_recovery
 *
 * 设计文档：第三阶段白皮书 §4.2.1
 */

// ============================================================
// 类型定义
// ============================================================

export interface FatigueInput {
  /** 平均心率 */
  averageHR: number;
  /** 静息心率 */
  restingHR: number;
  /** 最大心率 (220 - age) */
  maxHR: number;
  /** 峰值心率 */
  peakHR: number;
  /** 结束时心率 */
  finalHR: number;
  /** 徒步时长（秒） */
  durationSeconds: number;
  /** 累计爬升（米） */
  elevationGain: number;
  /** Zone4+5 高强度时长（秒） */
  highIntensitySeconds: number;
  /** 平均 SpO2 */
  averageSpO2: number;
  /** 平均速度（m/s） */
  averageSpeed: number;
  /** 温度（℃） */
  temperature: number;
  /** 体重（kg） */
  weightKg: number;
}

export interface FatigueResult {
  /** 综合疲劳指数 0~100 */
  score: number;
  /** 等级 */
  grade: 'A' | 'B' | 'C' | 'D' | 'S';
  /** 等级标签 */
  gradeLabel: string;
  /** 等级颜色 */
  gradeColor: string;
  /** 等级描述 */
  gradeDesc: string;
  /** 各分项 */
  components: {
    hrLoad: number;
    durationLoad: number;
    elevationLoad: number;
    intensityLoad: number;
    recoveryLoad: number;
  };
}

export interface RecoveryAdvice {
  category: string;
  icon: string;
  urgency: 'low' | 'medium' | 'high' | 'critical';
  title: string;
  body: string;
  timeWindow: string;
  scienceNote: string;
}

// ============================================================
// FI 计算
// ============================================================

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export function calculateFatigueIndex(input: FatigueInput): FatigueResult {
  const hrReserve = input.maxHR - input.restingHR;

  // 1. 心率负荷
  const fiHR = hrReserve > 0
    ? clamp(((input.averageHR - input.restingHR) / hrReserve) * 100, 0, 100)
    : 0;

  // 2. 持续时间（8h 满分）
  const fiDuration = clamp((input.durationSeconds / 3600) / 8 * 100, 0, 100);

  // 3. 累积爬升（1500m 满分）
  const fiElevation = clamp(input.elevationGain / 1500 * 100, 0, 100);

  // 4. 高强度占比
  const fiIntensity = input.durationSeconds > 0
    ? clamp((input.highIntensitySeconds / input.durationSeconds) * 100, 0, 100)
    : 0;

  // 5. 恢复难度（结束时心率回落程度）
  const fiRecovery = hrReserve > 0
    ? clamp(100 - ((input.finalHR - input.restingHR) / (input.peakHR - input.restingHR)) * 100, 0, 100)
    : 0;

  const score = Math.round(
    0.30 * fiHR +
    0.20 * fiDuration +
    0.20 * fiElevation +
    0.20 * fiIntensity +
    0.10 * fiRecovery
  );

  let grade: FatigueResult['grade'];
  let gradeLabel: string;
  let gradeColor: string;
  let gradeDesc: string;

  if (score < 20) {
    grade = 'A'; gradeLabel = 'A'; gradeColor = '#10B981';
    gradeDesc = '这次散步真惬意';
  } else if (score < 40) {
    grade = 'B'; gradeLabel = 'B'; gradeColor = '#3B82F6';
    gradeDesc = '不错的锻炼强度';
  } else if (score < 60) {
    grade = 'C'; gradeLabel = 'C'; gradeColor = '#F59E0B';
    gradeDesc = '身体已经感到明显消耗';
  } else if (score < 80) {
    grade = 'D'; gradeLabel = 'D'; gradeColor = '#F97316';
    gradeDesc = '需要认真恢复';
  } else {
    grade = 'S'; gradeLabel = 'S'; gradeColor = '#EF4444';
    gradeDesc = '身体已接近极限，务必充分休息';
  }

  return {
    score: clamp(score, 0, 100),
    grade,
    gradeLabel,
    gradeColor,
    gradeDesc,
    components: {
      hrLoad: Math.round(fiHR),
      durationLoad: Math.round(fiDuration),
      elevationLoad: Math.round(fiElevation),
      intensityLoad: Math.round(fiIntensity),
      recoveryLoad: Math.round(fiRecovery),
    },
  };
}

// ============================================================
// 恢复建议引擎
// ============================================================

export function generateRecoveryAdvice(
  fi: FatigueResult,
  input: FatigueInput,
): RecoveryAdvice[] {
  const advice: RecoveryAdvice[] = [];
  const durationHours = input.durationSeconds / 3600;

  // ---- 1. 肌肉恢复与拉伸 ----
  if (fi.score >= 60) {
    advice.push({
      category: '肌肉恢复',
      icon: '🧘',
      urgency: 'high',
      title: '深度筋膜放松 · 48小时黄金窗口',
      body: `累计爬升 ${input.elevationGain}m，股四头肌和腓肠肌承受了巨大的离心收缩负荷。建议在结束后 30 分钟内进行 15 分钟静态拉伸（每个肌群保持 30 秒），重点针对：\n· 股四头肌（站立后弯拉伸）\n· 腘绳肌（坐姿前屈）\n· 小腿三头肌（墙壁推撑）\n· 髂胫束（交叉腿侧弯）`,
      timeWindow: '结束运动后 30~60 分钟',
      scienceNote: '离心运动导致的肌纤维微损伤在 24~48h 达峰值（DOMS），早期拉伸可减少肌节串联损伤',
    });
  } else if (fi.score >= 30) {
    advice.push({
      category: '肌肉恢复',
      icon: '🧘',
      urgency: 'medium',
      title: '轻度拉伸 · 保持关节灵活性',
      body: '强度适中的徒步，建议进行 10 分钟的全身关节环绕和动态拉伸',
      timeWindow: '结束运动后随时',
      scienceNote: '中等强度运动后的拉伸主要维持关节活动度',
    });
  } else {
    advice.push({
      category: '肌肉恢复',
      icon: '🧘',
      urgency: 'low',
      title: '日常拉伸即可',
      body: '本次运动强度较低，正常日常活动即可恢复',
      timeWindow: '任意时间',
      scienceNote: '低强度运动无需特殊恢复措施',
    });
  }

  // ---- 2. 电解质与水分补充 ----
  const sweatRate = durationHours * (1.0 + 0.3 * Math.max(input.temperature - 20, 0) / 10) * (1.0 + 0.2 * (fi.score / 100));
  const totalSweatLoss = sweatRate * durationHours;
  const electrolyteDeficit = totalSweatLoss * 800;

  if (electrolyteDeficit > 2000) {
    advice.push({
      category: '电解质补充',
      icon: '💧',
      urgency: 'critical',
      title: '⚠️ 严重电解质失衡风险',
      body: `估计出汗量 ${totalSweatLoss.toFixed(1)}L，流失钠 ~${Math.round(electrolyteDeficit)}mg。强烈建议在 2 小时内补充含电解质运动饮料 500~750ml，并在下一餐中增加咸味食物摄入。`,
      timeWindow: '结束运动后立即',
      scienceNote: '钠流失 > 2000mg 时低钠血症风险显著上升',
    });
  } else if (electrolyteDeficit > 1000) {
    advice.push({
      category: '电解质补充',
      icon: '💧',
      urgency: 'high',
      title: '补充含钠饮品',
      body: `估计出汗量 ${totalSweatLoss.toFixed(1)}L。建议饮用 500ml 电解质饮料，避免纯水稀释性低钠血症。`,
      timeWindow: '结束运动后 30 分钟内',
      scienceNote: '运动后补水应含电解质，纯水大量饮用可能导致稀释性低钠',
    });
  } else {
    advice.push({
      category: '电解质补充',
      icon: '💧',
      urgency: 'medium',
      title: '正常补水即可',
      body: '出汗量适中，正常饮水 300~500ml 即可恢复。',
      timeWindow: '结束运动后 1 小时内',
      scienceNote: '轻度脱水通过正常饮水即可恢复',
    });
  }

  // ---- 3. 超代偿恢复期 ----
  if (fi.score >= 70) {
    advice.push({
      category: '超代偿恢复',
      icon: '📅',
      urgency: 'high',
      title: '休息 3~4 天 · 第 5~7 天复训',
      body: '接下来 48 小时完全休息，第 3 天可进行 30 分钟低强度散步促进血液循环（主动恢复），第 5 天起可恢复中等强度训练。',
      timeWindow: '未来 72 小时',
      scienceNote: '高强度运动后肌糖原完全恢复需要 48~72h，超代偿窗口在第 4~7 天',
    });
  } else if (fi.score >= 40) {
    advice.push({
      category: '超代偿恢复',
      icon: '📅',
      urgency: 'medium',
      title: '休息 2~3 天 · 第 4~5 天复训',
      body: '休息 48 小时，期间可进行轻度瑜伽或游泳。',
      timeWindow: '未来 48 小时',
      scienceNote: '中等强度运动后 48h 内肌糖原即可恢复',
    });
  } else {
    advice.push({
      category: '超代偿恢复',
      icon: '📅',
      urgency: 'low',
      title: '明天即可恢复训练',
      body: '正常休息一晚即可恢复，明天可以继续活动。',
      timeWindow: '今晚',
      scienceNote: '低强度运动恢复窗口仅需 12~24h',
    });
  }

  // ---- 4. 睡眠质量优化 ----
  if (input.averageHR > 130 || durationHours > 4) {
    advice.push({
      category: '睡眠优化',
      icon: '😴',
      urgency: 'high',
      title: '今晚深度睡眠将显著延长',
      body: '高强度运动后身体进入副交感神经反弹期，深度睡眠占比将增加 15~25%。建议：\n· 提前 1 小时上床（22:00 前）\n· 睡前 2 小时避免蓝光\n· 室温控制在 18~20℃\n· 补充镁元素（200~400mg）促进肌肉放松',
      timeWindow: '今晚',
      scienceNote: '运动诱导的腺苷积累增加慢波睡眠需求',
    });
  } else {
    advice.push({
      category: '睡眠优化',
      icon: '😴',
      urgency: 'low',
      title: '保持正常作息',
      body: '运动强度适中，正常睡眠即可。',
      timeWindow: '今晚',
      scienceNote: '适度运动改善睡眠质量，无需特殊调整',
    });
  }

  // ---- 5. 营养窗口期 ----
  const proteinNeed = Math.round(0.3 * input.weightKg);
  const carbNeed = Math.round(1.0 * input.weightKg);

  if (fi.score >= 40) {
    advice.push({
      category: '营养窗口',
      icon: '🍌',
      urgency: 'high',
      title: '30 分钟黄金营养窗口',
      body: `运动后 30~60 分钟是糖原再合成的黄金窗口期：\n· 快速碳水：香蕉 1 根 + 蜂蜜水（~40g 糖）\n· 优质蛋白：鸡蛋 2 个 或 乳清蛋白粉 1 勺（~${proteinNeed}g）\n· 抗氧化：蓝莓/樱桃汁（减少运动后氧化应激）`,
      timeWindow: '结束后 30 分钟内',
      scienceNote: '运动后 30~60min 内糖原合成酶活性最高，碳水+蛋白质联合摄入效果最佳',
    });
  } else {
    advice.push({
      category: '营养窗口',
      icon: '🍌',
      urgency: 'medium',
      title: '均衡饮食即可',
      body: '运动量不大，正常饮食中注意蛋白质和碳水的均衡摄入即可。',
      timeWindow: '下一餐',
      scienceNote: '低强度运动后的营养窗口较宽，无需刻意补充',
    });
  }

  return advice;
}

// ============================================================
// 导出工具
// ============================================================

export function getUrgencyColor(urgency: RecoveryAdvice['urgency']): string {
  switch (urgency) {
    case 'critical': return '#EF4444';
    case 'high': return '#F97316';
    case 'medium': return '#F59E0B';
    case 'low': return '#10B981';
  }
}

export function getUrgencyLabel(urgency: RecoveryAdvice['urgency']): string {
  switch (urgency) {
    case 'critical': return 'CRITICAL';
    case 'high': return 'HIGH';
    case 'medium': return 'MEDIUM';
    case 'low': return 'INFO';
  }
}
