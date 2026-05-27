/**
 * ============================================================
 * AI 智能领队聊天界面（AIChatScreen）
 * ============================================================
 *
 * 小红书式磨砂白气泡对话流设计。
 * - FlatList 渲染聊天气泡（用户/AI 双头像）
 * - 基础 Markdown 渲染（加粗、列表、分割线）
 * - KeyboardAvoidingView 键盘避让
 * - SSE 流式打字机效果
 */

import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useHikeStore } from '../store/useHikeStore';
import {
  sendStreamingChat,
  setDeepSeekApiKey,
  getDeepSeekApiKey,
  type ChatCompletionMessage,
} from '../services/deepseekService';
import {
  buildMessages,
  getLifeAlertPrefix,
  type EnvironmentContext,
} from '../utils/promptTemplate';
import type { ChatMessage } from '../types';

/**
 * Props
 */
interface AIChatScreenProps {
  /** 是否可见 */
  visible: boolean;
  /** 关闭回调 */
  onClose: () => void;
}

/**
 * 生成消息唯一 ID
 */
function generateMessageId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 简易 Markdown 文本渲染器
 *
 * 将 Markdown 文本解析为可渲染的 Text 元素数组。
 * 支持：加粗 **text**、无序列表 - item、分割线 ---、换行
 */
function renderMarkdownText(text: string, isAI: boolean): React.ReactNode[] {
  const lines = text.split('\n');
  const elements: React.ReactNode[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 分割线
    if (line.trim() === '---') {
      elements.push(
        <View
          key={`hr_${i}`}
          style={{
            height: 1,
            backgroundColor: '#e8e8e8',
            marginVertical: 8,
          }}
        />,
      );
      continue;
    }

    // 无序列表项
    if (line.trim().startsWith('- ') || line.trim().startsWith('* ')) {
      const itemText = line.trim().slice(2);
      elements.push(
        <View key={`li_${i}`} style={{ flexDirection: 'row', marginVertical: 2 }}>
          <Text style={{ color: isAI ? '#666' : '#fff', marginRight: 6 }}>{'•'}</Text>
          <Text style={{ color: isAI ? '#333' : '#fff', flex: 1, lineHeight: 20 }}>
            {renderInlineMarkdown(itemText, isAI)}
          </Text>
        </View>,
      );
      continue;
    }

    // 有序列表项
    const orderedMatch = line.trim().match(/^(\d+)\.\s(.+)/);
    if (orderedMatch) {
      elements.push(
        <View key={`ol_${i}`} style={{ flexDirection: 'row', marginVertical: 2 }}>
          <Text style={{ color: isAI ? '#666' : '#fff', marginRight: 6, fontWeight: '600' }}>
            {orderedMatch[1]}.
          </Text>
          <Text style={{ color: isAI ? '#333' : '#fff', flex: 1, lineHeight: 20 }}>
            {renderInlineMarkdown(orderedMatch[2], isAI)}
          </Text>
        </View>,
      );
      continue;
    }

    // 空行
    if (line.trim() === '') {
      elements.push(<View key={`br_${i}`} style={{ height: 6 }} />);
      continue;
    }

    // 普通段落
    elements.push(
      <Text key={`p_${i}`} style={{ color: isAI ? '#333' : '#fff', lineHeight: 20, marginVertical: 1 }}>
        {renderInlineMarkdown(line, isAI)}
      </Text>,
    );
  }

  return elements;
}

/**
 * 渲染行内 Markdown（加粗）
 */
function renderInlineMarkdown(text: string, isAI: boolean): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, idx) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return (
        <Text key={idx} style={{ fontWeight: '700', color: isAI ? '#1a1a1a' : '#fff' }}>
          {part.slice(2, -2)}
        </Text>
      );
    }
    return <Text key={idx}>{part}</Text>;
  });
}

/**
 * 聊天气泡组件
 */
function ChatBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  const isAlert = message.content.includes('红色生命警报');

  return (
    <View style={[bubbleStyles.row, isUser ? bubbleStyles.rowUser : bubbleStyles.rowAI]}>
      {/* AI 头像 */}
      {!isUser && (
        <View style={[bubbleStyles.avatar, bubbleStyles.avatarAI]}>
          <Text style={bubbleStyles.avatarText}>🦅</Text>
        </View>
      )}

      {/* 气泡内容 */}
      <View
        style={[
          bubbleStyles.bubble,
          isUser ? bubbleStyles.bubbleUser : bubbleStyles.bubbleAI,
          isAlert && bubbleStyles.bubbleAlert,
        ]}
      >
        {isAlert && !isUser && (
          <View style={bubbleStyles.alertBadge}>
            <Text style={bubbleStyles.alertBadgeText}>🚨 生命安全警报</Text>
          </View>
        )}
        <View>
          {renderMarkdownText(message.content, !isUser)}
        </View>
        {message.isStreaming && (
          <ActivityIndicator
            size="small"
            color={isUser ? '#fff' : '#1890ff'}
            style={{ marginTop: 4 }}
          />
        )}
      </View>

      {/* 用户头像 */}
      {isUser && (
        <View style={[bubbleStyles.avatar, bubbleStyles.avatarUser]}>
          <Text style={bubbleStyles.avatarText}>🧗</Text>
        </View>
      )}
    </View>
  );
}

/**
 * AIChatScreen 主组件
 */
export default function AIChatScreen({ visible, onClose }: AIChatScreenProps) {
  const insets = useSafeAreaInsets();
  const flatListRef = useRef<FlatList>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const {
    profile,
    biometrics,
    elevationGain,
    totalDistance,
    chatMessages,
    clearChatMessages,
  } = useHikeStore();
  const [inputText, setInputText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [needsApiKey, setNeedsApiKey] = useState(true);

  /** 检查 API Key 是否已设置 */
  useEffect(() => {
    if (visible) {
      const existingKey = getDeepSeekApiKey();
      setNeedsApiKey(!existingKey);
    }
  }, [visible]);

  /** 构建环境上下文 */
  const environmentContext = useMemo<EnvironmentContext>(
    () => ({
      profile,
      biometrics,
      elevationGain,
      totalDistance,
    }),
    [profile, biometrics, elevationGain, totalDistance],
  );

  /** 确认 API Key */
  const handleConfirmApiKey = useCallback(() => {
    const trimmed = apiKeyInput.trim();
    if (!trimmed) {
      Alert.alert('提示', '请输入有效的 DeepSeek API Key');
      return;
    }
    setDeepSeekApiKey(trimmed);
    setNeedsApiKey(false);
  }, [apiKeyInput]);

  /**
   * 更新指定 ID 的消息
   *
   * 使用 Zustand 函数式更新 set((prev) => ...)，
   * 闭包内不依赖 chatMessages，避免陈旧引用导致渲染循环崩溃。
   */
  const updateMessage = useCallback(
    (id: string, updater: (msg: ChatMessage) => ChatMessage) => {
      useHikeStore.setState((prev) => ({
        chatMessages: prev.chatMessages.map((m) =>
          m.id === id ? updater(m) : m,
        ),
      }));
    },
    [],
  );

  /** 发送消息 */
  const handleSend = useCallback(async () => {
    const userText = inputText.trim();
    if (!userText || isLoading) return;

    const userMessage: ChatMessage = {
      id: generateMessageId(),
      role: 'user',
      content: userText,
      timestamp: Date.now(),
    };

    const aiMessageId = generateMessageId();
    const aiMessage: ChatMessage = {
      id: aiMessageId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      isStreaming: true,
    };

    // 使用函数式更新追加消息，不依赖闭包中的 chatMessages
    useHikeStore.setState((prev) => ({
      chatMessages: [...prev.chatMessages, userMessage, aiMessage],
    }));
    setInputText('');
    setIsLoading(true);

    const alertPrefix = getLifeAlertPrefix(environmentContext);

    // 从 store 读取最新消息构建历史（此时刚写入，数据是最新的）
    const currentMessages = useHikeStore.getState().chatMessages;
    const chatHistory = currentMessages.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));
    const apiMessages = buildMessages(environmentContext, chatHistory, userText);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    let accumulated = '';

    try {
      if (alertPrefix) {
        accumulated = alertPrefix;
        updateMessage(aiMessageId, (m) => ({ ...m, content: accumulated }));
      }

      await sendStreamingChat(
        apiMessages,
        (chunk, fullText, isDone) => {
          accumulated = (alertPrefix || '') + fullText;
          updateMessage(aiMessageId, (m) => ({
            ...m,
            content: accumulated,
            isStreaming: !isDone,
          }));
        },
        controller.signal,
      );
    } catch (error: any) {
      if (error.name === 'AbortError') {
        updateMessage(aiMessageId, (m) => ({
          ...m,
          content: accumulated + '\n\n*[已取消]*',
          isStreaming: false,
        }));
      } else {
        const errorMsg = error instanceof Error ? error.message : '未知错误';
        updateMessage(aiMessageId, (m) => ({
          ...m,
          content: `抱歉，请求失败：${errorMsg}\n\n请检查网络连接和 API Key 是否正确。`,
          isStreaming: false,
        }));
      }
    } finally {
      setIsLoading(false);
      abortControllerRef.current = null;
    }
  }, [inputText, isLoading, environmentContext, updateMessage]);

  /** 清空对话 */
  const handleClearChat = useCallback(() => {
    Alert.alert('清空对话', '确定要清空所有对话记录吗？', [
      { text: '取消', style: 'cancel' },
      {
        text: '确定',
        style: 'destructive',
        onPress: () => clearChatMessages(),
      },
    ]);
  }, [clearChatMessages]);

  if (!visible) return null;

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* 头部栏 */}
      <View style={styles.header}>
        <TouchableOpacity onPress={onClose} style={styles.headerButton}>
          <Text style={styles.headerButtonText}>← 返回</Text>
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>🦅 AI 领队</Text>
          <Text style={styles.headerSubtitle}>山鹰 · 高海拔徒步专家</Text>
        </View>
        <TouchableOpacity onPress={handleClearChat} style={styles.headerButton}>
          <Text style={[styles.headerButtonText, { color: '#999' }]}>清空</Text>
        </TouchableOpacity>
      </View>

      {/* API Key 输入面板 */}
      {needsApiKey ? (
        <View style={styles.apiKeyPanel}>
          <Text style={styles.apiKeyTitle}>🔑 设置 DeepSeek API Key</Text>
          <Text style={styles.apiKeyDesc}>
            请输入您的 DeepSeek API Key 以启用 AI 领队功能。
            {'\n'}可前往 platform.deepseek.com 免费获取。
          </Text>
          <TextInput
            style={styles.apiKeyInput}
            value={apiKeyInput}
            onChangeText={setApiKeyInput}
            placeholder="sk-..."
            placeholderTextColor="#ccc"
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
          />
          <TouchableOpacity
            style={styles.apiKeyButton}
            onPress={handleConfirmApiKey}
          >
            <Text style={styles.apiKeyButtonText}>确认</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <KeyboardAvoidingView
          style={styles.chatContainer}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          keyboardVerticalOffset={0}
        >
          {/* 聊天列表 */}
          <FlatList
            ref={flatListRef}
            data={chatMessages}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => <ChatBubble message={item} />}
            contentContainerStyle={styles.chatList}
            onContentSizeChange={() =>
              flatListRef.current?.scrollToEnd({ animated: true })
            }
            ListEmptyComponent={
              <View style={styles.emptyContainer}>
                <Text style={styles.emptyIcon}>🏔️</Text>
                <Text style={styles.emptyTitle}>你好，我是山鹰</Text>
                <Text style={styles.emptyDesc}>
                  你的 AI 户外领队。随时问我关于路线、装备、高反防护、急救知识等问题。
                </Text>
                <View style={styles.quickQuestions}>
                  {[
                    '我现在身体状况适合继续前进吗？',
                    '出现头痛恶心怎么办？',
                    '高海拔徒步需要注意什么？',
                  ].map((q) => (
                    <TouchableOpacity
                      key={q}
                      style={styles.quickQuestionButton}
                      onPress={() => setInputText(q)}
                    >
                      <Text style={styles.quickQuestionText}>{q}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            }
          />

          {/* 输入栏 */}
          <View style={[styles.inputBar, { paddingBottom: insets.bottom + 8 }]}>
            <TextInput
              style={styles.textInput}
              value={inputText}
              onChangeText={setInputText}
              placeholder="向 AI 领队提问..."
              placeholderTextColor="#aaa"
              multiline
              maxLength={1000}
              editable={!isLoading}
            />
            <TouchableOpacity
              style={[
                styles.sendButton,
                (!inputText.trim() || isLoading) && styles.sendButtonDisabled,
              ]}
              onPress={handleSend}
              disabled={!inputText.trim() || isLoading}
            >
              {isLoading ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={styles.sendButtonText}>发送</Text>
              )}
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      )}
    </View>
  );
}

// ---- 样式定义 ----

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fafafa',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: 'rgba(255, 255, 255, 0.95)',
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  headerButton: {
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  headerButtonText: {
    fontSize: 15,
    color: '#1890ff',
    fontWeight: '600',
  },
  headerCenter: {
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#1a1a1a',
  },
  headerSubtitle: {
    fontSize: 12,
    color: '#999',
    marginTop: 1,
  },
  apiKeyPanel: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  apiKeyTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#1a1a1a',
    marginBottom: 12,
    textAlign: 'center',
  },
  apiKeyDesc: {
    fontSize: 14,
    color: '#666',
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 24,
  },
  apiKeyInput: {
    backgroundColor: '#fff',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 15,
    borderWidth: 1,
    borderColor: '#e8e8e8',
    marginBottom: 16,
  },
  apiKeyButton: {
    backgroundColor: '#1890ff',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  apiKeyButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  chatContainer: {
    flex: 1,
  },
  chatList: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
  },
  emptyContainer: {
    alignItems: 'center',
    paddingTop: 80,
    paddingHorizontal: 32,
  },
  emptyIcon: {
    fontSize: 48,
    marginBottom: 16,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#1a1a1a',
    marginBottom: 8,
  },
  emptyDesc: {
    fontSize: 14,
    color: '#888',
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 24,
  },
  quickQuestions: {
    width: '100%',
    gap: 10,
  },
  quickQuestionButton: {
    backgroundColor: '#fff',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: '#e8e8e8',
  },
  quickQuestionText: {
    fontSize: 14,
    color: '#1890ff',
    fontWeight: '500',
  },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 12,
    paddingTop: 8,
    backgroundColor: 'rgba(255, 255, 255, 0.95)',
    borderTopWidth: 1,
    borderTopColor: '#f0f0f0',
    gap: 8,
  },
  textInput: {
    flex: 1,
    backgroundColor: '#f5f5f5',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 15,
    color: '#1a1a1a',
    maxHeight: 100,
    borderWidth: 1,
    borderColor: '#e8e8e8',
  },
  sendButton: {
    backgroundColor: '#1890ff',
    borderRadius: 20,
    paddingHorizontal: 20,
    paddingVertical: 10,
    justifyContent: 'center',
    alignItems: 'center',
    minWidth: 60,
  },
  sendButtonDisabled: {
    backgroundColor: '#c0c0c0',
  },
  sendButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },
});

// ---- 气泡样式 ----

const bubbleStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    marginBottom: 12,
    alignItems: 'flex-end',
  },
  rowUser: {
    justifyContent: 'flex-end',
  },
  rowAI: {
    justifyContent: 'flex-start',
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: 8,
  },
  avatarAI: {
    backgroundColor: '#e6f7ff',
  },
  avatarUser: {
    backgroundColor: '#fff1f0',
  },
  avatarText: {
    fontSize: 18,
  },
  bubble: {
    maxWidth: '75%',
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  bubbleUser: {
    backgroundColor: '#1890ff',
    borderBottomRightRadius: 4,
  },
  bubbleAI: {
    backgroundColor: '#fff',
    borderBottomLeftRadius: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  bubbleAlert: {
    backgroundColor: '#fff1f0',
    borderWidth: 1,
    borderColor: '#ffa39e',
  },
  alertBadge: {
    backgroundColor: '#ff4d4f',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
    alignSelf: 'flex-start',
    marginBottom: 8,
  },
  alertBadgeText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
  },
});
