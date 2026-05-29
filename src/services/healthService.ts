/**
 * ============================================================
 * 统一健康数据服务层（双端自适应 + 智能降级模拟器）
 * ============================================================
 *
 * iOS:  react-native-health (AppleHealthKit)
 * Android: react-native-health-connect
 * 模拟器/无授权: 正弦波 + 随机噪声模拟器
 */

import { Platform } from 'react-native';

export interface HealthData {
  heartRate: number;
  spO2: number;
}

type HealthCallback = (data: HealthData) => void;

// ---- Simulator state ----
let simulatorStartTime = Date.now();
let simulatorInterval: ReturnType<typeof setInterval> | null = null;
let simulatorCallback: HealthCallback | null = null;
let isRealDataAvailable = false;

// ---- Simulator math ----
// V_sim = V_base + A * sin(omega * t) + epsilon
const HR_BASE = 82;
const HR_AMPLITUDE = 18;
const HR_OMEGA = 0.15;
const SPO2_BASE = 97;
const SPO2_AMPLITUDE = 1.5;
const SPO2_OMEGA = 0.08;

function gaussianNoise(): number {
  const u1 = Math.random();
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function simulateHeartRate(elapsedSec: number): number {
  const signal = HR_BASE + HR_AMPLITUDE * Math.sin(HR_OMEGA * elapsedSec);
  const noise = gaussianNoise() * 3;
  return Math.round(Math.max(55, Math.min(195, signal + noise)));
}

function simulateSpO2(elapsedSec: number): number {
  const signal = SPO2_BASE + SPO2_AMPLITUDE * Math.sin(SPO2_OMEGA * elapsedSec);
  const noise = gaussianNoise() * 0.5;
  return Math.round(Math.max(85, Math.min(100, signal + noise)));
}

function startSimulator(callback: HealthCallback): void {
  simulatorCallback = callback;
  simulatorStartTime = Date.now();

  if (simulatorInterval) clearInterval(simulatorInterval);
  simulatorInterval = setInterval(() => {
    const elapsed = (Date.now() - simulatorStartTime) / 1000;
    callback({
      heartRate: simulateHeartRate(elapsed),
      spO2: simulateSpO2(elapsed),
    });
  }, 1000);
}

function stopSimulator(): void {
  if (simulatorInterval) {
    clearInterval(simulatorInterval);
    simulatorInterval = null;
  }
  simulatorCallback = null;
}

// ---- iOS HealthKit bridge ----

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

// ---- Android Health Connect bridge ----

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

// ---- Public API ----

let pollingInterval: ReturnType<typeof setInterval> | null = null;

/**
 * 初始化健康服务并开始数据流。
 * 真机有授权 → 真实数据；否则 → 正弦波模拟器。
 *
 * @param callback 每秒收到一次 HealthData
 * @returns 当前是否使用真实数据
 */
export async function startHealthDataStream(callback: HealthCallback): Promise<boolean> {
  let nativeAvailable = false;

  if (Platform.OS === 'ios') {
    nativeAvailable = await initIOSHealthKit();
  } else if (Platform.OS === 'android') {
    nativeAvailable = await initAndroidHealthConnect();
  }

  isRealDataAvailable = nativeAvailable;

  if (nativeAvailable) {
    // Poll native health data every 2 seconds
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

      callback({
        heartRate: hr ?? simulateHeartRate((Date.now() - simulatorStartTime) / 1000),
        spO2: spo2 ?? simulateSpO2((Date.now() - simulatorStartTime) / 1000),
      });
    }, 2000);
  } else {
    // Simulator fallback
    startSimulator(callback);
  }

  return isRealDataAvailable;
}

/**
 * 停止数据流
 */
export function stopHealthDataStream(): void {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
  stopSimulator();
}

/**
 * 当前是否使用真实设备数据
 */
export function isUsingRealHealthData(): boolean {
  return isRealDataAvailable;
}
