/**
 * ============================================================
 * 统一健康数据服务层（VitalsSimulator 驱动版）
 * ============================================================
 *
 * 数据来源优先级：
 *   1. iOS HealthKit / Android Health Connect → HR & SpO2
 *   2. VitalsSimulator（一阶惯性模型）→ HR & SpO2 & 呼吸 & 卡路里
 *
 * 当真机有授权时，HR/SpO2 取自真实设备，
 * 呼吸频率/卡路里/运动状态/强度仍由 VitalsSimulator 提供。
 *
 * 设计文档：第三阶段白皮书 §1 & §3
 */

import { Platform } from 'react-native';
import { VitalsSimulator, type VitalsProfile, type VitalsSnapshot } from '../utils/vitalsSimulator';

// ============================================================
// 类型定义
// ============================================================

/**
 * 基础健康数据（向后兼容旧接口）
 */
export interface HealthData {
  heartRate: number;
  spO2: number;
}

/**
 * 扩展健康数据（VitalsSimulator 完整输出）
 */
export interface ExtendedHealthData extends HealthData {
  respRate: number;
  calories: number;
  motionState: VitalsSnapshot['motionState'];
  intensity: number;
}

/**
 * GPS 运动数据（由 MapContainer 注入）
 */
export interface MotionFeedData {
  speed: number;
  gradePercent: number;
  altitude: number;
}

type HealthCallback = (data: ExtendedHealthData) => void;

// ============================================================
// 模块状态
// ============================================================

let simulator: VitalsSimulator | null = null;
let simulatorInterval: ReturnType<typeof setInterval> | null = null;
let simulatorCallback: HealthCallback | null = null;
let isRealDataAvailable = false;
let lastMotionFeed: MotionFeedData = { speed: 0, gradePercent: 0, altitude: 500 };
let simulatorTickIntervalMs = 1000;

// ============================================================
// VitalsSimulator 管理
// ============================================================

function getOrCreateSimulator(profile?: Partial<VitalsProfile>): VitalsSimulator {
  if (!simulator) {
    simulator = new VitalsSimulator(profile);
  }
  return simulator;
}

function startSimulatorLoop(callback: HealthCallback, profile?: Partial<VitalsProfile>): void {
  simulatorCallback = callback;
  const sim = getOrCreateSimulator(profile);

  if (simulatorInterval) clearInterval(simulatorInterval);

  const dt = simulatorTickIntervalMs / 1000;
  let lastTickTime = Date.now();

  simulatorInterval = setInterval(() => {
    const now = Date.now();
    const actualDt = (now - lastTickTime) / 1000;
    lastTickTime = now;

    const snapshot = sim.tick({
      speed: lastMotionFeed.speed,
      gradePercent: lastMotionFeed.gradePercent,
      altitude: lastMotionFeed.altitude,
      dt: actualDt,
    });

    callback({
      heartRate: snapshot.heartRate,
      spO2: snapshot.spo2,
      respRate: snapshot.respRate,
      calories: snapshot.calories,
      motionState: snapshot.motionState,
      intensity: snapshot.intensity,
    });
  }, simulatorTickIntervalMs);
}

function stopSimulatorLoop(): void {
  if (simulatorInterval) {
    clearInterval(simulatorInterval);
    simulatorInterval = null;
  }
  simulatorCallback = null;
}

// ============================================================
// iOS HealthKit 桥接
// ============================================================

let iosHealthKitInitialized = false;

async function initIOSHealthKit(): Promise<boolean> {
  if (Platform.OS !== 'ios') return false;

  try {
    const AppleHealthKit = require('react-native-health').default;

    const permissions = {
      permissions: {
        read: [
          AppleHealthKit.Constants.Permissions.HeartRate,
          AppleHealthKit.Constants.Permissions.OxygenSaturation,
        ],
        write: [],
      },
    };

    return new Promise<boolean>((resolve) => {
      AppleHealthKit.initHealthKit(permissions, (err: string) => {
        if (err) {
          console.warn('HealthKit init failed:', err);
          resolve(false);
          return;
        }
        iosHealthKitInitialized = true;
        resolve(true);
      });
    });
  } catch (e) {
    console.warn('react-native-health not available:', e);
    return false;
  }
}

async function queryIOSHeartRate(): Promise<number | null> {
  if (!iosHealthKitInitialized) return null;

  try {
    const AppleHealthKit = require('react-native-health').default;
    const options = {
      startDate: new Date(Date.now() - 60 * 1000).toISOString(),
      endDate: new Date().toISOString(),
      limit: 1,
      ascending: false,
    };

    return new Promise<number | null>((resolve) => {
      AppleHealthKit.getHeartRateSamples(options, (err: string, results: Array<{ value: number }>) => {
        if (err || !results || results.length === 0) {
          resolve(null);
          return;
        }
        resolve(Math.round(results[0].value));
      });
    });
  } catch {
    return null;
  }
}

async function queryIOSSpO2(): Promise<number | null> {
  if (!iosHealthKitInitialized) return null;

  try {
    const AppleHealthKit = require('react-native-health').default;
    const options = {
      startDate: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      endDate: new Date().toISOString(),
      limit: 1,
      ascending: false,
    };

    return new Promise<number | null>((resolve) => {
      AppleHealthKit.getOxygenSaturationSamples(options, (err: string, results: Array<{ value: number }>) => {
        if (err || !results || results.length === 0) {
          resolve(null);
          return;
        }
        resolve(Math.round(results[0].value * 100));
      });
    });
  } catch {
    return null;
  }
}

// ============================================================
// Android Health Connect 桥接
// ============================================================

let androidInitialized = false;

async function initAndroidHealthConnect(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;

  try {
    const { initialize, requestPermission } = require('react-native-health-connect');

    const result = await initialize();
    if (!result) return false;

    const granted = await requestPermission([
      { accessType: 'read', recordType: 'HeartRate' },
      { accessType: 'read', recordType: 'OxygenSaturation' },
    ]);

    if (granted && granted.length > 0) {
      androidInitialized = true;
      return true;
    }
    return false;
  } catch (e) {
    console.warn('Health Connect not available:', e);
    return false;
  }
}

async function queryAndroidHeartRate(): Promise<number | null> {
  if (!androidInitialized) return null;

  try {
    const { readRecords } = require('react-native-health-connect');
    const now = new Date();
    const oneMinuteAgo = new Date(now.getTime() - 60 * 1000);

    const result = await readRecords('HeartRate', {
      timeRangeFilter: {
        operator: 'between',
        startTime: oneMinuteAgo.toISOString(),
        endTime: now.toISOString(),
      },
    });

    if (result && result.length > 0) {
      const latest = result[result.length - 1];
      if (latest.samples && latest.samples.length > 0) {
        return Math.round(latest.samples[0].beatsPerMinute);
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function queryAndroidSpO2(): Promise<number | null> {
  if (!androidInitialized) return null;

  try {
    const { readRecords } = require('react-native-health-connect');
    const now = new Date();
    const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000);

    const result = await readRecords('OxygenSaturation', {
      timeRangeFilter: {
        operator: 'between',
        startTime: fiveMinAgo.toISOString(),
        endTime: now.toISOString(),
      },
    });

    if (result && result.length > 0) {
      const latest = result[result.length - 1];
      if (latest.percentage) {
        return Math.round(latest.percentage.value * 100);
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ============================================================
// 真机数据 + 模拟器混合轮询
// ============================================================

let pollingInterval: ReturnType<typeof setInterval> | null = null;
let nativePollingActive = false;

/**
 * 真机有授权时：每 2s 从 HealthKit/HealthConnect 读取 HR/SpO2，
 * 同时 VitalsSimulator 持续运行提供呼吸/卡路里/运动状态。
 * 真机读数会覆盖模拟器的 HR/SpO2 输出。
 */
function startNativePollingLoop(callback: HealthCallback): void {
  nativePollingActive = true;

  if (pollingInterval) clearInterval(pollingInterval);

  pollingInterval = setInterval(async () => {
    let hr: number | null = null;
    let spo2: number | null = null;

    if (Platform.OS === 'ios') {
      hr = await queryIOSHeartRate();
      spo2 = await queryIOSSpO2();
    } else if (Platform.OS === 'android') {
      hr = await queryAndroidHeartRate();
      spo2 = await queryAndroidSpO2();
    }

    // 模拟器始终运行（提供呼吸/卡路里/运动状态）
    if (simulator) {
      const dt = 2;
      const snapshot = simulator.tick({
        speed: lastMotionFeed.speed,
        gradePercent: lastMotionFeed.gradePercent,
        altitude: lastMotionFeed.altitude,
        dt,
      });

      // 真机数据优先覆盖 HR/SpO2
      callback({
        heartRate: hr ?? snapshot.heartRate,
        spO2: spo2 ?? snapshot.spo2,
        respRate: snapshot.respRate,
        calories: snapshot.calories,
        motionState: snapshot.motionState,
        intensity: snapshot.intensity,
      });
    } else {
      // 模拟器未初始化时的兜底
      callback({
        heartRate: hr ?? 82,
        spO2: spo2 ?? 97,
        respRate: 16,
        calories: 0,
        motionState: 'stationary',
        intensity: 0,
      });
    }
  }, 2000);
}

function stopNativePollingLoop(): void {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
  nativePollingActive = false;
}

// ============================================================
// 公开 API
// ============================================================

/**
 * 初始化健康服务并开始数据流。
 *
 * 行为：
 *   - 尝试初始化 iOS HealthKit / Android Health Connect
 *   - 无论是否有原生数据，VitalsSimulator 始终启动
 *   - 原生有授权时，HR/SpO2 取自真机，其余来自模拟器
 *   - 原生无授权时，全部数据来自模拟器
 *
 * @param callback 每 tick 周期收到一次 ExtendedHealthData
 * @param profile 用户生理档案（可选，传入时影响模拟器参数）
 * @returns 当前是否使用真实设备数据
 */
export async function startHealthDataStream(
  callback: HealthCallback,
  profile?: Partial<VitalsProfile>,
): Promise<boolean> {
  let nativeAvailable = false;

  if (Platform.OS === 'ios') {
    nativeAvailable = await initIOSHealthKit();
  } else if (Platform.OS === 'android') {
    nativeAvailable = await initAndroidHealthConnect();
  }

  isRealDataAvailable = nativeAvailable;

  // VitalsSimulator 始终启动（即使有真机数据，也需要它提供呼吸/卡路里/运动状态）
  getOrCreateSimulator(profile);

  if (nativeAvailable) {
    startNativePollingLoop(callback);
  } else {
    startSimulatorLoop(callback, profile);
  }

  return isRealDataAvailable;
}

/**
 * 停止所有数据流并清理资源
 */
export function stopHealthDataStream(): void {
  stopNativePollingLoop();
  stopSimulatorLoop();
}

/**
 * 向模拟器注入 GPS 运动数据。
 * MapContainer 在 GPS 轮询时调用此方法。
 *
 * @param data 运动数据（速度、坡度、海拔）
 */
export function feedMotionData(data: MotionFeedData): void {
  lastMotionFeed = data;
}

/**
 * 重置模拟器状态（新一轮徒步开始时调用）
 */
export function resetSimulator(profile?: Partial<VitalsProfile>): void {
  if (simulator) {
    simulator.reset(profile);
  }
  lastMotionFeed = { speed: 0, gradePercent: 0, altitude: 500 };
}

/**
 * 获取模拟器当前快照（不触发 tick，只读当前状态）
 * 返回 null 表示模拟器未初始化
 */
export function getSimulatorSnapshot(): VitalsSnapshot | null {
  if (!simulator) return null;
  return {
    heartRate: simulator.currentHR,
    spo2: simulator.currentSpO2,
    respRate: simulator.currentRespRate,
    calories: simulator.currentCalories,
    motionState: simulator.currentMotionState,
    intensity: 0,
  };
}

/**
 * 获取模拟器累计统计（用于战报）
 * 返回 null 表示模拟器未初始化
 */
export function getSimulatorStats(): {
  averageHR: number;
  averageSpO2: number;
  peakHR: number;
  totalTimeSeconds: number;
  zone4Seconds: number;
  zone5Seconds: number;
  calories: number;
} | null {
  if (!simulator) return null;
  return {
    averageHR: simulator.averageHR,
    averageSpO2: simulator.averageSpO2,
    peakHR: simulator.peakHeartRate,
    totalTimeSeconds: simulator.totalTimeSeconds,
    zone4Seconds: simulator.zone4Seconds,
    zone5Seconds: simulator.zone5Seconds,
    calories: simulator.currentCalories,
  };
}

/**
 * 当前是否使用真实设备数据
 */
export function isUsingRealHealthData(): boolean {
  return isRealDataAvailable;
}
