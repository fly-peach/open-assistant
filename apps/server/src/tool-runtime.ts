/**
 * 自研工具共用的运行期上下文解析：从工具第二参数 / 当前执行上下文里拿到工作区绝对路径。
 *
 * 工作区来自 run 的 `config.configurable.workspace`（工作区绝对路径），
 * 与 agent 的 FilesystemBackend 根一致，因此工具与文件工具作用在同一块目录上。
 */
import { getConfig } from "@langchain/langgraph";
import { readWorkspacePathFromConfig, resolveWorkspaceDir } from "./workspace.js";

/** 从工具第二参数 / getConfig 中解析工作区绝对路径 */
export function resolveWorkspacePathFromRuntime(runtime: unknown): string {
  const runtimeConfig =
    (runtime as { config?: unknown } | undefined)?.config ?? (runtime as unknown);
  let p = readWorkspacePathFromConfig(runtimeConfig);
  if (!p) {
    try {
      p = readWorkspacePathFromConfig(getConfig());
    } catch {
      // 工具在 graph 上下文之外被调用时 getConfig 可能不可用，忽略。
    }
  }
  if (!p) {
    throw new Error(
      "未指定工作区：请在 run 的 config.configurable.workspace 中提供工作区绝对路径",
    );
  }
  return p;
}

/** 校验并解析出可读写的工作区目录（realpath 归一化） */
export async function workspaceDirOf(runtime: unknown): Promise<string> {
  return resolveWorkspaceDir(resolveWorkspacePathFromRuntime(runtime));
}

/** 工具错误 → 给模型看的可读文本 */
export function errorText(err: unknown): string {
  const code = (err as { code?: unknown })?.code;
  if (typeof code === "string" && err instanceof Error) {
    return `ERROR [${code}] ${err.message}`;
  }
  if (err instanceof Error) {
    return `ERROR ${err.message}`;
  }
  return `ERROR ${String(err)}`;
}