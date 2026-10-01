/**
 * 模型配置层的类型（自定义供应商 / 模型 / 能力位）。
 *
 * ## 为什么要单独一层
 *
 * 改造前模型是**进程级常量**：`agent.ts` 在模块加载时用 `MODEL_ID / MODEL_BASE_URL /
 * MODEL_API_KEY` 三个环境变量 new 一个 `RobustChatOpenAI`，整张图共用。
 * 想换模型 = 改 `.env` + 重启，且每个 agent 的 `config.json` 里那个
 * `model: { id, baseUrl }` 字段**只写不读**（是死字段）。
 *
 * 现在把「用哪个模型」变成**运行期可解析的数据**：
 *
 *   provider（供应商：baseURL + apiKey + 名称）
 *     └── model（模型 id：来自内置参考清单 / 远端 /models / 手工补充）
 *           └── capability（能力位：vision 等，来源 手动 > 探测 > 内置清单）
 *
 * 解析顺序（谁说话算数）：**agent 配置 > 全局默认 > 环境变量兜底**。
 * 见 `resolve.ts` 的 `resolveEffectiveModel`。
 *
 * ## 凭据放哪
 *
 * 供应商的 apiKey 是凭据，**不落工作区**（对齐 workspace spec「敏感信息与工作区分离」）：
 * 存 `<用户主目录>/.open-assistant/models.json`，可用 `OPEN_ASSISTANT_MODELS_FILE` 覆盖。
 * 通过 HTTP 读出去时一律**掩码**（`maskApiKey`），前端拿不到明文。
 */
/** 供应商类型：三家内置 + 完全自定义 */
export type ProviderKind = "deepseek" | "ali-tokenplan" | "aliyun" | "custom";

/**
 * 一个供应商。内置三家（deepseek / ali-tokenplan / aliyun）由 `catalog.ts` 提供
 * `defaultBaseUrl`，用户只需填 key；`custom` 由用户自己填 baseUrl + key。
 */
export interface ProviderRecord {
  id: string;
  kind: ProviderKind;
  /** 展示名（可改；内置供应商给了默认中文名） */
  name: string;
  /** 与 OpenAI 兼容的 chat completions 端点（如 `https://api.deepseek.com/v1`） */
  baseUrl: string;
  /** 凭据；空串表示「还没配」，此时不参与可用模型列表 */
  apiKey: string;
  /** 关掉的供应商不进清单、不可选用（但配置保留，便于临时恢复） */
  enabled: boolean;
  /**
   * 手工补充的模型 id（远端 `/models` 拿不到或不想拉时用）。
   * 与内置参考清单、远端发现**取并集**，不是白名单 —— 用户填什么就能选什么。
   */
  models: string[];
  /** 额外请求头（少数网关需要，如自建代理的自定义鉴权头） */
  headers?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

/** 一个模型在清单里的样子（`source` 说明它是从哪来的，便于界面标注） */
export type ModelSource = "catalog" | "remote" | "manual";

export interface ModelView {
  providerId: string;
  providerName: string;
  providerKind: ProviderKind;
  id: string;
  /** 展示名（内置清单给了中文名；其余回落成 id） */
  name: string;
  source: ModelSource;
  /** 是否支持图像输入；null = 未知（需要探测或手工指定） */
  vision: boolean | null;
  /** 这个结论是谁给的：manual > probe > catalog > unknown */
  visionSource: CapabilitySource;
  /** 探针最后一次跑的时间（ISO），没探测过则缺省 */
  probedAt?: string;
}

/** 能力位的来源，优先级从高到低 */
export type CapabilitySource = "manual" | "probe" | "catalog" | "unknown";

/** 一个 (providerId, modelId) 的能力记录 */
export interface CapabilityRecord {
  /** null = 探到了但结论不确定（网络失败 / 模型答非所问），界面显示「未知」 */
  vision: boolean | null;
  source: Exclude<CapabilitySource, "unknown">;
  /** 连续探测失败次数：达到上限后不再自动重试（照搬 QwenPaw 的失败计数思路） */
  failures: number;
  updatedAt: string;
}

/** `models.json` 的整体结构 */
export interface ModelsFile {
  version: 1;
  providers: ProviderRecord[];
  /** 全局默认模型（agent 没配时用它）；undefined = 继续回落环境变量 */
  defaultProviderId?: string;
  defaultModelId?: string;
  /** 能力位缓存，键是 `${providerId}::${modelId}` */
  capabilities: Record<string, CapabilityRecord>;
}

/** 运行期真正要用的东西：怎么连、连哪个模型 */
export interface ResolvedModelConfig {
  providerId: string;
  providerName: string;
  modelId: string;
  baseUrl: string;
  apiKey: string;
  vision: boolean | null;
  /** 这个解析结果的来源，便于在界面上说明「为什么现在是它」 */
  origin: "agent" | "default" | "env";
}

/** 能力键（providerId + modelId 拼成一个字符串键） */
export function capabilityKey(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`;
}
