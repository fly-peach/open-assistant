"use client";

/**
 * 顶部栏（任务 10.1 / 10.11）。
 *
 * 常驻跨页操作与状态：当前工作区、设置入口。不依赖具体页面提供，
 * 因此页面切换时不会重建（只有内部文本随路由变化）。
 * 沉浸式页面下补上品牌与返回入口（主导航此时被隐藏）。
 */
import { useRouter } from "next/navigation";
import { ArrowLeft, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PathLabel } from "@/app/components/workspace/PathLabel";
import { useWorkspaceContext } from "@/providers/WorkspaceProvider";
import zh from "@/i18n/zh";
import { useAppConfig } from "./AppConfigContext";

interface TopBarProps {
  /** 沉浸式页面：显示品牌 + 返回，替代常规的「当前页」标题。 */
  immersive: boolean;
  /** 当前页标题（导航数据表里的 label），非沉浸式时展示。 */
  title: string | null;
}

export function TopBar({ immersive, title }: TopBarProps) {
  const router = useRouter();
  const { workspacePath } = useWorkspaceContext();
  const { openConfigDialog } = useAppConfig();

  const goBack = () => {
    if (typeof window !== "undefined" && window.history.length > 1) {
      router.back();
      return;
    }
    router.push("/");
  };

  return (
    <header
      data-shell-topbar
      className="flex h-12 shrink-0 items-center justify-between border-b border-border bg-card px-3"
    >
      <div className="flex min-w-0 items-center gap-3">
        {immersive ? (
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={goBack}
              data-topbar-back
            >
              <ArrowLeft className="mr-1 h-4 w-4" />
              {zh.shell.back}
            </Button>
            <span className="truncate text-sm font-semibold">
              {zh.app.title}
            </span>
            {title && (
              <span className="truncate text-xs text-muted-foreground">
                {title}
              </span>
            )}
          </>
        ) : (
          <span className="truncate text-sm font-medium" data-topbar-title>
            {title ?? zh.app.title}
          </span>
        )}
      </div>

      <div className="flex min-w-0 items-center gap-3">
        <span
          className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground"
          data-topbar-workspace
        >
          <span className="shrink-0">{zh.shell.workspaceLabel}</span>
          {workspacePath ? (
            <PathLabel
              path={workspacePath}
              max={22}
              tail={14}
              className="max-w-[220px] text-xs text-muted-foreground"
            />
          ) : (
            <span className="shrink-0">{zh.shell.workspaceNone}</span>
          )}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={openConfigDialog}
          aria-label={zh.app.settings}
          data-topbar-settings
        >
          <Settings className="mr-2 h-4 w-4" />
          {zh.app.settings}
        </Button>
      </div>
    </header>
  );
}