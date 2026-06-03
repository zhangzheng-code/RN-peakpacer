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
 * - 账户登录状态（accountState）
 * - AI 领队对话记录（aiMessages）
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { shallow } from 'zustand/shallow';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type {
  HikeStatus,
  TrailPoint,
  HistoryTrack,
  UserProfile,
  BiometricsData,
  ChatMessage,
  BiometricsRecord,
} from '../types';

// ============================================================
// 账户状态类型
// ============================================================

/**
 * 登录用户信息
 */
export interface AccountUser {
  /** 用户唯一 ID */
  id: string;
  /** 用户昵称 */
  nickname: string;
  /** 头像 URL（可选） */
  avatarUrl: string | null;
  /** 认证 Token */
  token: string;
  /** 手机号（脱敏） */
  phone: string;
}

/**
 * 账户登录状态
 */
export interface AccountState {
  /** 是否已登录 */
  isLoggedIn: boolean;
  /** 用户信息（未登录时为 null） */
  user: AccountUser | null;
  /** 登录请求进行中 */
  isLoading: boolean;
  /** 登录失败错误信息 */
  error: string | null;
}

/**
 * 登录请求参数
 */
export interface LoginParams {
  /** 手机号 */
  phone: string;
  /** 验证码（Mock 模式下固定为 '123456'） */
  code: string;
}

/**
 * AI 领队对话消息（MiMo 模型专用）
 * 与 ChatMessage 结构一致，但独立存储以区分 DeepSeek 和 MiMo 的对话上下文
 */
export interface AiMessage {
  /** 消息唯一 ID */
  id: string;
  /** 消息角色 */
  role: 'user' | 'assistant' | 'system';
  /** 消息文本内容 */
  content: string;
  /** 创建时间戳（Unix 毫秒） */
  timestamp: number;
  /** 是否正在流式接收中 */
  isStreaming?: boolean;
}

/**
 * Mock 用户数据库
 * 生产环境替换为真实 API 调用
 */
const MOCK_USERS: Record<string, AccountUser> = {
  '13800000001': {
    id: 'usr_001',
    nickname: '山鹰',
    avatarUrl: null,
    token: 'mock_jwt_token_001_abc123',
    phone: '138****0001',
  },
  '13800000002': {
    id: 'usr_002',
    nickname: '林间风',
    avatarUrl: null,
    token: 'mock_jwt_token_002_def456',
    phone: '138****0002',
  },
  '13800000003': {
    id: 'usr_003',
    nickname: '云上行者',
    avatarUrl: null,
    token: 'mock_jwt_token_003_ghi789',
    phone: '138****0003',
  },
};

/**
 * 默认账户状态
 */
const DEFAULT_ACCOUNT_STATE: AccountState = {
  isLoggedIn: false,
  user: null,
  isLoading: false,
  error: null,
};

/**
 * JIT 危险装备卡片触发类型
 *
 * - 'oxygen'  : PEI 极高（≥80），推荐便携氧气设备
 * - 'cold'    : 气温跌破 0℃，推荐防寒冲锋衣
 * - null      : 无危险，不显示卡片
 */
export type HazardAlertType = 'oxygen' | 'cold' | null;

/**
 * 环境气象数据
 */
export interface WeatherData {
  /** 当前气温（℃） */
  temp: number;
  /** 天气状况描述（如 '晴'、'多云'、'暴风雪'） */
  condition: string;
}

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

  // ---- 环境气象 ----

  /** 当前环境气象数据 */
  weather: WeatherData;

  // ---- JIT 危险装备卡片 ----

  /**
   * 当前危险预警类型
   * - 'oxygen' : PEI ≥ 80，极度疲劳，推荐吸氧设备
   * - 'cold'   : 气温 < 0℃，推荐防寒装备
   * - null     : 安全，无卡片
   */
  hazardAlert: HazardAlertType;

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

  /** 更新环境气象数据（来自天气 API 或模拟） */
  updateWeather: (temp: number, condition: string) => void;

  /** 手动清除危险预警（用户已处理后） */
  clearHazardAlert: () => void;

  /** 删除历史轨迹 */
  deleteHistoryTrack: (id: string) => void;

  /** 清空所有历史轨迹 */
  clearHistory: () => void;

  // ---- AI 聊天记录 ----

  /** AI 聊天消息列表 */
  chatMessages: ChatMessage[];

  /** 设置聊天消息 */
  setChatMessages: (messages: ChatMessage[]) => void;

  /** 追加聊天消息 */
  appendChatMessage: (message: ChatMessage) => void;

  /** 清空聊天记录 */
  clearChatMessages: () => void;

  // ---- 网格探索状态 ----

  /**
   * 已点亮网格集合
   * 存储格式："latIndex,lngIndex"（如 "34263,108948"）
   * 使用 Set 序列化为字符串数组以兼容 AsyncStorage
   */
  exploredGrids: string[];

  /**
   * 网格索引查找 Set（运行时，不持久化）
   * 用于 O(1) 判断网格是否已探索
   */
  exploredGridSet: Set<string>;

  /** 点亮网格 action */
  exploreGrid: (lat: number, lng: number) => void;

  /** 手动添加单个已探索网格 key（用于回放/导入） */
  addExploredGrid: (gridKey: string) => void;

  /** 批量点亮网格（用于历史轨迹回放） */
  exploreGridsBatch: (points: TrailPoint[]) => void;

  /** 清空探索记录 */
  clearExploredGrids: () => void;

  // ---- 导航 / UI 状态 ----

  /** 当前活跃的 Tab 名称 */
  currentTab: string;

  /** 底部 Tab 栏是否可见（用于 BottomSheet 展开时隐藏） */
  isTabBarVisible: boolean;

  /** 设置当前 Tab */
  setCurrentTab: (tab: string) => void;

  /** 设置 Tab 栏可见性 */
  setTabBarVisible: (visible: boolean) => void;

  // ---- 账户状态 ----

  /** 账户登录状态 */
  accountState: AccountState;

  /**
   * Mock 登录
   * 模拟 POST /api/users/login
   * 验证码固定为 '123456'，手机号匹配 MOCK_USERS 数据库
   */
  login: (params: LoginParams) => Promise<boolean>;

  /** 登出并清除账户状态 */
  logout: () => void;

  // ---- AI 领队对话记录（MiMo 模型专用） ----

  /** AI 领队对话消息列表 */
  aiMessages: AiMessage[];

  /** 设置 AI 对话消息 */
  setAiMessages: (messages: AiMessage[]) => void;

  /** 追加 AI 对话消息 */
  appendAiMessage: (message: AiMessage) => void;

  /** 清空 AI 对话记录 */
  clearAiMessages: () => void;

  // ---- 约伴匹配 UI 状态 ----

  /** 智能匹配全屏动画是否可见 */
  isMatchVisible: boolean;

  /** 显示匹配动画 */
  showMatch: () => void;

  /** 关闭匹配动画 */
  hideMatch: () => void;

  // ---- 体征历史（滑动窗口） ----

  /** 最近 30 个数据点的体征历史 */
  biometricsHistory: BiometricsRecord[];

  /** 添加一条体征记录（FIFO 滑动窗口，超过 30 自动丢弃最旧） */
  addBiometricsRecord: (record: BiometricsRecord) => void;

  /** 清空体征历史 */
  clearBiometricsHistory: () => void;

  // ---- GPX 路线导入 ----

  /** 一键导入外部轨迹路线，覆盖 currentPath 并切换到录制状态 */
  importRoutePath: (path: Array<{ latitude: number; longitude: number }>) => void;
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
 * ============================================================
 * 网格化配置
 * ============================================================
 *
 * 网格尺寸：0.001° × 0.001°
 * 在赤道附近约合 111m × 111m，中纬度约 85m × 111m
 *
 * 网格索引计算：
 *   latIndex = Math.floor(latitude / GRID_SIZE)
 *   lngIndex = Math.floor(longitude / GRID_SIZE)
 *
 * 使用 Set<string> 进行 O(1) 的已探索判定
 */
const GRID_SIZE = 0.001;

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
      weather: { temp: 8, condition: '多云' },
      hazardAlert: null,
      chatMessages: [],
      exploredGrids: [],
      exploredGridSet: new Set<string>(),
      currentTab: 'HikeGo',
      isTabBarVisible: true,
      accountState: DEFAULT_ACCOUNT_STATE,
      aiMessages: [],
      isMatchVisible: false,
      biometricsHistory: [],

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

      updateWeather: (temp, condition) => {
        set({ weather: { temp, condition } });
      },

      clearHazardAlert: () => {
        set({ hazardAlert: null });
      },

      deleteHistoryTrack: (id) => {
        set((prev) => ({
          historyTracks: prev.historyTracks.filter((t) => t.id !== id),
        }));
      },

      clearHistory: () => {
        set({ historyTracks: [] });
      },

      setChatMessages: (messages) => {
        set({ chatMessages: messages });
      },

      appendChatMessage: (message) => {
        set((prev) => ({
          chatMessages: [...prev.chatMessages, message],
        }));
      },

      clearChatMessages: () => {
        set({ chatMessages: [] });
      },

      exploreGrid: (lat, lng) => {
        const latIndex = Math.floor(lat / GRID_SIZE);
        const lngIndex = Math.floor(lng / GRID_SIZE);
        const key = `${latIndex},${lngIndex}`;
        const state = get();
        if (state.exploredGridSet.has(key)) return;
        const newSet = new Set(state.exploredGridSet);
        newSet.add(key);
        set({
          exploredGrids: [...state.exploredGrids, key],
          exploredGridSet: newSet,
        });
      },

      addExploredGrid: (gridKey) => {
        const state = get();
        if (state.exploredGridSet.has(gridKey)) return;
        const newSet = new Set(state.exploredGridSet);
        newSet.add(gridKey);
        set({
          exploredGrids: [...state.exploredGrids, gridKey],
          exploredGridSet: newSet,
        });
      },

      exploreGridsBatch: (points) => {
        const state = get();
        const newSet = new Set(state.exploredGridSet);
        const newKeys: string[] = [];
        for (const p of points) {
          const latIndex = Math.floor(p.latitude / GRID_SIZE);
          const lngIndex = Math.floor(p.longitude / GRID_SIZE);
          const key = `${latIndex},${lngIndex}`;
          if (!newSet.has(key)) {
            newSet.add(key);
            newKeys.push(key);
          }
        }
        if (newKeys.length === 0) return;
        set({
          exploredGrids: [...state.exploredGrids, ...newKeys],
          exploredGridSet: newSet,
        });
      },

      clearExploredGrids: () => {
        set({ exploredGrids: [], exploredGridSet: new Set<string>() });
      },

      setCurrentTab: (tab) => {
        set({ currentTab: tab });
      },

      setTabBarVisible: (visible) => {
        set({ isTabBarVisible: visible });
      },

      addBiometricsRecord: (record) => {
        set((prev) => {
          const next = [...prev.biometricsHistory, record];
          // FIFO sliding window: keep only the last 30 records
          const biometricsHistory = next.length > 30
            ? next.slice(next.length - 30)
            : next;

          // ---- JIT 危险判定（多体征联合触发） ----
          // 最高优先级：缺氧/高负荷
          //   - SpO₂ < 90%（严重低氧）
          //   - 心率 > 120 bpm（高负荷）
          //   - PEI ≥ 12.0（综合耗竭）
          // 次高优先级：严寒失温（气温 < 0℃，且无缺氧风险）
          // 安全：不满足以上条件
          let hazardAlert: HazardAlertType = prev.hazardAlert;
          const isOxygenRisk =
            record.spo2 < 90 || record.heartRate > 120 || record.pei >= 12.0;
          const isColdRisk = prev.weather.temp < 0;

          if (isOxygenRisk) {
            hazardAlert = 'oxygen';
          } else if (isColdRisk) {
            hazardAlert = 'cold';
          } else {
            hazardAlert = null;
          }

          return { biometricsHistory, hazardAlert };
        });
      },

      clearBiometricsHistory: () => {
        set({ biometricsHistory: [] });
      },

      importRoutePath: (path) => {
        const trailPoints: TrailPoint[] = path.map((p) => ({
          latitude: p.latitude,
          longitude: p.longitude,
          timestamp: Date.now(),
        }));
        set({
          currentPath: trailPoints,
          hikeStatus: 'recording',
          startTime: Date.now(),
          totalDistance: 0,
          elevationGain: 0,
        });
      },

      // ============================================================
      // 账户登录（Mock API: POST /api/users/login）
      // ============================================================

      login: async (params: LoginParams): Promise<boolean> => {
        set((prev) => ({
          accountState: { ...prev.accountState, isLoading: true, error: null },
        }));

        // 模拟网络延迟 800~1500ms
        const delay = 800 + Math.random() * 700;
        await new Promise((resolve) => setTimeout(resolve, delay));

        // 验证码校验
        if (params.code !== '123456') {
          set((prev) => ({
            accountState: {
              ...prev.accountState,
              isLoading: false,
              error: '验证码错误，请输入 123456',
            },
          }));
          return false;
        }

        // 查询 Mock 用户数据库
        const user = MOCK_USERS[params.phone];
        if (!user) {
          // 手机号不在数据库中，自动创建新用户
          const newUser: AccountUser = {
            id: `usr_${Date.now().toString(36)}`,
            nickname: `徒步者${params.phone.slice(-4)}`,
            avatarUrl: null,
            token: `mock_jwt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
            phone: `${params.phone.slice(0, 3)}****${params.phone.slice(-4)}`,
          };
          set({
            accountState: {
              isLoggedIn: true,
              user: newUser,
              isLoading: false,
              error: null,
            },
          });
          return true;
        }

        // 登录成功
        set({
          accountState: {
            isLoggedIn: true,
            user: { ...user },
            isLoading: false,
            error: null,
          },
        });
        return true;
      },

      logout: () => {
        set({
          accountState: DEFAULT_ACCOUNT_STATE,
          aiMessages: [],
        });
      },

      // ============================================================
      // AI 领队对话记录（MiMo 模型专用）
      // ============================================================

      setAiMessages: (messages) => {
        set({ aiMessages: messages });
      },

      appendAiMessage: (message) => {
        set((prev) => ({
          aiMessages: [...prev.aiMessages, message],
        }));
      },

      clearAiMessages: () => {
        set({ aiMessages: [] });
      },

      showMatch: () => {
        set({ isMatchVisible: true });
      },

      hideMatch: () => {
        set({ isMatchVisible: false });
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
        weather: state.weather,
        chatMessages: state.chatMessages,
        exploredGrids: state.exploredGrids,
        accountState: state.accountState,
        aiMessages: state.aiMessages,
      }),
      /**
       * onRehydrateStorage: 从 AsyncStorage 恢复后，
       * 将 exploredGrids 数组重建为 Set 以支持 O(1) 查找
       */
      onRehydrateStorage: () => (state) => {
        if (state && state.exploredGrids) {
          state.exploredGridSet = new Set(state.exploredGrids);
        }
      },
    },
  ),
);
