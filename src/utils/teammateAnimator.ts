/**
 * ============================================================
 * TeammateAnimator — 多人协同伪轮询位移引擎
 * ============================================================
 *
 * 基于路径弧长参数化的微幅偏离算法。
 * 每个队友独立维护进度、速度、横向正弦漂移和体征状态。
 *
 * 设计文档：第三阶段白皮书 §3
 */

// ============================================================
// 类型定义
// ============================================================

export interface TrailPoint {
  latitude: number;
  longitude: number;
}

export interface MockTeammate {
  id: string;
  emoji: string;
  name: string;
  color: string;
  baseSpeed: number;
  progress: number;
  lateralPhase: number;
  lateralAmplitude: number;
  lateralPeriod: number;
  heartRate: number;
  spo2: number;
  isResting: boolean;
  restTimer: number;
  speedBoost: number;
  boostTimer: number;
}

export interface TeammateRenderData {
  id: string;
  emoji: string;
  name: string;
  color: string;
  lat: number;
  lng: number;
  heartRate: number;
  spo2: number;
  isResting: boolean;
}

// ============================================================
// 工具函数
// ============================================================

function gaussian(stdDev: number): number {
  const u1 = Math.random();
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(Math.max(u1, 1e-10))) * Math.cos(2 * Math.PI * u2) * stdDev;
}

function haversine(a: TrailPoint, b: TrailPoint): number {
  const R = 6371000;
  const dLat = ((b.latitude - a.latitude) * Math.PI) / 180;
  const dLng = ((b.longitude - a.longitude) * Math.PI) / 180;
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos((a.latitude * Math.PI) / 180) * Math.cos((b.latitude * Math.PI) / 180) * sinLng * sinLng;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

// ============================================================
// 默认队友数据
// ============================================================

const DEFAULT_TEAMMATES: Omit<MockTeammate, 'progress' | 'heartRate' | 'spo2' | 'isResting' | 'restTimer' | 'speedBoost' | 'boostTimer'>[] = [
  {
    id: 'tm-alpha',
    emoji: '🐺',
    name: '野狼',
    color: '#3B82F6',
    baseSpeed: 1.4,
    lateralPhase: 0,
    lateralAmplitude: 1.5,
    lateralPeriod: 25,
  },
  {
    id: 'tm-bravo',
    emoji: '🦅',
    name: '山鹰',
    color: '#8B5CF6',
    baseSpeed: 1.8,
    lateralPhase: Math.PI / 3,
    lateralAmplitude: 3.0,
    lateralPeriod: 18,
  },
  {
    id: 'tm-charlie',
    emoji: '🐻',
    name: '棕熊',
    color: '#F59E0B',
    baseSpeed: 1.0,
    lateralPhase: (2 * Math.PI) / 3,
    lateralAmplitude: 2.0,
    lateralPeriod: 30,
  },
];

// ============================================================
// TeammateAnimator 主类
// ============================================================

export class TeammateAnimator {
  private teammates: MockTeammate[] = [];
  private path: TrailPoint[] = [];
  private cumulativeDist: number[] = [];
  private totalLength: number = 0;
  private initialized: boolean = false;

  /**
   * 初始化：传入当前路径，创建 3 个队友
   */
  init(path: TrailPoint[]): void {
    this.path = path;
    if (path.length < 2) {
      this.initialized = false;
      return;
    }

    // 计算累计弧长
    this.cumulativeDist = [0];
    for (let i = 1; i < path.length; i++) {
      this.cumulativeDist.push(this.cumulativeDist[i - 1] + haversine(path[i - 1], path[i]));
    }
    this.totalLength = this.cumulativeDist[this.cumulativeDist.length - 1];

    // 创建队友，初始进度分散在路径前 20%~50%
    this.teammates = DEFAULT_TEAMMATES.map((tmpl, i) => ({
      ...tmpl,
      progress: 0.2 + i * 0.15,
      heartRate: 65 + Math.round(Math.random() * 10),
      spo2: 97 + Math.round(Math.random() * 2),
      isResting: false,
      restTimer: 0,
      speedBoost: 1.0,
      boostTimer: 0,
    }));

    this.initialized = true;
  }

  /**
   * 每秒调用一次，更新所有队友位置和体征
   */
  tick(dt: number): TeammateRenderData[] {
    if (!this.initialized || this.path.length < 2) return [];

    const now = Date.now() / 1000;

    return this.teammates.map((tm) => {
      // ---- 1. 计算当前位置坡度 ----
      const idx = this.progressToIndex(tm.progress);
      const grade = this.calcGrade(idx);

      // ---- 2. 速度修正 ----
      let speed = tm.baseSpeed;
      speed /= 1 + 0.03 * Math.pow(Math.max(grade, 0), 2);
      if (tm.speedBoost > 1) {
        speed *= tm.speedBoost;
        tm.boostTimer -= dt;
        if (tm.boostTimer <= 0) tm.speedBoost = 1.0;
      }

      // ---- 3. 休憩判定 ----
      if (tm.isResting) {
        speed = 0;
        tm.restTimer -= dt;
        if (tm.restTimer <= 0) {
          tm.isResting = false;
          tm.speedBoost = 1.1;
          tm.boostTimer = 20;
        }
      } else if (Math.random() < 0.005) {
        tm.isResting = true;
        tm.restTimer = 15 + Math.random() * 30;
      }

      // ---- 4. 更新进度 ----
      const deltaProgress = this.totalLength > 0 ? (speed * dt) / this.totalLength : 0;
      tm.progress = Math.min(1.0, tm.progress + deltaProgress);

      // ---- 5. 更新体征 ----
      const gradePercent = grade * 100;
      tm.heartRate = this.updateHR(tm, speed, gradePercent, dt);
      tm.spo2 = this.updateSpo2(tm, gradePercent, dt);

      // ---- 6. 计算渲染坐标（含横向偏移） ----
      const base = this.interpolatePath(tm.progress);
      const tangent = this.getPathTangent(tm.progress);
      const normal = { x: -tangent.y, y: tangent.x };

      const offset =
        tm.lateralAmplitude * Math.sin((2 * Math.PI * now) / tm.lateralPeriod + tm.lateralPhase) +
        gaussian(0.8);

      return {
        id: tm.id,
        emoji: tm.emoji,
        name: tm.name,
        color: tm.color,
        lat: base.latitude + offset * normal.x * 1e-5,
        lng: base.longitude + offset * normal.y * 1e-5,
        heartRate: Math.round(tm.heartRate),
        spo2: Math.round(tm.spo2),
        isResting: tm.isResting,
      };
    });
  }

  /**
   * 重置（新一轮徒步或新路线导入时）
   */
  reset(path?: TrailPoint[]): void {
    if (path) {
      this.init(path);
    } else {
      this.initialized = false;
      this.teammates = [];
    }
  }

  get isReady(): boolean {
    return this.initialized;
  }

  // ---- 内部方法 ----

  private progressToIndex(progress: number): number {
    const targetDist = progress * this.totalLength;
    for (let i = 1; i < this.cumulativeDist.length; i++) {
      if (this.cumulativeDist[i] >= targetDist) return i - 1;
    }
    return this.cumulativeDist.length - 2;
  }

  private calcGrade(idx: number): number {
    if (idx < 0 || idx >= this.path.length - 1) return 0;
    const dist = haversine(this.path[idx], this.path[idx + 1]);
    if (dist === 0) return 0;
    const altA = (this.path[idx] as any).altitude || 500;
    const altB = (this.path[idx + 1] as any).altitude || 500;
    return ((altB - altA) / dist) * 100;
  }

  private interpolatePath(progress: number): TrailPoint {
    const targetDist = progress * this.totalLength;
    for (let i = 1; i < this.cumulativeDist.length; i++) {
      if (this.cumulativeDist[i] >= targetDist) {
        const segLen = this.cumulativeDist[i] - this.cumulativeDist[i - 1];
        const t = segLen > 0 ? (targetDist - this.cumulativeDist[i - 1]) / segLen : 0;
        return {
          latitude: this.path[i - 1].latitude + t * (this.path[i].latitude - this.path[i - 1].latitude),
          longitude: this.path[i - 1].longitude + t * (this.path[i].longitude - this.path[i - 1].longitude),
        };
      }
    }
    return this.path[this.path.length - 1];
  }

  private getPathTangent(progress: number): { x: number; y: number } {
    const idx = this.progressToIndex(progress);
    if (idx < 0 || idx >= this.path.length - 1) return { x: 1, y: 0 };
    const dx = this.path[idx + 1].longitude - this.path[idx].longitude;
    const dy = this.path[idx + 1].latitude - this.path[idx].latitude;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    return { x: dx / len, y: dy / len };
  }

  private updateHR(tm: MockTeammate, speed: number, grade: number, dt: number): number {
    const intensity = 0.4 * (speed / 2.5) + 0.45 * Math.min(Math.max(grade, 0) / 15, 1);
    const hrTarget = 65 + 125 * Math.min(intensity, 0.95);
    const tau = tm.heartRate < hrTarget ? 35 : 90;
    tm.heartRate += (hrTarget - tm.heartRate) * (1 - Math.exp(-dt / tau));
    tm.heartRate += gaussian(2.5);
    return Math.max(60, Math.min(190, tm.heartRate));
  }

  private updateSpo2(tm: MockTeammate, grade: number, dt: number): number {
    const target = 98 - 0.04 * Math.pow(Math.max(grade, 0), 2);
    tm.spo2 += (target - tm.spo2) * (1 - Math.exp(-dt / 150));
    tm.spo2 += gaussian(0.3);
    return Math.max(88, Math.min(99, tm.spo2));
  }
}
