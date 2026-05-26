/**
 * ============================================================
 * 生理耗竭指数（PEI）计算模块
 * ============================================================
 *
 * PEI（Physical Exhaustion Index）是一个综合评估徒步者
 * 当前身体负荷和高原反应风险的端侧数学模型。
 *
 * 计算公式：
 *   PEI = w1 * ((HR_current - HR_resting) / (HR_max - HR_resting))
 *       + w2 * (100 - SpO2)
 *       + w3 * (ΔH_accum / 100) * ln(1 + θ_slope)
 *
 * 其中：
 *   w1 = 0.50（心率权重）
 *   w2 = 0.35（血氧权重）
 *   w3 = 0.15（海拔权重）
 *   HR_max = 220 - age
 *   HR_current = 当前心率
 *   HR_resting = 静息心率
 *   SpO2 = 血氧饱和度（%）
 *   ΔH_accum = 累计海拔上升（米）
 *   θ_slope = 当前坡度（弧度），通过 atan(Δh/Δd) 估算
 *
 * PEI 值解读：
 *   0~30: 安全区间，身体状态良好
 *   30~50: 轻度疲劳，建议适当减速
 *   50~75: 中度疲劳，需要休息和补水
 *   75+: 极度疲劳/高反风险，必须立即停止并采取防护措施
 */

import type { UserProfile, BiometricsData, PEIResult } from '../types';

/**
 * PEI 安全阈值
 * 超过此值触发预警
 */
export const PEI_DANGER_THRESHOLD = 75;

/**
 * PEI 警告阈值
 * 超过此值显示警告
 */
export const PEI_WARNING_THRESHOLD = 50;

/**
 * PEI 计算权重
 */
const WEIGHTS = {
  heartRate: 0.50,
  spo2: 0.35,
  altitude: 0.15,
} as const;

/**
 * 计算生理耗竭指数（PEI）
 *
 * @param profile - 用户静态生理特征
 * @param biometrics - 实时体征数据
 * @param elevationGain - 累计海拔上升（米）
 * @param slopeAngle - 当前坡度角（弧度），默认 0.3（约 17°）
 * @returns PEI 计算结果，包含总分和各分量
 */
export function calculatePEI(
  profile: UserProfile,
  biometrics: BiometricsData,
  elevationGain: number,
  slopeAngle: number = 0.3,
): PEIResult {
  // ---- Step 1: 估算最大心率 ----
  // HR_max = 220 - age（Tanaka 公式的简化版本）
  const hrMax = 220 - profile.age;

  // ---- Step 2: 计算心率分量 ----
  // 心率储备利用率 = (HR_current - HR_resting) / (HR_max - HR_resting)
  // 该值表示当前心率占心率储备的比例
  // 当 HR_current >= HR_max 时，分量被限制在 1.0
  const heartRateReserve = hrMax - profile.restingHeartRate;
  let heartRateComponent = 0;
  if (heartRateReserve > 0) {
    heartRateComponent = Math.max(
      0,
      (biometrics.currentHeartRate - profile.restingHeartRate) / heartRateReserve,
    );
    heartRateComponent = Math.min(heartRateComponent, 1.0);
  }

  // ---- Step 3: 计算血氧分量 ----
  // 血氧不足量 = 100 - SpO2
  // 正常 SpO2 为 95~100%，低于 90% 为严重低氧
  // 分量 = (100 - SpO2)，当 SpO2=98 时分量=2，当 SpO2=85 时分量=15
  const spo2Deficit = 100 - biometrics.spo2;
  const spo2Component = Math.max(0, spo2Deficit);

  // ---- Step 4: 计算海拔分量 ----
  // 海拔耗竭因子 = (ΔH_accum / 100) * ln(1 + θ_slope)
  // 设计思路：
  // - 累计海拔越高，身体负荷越大（线性关系）
  // - 坡度越陡，单位距离消耗越大（对数关系，避免陡坡时分量爆炸）
  // - 除以 100 将米转换为"百米"单位，使分量数值在合理范围
  const altitudeComponent =
    (elevationGain / 100) * Math.log(1 + Math.max(0, slopeAngle));

  // ---- Step 5: 加权求和 ----
  const peiValue =
    WEIGHTS.heartRate * heartRateComponent * 100 +
    WEIGHTS.spo2 * spo2Component +
    WEIGHTS.altitude * altitudeComponent;

  // ---- Step 6: 判定风险等级 ----
  let level: PEIResult['level'] = 'safe';
  if (peiValue >= PEI_DANGER_THRESHOLD) {
    level = 'danger';
  } else if (peiValue >= PEI_WARNING_THRESHOLD) {
    level = 'warning';
  }

  return {
    value: Math.round(peiValue * 10) / 10,
    level,
    heartRateComponent: Math.round(WEIGHTS.heartRate * heartRateComponent * 100 * 10) / 10,
    spo2Component: Math.round(WEIGHTS.spo2 * spo2Component * 10) / 10,
    altitudeComponent: Math.round(WEIGHTS.altitude * altitudeComponent * 10) / 10,
  };
}

/**
 * 获取 PEI 风险等级对应的颜色
 */
export function getPEIColor(level: PEIResult['level']): string {
  switch (level) {
    case 'safe':
      return '#52c41a';
    case 'warning':
      return '#faad14';
    case 'danger':
      return '#ff4d4f';
  }
}

/**
 * 获取 PEI 风险等级对应的中文描述
 */
export function getPEILabel(level: PEIResult['level']): string {
  switch (level) {
    case 'safe':
      return '状态良好';
    case 'warning':
      return '轻度疲劳';
    case 'danger':
      return '极度危险';
  }
}

/**
 * 获取应急自救方案
 * 当 PEI 超出安全阈值时展示
 */
export function getEmergencyTips(level: PEIResult['level']): string[] {
  if (level === 'danger') {
    return [
      '立即停止前进，原地坐下或半卧休息',
      '解开衣领和腰带，保持呼吸通畅',
      '缓慢深呼吸，避免急促喘气',
      '补充温水和电解质，小口慢饮',
      '如有便携氧气，立即吸氧 10~15 分钟',
      '服用高反药物（乙酰唑胺/地塞米松）',
      '若 30 分钟内无好转，立即呼叫救援',
    ];
  }
  if (level === 'warning') {
    return [
      '降低行进速度，减少心肺负荷',
      '每 30 分钟休息 5~10 分钟',
      '补充水分和能量食品',
      '关注身体变化，若持续恶化则折返',
    ];
  }
  return [];
}

/**
 * 获取推荐装备清单
 */
export function getRecommendedGear(level: PEIResult['level']): Array<{
  name: string;
  description: string;
  icon: string;
}> {
  if (level === 'danger') {
    return [
      { name: '便携式氧气瓶', description: '快速缓解高原缺氧症状', icon: '🫁' },
      { name: '高能压缩饼干', description: '快速补充热量和体力', icon: '🍪' },
      { name: '电解质泡腾片', description: '补充流失的矿物质', icon: '💊' },
      { name: '急救保温毯', description: '防止失温，保持体温', icon: '🧥' },
      { name: '对讲机/卫星电话', description: '紧急呼叫救援', icon: '📡' },
    ];
  }
  if (level === 'warning') {
    return [
      { name: '运动饮料', description: '补充水分和电解质', icon: '🥤' },
      { name: '能量胶', description: '快速吸收的碳水化合物', icon: '🍫' },
      { name: '防晒面罩', description: '减少紫外线伤害', icon: '🧴' },
    ];
  }
  return [];
}
