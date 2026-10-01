/**
 * 模型解析：把「配置数据」翻译成「这一轮该用哪个模型 / 有哪些模型可选」。
 *
 * ## 三层回退（谁说话算数）
 *
 * ```
 * 1. agent 配置（config.json 的 model）      ← 运行身份以工作区绑定为准
 * 2. models.json 的全局默认（defaultProviderId / defaultModelId）
 * 3. 环境变量 MODEL_ID / MODEL_BASE_URL / MODEL_API_KEY   ← 老配置的兜底
 * ```
 *
 * 解析顺序必须在**运行期**做，不能在图构建时做：同一个后端进程要服务多个工作区，
 * 而每个工作区绑定的 agent 可能配了不同模型（见 `middleware.ts` 的用法）。
 *
 * ## 能力位从哪来
 *
 * `manual > probe > catalog > unknown`：
 * 用户手动指定的最硬（他可能知道我们不知道的事），其次是真探测出来的，
 * 最后才是内置清单的先验。三者都没有 → `null`（未知），界面显示「未知」而不是假装知道。
 */
import { readBinding } from "../binding.js";
import { resolveAgentRuntime } from "../agents/registry.js";
import { RobustChatOpenAI } from "../model.js";
import { ModelError } from "./errors.js";
import {
  BUILTIN_PROVIDERS,
  builtinModels,
  builtinProvider,
  PROVIDER_KIND_HINTS,
} from "./catalog.js";
import {
  findProvider,
  maskApiKey,
  readModelsFile,
  providerApiKey,
} from "./store.js";
import type {
  CapabilitySource,
  ModelView,
  ModelsFile,
  ProviderRecord,
  ResolvedModelConfig,
} from "./types.js";
import { capabilityKey } from "./types.js";

/** 配置页看到的供应商（apiKey 只给掩码；明文永远不出后端） */
export interface ProviderView {
  id: string;
  kind: ProviderRecord["kind"];
  name: string;
  baseUrl: string;
  enabled: boolean;
  models: string[];
  apiKeyMasked: string;
  hasApiKey: boolean;
  /** 内置三家不可删（只能改） */
  removable: boolean;
  kindHint: string;
  updatedAt: string;
}

export function toProviderView(provider: ProviderRecord): ProviderView {
  const key = providerApiKey(provider);
  return {
    id: provider.id,
    kind: provider.kind,
    name: provider.name,
    baseUrl: provider.baseUrl,
    enabled: provider.enabled,
    models: [...provider.models],
    apiKeyMasked: maskApiKey(key),
    hasApiKey: key.length > 0,
    removable: builtinProvider(provider.id)?.removable !== false,
    kindHint: PROVIDER_KIND_HINTS[provider.kind] ?? "",
    updatedAt: provider.updatedAt,
  };
}

/** 某个模型的视觉能力结论 + 结论来源 */
export interface CapabilityView {
  vision: boolean | null;
  source: CapabilitySource;
  probedAt?: string;
}

export function capabilityFor(file: ModelsFile, providerId: string, modelId: string): CapabilityView {
  const record = file.capabilities[capabilityKey(providerId, modelId)];
  if (record) {
    return {
      vision: record.vision,
      source: record.source,
      ...(record.updatedAt ? { probedAt: record.updatedAt } : {}),
    };
  }
  const builtin = builtinModels(providerId).find((m) => m.id === modelId);
  if (builtin && builtin.vision !== null) {
    return { vision: builtin.vision, source: "catalog" };
  }
  return { vision: null, source: "unknown" };
}

/**
 * 列出可选模型：内置参考清单 ∪ 用户手工补充（∪ 可选远端清单）。
 *
 * `remoteProviderIds` 由 HTTP 层在「用户点了刷新」时传入（远端拉取要几秒，
 * 不该让每次打开配置页都等它）。
 */
export function listModelViews(file: ModelsFile, remote?: Map<string, string[]>): ModelView[] {
  const views: ModelView[] = [];
  for (const provider of file.providers) {
    if (!provider.enabled) continue;
    const seen = new Set<string>();
    const push = (id: string, source: ModelView["source"], name?: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      const capability = capabilityFor(file, provider.id, id);
      const builtinName = builtinModels(provider.id).find((m) => m.id === id)?.name;
      views.push({
        providerId: provider.id,
        providerName: provider.name,
        providerKind: provider.kind,
        id,
        name: name ?? builtinName ?? id,
        source,
        vision: capability.vision,
        visionSource: capability.source,
        ...(capability.probedAt ? { probedAt: capability.probedAt } : {}),
      });
    };
    for (const model of builtinModels(provider.id)) push(model.id, "catalog");
    for (const model of provider.models) push(model, "manual");
    for (const model of remote?.get(provider.id) ?? []) push(model, "remote");
  }
  return views;
}

/** 老配置 `{ id, baseUrl }` 按 baseUrl 反查供应商 */
function providerByBaseUrl(file: ModelsFile, baseUrl: string | undefined): ProviderRecord | undefined {
  if (!baseUrl) return undefined;
  const normalized = baseUrl.replace(/\/+$/, "");
  return file.providers.find((p) => p.baseUrl.replace(/\/+$/, "") === normalized);
}

function envFallback(): ResolvedModelConfig | null {
  const modelId = process.env["MODEL_ID"]?.trim();
  const baseUrl = process.env["MODEL_BASE_URL"]?.trim();
  const apiKey = process.env["MODEL_API_KEY"]?.trim();
  if (!modelId || !baseUrl) return null;
  return {
    providerId: "env",
    providerName: "环境变量",
    modelId,
    baseUrl,
    apiKey: apiKey ?? "",
    vision: null,
    origin: "env",
  };
}

/**
 * 算出某个工作区这一轮真正要用的模型。
 *
 * 运行身份**只认工作区绑定**（`<工作区>/.open-assistant/project.json`），
 * 客户端传什么都无效 —— 否则可以拿 A 工作区的钥匙用 B agent 的模型计费。
 */
export async function resolveEffectiveModel(
  workspaceDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedModelConfig | null> {
  const file = await readModelsFile(env);
  const binding = await readBinding(workspaceDir);

  if (binding) {
    const runtime = await resolveAgentRuntime(binding.activeAgentId);
    const configured = runtime.config.model;
    if (configured) {
      const provider =
        (configured.providerId ? file.providers.find((p) => p.id === configured.providerId) : undefined) ??
        providerByBaseUrl(file, configured.baseUrl);
      const explicit =
        file.providers.find((p) => p.id === configured.providerId) ??
        (file.defaultProviderId ? file.providers.find((p) => p.id === file.defaultProviderId) : undefined);
      const owner = provider ?? explicit;
      if (owner && owner.enabled) {
        const capability = capabilityFor(file, owner.id, configured.id);
        return {
          providerId: owner.id,
          providerName: owner.name,
          modelId: configured.id,
          baseUrl: configured.baseUrl?.trim() || owner.baseUrl,
          apiKey: providerApiKey(owner, env),
          vision: capability.vision,
          origin: "agent",
        };
      }
    }
  }

  if (file.defaultProviderId && file.defaultModelId) {
    const owner = file.providers.find((p) => p.id === file.defaultProviderId);
    if (owner && owner.enabled) {
      const capability = capabilityFor(file, owner.id, file.defaultModelId);
      return {
        providerId: owner.id,
        providerName: owner.name,
        modelId: file.defaultModelId,
        baseUrl: owner.baseUrl,
        apiKey: providerApiKey(owner, env),
        vision: capability.vision,
        origin: "default",
      };
    }
  }

  return envFallback();
}

/**
 * 解析失败要拒绝对话（而不是悄悄用兜底模型）：
 * 「用户以为在用 A 模型、实际跑的是 B」是比报错更难查的问题。
 */
export function requireReady(resolved: ResolvedModelConfig | null): ResolvedModelConfig {
  if (!resolved) {
    throw new ModelError(
      "MODEL_NOT_CONFIGURED",
      "尚未配置可用模型：请到「设置 → 模型」里填好供应商的 API Key，或在 agent 配置里选一个模型",
      409,
    );
  }
  if (!resolved.apiKey) {
    throw new ModelError(
      "MODEL_NOT_CONFIGURED",
      `供应商「${resolved.providerName}」还没填 API Key：请到「设置 → 模型」里补上`,
      409,
      "apiKey",
    );
  }
  if (!resolved.baseUrl) {
    throw new ModelError(
      "MODEL_INVALID_CONFIG",
      `供应商「${resolved.providerName}」缺少 baseUrl`,
      409,
      "baseUrl",
    );
  }
  return resolved;
}

/* ------------------------------------------------------------- 实例与缓存 */

/**
 * 模型实例缓存。
 *
 * 为什么要缓存：LangChain 的 ChatModel 实例每次新建都会重新解析配置、重建
 * 内部 http client，而它**是无状态的**（对话状态在 graph 的 checkpoint 里），
 * 所以同一组 (baseUrl, model, key) 复用同一个实例是安全的。
 * 键里带上 key 的尾部片段：换了 key 要换实例，否则会拿旧凭据继续发请求。
 */
const modelCache = new Map<string, RobustChatOpenAI>();

export function buildChatModel(resolved: ResolvedModelConfig): RobustChatOpenAI {
  const key = `${resolved.baseUrl}|${resolved.modelId}|${resolved.apiKey.slice(-6)}`;
  const cached = modelCache.get(key);
  if (cached) return cached;
  const model = new RobustChatOpenAI({
    model: resolved.modelId,
    apiKey: resolved.apiKey,
    temperature: 0,
    configuration: { baseURL: resolved.baseUrl },
  });
  modelCache.set(key, model);
  return model;
}

/** 清空模型实例缓存（测试用） */
export function clearModelCache(): void {
  modelCache.clear();
}

/** 供配置页展示：这个供应商下有没有一个模型都拿不出来 */
export function providerRequiresKey(provider: ProviderRecord): boolean {
  return providerApiKey(provider).length === 0;
}
