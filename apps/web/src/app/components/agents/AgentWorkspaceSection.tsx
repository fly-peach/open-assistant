"use client";

/**
 * 「智能体配置页 → 工作区」区块（对应 design 2026-10-01：工作区是 agent 身份的一部分）。
 *
 * 为什么放在配置页：照 QwenPaw 的 `AgentProfileRef { id, workspace_dir, ... }`，
 * **agent ↔ 工作区目录是 1:1** —— 「这个助手维护哪个目录」跟人设 / 模型一样属于它的定义，
 * 所以配置跟它们同页；选择器只负责在几个 agent 之间切，不负责补配置。
 *
 * 1:1 的另一半由后端强制：一个目录已经由别的 agent 维护时，这里是 409 并给出是谁。
 */
import React, { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { DirectoryPicker } from "@/app/components/workspace/DirectoryPicker";
import { PathLabel } from "@/app/components/workspace/PathLabel";
import { openWorkspace } from "@/lib/workspaceApi";
import { getAgentProfiles, setAgentWorkspaceDir } from "@/lib/agentProfilesApi";
import zh from "@/i18n/zh";

export function AgentWorkspaceSection({ agentId }: { agentId: string }) {
  const [workspaceDir, setWorkspaceDir] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    try {
      const view = await getAgentProfiles(null);
      setWorkspaceDir(view.agents.find((a) => a.id === agentId)?.workspaceDir ?? null);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoaded(true);
    }
  }, [agentId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const assign = useCallback(
    async (path: string, create: boolean) => {
      setBusy(true);
      setError(null);
      try {
        // 选的是还没建的目录 → 先让后端建出来，再认领给这个 agent
        if (create) await openWorkspace(path, true);
        await setAgentWorkspaceDir(agentId, path);
        await reload();
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [agentId, reload],
  );

  const release = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await setAgentWorkspaceDir(agentId, null);
      await reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [agentId, reload]);

  return (
    <section className="rounded-md border border-border bg-card p-4" data-agent-workspace>
      <h2 className="text-base font-semibold">{zh.agentWorkspace.title}</h2>
      <p className="mt-1 text-xs text-muted-foreground">{zh.agentWorkspace.hint}</p>

      <div className="mt-3 rounded border border-border-light p-3" data-agent-workspace-value>
        {!loaded ? (
          <p className="text-xs text-muted-foreground">{zh.common.loading}</p>
        ) : workspaceDir ? (
          <PathLabel path={workspaceDir} className="text-xs" />
        ) : (
          <p className="text-xs text-muted-foreground" data-agent-workspace-empty>
            {zh.agentWorkspace.notSet}
          </p>
        )}
      </div>

      {error && (
        <p className="mt-2 text-xs text-[var(--color-error)]" data-agent-workspace-error>
          {error}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          data-agent-workspace-pick
          disabled={busy}
          onClick={() => setPickerOpen(true)}
        >
          {workspaceDir ? zh.agentWorkspace.change : zh.agentWorkspace.pick}
        </Button>
        {workspaceDir && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-agent-workspace-release
            disabled={busy}
            onClick={() => void release()}
          >
            {zh.agentWorkspace.release}
          </Button>
        )}
      </div>

      <DirectoryPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        initialPath={workspaceDir}
        onSubmit={async (path, create) => {
          await assign(path, create);
          setPickerOpen(false);
        }}
      />
    </section>
  );
}

export default AgentWorkspaceSection;