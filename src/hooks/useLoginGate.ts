/**
 * ============================================================
 * useLoginGate — 全局登录拦截 Hook
 * ============================================================
 *
 * 统一登录拦截模式，避免在 14 个 action handler 中重复写 if/else。
 *
 * 用法：
 *   const { requireLogin } = useLoginGate();
 *
 *   const handleStartHike = useCallback(() => {
 *     if (!requireLogin('开始徒步')) return;
 *     // ... 原有逻辑
 *   }, [requireLogin]);
 *
 * 设计原则：
 *   - 用 Zustand.getState() 读取最新闭包外状态，避免陈旧引用
 *   - 未登录时自动弹出 LoginModal + Haptic 提示
 *   - 返回 true = 已登录可继续，false = 被拦截
 */

import { useCallback } from 'react';
import * as Haptics from 'expo-haptics';
import { useHikeStore } from '../store/useHikeStore';

export function useLoginGate() {
  /**
   * 检查登录状态，未登录则弹出登录弹窗并返回 false。
   * @param action 可选的 action 名称，用于日志或提示
   * @returns true = 已登录可继续，false = 被拦截
   */
  const requireLogin = useCallback((action?: string): boolean => {
    const { accountState, showLoginModal } = useHikeStore.getState();
    if (accountState.isLoggedIn) return true;

    // 震动提醒用户需要登录
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    showLoginModal();
    return false;
  }, []);

  return { requireLogin };
}
