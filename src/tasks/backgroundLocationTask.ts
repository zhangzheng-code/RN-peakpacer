/**
 * ============================================================
 * 后台定位任务注册模块
 * ============================================================
 *
 * 使用 expo-task-manager 定义后台位置更新任务。
 * 当 App 进入后台或屏幕锁定后，系统仍会持续触发此任务，
 * 确保徒步轨迹不中断。
 *
 * 工作流程：
 *   系统 GPS 硬件 → expo-location 后台服务 → defineTask 回调
 *   → 卡尔曼滤波纠偏 → 追加进全局轨迹数组
 *
 * iOS 权限配置（app.json → ios.infoPlist）：
 *   NSLocationAlwaysAndWhenInUseUsageDescription
 *   + UIBackgroundModes: ["location"]
 *
 * Android 权限配置（app.json → android.permissions）：
 *   ACCESS_BACKGROUND_LOCATION
 */

import * as TaskManager from 'expo-task-manager';
import * as Location from 'expo-location';
import type { LocationObject } from 'expo-location';
import { GpsKalmanFilter } from '../utils/gpsFilter';
import type { TrailPoint } from '../types';

/**
 * 后台位置任务的数据类型
 * expo-location 的 startLocationUpdatesAsync 触发时，
 * data 中包含 locations 数组
 */
interface LocationTaskData {
  locations: LocationObject[];
}

/**
 * 后台定位任务名称
 * 全局唯一标识符，用于 registerTaskAsync / unregisterTaskAsync
 */
export const BACKGROUND_LOCATION_TASK = 'smarthike-background-location';

/**
 * 全局卡尔曼滤波器实例
 *
 * 注意：由于 TaskManager.defineTask 的回调在独立的 JS 上下文中执行，
 * 此模块级变量在任务注册时初始化一次，后续每次任务触发时复用同一实例，
 * 保证滤波器状态（xHat、P）在多次回调间连续累积。
 */
const kalmanFilter = new GpsKalmanFilter(
  0.0001, // Q: 过程噪声，控制滤波器对状态变化的敏感度
  0.0001, // R: 测量噪声，控制滤波器对 GPS 跳点的容忍度
);

/**
 * 轨迹点缓冲区
 *
 * 后台任务回调中无法直接操作 React 组件状态，
 * 因此使用模块级数组作为中间缓冲区。
 * 前台组件通过轮询或事件监听读取此缓冲区。
 */
let trailBuffer: TrailPoint[] = [];

/**
 * 累计距离（米）
 */
let totalDistance: number = 0;

/**
 * 上一个轨迹点（用于计算累计距离）
 */
let lastPoint: TrailPoint | null = null;

/**
 * 获取当前轨迹缓冲区的副本
 * 前台组件调用此方法获取最新轨迹数据
 */
export function getTrailBuffer(): TrailPoint[] {
  return [...trailBuffer];
}

/**
 * 获取累计距离
 */
export function getTotalDistance(): number {
  return totalDistance;
}

/**
 * 清空轨迹缓冲区和滤波器状态
 * 在开始新的徒步记录时调用
 */
export function resetTrailBuffer(): void {
  trailBuffer = [];
  totalDistance = 0;
  lastPoint = null;
  kalmanFilter.reset();
}

/**
 * ============================================================
 * 后台位置更新任务定义
 * ============================================================
 *
 * TaskManager.defineTask 注册一个后台任务回调。
 * 当 expo-location 的后台定位服务触发时，系统调用此回调，
 * 传入最新的 GPS 坐标数据。
 *
 * 任务参数类型：
 *   data: { locations: LocationObject[] }
 *   error: TaskManager.TaskManagerError | null
 *
 * 处理流程：
 *   1. 从 data.locations 中提取最新坐标
 *   2. 构造 TrailPoint 对象
 *   3. 通过卡尔曼滤波器纠偏
 *   4. 计算与上一个点的距离，累加到总距离
 *   5. 追加进轨迹缓冲区
 */
TaskManager.defineTask<LocationTaskData>(BACKGROUND_LOCATION_TASK, async ({ data, error }) => {
  if (error) {
    console.error('[BackgroundLocationTask] 后台定位任务出错:', error.message);
    return;
  }

  if (!data || !data.locations || data.locations.length === 0) {
    return;
  }

  const latestLocation = data.locations[data.locations.length - 1];

  if (!latestLocation || !latestLocation.coords) {
    return;
  }

  processLocationPoint(latestLocation.coords, latestLocation.timestamp || Date.now());
});

/**
 * Haversine 公式计算两点间距离（米）
 */
function haversineDistance(p1: TrailPoint, p2: TrailPoint): number {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;

  const dLat = toRad(p2.latitude - p1.latitude);
  const dLon = toRad(p2.longitude - p1.longitude);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(p1.latitude)) *
      Math.cos(toRad(p2.latitude)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

/**
 * ============================================================
 * 启动后台定位服务
 * ============================================================
 *
 * 调用 Location.startLocationUpdatesAsync 注册后台定位任务。
 *
 * 参数说明：
 * - accuracy: Location.Accuracy.BestForNavigation
 *   使用最高精度（GPS + GLONASS + 北斗多星座融合）
 *   精度约 3~5m，功耗较高，适合徒步记录场景
 *
 * - timeInterval: 1000 (1 秒)
 *   每隔 1 秒上报一次坐标，保障轨迹连续性
 *   可根据功耗需求调整为 2000~5000ms
 *
 * - distanceInterval: 5 (米)
 *   位移超过 5 米才上报，避免静止时产生重复点
 *
 * - deferredUpdatesInterval: 1000 (1 秒)
 *   iOS 延迟更新间隔，攒批后统一回调，减少唤醒次数
 *
 * - showsBackgroundLocationIndicator: true
 *   iOS 在状态栏显示蓝色定位指示条，提醒用户后台定位正在运行
 *
 * - foregroundService: Android 前台服务通知
 *   Android 要求后台定位必须运行在前台服务中，
 *   需要配置通知标题和内容，用户可在通知栏看到并管理
 */
/**
 * 处理单个定位点的通用逻辑（卡尔曼滤波 + 精度门控 + 距离累加 + 入缓冲区）
 */
function processLocationPoint(coords: { latitude: number; longitude: number; altitude: number | null; accuracy: number | null }, timestamp: number) {
  const rawPoint: TrailPoint = {
    latitude: coords.latitude,
    longitude: coords.longitude,
    timestamp,
    altitude: coords.altitude,
    accuracy: coords.accuracy,
  };

  const filteredPoint = kalmanFilter.filter(rawPoint);

  if (filteredPoint.accuracy !== null && filteredPoint.accuracy !== undefined && filteredPoint.accuracy > 50) {
    return;
  }

  if (lastPoint !== null) {
    const deltaDistance = haversineDistance(lastPoint, filteredPoint);
    if (deltaDistance < 100) {
      totalDistance += deltaDistance;
    }
  }

  trailBuffer.push(filteredPoint);
  lastPoint = filteredPoint;
}

export async function startBackgroundLocation(): Promise<boolean> {
  try {
    // 检查后台定位权限
    const { status: backgroundStatus } = await Location.getBackgroundPermissionsAsync();
    if (backgroundStatus !== 'granted') {
      const { status: requestedStatus } = await Location.requestBackgroundPermissionsAsync();
      if (requestedStatus !== 'granted') {
        console.warn('[BackgroundLocationTask] 后台定位权限未授予');
        return false;
      }
    }

    // 检查是否已有同名任务在运行
    const isTaskRegistered = await TaskManager.isTaskRegisteredAsync(BACKGROUND_LOCATION_TASK);
    if (isTaskRegistered) {
      await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
    }

    // 启动原生 iOS 后台常驻定位
    await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, {
      accuracy: Location.Accuracy.BestForNavigation,
      timeInterval: 1000,
      distanceInterval: 5,
      deferredUpdatesInterval: 1000,
      showsBackgroundLocationIndicator: true,
      foregroundService: {
        notificationTitle: 'SmartHike 正在记录轨迹',
        notificationBody: '后台定位已开启，点击返回应用',
        notificationColor: '#1890ff',
      },
    });

    console.log('[BackgroundLocationTask] 原生后台定位已启动');
    return true;
  } catch (error) {
    console.error('[BackgroundLocationTask] 启动后台定位失败:', error);
    return false;
  }
}

/**
 * 停止原生后台定位服务
 */
export async function stopBackgroundLocation(): Promise<void> {
  try {
    const isTaskRegistered = await TaskManager.isTaskRegisteredAsync(BACKGROUND_LOCATION_TASK);
    if (isTaskRegistered) {
      await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
    }
  } catch (error) {
    console.error('[BackgroundLocationTask] 停止后台定位失败:', error);
  }
}
