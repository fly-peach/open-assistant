/**
 * 频道配置的存取（tasks 13.4、13.6、13.7）与字段校验（tasks 13.2、13.3）。
 *
 * 存放位置：**`<agents 根>/<agent-id>/channels.json`** —— 频道归属 agent 定义（design D13），
 * 所以配置跟着 agent 走，换绑工作区不带走它。凭据不在这里（见 `secrets.ts`）。
 *
 * 校验在**保存时**做，而不是运行期才炸：非法取值当场拒绝并指出字段（对齐 specs/channels
 * 「无效取值被拒且指出字段」）。
 */
import path from "node:path";
import fs from "node:fs/promises";

import { writeJsonAtomic } from "../agents/json-file.js";
import { channelCatalogEntry } from "./catalog.js";
import type {
  ChannelCatalogEntry,
  ChannelFieldDef,
  ChannelInstance,
  ChannelsFile,
} from "./types.js";
import { defaultConfigFor } from "./types.js";

export const CHANNELS_FILE = "channels.json";

export class ChannelError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly field?: string,
  ) {
    super(message);
    this.name = "ChannelError";
  }
}

export function channelsPath(agentDir: string): string {
  return path.join(path.resolve(agentDir), CHANNELS_FILE);
}

function emptyFile(now = new Date().toISOString()): ChannelsFile {
  return { version: 1, updatedAt: now, channels: [] };
}

/**
 * 读频道配置。文件不存在 → 空（视为「这个 agent 没接任何频道」）；
 * **内容损坏 → 报错而不当成空**（否则下一次写入会把用户配置覆盖掉）。
 */
export async function readChannelsFile(agentDir: string): Promise<ChannelsFile> {
  const file = channelsPath(agentDir);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return emptyFile();
  }
  if (raw.trim().length === 0) return emptyFile();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ChannelError(
      "CHANNELS_FILE_CORRUPT",
      `频道配置不是合法 JSON，已拒绝读取以免覆盖你的配置：${file}（${(err as Error).message}）`,
      422,
    );
  }
  const obj = parsed as Partial<ChannelsFile>;
  if (!obj || typeof obj !== "object" || !Array.isArray(obj.channels)) {
    throw new ChannelError(
      "CHANNELS_FILE_CORRUPT",
      `频道配置结构不对（缺少 channels 数组），已拒绝读取以免覆盖你的配置：${file}`,
      422,
    );
  }
  return {
    version: 1,
    updatedAt: typeof obj.updatedAt === "string" ? obj.updatedAt : new Date().toISOString(),
    channels: obj.channels as ChannelInstance[],
  };
}

export async function writeChannelsFile(agentDir: string, file: ChannelsFile): Promise<void> {
  await fs.mkdir(path.resolve(agentDir), { recursive: true });
  await writeJsonAtomic(channelsPath(agentDir), { ...file, version: 1 });
}

export function findChannel(file: ChannelsFile, key: string): ChannelInstance | undefined {
  return file.channels.find((c) => c.key === key);
}

// —— 字段校验 ——

export interface ValidatedInput {
  /** 非敏感值（可直接落 channels.json） */
  config: Record<string, string | number | boolean>;
  /** 凭据（调用方写入 secrets 存储，**不落这里**） */
  secrets: Record<string, string>;
}

function coerceField(field: ChannelFieldDef, value: unknown): string | number | boolean {
  switch (field.type) {
    case "switch": {
      if (typeof value === "boolean") return value;
      if (value === "true") return true;
      if (value === "false") return false;
      throw new ChannelError("CHANNEL_INVALID_FIELD", `「${field.label}」必须是 true 或 false`, 400, field.key);
    }
    case "number": {
      const n = typeof value === "number" ? value : Number(String(value ?? "").trim());
      if (!Number.isFinite(n)) {
        throw new ChannelError("CHANNEL_INVALID_FIELD", `「${field.label}」必须是数字`, 400, field.key);
      }
      if (field.min !== undefined && n < field.min) {
        throw new ChannelError("CHANNEL_INVALID_FIELD", `「${field.label}」不能小于 ${field.min}`, 400, field.key);
      }
      if (field.max !== undefined && n > field.max) {
        throw new ChannelError("CHANNEL_INVALID_FIELD", `「${field.label}」不能大于 ${field.max}`, 400, field.key);
      }
      return n;
    }
    case "select": {
      const s = String(value ?? "").trim();
      const allowed = (field.options ?? []).map((o) => o.value);
      if (allowed.length > 0 && !allowed.includes(s)) {
        throw new ChannelError(
          "CHANNEL_INVALID_FIELD",
          `「${field.label}」只能是 ${allowed.join(" / ")}（收到 ${JSON.stringify(s)}）`,
          400,
          field.key,
        );
      }
      return s;
    }
    default: {
      // text / password：凭据保留原文（含首尾空格可能有意），非凭据 trim
      const s = String(value ?? "");
      return field.secret ? s : s.trim();
    }
  }
}

/**
 * 校验并拆分配置输入（tasks 13.2 / 13.3 / 13.7）。
 *
 * - 字段表**之外的键被忽略**（不给未来字段挖坑）
 * - 凭据字段进 `secrets`；空串表示「清除该凭据」
 * - `requireSecrets` 为真时（启用前）必填凭据缺失 → 拒绝并指出字段
 */
export function validateChannelInput(
  entry: ChannelCatalogEntry,
  input: Record<string, unknown>,
  options: { requireSecrets?: boolean; existingSecrets?: Record<string, string> } = {},
): ValidatedInput {
  const config: Record<string, string | number | boolean> = {};
  const secrets: Record<string, string> = {};
  const existing = options.existingSecrets ?? {};

  for (const field of entry.fields) {
    const provided = Object.prototype.hasOwnProperty.call(input, field.key);
    const raw = provided ? input[field.key] : undefined;

    if (field.secret) {
      if (!provided) continue; // 没传 = 不动原值
      const value = coerceField(field, raw) as string;
      if (field.required && options.requireSecrets && value.length === 0 && !existing[field.key]) {
        throw new ChannelError("CHANNEL_MISSING_FIELD", `「${field.label}」是必填凭据，不能为空`, 400, field.key);
      }
      secrets[field.key] = value;
      continue;
    }

    if (!provided) {
      // 未提供：用默认值（如果还没有既有的值）
      if (field.default !== undefined) config[field.key] = field.default;
      continue;
    }
    config[field.key] = coerceField(field, raw);
  }

  // 启用前：必填的**非凭据**字段也要在
  if (options.requireSecrets) {
    for (const field of entry.fields) {
      if (field.secret || !field.required) continue;
      const value = config[field.key];
      if (value === undefined || String(value).trim().length === 0) {
        throw new ChannelError("CHANNEL_MISSING_FIELD", `「${field.label}」是必填项，不能为空`, 400, field.key);
      }
    }
    for (const field of entry.fields) {
      if (!field.secret || !field.required) continue;
      const incoming = secrets[field.key];
      const effective = incoming !== undefined ? incoming : (existing[field.key] ?? "");
      if (effective.trim().length === 0) {
        throw new ChannelError("CHANNEL_MISSING_FIELD", `「${field.label}」是必填凭据，不能为空`, 400, field.key);
      }
    }
  }

  return { config, secrets };
}

/**
 * 新建/更新一个频道实例。凭据由调用方写入独立凭据库（本函数不碰凭据文件）。
 */
export async function upsertChannel(
  agentDir: string,
  key: string,
  patch: { enabled?: boolean; input?: Record<string, unknown>; existingSecrets?: Record<string, string> },
): Promise<{ instance: ChannelInstance; secrets: Record<string, string>; validated: ValidatedInput }> {
  const entry = channelCatalogEntry(key);
  const file = await readChannelsFile(agentDir);
  const current = findChannel(file, key);
  const nextEnabled = patch.enabled ?? current?.enabled ?? false;

  const validated = validateChannelInput(entry, patch.input ?? {}, {
    requireSecrets: nextEnabled,
    existingSecrets: patch.existingSecrets,
  });

  const merged: Record<string, string | number | boolean> = {
    ...defaultConfigFor(entry),
    ...(current?.config ?? {}),
    ...validated.config,
  };

  const instance: ChannelInstance = {
    key,
    enabled: nextEnabled,
    config: merged,
    updatedAt: new Date().toISOString(),
  };

  const others = file.channels.filter((c) => c.key !== key);
  await writeChannelsFile(agentDir, {
    version: 1,
    updatedAt: instance.updatedAt,
    channels: [...others, instance].sort((a, b) => a.key.localeCompare(b.key)),
  });

  return { instance, secrets: validated.secrets, validated };
}

/** 删除一个频道实例（凭据由调用方另行清理） */
export async function removeChannel(agentDir: string, key: string): Promise<boolean> {
  const file = await readChannelsFile(agentDir);
  const next = file.channels.filter((c) => c.key !== key);
  if (next.length === file.channels.length) return false;
  await writeChannelsFile(agentDir, { version: 1, updatedAt: new Date().toISOString(), channels: next });
  return true;
}