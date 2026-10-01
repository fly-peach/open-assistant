"use client";

/**
 * 导航区设置（任务 10.4 / 10.5，对齐 specs/app-shell「导航条目可配置」）。
 *
 * - 顺序：原生 HTML5 拖拽（`draggable` + `dragover` 落位）或上/下按钮；
 * - 显隐：眼睛图标；核心条目禁用（不可隐藏）；
 * - 持久化：每次调整立即写 localStorage，重开后保持；
 * - 预览：右侧实时渲染导航区将来显示的样子；
 * - 重置：只清掉导航配置这一个键。
 */
import { useState } from "react";
import { toast } from "sonner";
import {
  ArrowDown,
  ArrowUp,
  Eye,
  EyeOff,
  GripVertical,
  Lock,
  RotateCcw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import zh, { t } from "@/i18n/zh";
import { useNavConfig } from "./navConfigStore";
import type { NavEntry } from "./navRegistry";

const SOURCE_LABEL: Record<NavEntry["source"], string> = {
  core: zh.shell.settingsSourceCore,
  builtin: zh.shell.settingsSourceBuiltin,
  extension: zh.shell.settingsSourceExtension,
};

export function NavSettingsPanel() {
  const { all, keys, visible, hidden, moveUp, moveDown, moveBefore, toggle, reset } =
    useNavConfig();
  const [dragKey, setDragKey] = useState<string | null>(null);
  const byKey = new Map(all.map((entry) => [entry.key, entry]));

  const handleReset = () => {
    reset();
    toast.success(zh.shell.settingsNavResetDone);
  };

  return (
    <section
      className="mt-6"
      data-nav-settings
    >
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">{zh.shell.settingsNavTitle}</h2>
        <Button
          variant="outline"
          size="sm"
          onClick={handleReset}
          data-nav-reset
        >
          <RotateCcw className="mr-2 h-4 w-4" />
          {zh.shell.settingsNavReset}
        </Button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {zh.shell.settingsNavHint}
      </p>

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_220px]">
        <ul className="flex flex-col gap-1">
          {keys.map((key, index) => {
            const entry = byKey.get(key);
            if (!entry) return null;
            const isHiddenEntry = hidden(entry);
            const Icon = entry.icon;
            return (
              <li
                key={key}
                data-nav-row={key}
                data-nav-hidden={isHiddenEntry ? "1" : "0"}
                draggable
                onDragStart={() => setDragKey(key)}
                onDragOver={(event) => {
                  event.preventDefault();
                  if (dragKey && dragKey !== key) moveBefore(dragKey, key);
                }}
                onDragEnd={() => setDragKey(null)}
                className={cn(
                  "flex items-center gap-2 rounded-md border border-border bg-card px-2 py-1.5",
                  isHiddenEntry && "opacity-60"
                )}
              >
                <span
                  className="cursor-grab text-muted-foreground"
                  aria-hidden
                >
                  <GripVertical size={14} />
                </span>
                <span
                  className="min-w-0 flex-1 truncate"
                  data-nav-row-label
                >
                  <Icon
                    size={14}
                    className="mr-1 inline align-[-2px]"
                    aria-hidden
                  />
                  {entry.label}
                </span>
                <span className="rounded border border-border px-1 text-[10px] text-muted-foreground">
                  {SOURCE_LABEL[entry.source]}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => moveUp(key)}
                  disabled={index === 0}
                  aria-label={t(zh.shell.settingsMoveUp, { name: entry.label })}
                  data-nav-move-up={key}
                >
                  <ArrowUp size={14} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => moveDown(key)}
                  disabled={index === keys.length - 1}
                  aria-label={t(zh.shell.settingsMoveDown, { name: entry.label })}
                  data-nav-move-down={key}
                >
                  <ArrowDown size={14} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => toggle(key)}
                  disabled={entry.core}
                  title={
                    entry.core
                      ? t(zh.shell.settingsCoreLocked, { name: entry.label })
                      : undefined
                  }
                  aria-label={
                    isHiddenEntry
                      ? t(zh.shell.settingsShow, { name: entry.label })
                      : t(zh.shell.settingsHide, { name: entry.label })
                  }
                  data-nav-toggle-hidden={key}
                >
                  {entry.core ? (
                    <Lock size={14} />
                  ) : isHiddenEntry ? (
                    <EyeOff size={14} />
                  ) : (
                    <Eye size={14} />
                  )}
                </Button>
              </li>
            );
          })}
        </ul>

        <div
          className="rounded-md border border-border bg-muted/30 p-3"
          data-nav-preview
        >
          <h3 className="text-xs font-medium text-muted-foreground">
            {zh.shell.settingsNavPreview}
          </h3>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {zh.shell.settingsNavPreviewHint}
          </p>
          <ul className="mt-2 flex flex-col gap-0.5">
            {visible.map((entry) => {
              const Icon = entry.icon;
              return (
                <li
                  key={entry.key}
                  data-nav-preview-key={entry.key}
                  className="flex items-center gap-2 rounded px-2 py-1 text-xs text-muted-foreground"
                >
                  <Icon size={13} aria-hidden />
                  <span className="truncate">{entry.label}</span>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </section>
  );
}