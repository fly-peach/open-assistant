"use client";

/**
 * 模型配置的数据钩子（SWR）。
 *
 * - `useModelsOverview()`：供应商 + 可选模型 + 全局默认。导航到 `/models` 时取一次；
 * - `useModelSelection(workspace)`：**key 带工作区路径** —— 换工作区就是换 key，
 *   两个工作区的当前模型不会互相复用（和绑定 / 任务的做法一致）。
 */
import useSWR from "swr";

import { getModels, getSelection, type ModelsOverview, type SelectionView } from "@/lib/modelsApi";

export function useModelsOverview() {
  return useSWR<ModelsOverview>("/models", () => getModels());
}

export function useModelSelection(workspace: string | null) {
  return useSWR<SelectionView>(workspace ? `/models/selection?path=${workspace}` : null, () =>
    getSelection(workspace as string)
  );
}
