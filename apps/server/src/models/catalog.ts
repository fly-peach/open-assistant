/**
 * 内置供应商预置 + 模型参考清单。
 *
 * ## 参考清单不是白名单
 *
 * `BUILTIN_MODELS` 只用来**填空**（用户不想等着拉 `/models` 时也有东西可选），
 * 真正的可选集合是 `内置清单 ∪ 远端 /models ∪ 用户手工补充`（见 `resolve.ts`）。
 * 所以这里漏了某个新模型不会「选不了」，只是要手动填一次。
 *
 * ## 视觉能力从哪来
 *
 * 清单里的 `vision` 是**静态先验**，优先级最低（manual > probe > catalog）。
 * 拿得准的写死（qwen-vl 系带视觉、deepseek 的 chat/reasoner 不带图像输入），
 * 拿不准的写 `null` —— `null` 在界面上是「未知」，点一下探测就有结论，
 * 绝不假装知道（写死一个错的 false 比写 null 更糟：用户会以为模型真的看不了图）。
 */
import type { ProviderKind } from "./types.js";

export interface BuiltinProviderPreset {
  id: string;
  kind: ProviderKind;
  name: string;
  /** 与 OpenAI 兼容的 chat completions 端点 */
  defaultBaseUrl: string;
  /** 该供应商的 API key 也可以从哪个环境变量读（记录里没填时的兜底） */
  envKeys: string[];
  /** 是否允许删除（内置三家是固定入口，只能改不能删） */
  removable: boolean;
}

/**
 * 三家内置供应商 —— 对应用户要的 deepseek / ali-tokenplan / aliyun，
 * 外加完全自定义的 `custom`（用户自建 baseUrl 时用）。
 */
export const BUILTIN_PROVIDERS: BuiltinProviderPreset[] = [
  {
    id: "deepseek",
    kind: "deepseek",
    name: "DeepSeek",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    envKeys: ["DEEPSEEK_API_KEY"],
    removable: false,
  },
  {
    id: "ali-tokenplan",
    kind: "ali-tokenplan",
    name: "阿里云 Token Plan",
    defaultBaseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    // 项目原本就是靠 MODEL_* 这三个环境变量跑的，保留为兜底，老用户零迁移
    envKeys: ["ALI_TOKENPLAN_API_KEY", "MODEL_API_KEY"],
    removable: false,
  },
  {
    id: "aliyun",
    kind: "aliyun",
    name: "阿里云百炼（DashScope 兼容模式）",
    defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    envKeys: ["DASHSCOPE_API_KEY", "BAILIAN_API_KEY"],
    removable: false,
  },
];

/** 自定义供应商的 id 前缀（`custom-1`、`custom-2` …，避免撞上内置 id） */
export const CUSTOM_PROVIDER_PREFIX = "custom-";

export interface BuiltinModel {
  id: string;
  name: string;
  /** true=确定支持图像输入；false=确定不支持；null=不确定，交给探测 */
  vision: boolean | null;
  note?: string;
}

/**
 * 模型参考清单。只列「值得直接出现在下拉框里」的常见项，不是全集。
 */
export const BUILTIN_MODELS: Record<string, BuiltinModel[]> = {
  deepseek: [
    { id: "deepseek-chat", name: "DeepSeek Chat", vision: false },
    { id: "deepseek-reasoner", name: "DeepSeek Reasoner", vision: false },
  ],
  "ali-tokenplan": [
    // token-plan 上跑的是 DeepSeek 系列；是否有视觉能力尚无公开结论 → 交给探测
    { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", vision: null, note: "项目原本的默认模型" },
  ],
  aliyun: [
    { id: "qwen3-max", name: "通义千问 3 Max", vision: false },
    { id: "qwen-plus", name: "通义千问 Plus", vision: false },
    { id: "qwen-turbo", name: "通义千问 Turbo", vision: false },
    { id: "qwen-vl-max", name: "通义千问 VL Max", vision: true },
    { id: "qwen-vl-plus", name: "通义千问 VL Plus", vision: true },
    { id: "qwen2.5-vl-72b-instruct", name: "Qwen2.5-VL 72B", vision: true },
  ],
  custom: [],
};

export function builtinProvider(id: string): BuiltinProviderPreset | undefined {
  return BUILTIN_PROVIDERS.find((p) => p.id === id);
}

export function builtinModels(providerId: string): BuiltinModel[] {
  return BUILTIN_MODELS[providerId] ?? [];
}

/** 供应商种类 → 中文说明（配置页展示用） */
export const PROVIDER_KIND_HINTS: Record<ProviderKind, string> = {
  deepseek: "DeepSeek 官方 API（OpenAI 兼容）",
  "ali-tokenplan": "阿里云百炼 Token Plan 网关（OpenAI 兼容）",
  aliyun: "阿里云百炼 DashScope 兼容模式",
  custom: "自建 / 第三方 OpenAI 兼容端点",
};
