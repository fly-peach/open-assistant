"use client";

/**
 * 页面级故障隔离（任务 10.9，对齐 specs/app-shell「页面级故障隔离」）。
 *
 * - 内容区外层套 `Suspense`（加载反馈）+ 本错误边界；
 * - 单页渲染失败只把**该页**替换成错误提示与重试入口，导航与顶部栏照常；
 * - 重试通过变更内部 key 强制重挂载内容区，不需要刷新整个应用；
 * - 父组件用 `key={pathname}` 传本边界，切页即自愈。
 */
import React, { Suspense, createContext, useContext } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import zh from "@/i18n/zh";

/**
 * 当前页面被重试了几次（0 = 首次渲染）。
 * 页面可以据此实现「首次抛错、重试即恢复」的演示（见 `/error-demo/recoverable`）。
 */
const PageAttemptContext = createContext(0);

export function usePageAttempt(): number {
  return useContext(PageAttemptContext);
}

interface PageErrorBoundaryProps {
  children: React.ReactNode;
}

interface PageErrorBoundaryState {
  error: Error | null;
  attempt: number;
}

export class PageErrorBoundary extends React.Component<
  PageErrorBoundaryProps,
  PageErrorBoundaryState
> {
  state: PageErrorBoundaryState = { error: null, attempt: 0 };

  static getDerivedStateFromError(error: Error): Partial<PageErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error): void {
    // 保留控制台线索，便于定位是哪个页面抛的错。
    console.error("[app-shell] page crashed:", error);
  }

  private retry = (): void => {
    this.setState((state) => ({ error: null, attempt: state.attempt + 1 }));
  };

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div
          className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center"
          data-page-error
        >
          <AlertTriangle
            className="text-[var(--color-error)]"
            size={28}
            aria-hidden
          />
          <h2 className="text-base font-semibold">{zh.shell.pageErrorTitle}</h2>
          <p className="max-w-md text-sm text-muted-foreground">
            {zh.shell.pageErrorHint}
          </p>
          <p
            className="max-w-md break-all text-xs text-[var(--color-text-tertiary)]"
            data-page-error-detail
          >
            {this.state.error.message}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={this.retry}
            data-page-error-retry
          >
            <RotateCcw className="mr-2 h-4 w-4" />
            {zh.shell.pageErrorRetry}
          </Button>
        </div>
      );
    }
    // key 变化 → 内容区重挂载，重试才会重新执行页面渲染。
    return (
      <PageAttemptContext.Provider value={this.state.attempt}>
        <React.Fragment key={this.state.attempt}>
          {this.props.children}
        </React.Fragment>
      </PageAttemptContext.Provider>
    );
  }
}

/** 页面资源仍在加载时的反馈（内容区不得留白）。 */
export function PageLoading() {
  return (
    <div
      className="flex h-full items-center justify-center text-sm text-muted-foreground"
      data-page-loading
    >
      {zh.shell.pageLoading}
    </div>
  );
}

interface PageViewportProps {
  /** 路由键：切换路由时重置错误状态（切页自愈）。 */
  routeKey: string;
  children: React.ReactNode;
}

/** 内容区：Suspense + 页面级错误边界。 */
export function PageViewport({ routeKey, children }: PageViewportProps) {
  return (
    <Suspense fallback={<PageLoading />}>
      <PageErrorBoundary key={routeKey}>{children}</PageErrorBoundary>
    </Suspense>
  );
}