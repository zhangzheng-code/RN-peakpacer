import React from 'react';
import { View, Text, ScrollView, TouchableOpacity } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const QUICK_PROMPTS = [
  { icon: '🏔️', label: '路线规划', desc: '根据体能推荐最佳路线' },
  { icon: '⚠️', label: '风险评估', desc: '实时分析当前路段安全' },
  { icon: '🌡️', label: '天气预警', desc: '山区微气候精准预报' },
  { icon: '🎒', label: '装备清单', desc: 'AI 生成必备装备列表' },
];

export default function AIGuideScreen() {
  const insets = useSafeAreaInsets();

  return (
    <View className="flex-1 bg-[#121314]" style={{ paddingTop: insets.top }}>
      {/* Header */}
      <View className="px-5 pt-4 pb-3">
        <Text className="text-3xl font-bold text-white">AI Guide</Text>
        <Text className="text-sm text-gray-500 mt-1">你的智能山野领队</Text>
      </View>

      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: insets.bottom + 120 }}
        showsVerticalScrollIndicator={false}
      >
        {/* AI Avatar + greeting */}
        <View
          className="rounded-2xl p-5 mb-6"
          style={{
            backgroundColor: 'rgba(16,185,129,0.06)',
            borderWidth: 1,
            borderColor: 'rgba(16,185,129,0.15)',
          }}
        >
          <View className="flex-row items-center mb-3">
            <View
              className="w-12 h-12 rounded-full items-center justify-center"
              style={{ backgroundColor: 'rgba(16,185,129,0.2)' }}
            >
              <Text className="text-2xl">🤖</Text>
            </View>
            <View className="ml-3 flex-1">
              <Text className="text-white font-semibold text-base">DeepSeek 领队</Text>
              <Text className="text-emerald-400/70 text-xs mt-0.5">在线 · 准备就绪</Text>
            </View>
          </View>
          <Text className="text-gray-300 text-sm leading-5">
            你好！我是你的 AI 山野领队。我可以帮你规划路线、评估风险、推荐装备，或者在徒步过程中提供实时指导。有什么需要帮助的吗？
          </Text>
        </View>

        {/* Quick prompt cards */}
        <Text className="text-base font-semibold text-white mb-3">快速咨询</Text>

        <View className="flex-row flex-wrap gap-3">
          {QUICK_PROMPTS.map((prompt) => (
            <TouchableOpacity
              key={prompt.label}
              activeOpacity={0.7}
              className="rounded-xl p-4"
              style={{
                width: '47%',
                backgroundColor: 'rgba(255,255,255,0.04)',
                borderWidth: 1,
                borderColor: 'rgba(255,255,255,0.06)',
              }}
            >
              <Text className="text-2xl mb-2">{prompt.icon}</Text>
              <Text className="text-white text-sm font-medium">{prompt.label}</Text>
              <Text className="text-gray-500 text-xs mt-1">{prompt.desc}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Recent insights */}
        <Text className="text-base font-semibold text-white mb-3 mt-6">最近洞察</Text>

        {[
          { time: '2小时前', text: '前方 2.3km 处有落石风险，建议绕行北侧小径' },
          { time: '昨天', text: '您上周四姑娘山之行 PEI 峰值 78，建议本周轻度恢复训练' },
        ].map((insight, i) => (
          <View
            key={i}
            className="rounded-xl p-4 mb-3"
            style={{
              backgroundColor: 'rgba(255,255,255,0.03)',
              borderWidth: 1,
              borderColor: 'rgba(255,255,255,0.05)',
            }}
          >
            <Text className="text-gray-500 text-xs mb-1">{insight.time}</Text>
            <Text className="text-gray-300 text-sm leading-5">{insight.text}</Text>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}
