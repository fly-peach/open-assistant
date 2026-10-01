"use client";

/**
 * 应用外壳（任务 10.1 / 10.9 / 10.10 / 10.11）。
 *
 * 结构：左导航区 + 顶部栏 + 内容区，外加两个固定插槽：
 * `content.statusBar`（内容区上方状态栏）与 `overlay.global`（全局浮层）。
 *
 * 本组件挂在**根布局**上，所以同布局内换路由时它不重建：
 * 只有 `children`（内容区）被替换——这正是 10.1 要验证的行为。
 */
import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { matchNavEntry } from "./navRegistry";
import { NavRail } from "./NavRail";
import { TopBar } from "./TopBar";
import { PageViewport } from "./PageBoundary";
import { Slot, slotStore } from "./slots";

interface AppShellProps {
  children: React.ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const pathname = usePathname();
  const entry = matchNavEntry(pathname);
  const immersive = Boolean(entry?.immersive);

  // 开发环境把插槽 store 暴露到 window，方便浏览器验证「注册后出现 / 无注册不占位」。
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    (window as unknown as Record<string, unknown>).__oaSlotStore = slotStore;
  }, []);

  return (
    <div
      className="flex h-screen flex-col overflow-hidden bg-background"
      data-shell-root
    >
      <TopBar
        immersive={immersive}
        title={entry?.label ?? null}
      />
      <div className="flex min-h-0 flex-1">
        {!immersive && <NavRail activeKey={entry?.key ?? null} />}
        <main
          className="flex min-w-0 flex-1 flex-col"
          data-shell-content
        >
          <Slot
            name="content.statusBar"
            className="shrink-0 border-b border-border bg-muted/30 px-3 py-1 text-xs"
          />
          <div
            className="min-h-0 flex-1 overflow-hidden"
            data-page-content
          >
            <PageViewport routeKey={pathname}>{children}</PageViewport>
          </div>
        </main>
      </div>
      {/* 全局浮层：铺满外壳最上层，无注册时 Slot 返回 null（不占位）。 */}
      <Slot
        name="overlay.global"
        className="pointer-events-none fixed inset-0 z-50"
      />
    </div>
  );
}