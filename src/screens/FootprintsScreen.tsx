import React from 'react';
import { View, Text, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const STATS = [
  { label: '总里程', value: '342.8', unit: 'km' },
  { label: '累计爬升', value: '12,450', unit: 'm' },
  { label: '徒步天数', value: '28', unit: '天' },
  { label: '探索网格', value: '1,247', unit: '格' },
];

const HISTORY = [
  { id: '1', name: '武功山云海穿越', date: '2026-05-15', distance: '24.5km', duration: '8h 32m', pei: 72 },
  { id: '2', name: '香格里拉环线', date: '2026-04-28', distance: '38.2km', duration: '2天1夜', pei: 85 },
  { id: '3', name: '黄山日出速穿', date: '2026-04-10', distance: '15.6km', duration: '5h 10m', pei: 58 },
];

const PEI_COLOR = (pei: number) => {
  if (pei < 60) return 'text-emerald-400';
  if (pei < 80) return 'text-amber-400';
  return 'text-red-400';
};

export default function FootprintsScreen() {
  const insets = useSafeAreaInsets();

  return (
    <View className="flex-1 bg-[#121314]" style={{ paddingTop: insets.top }}>
      {/* Header */}
      <View className="px-5 pt-4 pb-3">
        <Text className="text-3xl font-bold text-white">Footprints</Text>
        <Text className="text-sm text-gray-500 mt-1">你的山野足迹档案</Text>
      </View>

      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: insets.bottom + 120 }}
        showsVerticalScrollIndicator={false}
      >
        {/* Stats grid */}
        <View className="flex-row flex-wrap gap-3 mb-6">
          {STATS.map((stat) => (
            <View
              key={stat.label}
              className="rounded-2xl p-4 items-center"
              style={{
                width: '47%',
                backgroundColor: 'rgba(255,255,255,0.04)',
                borderWidth: 1,
                borderColor: 'rgba(255,255,255,0.06)',
              }}
            >
              <Text className="text-2xl font-bold text-white">
                {stat.value}
                <Text className="text-sm text-gray-500"> {stat.unit}</Text>
              </Text>
              <Text className="text-gray-500 text-xs mt-1">{stat.label}</Text>
            </View>
          ))}
        </View>

        {/* Recent hikes */}
        <Text className="text-base font-semibold text-white mb-3">最近徒步</Text>

        {HISTORY.map((hike) => (
          <View
            key={hike.id}
            className="rounded-2xl p-4 mb-3"
            style={{
              backgroundColor: 'rgba(255,255,255,0.04)',
              borderWidth: 1,
              borderColor: 'rgba(255,255,255,0.06)',
            }}
          >
            <View className="flex-row items-center justify-between">
              <Text className="text-white font-semibold text-base flex-1">{hike.name}</Text>
              <Text className={`text-sm font-bold ${PEI_COLOR(hike.pei)}`}>PEI {hike.pei}</Text>
            </View>
            <View className="flex-row items-center mt-2 gap-4">
              <Text className="text-gray-500 text-xs">{hike.date}</Text>
              <Text className="text-gray-500 text-xs">{hike.distance}</Text>
              <Text className="text-gray-500 text-xs">{hike.duration}</Text>
            </View>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}
