/**
 * 模型配置层的对外服务（HTTP 层只调这里，不直接碰 store / probe）。
 *
 * 分工：
 * - `store.ts` 管「怎么存」；`probe.ts` 管「怎么测」；`resolve.ts` 管「这轮用哪个」；
 * - 本文件管**业务动作**：改供应商、拉远端清单、测连通、跑探测、设默认、写选中项。
 *
 * 所有写动作都遵循同一套规矩：
 * - 改完**立刻失效**相关缓存（模型解析缓存 1s TTL、agent 运行实例缓存），
 *   避免「改完配置下一轮还是老模型」这种最难查的错；
 * - 凭据明文**只进不出**（返回给前端的永远是掩码）。
 */
import { updateAgent, resolveAgentRuntime } from "../agents/registry.js";
import { AgentError } from "../agents/errors.js";
import { readBinding } from "../binding.js";
import { chatCompletion, listRemoteModels, normalizeBaseUrl } from "./client.js";
import { assertBaseUrl } from "./client.js";
import { builtinModels, builtinProvider } from "./catalog.js";
import { ModelError } from "./errors.js";
import { invalidateModelResolution } from "./middleware.js";
import { PROBE_MAX_FAILURES, probeVision, type VisionProbeResult } from "./probe.js";
import {
  capabilityFor,
  listModelViews,
  resolveEffectiveModel,
  toProviderView,
  type CapabilityView,
  type ProviderView,
} from "./resolve.js";
import {
  findProvider,
  isValidProviderId,
  maskApiKey,
  nextCustomProviderId,
  providerApiKey,
  readModelsFile,
  writeModelsFile,
} from "./store.js";
import { capabilityKey, type ModelsFile, type ProviderKind, type ProviderRecord } from "./types.js";

/** 前端回传掩码时不要把它当新 key 写进去 */
function isMasked(value: string): boolean {
  return value.includes("*");
}

async function save(file: ModelsFile): Promise<void> {
  await writeModelsFile(file);
  invalidateModelResolution();
}

/* ------------------------------------------------------------------ 读 */

export interface ModelsOverview {
  providers: ProviderView[];
  models: ReturnType<typeof listModelViews>;
  defaults: { providerId: string | null; modelId: string | null };
}

export async function getOverview(): Promise<ModelsOverview> {
  const file = await readModelsFile();
  return {
    providers: file.providers.map(toProviderView),
    models: listModelViews(file),
    defaults: {
      providerId: file.defaultProviderId ?? null,
      modelId: file.defaultModelId ?? null,
    },
  };
}

/* ------------------------------------------------------- 供应商增改删 */

export interface UpsertProviderInput {
  id?: unknown;
  kind?: unknown;
  name?: unknown;
  baseUrl?: unknown;
  /** 缺省 = 不改；空串 = 清空；含 `*` = 前端把掩码回传了，忽略 */
  apiKey?: unknown;
  enabled?: unknown;
  models?: unknown;
}

const PROVIDER_KINDS: ProviderKind[] = ["deepseek", "ali-tokenplan", "aliyun", "custom"];

function normalizeModelIds(raw: unknown, field: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new ModelError("MODEL_INVALID_CONFIG", `${field} 必须是字符串数组`, 400, field);
  }
  const ids: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new ModelError("MODEL_INVALID_CONFIG", `${field} 含非法模型 id（必须是非空字符串）`, 400, field);
    }
    if (/\s/.test(item.trim())) {
      throw new ModelError("MODEL_INVALID_CONFIG", `${field} 里的模型 id 不能含空白：${item}`, 400, field);
    }
    if (!ids.includes(item.trim())) ids.push(item.trim());
  }
  return ids;
}

/** 新建或更新一个供应商 */
export async function upsertProvider(input: UpsertProviderInput): Promise<ProviderView> {
  const file = await readModelsFile();
  const now = new Date().toISOString();

  let provider: ProviderRecord | undefined;
  if (input.id !== undefined) {
    if (!isValidProviderId(input.id)) {
      throw new ModelError(
        "MODEL_INVALID_PROVIDER_ID",
        `非法供应商标识 ${JSON.stringify(input.id)}：字母数字开头，可含 - _ .，不超过 48 字符`,
        400,
        "id",
      );
    }
    provider = file.providers.find((p) => p.id === input.id);
  }

  if (!provider) {
    const id = input.id !== undefined ? (input.id as string) : nextCustomProviderId(file);
    const kind = typeof input.kind === "string" ? (input.kind as ProviderKind) : "custom";
    if (!PROVIDER_KINDS.includes(kind)) {
      throw new ModelError("MODEL_INVALID_CONFIG", `未知的供应商类型：${kind}`, 400, "kind");
    }
    const preset = builtinProvider(id);
    provider = {
      id,
      kind: preset?.kind ?? kind,
      name: preset?.name ?? (typeof input.name === "string" && input.name.trim() ? input.name.trim() : id),
      baseUrl: preset?.defaultBaseUrl ?? "",
      apiKey: "",
      enabled: true,
      models: [],
      createdAt: now,
      updatedAt: now,
    };
    file.providers.push(provider);
  }

  const preset = builtinProvider(provider.id);
  if (input.name !== undefined) {
    if (typeof input.name !== "string" || input.name.trim().length === 0) {
      throw new ModelError("MODEL_INVALID_CONFIG", "name 必须是非空字符串", 400, "name");
    }
    provider.name = input.name.trim();
  }
  if (input.baseUrl !== undefined) {
    provider.baseUrl = input.baseUrl === "" ? "" : assertBaseUrl(input.baseUrl);
  }
  if (input.apiKey !== undefined) {
    if (typeof input.apiKey !== "string") {
      throw new ModelError("MODEL_INVALID_CONFIG", "apiKey 必须是字符串", 400, "apiKey");
    }
    if (!isMasked(input.apiKey)) provider.apiKey = input.apiKey.trim();
  }
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== "boolean") {
      throw new ModelError("MODEL_INVALID_CONFIG", "enabled 必须是布尔值", 400, "enabled");
    }
    provider.enabled = input.enabled;
  }
  if (input.models !== undefined) {
    provider.models = normalizeModelIds(input.models, "models");
  }
  if (input.kind !== undefined && !preset && typeof input.kind === "string") {
    const kind = input.kind as ProviderKind;
    if (!PROVIDER_KINDS.includes(kind)) {
      throw new ModelError("MODEL_INVALID_CONFIG", `未知的供应商类型：${kind}`, 400, "kind");
    }
    provider.kind = kind;
  }
  provider.updatedAt = now;

  await save(file);
  return toProviderView(provider);
}

/** 删除供应商（内置三家不可删） */
export async function deleteProvider(id: string): Promise<void> {
  const file = await readModelsFile();
  const provider = findProvider(file, id);
  if (builtinProvider(provider.id)?.removable === false) {
    throw new ModelError(
      "MODEL_PROVIDER_LOCKED",
      `「${provider.name}」是内置供应商，不能删除；可以关掉它（enabled=false）或在里面清空配置`,
      409,
      "id",
    );
  }
  file.providers = file.providers.filter((p) => p.id !== id);
  // 清掉它的能力缓存与默认指向，避免留下指向已删供应商的悬空默认
  for (const key of Object.keys(file.capabilities)) {
    if (key.startsWith(`${id}::`)) delete file.capabilities[key];
  }
  if (file.defaultProviderId === id) {
    delete file.defaultProviderId;
    delete file.defaultModelId;
  }
  await save(file);
}

/* ------------------------------------------------------------ 默认模型 */

export async function setDefaultModel(providerId: string, modelId: string): Promise<void> {
  const file = await readModelsFile();
  const provider = findProvider(file, providerId);
  if (!provider.enabled) {
    throw new ModelError("MODEL_INVALID_CONFIG", `供应商「${provider.name}」已停用`, 400, "providerId");
  }
  if (typeof modelId !== "string" || modelId.trim().length === 0) {
    throw new ModelError("MODEL_INVALID_CONFIG", "modelId 不能为空", 400, "modelId");
  }
  file.defaultProviderId = provider.id;
  file.defaultModelId = modelId.trim();
  await save(file);
}

/* ------------------------------------------------------ 远端模型发现 */

export interface DiscoverResult {
  ok: boolean;
  models: string[];
  /** 远端拉取失败时的原因（此时前端仍可看到内置清单 + 手工清单） */
  error?: string;
  /** 拉回来的 id 里有哪些不在清单中（前端提示「有几项可以补充」） */
  added: string[];
}

/**
 * 拉某个供应商的远端模型清单（`GET /models`）。
 *
 * 结果**只用于展示**，不写盘 —— 「刷新」是只读动作，
 * 用户看到感兴趣的再点「加入清单」，避免把供应商的几百个模型一次灌进来。
 */
export async function discoverModels(providerId: string): Promise<DiscoverResult> {
  const file = await readModelsFile();
  const provider = findProvider(file, providerId);
  const apiKey = providerApiKey(provider);
  if (!provider.baseUrl) {
    throw new ModelError("MODEL_INVALID_CONFIG", `供应商「${provider.name}」还没填 baseUrl`, 400, "baseUrl");
  }
  if (!apiKey) {
    throw new ModelError("MODEL_NOT_CONFIGURED", `供应商「${provider.name}」还没填 API Key`, 409, "apiKey");
  }
  const result = await listRemoteModels({
    baseUrl: provider.baseUrl,
    apiKey,
    ...(provider.headers ? { headers: provider.headers } : {}),
  });
  if (!result.ok) return { ok: false, models: [], added: [], error: result.error ?? "未知错误" };
  const known = new Set([
    ...builtinModels(provider.id).map((m) => m.id),
    ...provider.models,
  ]);
  return { ok: true, models: result.models, added: result.models.filter((m) => !known.has(m)) };
}

/** 把一批模型 id 加进供应商的手工清单（幂等） */
export async function addProviderModels(providerId: string, ids: string[]): Promise<ProviderView> {
  const file = await readModelsFile();
  const provider = findProvider(file, providerId);
  const incoming = normalizeModelIds(ids, "models");
  for (const id of incoming) {
    if (!provider.models.includes(id)) provider.models.push(id);
  }
  provider.updatedAt = new Date().toISOString();
  await save(file);
  return toProviderView(provider);
}

/* --------------------------------------------------------- 连通性测试 */

export interface TestResult {
  ok: boolean;
  /** 是否连通（能拿到一次正常回复） */
  modelId: string;
  latencyMs: number;
  reply?: string;
  error?: string;
}

/** 拿一次最小对话验证 baseUrl + key + 模型 id 三者配得对不对 */
export async function testProvider(providerId: string, modelId?: string): Promise<TestResult> {
  const file = await readModelsFile();
  const provider = findProvider(file, providerId);
  const apiKey = providerApiKey(provider);
  const target =
    modelId?.trim() ||
    provider.models[0] ||
    builtinModels(provider.id)[0]?.id ||
    "";
  if (!target) {
    throw new ModelError(
      "MODEL_INVALID_CONFIG",
      `供应商「${provider.name}」还没有可测试的模型：先填一个模型 id，或点「刷新远端清单」`,
      400,
      "modelId",
    );
  }
  if (!apiKey) {
    throw new ModelError("MODEL_NOT_CONFIGURED", `供应商「${provider.name}」还没填 API Key`, 409, "apiKey");
  }
  const started = Date.now();
  const result = await chatCompletion({
    baseUrl: provider.baseUrl,
    apiKey,
    model: target,
    messages: [{ role: "user", content: "ping" }],
    maxTokens: 16,
    timeoutMs: 20_000,
    ...(provider.headers ? { headers: provider.headers } : {}),
  });
  const latencyMs = Date.now() - started;
  if (!result.ok) {
    return { ok: false, modelId: target, latencyMs, ...(result.error ? { error: result.error } : {}) };
  }
  return { ok: true, modelId: target, latencyMs, reply: result.text.trim().slice(0, 200) };
}

/* ------------------------------------------------------------ 能力位 */

export interface ProbeOutcome extends VisionProbeResult {
  providerId: string;
  modelId: string;
  /** 结论是否写进了缓存（null 结论不写，避免把「没测出来」固化成「不支持」） */
  persisted: boolean;
}

/**
 * 跑一次视觉探测并落盘结论。
 *
 * 只有**有明确结论**（true/false）才写缓存：网络失败得到的 `null` 不写 ——
 * 否则一次网络抖动就会把模型永久标成「未知」，用户还得手动改回来。
 */
export async function probeModelCapability(
  providerId: string,
  modelId: string,
): Promise<ProbeOutcome> {
  const file = await readModelsFile();
  const provider = findProvider(file, providerId);
  const apiKey = providerApiKey(provider);
  if (!apiKey) {
    throw new ModelError("MODEL_NOT_CONFIGURED", `供应商「${provider.name}」还没填 API Key`, 409, "apiKey");
  }
  const result = await probeVision({
    baseUrl: provider.baseUrl,
    apiKey,
    model: modelId,
    ...(provider.headers ? { headers: provider.headers } : {}),
  });

  if (result.vision === null) {
    return { ...result, providerId, modelId, persisted: false };
  }

  const key = capabilityKey(providerId, modelId);
  const previous = file.capabilities[key];
  // 结论是「不支持」时记失败次数：连续多次失败后界面不再主动催探测（照搬 QwenPaw 的思路）
  const failures = result.vision ? 0 : (previous?.failures ?? 0) + 1;
  file.capabilities[key] = {
    vision: result.vision,
    source: "probe",
    failures,
    updatedAt: new Date().toISOString(),
  };
  await save(file);
  return { ...result, providerId, modelId, persisted: true };
}

/** 手动指定能力位（最高优先级，压过探测结论与内置清单） */
export async function setModelCapability(
  providerId: string,
  modelId: string,
  vision: boolean,
): Promise<CapabilityView> {
  const file = await readModelsFile();
  findProvider(file, providerId);
  file.capabilities[capabilityKey(providerId, modelId)] = {
    vision,
    source: "manual",
    failures: 0,
    updatedAt: new Date().toISOString(),
  };
  await save(file);
  return capabilityFor(file, providerId, modelId);
}

/** 清掉能力位（回到内置清单的先验 / 未知） */
export async function clearModelCapability(providerId: string, modelId: string): Promise<void> {
  const file = await readModelsFile();
  delete file.capabilities[capabilityKey(providerId, modelId)];
  await save(file);
}

/** 是否值得再自动探测（连续失败太多次就不再催） */
export function shouldSuggestProbe(file: ModelsFile, providerId: string, modelId: string): boolean {
  const record = file.capabilities[capabilityKey(providerId, modelId)];
  if (!record || record.source === "manual") return false;
  return record.failures < PROBE_MAX_FAILURES;
}

/* ------------------------------------------------- 工作区选中项（对话页用） */

export interface SelectionView {
  workspace: string;
  agentId: string;
  agentName: string;
  /** agent config.json 里写着的（可能为空 = 跟随全局默认） */
  configured: { providerId: string | null; modelId: string } | null;
  /** 这一轮真正会用到的 */
  effective: {
    providerId: string;
    providerName: string;
    modelId: string;
    /** 展示名（内置清单里的中文名，否则回落 id） */
    modelName: string;
    baseUrl: string;
    vision: boolean | null;
    origin: "agent" | "default" | "env";
  } | null;
}

/** 对话页顶部「模型」下拉需要的全部信息 */
export async function getSelection(workspacePath: string, normalizedWorkspace: string): Promise<SelectionView> {
  const binding = await readBinding(normalizedWorkspace);
  if (!binding) {
    throw new AgentError(
      "AGENT_NOT_BOUND",
      "此工作区尚未绑定 agent：请先在「工作区 → 选择 agent」里为它选一个 agent",
      409,
    );
  }
  const runtime = await resolveAgentRuntime(binding.agentId);
  const file = await readModelsFile();
  const resolved = await resolveEffectiveModel(normalizedWorkspace);
  const configured = runtime.config.model;
  const modelName = resolved
    ? (builtinModels(resolved.providerId).find((m) => m.id === resolved.modelId)?.name ?? resolved.modelId)
    : "";
  return {
    workspace: workspacePath,
    agentId: runtime.id,
    agentName: runtime.config.name,
    configured: configured
      ? { providerId: configured.providerId ?? null, modelId: configured.id }
      : null,
    effective: resolved
      ? {
          providerId: resolved.providerId,
          providerName: resolved.providerName,
          modelId: resolved.modelId,
          modelName,
          baseUrl: resolved.baseUrl,
          vision: resolved.vision,
          origin: resolved.origin,
        }
      : null,
  };
}

/**
 * 把对话页选的模型写进**绑定 agent 的 config.json**。
 *
 * 为什么不写工作区文件：模型是 agent 的属性（同一 agent 在多个工作区里表现一致），
 * 且 agent 配置已经有 fingerprint 失效机制，改完下一轮自动生效。
 */
export async function setSelection(
  normalizedWorkspace: string,
  providerId: string,
  modelId: string,
): Promise<void> {
  const binding = await readBinding(normalizedWorkspace);
  if (!binding) {
    throw new AgentError(
      "AGENT_NOT_BOUND",
      "此工作区尚未绑定 agent：请先在「工作区 → 选择 agent」里为它选一个 agent",
      409,
    );
  }
  const file = await readModelsFile();
  const provider = findProvider(file, providerId);
  if (!provider.enabled) {
    throw new ModelError("MODEL_INVALID_CONFIG", `供应商「${provider.name}」已停用`, 400, "providerId");
  }
  if (typeof modelId !== "string" || modelId.trim().length === 0) {
    throw new ModelError("MODEL_INVALID_CONFIG", "modelId 不能为空", 400, "modelId");
  }
  await updateAgent(binding.agentId, {
    config: { model: { id: modelId.trim(), providerId: provider.id } },
  });
  invalidateModelResolution(normalizedWorkspace);
}

/** 导出给测试与脚本用的低层入口 */
export { readModelsFile, writeModelsFile, maskApiKey, normalizeBaseUrl, normalizeModelIds };
