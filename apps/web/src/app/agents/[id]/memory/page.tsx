"use client";

/**
 * 智能体长期记忆编辑页（路由 `/agents/[id]/memory`，任务 5.3）。
 *
 * 这份记忆**跨工作区共享**（specs/agent-registry「记忆跨工作区共享」）：
 * 在 A 工作区写入，在 B 工作区运行同一个智能体时也能读到。
 * 与项目记忆（`/memory/project`）完全分开，两个端点、两份草稿。
 */
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { MemoryEditor } from "@/app/components/memory/MemoryEditor";
import { getAgentMemory, putAgentMemory } from "@/lib/agentsApi";
import { useAgent } from "@/app/hooks/useAgents";
import zh, { t } from "@/i18n/zh";

export default function AgentMemoryPage() {
  const params = useParams<{ id: string }>();
  const id = typeof params?.id === "string" ? decodeURIComponent(params.id) : null;
  const { data } = useAgent(id);

  return (
    <div
      className="h-full overflow-auto p-6"
      data-agent-memory-page
      data-agent-id={id ?? ""}
    >
      <Link
        href={id ? `/agents/${encodeURIComponent(id)}` : "/agents"}
        prefetch={false}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:underline"
        data-agent-memory-back
      >
        <ArrowLeft size={13} />
        {zh.agents.detailTitle}
      </Link>

      <h1 className="mt-2 text-lg font-semibold">
        {data?.name ?? id ?? zh.memory.title}
        <span className="ml-2 text-sm font-normal text-muted-foreground">
          {zh.memory.agentTab}
        </span>
      </h1>

      <div className="mt-4">
        <MemoryEditor
          scope="agent-detail"
          title={zh.memory.agentTab}
          description={zh.memory.agentDesc}
          targetLabel={
            id ? t(zh.memory.agentTarget, { name: data?.name ?? id }) : undefined
          }
          placeholder={zh.memory.placeholderAgent}
          reloadKey={`agent:${id ?? "none"}`}
          blockedReason={id ? null : zh.memory.noWorkspace}
          loadErrorMessage={zh.memory.loadFailed}
          load={() => getAgentMemory(id as string)}
          save={(content) => putAgentMemory(id as string, content)}
        />
      </div>
    </div>
  );
}