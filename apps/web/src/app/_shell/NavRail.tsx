"use client";

/**
 * 左导航区（任务 10.1 / 10.3 / 10.4 / 10.11）。
 *
 * 常驻在根布局里：页面切换只换内容区，本组件不重建（滚动位置 / 收起状态保持）。
 * 条目来自 `navRegistry` 的数据表，顺序与显隐来自 `navConfigStore`。
 */
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import zh from "@/i18n/zh";
import { useNavConfig } from "./navConfigStore";
import type { NavEntry } from "./navRegistry";

const COLLAPSE_KEY = "open-assistant.nav-rail-collapsed";

interface NavRailProps {
  activeKey: string | null;
}

export function NavRail({ activeKey }: NavRailProps) {
  const router = useRouter();
  const pathname = usePathname();
  const { visible } = useNavConfig();
  const [collapsed, setCollapsed] = useState(false);

  // 收起状态本地记忆（首帧用默认值，挂载后再套用存储值，避免水合不一致）。
  useEffect(() => {
    setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === "1");
  }, []);

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      window.localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      return next;
    });
  };

  /**
   * 导航保留当前查询参数：`workspace` / `threadId` 等页面内状态在换页后仍在，
   * 地址依旧可分享。用 `window.location.search` 而不是 `useSearchParams`，
   * 避免 nuqs 浅更新后读到滞后值。
   */
  const navigate = (entry: NavEntry) => (event: React.MouseEvent) => {
    event.preventDefault();
    if (pathname === entry.path) return;
    const query = typeof window === "undefined" ? "" : window.location.search;
    router.push(`${entry.path}${query}`);
  };

  return (
    <nav
      aria-label={zh.shell.navLabel}
      data-shell-nav
      data-collapsed={collapsed ? "1" : "0"}
      className={cn(
        "flex shrink-0 flex-col border-r border-border bg-card transition-[width] duration-150",
        collapsed ? "w-[56px]" : "w-[188px]"
      )}
    >
      <div className="flex h-10 items-center justify-between px-2">
        {!collapsed && (
          <span className="truncate px-1 text-sm font-semibold">
            {zh.app.title}
          </span>
        )}
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label={collapsed ? zh.shell.navExpand : zh.shell.navCollapse}
          aria-expanded={!collapsed}
          data-nav-collapse
          className="ml-auto rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
        </button>
      </div>

      <ul className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2 py-2">
        {visible.map((entry) => {
          const active = entry.key === activeKey;
          const Icon = entry.icon;
          return (
            <li key={entry.key}>
              <a
                href={entry.path}
                onClick={navigate(entry)}
                data-nav-key={entry.key}
                data-active={active ? "1" : "0"}
                aria-current={active ? "page" : undefined}
                aria-label={entry.label}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm",
                  collapsed && "justify-center px-0",
                  active
                    ? "bg-accent font-medium text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                )}
              >
                <Icon size={16} className="shrink-0" aria-hidden />
                {!collapsed && <span className="truncate">{entry.label}</span>}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}