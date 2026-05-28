import React from 'react';
import { View, Text, ScrollView, TouchableOpacity } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const PARTNERS = [
  { id: '1', name: '山风', avatar: '🧗', level: 'Lv.28 雪豹', trail: '贡嘎大环线', date: '6月3日', slots: 2 },
  { id: '2', name: '云雀', avatar: '🏃', level: 'Lv.15 飞鹰', trail: '武功山反穿', date: '6月7日', slots: 3 },
  { id: '3', name: '岩羊', avatar: '🧭', level: 'Lv.42 神鹰', trail: '鳌太穿越', date: '6月15日', slots: 1 },
];

export default function PartnerScreen() {
  const insets = useSafeAreaInsets();

  return (
    <View className="flex-1 bg-[#121314]" style={{ paddingTop: insets.top }}>
      {/* Header */}
      <View className="px-5 pt-4 pb-3">
        <Text className="text-3xl font-bold text-white">Partner</Text>
        <Text className="text-sm text-gray-500 mt-1">找到你的山野搭子</Text>
      </View>

      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: insets.bottom + 120 }}
        showsVerticalScrollIndicator={false}
      >
        {/* Quick match button */}
        <TouchableOpacity activeOpacity={0.8} className="mb-6">
          <View
            className="rounded-2xl p-5 items-center"
            style={{
              backgroundColor: 'rgba(16,185,129,0.1)',
              borderWidth: 1,
              borderColor: 'rgba(16,185,129,0.25)',
            }}
          >
            <Text className="text-3xl mb-2">🤝</Text>
            <Text className="text-emerald-400 font-semibold text-base">智能匹配</Text>
            <Text className="text-gray-400 text-xs mt-1">根据体能、偏好、时间自动推荐搭子</Text>
          </View>
        </TouchableOpacity>

        {/* Active invitations */}
        <View className="flex-row items-center justify-between mb-3">
          <Text className="text-base font-semibold text-white">正在约伴</Text>
          <Text className="text-emerald-400 text-xs">查看全部</Text>
        </View>

        {PARTNERS.map((partner) => (
          <View
            key={partner.id}
            className="rounded-2xl p-4 mb-3 flex-row items-center"
            style={{
              backgroundColor: 'rgba(255,255,255,0.04)',
              borderWidth: 1,
              borderColor: 'rgba(255,255,255,0.06)',
            }}
          >
            <View
              className="w-14 h-14 rounded-full items-center justify-center"
              style={{ backgroundColor: 'rgba(255,255,255,0.06)' }}
            >
              <Text className="text-2xl">{partner.avatar}</Text>
            </View>

            <View className="flex-1 ml-3">
              <View className="flex-row items-center">
                <Text className="text-white font-semibold text-base">{partner.name}</Text>
                <Text className="text-emerald-400/60 text-xs ml-2">{partner.level}</Text>
              </View>
              <Text className="text-gray-400 text-xs mt-1">{partner.trail} · {partner.date}</Text>
              <Text className="text-amber-400/70 text-xs mt-0.5">还差 {partner.slots} 人</Text>
            </View>

            <TouchableOpacity
              activeOpacity={0.7}
              className="px-4 py-2 rounded-full"
              style={{ backgroundColor: 'rgba(16,185,129,0.15)', borderWidth: 1, borderColor: 'rgba(16,185,129,0.3)' }}
            >
              <Text className="text-emerald-400 text-xs font-medium">加入</Text>
            </TouchableOpacity>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}
