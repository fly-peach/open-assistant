"use client";

/**
 * 「安排」页（路由 `/schedule`）：把**待办**与**定时任务**合到一页，用页签切换，
 * 默认打开**日历**主 tab（日历里同时看待办的排期与定时任务的发生时刻）。
 *
 * - 日历：`ScheduleCalendar`（主 tab）
 * - 待办：复用 `TodoBoard`（事实源仍是工作区里的 `todos.json`）
 * - 定时任务：复用定时任务页 `JobsPage`
 *
 * `?tab=calendar|todos|jobs` 决定当前页签；旧路由 `/todos`、`/jobs`、`/cron` 重定向到这里。
 */
import { Suspense } from "react";
import { useQueryState } from "nuqs";
import { CalendarDays } from "lucide-react";

import { TodoBoard } from "@/app/_shell/TodoBoard";
import { PageLoading } from "@/app/_shell/PageBoundary";
import { ScheduleCalendar } from "@/app/components/schedule/ScheduleCalendar";
import JobsPage from "@/app/jobs/page";
import { useWorkspaceContext } from "@/providers/WorkspaceProvider";
import zh from "@/i18n/zh";
import { cn } from "@/lib/utils";

const TABS = [
  { key: "calendar", label: zh.schedule.tabCalendar },
  { key: "todos", label: zh.schedule.tabTodos },
  { key: "jobs", label: zh.schedule.tabJobs },
] as const;

type TabKey = (typeof TABS)[number]["key"];

function SchedulePageInner() {
  const [tab, setTab] = useQueryState("tab");
  const { workspacePath } = useWorkspaceContext();
  const active: TabKey = TABS.some((item) => item.key === tab) ? (tab as TabKey) : "calendar";

  return (
    <div className="flex h-full min-h-0 flex-col" data-schedule-page>
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-6 py-3">
        <CalendarDays size={18} aria-hidden />
        <h1 className="text-lg font-semibold">{zh.schedule.title}</h1>
        <p className="text-xs text-muted-foreground">{zh.schedule.hint}</p>
        <nav
          role="tablist"
          aria-label={zh.schedule.title}
          className="ml-auto flex items-center gap-1"
        >
          {TABS.map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={active === item.key}
              data-schedule-tab={item.key}
              onClick={() => void setTab(item.key)}
              className={cn(
                "rounded-md px-3 py-1 text-sm",
                active === item.key
                  ? "bg-accent font-medium text-foreground"
                  : "text-muted-foreground hover:bg-accent"
              )}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </header>

      <div className="min-h-0 flex-1" data-schedule-body={active}>
        {!workspacePath ? (
          <p className="p-6 text-sm text-muted-foreground" data-schedule-no-workspace>
            {zh.schedule.noWorkspace}
          </p>
        ) : active === "todos" ? (
          <TodoBoard title={zh.schedule.tabTodos} hint={zh.schedule.hint} />
        ) : active === "jobs" ? (
          <JobsPage />
        ) : (
          <ScheduleCalendar />
        )}
      </div>
    </div>
  );
}

/**
 * 默认导出包一层 `Suspense`：`useQueryState`（nuqs）内部用 `useSearchParams`，
 * 不包 boundary 时 Next 会额外保留一份隐藏副本（既浪费又会重复跑副作用）。
 */
export default function SchedulePage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <SchedulePageInner />
    </Suspense>
  );
}