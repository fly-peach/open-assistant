/**
 * `models.json` 的读写：供应商配置 + 能力位缓存。
 *
 * ## 位置与安全
 *
 * 默认 `<用户主目录>/.open-assistant/models.json`，可用 `OPEN_ASSISTANT_MODELS_FILE` 覆盖
 * （测试与多实例部署用）。**不放工作区** —— 供应商 apiKey 是凭据，
 * 而工作区是用户随手就能 `ls` 的普通目录（对齐 workspace spec「敏感信息与工作区分离」）。
 *
 * 写盘一律走 `writeJsonAtomic`（同目录临时文件 + fsync + rename），
 * 所以读到的永远是完整 JSON，不会撞上半截文件。文件权限在 Unix 下收到 0600。
 *
 * ## 首次播种
 *
 * 文件不存在时，用「环境变量 + 内置预置」拼一份出来：
 * 三家内置供应商各自从一个环境变量读 key（`DEEPSEEK_API_KEY` / `ALI_TOKENPLAN_API_KEY`
 * 或项目老变量 `MODEL_API_KEY` / `DASHSCOPE_API_KEY`），并把 `MODEL_BASE_URL` / `MODEL_ID`
 * 认成 ali-tokenplan 的默认模型。这样老用户升级上来是**零迁移**：原来能跑的配置继续能跑。
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import { writeJsonAtomic, readJsonOrNull, statOrNull } from "../agents/json-file.js";
import { BUILTIN_PROVIDERS, CUSTOM_PROVIDER_PREFIX, builtinProvider } from "./catalog.js";
import { ModelError } from "./errors.js";
import type { ModelsFile, ProviderRecord, ProviderKind } from "./types.js";

/** 覆盖 `models.json` 路径的环境变量 */
export const MODELS_FILE_ENV = "OPEN_ASSISTANT_MODELS_FILE";

/** `models.json` 的默认路径 */
export function defaultModelsFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(os.homedir(), ".open-assistant", "models.json");
}

export function modelsFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env[MODELS_FILE_ENV]?.trim();
  return raw && raw.length > 0 ? path.resolve(raw) : defaultModelsFilePath(env);
}

/**
 * 供应商标识：字母数字开头，可含 `-` `_` `.`，≤48 字符。
 * 不带路径分隔符 / 空白 / `..` —— 它同时会出现在 HTTP 路径与前端查询串里。
 */
export function isValidProviderId(id: unknown): id is string {
  if (typeof id !== "string") return false;
  if (id.length === 0 || id.length > 48) return false;
  if (id.trim() !== id) return false;
  if (/\s/.test(id)) return false;
  if (id.includes("..")) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id);
}

/** 读取某个供应商预设可用的环境变量 key（记录里没填时兜底） */
function envApiKey(presetId: string, env: NodeJS.ProcessEnv): string {
  const preset = builtinProvider(presetId);
  if (!preset) return "";
  for (const name of preset.envKeys) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return "";
}

/**
 * 从环境变量播种内置供应商。
 *
 * baseUrl 也认环境变量：ali-tokenplan 用 `MODEL_BASE_URL`（项目老变量），
 * 其余供应商可用 `<ID 大写>_BASE_URL` 覆盖，方便自建网关。
 */
function seedProvider(presetId: string, env: NodeJS.ProcessEnv): ProviderRecord {
  const preset = builtinProvider(presetId)!;
  const envBaseUrlName = `${presetId.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}_BASE_URL`;
  const envBaseUrl = env[envBaseUrlName]?.trim();
  const baseUrl =
    presetId === "ali-tokenplan" && env["MODEL_BASE_URL"]?.trim()
      ? env["MODEL_BASE_URL"]!.trim()
      : envBaseUrl && envBaseUrl.length > 0
        ? envBaseUrl
        : preset.defaultBaseUrl;
  const now = new Date().toISOString();
  return {
    id: preset.id,
    kind: preset.kind,
    name: preset.name,
    baseUrl,
    apiKey: envApiKey(preset.id, env),
    enabled: true,
    models: [],
    createdAt: now,
    updatedAt: now,
  };
}

/** 播种整份文件（内置三家 + 老环境变量认出的默认模型） */
export function seedModelsFile(env: NodeJS.ProcessEnv = process.env): ModelsFile {
  const providers = BUILTIN_PROVIDERS.map((preset) => seedProvider(preset.id, env));
  const file: ModelsFile = { version: 1, providers, capabilities: {} };
  const legacyModel = env["MODEL_ID"]?.trim();
  if (legacyModel) {
    // 老配置只有「模型 id + baseUrl」，认到与之 baseUrl 相同的供应商名下
    const owner =
      providers.find((p) => p.baseUrl === env["MODEL_BASE_URL"]?.trim()) ??
      providers.find((p) => p.kind === "ali-tokenplan")!;
    file.defaultProviderId = owner.id;
    file.defaultModelId = legacyModel;
    if (!owner.models.includes(legacyModel)) owner.models.push(legacyModel);
  }
  return file;
}

/** 归一化读到的文件（缺字段补默认，脏数据不整体崩） */
export function normalizeModelsFile(raw: unknown): ModelsFile {
  const record = (raw ?? {}) as Record<string, unknown>;
  const providersRaw = Array.isArray(record["providers"]) ? (record["providers"] as unknown[]) : [];
  const providers: ProviderRecord[] = [];
  for (const item of providersRaw) {
    const p = (item ?? {}) as Record<string, unknown>;
    const id = typeof p["id"] === "string" ? p["id"] : "";
    if (!isValidProviderId(id)) continue;
    const kind = (typeof p["kind"] === "string" ? p["kind"] : "custom") as ProviderKind;
    providers.push({
      id,
      kind,
      name: typeof p["name"] === "string" && p["name"].trim() ? p["name"].trim() : id,
      baseUrl: typeof p["baseUrl"] === "string" ? p["baseUrl"].trim() : "",
      apiKey: typeof p["apiKey"] === "string" ? p["apiKey"] : "",
      enabled: p["enabled"] !== false,
      models: Array.isArray(p["models"])
        ? (p["models"] as unknown[]).filter((m): m is string => typeof m === "string" && m.trim().length > 0)
        : [],
      ...(p["headers"] && typeof p["headers"] === "object" && !Array.isArray(p["headers"])
        ? { headers: p["headers"] as Record<string, string> }
        : {}),
      createdAt: typeof p["createdAt"] === "string" ? p["createdAt"] : new Date().toISOString(),
      updatedAt: typeof p["updatedAt"] === "string" ? p["updatedAt"] : new Date().toISOString(),
    });
  }
  // 内置供应商缺一个就补上（用户手删过文件也不会失去三个入口）
  for (const preset of BUILTIN_PROVIDERS) {
    if (!providers.some((p) => p.id === preset.id)) providers.push(seedProvider(preset.id, process.env));
  }
  const capabilities =
    record["capabilities"] && typeof record["capabilities"] === "object"
      ? (record["capabilities"] as ModelsFile["capabilities"])
      : {};
  const file: ModelsFile = { version: 1, providers, capabilities };
  if (typeof record["defaultProviderId"] === "string") file.defaultProviderId = record["defaultProviderId"];
  if (typeof record["defaultModelId"] === "string") file.defaultModelId = record["defaultModelId"];
  return file;
}

/** 读取配置；文件不存在 → 播种并落盘（只播一次） */
export async function readModelsFile(env: NodeJS.ProcessEnv = process.env): Promise<ModelsFile> {
  const file = modelsFilePath(env);
  const exists = await statOrNull(file);
  if (!exists) {
    const seeded = seedModelsFile(env);
    await writeModelsFile(seeded, env);
    return seeded;
  }
  const raw = await readJsonOrNull(file, (err) => {
    throw new ModelError("MODEL_INVALID_CONFIG", `${file} 无法解析：${err.message}`, 500, "models.json");
  });
  return normalizeModelsFile(raw);
}

/** 原子写回；顺带把权限收到 0600（里面是凭据） */
export async function writeModelsFile(
  next: ModelsFile,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const file = modelsFilePath(env);
  await writeJsonAtomic(file, next);
  if (process.platform !== "win32") {
    await fs.chmod(file, 0o600).catch(() => undefined);
  }
}

/**
 * 掩码：只保留头尾各 4 个字符。
 * 短 key 一律整段打码 —— 「sk-1」这种短串露出 4 个头就等于全露。
 */
export function maskApiKey(key: string): string {
  if (!key) return "";
  if (key.length <= 12) return "*".repeat(key.length);
  return `${key.slice(0, 4)}${"*".repeat(Math.min(8, key.length - 8))}${key.slice(-4)}`;
}

/** 供应商真正可用的 key：记录里的优先，没有则回落环境变量（不写回磁盘） */
export function providerApiKey(provider: ProviderRecord, env: NodeJS.ProcessEnv = process.env): string {
  if (provider.apiKey.trim()) return provider.apiKey.trim();
  return envApiKey(provider.id, env);
}

/** 找一个供应商；不存在 → 404 */
export function findProvider(file: ModelsFile, id: string): ProviderRecord {
  const found = file.providers.find((p) => p.id === id);
  if (!found) {
    throw new ModelError("MODEL_PROVIDER_NOT_FOUND", `找不到供应商：${id}`, 404, "providerId");
  }
  return found;
}

/** 下一个可用的自定义供应商标识（`custom-1`、`custom-2` …） */
export function nextCustomProviderId(file: ModelsFile): string {
  let n = 1;
  const taken = new Set(file.providers.map((p) => p.id));
  while (taken.has(`${CUSTOM_PROVIDER_PREFIX}${n}`)) n += 1;
  return `${CUSTOM_PROVIDER_PREFIX}${n}`;
}
