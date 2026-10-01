/**
 * 模型中间件：**在每次模型调用前，把「这一轮该用的模型」换进去**。
 *
 * ## 为什么用 `wrapModelCall` 而不是在建图时选模型
 *
 * `createDeepAgent({ model })` 在**进程启动时**就把模型焊死在图里了。
 * 但「用哪个模型」是**每个工作区各自的事**（工作区 → 绑定 agent → agent 的 config.json），
 * 一个后端进程要同时服务多个工作区，所以只能在运行期决定。
 *
 * `wrapModelCall` 的 `request.model` 是「本次要发给模型的这一个」，
 * 改写它**不回写 state、不影响 checkpoint**（跟人设注入同一个侵入点，
 * 见 workspace-middleware.ts 顶部关于侵入点选择的说明）。
 *
 * ## 两道关
 *
 * - `beforeAgent`：**先校验再跑**。没配模型 / 没填 key 时在模型调用前就抛可读错误
 *   （错误码 `MODEL_NOT_CONFIGURED`，前端能直接展示怎么办）；
 * - `wrapModelCall`：真正换模型。解析结果按工作区缓存 1 秒 ——
 *   一轮对话里模型可能被调用好几次，没必要每次都读盘 + 解析绑定。
 */
import { createMiddleware } from "langchain";
import { getConfig } from "@langchain/langgraph";

import { normalizeWorkspacePath, readWorkspacePathFromConfig } from "../workspace.js";
import { buildChatModel, requireReady, resolveEffectiveModel } from "./resolve.js";
import type { ResolvedModelConfig } from "./types.js";

/** 解析结果缓存时长：足够覆盖一轮对话里的多次模型调用，又能在改配置后很快生效 */
const RESOLVE_TTL_MS = 1000;

interface CacheEntry {
  at: number;
  value: ResolvedModelConfig | null;
}

const resolveCache = new Map<string, CacheEntry>();

async function resolveForRun(workspace: string): Promise<ResolvedModelConfig | null> {
  const cached = resolveCache.get(workspace);
  const now = Date.now();
  if (cached && now - cached.at < RESOLVE_TTL_MS) return cached.value;
  const value = await resolveEffectiveModel(workspace);
  resolveCache.set(workspace, { at: now, value });
  return value;
}

/** 主动失效（改完配置立刻生效，不用等 TTL） */
export function invalidateModelResolution(workspace?: string): void {
  if (workspace === undefined) resolveCache.clear();
  else resolveCache.delete(workspace);
}

/**
 * 当前 run 的工作区绝对路径。
 * `beforeAgent` 用 `getConfig()`（此时还没有 request）；`wrapModelCall` 用
 * `request.runtime.configurable`（与 workspace-middleware 的取法保持一致）。
 */
function currentWorkspace(config?: unknown): string | null {
  const raw = config === undefined ? readWorkspacePathFromConfig(getConfig()) : readWorkspacePathFromConfig(config);
  if (!raw) return null;
  try {
    return normalizeWorkspacePath(raw);
  } catch {
    return null;
  }
}

export const modelMiddleware = createMiddleware({
  name: "ModelMiddleware",

  /** 跑之前先验证「有模型可用」，否则给用户一句能照做的错误 */
  beforeAgent: async () => {
    const workspace = currentWorkspace();
    // 工作区都没指定时交给 workspaceMiddleware 去报它那个更准确的错
    if (!workspace) return undefined;
    requireReady(await resolveForRun(workspace));
    return undefined;
  },

  /** 把这一轮该用的模型换进去（缺配置时保持原样，让 beforeAgent 的错误先暴露） */
  wrapModelCall: async (request, handler) => {
    const workspace = currentWorkspace({ configurable: request.runtime?.configurable });
    if (!workspace) return handler(request);
    const resolved = await resolveForRun(workspace);
    if (!resolved || !resolved.apiKey) return handler(request);
    return handler({ ...request, model: buildChatModel(resolved) });
  },
});
