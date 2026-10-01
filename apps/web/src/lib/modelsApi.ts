/**
 * 模型配置 HTTP 客户端（对齐后端 `apps/server/src/models/index.ts` 暴露的端点）。
 *
 * - `GET    /models`                          总览：供应商（key 掩码）+ 可选模型 + 全局默认
 * - `POST   /models/providers`                新建 / 更新供应商
 * - `DELETE /models/providers/{id}`           删除（内置三家不可删 → 409）
 * - `POST   /models/providers/{id}/discover`  拉远端清单（只读）
 * - `POST   /models/providers/{id}/models`    加入手工清单
 * - `POST   /models/providers/{id}/test`      连通性测试
 * - `PUT    /models/default`                  设全局默认
 * - `POST   /models/capability/probe`         跑视觉探针
 * - `PUT    /models/capability`               手动指定能力位
 * - `DELETE /models/capability`               清掉能力位
 * - `GET    /models/selection?path=`          该工作区这轮会用的模型
 * - `PUT    /models/selection`                写入绑定 agent 的 config.json
 *
 * 安全：**apiKey 明文只进不出**。这里读到的 key 一律是掩码；
 * 保存时只提交用户新输入的 key（不填就不提交，后端据此判断「不改」）。
 */
import { request, WorkspaceApiError } from "@/lib/workspaceApi";

export { WorkspaceApiError };

export type ProviderKind = "deepseek" | "ali-tokenplan" | "aliyun" | "custom";
export type ModelSource = "catalog" | "remote" | "manual";
export type CapabilitySource = "manual" | "probe" | "catalog" | "unknown";

export interface ProviderView {
  id: string;
  kind: ProviderKind;
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

export interface ModelView {
  providerId: string;
  providerName: string;
  providerKind: ProviderKind;
  id: string;
  name: string;
  source: ModelSource;
  /** null = 未知（未探测且清单里没写） */
  vision: boolean | null;
  visionSource: CapabilitySource;
  probedAt?: string;
}

export interface ModelsOverview {
  providers: ProviderView[];
  models: ModelView[];
  defaults: { providerId: string | null; modelId: string | null };
}

export interface DiscoverResult {
  ok: boolean;
  models: string[];
  added: string[];
  error?: string;
}

export interface TestResult {
  ok: boolean;
  modelId: string;
  latencyMs: number;
  reply?: string;
  error?: string;
}

export interface ProbeAttempt {
  color: string;
  answer?: string;
  error?: string;
  correct: boolean;
}

export interface ProbeOutcome {
  vision: boolean | null;
  correct: number;
  answered: number;
  attempts: ProbeAttempt[];
  reason: string;
  providerId: string;
  modelId: string;
  persisted: boolean;
}

export interface SelectionView {
  workspace: string;
  agentId: string;
  agentName: string;
  configured: { providerId: string | null; modelId: string } | null;
  effective: {
    providerId: string;
    providerName: string;
    modelId: string;
    modelName: string;
    baseUrl: string;
    vision: boolean | null;
    origin: "agent" | "default" | "env";
  } | null;
}

/* ---------------------------------------------------------------- 归一化 */

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asBool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function normalizeProviders(raw: unknown): ProviderView[] {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .map((item) => {
      const record = asRecord(item);
      const id = asString(record.id);
      if (!id) return null;
      const provider: ProviderView = {
        id,
        kind: (asString(record.kind) ?? "custom") as ProviderKind,
        name: asString(record.name) ?? id,
        baseUrl: asString(record.baseUrl) ?? "",
        enabled: record.enabled !== false,
        models: Array.isArray(record.models)
          ? record.models.filter((m): m is string => typeof m === "string")
          : [],
        apiKeyMasked: asString(record.apiKeyMasked) ?? "",
        hasApiKey: record.hasApiKey === true,
        removable: record.removable !== false,
        kindHint: asString(record.kindHint) ?? "",
        updatedAt: asString(record.updatedAt) ?? "",
      };
      return provider;
    })
    .filter((p): p is ProviderView => p !== null);
}

function normalizeModels(raw: unknown): ModelView[] {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .map((item) => {
      const record = asRecord(item);
      const id = asString(record.id);
      const providerId = asString(record.providerId);
      if (!id || !providerId) return null;
      const model: ModelView = {
        providerId,
        providerName: asString(record.providerName) ?? providerId,
        providerKind: (asString(record.providerKind) ?? "custom") as ProviderKind,
        id,
        name: asString(record.name) ?? id,
        source: (asString(record.source) ?? "manual") as ModelSource,
        vision: asBool(record.vision),
        visionSource: (asString(record.visionSource) ?? "unknown") as CapabilitySource,
      };
      const probedAt = asString(record.probedAt);
      if (probedAt) model.probedAt = probedAt;
      return model;
    })
    .filter((m): m is ModelView => m !== null);
}

export function normalizeOverview(raw: unknown): ModelsOverview {
  const record = asRecord(raw);
  const defaults = asRecord(record.defaults);
  return {
    providers: normalizeProviders(record.providers),
    models: normalizeModels(record.models),
    defaults: {
      providerId: asString(defaults.providerId) ?? null,
      modelId: asString(defaults.modelId) ?? null,
    },
  };
}

export function normalizeSelection(raw: unknown): SelectionView {
  const record = asRecord(raw);
  const configured = asRecord(record.configured);
  const effective = asRecord(record.effective);
  const view: SelectionView = {
    workspace: asString(record.workspace) ?? "",
    agentId: asString(record.agentId) ?? "",
    agentName: asString(record.agentName) ?? "",
    configured:
      Object.keys(configured).length > 0
        ? { providerId: asString(configured.providerId) ?? null, modelId: asString(configured.modelId) ?? "" }
        : null,
    effective: null,
  };
  const modelId = asString(effective.modelId);
  if (modelId) {
    view.effective = {
      providerId: asString(effective.providerId) ?? "",
      providerName: asString(effective.providerName) ?? "",
      modelId,
      modelName: asString(effective.modelName) ?? modelId,
      baseUrl: asString(effective.baseUrl) ?? "",
      vision: asBool(effective.vision),
      origin: (asString(effective.origin) ?? "default") as "agent" | "default" | "env",
    };
  }
  return view;
}

/* ------------------------------------------------------------------ 端点 */

export function getModels(): Promise<ModelsOverview> {
  return request<unknown>("/models").then(normalizeOverview);
}

export interface UpsertProviderInput {
  id?: string;
  kind?: ProviderKind;
  name?: string;
  baseUrl?: string;
  /** 只在用户输入了新 key 时带上；不传 = 不改，空串 = 清空 */
  apiKey?: string;
  enabled?: boolean;
  models?: string[];
}

export function upsertProvider(input: UpsertProviderInput): Promise<void> {
  return request<unknown>("/models/providers", {
    method: "POST",
    body: JSON.stringify(input),
  }).then(() => undefined);
}

export function deleteProvider(id: string): Promise<void> {
  return request<unknown>(`/models/providers/${encodeURIComponent(id)}`, { method: "DELETE" }).then(
    () => undefined
  );
}

export function discoverModels(id: string): Promise<DiscoverResult> {
  return request<DiscoverResult>(`/models/providers/${encodeURIComponent(id)}/discover`, {
    method: "POST",
  });
}

export function addProviderModels(id: string, models: string[]): Promise<void> {
  return request<unknown>(`/models/providers/${encodeURIComponent(id)}/models`, {
    method: "POST",
    body: JSON.stringify({ models }),
  }).then(() => undefined);
}

export function testProvider(id: string, modelId?: string): Promise<TestResult> {
  return request<TestResult>(`/models/providers/${encodeURIComponent(id)}/test`, {
    method: "POST",
    body: JSON.stringify(modelId ? { modelId } : {}),
  });
}

export function setDefaultModel(providerId: string, modelId: string): Promise<void> {
  return request<unknown>("/models/default", {
    method: "PUT",
    body: JSON.stringify({ providerId, modelId }),
  }).then(() => undefined);
}

export function probeCapability(providerId: string, modelId: string): Promise<ProbeOutcome> {
  return request<ProbeOutcome>("/models/capability/probe", {
    method: "POST",
    body: JSON.stringify({ providerId, modelId }),
  });
}

export function setCapability(
  providerId: string,
  modelId: string,
  vision: boolean
): Promise<void> {
  return request<unknown>("/models/capability", {
    method: "PUT",
    body: JSON.stringify({ providerId, modelId, vision }),
  }).then(() => undefined);
}

export function clearCapability(providerId: string, modelId: string): Promise<void> {
  return request<unknown>("/models/capability", {
    method: "DELETE",
    body: JSON.stringify({ providerId, modelId }),
  }).then(() => undefined);
}

export function getSelection(workspace: string): Promise<SelectionView> {
  return request<unknown>(`/models/selection?path=${encodeURIComponent(workspace)}`).then(
    normalizeSelection
  );
}

export function putSelection(
  workspace: string,
  providerId: string,
  modelId: string
): Promise<SelectionView> {
  return request<unknown>("/models/selection", {
    method: "PUT",
    body: JSON.stringify({ path: workspace, providerId, modelId }),
  }).then(normalizeSelection);
}

/* ------------------------------------------------------------ 展示辅助 */

/** 供应商类型的中文短名（配置页徽标用） */
export const PROVIDER_KIND_LABEL: Record<ProviderKind, string> = {
  deepseek: "DeepSeek",
  "ali-tokenplan": "Token Plan",
  aliyun: "阿里云百炼",
  custom: "自定义",
};

export const MODEL_SOURCE_LABEL: Record<ModelSource, string> = {
  catalog: "内置清单",
  remote: "远端发现",
  manual: "手工补充",
};

export const CAPABILITY_SOURCE_LABEL: Record<CapabilitySource, string> = {
  manual: "手动指定",
  probe: "探测结论",
  catalog: "内置清单",
  unknown: "未知",
};

/** 「供应商:id」合成键：塞进 Radix Select 的 value（id 里可能有冒号吗？不会有） */
export function modelKey(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`;
}

/**
 * 在总览里查一个模型（找不到返回 `null`）。
 *
 * `providerId` 为空的旧配置只按 id 反查 —— 同名模型可能命中多个供应商，
 * 这时**不猜**，返回 `null` 让调用方退回显示原始 id。
 */
export function findModel(
  overview: ModelsOverview | undefined,
  providerId: string | null | undefined,
  modelId: string
): ModelView | null {
  const models = overview?.models ?? [];
  if (providerId) {
    return models.find((m) => m.providerId === providerId && m.id === modelId) ?? null;
  }
  const matches = models.filter((m) => m.id === modelId);
  return matches.length === 1 ? matches[0]! : null;
}

export function parseModelKey(key: string): { providerId: string; modelId: string } | null {
  const index = key.indexOf("::");
  if (index <= 0) return null;
  return { providerId: key.slice(0, index), modelId: key.slice(index + 2) };
}
