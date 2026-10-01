"use client";

/**
 * 首次运行引导（三件事）：指定工作区 → 自动创建四位个人助理 → 开始使用。
 *
 * 「自动创建」在选定工作区后就触发（调 `POST /agents/ensure-personal`，幂等，
 * 已存在的 agent 不覆盖）。四位的预加载人设 / 工具 / 技能见后端 `agents/personal-assistants.ts`。
 *
 * 是否已引导由 localStorage 记（`open-assistant.onboarded`），不阻塞老用户。
 */
import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, FolderOpen, Loader2, Sparkles, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DirectoryPicker } from "@/app/components/workspace/DirectoryPicker";
import { useWorkspaceContext } from "@/providers/WorkspaceProvider";
import { ensurePersonalAssistants } from "@/lib/agentsApi";
import zh, { t } from "@/i18n/zh";

export function FirstRunOnboarding({ onDismiss }: { onDismiss: () => void }) {
  const { workspacePath, openWorkspace, isOpening } = useWorkspaceContext();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [summary, setSummary] = useState<{ created: string[]; skipped: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const seed = useCallback(async () => {
    setSeeding(true);
    setError(null);
    try {
      setSummary(await ensurePersonalAssistants());
    } catch (err) {
      setError(t(zh.onboarding.failed, { error: (err as Error).message }));
    } finally {
      setSeeding(false);
    }
  }, []);

  // 选好工作区即自动创建（幂等）；失败可点「开始使用」重试
  useEffect(() => {
    if (workspacePath && !summary && !seeding) void seed();
  }, [workspacePath, summary, seeding, seed]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm">
      <div
        className="w-full max-w-lg rounded-lg border border-border bg-card p-6 shadow-lg"
        data-onboarding
        role="dialog"
        aria-modal="true"
        aria-label={zh.onboarding.title}
      >
        <div className="flex items-start gap-2">
          <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-warning)]" />
          <h2 className="text-base font-semibold">{zh.onboarding.title}</h2>
          <button
            type="button"
            onClick={onDismiss}
            className="ml-auto rounded p-1 text-muted-foreground hover:bg-accent"
            aria-label={zh.onboarding.skip}
          >
            <X size={14} />
          </button>
        </div>

        <div className="mt-4 space-y-3 text-sm">
          <div className="rounded border border-border p-3">
            <p className="font-medium">{zh.onboarding.step1}</p>
            <p className="mt-1 text-xs text-muted-foreground">{zh.onboarding.step1hint}</p>
            <div className="mt-2">
              {workspacePath ? (
                <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                  <CheckCircle2 size={13} />
                  {zh.onboarding.workspaceReady}
                </span>
              ) : (
                <Button
                  size="sm"
                  onClick={() => setPickerOpen(true)}
                  disabled={isOpening}
                  data-onboarding-pick
                >
                  {isOpening ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <FolderOpen className="mr-2 h-4 w-4" />
                  )}
                  {zh.onboarding.pick}
                </Button>
              )}
            </div>
          </div>

          <div className="rounded border border-border p-3">
            <p className="font-medium">{zh.onboarding.step2}</p>
            <p className="mt-1 text-xs text-muted-foreground">{zh.onboarding.step2hint}</p>
            <div className="mt-2 space-y-1 text-xs">
              {!workspacePath && <span className="text-muted-foreground">—</span>}
              {workspacePath && seeding && (
                <span className="inline-flex items-center gap-1 text-muted-foreground">
                  <Loader2 size={12} className="animate-spin" />
                  {zh.onboarding.creating}
                </span>
              )}
              {summary && summary.created.length > 0 && (
                <p className="text-emerald-600 dark:text-emerald-400">
                  {t(zh.onboarding.created, { names: summary.created.join("、") })}
                </p>
              )}
              {summary && summary.skipped.length > 0 && (
                <p className="text-muted-foreground">
                  {t(zh.onboarding.skipped, { names: summary.skipped.join("、") })}
                </p>
              )}
              {error && <p className="text-[var(--color-error)]">{error}</p>}
            </div>
          </div>
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onDismiss}>
            {zh.onboarding.skip}
          </Button>
          <Button
            size="sm"
            onClick={onDismiss}
            disabled={!workspacePath || seeding}
            data-onboarding-done
          >
            {zh.onboarding.done}
          </Button>
        </div>
      </div>

      <DirectoryPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        initialPath={workspacePath}
        onSubmit={async (path, create) => {
          await openWorkspace(path, create);
        }}
      />
    </div>
  );
}

export default FirstRunOnboarding;