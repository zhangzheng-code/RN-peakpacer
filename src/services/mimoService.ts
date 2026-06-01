/**
 * ============================================================
 * 小米 MiMo API 流式对话服务
 * ============================================================
 *
 * 自动检测 API Key 前缀，路由到对应端点：
 *   tp- → https://token-plan-cn.xiaomimimo.com/v1/chat/completions
 *   sk- → https://api.xiaomimimo.com/v1/chat/completions
 *
 * 旗舰模型锁定：mimo-v2.5-pro
 * 完全兼容 OpenAI /chat/completions 协议（stream: true）
 *
 * 降级策略：当 RN Hermes 引擎不支持 response.body 时，
 * 自动降级为非流式请求 + 模拟逐字输出，保证 UX 一致。
 */

// ============================================================
// 常量
// ============================================================

/** 旗舰模型 ID，硬编码不可覆盖 */
const MODEL_ID = 'mimo-v2.5-pro';

/** Key 前缀 → 完整 endpoint 映射 */
const ENDPOINTS: Record<string, string> = {
  'tp-': 'https://token-plan-cn.xiaomimimo.com/v1/chat/completions',
  'sk-': 'https://api.xiaomimimo.com/v1/chat/completions',
};

/** 兜底 endpoint（无法识别前缀时使用） */
const DEFAULT_ENDPOINT = 'https://api.xiaomimimo.com/v1/chat/completions';

/** 默认生成参数 */
const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_MAX_TOKENS = 8192;

// ============================================================
// API Key 管理
// ============================================================

let apiKey: string = '';

/**
 * 设置 MiMo API Key
 *
 * 传入后自动 trim，后续请求根据前缀自动路由到对应端点。
 */
export function setMimoApiKey(key: string): void {
  apiKey = key.trim();
}

/** 获取当前 API Key（调试用） */
export function getMimoApiKey(): string {
  return apiKey;
}

/**
 * 根据 API Key 前缀解析 endpoint
 *
 * - tp- 开头 → token-plan 国内端点
 * - sk- 开头 → 标准端点
 * - 其他     → 兜底标准端点
 */
export function getMimoEndpoint(): string {
  if (!apiKey) return DEFAULT_ENDPOINT;
  for (const prefix of Object.keys(ENDPOINTS)) {
    if (apiKey.startsWith(prefix)) {
      return ENDPOINTS[prefix];
    }
  }
  return DEFAULT_ENDPOINT;
}

// ============================================================
// 类型定义
// ============================================================

/** 对话消息格式（兼容 OpenAI 协议） */
export interface MimoMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * 流式回调函数类型
 *
 * @param chunk    - 本次收到的增量文本片段
 * @param fullText - 截至目前累积的完整文本
 * @param isDone   - 是否已接收完毕
 */
export type MimoStreamCallback = (
  chunk: string,
  fullText: string,
  isDone: boolean,
) => void;

// ============================================================
// 内部工具函数
// ============================================================

/**
 * SSE 数据行解析器
 *
 * 从 data 帧中提取 choices[0].delta.content。
 * 健壮性：过滤空行、注释行、非 JSON、API 错误。
 *
 * @param line - 单行 SSE 数据（已去除 "data: " 前缀）
 * @returns 提取的文本片段；[DONE] 或无效数据返回 null
 */
function parseSSELine(line: string): string | null {
  const trimmed = line.trim();

  // 流结束标记
  if (trimmed === '[DONE]') return null;

  // 空行或 SSE 注释（以 ":" 开头）
  if (!trimmed || !trimmed.startsWith('{')) return null;

  try {
    const parsed = JSON.parse(trimmed);

    // API 错误响应
    if (parsed.error) {
      const errMsg = parsed.error.message || JSON.stringify(parsed.error);
      throw new Error(`MiMo API 错误: ${errMsg}`);
    }

    // 提取 delta.content
    if (parsed.choices && parsed.choices.length > 0) {
      const delta = parsed.choices[0].delta;
      if (delta && typeof delta.content === 'string') {
        return delta.content;
      }
    }
    return null;
  } catch (e) {
    // 重新抛出 API 错误，吞掉 JSON 解析失败
    if (e instanceof Error && e.message.startsWith('MiMo API 错误')) throw e;
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
async function sendNonStreaming(messages: MimoMessage[]): Promise<string> {
  const endpoint = getMimoEndpoint();
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL_ID,
      messages,
      stream: false,
      temperature: DEFAULT_TEMPERATURE,
      max_tokens: DEFAULT_MAX_TOKENS,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`MiMo API 请求失败 (${response.status}): ${errText}`);
  }

  const data = await response.json();

  if (data.error) {
    throw new Error(`MiMo API 错误: ${data.error.message || JSON.stringify(data.error)}`);
  }

  if (data.choices && data.choices.length > 0) {
    return data.choices[0].message.content;
  }

  throw new Error('MiMo API 返回空响应');
}

/**
 * 模拟流式逐字输出（用于降级场景）
 *
 * 当环境不支持 ReadableStream 时，先获取完整响应，
 * 再通过定时器模拟逐字输出效果，保持用户体验一致。
 */
async function simulateStreaming(fullText: string, onChunk: MimoStreamCallback): Promise<void> {
  const CHAR_DELAY_MS = 20;
  let accumulated = '';

  for (let i = 0; i < fullText.length; i++) {
    accumulated += fullText[i];
    onChunk(fullText[i], accumulated, false);

    // 每隔一定字符让出事件循环，允许 UI 更新
    if (i % 3 === 0) {
      await new Promise((r) => setTimeout(r, CHAR_DELAY_MS));
    }
  }

  onChunk('', fullText, true);
}

// ============================================================
// 公开 API
// ============================================================

/**
 * 发送流式聊天请求到 MiMo API
 *
 * 核心流程：
 *   1. 校验 API Key
 *   2. 根据 Key 前缀选择 endpoint
 *   3. fetch POST（stream: true）
 *   4. 检测 response.body 是否可用
 *      - 可用 → ReadableStream 流式读取 SSE
 *      - 不可用 → 降级为非流式 + 模拟逐字输出
 *
 * @param messages - 完整的对话消息数组（含 system prompt）
 * @param onChunk  - 流式回调函数
 * @param signal   - AbortSignal，用于取消请求
 */
export async function sendMimoStream(
  messages: MimoMessage[],
  onChunk: MimoStreamCallback,
  signal?: AbortSignal,
): Promise<void> {
  if (!apiKey) {
    throw new Error('MiMo API Key 未设置，请先调用 setMimoApiKey()');
  }

  const endpoint = getMimoEndpoint();

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL_ID,
      messages,
      stream: true,
      temperature: DEFAULT_TEMPERATURE,
      max_tokens: DEFAULT_MAX_TOKENS,
    }),
    signal,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`MiMo API 请求失败 (${response.status}): ${errText}`);
  }

  // ---- 检测流式支持 ----

  if (!isStreamSupported(response)) {
    // 降级：重新发起非流式请求 + 模拟逐字输出
    const fullText = await sendNonStreaming(messages);
    await simulateStreaming(fullText, onChunk);
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
        if (lineBuffer.trim().length > 0 && lineBuffer.startsWith('data: ')) {
          const content = parseSSELine(lineBuffer.slice(6));
          if (content) {
            fullText += content;
            onChunk(content, fullText, false);
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

      // 最后一个元素可能是不完整的行，保留在缓冲区
      lineBuffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;

        if (trimmed.startsWith('data: ')) {
          const payload = trimmed.slice(6);
          const content = parseSSELine(payload);

          if (content === null) {
            // [DONE] 标记
            if (payload.trim() === '[DONE]') {
              onChunk('', fullText, true);
              return;
            }
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
 * @param messages - 完整的对话消息数组（含 system prompt）
 * @returns AI 回复文本
 */
export async function sendMimoChat(messages: MimoMessage[]): Promise<string> {
  if (!apiKey) {
    throw new Error('MiMo API Key 未设置，请先调用 setMimoApiKey()');
  }
  return sendNonStreaming(messages);
}
