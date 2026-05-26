/**
 * ============================================================
 * GPS 轨迹滤波与抽稀算法模块
 * ============================================================
 *
 * 本模块实现两个核心算法：
 * 1. KalmanFilter - 卡尔曼滤波器，用于实时平滑 GPS 定位噪点和跳点
 * 2. rdpSimplify - Ramer-Douglas-Peucker 抽稀算法，用于压缩冗余轨迹点
 *
 * 设计目标：
 * - 高精度：卡尔曼滤波有效消除 GPS 漂移和随机跳点
 * - 高帧率：RDP 抽稀将数千点压缩为数百点，保障 Polyline 60fps 渲染
 * - 低功耗：纯数学运算，无 I/O 开销，可在后台任务中高频调用
 */

import type { TrailPoint } from '../types';

/**
 * ============================================================
 * 卡尔曼滤波器（Kalman Filter）
 * ============================================================
 *
 * 一维状态估计模型，分别对经纬度独立滤波。
 *
 * 状态方程（预测步）：
 *   x̂ₖ⁻ = x̂ₖ₋₁          （假设用户短距离内匀速，状态不变）
 *   Pₖ⁻  = Pₖ₋₁ + Q       （预测协方差随过程噪声 Q 增大）
 *
 * 更新方程（校正步）：
 *   Kₖ = Pₖ⁻ / (Pₖ⁻ + R)  （卡尔曼增益，决定信任预测还是测量）
 *   x̂ₖ = x̂ₖ⁻ + Kₖ * (zₖ - x̂ₖ⁻)  （融合预测与测量）
 *   Pₖ = (1 - Kₖ) * Pₖ⁻   （更新协方差）
 *
 * 其中：
 *   zₖ = 本次 GPS 测量值
 *   x̂ₖ = 滤波后的最优估计
 *   K  = 卡尔曼增益（0~1），K→0 信任预测，K→1 信任测量
 *   Q  = 过程噪声（预测模型的不确定性）
 *   R  = 测量噪声（GPS 接收器的不确定性）
 */
export class KalmanFilter {
  /**
   * 过程噪声协方差 Q
   *
   * Q 越大 → 预测不确定性越高 → 滤波器更信任新测量值
   * Q 越小 → 预测越可靠 → 滤波器更倾向于维持旧估计
   *
   * 对于徒步场景，用户移动速度约 1~5 m/s，
   * GPS 采样间隔约 1s，单步位移约 1~5m，对应经纬度变化约 0.00001~0.00005°。
   * 设 Q = 0.0001 可平衡响应速度与平滑度。
   */
  private Q: number;

  /**
   * 测量噪声协方差 R
   *
   * R 越大 → GPS 测量越不可信 → 滤波输出越平滑（但延迟增大）
   * R 越小 → GPS 测量越可信 → 滤波输出越接近原始数据
   *
   * 普通手机 GPS 在开阔地带精度约 3~5m，对应经纬度约 0.00003~0.00005°。
   * 在峡谷、密林等遮蔽环境下精度可能劣化到 10~30m。
   * 设 R = 0.0001 适配大多数户外徒步场景。
   *
   * 调参建议：
   * - 高精度模式（开阔地带）：R = 0.00005，更贴合实测
   * - 强平滑模式（密林/峡谷）：R = 0.0005，更激进地抑制跳点
   */
  private R: number;

  /** 上一次滤波后的最优估计值 */
  private xHat: number | null = null;

  /** 上一次的估计协方差 P */
  private P: number = 1.0;

  /** 是否已完成首次初始化 */
  private initialized: boolean = false;

  constructor(Q: number = 0.0001, R: number = 0.0001) {
    this.Q = Q;
    this.R = R;
  }

  /**
   * 对单个标量值（经度或纬度）进行卡尔曼滤波
   *
   * @param measurement - 本次 GPS 测量值（经度或纬度）
   * @returns 滤波后的最优估计值
   */
  update(measurement: number): number {
    // ---- 首次初始化 ----
    // 第一个测量值直接作为初始估计，不做滤波
    if (!this.initialized) {
      this.xHat = measurement;
      this.P = 1.0;
      this.initialized = true;
      return measurement;
    }

    // ---- 预测步（Predict）----
    // 假设状态不变：x̂ₖ⁻ = x̂ₖ₋₁
    // 预测协方差累加过程噪声：Pₖ⁻ = Pₖ₋₁ + Q
    const pMinus = this.P + this.Q;

    // ---- 计算卡尔曼增益 K ----
    // K = Pₖ⁻ / (Pₖ⁻ + R)
    //
    // K 的物理意义：
    // - 当 Pₖ⁻ >> R 时，K → 1，滤波器完全信任新测量值
    // - 当 Pₖ⁻ << R 时，K → 0，滤波器维持旧估计
    // - 随着迭代进行，P 逐渐收敛，K 趋于稳定
    const K = pMinus / (pMinus + this.R);

    // ---- 更新步（Update）----
    // 融合预测与测量：x̂ₖ = x̂ₖ⁻ + K * (zₖ - x̂ₖ⁻)
    // 其中 (zₖ - x̂ₖ⁻) 是"新息"（innovation），即测量与预测的偏差
    this.xHat = this.xHat! + K * (measurement - this.xHat!);

    // 更新估计协方差：Pₖ = (1 - K) * Pₖ⁻
    this.P = (1 - K) * pMinus;

    return this.xHat;
  }

  /**
   * 重置滤波器状态
   * 在开始新的徒步轨迹记录时调用，清除历史状态
   */
  reset(): void {
    this.xHat = null;
    this.P = 1.0;
    this.initialized = false;
  }
}

/**
 * ============================================================
 * GPS 轨迹双轴卡尔曼滤波器
 * ============================================================
 *
 * 封装两个独立的 KalmanFilter 实例，分别处理经度和纬度。
 * 经纬度在地球表面近似正交（短距离内），独立滤波不会引入显著误差。
 */
export class GpsKalmanFilter {
  /** 经度滤波器 */
  private lonFilter: KalmanFilter;

  /** 纬度滤波器 */
  private latFilter: KalmanFilter;

  constructor(Q: number = 0.0001, R: number = 0.0001) {
    this.lonFilter = new KalmanFilter(Q, R);
    this.latFilter = new KalmanFilter(Q, R);
  }

  /**
   * 对一个 GPS 坐标点进行卡尔曼滤波
   *
   * @param point - 原始 GPS 坐标点（含经纬度和时间戳）
   * @returns 滤波后的坐标点
   */
  filter(point: TrailPoint): TrailPoint {
    return {
      latitude: this.latFilter.update(point.latitude),
      longitude: this.lonFilter.update(point.longitude),
      timestamp: point.timestamp,
      altitude: point.altitude,
      accuracy: point.accuracy,
    };
  }

  /**
   * 重置滤波器（开始新轨迹时调用）
   */
  reset(): void {
    this.lonFilter.reset();
    this.latFilter.reset();
  }
}

/**
 * ============================================================
 * Ramer-Douglas-Peucker (RDP) 轨迹抽稀算法
 * ============================================================
 *
 * 算法原理：
 * 1. 连接轨迹首尾两点形成线段
 * 2. 计算中间所有点到该线段的垂直距离
 * 3. 找到距离最大的点 dmax
 * 4. 若 dmax > epsilon（容差阈值），则以该点为分割点递归处理左右两段
 * 5. 若 dmax <= epsilon，则丢弃中间所有点，只保留首尾
 *
 * 时间复杂度：O(n log n) 平均，O(n²) 最坏
 * 空间复杂度：O(n)（递归栈 + 结果数组）
 *
 * @param points - 原始轨迹点数组
 * @param epsilon - 容差阈值（单位：米），越大抽稀越激进
 * @returns 抽稀后的轨迹点数组
 */
export function rdpSimplify(points: TrailPoint[], epsilon: number): TrailPoint[] {
  // 边界条件：少于 3 个点无法抽稀
  if (points.length <= 2) {
    return [...points];
  }

  // ---- Step 1: 找到距离首尾连线最远的点 ----

  const firstPoint = points[0];
  const lastPoint = points[points.length - 1];

  let maxDistance = 0;
  let maxIndex = 0;

  for (let i = 1; i < points.length - 1; i++) {
    const distance = perpendicularDistance(points[i], firstPoint, lastPoint);
    if (distance > maxDistance) {
      maxDistance = distance;
      maxIndex = i;
    }
  }

  // ---- Step 2: 递归分割或丢弃 ----

  if (maxDistance > epsilon) {
    // 最远点超过容差，以该点为分割点递归处理
    const leftSegment = rdpSimplify(points.slice(0, maxIndex + 1), epsilon);
    const rightSegment = rdpSimplify(points.slice(maxIndex), epsilon);

    // 拼接左右两段（去掉右段的首点避免重复）
    return leftSegment.slice(0, -1).concat(rightSegment);
  } else {
    // 所有点都在容差范围内，只保留首尾
    return [firstPoint, lastPoint];
  }
}

/**
 * 计算点 P 到线段 AB 的垂直距离（单位：米）
 *
 * 使用 Haversine 公式计算地球上两点间的球面距离，
 * 再通过向量叉积计算点到线段的垂直距离。
 *
 * 数学推导：
 *   设 A、B 为线段两端点，P 为待测点
 *   向量 AB = B - A，向量 AP = P - A
 *   垂直距离 d = |AB × AP| / |AB|
 *
 * 在经纬度坐标系中，叉积的模等于：
 *   |AB × AP| = |(B.lon - A.lon) * (P.lat - A.lat) - (B.lat - A.lat) * (P.lon - A.lon)|
 *
 * 最终将归一化的角度距离转换为米（乘以每度对应的米数）
 *
 * @param point - 待测点 P
 * @param lineStart - 线段起点 A
 * @param lineEnd - 线段终点 B
 * @returns 垂直距离（米）
 */
function perpendicularDistance(
  point: TrailPoint,
  lineStart: TrailPoint,
  lineEnd: TrailPoint,
): number {
  // 线段向量的经纬度分量
  const dLon = lineEnd.longitude - lineStart.longitude;
  const dLat = lineEnd.latitude - lineStart.latitude;

  // 线段长度的平方（角度空间）
  const lineLengthSq = dLon * dLon + dLat * dLat;

  // 退化情况：首尾重合，直接计算点到点的距离
  if (lineLengthSq === 0) {
    return haversineDistance(point, lineStart);
  }

  // 向量叉积的绝对值（角度空间）
  // |AB × AP| = |dLon * (P.lat - A.lat) - dLat * (P.lon - A.lon)|
  const crossProduct = Math.abs(
    dLon * (point.latitude - lineStart.latitude) -
    dLat * (point.longitude - lineStart.longitude),
  );

  // 垂直距离 = 叉积模 / 线段长度
  // 再乘以每度对应的米数（取经纬度方向的平均值）
  const avgLat = (lineStart.latitude + lineEnd.latitude + point.latitude) / 3;
  const metersPerDegreeLon = 111320 * Math.cos((avgLat * Math.PI) / 180);
  const metersPerDegreeLat = 110540;

  // 将角度空间的距离转换为米
  const distanceInMeters =
    (crossProduct / Math.sqrt(lineLengthSq)) *
    Math.sqrt(metersPerDegreeLon * metersPerDegreeLon + metersPerDegreeLat * metersPerDegreeLat) /
    Math.sqrt(2);

  return distanceInMeters;
}

/**
 * Haversine 公式计算地球表面两点间的大圆距离
 *
 * 公式：d = 2R * arcsin(√(sin²(Δφ/2) + cos(φ₁)cos(φ₂)sin²(Δλ/2)))
 *
 * @param p1 - 点 1
 * @param p2 - 点 2
 * @returns 距离（米）
 */
function haversineDistance(p1: TrailPoint, p2: TrailPoint): number {
  const R = 6371000; // 地球平均半径（米）
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
 * 轨迹后处理管线（Pipeline）
 * ============================================================
 *
 * 将卡尔曼滤波和 RDP 抽稀串联为完整的轨迹处理管线：
 *
 *   原始 GPS 点 → 卡尔曼滤波（逐点实时） → RDP 抽稀（批量压缩）
 *
 * 使用方式：
 * - 实时记录时：每收到一个新 GPS 点，调用 kalmanFilter.filter() 进行滤波
 * - 渲染轨迹时：对累积的滤波后点数组调用 rdpSimplify() 进行压缩
 *
 * @param points - 滤波后的轨迹点数组
 * @param epsilon - RDP 容差阈值（米），推荐值：
 *   - 高精度模式：3~5 米（保留更多细节）
 *   - 平衡模式：8~15 米（适合徒步场景）
 *   - 高压缩模式：20~50 米（适合长距离轨迹预览）
 * @returns 抽稀后的轨迹点数组
 */
export function processTrail(points: TrailPoint[], epsilon: number = 10): TrailPoint[] {
  if (points.length <= 2) {
    return [...points];
  }
  return rdpSimplify(points, epsilon);
}
