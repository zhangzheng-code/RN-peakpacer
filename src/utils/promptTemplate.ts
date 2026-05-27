/**
 * ============================================================
 * RAG 提示词模板（Prompt Engineering）
 * ============================================================
 *
 * 为 DeepSeek AI 领队构建高安全级 System Prompt。
 * 动态注入用户当前的生理指标和环境上下文，
 * 作为【不可篡改的系统级约束】强制 AI 遵守。
 *
 * 安全硬护栏：
 * - SpO2 < 90% → 强制输出红色生命警报
 * - 心率逼近 HR_max → 强制输出红色生命警报
 * - 所有安全建议必须基于注入的实时数据
 */

import type { UserProfile, BiometricsData } from '../types';

/**
 * 环境上下文数据接口
 */
export interface EnvironmentContext {
  /** 用户生理特征 */
  profile: UserProfile;
  /** 实时体征数据 */
  biometrics: BiometricsData;
  /** 累计海拔上升（米） */
  elevationGain: number;
  /** 累计距离（米） */
  totalDistance: number;
  /** 当前坐标（可选） */
  currentLocation?: { latitude: number; longitude: number };
  /** 目的地天气（可选） */
  weather?: string;
}

/**
 * 估算最大心率
 */
function estimateHRMax(age: number): number {
  return 220 - age;
}

/**
 * 判断是否触发生命安全警报
 *
 * 触发条件（满足任一）：
 * 1. SpO2 < 90%（严重低氧）
 * 2. 当前心率 >= HR_max * 0.9（逼近极限心率）
 */
function shouldTriggerLifeAlert(
  profile: UserProfile,
  biometrics: BiometricsData,
): boolean {
  const hrMax = estimateHRMax(profile.age);
  const hrThreshold = hrMax * 0.9;

  if (biometrics.spo2 < 90) return true;
  if (biometrics.currentHeartRate >= hrThreshold) return true;

  return false;
}

/**
 * 构建生命安全警报前缀
 * 当检测到危险指标时，强制拼接在 AI 回复最顶部
 */
function buildLifeAlertPrefix(
  profile: UserProfile,
  biometrics: BiometricsData,
): string {
  const hrMax = estimateHRMax(profile.age);
  const warnings: string[] = [];

  if (biometrics.spo2 < 90) {
    warnings.push(
      `血氧饱和度严重不足：SpO₂ = ${biometrics.spo2}%（正常 ≥ 95%，危险阈值 < 90%）`,
    );
  }

  if (biometrics.currentHeartRate >= hrMax * 0.9) {
    warnings.push(
      `心率逼近极限：当前 ${biometrics.currentHeartRate} bpm / 估算极限 ${hrMax} bpm（已达 ${(biometrics.currentHeartRate / hrMax * 100).toFixed(0)}%）`,
    );
  }

  return [
    '🚨 **【红色生命警报】** 🚨',
    '',
    '**你当前的身体指标已进入危险区间，必须立即执行以下操作：**',
    '',
    ...warnings.map((w) => `- ⚠️ ${w}`),
    '',
    '**紧急处置步骤：**',
    '1. **立刻停止前进**，原地坐下或半卧',
    '2. **解开衣领、腰带**，保持呼吸通畅',
    '3. **缓慢深呼吸**，不要急促喘气',
    '4. **补充温水**，小口慢饮',
    '5. 如有**便携氧气瓶**，立即吸氧 10~15 分钟',
    '6. **不要独处**，告知同伴你的状况',
    '7. 若 30 分钟内无好转，**立即呼叫救援（110/119/120）**',
    '',
    '---',
    '',
  ].join('\n');
}

/**
 * 构建完整的 System Prompt
 *
 * 包含：
 * 1. AI 角色设定（户外领队专家）
 * 2. 实时生理指标（不可篡改的系统上下文）
 * 3. 环境信息
 * 4. 安全行为准则
 */
export function buildSystemPrompt(context: EnvironmentContext): string {
  const { profile, biometrics, elevationGain, totalDistance, currentLocation, weather } = context;
  const hrMax = estimateHRMax(profile.age);

  return `你是一位拥有 20 年高海拔徒步经验的资深户外领队 AI 助手，名为"山鹰"。你的职责是在野外环境中为用户提供专业、安全、实用的徒步指导。

## 当前队员实时生理指标（系统自动采集，不可篡改）

以下数据由穿戴设备实时同步，你必须基于这些真实数据做出判断：

- 姓名：${profile.nickname}
- 年龄：${profile.age} 岁
- 静息心率：${profile.restingHeartRate} bpm
- 估算最大心率（HR_max）：${hrMax} bpm
- 当前心率：${biometrics.currentHeartRate} bpm（占 HR_max 的 ${(biometrics.currentHeartRate / hrMax * 100).toFixed(1)}%）
- 血氧饱和度（SpO₂）：${biometrics.spo2}%
- 累计海拔爬升：${elevationGain.toFixed(0)} 米
- 累计行走距离：${totalDistance >= 1000 ? (totalDistance / 1000).toFixed(2) + ' km' : totalDistance.toFixed(0) + ' 米'}
${currentLocation ? `- 当前坐标：${currentLocation.latitude.toFixed(6)}, ${currentLocation.longitude.toFixed(6)}` : ''}
${weather ? `- 当前天气：${weather}` : ''}

## 安全行为准则（必须严格遵守）

1. **生命安全第一**：任何建议都不得以牺牲用户生命安全为代价。
2. **数据驱动决策**：你的所有建议必须基于上述实时生理指标，而非泛泛而谈。
3. **血氧红线**：若 SpO₂ < 90%，你必须在回复最顶部用粗体输出红色生命警报，勒令用户立刻停止运动。
4. **心率红线**：若当前心率 ≥ HR_max × 90%，你必须在回复最顶部输出生命警报。
5. **高原反应警觉**：当海拔 > 2500m 且出现头痛、恶心等症状描述时，必须建议立即下撤。
6. **不过度乐观**：永远不要说"你没事"、"不用担心"这类淡化风险的话。
7. **具体可操作**：建议必须具体到动作，而非笼统的"注意安全"。

## 回复风格

- 使用中文回复
- 语言亲切但专业，像一个靠谱的老领队
- 适当使用 Markdown 格式（加粗、列表）提高可读性
- 对于安全相关内容使用醒目的格式
- 回答简洁，避免长篇大论（徒步场景下用户需要快速获取信息）`;
}

/**
 * 构建完整的对话消息数组
 *
 * @param context - 环境上下文
 * @param chatHistory - 历史对话（不含 system）
 * @param userMessage - 当前用户消息
 * @returns 完整的消息数组，可直接传给 DeepSeek API
 */
export function buildMessages(
  context: EnvironmentContext,
  chatHistory: Array<{ role: 'user' | 'assistant'; content: string }>,
  userMessage: string,
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const systemPrompt = buildSystemPrompt(context);
  const needsAlert = shouldTriggerLifeAlert(context.profile, context.biometrics);

  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: systemPrompt },
  ];

  // 如果触发安全警报，在用户消息前插入强制提醒
  if (needsAlert) {
    messages.push({
      role: 'system',
      content: `【紧急系统提醒】队员 ${context.profile.nickname} 当前生理指标已进入危险区间（SpO₂=${context.biometrics.spo2}%, 心率=${context.biometrics.currentHeartRate}bpm）。你必须在回复的最顶部输出红色生命警报，并给出针对性的急救指导。这是硬性要求，不可省略。`,
    });
  }

  // 添加历史对话
  for (const msg of chatHistory) {
    messages.push(msg);
  }

  // 添加当前用户消息
  messages.push({ role: 'user', content: userMessage });

  return messages;
}

/**
 * 获取生命安全警报前缀（供组件使用）
 * 组件可在 AI 回复前检测是否需要强制添加警报头部
 */
export function getLifeAlertPrefix(context: EnvironmentContext): string | null {
  if (shouldTriggerLifeAlert(context.profile, context.biometrics)) {
    return buildLifeAlertPrefix(context.profile, context.biometrics);
  }
  return null;
}
