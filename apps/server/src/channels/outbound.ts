/**
 * 出站回复的整形（task 13.18）。
 *
 * 频道配置里那几个开关（展示思考 / 工具调用 / 工具结果、两个长度上限、回复前缀）
 * 最终都要落到**一条要发出去的文本**上。这里把它做成纯函数：
 * 输入一轮的产物与配置，输出该发什么字符串。
 *
 * 为什么值得单独成模块：这几个开关的组合很碎（3 个开关 × 2 个长度上限 × 前缀），
 * 塞在频道实现里会到处 if；抽出来能完整测试，也保证**「关掉的东西一定不会出现」**。
 */

export interface OutboundConfig {
  bot_prefix?: string;
  show_thinking?: boolean;
  show_tool_calls?: boolean;
  show_tool_results?: boolean;
  tool_call_max_length?: number;
  tool_result_max_length?: number;
}

export interface ToolCallView {
  name: string;
  /** 参数摘要（可空） */
  args?: string;
  /** 工具结果（可空） */
  result?: string;
}

export interface OutboundInput {
  /** 面向用户的最终答复 */
  text: string;
  /** 思考过程（模型 reasoning） */
  thinking?: string;
  toolCalls?: readonly ToolCallView[];
  config?: OutboundConfig;
}

const DEFAULT_CALL_MAX = 500;
const DEFAULT_RESULT_MAX = 1500;

/** 按上限截断并留可见标记（不让内容无声消失） */
export function truncateWithMarker(text: string, max: number): string {
  const value = String(text ?? "");
  if (max <= 0) return "";
  if (value.length <= max) return value;
  const kept = value.slice(0, max);
  return `${kept}…（已截断 ${value.length - max} 字）`;
}

/** 工具调用的一行呈现 */
export function renderToolCall(call: ToolCallView, config: OutboundConfig = {}): string {
  const max = config.tool_call_max_length ?? DEFAULT_CALL_MAX;
  const args = call.args ? ` ${truncateWithMarker(call.args, max)}` : "";
  return `🔧 ${call.name}${args}`;
}

/** 工具结果的一行呈现 */
export function renderToolResult(call: ToolCallView, config: OutboundConfig = {}): string {
  const max = config.tool_result_max_length ?? DEFAULT_RESULT_MAX;
  const result = call.result ?? "";
  if (result.trim().length === 0) return "";
  return truncateWithMarker(result, max);
}

/**
 * 组装要发出去的文本。
 *
 * 顺序：思考（可选）→ 工具调用/结果（可选）→ 正式答复 → 前缀。
 * 前缀加在**最前面**（群里用来区分是助手说的）。
 *
 * ⚠️ 默认值必须与 `COMMON_CHANNEL_FIELDS` 保持一致：
 * **思考默认关、工具调用与结果默认开**。写成“必须显式 === true 才显示”
 * 会让未配置的频道反而看不到工具调用（这是实测出来的错）。
 */
export function shapeOutbound(input: OutboundInput): string {
  const config = input.config ?? {};
  const showThinking = config.show_thinking === true;
  const showToolCalls = config.show_tool_calls !== false;
  const showToolResults = config.show_tool_results !== false;
  const blocks: string[] = [];

  if (showThinking && input.thinking && input.thinking.trim().length > 0) {
    blocks.push(input.thinking.trim());
  }

  const calls = input.toolCalls ?? [];
  if (showToolCalls && calls.length > 0) {
    blocks.push(calls.map((c) => renderToolCall(c, config)).join("\n"));
  }
  if (showToolResults && calls.length > 0) {
    const results = calls
      .map((c) => renderToolResult(c, config))
      .filter((r) => r.length > 0);
    if (results.length > 0) blocks.push(results.join("\n"));
  }

  if (input.text && input.text.trim().length > 0) blocks.push(input.text.trim());

  const body = blocks.join("\n\n").trim();
  const prefix = String(config.bot_prefix ?? "").trim();
  if (prefix.length === 0) return body;
  return body.length === 0 ? prefix : `${prefix}\n${body}`;
}

/**
 * 一条回复是否值得发出去。
 * 全空（例如只产生了思考而思考被关掉）→ 不发，避免在平台上留下一条空气泡。
 */
export function shouldSend(shape: string): boolean {
  return shape.trim().length > 0;
}