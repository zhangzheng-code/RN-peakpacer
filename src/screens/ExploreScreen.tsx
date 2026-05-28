import React from 'react';
import { View, Text, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const FEATURED_TRAILS = [
  { id: '1', name: '武功山云海穿越', difficulty: '进阶', distance: '24.5km', rating: 4.9 },
  { id: '2', name: '虎跳峡高路徒步', difficulty: '挑战', distance: '31.2km', rating: 4.8 },
  { id: '3', name: '四姑娘山长坪沟', difficulty: '入门', distance: '16.8km', rating: 4.7 },
  { id: '4', name: '雨崩神瀑朝圣', difficulty: '进阶', distance: '28.0km', rating: 4.9 },
];

const CATEGORIES = ['热门推荐', '新手友好', '极限挑战', '星空露营', '雪山之巅'];

const DIFFICULTY_COLOR: Record<string, string> = {
  '入门': 'text-emerald-400',
  '进阶': 'text-amber-400',
  '挑战': 'text-red-400',
};

export default function ExploreScreen() {
  const insets = useSafeAreaInsets();

  return (
    <View className="flex-1 bg-[#121314]" style={{ paddingTop: insets.top }}>
      {/* Header */}
      <View className="px-5 pt-4 pb-3">
        <Text className="text-3xl font-bold text-white">Explore</Text>
        <Text className="text-sm text-gray-500 mt-1">发现你的下一条传奇路线</Text>
      </View>

      {/* Category chips */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 20, gap: 10 }}
        className="mb-4"
      >
        {CATEGORIES.map((cat, i) => (
          <View
            key={cat}
            className={`px-4 py-2 rounded-full ${
              i === 0 ? 'bg-emerald-500/20 border border-emerald-500/40' : 'bg-white/5 border border-white/10'
            }`}
          >
            <Text className={`text-sm ${i === 0 ? 'text-emerald-400 font-semibold' : 'text-gray-400'}`}>
              {cat}
            </Text>
          </View>
        ))}
      </ScrollView>

      {/* Featured trail cards */}
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: insets.bottom + 120 }}
        showsVerticalScrollIndicator={false}
      >
        <Text className="text-lg font-semibold text-white mb-3">精选路线</Text>

        {FEATURED_TRAILS.map((trail) => (
          <View
            key={trail.id}
            className="mb-4 rounded-2xl overflow-hidden"
            style={{
              backgroundColor: 'rgba(255,255,255,0.04)',
              borderWidth: 1,
              borderColor: 'rgba(255,255,255,0.06)',
            }}
          >
            {/* Placeholder hero area */}
            <View
              style={{ height: 160, backgroundColor: 'rgba(16,185,129,0.08)' }}
              className="items-center justify-center"
            >
              <Text className="text-5xl">&#x1F3D4;&#xFE0F;</Text>
            </View>

            <View className="p-4">
              <Text className="text-white text-base font-semibold">{trail.name}</Text>
              <View className="flex-row items-center mt-2 gap-3">
                <Text className={`text-xs font-medium ${DIFFICULTY_COLOR[trail.difficulty] || 'text-gray-400'}`}>
                  {trail.difficulty}
                </Text>
                <Text className="text-xs text-gray-500">{trail.distance}</Text>
                <Text className="text-xs text-amber-400">{'★'.repeat(Math.floor(trail.rating))} {trail.rating}</Text>
              </View>
            </View>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}
