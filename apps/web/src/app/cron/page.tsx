"use client";

/** 定时任务页占位（导航数据表里的「扩展」条目，可被隐藏）。 */
import zh from "@/i18n/zh";
import { ComingSoonPage } from "@/app/_shell/ComingSoonPage";

export default function CronPage() {
  return <ComingSoonPage name={zh.shell.nav.cron} />;
}