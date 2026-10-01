"use client";

/**
 * 视觉能力徽标。
 *
 * 三种状态各有各的样子，**不把「未知」画成「不支持」**：
 * - 支持（true）→ 实心眼睛图标；
 * - 不支持（false）→ 带斜杠的眼睛，灰；
 * - 未知（null）→ 问号，虚线边框 —— 它是个「待办」，不是结论。
 *
 * `from` 用来在 title 里说明结论是哪来的（手动 / 探测 / 内置清单 / 未知），
 * 因为用户看到一个「不支持」时，第一个问题总是「你怎么知道的」。
 */
import { Eye, EyeOff, HelpCircle } from "lucide-react";

import zh, { t } from "@/i18n/zh";
import { cn } from "@/lib/utils";
import {
  CAPABILITY_SOURCE_LABEL,
  type CapabilitySource,
} from "@/lib/modelsApi";

export interface VisionBadgeProps {
  vision: boolean | null;
  source?: CapabilitySource;
  /** 紧凑模式：只有图标（放在狭长的下拉项里用） */
  compact?: boolean;
  className?: string;
}

export function visionLabel(vision: boolean | null): string {
  if (vision === true) return zh.models.visionSupported;
  if (vision === false) return zh.models.visionUnsupported;
  return zh.models.visionUnknown;
}

export function VisionBadge({ vision, source, compact = false, className }: VisionBadgeProps) {
  const Icon = vision === true ? Eye : vision === false ? EyeOff : HelpCircle;
  const label = visionLabel(vision);
  const title =
    source === undefined
      ? label
      : t(zh.models.visionFrom, { source: CAPABILITY_SOURCE_LABEL[source] ?? source });
  return (
    <span
      title={title}
      data-vision={vision === null ? "unknown" : String(vision)}
      data-testid="vision-badge"
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] leading-none",
        vision === true && "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
        vision === false && "border-muted-foreground/30 text-muted-foreground",
        vision === null && "border-dashed border-muted-foreground/40 text-muted-foreground",
        className
      )}
    >
      <Icon className="h-3 w-3" aria-hidden />
      {!compact && <span>{label}</span>}
    </span>
  );
}
