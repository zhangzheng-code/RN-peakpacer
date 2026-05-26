/**
 * 地图图源类型枚举
 * - standard: 高德标准路网瓦片（含等高线标注）
 * - satellite: 高德卫星影像瓦片
 */
export type TileSourceType = 'standard' | 'satellite';

/**
 * 瓦片图源配置接口
 * 每种图源包含唯一的 URL 模板和显示名称
 */
export interface TileSourceConfig {
  /** 瓦片 URL 模板，{x}/{y}/{z} 为标准瓦片坐标占位符 */
  urlTemplate: string;
  /** 图源显示名称，用于切换按钮文案 */
  label: string;
  /** 图源类型标识 */
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
 *
 * 包含 GPS 原始/滤波后的完整信息，
 * 用于卡尔曼滤波输入、RDP 抽稀和 Polyline 渲染。
 */
export interface TrailPoint {
  /** 纬度（WGS-84 坐标系） */
  latitude: number;
  /** 经度（WGS-84 坐标系） */
  longitude: number;
  /** 记录时间戳（Unix 毫秒） */
  timestamp: number;
  /** 海拔高度（米），可能为 null */
  altitude?: number | null;
  /** 定位精度半径（米），来自 GPS 接收器 */
  accuracy?: number | null;
}

/**
 * 徒步状态枚举
 * - idle: 空闲状态，未在记录
 * - recording: 正在记录轨迹
 * - paused: 暂停记录（保留已有轨迹，停止打点）
 */
export type HikeStatus = 'idle' | 'recording' | 'paused';

/**
 * 徒步记录完整状态
 */
export interface HikeState {
  /** 当前徒步状态 */
  status: HikeStatus;
  /** 原始轨迹点数组（卡尔曼滤波后） */
  trailPoints: TrailPoint[];
  /** 经 RDP 抽稀后用于渲染的轨迹点数组 */
  displayPoints: TrailPoint[];
  /** 徒步开始时间（Unix 毫秒），null 表示未开始 */
  startTime: number | null;
  /** 累计距离（米） */
  totalDistance: number;
  /** 累计海拔上升（米） */
  elevationGain: number;
}
