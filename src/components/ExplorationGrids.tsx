/**
 * ============================================================
 * 地图足迹迷雾点亮组件（ExplorationGrids）
 * ============================================================
 *
 * 将已探索的网格以半透明亮色 Polygon 渲染在地图上，
 * 呈现"迷雾被驱散"的游戏化视觉效果。
 *
 * 性能优化：
 * - 使用 useMemo 缓存 Polygon 坐标，仅在 exploredGrids 长度变化时重算
 * - 使用 Zustand selector 精确订阅，避免无关状态触发重渲染
 * - Polygon 设置 geodesic={false} 避免不必要的球面计算
 */

import React, { useMemo, memo } from 'react';
import { Polygon } from 'react-native-maps';
import { useHikeStore } from '../store/useHikeStore';

/**
 * 网格尺寸（度），与 Store 中的 GRID_SIZE 一致
 */
const GRID_SIZE = 0.001;

/**
 * 网格填充颜色
 * 柔和的亮绿色半透明，模拟迷雾驱散后的"已探索"区域
 */
const GRID_FILL_COLOR = 'rgba(16, 185, 129, 0.22)';

/**
 * 单个网格的 Polygon 坐标
 * 由网格索引 (latIndex, lngIndex) 计算四个顶点
 */
interface GridPolygonCoords {
  id: string;
  coordinates: Array<{ latitude: number; longitude: number }>;
}

/**
 * 将 "latIndex,lngIndex" 字符串转换为 Polygon 四顶点坐标
 *
 * @param key - 网格索引字符串，如 "34263,108948"
 * @returns 四个顶点坐标（顺时针）
 */
function gridKeyToCoordinates(key: string): Array<{ latitude: number; longitude: number }> {
  const parts = key.split(',');
  const latIndex = parseInt(parts[0], 10);
  const lngIndex = parseInt(parts[1], 10);

  const south = latIndex * GRID_SIZE;
  const north = south + GRID_SIZE;
  const west = lngIndex * GRID_SIZE;
  const east = west + GRID_SIZE;

  return [
    { latitude: south, longitude: west }, // 左下
    { latitude: south, longitude: east }, // 右下
    { latitude: north, longitude: east }, // 右上
    { latitude: north, longitude: west }, // 左上
  ];
}

/**
 * ExplorationGrids 组件
 *
 * 使用 Zustand selector 精确订阅 exploredGrids 数组长度，
 * 仅当有新网格被点亮时才触发 useMemo 重算。
 */
function ExplorationGrids() {
  /**
   * 精确订阅：只读取 exploredGrids 的长度，
   * 避免数组引用变化导致的不必要重渲染
   */
  const gridsLength = useHikeStore((state) => state.exploredGrids.length);

  /**
   * 读取完整的 exploredGrids 数组用于渲染
   * 由于上面的 length 选择器已经过滤了大部分无关更新，
   * 这里的重渲染只在 length 变化时发生
   */
  const exploredGrids = useHikeStore((state) => state.exploredGrids);

  /**
   * useMemo 缓存 Polygon 坐标集合
   * 仅在 gridsLength 变化时重新计算
   */
  const polygonData = useMemo<GridPolygonCoords[]>(() => {
    return exploredGrids.map((key) => ({
      id: key,
      coordinates: gridKeyToCoordinates(key),
    }));
  }, [gridsLength]);

  return (
    <>
      {polygonData.map((grid) => (
        <Polygon
          key={grid.id}
          coordinates={grid.coordinates}
          fillColor={GRID_FILL_COLOR}
          strokeWidth={0}
          geodesic={false}
        />
      ))}
    </>
  );
}

/**
 * 使用 React.memo 包装，配合 selector 订阅实现极致性能
 */
export default memo(ExplorationGrids);
