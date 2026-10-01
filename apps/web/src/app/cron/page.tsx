/**
 * 原占位页 `/cron` 已由真实页 `/jobs` 取代（任务 6.1）。
 *
 * 保留这个路由只做重定向：旧书签 / 旧链接仍然可达，导航数据表里的条目
 * 已经指向 `/jobs`。
 */
import { redirect } from "next/navigation";

export default function CronPage() {
  redirect("/jobs");
}