/**
 * ============================================================
 * 小米 MiMo API 对话服务（MCP Tool Calling 版）
 * ============================================================
 *
 * 自动检测 API Key 前缀，路由到对应端点：
 *   tp- → https://token-plan-cn.xiaomimimo.com/v1/chat/completions
 *   sk- → https://api.xiaomimimo.com/v1/chat/completions
 *
 * 旗舰模型锁定：mimo-v2.5-pro
 * 完全兼容 OpenAI /chat/completions 协议
 *
 * 支持：
 *   - 纯文本对话（stream: false）
 *   - MCP Tool Calling 循环（最多 3 轮）
 *   - 打字机效果逐字输出
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

/** Tool Calling 最大轮次（防止无限循环） */
const MAX_TOOL_ROUNDS = 3;

// ============================================================
// API Key 管理
// ============================================================

let apiKey: string = '';

export function setMimoApiKey(key: string): void {
  apiKey = key.trim();
}

export function getMimoApiKey(): string {
  return apiKey;
}

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

/** 工具调用（OpenAI 兼容格式） */
export interface MimoToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

/** 对话消息格式（兼容 OpenAI 协议 + Tool Calling） */
export interface MimoMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: MimoToolCall[];
  tool_call_id?: string;
  name?: string;
}

/** 流式回调函数类型 */
export type MimoStreamCallback = (
  chunk: string,
  fullText: string,
  isDone: boolean,
) => void;

/** Tool Call 通知回调 */
export type ToolCallCallback = (toolCalls: MimoToolCall[]) => void;

/** Tool Result 通知回调（UI 可用于更新卡片状态） */
export type ToolResultCallback = (toolCallId: string, result: object, error?: string) => void;

// ============================================================
// 内部核心 — 纯 JSON 请求（返回完整 choice 对象）
// ============================================================

interface MimoResponseMessage {
  role: string;
  content: string | null;
  tool_calls?: MimoToolCall[];
}

interface MimoChoice {
  message: MimoResponseMessage;
  finish_reason: string;
}

/**
 * 发送一次非流式请求，返回完整的 choice 对象
 * （而非仅 content，以便检查 tool_calls）
 */
async function sendOnce(
  messages: MimoMessage[],
  tools?: object[],
): Promise<MimoChoice> {
  const endpoint = getMimoEndpoint();

  const body: Record<string, any> = {
    model: MODEL_ID,
    messages,
    stream: false,
    temperature: DEFAULT_TEMPERATURE,
    max_tokens: DEFAULT_MAX_TOKENS,
  };
  if (tools && tools.length > 0) {
    body.tools = tools;
  }

  const bodyStr = JSON.stringify(body);

  console.log('[MiMo] ===== 请求开始 =====');
  console.log('[MiMo] endpoint =', endpoint);
  console.log('[MiMo] Authorization = Bearer ' + apiKey.slice(0, 6) + '***' + apiKey.slice(-4));
  console.log('[MiMo] body length =', bodyStr.length);
  if (tools) console.log('[MiMo] tools count =', tools.length);

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: bodyStr,
  });

  console.log('[MiMo] HTTP Status =', response.status);

  if (!response.ok) {
    const errText = await response.text();
    console.log('[MiMo] Error Body =', errText.slice(0, 500));
    const statusMsg: Record<number, string> = {
      401: 'API Key 无效或已过期',
      403: 'API Key 无权访问该模型',
      429: '请求过于频繁，请稍后再试',
      500: 'MiMo 服务器内部错误',
      502: 'MiMo 服务网关异常',
      503: 'MiMo 服务暂时不可用',
    };
    const hint = statusMsg[response.status] || `HTTP ${response.status}`;
    throw new Error(`${hint}：${errText.slice(0, 200)}`);
  }

  const rawText = await response.text();
  console.log('[MiMo] Response length =', rawText.length);

  if (!rawText || rawText.trim().length === 0) {
    throw new Error('MiMo API 返回空响应体');
  }

  let data: any;
  try {
    data = JSON.parse(rawText);
  } catch {
    console.log('[MiMo] JSON parse failed, raw =', rawText.slice(0, 500));
    throw new Error('MiMo API 返回了非 JSON 响应');
  }

  if (data.error) {
    throw new Error(`MiMo API 错误: ${data.error.message || JSON.stringify(data.error)}`);
  }

  if (!data.choices || data.choices.length === 0) {
    throw new Error('MiMo API 返回空响应');
  }

  return data.choices[0] as MimoChoice;
}

// ============================================================
// 公开 API
// ============================================================

/**
 * 发送聊天请求到 MiMo API（支持 MCP Tool Calling）
 *
 * 核心流程：
 *   1. 校验 API Key
 *   2. fetch POST → 检查 response
 *   3. 如果有 tool_calls → 执行工具 → 把结果注入 messages → 再次请求
 *   4. 循环最多 MAX_TOOL_ROUNDS 轮
 *   5. 最终文本回复 → 打字机效果输出
 *
 * @param messages    - 完整的对话消息数组（含 system prompt）
 * @param onChunk     - 打字机回调
 * @param signal      - AbortSignal
 * @param tools       - OpenAI tools 数组（可选）
 * @param onToolCall  - 工具调用通知回调（可选）
 * @param onToolResult - 工具结果通知回调（可选）
 */
export async function sendMimoStream(
  messages: MimoMessage[],
  onChunk: MimoStreamCallback,
  signal?: AbortSignal,
  tools?: object[],
  onToolCall?: ToolCallCallback,
  onToolResult?: ToolResultCallback,
): Promise<void> {
  if (!apiKey) {
    throw new Error('MiMo API Key 未设置，请先调用 setMimoApiKey()');
  }

  if (signal?.aborted) {
    throw new Error('请求已取消');
  }

  // 对话历史（tool call 循环中会追加消息）
  const conversation = [...messages];

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    if (signal?.aborted) throw new Error('请求已取消');

    const choice = await sendOnce(conversation, tools);
    const msg = choice.message;

    // ---- 情况 A：模型返回了 tool_calls ----
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      console.log(`[MiMo] Tool Call 第 ${round + 1} 轮，${msg.tool_calls.length} 个工具`);

      // 通知 UI 有工具调用
      onToolCall?.(msg.tool_calls);

      // 把 assistant 消息（含 tool_calls）加入对话历史
      conversation.push({
        role: 'assistant',
        content: null,
        tool_calls: msg.tool_calls,
      });

      // 逐个执行工具
      for (const tc of msg.tool_calls) {
        if (signal?.aborted) throw new Error('请求已取消');

        const { getToolByName } = await import('./toolRegistry');
        const tool = getToolByName(tc.function.name);

        let result: object;
        let error: string | undefined;

        try {
          const args = JSON.parse(tc.function.arguments);
          if (tool) {
            const { useHikeStore } = await import('../store/useHikeStore');
            const store = useHikeStore.getState();
            result = await tool.execute(args, store);
          } else {
            result = { error: `未知工具: ${tc.function.name}` };
          }
        } catch (err) {
          result = { error: String(err) };
          error = String(err);
        }

        console.log('[MiMo] 工具执行:', tc.function.name, error ? '❌' : '✅');

        // 通知 UI 工具结果
        onToolResult?.(tc.id, result, error);

        // 把工具结果加入对话历史
        conversation.push({
          role: 'tool',
          content: JSON.stringify(result),
          tool_call_id: tc.id,
          name: tc.function.name,
        });
      }

      // 继续下一轮（让 MiMo 基于工具结果生成回复）
      continue;
    }

    // ---- 情况 B：正常文本回复 ----
    const fullText = msg.content || '';

    // 打字机效果
    const CHAR_DELAY_MS = 18;
    let accumulated = '';
    for (let i = 0; i < fullText.length; i++) {
      if (signal?.aborted) throw new Error('请求已取消');
      accumulated += fullText[i];
      onChunk(fullText[i], accumulated, false);
      if (i % 2 === 0) {
        await new Promise((r) => setTimeout(r, CHAR_DELAY_MS));
      }
    }
    onChunk('', fullText, true);
    return;
  }

  // 超过最大轮次
  throw new Error('工具调用轮次超限');
}

/**
 * 发送非流式聊天请求（备用，不含 tool call 循环）
 */
export async function sendMimoChat(messages: MimoMessage[]): Promise<string> {
  if (!apiKey) {
    throw new Error('MiMo API Key 未设置，请先调用 setMimoApiKey()');
  }
  const choice = await sendOnce(messages);
  return choice.message.content || '';
}
