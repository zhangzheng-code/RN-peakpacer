/**
 * ============================================================
 * Zustand 全局状态管理 Store（持久化版本）
 * ============================================================
 *
 * 使用 Zustand + AsyncStorage 实现 Local-First 架构。
 * 即使 App 被系统强杀，重新打开时自动从 AsyncStorage 恢复：
 * - 当前徒步状态（isTracking）
 * - 实时轨迹路径（currentPath）
 * - 历史轨迹记录（historyTracks）
 * - 用户生理静态特征（profile）
 * - 生理体征数据（biometrics）
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type {
  HikeStatus,
  TrailPoint,
  HistoryTrack,
  UserProfile,
  BiometricsData,
} from '../types';

/**
 * Store 状态接口定义
 */
interface HikeStoreState {
  // ---- 徒步状态 ----

  /** 当前徒步状态 */
  hikeStatus: HikeStatus;

  /** 当前轨迹点数组（卡尔曼滤波后，未抽稀） */
  currentPath: TrailPoint[];

  /** 徒步开始时间（Unix 毫秒） */
  startTime: number | null;

  /** 累计距离（米） */
  totalDistance: number;

  /** 累计海拔上升（米） */
  elevationGain: number;

  // ---- 历史轨迹 ----

  /** 历史轨迹记录列表 */
  historyTracks: HistoryTrack[];

  // ---- 用户特征 ----

  /** 用户静态生理特征 */
  profile: UserProfile;

  // ---- 实时体征 ----

  /** 实时生理体征数据 */
  biometrics: BiometricsData;

  // ---- 安全预警状态 ----

  /** 连续超出阈值的次数 */
  consecutiveAlertCount: number;

  /** 是否正在显示警报 */
  isAlertActive: boolean;

  // ---- Actions ----

  /** 开始徒步 */
  startHike: () => void;

  /** 停止徒步并保存到历史记录 */
  stopHike: () => void;

  /** 追加轨迹点 */
  appendTrailPoints: (points: TrailPoint[]) => void;

  /** 更新累计距离 */
  setTotalDistance: (distance: number) => void;

  /** 更新累计海拔 */
  setElevationGain: (gain: number) => void;

  /** 更新用户特征 */
  updateProfile: (profile: Partial<UserProfile>) => void;

  /** 更新实时体征 */
  updateBiometrics: (data: Partial<BiometricsData>) => void;

  /** 增加连续警报计数 */
  incrementAlertCount: () => void;

  /** 重置连续警报计数 */
  resetAlertCount: () => void;

  /** 设置警报激活状态 */
  setAlertActive: (active: boolean) => void;

  /** 删除历史轨迹 */
  deleteHistoryTrack: (id: string) => void;

  /** 清空所有历史轨迹 */
  clearHistory: () => void;
}

/**
 * 默认用户特征
 */
const DEFAULT_PROFILE: UserProfile = {
  age: 30,
  restingHeartRate: 65,
  nickname: '徒步者',
};

/**
 * 默认体征数据
 */
const DEFAULT_BIOMETRICS: BiometricsData = {
  currentHeartRate: 75,
  spo2: 98,
};

/**
 * Zustand Store 创建
 *
 * persist 中间件配置：
 * - name: AsyncStorage 中的 key 名称
 * - storage: 使用 AsyncStorage 作为持久化后端
 * - partialize: 只持久化需要恢复的状态，排除函数和临时状态
 */
export const useHikeStore = create<HikeStoreState>()(
  persist(
    (set, get) => ({
      // ---- 初始状态 ----

      hikeStatus: 'idle',
      currentPath: [],
      startTime: null,
      totalDistance: 0,
      elevationGain: 0,
      historyTracks: [],
      profile: DEFAULT_PROFILE,
      biometrics: DEFAULT_BIOMETRICS,
      consecutiveAlertCount: 0,
      isAlertActive: false,

      // ---- Actions 实现 ----

      startHike: () => {
        set({
          hikeStatus: 'recording',
          currentPath: [],
          startTime: Date.now(),
          totalDistance: 0,
          elevationGain: 0,
          consecutiveAlertCount: 0,
          isAlertActive: false,
        });
      },

      stopHike: () => {
        const state = get();
        if (state.currentPath.length > 0 && state.startTime !== null) {
          const track: HistoryTrack = {
            id: `track_${state.startTime}`,
            startTime: state.startTime,
            endTime: Date.now(),
            trailPoints: [...state.currentPath],
            totalDistance: state.totalDistance,
            elevationGain: state.elevationGain,
            duration: Math.floor((Date.now() - state.startTime) / 1000),
          };
          set((prev) => ({
            hikeStatus: 'idle',
            startTime: null,
            historyTracks: [...prev.historyTracks, track],
            consecutiveAlertCount: 0,
            isAlertActive: false,
          }));
        } else {
          set({
            hikeStatus: 'idle',
            startTime: null,
            consecutiveAlertCount: 0,
            isAlertActive: false,
          });
        }
      },

      appendTrailPoints: (points) => {
        set((prev) => ({
          currentPath: [...prev.currentPath, ...points],
        }));
      },

      setTotalDistance: (distance) => {
        set({ totalDistance: distance });
      },

      setElevationGain: (gain) => {
        set({ elevationGain: gain });
      },

      updateProfile: (profileUpdate) => {
        set((prev) => ({
          profile: { ...prev.profile, ...profileUpdate },
        }));
      },

      updateBiometrics: (data) => {
        set((prev) => ({
          biometrics: { ...prev.biometrics, ...data },
        }));
      },

      incrementAlertCount: () => {
        set((prev) => ({
          consecutiveAlertCount: prev.consecutiveAlertCount + 1,
        }));
      },

      resetAlertCount: () => {
        set({ consecutiveAlertCount: 0 });
      },

      setAlertActive: (active) => {
        set({ isAlertActive: active });
      },

      deleteHistoryTrack: (id) => {
        set((prev) => ({
          historyTracks: prev.historyTracks.filter((t) => t.id !== id),
        }));
      },

      clearHistory: () => {
        set({ historyTracks: [] });
      },
    }),
    {
      name: 'smarthike-store',
      storage: createJSONStorage(() => AsyncStorage),
      /**
       * partialize: 只持久化需要跨会话恢复的状态
       * 排除临时状态（isAlertActive、consecutiveAlertCount）和函数
       */
      partialize: (state) => ({
        hikeStatus: state.hikeStatus,
        currentPath: state.currentPath,
        startTime: state.startTime,
        totalDistance: state.totalDistance,
        elevationGain: state.elevationGain,
        historyTracks: state.historyTracks,
        profile: state.profile,
        biometrics: state.biometrics,
      }),
    },
  ),
);
