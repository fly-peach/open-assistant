"use client";

/**
 * 日历主 tab：一个月视图，把**有排期的待办**与**定时任务的发生时刻**放进同一天格里。
 *
 * - 待办：todos.json 里带 `dueAt` 的按天落位；没排期的归到下方「未排期待办」；
 * - 定时任务：`/jobs/occurrences` 展开本月区间（一次性任务的 at；周期任务用 cron 逐次求值）；
 * - 数据源与待办视图共用同一份 todos（SWR key 一致，改完即时反映）。
 */
import { useMemo, useState } from "react";
import useSWR from "swr";
import { CalendarClock, ChevronLeft, ChevronRight } from "lucide-react";

import { readTodos } from "@/lib/workspaceApi";
import { useJobOccurrences } from "@/app/hooks/useAgents";
import { useWorkspaceContext } from "@/providers/WorkspaceProvider";
import { localDateKey } from "@/app/utils/datetime";
import zh, { t } from "@/i18n/zh";
import { cn } from "@/lib/utils";

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"] as const;

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function endOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
}

export function ScheduleCalendar() {
  const { workspacePath, revision } = useWorkspaceContext();
  const today = new Date();
  const [month, setMonth] = useState<Date>(() => startOfMonth(today));
  const [selected, setSelected] = useState<string>(() => localDateKey(today));

  const { data, error } = useSWR(
    workspacePath ? ["todos", workspacePath, revision] : null,
    () => readTodos(workspacePath as string),
    { revalidateOnFocus: false, keepPreviousData: true, shouldRetryOnError: false }
  );
  const todos = data?.file.todos ?? [];

  const monthStart = startOfMonth(month);
  const monthEnd = endOfMonth(month);
  const occurrences = useJobOccurrences(
    workspacePath,
    monthStart.toISOString(),
    monthEnd.toISOString()
  );

  const todosByDay = useMemo(() => {
    const map = new Map<string, typeof todos>();
    for (const todo of todos) {
      if (!todo.dueAt) continue;
      const key = localDateKey(todo.dueAt);
      if (!key) continue;
      const list = map.get(key) ?? [];
      list.push(todo);
      map.set(key, list);
    }
    return map;
  }, [todos]);

  const jobsByDay = useMemo(() => {
    const map = new Map<string, { name: string; at: string }[]>();
    for (const occ of occurrences.data ?? []) {
      const key = localDateKey(occ.at);
      const list = map.get(key) ?? [];
      list.push({ name: occ.name, at: occ.at });
      map.set(key, list);
    }
    return map;
  }, [occurrences.data]);

  const unscheduled = useMemo(() => todos.filter((todo) => !todo.dueAt), [todos]);

  // 6×7 网格（周一开始）
  const cells = useMemo(() => {
    const first = startOfMonth(month);
    const offset = (first.getDay() + 6) % 7;
    const start = new Date(first.getFullYear(), first.getMonth(), 1 - offset);
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      return d;
    });
  }, [month]);

  const todayKey = localDateKey(today);
  const dayTodos = todosByDay.get(selected) ?? [];
  const dayJobs = jobsByDay.get(selected) ?? [];

  return (
    <div className="h-full overflow-auto p-6" data-schedule-calendar>
      <div className="mx-auto max-w-5xl">
        <header className="mb-3 flex items-center gap-2">
          <h2 className="text-sm font-semibold">
            {month.getFullYear()} 年 {month.getMonth() + 1} 月
          </h2>
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
              aria-label={zh.schedule.prevMonth}
              title={zh.schedule.prevMonth}
              data-cal-prev
              className="rounded border border-border p-1 hover:bg-accent"
            >
              <ChevronLeft size={14} />
            </button>
            <button
              type="button"
              onClick={() => {
                setMonth(startOfMonth(new Date()));
                setSelected(localDateKey(new Date()));
              }}
              className="rounded border border-border px-2 py-1 text-xs hover:bg-accent"
              data-cal-today
            >
              {zh.schedule.today}
            </button>
            <button
              type="button"
              onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
              aria-label={zh.schedule.nextMonth}
              title={zh.schedule.nextMonth}
              data-cal-next
              className="rounded border border-border p-1 hover:bg-accent"
            >
              <ChevronRight size={14} />
            </button>
          </div>
        </header>

        {error && (
          <p className="mb-2 text-xs text-[var(--color-error)]" data-cal-error>
            {t(zh.schedule.loadFailed, { error: String((error as Error).message ?? error) })}
          </p>
        )}

        {/* 月网格 */}
        <div className="rounded-md border border-border bg-card">
          <div className="grid grid-cols-7 border-b border-border text-center text-[11px] text-muted-foreground">
            {WEEKDAYS.map((w) => (
              <div key={w} className="py-1.5">
                {w}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {cells.map((d) => {
              const key = localDateKey(d);
              const inMonth = d.getMonth() === month.getMonth();
              const dayT = todosByDay.get(key)?.length ?? 0;
              const dayJ = jobsByDay.get(key)?.length ?? 0;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setSelected(key)}
                  data-cal-day={key}
                  data-cal-selected={selected === key ? "1" : "0"}
                  className={cn(
                    "flex min-h-[76px] flex-col items-start gap-1 border-b border-r border-border p-1.5 text-left last:border-r-0 hover:bg-accent",
                    !inMonth && "opacity-40",
                    selected === key && "bg-accent"
                  )}
                >
                  <span
                    className={cn(
                      "inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[11px]",
                      key === todayKey && "bg-[var(--color-primary)] text-white"
                    )}
                  >
                    {d.getDate()}
                  </span>
                  <span className="flex flex-wrap gap-1">
                    {dayT > 0 && (
                      <span className="rounded bg-[#f59e0b]/15 px-1 text-[10px] text-[#b45309]">
                        {zh.schedule.tabTodos} {dayT}
                      </span>
                    )}
                    {dayJ > 0 && (
                      <span className="rounded bg-[var(--color-surface)] px-1 text-[10px] text-[var(--color-text-secondary)]">
                        <CalendarClock size={9} className="mr-0.5 inline" />
                        {dayJ}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* 选中日详情 */}
        <div className="mt-4 grid gap-4 sm:grid-cols-2" data-cal-detail={selected}>
          <section className="rounded-md border border-border bg-card p-3">
            <h3 className="text-xs font-semibold">{zh.schedule.dayTodos}</h3>
            {dayTodos.length === 0 ? (
              <p className="mt-1 text-[11px] text-muted-foreground">{zh.schedule.noItems}</p>
            ) : (
              <ul className="mt-1 space-y-1">
                {dayTodos.map((todo) => (
                  <li key={todo.id} className="text-xs">
                    <span className={cn(todo.status === "completed" && "line-through opacity-60")}>
                      {todo.content}
                    </span>
                    {todo.dueAt && (
                      <span className="ml-1 text-[10px] text-muted-foreground">
                        {new Date(todo.dueAt).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="rounded-md border border-border bg-card p-3">
            <h3 className="text-xs font-semibold">{zh.schedule.dayJobs}</h3>
            {dayJobs.length === 0 ? (
              <p className="mt-1 text-[11px] text-muted-foreground">{zh.schedule.noItems}</p>
            ) : (
              <ul className="mt-1 space-y-1">
                {dayJobs.map((job, i) => (
                  <li key={`${job.name}-${i}`} className="text-xs">
                    <CalendarClock size={11} className="mr-1 inline text-[var(--color-text-tertiary)]" />
                    {job.name}
                    <span className="ml-1 text-[10px] text-muted-foreground">
                      {new Date(job.at).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        {/* 未排期待办 */}
        <section className="mt-4 rounded-md border border-border bg-card p-3" data-cal-unscheduled>
          <h3 className="text-xs font-semibold">
            {zh.schedule.unscheduled}
            {unscheduled.length > 0 && <span className="ml-1 font-normal">({unscheduled.length})</span>}
          </h3>
          {unscheduled.length === 0 ? (
            <p className="mt-1 text-[11px] text-muted-foreground">{zh.schedule.unscheduledEmpty}</p>
          ) : (
            <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
              {unscheduled.map((todo) => (
                <li key={todo.id} className="text-xs text-muted-foreground">
                  {todo.content}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

export default ScheduleCalendar;