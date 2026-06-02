/**
 * ============================================================
 * 高仿真体征发生器（VitalsSimulator）
 * ============================================================
 *
 * 运动状态驱动的一阶惯性体征模拟系统。
 * 心率 / SpO2 / 呼吸频率 / 卡路里全部与 GPS 速度、
 * 坡度、海拔实时联动，彻底告别"随机数撒谎"。
 *
 * 核心公式：
 *   HR_target = HR_rest + ΔHR_max · IntensityFactor
 *   HR_new    = HR_current + (HR_target - HR_current) · (1 - e^(-Δt/τ))
 *
 * 设计文档：第三阶段白皮书 §1
 */

// ============================================================
// 类型定义
// ============================================================

/**
 * 运动状态枚举
 * 基于 GPS 速度和坡度实时判定
 */
export type MotionState =
  | 'stationary'  // 静止（GPS 速度 < 0.3 m/s，持续 > 10s）
  | 'strolling'   // 漫步（0.3 ~ 1.2 m/s）
  | 'hiking'      // 正常徒步（1.2 ~ 2.5 m/s）
  | 'climbing'    // 陡坡攀升（爬升率 > 8% 且速度 < 2.0 m/s）
  | 'descending'  // 下降（下降率 > 10%）
  | 'resting';    // 主动休息（GPS 停止 > 30s，心率正在回落）

/**
 * 单次 tick 输出的完整体征快照
 */
export interface VitalsSnapshot {
  heartRate: number;
  spo2: number;
  respRate: number;
  calories: number;
  motionState: MotionState;
  intensity: number;
}

/**
 * 用户生理档案（从 store 传入）
 */
export interface VitalsProfile {
  age: number;
  restingHeartRate: number;
  weightKg: number;
}

/**
 * GPS 运动数据输入
 */
export interface MotionInput {
  /** GPS 速度（m/s） */
  speed: number;
  /** 坡度百分比（正 = 上坡，负 = 下坡） */
  gradePercent: number;
  /** 海拔高度（米） */
  altitude: number;
  /** 距上次 tick 的时间间隔（秒） */
  dt: number;
}

// ============================================================
// 常量
// ============================================================

const DEFAULT_PROFILE: VitalsProfile = {
  age: 30,
  restingHeartRate: 65,
  weightKg: 65,
};

/** WorkRate 归一化基准：speed=2.5, grade=15 时 WorkRate ≈ 1.0 */
const WORK_RATE_NORMALIZER = 2.5;

/** 速度阈值 */
const SPEED_STATIONARY = 0.3;
const SPEED_STROLLING_MAX = 1.2;
const SPEED_HIKING_MAX = 2.5;
const SPEED_CLIMBING_MAX = 2.0;

/** 坡度阈值 */
const GRADE_CLIMBING = 8;
const GRADE_DESCENDING = -10;

/** 时间阈值（秒） */
const STATIONARY_DURATION = 10;
const RESTING_DURATION = 30;

// ============================================================
// 工具函数
// ============================================================

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function gaussianNoise(stdDev: number): number {
  const u1 = Math.random();
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(Math.max(u1, 1e-10))) * Math.cos(2 * Math.PI * u2) * stdDev;
}

// ============================================================
// VitalsSimulator 主类
// ============================================================

export class VitalsSimulator {
  // ---- 内部体征状态（一阶惯性系统的当前值） ----
  private hr: number;
  private spo2: number;
  private respRate: number;
  private calories: number;

  // ---- 运动状态 ----
  private motionState: MotionState = 'stationary';
  private stateEntryTime: number = Date.now();
  private stationaryTimer: number = 0;
  private restingTimer: number = 0;

  // ---- 用户档案 ----
  private profile: VitalsProfile;
  private hrMax: number;

  // ---- 累计统计 ----
  private totalDuration: number = 0;
  private peakHR: number = 0;
  private hrSum: number = 0;
  private hrSamples: number = 0;
  private spo2Sum: number = 0;
  private spo2Samples: number = 0;
  private timeInZone4: number = 0;
  private timeInZone5: number = 0;

  constructor(profile: Partial<VitalsProfile> = {}) {
    this.profile = { ...DEFAULT_PROFILE, ...profile };
    this.hrMax = 220 - this.profile.age;
    this.hr = this.profile.restingHeartRate;
    this.spo2 = 98;
    this.respRate = 14;
    this.calories = 0;
  }

  // ============================================================
  // 核心 tick：每 1~2 秒调用一次
  // ============================================================

  tick(input: MotionInput): VitalsSnapshot {
    const { speed, gradePercent, altitude, dt } = input;

    // ---- Step 1: 更新运动状态 ----
    this.updateMotionState(speed, gradePercent, dt);

    // ---- Step 2: 计算运动强度 ----
    const intensity = this.calcIntensity(speed, gradePercent);

    // ---- Step 3: 心率一阶惯性响应 ----
    this.updateHeartRate(intensity, dt);

    // ---- Step 4: SpO2 响应 ----
    this.updateSpO2(gradePercent, altitude, dt);

    // ---- Step 5: 呼吸频率 ----
    this.updateRespiration(intensity);

    // ---- Step 6: 卡路里 ----
    this.updateCalories(intensity, dt);

    // ---- Step 7: 累计统计 ----
    this.updateStats(dt);

    return {
      heartRate: Math.round(this.hr),
      spo2: Math.round(this.spo2),
      respRate: Math.round(this.respRate),
      calories: Math.round(this.calories),
      motionState: this.motionState,
      intensity: Math.round(intensity * 100) / 100,
    };
  }

  // ============================================================
  // 运动状态分类器
  // ============================================================

  private updateMotionState(speed: number, grade: number, dt: number): void {
    let candidate: MotionState;

    if (speed < SPEED_STATIONARY) {
      this.stationaryTimer += dt;
      if (this.stationaryTimer > RESTING_DURATION && this.hr > this.profile.restingHeartRate + 20) {
        candidate = 'resting';
      } else if (this.stationaryTimer > STATIONARY_DURATION) {
        candidate = 'stationary';
      } else {
        // 保持上一个状态，避免短暂停顿就切换
        candidate = this.motionState === 'resting' ? 'resting' : this.motionState;
      }
    } else {
      this.stationaryTimer = 0;
      this.restingTimer = 0;

      if (grade > GRADE_CLIMBING && speed < SPEED_CLIMBING_MAX) {
        candidate = 'climbing';
      } else if (grade < GRADE_DESCENDING) {
        candidate = 'descending';
      } else if (speed < SPEED_STROLLING_MAX) {
        candidate = 'strolling';
      } else if (speed <= SPEED_HIKING_MAX) {
        candidate = 'hiking';
      } else {
        candidate = 'hiking';
      }
    }

    if (candidate !== this.motionState) {
      this.motionState = candidate;
      this.stateEntryTime = Date.now();
    }
  }

  // ============================================================
  // 运动强度因子
  // ============================================================

  private calcIntensity(speed: number, grade: number): number {
    const alpha = 0.40;
    const beta = 0.45;
    const gamma = 0.15;

    const normalizedSpeed = speed / WORK_RATE_NORMALIZER;
    const normalizedGrade = Math.max(grade, 0) / 15;
    const interaction = normalizedSpeed * normalizedGrade;

    const workRate = alpha * normalizedSpeed + beta * normalizedGrade + gamma * interaction;
    return clamp(workRate, 0.05, 0.95);
  }

  // ============================================================
  // 心率：一阶惯性系统 + 噪声层
  // ============================================================

  private updateHeartRate(intensity: number, dt: number): void {
    const hrTarget = this.profile.restingHeartRate + (this.hrMax - this.profile.restingHeartRate) * intensity;

    // 时间常数：上升快、下降慢
    const tau = this.hr < hrTarget ? this.getTauUp() : this.getTauDown();

    // 一阶惯性响应
    const response = 1 - Math.exp(-dt / tau);
    this.hr += (hrTarget - this.hr) * response;

    // 噪声层
    this.hr += gaussianNoise(3);

    // 突发噪声（3% 概率 ±8~15 bpm 传感器伪影）
    if (Math.random() < 0.03) {
      this.hr += (Math.random() - 0.5) * 15;
    }

    this.hr = clamp(this.hr, 55, 200);
  }

  private getTauUp(): number {
    switch (this.motionState) {
      case 'climbing':
        return 25;
      case 'hiking':
        return 35;
      case 'strolling':
        return 40;
      default:
        return 45;
    }
  }

  private getTauDown(): number {
    switch (this.motionState) {
      case 'resting':
        return 120;
      case 'stationary':
        return 90;
      case 'descending':
        return 70;
      default:
        return 60;
    }
  }

  // ============================================================
  // SpO2：负相关于运动强度，响应缓慢
  // ============================================================

  private updateSpO2(grade: number, altitude: number, dt: number): void {
    const spo2Base = 98;

    // 坡度效应（二次）
    const gradePenalty = 0.06 * Math.pow(Math.max(grade, 0), 2);

    // 海拔效应（> 2500m 开始显著下降）
    const altitudePenalty = Math.max(0, (altitude - 2500) / 500) * 1.5;

    const spo2Target = spo2Base - gradePenalty - altitudePenalty;

    // 心率过高时强制压低 SpO2（组织耗氧增加）
    const hrConstraint = this.hr > 150 ? (this.hr - 150) * 0.05 : 0;
    const effectiveTarget = Math.min(spo2Target, 98 - hrConstraint);

    // 一阶惯性（SpO2 变化极慢）
    const tau = 150;
    this.spo2 += (effectiveTarget - this.spo2) * (1 - Math.exp(-dt / tau));

    // 微幅噪声
    this.spo2 += gaussianNoise(0.4);

    this.spo2 = clamp(this.spo2, 85, 99);
  }

  // ============================================================
  // 呼吸频率：与强度正相关，与 SpO2 交互
  // ============================================================

  private updateRespiration(intensity: number): void {
    let rr = 12 + 28 * intensity;

    // SpO2 低于 93 时呼吸代偿性加快
    if (this.spo2 < 93) {
      rr += (93 - this.spo2) * 2;
    }

    rr += gaussianNoise(1.5);
    this.respRate = clamp(rr, 10, 45);
  }

  // ============================================================
  // 卡路里：MET 代谢当量模型
  // ============================================================

  private updateCalories(intensity: number, dt: number): void {
    const met = 1.0 + 9.0 * Math.pow(intensity, 2);
    const caloriesPerSecond = (met * 3.5 * this.profile.weightKg) / (200 * 60);
    this.calories += caloriesPerSecond * dt;
  }

  // ============================================================
  // 统计追踪
  // ============================================================

  private updateStats(dt: number): void {
    this.totalDuration += dt;

    if (this.hr > this.peakHR) {
      this.peakHR = this.hr;
    }

    this.hrSum += this.hr;
    this.hrSamples += 1;
    this.spo2Sum += this.spo2;
    this.spo2Samples += 1;

    // 高强度区间计时
    const hrPercent = (this.hr - this.profile.restingHeartRate) / (this.hrMax - this.profile.restingHeartRate);
    if (hrPercent > 0.9) {
      this.timeInZone5 += dt;
    } else if (hrPercent > 0.8) {
      this.timeInZone4 += dt;
    }
  }

  // ============================================================
  // 公开 Getters
  // ============================================================

  get currentHR(): number {
    return Math.round(this.hr);
  }

  get currentSpO2(): number {
    return Math.round(this.spo2);
  }

  get currentRespRate(): number {
    return Math.round(this.respRate);
  }

  get currentCalories(): number {
    return Math.round(this.calories);
  }

  get currentMotionState(): MotionState {
    return this.motionState;
  }

  get averageHR(): number {
    return this.hrSamples > 0 ? Math.round(this.hrSum / this.hrSamples) : 0;
  }

  get averageSpO2(): number {
    return this.spo2Samples > 0 ? Math.round(this.spo2Sum / this.spo2Samples) : 0;
  }

  get peakHeartRate(): number {
    return Math.round(this.peakHR);
  }

  get totalTimeSeconds(): number {
    return Math.round(this.totalDuration);
  }

  get zone4Seconds(): number {
    return Math.round(this.timeInZone4);
  }

  get zone5Seconds(): number {
    return Math.round(this.timeInZone5);
  }

  // ============================================================
  // 重置（新一轮徒步开始时调用）
  // ============================================================

  reset(profile?: Partial<VitalsProfile>): void {
    if (profile) {
      this.profile = { ...DEFAULT_PROFILE, ...profile };
      this.hrMax = 220 - this.profile.age;
    }
    this.hr = this.profile.restingHeartRate;
    this.spo2 = 98;
    this.respRate = 14;
    this.calories = 0;
    this.motionState = 'stationary';
    this.stateEntryTime = Date.now();
    this.stationaryTimer = 0;
    this.restingTimer = 0;
    this.totalDuration = 0;
    this.peakHR = 0;
    this.hrSum = 0;
    this.hrSamples = 0;
    this.spo2Sum = 0;
    this.spo2Samples = 0;
    this.timeInZone4 = 0;
    this.timeInZone5 = 0;
  }
}
