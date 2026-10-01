"use client";

/**
 * 根系（任务 10.1 / 10.2）。
 *
 * 把「跨路由不能重建」的东西上提到根布局：
 * - `AppConfigProvider`：应用配置 + 配置弹窗；
 * - `WorkspaceProvider`：工作区状态（nuqs 查询参数 `workspace`）；
 * - `ClientProvider`：LangGraph 客户端（配置就绪后创建，`useMemo` 保证只建一次）；
 * - `AppShell`：左导航 + 顶部栏 + 内容区。
 *
 * provider 在布局层 → 页面之间跳转时不会重新创建客户端、也不会丢工作区状态。
 */
import { ConfigDialog } from "@/app/components/ConfigDialog";
import { ClientProvider } from "@/providers/ClientProvider";
import { WorkspaceProvider } from "@/providers/WorkspaceProvider";
import { AppShell } from "./AppShell";
import { AppConfigProvider, useAppConfig } from "./AppConfigContext";

function ShellWithProviders({ children }: { children: React.ReactNode }) {
  const {
    config,
    configDialogOpen,
    setConfigDialogOpen,
    handleSaveConfig,
  } = useAppConfig();

  const langsmithApiKey =
    config?.langsmithApiKey || process.env.NEXT_PUBLIC_LANGSMITH_API_KEY || "";

  const shell = <AppShell>{children}</AppShell>;

  return (
    <>
      {config ? (
        <ClientProvider
          deploymentUrl={config.deploymentUrl}
          apiKey={langsmithApiKey}
        >
          {shell}
        </ClientProvider>
      ) : (
        shell
      )}
      <ConfigDialog
        open={configDialogOpen}
        onOpenChange={setConfigDialogOpen}
        onSave={handleSaveConfig}
        initialConfig={config ?? undefined}
      />
    </>
  );
}

export function AppRoot({ children }: { children: React.ReactNode }) {
  return (
    <AppConfigProvider>
      <WorkspaceProvider>
        <ShellWithProviders>{children}</ShellWithProviders>
      </WorkspaceProvider>
    </AppConfigProvider>
  );
}