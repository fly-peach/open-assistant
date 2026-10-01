/**
 * 频道服务层（tasks 13.1–13.8 的组合视图）。
 *
 * HTTP 层与界面都只跟这里打交道，不直接碰 store / secrets：
 * - 把「配置（非敏感）」与「凭据（掩码）」合成一个可直接渲染的视图
 * - 算出**必填但缺失**的字段，让界面能解释「为什么这个频道还不能启用」
 * - 区分「已配置」与「可添加」两组（对齐频道界面的两分区）
 *
 * 归属（design D13）：频道属于 **agent 定义**，所以这里只按 `agentId + agentDir` 工作。
 */
import { builtinChannels, channelCatalogEntry } from "./catalog.js";
import {
  findChannel,
  readChannelsFile,
  removeChannel,
  upsertChannel,
} from "./store.js";
import {
  clearChannelSecrets,
  hasSecret,
  maskSecret,
  readChannelSecrets,
  writeChannelSecrets,
} from "./secrets.js";
import { defaultConfigFor, type ChannelFieldDef, type ChannelInstance } from "./types.js";

/** 给界面用的频道视图 */
export interface ChannelView {
  key: string;
  label: string;
  builtin: boolean;
  icon?: string;
  qrcode?: boolean;
  enabled: boolean;
  /** 非敏感配置（已补齐默认值） */
  config: Record<string, string | number | boolean>;
  /** 凭据字段 → 掩码文本（空串表示未设置） */
  secrets: Record<string, string>;
  /** 必填但缺失的字段 key（非空时不能启用；界面据此解释原因） */
  missing: string[];
  updatedAt: string | null;
}

export interface ChannelViews {
  /** 已配置的频道 */
  configured: ChannelView[];
  /** 目录里尚未添加的频道（可添加分区） */
  available: ChannelView[];
}

/** 该频道的字段表（含公共字段），界面按它渲染表单 */
export function channelFieldsFor(key: string): ChannelFieldDef[] {
  return channelCatalogEntry(key).fields;
}

/**
 * 算出必填但缺失的字段。
 * 非凭据看 `config`，凭据看凭据库（**不看掩码字符串**，否则永远判不出缺失）。
 */
export function missingRequiredFields(
  key: string,
  config: Record<string, unknown>,
  secrets: Record<string, string>,
): string[] {
  const entry = channelCatalogEntry(key);
  const missing: string[] = [];
  for (const field of entry.fields) {
    if (!field.required) continue;
    if (field.secret) {
      if (!hasSecret(secrets, field.key)) missing.push(field.key);
    } else {
      const value = config[field.key];
      if (value === undefined || String(value).trim().length === 0) missing.push(field.key);
    }
  }
  return missing;
}

function toView(
  key: string,
  instance: ChannelInstance | undefined,
  secrets: Record<string, string>,
): ChannelView {
  const entry = channelCatalogEntry(key);
  const config: Record<string, string | number | boolean> = {
    ...defaultConfigFor(entry),
    ...(instance?.config ?? {}),
  };
  const masked: Record<string, string> = {};
  for (const field of entry.fields) {
    if (!field.secret) continue;
    masked[field.key] = hasSecret(secrets, field.key) ? maskSecret(secrets[field.key]!) : "";
  }
  return {
    key,
    label: entry.label,
    builtin: entry.builtin,
    ...(entry.icon === undefined ? {} : { icon: entry.icon }),
    ...(entry.qrcode === undefined ? {} : { qrcode: entry.qrcode }),
    enabled: instance?.enabled ?? false,
    config,
    secrets: masked,
    missing: missingRequiredFields(key, config, secrets),
    updatedAt: instance?.updatedAt ?? null,
  };
}

/** 列出该 agent 的频道：已配置 + 目录里可添加的 */
export async function listChannelViews(
  agentId: string,
  agentDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ChannelViews> {
  const file = await readChannelsFile(agentDir);
  const configured: ChannelView[] = [];
  for (const instance of file.channels) {
    const secrets = await readChannelSecrets(agentId, instance.key, env);
    configured.push(toView(instance.key, instance, secrets));
  }
  configured.sort((a, b) => a.key.localeCompare(b.key));

  const configuredKeys = new Set(configured.map((c) => c.key));
  const available = builtinChannels()
    .filter((entry) => !configuredKeys.has(entry.key))
    .map((entry) => toView(entry.key, undefined, {}));

  return { configured, available };
}

/**
 * 新建或更新一个频道。
 * `patch.secrets` 里传空串表示**清除该凭据**；不传表示不动原值。
 */
export async function upsertChannelView(
  agentId: string,
  agentDir: string,
  key: string,
  patch: {
    enabled?: boolean;
    config?: Record<string, unknown>;
    secrets?: Record<string, string>;
  },
  env: NodeJS.ProcessEnv = process.env,
): Promise<ChannelView> {
  const stored = await readChannelSecrets(agentId, key, env);

  // ⚠️ 关键：把**本次请求里带的凭据**先并进"有效凭据"，再拿去校验。
  // 否则「填凭据 + 同时启用」这个界面上的最常见操作会被拒（校验看到的是库里原有的空值）。
  const effectiveSecrets: Record<string, string> = { ...stored };
  for (const [k, v] of Object.entries(patch.secrets ?? {})) {
    if (typeof v !== "string") continue;
    if (v.length === 0) delete effectiveSecrets[k];
    else effectiveSecrets[k] = v;
  }

  const { instance } = await upsertChannel(agentDir, key, {
    ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
    ...(patch.config === undefined ? {} : { input: patch.config }),
    existingSecrets: effectiveSecrets,
  });

  if (patch.secrets && Object.keys(patch.secrets).length > 0) {
    await writeChannelSecrets(agentId, key, patch.secrets, env);
  }

  const secrets = await readChannelSecrets(agentId, key, env);
  return toView(key, instance, secrets);
}

/** 删除频道，并清掉它的凭据（不留悬空凭据） */
export async function deleteChannelView(
  agentId: string,
  agentDir: string,
  key: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const removed = await removeChannel(agentDir, key);
  await clearChannelSecrets(agentId, key, env);
  return removed;
}

/**
 * 该 agent 上**启用了**的频道。
 * 供运行时使用：没有启用的频道就不该去连平台。
 */
export async function enabledChannels(
  agentId: string,
  agentDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ChannelInstance[]> {
  const file = await readChannelsFile(agentDir);
  const out: ChannelInstance[] = [];
  for (const instance of file.channels) {
    if (!instance.enabled) continue;
    // 启用时再兜一次必填校验：防的是「配置在启用后被人在文件里改坏」
    const secrets = await readChannelSecrets(agentId, instance.key, env);
    const missing = missingRequiredFields(instance.key, instance.config, secrets);
    if (missing.length > 0) continue;
    out.push(instance);
  }
  return out;
}

/** 便于调试：某个频道实例是否存在 */
export async function hasChannel(agentDir: string, key: string): Promise<boolean> {
  return findChannel(await readChannelsFile(agentDir), key) !== undefined;
}