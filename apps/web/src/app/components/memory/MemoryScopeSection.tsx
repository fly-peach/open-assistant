"use client";

/**
 * 一级导航节点（任务 11.18）：一个「记忆范围」。
 *
 * 这里刻意不用 Radix Tabs：两级导航的父节点要能**同时**做两件事
 * ——「激活这个范围（切换右侧预览）」与「展开/收起它的子树」。
 * 两个动作各是一个原生 `<button>`（`data-memory-scope-node` / `data-memory-scope-toggle`），
 * 迁移测试与 browser-use 都能用真实指针事件点到，不依赖 Radix 的内部键盘处理。
 */
import React from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export interface MemoryScopeSectionProps {
  scope: "agent" | "wiki";
  title: string;
  description: string;
  icon: React.ReactNode;
  /** 是否是当前激活范围（右侧预览跟随它）。 */
  active: boolean;
  open: boolean;
  onActivate: () => void;
  onToggle: () => void;
  /** 展开/收起的无障碍名称（含范围名）。 */
  toggleLabel: string;
  children: React.ReactNode;
}

export function MemoryScopeSection({
  scope,
  title,
  description,
  icon,
  active,
  open,
  onActivate,
  onToggle,
  toggleLabel,
  children,
}: MemoryScopeSectionProps) {
  return (
    <section
      className="border-b border-border py-1 last:border-b-0"
      data-memory-scope={scope}
      data-memory-scope-active={active ? "true" : "false"}
    >
      <div
        className={cn(
          "flex items-start gap-1 rounded px-1 py-1",
          active && "bg-[var(--color-surface)]"
        )}
      >
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-label={toggleLabel}
          title={toggleLabel}
          data-memory-scope-toggle={scope}
          className="mt-[3px] shrink-0 rounded p-0.5 text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-hover,#f3f4f6)]"
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <button
          type="button"
          onClick={onActivate}
          data-memory-scope-node={scope}
          className="min-w-0 flex-1 text-left"
        >
          <span className="flex items-center gap-1.5 text-sm font-medium">
            {icon}
            <span className="min-w-0 truncate">{title}</span>
          </span>
          <span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">
            {description}
          </span>
        </button>
      </div>
      {open && (
        <div
          className="mt-1"
          data-memory-scope-tree={scope}
        >
          {children}
        </div>
      )}
    </section>
  );
}

export default MemoryScopeSection;