"use client";

import React from "react";
import { middleEllipsis } from "@/app/utils/path";
import { cn } from "@/lib/utils";

interface PathLabelProps {
  /** 完整绝对路径（`title` 里始终是全文，供 hover 查看）。 */
  path: string;
  className?: string;
  /** 允许显示的最大字符数，超过则中间省略（tasks 8.11）。 */
  max?: number;
  /** 尾部保留字符数。 */
  tail?: number;
}

/**
 * 路径展示（tasks 8.10 / 8.11）。
 *
 * - 展示**完整绝对路径**（过长时中间省略，而不是截断尾部，因为尾部更能区分目录）；
 * - `title` 与 `data-full-path` 保留全文，鼠标悬停即可看到；
 * - `min-w-0 truncate` 保证不会把侧边栏 / 工具条撑破。
 */
export function PathLabel({ path, className, max, tail }: PathLabelProps) {
  const display = middleEllipsis(path, { max, tail });
  return (
    <span
      className={cn("block min-w-0 truncate font-mono", className)}
      title={path}
      data-full-path={path}
    >
      {display}
    </span>
  );
}

export default PathLabel;