"use client";

/** 尚未实现的扩展页面占位（导航数据表里的「扩展」条目）。 */
import { Wrench } from "lucide-react";
import zh, { t } from "@/i18n/zh";

interface ComingSoonPageProps {
  /** 功能名（来自导航数据表，用于文案插值）。 */
  name: string;
}

export function ComingSoonPage({ name }: ComingSoonPageProps) {
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center"
      data-coming-soon
    >
      <Wrench
        className="text-muted-foreground"
        size={24}
        aria-hidden
      />
      <h1 className="text-base font-semibold">{zh.shell.comingSoonTitle}</h1>
      <p className="text-sm text-muted-foreground">
        {t(zh.shell.comingSoonDescription, { name })}
      </p>
    </div>
  );
}