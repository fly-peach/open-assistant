"use client";

/**
 * 对话页的「可选模型」下拉（对齐 QwenPaw 在对话顶部提供模型切换的做法）。
 *
 * ## 数据怎么来
 *
 * - 可选集合：`GET /models`（所有**启用**供应商的模型清单：内置 ∪ 手工 ∪ 远端）；
 * - 当前值：`GET /models/selection?path=<工作区>` —— 由后端算「这轮真正会用哪个」，
 *   前端**不自己推导**。原因：回退链（agent 配置 → 全局默认 → 环境变量）与
 *   供应商 key 都只有后端知道，前端猜一个「看起来对」的值最容易骗人。
 *
 * ## 选中后发生什么
 *
 * `PUT /models/selection` 把 `{providerId, modelId}` 写进**绑定 agent 的 config.json**，
 * 后端据此在下一轮 `wrapModelCall` 换模型（不用重启、不用重新建图）。
 *
 * ## 为什么跑的时候不让切
 *
 * 一个 run 里模型会被调用多次。跑到一半换模型会出现「前半段 A、后半段 B」，
 * 排查问题时没人能复现。所以流式进行中禁用下拉（`pickerLocked`）。
 */
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import zh, { t } from "@/i18n/zh";
import { cn } from "@/lib/utils";
import { modelKey, parseModelKey, putSelection, PROVIDER_KIND_LABEL, type ModelView } from "@/lib/modelsApi";
import { useModelsOverview, useModelSelection } from "@/app/hooks/useModels";
import { useChatContext } from "@/providers/ChatProvider";
import { useWorkspaceContext } from "@/providers/WorkspaceProvider";
import { VisionBadge } from "@/app/components/models/VisionBadge";

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface ProviderGroup {
  providerId: string;
  providerName: string;
  providerKind: ModelView["providerKind"];
  models: ModelView[];
}

/** 按供应商分组（保持后端返回的顺序：内置三家在前，自定义在后）。 */
export function groupModelsByProvider(models: ModelView[]): ProviderGroup[] {
  const groups: ProviderGroup[] = [];
  const index = new Map<string, ProviderGroup>();
  for (const model of models) {
    let group = index.get(model.providerId);
    if (!group) {
      group = {
        providerId: model.providerId,
        providerName: model.providerName,
        providerKind: model.providerKind,
        models: [],
      };
      index.set(model.providerId, group);
      groups.push(group);
    }
    group.models.push(model);
  }
  return groups;
}

/** 下拉项里的能力提示文字（SelectItem 里放不了徽标，用后缀文字 + 触发器上的徽标代替） */
function visionSuffix(vision: boolean | null): string {
  if (vision === true) return ` · ${zh.models.visionSupported}`;
  if (vision === false) return "";
  return ` · ${zh.models.visionUnknown}`;
}

export function ModelPicker({ className }: { className?: string }) {
  const { workspacePath } = useWorkspaceContext();
  const router = useRouter();
  const { isLoading: running } = useChatContext();
  const overview = useModelsOverview();
  const selection = useModelSelection(workspacePath);
  const [busy, setBusy] = useState(false);

  const groups = useMemo(() => groupModelsByProvider(overview.data?.models ?? []), [overview.data]);

  const current = selection.data?.effective ?? null;
  const value = current ? modelKey(current.providerId, current.modelId) : "";

  // 工作区都没选 / 后端说这个工作区还没绑 agent：不给切，并说明下一步做什么
  const gate = (() => {
    if (!workspacePath) return zh.models.pickerNeedWorkspace;
    if (selection.error) {
      const message = messageOf(selection.error);
      return message.includes("AGENT_NOT_BOUND") || message.includes("尚未绑定")
        ? zh.models.pickerNoAgent
        : null;
    }
    if (selection.data && !current) return zh.models.pickerEmptyHint;
    return null;
  })();

  const disabled = gate !== null || busy || running || !workspacePath;

  async function handleChange(next: string) {
    const parsed = parseModelKey(next);
    if (!parsed || !workspacePath) return;
    setBusy(true);
    try {
      const updated = await putSelection(workspacePath, parsed.providerId, parsed.modelId);
      await selection.mutate(updated, { revalidate: false });
      toast.success(t(zh.models.pickerChanged, { name: updated.effective?.modelName ?? parsed.modelId }));
    } catch (err) {
      toast.error(t(zh.models.pickerChangeFailed, { error: messageOf(err) }));
    } finally {
      setBusy(false);
    }
  }

  const label = current ? current.modelName : zh.models.pickerEmpty;
  const title = gate ?? t(zh.models.pickerLabel);

  return (
    <div className={cn("flex items-center gap-1", className)} data-model-picker>
      <Select value={value} onValueChange={(next) => void handleChange(next)} disabled={disabled}>
        <SelectTrigger
          aria-label={zh.models.pickerLabel}
          title={title}
          data-model-picker-trigger
          className={cn(
            "h-8 w-auto max-w-[220px] gap-1 rounded-full border-border px-3 text-xs",
            "focus:ring-1 focus:ring-ring"
          )}
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          <SelectValue placeholder={label}>{label}</SelectValue>
        </SelectTrigger>
        <SelectContent align="start" className="max-h-80">
          {groups.map((group) => (
            <SelectGroup key={group.providerId}>
              <SelectLabel className="pl-2 text-[11px] font-normal text-muted-foreground">
                {group.providerName}
                <span className="ml-1 opacity-60">
                  {PROVIDER_KIND_LABEL[group.providerKind] ?? group.providerKind}
                </span>
              </SelectLabel>
              {group.models.map((model) => (
                <SelectItem key={modelKey(model.providerId, model.id)} value={modelKey(model.providerId, model.id)}>
                  {model.name}
                  {model.name !== model.id ? (
                    <span className="ml-1 text-[11px] text-muted-foreground">{model.id}</span>
                  ) : null}
                  <span className="text-[11px] text-muted-foreground">{visionSuffix(model.vision)}</span>
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
          {groups.length === 0 && (
            <div className="px-2 py-3 text-xs text-muted-foreground">{zh.models.pickerEmptyHint}</div>
          )}
        </SelectContent>
      </Select>

      {/* 当前模型的视觉能力：结论来源放进 title，用户能追问「你怎么知道的」 */}
      {current && <VisionBadge vision={current.vision} compact />}

      <Button
        type="button"
        variant="ghost"
        size="sm"
        title={`${zh.models.pickerManage}（${current?.providerName ?? ""}）`}
        aria-label={zh.models.pickerManage}
        onClick={() => router.push("/models")}
        className="h-8 w-8 p-0"
      >
        <Sparkles size={14} />
      </Button>
    </div>
  );
}
