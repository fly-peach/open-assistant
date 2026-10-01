"use client";

/** 记忆页占位（导航数据表里的「扩展」条目，可被隐藏）。 */
import zh from "@/i18n/zh";
import { ComingSoonPage } from "@/app/_shell/ComingSoonPage";

export default function MemoryPage() {
  return <ComingSoonPage name={zh.shell.nav.memory} />;
}