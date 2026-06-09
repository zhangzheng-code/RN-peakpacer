/**
 * ============================================================
 * MCP 工具注册表（Tool Registry）
 * ============================================================
 *
 * 定义 MiMo AI 可调用的端侧工具。
 * 每个工具包含：
 *   - OpenAI function schema（供 MiMo 理解如何调用）
 *   - execute 函数（客户端执行，读 Zustand store）
 *   - UI 元数据（渐变色、标签、图标）
 */

import { calculatePEI, getEmergencyTips, getRecommendedGear } from '../utils/healthCalculator';

// ============================================================
// 类型定义
// ============================================================

export interface ToolDefinition {
  /** 工具名（英文，MiMo 调用时使用） */
  name: string;
  /** 工具描述（MiMo 用来判断何时调用） */
  description: string;
  /** 参数 JSON Schema（OpenAI function calling 格式） */
  parameters: object;
  /** 品牌渐变色 [起始色, 结束色] */
  gradientColors: [string, string];
  /** 中文标签（UI 显示） */
  label: string;
  /** emoji 图标 */
  icon: string;
  /** 执行函数 */
  execute: (args: Record<string, any>, store: any) => Promise<object>;
}

// ============================================================
// 工具定义
// ============================================================

const tools: ToolDefinition[] = [
  // ---- 1. 路线推荐 ----
  {
    name: 'get_route_advice',
    description: '根据用户当前位置、体能状态和偏好，推荐适合的徒步路线。当用户询问"去哪走"、"推荐路线"、"附近有什么步道"时调用。',
    parameters: {
      type: 'object',
      properties: {
        difficulty: {
          type: 'string',
          enum: ['easy', 'medium', 'hard'],
          description: '难度偏好：easy（休闲）、medium（中等）、hard（挑战）',
        },
        max_distance_km: {
          type: 'number',
          description: '最大距离（公里），不传则不限制',
        },
      },
      required: [],
    },
    gradientColors: ['#3B82F6', '#1D4ED8'],
    label: '路线推荐',
    icon: '🗺️',
    execute: async (args, store) => {
      const pei = store.profile && store.biometrics
        ? calculatePEI(store.profile, store.biometrics, store.elevationGain)
        : null;

      // 热门路线数据（本地 mock，未来可接真实 API）
      const allRoutes = [
        { name: '阳朔遇龙河步道', distance_km: 8.2, elevation_m: 120, difficulty: 'easy', match_score: 0.92, region: '广西' },
        { name: '张家界金鞭溪', distance_km: 7.5, elevation_m: 280, difficulty: 'medium', match_score: 0.85, region: '湖南' },
        { name: '四姑娘山大峰', distance_km: 15.0, elevation_m: 1200, difficulty: 'hard', match_score: 0.70, region: '四川' },
        { name: '武功山绝望坡', distance_km: 12.0, elevation_m: 900, difficulty: 'medium', match_score: 0.78, region: '江西' },
        { name: '黄山前山步道', distance_km: 6.5, elevation_m: 500, difficulty: 'medium', match_score: 0.82, region: '安徽' },
      ];

      let filtered = allRoutes;
      if (args.difficulty) {
        filtered = filtered.filter(r => r.difficulty === args.difficulty);
      }
      if (args.max_distance_km) {
        filtered = filtered.filter(r => r.distance_km <= args.max_distance_km);
      }

      // 根据 PEI 调整匹配度
      if (pei) {
        filtered = filtered.map(r => ({
          ...r,
          match_score: r.difficulty === 'hard' && pei.value > 50
            ? Math.round(r.match_score * 0.5 * 100) / 100
            : r.match_score,
        }));
      }

      filtered.sort((a, b) => b.match_score - a.match_score);

      return {
        recommended_routes: filtered.slice(0, 3),
        current_fitness: pei ? { pei: pei.value, level: pei.level } : null,
        total_found: filtered.length,
      };
    },
  },

  // ---- 2. 装备推荐 ----
  {
    name: 'get_gear_recommendation',
    description: '根据当前体能状态（PEI 等级）推荐必要的户外装备。当用户询问"需要带什么"、"装备推荐"、"该准备什么"时调用。',
    parameters: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['emergency', 'hydration', 'nutrition', 'protection'],
          description: '装备类别筛选',
        },
      },
      required: [],
    },
    gradientColors: ['#8B5CF6', '#6D28D9'],
    label: '装备推荐',
    icon: '🎒',
    execute: async (args, store) => {
      const pei = calculatePEI(store.profile, store.biometrics, store.elevationGain);
      const gear = getRecommendedGear(pei.level);

      return {
        pei_level: pei.level,
        pei_value: pei.value,
        gear_list: gear,
        count: gear.length,
        message: gear.length === 0
          ? '当前状态良好，无需特殊装备'
          : `根据您的 PEI 等级（${pei.level}），推荐 ${gear.length} 件装备`,
      };
    },
  },

  // ---- 3. 天气查询 ----
  {
    name: 'check_weather',
    description: '获取当前天气信息，评估天气对徒步的影响。当用户询问"天气怎么样"、"会不会下雨"、"温度多少"时调用。',
    parameters: {
      type: 'object',
      properties: {
        location: {
          type: 'string',
          description: '查询地点名称（可选，默认当前位置）',
        },
      },
      required: [],
    },
    gradientColors: ['#F59E0B', '#D97706'],
    label: '天气查询',
    icon: '🌤️',
    execute: async (args, store) => {
      const weather = store.weather;
      const temp = weather.temp;
      const condition = weather.condition;

      let hikingImpact = '适宜徒步';
      const warnings: string[] = [];

      if (temp < 0) {
        hikingImpact = '极寒风险，建议取消';
        warnings.push('低温冻伤风险', '路面可能结冰', '体感温度远低于实际温度');
      } else if (temp < 5) {
        hikingImpact = '严寒，需充分保暖';
        warnings.push('注意防风保暖', '手指脚趾容易冻伤');
      } else if (temp < 10) {
        hikingImpact = '偏冷，注意保暖';
        warnings.push('建议穿抓绒衣+冲锋衣');
      } else if (temp > 35) {
        hikingImpact = '高温风险，注意防暑';
        warnings.push('中暑风险高', '需大量补水', '避免正午行进');
      }

      if (condition.includes('雨') || condition.includes('雷')) {
        warnings.push('注意防雷', '路面湿滑，减速慢行');
      }

      return {
        temperature: temp,
        condition,
        hiking_impact: hikingImpact,
        warnings,
        advice: `当前${temp}℃，${condition}。${hikingImpact}。`,
      };
    },
  },

  // ---- 4. 危险评估 ----
  {
    name: 'assess_danger',
    description: '综合评估当前徒步危险等级，包括 PEI、血氧、心率、天气等多维度风险。当用户询问"安全吗"、"身体怎么样"、"有没有危险"时调用。',
    parameters: {
      type: 'object',
      properties: {
        include_history: {
          type: 'boolean',
          description: '是否包含历史趋势分析',
        },
      },
      required: [],
    },
    gradientColors: ['#EF4444', '#B91C1C'],
    label: '危险评估',
    icon: '⚠️',
    execute: async (args, store) => {
      const pei = calculatePEI(store.profile, store.biometrics, store.elevationGain);
      const tips = getEmergencyTips(pei.level);

      // 各维度风险
      const risks: Array<{ dimension: string; level: string; detail: string }> = [];

      // 心率风险
      const hrMax = 220 - store.profile.age;
      const hrRatio = store.biometrics.currentHeartRate / hrMax;
      if (hrRatio > 0.9) {
        risks.push({ dimension: '心率', level: 'danger', detail: `心率 ${store.biometrics.currentHeartRate}bpm，已达最大心率 ${(hrRatio * 100).toFixed(0)}%` });
      } else if (hrRatio > 0.8) {
        risks.push({ dimension: '心率', level: 'warning', detail: `心率 ${store.biometrics.currentHeartRate}bpm，接近上限` });
      } else {
        risks.push({ dimension: '心率', level: 'safe', detail: `心率 ${store.biometrics.currentHeartRate}bpm，正常范围` });
      }

      // 血氧风险
      if (store.biometrics.spo2 < 90) {
        risks.push({ dimension: '血氧', level: 'danger', detail: `SpO₂ ${store.biometrics.spo2}%，严重低氧` });
      } else if (store.biometrics.spo2 < 95) {
        risks.push({ dimension: '血氧', level: 'warning', detail: `SpO₂ ${store.biometrics.spo2}%，偏低` });
      } else {
        risks.push({ dimension: '血氧', level: 'safe', detail: `SpO₂ ${store.biometrics.spo2}%，正常` });
      }

      // 天气风险
      if (store.weather.temp < 0) {
        risks.push({ dimension: '天气', level: 'danger', detail: `${store.weather.temp}℃，极寒` });
      } else if (store.weather.temp < 10) {
        risks.push({ dimension: '天气', level: 'warning', detail: `${store.weather.temp}℃，偏冷` });
      } else {
        risks.push({ dimension: '天气', level: 'safe', detail: `${store.weather.temp}℃，${store.weather.condition}` });
      }

      return {
        pei,
        hazard_alert: store.hazardAlert,
        risks,
        emergency_tips: tips,
        overall_risk: pei.level === 'danger' ? 'critical' : pei.level === 'warning' ? 'elevated' : 'normal',
        summary: pei.level === 'danger'
          ? '⛔ 当前处于极度危险状态，必须立即停止运动'
          : pei.level === 'warning'
            ? '⚠️ 当前有中度风险，建议减速休息'
            : '✅ 当前状态良好，可继续行进',
      };
    },
  },
];

// ============================================================
// 公开 API
// ============================================================

/** 生成 OpenAI tools 数组（供 sendMimoStream 使用） */
export function buildToolsArray(): object[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

/** 按名称查找工具定义 */
export function getToolByName(name: string): ToolDefinition | undefined {
  return tools.find((t) => t.name === name);
}

/** 获取所有工具定义（调试用） */
export function getAllTools(): ToolDefinition[] {
  return tools;
}
