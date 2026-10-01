/**
 * 频道目录：已知频道的键、名称、图标、是否内置、字段定义（tasks 13.1–13.3）。
 *
 * 首发两个频道：**QQ** 与 **飞书**。字段取自 QwenPaw 的 `QQConfig` / `FeishuConfig`
 * （`console/src/api/types/channel.ts`），只保留对本地助手有意义的部分。
 *
 * 目录之外的频道键**不被拒绝**：按 kebab 键生成可读名并给一组空字段，
 * 使插件式频道仍能加载（对齐 specs/channels「目录之外的频道不被拒绝」）。
 */
import {
  COMMON_CHANNEL_FIELDS,
  withCommonFields,
  type ChannelCatalogEntry,
  type ChannelFieldDef,
} from "./types.js";

/** QQ：WebSocket 收事件 + HTTP API 回消息（出站长连接，不需要公网入口） */
const QQ_FIELDS: readonly ChannelFieldDef[] = [
  {
    key: "app_id",
    label: "应用标识 AppID",
    type: "text",
    required: true,
    help: "QQ 开放平台机器人页面里的 AppID。",
  },
  {
    key: "client_secret",
    label: "客户端密钥",
    type: "password",
    required: true,
    secret: true,
    help: "QQ 开放平台里的 AppSecret。只保存在本机凭据库里，不会写进工作区。",
  },
  {
    key: "ack_message",
    label: "收到消息时的确认话术",
    type: "text",
    default: "收到，正在处理…",
    help: "QQ 平台要求在限定时间内先回一条，否则判超时。",
  },
];

/** 飞书：lark 长连接收事件 + Open API 发消息（同为出站连接） */
const FEISHU_FIELDS: readonly ChannelFieldDef[] = [
  {
    key: "app_id",
    label: "应用标识 App ID",
    type: "text",
    required: true,
    help: "飞书开放平台应用的 App ID（cli_ 开头）。",
  },
  {
    key: "app_secret",
    label: "应用密钥 App Secret",
    type: "password",
    required: true,
    secret: true,
    help: "飞书开放平台应用的 App Secret。只保存在本机凭据库里。",
  },
  {
    key: "domain",
    label: "服务域名",
    type: "select",
    default: "feishu",
    options: [
      { value: "feishu", label: "飞书（中国）" },
      { value: "lark", label: "Lark（国际）" },
    ],
    help: "按你的租户所在地选择。",
  },
  {
    key: "encrypt_key",
    label: "事件加密密钥",
    type: "password",
    secret: true,
    help: "仅在使用 Webhook 方式接入时需要。用长连接（默认）可留空。",
  },
  {
    key: "verification_token",
    label: "事件校验 Token",
    type: "password",
    secret: true,
    help: "同上，仅 Webhook 方式需要。",
  },
  {
    key: "media_dir",
    label: "媒体存放目录",
    type: "text",
    default: "media",
    help: "接收到的图片与文件在工作区内的存放目录（相对工作区根）。",
  },
];

const BUILTIN_CATALOG: readonly ChannelCatalogEntry[] = [
  {
    key: "qq",
    label: "QQ",
    builtin: true,
    icon: "qq",
    qrcode: true,
    fields: withCommonFields(QQ_FIELDS),
  },
  {
    key: "feishu",
    label: "飞书",
    builtin: true,
    icon: "feishu",
    qrcode: true,
    fields: withCommonFields(FEISHU_FIELDS),
  },
] as const;

/** kebab / snake 键 → 可读名（目录外频道用） */
export function humanizeChannelKey(key: string): string {
  return String(key ?? "")
    .split(/[-_]/)
    .filter((w) => w.length > 0)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** 内置频道目录（顺序即界面「可添加」分区的顺序） */
export function builtinChannels(): ChannelCatalogEntry[] {
  return BUILTIN_CATALOG.map((e) => ({ ...e, fields: [...e.fields] }));
}

/** 已知频道的键 */
export function builtinChannelKeys(): string[] {
  return BUILTIN_CATALOG.map((e) => e.key);
}

/** 取一个频道定义；目录之外 → 生成一个**只有公共字段**的条目（不报错） */
export function channelCatalogEntry(key: string): ChannelCatalogEntry {
  const found = BUILTIN_CATALOG.find((e) => e.key === key);
  if (found) return { ...found, fields: [...found.fields] };
  return {
    key,
    label: humanizeChannelKey(key) || key,
    builtin: false,
    fields: [...COMMON_CHANNEL_FIELDS],
  };
}

/** 该频道是否内置（供界面标「内置 / 自定义」） */
export function isBuiltinChannel(key: string): boolean {
  return BUILTIN_CATALOG.some((e) => e.key === key);
}