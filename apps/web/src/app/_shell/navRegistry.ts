/**
 * 导航数据表（任务 10.3：key / label / icon / path / 是否核心 / 来源）。
 *
 * 一条记录就是导航的全部事实：壳层不感知具体页面，新页面只要往表里加一行。
 * - `core: true` 的条目不可隐藏（spec「核心条目不可隐藏」）；
 * - `source` 记录条目来源，设置页据此展示来源徽标；
 * - `immersive: true` 的页面会隐藏主导航（任务 10.11）。
 */
import {
  Bot,
  Brain,
  CalendarDays,
  MessagesSquare,
  Settings,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import zh from "@/i18n/zh";
import { matchEntryByPath, type NavSource } from "./navConfig";

export interface NavEntry {
  key: string;
  label: string;
  icon: LucideIcon;
  path: string;
  /** 核心条目：不可隐藏。 */
  core: boolean;
  source: NavSource;
  /** 沉浸式页面：隐藏主导航，顶部栏补品牌与返回。 */
  immersive?: boolean;
}

export const NAV_ENTRIES: readonly NavEntry[] = [
  {
    key: "chat",
    label: zh.shell.nav.chat,
    icon: MessagesSquare,
    path: "/",
    core: true,
    source: "core",
  },
  {
    key: "schedule",
    label: zh.shell.nav.schedule,
    icon: CalendarDays,
    path: "/schedule",
    core: false,
    source: "builtin",
  },
  {
    key: "memory",
    label: zh.shell.nav.memory,
    icon: Brain,
    path: "/memory",
    core: false,
    source: "extension",
  },
  {
    key: "agents",
    label: zh.shell.nav.agents,
    icon: Bot,
    path: "/agents",
    core: false,
    source: "extension",
  },
  {
    key: "models",
    label: zh.shell.nav.models,
    icon: Sparkles,
    path: "/models",
    core: false,
    source: "extension",
  },
  {
    key: "settings",
    label: zh.shell.nav.settings,
    icon: Settings,
    path: "/settings",
    core: true,
    source: "core",
  },
];

export function matchNavEntry(pathname: string): NavEntry | undefined {
  return matchEntryByPath(NAV_ENTRIES, pathname);
}

/** 当前路径是否是沉浸式页面（沉浸式页面隐藏主导航）。 */
export function isImmersivePath(pathname: string): boolean {
  return Boolean(matchNavEntry(pathname)?.immersive);
}