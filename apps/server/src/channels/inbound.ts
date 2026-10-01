/**
 * 入站内容的归一化与去抖（tasks 13.16）。
 *
 * ## 它解决的两个真实问题
 *
 * 1. **纯媒体消息不能被无限挂起**：用户只发了一张图（或只发了语音），没有任何文字。
 *    如果「等文字到齐再处理」的规则无条件生效，这条消息会被永久挂在 pending 里 ——
 *    用户看不到任何反应。QwenPaw 的处置是：**语音是完整输入，直接放行**。
 * 2. **图先到、配文后到要合并**：先发图再打字是很常见的操作。两条平台事件之间
 *    隔几百毫秒，必须合成一条输入，否则助手会先对着空文字回一轮。
 */

export type PartKind = "text" | "audio" | "image" | "file" | "other";

export interface ContentPart {
  kind: PartKind;
  /** 文本内容（kind === "text" 时） */
  text?: string;
  /** 媒体地址或本地路径 */
  url?: string;
}

export interface NormalizedContent {
  /** 拼接后的文本（可能为空） */
  text: string;
  hasText: boolean;
  hasAudio: boolean;
  hasMedia: boolean;
  parts: ContentPart[];
}

/** 把任意来源的片段列表归一化成统一的内部形状 */
export function normalizeContentParts(parts: readonly ContentPart[] | undefined): NormalizedContent {
  const list = Array.isArray(parts) ? [...parts] : [];
  const text = list
    .filter((p) => p.kind === "text")
    .map((p) => String(p.text ?? ""))
    .join("")
    .trim();
  return {
    text,
    hasText: text.length > 0,
    hasAudio: list.some((p) => p.kind === "audio"),
    hasMedia: list.some((p) => p.kind === "image" || p.kind === "file"),
    parts: list,
  };
}

export interface DebounceDecision {
  /** true = 现在就把 `parts` 交给 agent；false = 先缓存，等后续事件 */
  flush: boolean;
  /** flush 为 true 时要交给 agent 的内容（已含此前缓存的片段） */
  parts: ContentPart[];
}

/**
 * 「无文本去抖」决策。
 *
 * 规则（照 QwenPaw `_apply_no_text_debounce` 的语义）：
 * - 有文本 → **立刻放行**，并带上此前缓存的片段（图先到、配文后到）
 * - 无文本但是**语音** → 立刻放行（语音本身是完整输入，不能等文字）
 * - 无文本且非语音 → **缓存**，本次不处理
 */
export function decideNoTextDebounce(
  pending: readonly ContentPart[],
  incoming: readonly ContentPart[],
): DebounceDecision {
  const merged = [...pending, ...incoming];
  const normalized = normalizeContentParts(merged);

  if (normalized.hasText) return { flush: true, parts: merged };
  if (normalized.hasAudio) return { flush: true, parts: merged };
  return { flush: false, parts: [] };
}

/** 把片段渲染成给模型看的一句话（附件用占位符表示，与 QwenPaw 的降级写法一致） */
export function renderPartsForModel(normalized: NormalizedContent): string {
  const lines: string[] = [];
  if (normalized.text) lines.push(normalized.text);
  for (const part of normalized.parts) {
    if (part.kind === "image") lines.push(`[图片: ${part.url ?? "(未提供地址)"}]`);
    else if (part.kind === "audio") lines.push(`[语音: ${part.url ?? "(未提供地址)"}]`);
    else if (part.kind === "file") lines.push(`[文件: ${part.url ?? "(未提供地址)"}]`);
  }
  return lines.join("\n").trim();
}