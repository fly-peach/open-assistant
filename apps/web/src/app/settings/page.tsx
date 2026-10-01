"use client";

/**
 * 设置页（路由 `/settings`，任务 10.5）。
 *
 * - 应用配置：打开常驻的配置弹窗（部署地址 / 助手 ID）；
 * - 导航设置：顺序、显隐、重置与预览；
 * - 诊断（仅开发环境）：故障隔离演示页入口。
 */
import Link from "next/link";
import { Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import zh from "@/i18n/zh";
import { useAppConfig } from "@/app/_shell/AppConfigContext";
import { NavSettingsPanel } from "@/app/_shell/NavSettingsPanel";

export default function SettingsPage() {
  const { config, openConfigDialog } = useAppConfig();
  const showDiagnostics = process.env.NODE_ENV !== "production";

  return (
    <div className="h-full overflow-auto p-6">
      <h1 className="flex items-center gap-2 text-lg font-semibold">
        <Settings size={18} aria-hidden />
        {zh.shell.settingsTitle}
      </h1>

      <section
        className="mt-4 rounded-md border border-border bg-card p-4"
        data-settings-app
      >
        <h2 className="text-base font-semibold">{zh.shell.settingsAppTitle}</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {zh.shell.settingsAppHint}
        </p>
        <p
          className="mt-2 text-xs text-muted-foreground"
          data-settings-assistant
        >
          {config ? `${zh.app.assistantLabel}${config.assistantId}` : ""}
        </p>
        <Button
          variant="outline"
          size="sm"
          className="mt-3"
          onClick={openConfigDialog}
          data-settings-open-config
        >
          {zh.shell.settingsOpenConfig}
        </Button>
      </section>

      <NavSettingsPanel />

      {showDiagnostics && (
        <section
          className="mt-6 text-xs text-muted-foreground"
          data-settings-diagnostics
        >
          <h2 className="text-sm font-semibold text-foreground">
            {zh.shell.settingsDiagnosticsTitle}
          </h2>
          <p className="mt-1">{zh.shell.settingsDiagnosticsHint}</p>
          <Link
            href="/error-demo"
            prefetch={false}
            className="mt-2 inline-block text-primary underline"
            data-settings-error-demo
          >
            {zh.shell.settingsDiagnosticsErrorPage}
          </Link>
          <br />
          <Link
            href="/error-demo/recoverable"
            prefetch={false}
            className="text-primary underline"
            data-settings-error-demo-recoverable
          >
            {zh.shell.errorDemoRecoverTitle}
          </Link>
        </section>
      )}
    </div>
  );
}