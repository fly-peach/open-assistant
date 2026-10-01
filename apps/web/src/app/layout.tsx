import { Suspense } from "react";
import { Inter } from "next/font/google";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import { Toaster } from "sonner";
import { AppRoot } from "@/app/_shell/AppRoot";
import { PageLoading } from "@/app/_shell/PageBoundary";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

/**
 * 根布局 = 应用外壳（任务 10.1 / 10.2）。
 *
 * 导航与顶部栏挂在这里，因此同布局内的路由切换**只替换内容区**：
 * 客户端、工作区状态、导航滚动/收起状态都不会重建。
 * `Suspense` 兜住 nuqs 适配器（它内部用 `useSearchParams`）。
 */
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="zh-CN"
      suppressHydrationWarning
    >
      <body
        className={inter.className}
        suppressHydrationWarning
      >
        <NuqsAdapter>
          <Suspense fallback={<PageLoading />}>
            <AppRoot>{children}</AppRoot>
          </Suspense>
        </NuqsAdapter>
        <Toaster />
      </body>
    </html>
  );
}