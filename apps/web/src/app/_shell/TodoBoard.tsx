"use client";

/**
 * 待办看板（`/todos` 页面使用；壳层的沉浸式机制保留但当前无使用方）。
 *
 * 直接复用现有的 `TodoView`（事实源是工作区里的 `todos.json`），
 * 只是把它从工作区侧栏搬到一个整页容器里。
 */
import { TodoView } from "@/app/components/workspace/TodoView";
import { useWorkspaceContext } from "@/providers/WorkspaceProvider";
import zh from "@/i18n/zh";

interface TodoBoardProps {
  title: string;
  hint?: string;
}

export function TodoBoard({ title, hint }: TodoBoardProps) {
  const { workspacePath, revision, notifyWorkspaceChanged } =
    useWorkspaceContext();

  return (
    <div className="h-full overflow-auto p-6" data-todo-board>
      <h1 className="text-lg font-semibold">{title}</h1>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
      {workspacePath ? (
        <div className="mt-4 rounded-md border border-border bg-card p-3">
          <TodoView
            workspacePath={workspacePath}
            revision={revision}
            onChanged={notifyWorkspaceChanged}
          />
        </div>
      ) : (
        <p
          className="mt-4 text-sm text-muted-foreground"
          data-todo-no-workspace
        >
          {zh.shell.todoPageNoWorkspace}
        </p>
      )}
    </div>
  );
}