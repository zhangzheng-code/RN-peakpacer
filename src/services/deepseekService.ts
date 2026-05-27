/**
 * ============================================================
 * DeepSeek-V4 API 对接服务
 * ============================================================
 *
 * 使用标准 fetch + ReadableStream 实现 SSE 流式传输。
 * 内置降级策略：当 Hermes 引擎不支持 response.body 时，
 * 自动降级为非流式请求 + 模拟逐字输出效果。
 *
 * 兼容性：
 * - Hermes 引擎原生支持 ReadableStream（RN 0.72+）
 * - TextDecoder 在 Hermes 中可用
 * - 不依赖第三方 SSE 库，纯手工解析
 */

/**
 * DeepSeek API 配置
 */
const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';
const DEEPSEEK_MODEL = 'deepseek-chat';

/**
 * API Key 存储
 */
let apiKey: string = '';

export function setDeepSeekApiKey(key: string): void {
  apiKey = key;
}

export function getDeepSeekApiKey(): string {
  return apiKey;
}

/**
 * 聊天消息格式（DeepSeek 兼容 OpenAI 协议）
 */
export interface ChatCompletionMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * 流式回调函数类型
 *
 * @param chunk - 本次收到的增量文本片段
 * @param fullText - 截至目前累积的完整文本
 * @param isDone - 是否已接收完毕
 */
export type StreamCallback = (
  chunk: string,
  fullText: string,
  isDone: boolean,
) => void;

/**
 * SSE 数据行解析器
 *
 * 从 SSE data 帧中提取 delta.content。
 * 健壮性：过滤空行、注释行、非 JSON 内容。
 *
 * @param line - 单行 SSE 数据（已去除 "data: " 前缀）
 * @returns 提取的文本片段，若为 [DONE] 或无效数据返回 null
 */
function parseSSELine(line: string): string | null {
  const trimmed = line.trim();

  // 流结束标记
  if (trimmed === '[DONE]') {
    return null;
  }

  // 空行或非 JSON 内容（如 SSE 注释以 ":" 开头）
  if (!trimmed || !trimmed.startsWith('{')) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed);

    // 检查 API 错误响应
    if (parsed.error) {
      const errMsg = parsed.error.message || JSON.stringify(parsed.error);
      throw new Error(`DeepSeek API 错误: ${errMsg}`);
    }

    // DeepSeek 兼容 OpenAI 协议：choices[0].delta.content
    if (parsed.choices && parsed.choices.length > 0) {
      const delta = parsed.choices[0].delta;
      if (delta && typeof delta.content === 'string') {
        return delta.content;
      }
    }
    return null;
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('DeepSeek API 错误')) {
      throw e;
    }
    // JSON 解析失败，跳过该行
    return null;
  }
}

/**
 * 检测当前环境是否支持 ReadableStream 流式读取
 *
 * RN Hermes 引擎下 response.body 可能为 null，
 * 此时无法使用流式读取，需要降级处理。
 */
function isStreamSupported(response: Response): boolean {
  return response.body !== null && typeof response.body?.getReader === 'function';
}

/**
 * 发送非流式聊天请求（内部方法，用于降级）
 */
async function sendNonStreamingChat(
  messages: ChatCompletionMessage[],
): Promise<string> {
  const response = await fetch(DEEPSEEK_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages,
      stream: false,
      temperature: 0.7,
      max_tokens: 2048,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`DeepSeek API 请求失败 (${response.status}): ${errorText}`);
  }

  const data = await response.json();

  if (data.error) {
    throw new Error(`DeepSeek API 错误: ${data.error.message || JSON.stringify(data.error)}`);
  }

  if (data.choices && data.choices.length > 0) {
    return data.choices[0].message.content;
  }

  throw new Error('DeepSeek API 返回空响应');
}

/**
 * 模拟流式逐字输出（用于降级场景）
 *
 * 当环境不支持 ReadableStream 时，先获取完整响应，
 * 再通过定时器模拟逐字输出效果，保持用户体验一致。
 */
async function simulateStreamingOutput(
  fullText: string,
  onChunk: StreamCallback,
): Promise<void> {
  const CHAR_DELAY_MS = 20; // 每个字符间隔
  let accumulated = '';

  for (let i = 0; i < fullText.length; i++) {
    accumulated += fullText[i];
    onChunk(fullText[i], accumulated, false);

    // 每隔一定字符让出事件循环，允许 UI 更新
    if (i % 3 === 0) {
      await new Promise((resolve) => setTimeout(resolve, CHAR_DELAY_MS));
    }
  }

  onChunk('', fullText, true);
}

/**
 * 发送流式聊天请求
 *
 * 核心流程：
 *   1. 构造请求体（stream: true）
 *   2. 通过 fetch 发起 HTTP 请求
 *   3. 检测 response.body 是否可用
 *   4. 可用 → ReadableStream 流式读取
 *   5. 不可用 → 降级为非流式请求 + 模拟逐字输出
 *
 * @param messages - 完整的对话消息数组（含 system prompt）
 * @param onChunk - 流式回调函数
 * @param signal - AbortSignal，用于取消请求
 */
export async function sendStreamingChat(
  messages: ChatCompletionMessage[],
  onChunk: StreamCallback,
  signal?: AbortSignal,
): Promise<void> {
  if (!apiKey) {
    throw new Error('DeepSeek API Key 未设置，请先调用 setDeepSeekApiKey()');
  }

  const response = await fetch(DEEPSEEK_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages,
      stream: true,
      temperature: 0.7,
      max_tokens: 2048,
    }),
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`DeepSeek API 请求失败 (${response.status}): ${errorText}`);
  }

  // ---- 检测流式支持 ----

  if (!isStreamSupported(response)) {
    // 降级：重新发起非流式请求 + 模拟逐字输出
    const fullText = await sendNonStreamingChat(messages);
    await simulateStreamingOutput(fullText, onChunk);
    return;
  }

  // ---- 流式读取 ----

  const reader = response.body!.getReader();
  const decoder = new TextDecoder('utf-8');

  let fullText = '';
  let lineBuffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        // 流结束，处理缓冲区中可能残留的最后一行
        if (lineBuffer.trim().length > 0) {
          if (lineBuffer.startsWith('data: ')) {
            const content = parseSSELine(lineBuffer.slice(6));
            if (content) {
              fullText += content;
              onChunk(content, fullText, false);
            }
          }
        }
        onChunk('', fullText, true);
        break;
      }

      // 将 Uint8Array 解码为字符串，拼接到行缓冲区
      const chunk = decoder.decode(value, { stream: true });
      lineBuffer += chunk;

      // 按行分割处理
      const lines = lineBuffer.split('\n');

      // 最后一个元素可能是不完整的行，保留在缓冲区中
      lineBuffer = lines.pop() || '';

      for (const line of lines) {
        // 跳过空行和 SSE 注释行
        const trimmedLine = line.trim();
        if (!trimmedLine || trimmedLine.startsWith(':')) {
          continue;
        }

        // SSE 协议：每行以 "data: " 开头
        if (trimmedLine.startsWith('data: ')) {
          const dataPayload = trimmedLine.slice(6);
          const content = parseSSELine(dataPayload);

          if (content === null) {
            // [DONE] 标记
            if (dataPayload.trim() === '[DONE]') {
              onChunk('', fullText, true);
              return;
            }
            // 其他无效数据，跳过
            continue;
          }

          fullText += content;
          onChunk(content, fullText, false);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * 发送非流式聊天请求（公开方法，备用方案）
 *
 * @param messages - 完整的对话消息数组
 * @returns AI 回复文本
 */
export async function sendChat(
  messages: ChatCompletionMessage[],
): Promise<string> {
  if (!apiKey) {
    throw new Error('DeepSeek API Key 未设置，请先调用 setDeepSeekApiKey()');
  }
  return sendNonStreamingChat(messages);
}
