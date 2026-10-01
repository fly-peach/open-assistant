"use client";

/**
 * 可折叠区块（expander）：配置类页面的统一外壳。
 *
 * 设计约束：
 * - 标题栏整行可点（`aria-expanded`），右侧 `actions` 不触发展开（比如「保存」）；
 * - 默认折叠，`defaultOpen` 打开最常用的那一块；
 * - 内容仍在同一棵 React 树里，收起只是不渲染内容 —— 配置页都是被控表单，
 *   所以这里**收起会卸载内容**（未保存的输入会丢）。为避免误操作，收起前不做拦截，
 *   但表单状态由父组件持有（本组件的子内容多为受控组件，状态在父级）。
 */
import React, { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";

export interface ExpanderProps
  extends Omit<React.HTMLAttributes<HTMLElement>, "title" | "children"> {
  title: ReactNode;
  subtitle?: ReactNode;
  /** 默认是否展开 */
  defaultOpen?: boolean;
  /** 右上角操作区（不触发展开 / 收起） */
  actions?: ReactNode;
  /** 内容区额外 class */
  contentClassName?: string;
  children: ReactNode;
  /** 允许直接传 data-* 供测试定位 */
  [dataAttr: `data-${string}`]: unknown;
}

export function Expander({
  title,
  subtitle,
  defaultOpen = false,
  actions,
  contentClassName,
  className,
  children,
  ...rest
}: ExpanderProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section className={cn("rounded-md border border-border bg-card", className)} {...rest}>
      <div className="flex items-center gap-2 px-4 py-3">
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          aria-expanded={open}
          data-expander-toggle
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <ChevronRight
            className={cn(
              "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90"
            )}
          />
          <span className="min-w-0 flex-1">
            <span className="block text-base font-semibold">{title}</span>
            {subtitle ? (
              <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                {subtitle}
              </span>
            ) : null}
          </span>
        </button>
        {actions ? <div className="shrink-0">{actions}</div> : null}
      </div>

      {open ? (
        <div
          className={cn("border-t border-border px-4 py-3", contentClassName)}
          data-expander-content
        >
          {children}
        </div>
      ) : null}
    </section>
  );
}

export default Expander;