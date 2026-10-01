"use client";

/**
 * 新建子 agent 的内联表单（不是弹窗 —— 本仓的弹窗只用于「配置地址」「选目录」这类模态场景，
 * `/agents` 的新建同样是内联表单）。
 *
 * 目录名就是标识，创建后不可更改；前端先按与主 agent 同一套规则挡一层
 * （非空 / 无分隔符 / 无 `..` / 无空白 / 字符集），**权威判定仍然后端**。
 * `description` 是必填：它是主 agent 的路由依据，留空会让新建出来的成员立刻是非法声明，
 * 所以这里当普通必填项处理，为空就不提交。
 */
import { useState } from "react";
import { Loader2, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import zh from "@/i18n/zh";
import {
  subAgentIdErrorText,
  validateSubAgentName,
} from "@/app/utils/teamConfig";
import type { AgentIdError } from "@/app/utils/agentConfig";

export interface SubAgentCreateFormProps {
  creating: boolean;
  /** 返回 `true` 表示创建成功（表单随即清空）。 */
  onCreate: (values: { name: string; description: string }) => Promise<boolean>;
}

export function SubAgentCreateForm({ creating, onCreate }: SubAgentCreateFormProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [idError, setIdError] = useState<AgentIdError>(null);
  const [descriptionError, setDescriptionError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const reason = validateSubAgentName(name);
    setIdError(reason);
    if (reason) return;
    if (!description.trim()) {
      setDescriptionError(zh.team.noDescription);
      return;
    }
    setDescriptionError(null);
    const ok = await onCreate({ name: name.trim(), description: description.trim() });
    if (ok) {
      setName("");
      setDescription("");
    }
  };

  return (
    <section className="mt-4 rounded-md border border-border bg-card p-4" data-team-create>
      <h2 className="text-base font-semibold">{zh.team.createTitle}</h2>
      <p className="mt-1 text-xs text-muted-foreground">{zh.team.createHint}</p>
      <form className="mt-3 grid gap-3 sm:grid-cols-2" onSubmit={(event) => void submit(event)}>
        <div className="space-y-1.5">
          <Label htmlFor="team-new-name">{zh.team.nameLabel}</Label>
          <Input
            id="team-new-name"
            data-team-name-input
            value={name}
            placeholder={zh.team.namePlaceholder}
            onChange={(event) => {
              setName(event.target.value);
              if (idError) setIdError(null);
            }}
          />
          {idError && (
            <p className="text-xs text-destructive" data-team-name-error>
              {subAgentIdErrorText(idError)}
            </p>
          )}
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="team-new-description">{zh.team.descriptionLabel}</Label>
          <Textarea
            id="team-new-description"
            data-team-description-input
            rows={2}
            value={description}
            placeholder={zh.team.descriptionPlaceholder}
            onChange={(event) => {
              setDescription(event.target.value);
              if (descriptionError) setDescriptionError(null);
            }}
          />
          <p className="text-[11px] text-muted-foreground">{zh.team.descriptionHint}</p>
          {descriptionError && (
            <p className="text-xs text-destructive" data-team-description-error>
              {descriptionError}
            </p>
          )}
        </div>
        <div className="sm:col-span-2">
          <Button type="submit" size="sm" disabled={creating} data-team-create-submit>
            {creating ? <Loader2 className="animate-spin" size={14} /> : <Plus size={14} />}
            {creating ? zh.team.creating : zh.team.create}
          </Button>
        </div>
      </form>
    </section>
  );
}
