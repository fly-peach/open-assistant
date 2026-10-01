import type { ToolCall } from "@/app/types/types";
import { looksLikeToolError } from "@/app/utils/toolResult";

/** 工具卡片只有三态（对齐 QwenPaw 的 calling/done/error）。 */
export type ToolCallStatus = "calling" | "done" | "error";

/**
 * 卡片渲染所需的、与后端消息形态解耦的调用视图。
 * 由 `ToolCallBox` 从 `ToolCall` 适配而来（见 `adaptToolCall`）。
 */
export interface ToolCallContent {
  id: string;
  name: string;
  /** 解析后的参数（已做键名归一化，见 params.ts 的 `normalizeParams`）。 */
  params: Record<string, unknown>;
  /** 原始参数，未经归一化。 */
  rawInput: Record<string, unknown>;
  result?: unknown;
  status: ToolCallStatus;
  /** error 是否由「中断」而非工具失败引起。 */
  interrupted?: boolean;
}

export interface CardProps {
  content: ToolCallContent;
  /** 该调用所在回合仍在流式生成。 */
  isStreaming?: boolean;
}

export type BuiltinCardComponent = React.FC<CardProps>;

/** 派生三态所需的上下文。 */
export interface DeriveToolStatusContext {
  /** 该调用所在回合是否仍在流式生成。 */
  isStreaming?: boolean;
  /** 该回合是否已经结束（结束仍未拿到结果的悬挂调用按中断处理）。 */
  turnEnded?: boolean;
  /** 该调用正在等待人工批准（此时不算失败）。 */
  awaitingApproval?: boolean;
  /** 结果正文呈失败特征（见 `looksLikeToolError`）。 */
  resultError?: boolean;
}

/**
 * 结果正文里的失败特征（实现见 `@/app/utils/toolResult`）。
 * 放在 utils 里是为了让回合聚合层也能用同一套判定，避免两处逻辑分叉。
 */
export {
  ERROR_RESULT_PATTERNS,
  looksLikeToolError,
} from "@/app/utils/toolResult";

/**
 * 从后端状态推导三态。
 *
 * 为什么需要它：`pending` 同时覆盖「还在跑」和「已被中断」两种情况，
 * 单看状态无法区分 —— 若不借助回合是否结束来收尾，被停止的调用会永远转圈
 * （QwenPaw 的同一结论，见其 `deriveToolStatus`）。
 */
export function deriveToolStatus(
  status: ToolCall["status"],
  ctx: DeriveToolStatusContext = {}
): { status: ToolCallStatus; interrupted: boolean } {
  const {
    isStreaming = false,
    turnEnded = false,
    awaitingApproval = false,
    resultError = false,
  } = ctx;

  if (status === "completed") {
    // 后端把部分失败报成 success，正文才是真相。
    return resultError
      ? { status: "error", interrupted: false }
      : { status: "done", interrupted: false };
  }
  if (status === "error") return { status: "error", interrupted: false };
  if (status === "interrupted") return { status: "error", interrupted: true };

  // status === "pending"
  if (awaitingApproval) return { status: "calling", interrupted: false };
  if (turnEnded && !isStreaming) return { status: "error", interrupted: true };
  return { status: "calling", interrupted: false };
}

/** 把前端 `ToolCall` 适配成卡片契约。 */
export function adaptToolCall(
  toolCall: ToolCall,
  ctx: DeriveToolStatusContext = {}
): ToolCallContent {
  const { status, interrupted } = deriveToolStatus(toolCall.status, {
    ...ctx,
    resultError: looksLikeToolError(toolCall.result),
  });
  return {
    id: toolCall.id,
    name: toolCall.name || "",
    params: normalizeParams(toolCall.args || {}),
    rawInput: toolCall.args || {},
    result: toolCall.result,
    status,
    interrupted,
  };
}

// ---------------------------------------------------------------------------
// 参数键归一化
// ---------------------------------------------------------------------------

/**
 * 参数键别名表：`canonical -> 后端可能用的所有键名`。
 *
 * 必须做这一层的原因：QwenPaw 系工具用 `old_text`/`new_text`，
 * DeepAgents 内置的 `edit_file` 用 `old_string`/`new_string`（已实测确认）。
 * 不归一化的话修改类卡片拿不到参数，只会退化成通用键值对罗列。
 */
export const PARAM_ALIASES: Record<string, readonly string[]> = {
  file_path: ["file_path", "path", "file", "filename", "filepath"],
  old_text: ["old_text", "old_string", "old_str", "search", "find"],
  new_text: ["new_text", "new_string", "new_str", "replace", "replacement"],
  content: ["content", "text", "contents", "data"],
  pattern: ["pattern", "query", "regex", "keyword"],
  command: ["command", "cmd", "script"],
  path: ["path", "directory", "dir", "directory_path"],
};

/** 单个键的别名解析（按别名表顺序，第一个存在的胜出）。 */
export function pickParam(
  params: Record<string, unknown>,
  canonical: string
): unknown {
  const keys = PARAM_ALIASES[canonical] ?? [canonical];
  for (const key of keys) {
    const value = params[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/**
 * 归一化整份参数：为每个别名组补上 canonical 键。
 * 原有键全部保留，避免兜底卡片丢失信息。
 */
export function normalizeParams(
  params: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  const input = params ?? {};
  const out: Record<string, unknown> = { ...input };
  for (const canonical of Object.keys(PARAM_ALIASES)) {
    if (out[canonical] !== undefined) continue;
    const value = pickParam(input, canonical);
    if (value !== undefined) out[canonical] = value;
  }
  return out;
}

/** 取字符串参数，缺失时返回空串。 */
export function paramString(
  params: Record<string, unknown>,
  canonical: string
): string {
  const value = params[canonical] ?? pickParam(params, canonical);
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

// ---------------------------------------------------------------------------
// 纯展示工具函数
// ---------------------------------------------------------------------------

export function countLines(text: string): number {
  if (text === "") return 0;
  return text.split("\n").length;
}

/** 结果转文本：字符串原样，其它 JSON 化。 */
export function stringifyResult(result: unknown): string {
  if (result === undefined || result === null) return "";
  if (typeof result === "string") return result;
  if (typeof result === "number" || typeof result === "boolean") {
    return String(result);
  }
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

/**
 * 结果里可能包着 `{"content":[{"type":"text","text":"..."}]}` 这类包装，
 * 展示前先把纯文本抽出来，避免用户看到一堆结构噪音。
 */
export function extractResultText(result: unknown): string {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const obj = result as Record<string, unknown>;
    const content = obj.content;
    if (Array.isArray(content)) {
      const joined = content
        .map((block) => {
          if (typeof block === "string") return block;
          if (block && typeof block === "object" && "text" in block) {
            const text = (block as { text?: unknown }).text;
            return typeof text === "string" ? text : "";
          }
          return "";
        })
        .join("");
      if (joined.trim() !== "") return joined;
    }
  }
  return stringifyResult(result);
}

const LANGUAGE_BY_EXT: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  cpp: "cpp",
  cc: "cpp",
  h: "c",
  c: "c",
  cs: "csharp",
  php: "php",
  swift: "swift",
  scala: "scala",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  json: "json",
  jsonc: "json",
  xml: "xml",
  html: "html",
  css: "css",
  scss: "scss",
  sass: "sass",
  less: "less",
  sql: "sql",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ini: "ini",
  md: "markdown",
  markdown: "markdown",
};

/** 按扩展名给出语法高亮语言；未知返回空串（由 DefaultBlock 自行探测）。 */
export function getFileLanguage(path: string): string {
  const name = path.split("/").pop() ?? path;
  if (!name.includes(".")) {
    const lower = name.toLowerCase();
    if (lower === "dockerfile") return "dockerfile";
    if (lower === "makefile") return "makefile";
    return "";
  }
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return LANGUAGE_BY_EXT[ext] ?? "";
}

/** 取文件名末尾一段（用于标题过长时的 tooltip）。 */
export function shortFileName(path: string): string {
  if (!path) return "";
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** 摘要行里的单行化：压掉换行、按长度截断。 */
export function oneLine(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max)}…`;
}