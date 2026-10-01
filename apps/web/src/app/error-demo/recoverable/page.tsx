"use client";

import zh from "@/i18n/zh";
import { usePageAttempt } from "@/app/_shell/PageBoundary";

/**
 * 任务 10.9 验证用的**可恢复**故障页（`/error-demo/recoverable`）。
 *
 * 首次渲染必抛错（因此会被页面级错误边界接住，只有内容区变成错误提示）；
 * 点「重试」后错误边界会把重试次数带给页面，于是同一路由正常渲染——
 * 用来断言「重试可恢复」。
 */
export default function RecoverableErrorPage(): React.ReactElement {
  const attempt = usePageAttempt();
  if (attempt === 0) {
    throw new Error("recoverable-page-fault-demo");
  }

  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center"
      data-error-demo-recovered
    >
      <h1 className="text-base font-semibold">
        {zh.shell.errorDemoRecoverTitle}
      </h1>
      <p className="text-sm text-muted-foreground">
        {zh.shell.errorDemoRecoverHint}
      </p>
    </div>
  );
}