"use client";

/**
 * 模型清单里的一行：名称 / id / 来源 / 视觉能力 + 操作。
 *
 * ## 视觉这一列为什么这么啰嗦
 *
 * 「这个模型看不看得见图」有三种状态，而且**结论来自哪里**同样重要：
 * - 内置清单先验（我们猜的）→ 可以点「探测」用真实请求验证；
 * - 探测结论（实测的）→ 展示明细，用户能看模型当时答了什么；
 * - 手动指定（用户说的）→ 最高优先级，压过一切自动结论。
 *
 * 所以这里不做「一个开关搞定」：先给结论 + 来源，再给三个动作
 * （探测 / 标记支持 / 标记不支持 / 清除），把用户推进「有一个可信答案」的状态。
 */
import { useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import zh, { t } from "@/i18n/zh";
import { cn } from "@/lib/utils";
import {
  clearCapability,
  probeCapability,
  setCapability,
  type ModelView,
  type ProbeOutcome,
} from "@/lib/modelsApi";
import { VisionBadge, visionLabel } from "@/app/components/models/VisionBadge";

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface ModelRowProps {
  model: ModelView;
  isDefault: boolean;
  onSetDefault: (model: ModelView) => Promise<void>;
  onRefresh: () => Promise<void>;
  onRemove?: (model: ModelView) => Promise<void>;
}

export function ModelRow({ model, isDefault, onSetDefault, onRefresh, onRemove }: ModelRowProps) {
  const [busy, setBusy] = useState<"probe" | "default" | "capability" | "remove" | null>(null);
  const [probe, setProbe] = useState<ProbeOutcome | null>(null);

  async function runProbe() {
    setBusy("probe");
    try {
      const outcome = await probeCapability(model.providerId, model.id);
      setProbe(outcome);
      await onRefresh();
      if (outcome.vision === null) {
        toast.warning(t(zh.models.probeInconclusive, { reason: outcome.reason }));
      } else {
        toast.success(t(zh.models.probeOk, { reason: outcome.reason }));
      }
    } catch (err) {
      toast.error(t(zh.models.probeFail, { error: messageOf(err) }));
    } finally {
      setBusy(null);
    }
  }

  async function mark(vision: boolean | null) {
    setBusy("capability");
    try {
      if (vision === null) {
        await clearCapability(model.providerId, model.id);
        toast.success(zh.models.visionCleared);
      } else {
        await setCapability(model.providerId, model.id, vision);
        toast.success(vision ? zh.models.setVisionSupported : zh.models.setVisionUnsupported);
      }
      setProbe(null);
      await onRefresh();
    } catch (err) {
      toast.error(messageOf(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="border-b border-border/60 px-3 py-2 last:border-b-0" data-model-row={model.id}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{model.name}</span>
            <VisionBadge vision={model.vision} source={model.visionSource} />
            {isDefault && (
              <span className="rounded-full border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-[11px] leading-none text-primary">
                {zh.models.defaultTitle}
              </span>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <code className="rounded bg-muted px-1 py-0.5">{model.id}</code>
            <span>
              {model.source === "catalog"
                ? zh.models.sourceCatalog
                : model.source === "remote"
                  ? zh.models.sourceRemote
                  : zh.models.sourceManual}
            </span>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void runProbe()}
            disabled={busy !== null}
            title={zh.models.probeHint}
            data-model-probe
          >
            {busy === "probe" ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            {busy === "probe" ? zh.models.probing : zh.models.probe}
          </Button>

          {/* 手动指定：两个方向都摆出来，避免「开关一开默认是支持」这种隐含默认 */}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy !== null || model.vision === true}
            onClick={() => void mark(true)}
            title={zh.models.setVisionSupported}
          >
            {zh.models.visionSupported}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy !== null || model.vision === false}
            onClick={() => void mark(false)}
            title={zh.models.setVisionUnsupported}
          >
            {zh.models.visionUnsupported}
          </Button>
          {model.visionSource === "manual" && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy !== null}
              onClick={() => void mark(null)}
              title={zh.models.clearVision}
            >
              {zh.models.visionUnknown}
            </Button>
          )}

          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy !== null || isDefault}
            onClick={async () => {
              setBusy("default");
              try {
                await onSetDefault(model);
              } finally {
                setBusy(null);
              }
            }}
            data-model-set-default
          >
            {zh.models.defaultSet}
          </Button>

          {onRemove && model.source === "manual" && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              disabled={busy !== null}
              title={zh.models.removeModel}
              onClick={async () => {
                setBusy("remove");
                try {
                  await onRemove(model);
                } finally {
                  setBusy(null);
                }
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      {/* 探测明细：只在刚探完时显示，回答「它当时答了什么」 */}
      {probe && (
        <div className={cn("mt-2 rounded-md border border-border bg-muted/40 p-2 text-[11px]")} data-probe-detail>
          <div className="mb-1 font-medium">
            {zh.models.probeResultTitle}：{visionLabel(probe.vision)}
            <span className="ml-2 font-normal text-muted-foreground">{probe.reason}</span>
          </div>
          <ul className="space-y-0.5 text-muted-foreground">
            {probe.attempts.map((attempt, index) => (
              <li key={`${attempt.color}-${index}`}>
                {attempt.color}：
                {attempt.error
                  ? `${zh.models.probeAttemptError}（${attempt.error}）`
                  : `${attempt.correct ? zh.models.probeAttemptCorrect : zh.models.probeAttemptWrong} —— ${attempt.answer ?? ""}`}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
