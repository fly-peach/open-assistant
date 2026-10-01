"use client";

/**
 * 团队管理页（路由 `/agents/[id]/team`，任务 2.1 – 2.6）。
 *
 * 形态照抄 `/agents/[id]/memory`：**子路由 + 返回链接**，不是 tab
 * （既有配置页是单页滚动 section，全仓没有用过 `ui/tabs`）。
 *
 * 覆盖 specs/subagent-team「团队的可见与可编辑」：
 * - 列出全部子 agent 的名称与路由描述，**非法的照样列出**并标注原因；
 * - 编辑路由描述 / 工具白名单 / 模型 / 正文（系统提示词），一次 `PUT` 原子落盘；
 * - 新建子 agent（内联表单 → 建目录 + 写声明文件骨架）。
 *
 * 后端未就绪时展示可读错误态，不静默给空列表；保存被拒绝时把后端原因渲染到卡片上。
 */
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { ArrowLeft, RefreshCw, Users } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import zh, { t } from "@/i18n/zh";
import { createSubAgent, updateSubAgent, type SubAgentPatch } from "@/lib/teamApi";
import { useTeam } from "@/app/hooks/useAgents";
import { useModelsOverview } from "@/app/hooks/useModels";
import { groupModelsByProvider } from "@/app/components/models/ModelPicker";
import { SubAgentCreateForm } from "@/app/components/team/SubAgentCreateForm";
import { TeamMemberCard } from "@/app/components/team/TeamMemberCard";
import { sortMembers } from "@/app/utils/teamConfig";

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export default function AgentTeamPage() {
  const params = useParams<{ id: string }>();
  const id = typeof params?.id === "string" ? decodeURIComponent(params.id) : null;
  const [revision, setRevision] = useState(0);
  const { data, error, isLoading, mutate } = useTeam(id, revision);
  const models = useModelsOverview();
  const [creating, setCreating] = useState(false);

  /** 模型下拉的分组数据（可选项即「模型」页配置好的那些）。 */
  const modelGroups = useMemo(
    () => groupModelsByProvider(models.data?.models ?? []),
    [models.data]
  );
  const modelsReady = !models.isLoading && !models.error;

  const members = useMemo(() => sortMembers(data?.members ?? []), [data]);

  const refresh = useCallback(() => {
    setRevision((prev) => prev + 1);
    void mutate();
  }, [mutate]);

  const onCreate = useCallback(
    async (values: { name: string; description: string }) => {
      if (!id) return false;
      setCreating(true);
      try {
        const created = await createSubAgent(id, values);
        toast.success(t(zh.team.created, { name: created.name }));
        setRevision((prev) => prev + 1);
        await mutate();
        return true;
      } catch (err) {
        toast.error(t(zh.team.createFailed, { error: messageOf(err) }));
        return false;
      } finally {
        setCreating(false);
      }
    },
    [id, mutate]
  );

  /**
   * 保存一个成员：**故意不 catch** —— 让拒绝原因冒泡回卡片，
   * 由卡片渲染到 `data-team-save-error`（只弹 toast 的话，用户和 browser-use 都看不到原因）。
   */
  const onSaveMember = useCallback(
    async (name: string, patch: SubAgentPatch) => {
      if (!id) return;
      await updateSubAgent(id, name, patch);
      toast.success(zh.team.saved);
      await mutate();
    },
    [id, mutate]
  );

  return (
    <div className="h-full overflow-auto p-6" data-team-page data-agent-id={id ?? ""}>
      <Link
        href={id ? `/agents/${encodeURIComponent(id)}` : "/agents"}
        prefetch={false}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:underline"
        data-team-back
      >
        <ArrowLeft size={13} />
        {zh.team.backToAgent}
      </Link>

      <header className="mt-2 flex flex-wrap items-center gap-2">
        <Users size={18} aria-hidden />
        <h1 className="text-lg font-semibold">{zh.team.title}</h1>
        {id && <code className="text-xs text-muted-foreground">{id}</code>}
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          onClick={refresh}
          aria-label={zh.team.refresh}
          title={zh.team.refresh}
          data-team-refresh
        >
          <RefreshCw size={14} />
        </Button>
      </header>
      <p className="mt-1 max-w-3xl text-xs text-muted-foreground">{zh.team.tabHint}</p>
      {data?.teamDir && (
        <p className="mt-1 text-[11px] text-muted-foreground" data-team-root title={data.teamDir}>
          {zh.team.rootLabel}
          {"："}
          {data.teamDir}
        </p>
      )}

      <SubAgentCreateForm creating={creating} onCreate={onCreate} />

      {error && (
        <p
          className="mt-4 rounded-md border border-destructive/40 bg-card p-3 text-sm text-destructive"
          data-team-error
        >
          {t(zh.team.loadFailed, { error: messageOf(error) })}
        </p>
      )}
      {!error && isLoading && (
        <p className="mt-4 text-sm text-muted-foreground">{zh.common.loading}</p>
      )}

      {!error && !isLoading && members.length === 0 && (
        <div
          className="mt-4 rounded-md border border-dashed border-border p-4 text-center"
          data-team-empty
        >
          <p className="text-sm font-medium">{zh.team.empty}</p>
          <p className="mt-1 text-xs text-muted-foreground">{zh.team.emptyHint}</p>
        </div>
      )}

      {!error && members.length > 0 && (
        <section className="mt-6">
          <h2 className="text-base font-semibold" data-team-count>
            {t(zh.team.memberCount, { count: members.length })}
          </h2>
          <div className="mt-2 grid gap-3" data-team-list>
            {members.map((member) => (
              <TeamMemberCard
                key={member.name}
                member={member}
                catalog={data?.toolCatalog ?? []}
                modelGroups={modelGroups}
                modelsReady={modelsReady}
                onSave={(patch) => onSaveMember(member.name, patch)}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
