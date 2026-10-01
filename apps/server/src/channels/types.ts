/**
 * 频道的数据模型与字段类型系统（tasks 13.1–13.3）。
 *
 * 参考 QwenPaw `console/src/api/types/channel.ts` 的 `BaseChannelConfig` + 各频道 Config，
 * 但把「字段」提升为一等公民：**界面按字段定义自动渲染表单**，而不是每个频道手写一套表单。
 * 这样以后加频道只加数据、不用改页面（对齐 specs/channels「频道配置字段」）。
 */

/** 字段控件类型。界面按它决定渲染什么。 */
export type ChannelFieldType = "text" | "password" | "number" | "switch" | "select";

export interface ChannelFieldOption {
  value: string;
  label: string;
}

export interface ChannelFieldDef {
  key: string;
  /** 中文标签（界面展示） */
  label: string;
  type: ChannelFieldType;
  /** 必填（缺失时不允许启用） */
  required?: boolean;
  /**
   * 是否凭据类字段：值为敏感信息 —— **不落 agent 定义目录，落独立的凭据库，
   * 且对外读取一律掩码**（对齐 specs/channels「凭据与工作区、与 agent 定义都分离」）。
   */
  secret?: boolean;
  /** 默认值（未配置时用） */
  default?: string | number | boolean;
  /** select 的候选项 */
  options?: ChannelFieldOption[];
  /** 数字范围 */
  min?: number;
  max?: number;
  /** 给用户看的说明 */
  help?: string;
}

export interface ChannelCatalogEntry {
  key: string;
  /** 默认展示名（界面可再按语言覆盖） */
  label: string;
  /** 内置频道还是自定义频道 */
  builtin: boolean;
  /** 图标标识（前端映射到具体图标组件） */
  icon?: string;
  fields: ChannelFieldDef[];
  /** 该频道支持扫码换取凭据 */
  qrcode?: boolean;
}

/** 一个频道实例（某个 agent 上配置的一个频道） */
export interface ChannelInstance {
  key: string;
  enabled: boolean;
  /** **非敏感**配置值；凭据类字段不在这里 */
  config: Record<string, string | number | boolean>;
  updatedAt: string;
}

export interface ChannelsFile {
  version: 1;
  updatedAt: string;
  channels: ChannelInstance[];
}

/** 频道的运行健康（tasks 13.8）。 */
export type ChannelHealth = "disconnected" | "connecting" | "connected" | "error";

export interface ChannelRuntimeStatus {
  key: string;
  enabled: boolean;
  health: ChannelHealth;
  /** 最近一次收到或发出消息的时间 */
  lastActivityAt: string | null;
  /** 失败原因（health === "error" 时给用户看） */
  lastError?: string;
}

/**
 * 所有频道共用的字段（照 QwenPaw 的 `BaseChannelConfig` 取对本地助手有意义的部分）。
 * 顺序即界面上的渲染顺序。
 */
export const COMMON_CHANNEL_FIELDS: readonly ChannelFieldDef[] = [
  {
    key: "bot_prefix",
    label: "回复前缀",
    type: "text",
    default: "",
    help: "每条回复前面加一段固定文字，用于在群里区分是助手说的。留空则不加。",
  },
  {
    key: "show_thinking",
    label: "展示思考过程",
    type: "switch",
    default: false,
    help: "开启后把模型的思考过程也发到频道里。默认关闭，避免刷屏。",
  },
  {
    key: "show_tool_calls",
    label: "展示工具调用",
    type: "switch",
    default: true,
    help: "把「调用了哪个工具」显示在回复里。",
  },
  {
    key: "show_tool_results",
    label: "展示工具结果",
    type: "switch",
    default: true,
    help: "把工具返回的内容也显示出来。",
  },
  {
    key: "tool_call_max_length",
    label: "工具调用最长长度",
    type: "number",
    default: 500,
    min: 50,
    max: 20000,
    help: "超过就截断，避免一条回复过长被平台拒收。",
  },
  {
    key: "tool_result_max_length",
    label: "工具结果最长长度",
    type: "number",
    default: 1500,
    min: 50,
    max: 20000,
    help: "同上。",
  },
  {
    key: "dm_policy",
    label: "私聊策略",
    type: "select",
    default: "open",
    options: [
      { value: "open", label: "所有人可对话" },
      { value: "allowlist", label: "仅名单内" },
    ],
    help: "「仅名单内」时，陌生人会被挂起等待你在频道页里裁决。",
  },
  {
    key: "group_policy",
    label: "群聊策略",
    type: "select",
    default: "allowlist",
    options: [
      { value: "open", label: "所有群可用" },
      { value: "allowlist", label: "仅名单内的群" },
    ],
  },
  {
    key: "require_mention",
    label: "群里需要先提及我才响应",
    type: "switch",
    default: true,
    help: "开启后群消息必须先 @ 助手才会被处理，避免群里每句话都触发。",
  },
  {
    key: "streaming_enabled",
    label: "流式回复",
    type: "switch",
    default: false,
    help: "开启后边生成边更新消息。平台不支持时会自动退化为只发最终结果。",
  },
] as const;

/** 把公共字段与频道特有字段拼成完整字段表（特有字段在前，公共在后） */
export function withCommonFields(specific: readonly ChannelFieldDef[]): ChannelFieldDef[] {
  return [...specific, ...COMMON_CHANNEL_FIELDS];
}

/** 取某频道的默认配置值（仅非敏感字段） */
export function defaultConfigFor(entry: ChannelCatalogEntry): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const field of entry.fields) {
    if (field.secret) continue;
    if (field.default !== undefined) out[field.key] = field.default;
  }
  return out;
}

/** 从字段表里挑出凭据类字段 */
export function secretFieldsOf(entry: ChannelCatalogEntry): ChannelFieldDef[] {
  return entry.fields.filter((f) => f.secret === true);
}