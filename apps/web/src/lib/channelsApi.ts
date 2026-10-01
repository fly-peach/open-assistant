/**
 * 频道 HTTP 客户端（agent 级）。
 *
 * 频道归属 **agent 定义**（design D13），所以接口挂在 `/agents/{id}/channels` 下，
 * 配置界面就长在「智能体 → 打开配置」那一页里（而不是另开一个工作区级页面）。
 *
 * - `GET    /agents/{id}/channels`           → 已配置 + 可添加 + 每个频道的字段定义
 * - `PUT    /agents/{id}/channels/{key}`     → 新建/更新（可同时传 config 与 secrets）
 * - `DELETE /agents/{id}/channels/{key}`     → 删除（会一并清掉凭据）
 *
 * 凭据**只回掩码**：`secrets[key]` 是 `"已设置（…abcd）"` 或空串。
 * 提交时传空串表示「清除该凭据」，不传表示「不动原值」。
 */
import { request } from "@/lib/workspaceApi";

export type ChannelFieldType = "text" | "password" | "number" | "switch" | "select";

export interface ChannelField {
  key: string;
  label: string;
  type: ChannelFieldType;
  required?: boolean;
  secret?: boolean;
  default?: string | number | boolean;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  help?: string;
}

export interface ChannelView {
  key: string;
  label: string;
  builtin: boolean;
  icon?: string;
  qrcode?: boolean;
  enabled: boolean;
  config: Record<string, string | number | boolean>;
  /** 凭据字段 → 掩码文本（空串 = 未设置） */
  secrets: Record<string, string>;
  /** 必填但缺失的字段 key（非空时不能启用） */
  missing: string[];
  updatedAt: string | null;
}

export interface ChannelList {
  agentId: string;
  configured: ChannelView[];
  available: ChannelView[];
  /** 频道键 → 字段定义；界面按它自动渲染表单 */
  fields: Record<string, ChannelField[]>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function normalizeView(raw: unknown): ChannelView | null {
  const record = asRecord(raw);
  const key = typeof record["key"] === "string" ? record["key"] : null;
  if (!key) return null;
  const config = asRecord(record["config"]);
  const secretsRaw = asRecord(record["secrets"]);
  const secrets: Record<string, string> = {};
  for (const [k, v] of Object.entries(secretsRaw)) if (typeof v === "string") secrets[k] = v;
  const missing = Array.isArray(record["missing"])
    ? (record["missing"] as unknown[]).filter((m): m is string => typeof m === "string")
    : [];
  const configOut: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(config)) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") configOut[k] = v;
  }
  return {
    key,
    label: typeof record["label"] === "string" ? record["label"] : key,
    builtin: record["builtin"] === true,
    ...(typeof record["icon"] === "string" ? { icon: record["icon"] } : {}),
    ...(record["qrcode"] === true ? { qrcode: true } : {}),
    enabled: record["enabled"] === true,
    config: configOut,
    secrets,
    missing,
    updatedAt: typeof record["updatedAt"] === "string" ? record["updatedAt"] : null,
  };
}

function normalizeFields(raw: unknown): Record<string, ChannelField[]> {
  const out: Record<string, ChannelField[]> = {};
  for (const [key, value] of Object.entries(asRecord(raw))) {
    if (!Array.isArray(value)) continue;
    out[key] = value.filter((f): f is ChannelField => {
      const r = asRecord(f);
      return typeof r["key"] === "string" && typeof r["label"] === "string";
    }) as ChannelField[];
  }
  return out;
}

export async function listAgentChannels(agentId: string): Promise<ChannelList> {
  const raw = await request<unknown>(`/agents/${encodeURIComponent(agentId)}/channels`);
  const record = asRecord(raw);
  const configured = Array.isArray(record["configured"])
    ? (record["configured"] as unknown[]).map(normalizeView).filter((v): v is ChannelView => v !== null)
    : [];
  const available = Array.isArray(record["available"])
    ? (record["available"] as unknown[]).map(normalizeView).filter((v): v is ChannelView => v !== null)
    : [];
  return {
    agentId: typeof record["agentId"] === "string" ? record["agentId"] : agentId,
    configured,
    available,
    fields: normalizeFields(record["fields"]),
  };
}

export async function saveAgentChannel(
  agentId: string,
  key: string,
  payload: {
    enabled?: boolean;
    config?: Record<string, string | number | boolean>;
    secrets?: Record<string, string>;
  },
): Promise<ChannelView> {
  const raw = await request<unknown>(`/agents/${encodeURIComponent(agentId)}/channels/${encodeURIComponent(key)}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
  const view = normalizeView(asRecord(raw)["channel"]);
  if (!view) throw new Error("保存频道后返回的结构不可识别");
  return view;
}

export async function deleteAgentChannel(agentId: string, key: string): Promise<void> {
  await request<unknown>(`/agents/${encodeURIComponent(agentId)}/channels/${encodeURIComponent(key)}`, {
    method: "DELETE",
  });
}