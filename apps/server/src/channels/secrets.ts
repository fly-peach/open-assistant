/**
 * 频道凭据库（tasks 13.5–13.6）。
 *
 * ## 为什么独立成一个文件、而且放在这里
 *
 * 凭据**既不能落工作区，也不能落 agent 定义目录**：
 * - 工作区会被用户整个复制/分享给别人（对齐 specs/workspace「敏感信息与工作区分离」）
 * - agent 定义目录同样会被复制/分享（**复制 agent 定义做副本**时甚至会被用来生成第二份实例）
 *
 * 所以统一放 `<用户主目录>/.open-assistant/channel-secrets.json`，
 * 按 `(agentId, 频道键)` 索引 —— 与 models 层放供应商 apiKey 的做法一致。
 *
 * ## 对外一律掩码
 * 任何读接口都不得返回明文；`maskSecret` 只给出「是否已设置」与尾部几位。
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import { writeJsonAtomic } from "../agents/json-file.js";

/** 覆盖凭据库路径的环境变量 */
export const CHANNEL_SECRETS_ENV = "OPEN_ASSISTANT_CHANNEL_SECRETS_FILE";
/** 用户主目录下的应用数据目录名（与 models.json 同级） */
export const APP_DATA_DIRNAME = ".open-assistant";
export const CHANNEL_SECRETS_FILENAME = "channel-secrets.json";

export interface ChannelSecretsFile {
  version: 1;
  updatedAt: string;
  /** agentId → 频道键 → 字段名 → 明文 */
  entries: Record<string, Record<string, Record<string, string>>>;
}

function emptyFile(now = new Date().toISOString()): ChannelSecretsFile {
  return { version: 1, updatedAt: now, entries: {} };
}

/** 凭据库绝对路径（可用环境变量覆盖，便于测试隔离） */
export function channelSecretsPath(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env[CHANNEL_SECRETS_ENV]?.trim();
  if (raw && raw.length > 0) return path.resolve(raw);
  return path.join(os.homedir(), APP_DATA_DIRNAME, CHANNEL_SECRETS_FILENAME);
}

/** 读凭据库；不存在或损坏 → 空（不报错、不阻断） */
export async function readSecretsFile(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ChannelSecretsFile> {
  try {
    const raw = await fs.readFile(channelSecretsPath(env), "utf8");
    const parsed = JSON.parse(raw) as ChannelSecretsFile;
    if (parsed && typeof parsed === "object" && parsed.entries && typeof parsed.entries === "object") {
      return parsed;
    }
  } catch {
    /* 不存在 / 坏了 → 空 */
  }
  return emptyFile();
}

/** 取某个 agent 某个频道的凭据（明文，**只在服务端使用**） */
export async function readChannelSecrets(
  agentId: string,
  channelKey: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, string>> {
  const file = await readSecretsFile(env);
  return { ...(file.entries[agentId]?.[channelKey] ?? {}) };
}

/**
 * 合并写入凭据：只覆盖传入的键，其余保留。
 * 传空串表示**清除该字段**（用户主动清空）。
 */
export async function writeChannelSecrets(
  agentId: string,
  channelKey: string,
  values: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const file = await readSecretsFile(env);
  const forAgent = { ...(file.entries[agentId] ?? {}) };
  const current = { ...(forAgent[channelKey] ?? {}) };
  for (const [k, v] of Object.entries(values)) {
    if (typeof v !== "string") continue;
    if (v.length === 0) delete current[k];
    else current[k] = v;
  }
  if (Object.keys(current).length === 0) delete forAgent[channelKey];
  else forAgent[channelKey] = current;

  if (Object.keys(forAgent).length === 0) delete file.entries[agentId];
  else file.entries[agentId] = forAgent;

  file.updatedAt = new Date().toISOString();
  await writeJsonAtomic(channelSecretsPath(env), file);
}

/** 清掉某频道（或整个 agent）的凭据 —— 删除频道/agent 时调用 */
export async function clearChannelSecrets(
  agentId: string,
  channelKey?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const file = await readSecretsFile(env);
  if (channelKey) {
    const forAgent = { ...(file.entries[agentId] ?? {}) };
    delete forAgent[channelKey];
    if (Object.keys(forAgent).length === 0) delete file.entries[agentId];
    else file.entries[agentId] = forAgent;
  } else {
    delete file.entries[agentId];
  }
  file.updatedAt = new Date().toISOString();
  await writeJsonAtomic(channelSecretsPath(env), file);
}

/** 该字段是否已有值 */
export function hasSecret(values: Record<string, string>, field: string): boolean {
  const v = values[field];
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * 掩码：只暴露尾部 4 位，便于用户确认「填的是哪一个」而不泄露明文。
 * 短值一律显示「已设置」，不暴露长度。
 */
export function maskSecret(value: string): string {
  const v = String(value ?? "");
  if (v.length === 0) return "";
  if (v.length <= 8) return "已设置";
  return `已设置（…${v.slice(-4)}）`;
}

/**
 * 生成给界面/接口用的**掩码配置**：所有凭据字段只回"已设置/未设置"。
 * 传入的 `config` 只含非敏感值；凭据单独从 `secrets` 判断。
 */
export function maskedSecretsView(
  secretFieldKeys: readonly string[],
  secrets: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of secretFieldKeys) {
    out[key] = hasSecret(secrets, key) ? maskSecret(secrets[key]!) : "";
  }
  return out;
}