/**
 * 地图图源类型枚举
 */
export type TileSourceType = 'standard' | 'satellite';

/**
 * 瓦片图源配置接口
 */
export interface TileSourceConfig {
  urlTemplate: string;
  label: string;
  type: TileSourceType;
}

/**
 * 用户坐标信息
 */
export interface UserLocation {
  latitude: number;
  longitude: number;
}

/**
 * 轨迹点数据结构
 */
export interface TrailPoint {
  latitude: number;
  longitude: number;
  timestamp: number;
  altitude?: number | null;
  accuracy?: number | null;
}

/**
 * 徒步状态枚举
 */
export type HikeStatus = 'idle' | 'recording' | 'paused';

/**
 * 用户静态生理特征
 * 用于 PEI 公式中的 HR_max 估算
 */
export interface UserProfile {
  /** 年龄（岁），用于估算 HR_max = 220 - age */
  age: number;
  /** 静息心率（bpm），通常 60~80 */
  restingHeartRate: number;
  /** 用户昵称 */
  nickname: string;
}

/**
 * 实时生理体征数据
 * 由 BiometricsPanel 滑动条模拟输入
 */
export interface BiometricsData {
  /** 当前心率（bpm），范围 60~200 */
  currentHeartRate: number;
  /** 当前血氧饱和度（%），范围 80~100 */
  spo2: number;
}

/**
 * 单条历史轨迹记录
 */
export interface HistoryTrack {
  /** 唯一标识符 */
  id: string;
  /** 徒步开始时间（Unix 毫秒） */
  startTime: number;
  /** 徒步结束时间（Unix 毫秒） */
  endTime: number;
  /** 完整轨迹点数组（卡尔曼滤波后） */
  trailPoints: TrailPoint[];
  /** 累计距离（米） */
  totalDistance: number;
  /** 累计海拔上升（米） */
  elevationGain: number;
  /** 徒步用时（秒） */
  duration: number;
}

/**
 * PEI 计算结果
 */
export interface PEIResult {
  /** 生理耗竭指数（0~100+） */
  value: number;
  /** 风险等级 */
  level: 'safe' | 'warning' | 'danger';
  /** 心率分量 */
  heartRateComponent: number;
  /** 血氧分量 */
  spo2Component: number;
  /** 海拔分量 */
  altitudeComponent: number;
}

/**
 * 生理体征历史记录（滑动窗口数据点）
 */
export interface BiometricsRecord {
  /** 时间戳（Unix 毫秒） */
  timestamp: number;
  /** 心率（bpm） */
  heartRate: number;
  /** 血氧饱和度（%） */
  spo2: number;
  /** 生理耗竭指数 */
  pei: number;
}

/**
 * AI 聊天消息
 */
export interface ChatMessage {
  /** 消息唯一 ID */
  id: string;
  /** 消息角色 */
  role: 'user' | 'assistant' | 'system';
  /** 消息文本内容 */
  content: string;
  /** 创建时间戳 */
  timestamp: number;
  /** 是否正在流式接收中 */
  isStreaming?: boolean;
}
