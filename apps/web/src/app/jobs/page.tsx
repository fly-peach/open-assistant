"use client";

/**
 * 定时任务页（路由 `/jobs`，任务 6.1 / 6.2 / 6.4；替换原占位 `/cron`）。
 *
 * - 任务保存在**本工作区**（`.open-assistant/jobs.json`），所有请求都带 `path`，
 *   因此两个工作区的任务互不可见（specs/agent-scheduling「任务只在所属工作区触发」）；
 * - 表单字段对齐 spec：一次性/周期、时区、结束条件、投递方式、静默、运行约束、
 *   内容形态（固定文本 / 交给智能体）与心跳标记；
 * - 后端未就绪时展示可读错误态，不静默给空列表。
 */
import { useCallback, useMemo, useState } from "react";
import { CalendarClock, Loader2, Pencil, Play, Plus, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import zh, { t } from "@/i18n/zh";
import { useWorkspaceContext } from "@/providers/WorkspaceProvider";
import { useJobs } from "@/app/hooks/useAgents";
import {
  createJob,
  deleteJob,
  emptyJob,
  formToJob,
  jobFormError,
  jobPayload,
  jobToForm,
  localTimezone,
  updateJob,
  type JobFormState,
  type JobSpec,
} from "@/lib/jobsApi";

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type EditTarget = { mode: "create" } | { mode: "edit"; job: JobSpec };

function scheduleSummary(job: JobSpec): string {
  const timezone = job.schedule.timezone ?? "";
  const base =
    job.schedule.kind === "once"
      ? t(zh.jobs.summaryOnce, { at: job.schedule.at ?? "" })
      : t(zh.jobs.summaryPeriodic, { cron: job.schedule.cron ?? "", tz: timezone });
  const end = job.schedule.end;
  if (!end || end.kind === "never") return `${base}${zh.jobs.summaryEndNever}`;
  if (end.kind === "until") return `${base}${t(zh.jobs.summaryEndUntil, { until: end.until ?? "" })}`;
  return `${base}${t(zh.jobs.summaryEndCount, { count: end.count ?? 0 })}`;
}

export default function JobsPage() {
  const { workspacePath } = useWorkspaceContext();
  const { data, error, isLoading, mutate } = useJobs(workspacePath);
  const [target, setTarget] = useState<EditTarget | null>(null);
  const [form, setForm] = useState<JobFormState>(() => jobToForm(emptyJob(localTimezone())));
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const patch = useCallback((next: Partial<JobFormState>) => {
    setForm((prev) => ({ ...prev, ...next }));
    setFormError(null);
  }, []);

  const openCreate = useCallback(() => {
    const draft = emptyJob(localTimezone());
    setForm(jobToForm(draft));
    setFormError(null);
    setTarget({ mode: "create" });
  }, []);

  const openEdit = useCallback((job: JobSpec) => {
    setForm(jobToForm(job));
    setFormError(null);
    setTarget({ mode: "edit", job });
  }, []);

  const jobs = useMemo(() => data ?? [], [data]);

  const submit = useCallback(async () => {
    if (!workspacePath || !target) return;
    const invalid = jobFormError(form);
    if (invalid === "name") {
      setFormError(zh.jobs.nameRequired);
      return;
    }
    if (invalid === "silentText") {
      setFormError(zh.jobs.silentUnsupported);
      return;
    }
    setSaving(true);
    try {
      if (target.mode === "create") {
        await createJob(workspacePath, formToJob(form));
      } else {
        await updateJob(workspacePath, target.job.id, jobPayload(formToJob(form, target.job)));
      }
      toast.success(zh.jobs.saved);
      setTarget(null);
      await mutate();
    } catch (err) {
      toast.error(t(zh.jobs.saveFailed, { error: messageOf(err) }));
    } finally {
      setSaving(false);
    }
  }, [workspacePath, target, form, mutate]);

  const toggle = useCallback(
    async (job: JobSpec) => {
      if (!workspacePath) return;
      try {
        await updateJob(workspacePath, job.id, { enabled: !job.enabled });
        await mutate();
      } catch (err) {
        toast.error(t(zh.jobs.toggleFailed, { error: messageOf(err) }));
      }
    },
    [workspacePath, mutate]
  );

  const remove = useCallback(
    async (job: JobSpec) => {
      if (!workspacePath) return;
      try {
        await deleteJob(workspacePath, job.id);
        toast.success(zh.jobs.deleted);
        await mutate();
      } catch (err) {
        toast.error(t(zh.jobs.deleteFailed, { error: messageOf(err) }));
      }
    },
    [workspacePath, mutate]
  );

  if (!workspacePath) {
    return (
      <div
        className="h-full p-6"
        data-jobs-page
      >
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <CalendarClock size={18} aria-hidden />
          {zh.jobs.title}
        </h1>
        <p
          className="mt-3 rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground"
          data-jobs-no-workspace
        >
          {zh.jobs.noWorkspace}
        </p>
      </div>
    );
  }

  return (
    <div
      className="h-full overflow-auto p-6"
      data-jobs-page
      data-jobs-workspace={workspacePath}
    >
      <header className="flex items-center gap-2">
        <CalendarClock size={18} aria-hidden />
        <h1 className="text-lg font-semibold">{zh.jobs.title}</h1>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void mutate()}
            aria-label={zh.workspace.refresh}
            title={zh.workspace.refresh}
            data-jobs-refresh
          >
            <RefreshCw size={14} />
          </Button>
          <Button
            size="sm"
            onClick={openCreate}
            data-jobs-create
          >
            <Plus size={14} />
            {zh.jobs.create}
          </Button>
        </div>
      </header>
      <p className="mt-1 max-w-3xl text-xs text-muted-foreground">{zh.jobs.hint}</p>

      {target && (
        <section
          className="mt-4 rounded-md border border-border bg-card p-4"
          data-jobs-form
          data-jobs-form-mode={target.mode}
        >
          <h2 className="text-base font-semibold">
            {target.mode === "create" ? zh.jobs.createTitle : zh.jobs.editTitle}
          </h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="job-name">{zh.jobs.nameLabel}</Label>
              <Input
                id="job-name"
                data-job-name
                value={form.name}
                placeholder={zh.jobs.namePlaceholder}
                onChange={(event) => patch({ name: event.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="job-content-kind">{zh.jobs.contentKindLabel}</Label>
              <select
                id="job-content-kind"
                data-job-content-kind
                className="h-9 rounded-md border border-border bg-background px-2 text-sm"
                value={form.contentKind}
                onChange={(event) =>
                  patch({ contentKind: event.target.value as JobFormState["contentKind"] })
                }
              >
                <option value="agent">{zh.jobs.contentKindAgent}</option>
                <option value="text">{zh.jobs.contentKindText}</option>
              </select>
            </div>

            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="job-content-text">
                {form.contentKind === "text"
                  ? zh.jobs.contentTextLabel
                  : zh.jobs.contentAgentLabel}
              </Label>
              <Textarea
                id="job-content-text"
                data-job-content-text
                rows={3}
                value={form.contentText}
                placeholder={
                  form.contentKind === "text"
                    ? zh.jobs.contentTextPlaceholder
                    : zh.jobs.contentAgentPlaceholder
                }
                onChange={(event) => patch({ contentText: event.target.value })}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="job-schedule-kind">{zh.jobs.scheduleKindLabel}</Label>
              <select
                id="job-schedule-kind"
                data-job-schedule-kind
                className="h-9 rounded-md border border-border bg-background px-2 text-sm"
                value={form.scheduleKind}
                onChange={(event) =>
                  patch({ scheduleKind: event.target.value as JobFormState["scheduleKind"] })
                }
              >
                <option value="periodic">{zh.jobs.schedulePeriodic}</option>
                <option value="once">{zh.jobs.scheduleOnce}</option>
              </select>
            </div>

            {form.scheduleKind === "once" ? (
              <div className="space-y-1.5">
                <Label htmlFor="job-at">{zh.jobs.onceAtLabel}</Label>
                <Input
                  id="job-at"
                  data-job-at
                  value={form.at}
                  placeholder="2026-01-01 09:00"
                  onChange={(event) => patch({ at: event.target.value })}
                />
                <p className="text-[11px] text-muted-foreground">{zh.jobs.onceAtHint}</p>
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor="job-cron">{zh.jobs.cronLabel}</Label>
                <Input
                  id="job-cron"
                  data-job-cron
                  value={form.cron}
                  placeholder="0 9 * * *"
                  onChange={(event) => patch({ cron: event.target.value })}
                />
                <p className="text-[11px] text-muted-foreground">{zh.jobs.cronHint}</p>
              </div>
            )}

            {form.scheduleKind === "periodic" && (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="job-timezone">{zh.jobs.timezoneLabel}</Label>
                  <Input
                    id="job-timezone"
                    data-job-timezone
                    value={form.timezone}
                    onChange={(event) => patch({ timezone: event.target.value })}
                  />
                  <p className="text-[11px] text-muted-foreground">{zh.jobs.timezoneHint}</p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="job-end-kind">{zh.jobs.endLabel}</Label>
                  <select
                    id="job-end-kind"
                    data-job-end-kind
                    className="h-9 rounded-md border border-border bg-background px-2 text-sm"
                    value={form.endKind}
                    onChange={(event) =>
                      patch({ endKind: event.target.value as JobFormState["endKind"] })
                    }
                  >
                    <option value="never">{zh.jobs.endNever}</option>
                    <option value="until">{zh.jobs.endUntil}</option>
                    <option value="count">{zh.jobs.endCount}</option>
                  </select>
                </div>
                {form.endKind === "until" && (
                  <div className="space-y-1.5">
                    <Label htmlFor="job-end-until">{zh.jobs.endUntilLabel}</Label>
                    <Input
                      id="job-end-until"
                      data-job-end-until
                      value={form.endUntil}
                      onChange={(event) => patch({ endUntil: event.target.value })}
                    />
                  </div>
                )}
                {form.endKind === "count" && (
                  <div className="space-y-1.5">
                    <Label htmlFor="job-end-count">{zh.jobs.endCountLabel}</Label>
                    <Input
                      id="job-end-count"
                      data-job-end-count
                      type="number"
                      min={1}
                      value={form.endCount}
                      onChange={(event) => patch({ endCount: event.target.value })}
                    />
                  </div>
                )}
              </>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="job-dispatch">{zh.jobs.dispatchLabel}</Label>
              <select
                id="job-dispatch"
                data-job-dispatch
                className="h-9 rounded-md border border-border bg-background px-2 text-sm"
                value={form.dispatchMode}
                onChange={(event) =>
                  patch({ dispatchMode: event.target.value as JobFormState["dispatchMode"] })
                }
              >
                <option value="stream">{zh.jobs.dispatchStream}</option>
                <option value="final">{zh.jobs.dispatchFinal}</option>
              </select>
            </div>

            <div className="space-y-1.5">
              <span className="text-sm font-medium">{zh.jobs.runtimeLabel}</span>
              <div className="grid grid-cols-3 gap-2">
                <label className="text-xs text-muted-foreground">
                  {zh.jobs.concurrencyLabel}
                  <Input
                    data-job-concurrency
                    type="number"
                    min={1}
                    value={form.concurrency}
                    onChange={(event) => patch({ concurrency: event.target.value })}
                  />
                </label>
                <label className="text-xs text-muted-foreground">
                  {zh.jobs.timeoutLabel}
                  <Input
                    data-job-timeout
                    type="number"
                    min={0}
                    value={form.timeoutSeconds}
                    onChange={(event) => patch({ timeoutSeconds: event.target.value })}
                  />
                </label>
                <label className="text-xs text-muted-foreground">
                  {zh.jobs.graceLabel}
                  <Input
                    data-job-grace
                    type="number"
                    min={0}
                    value={form.graceSeconds}
                    onChange={(event) => patch({ graceSeconds: event.target.value })}
                  />
                </label>
              </div>
            </div>

            <div className="space-y-2">
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  data-job-silent
                  className="mt-0.5"
                  checked={form.silent}
                  disabled={form.contentKind === "text"}
                  onChange={(event) => patch({ silent: event.target.checked })}
                />
                <span>
                  {zh.jobs.silentLabel}
                  <span className="block text-xs text-muted-foreground">
                    {form.contentKind === "text"
                      ? zh.jobs.silentUnsupported
                      : zh.jobs.silentHint}
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  data-job-heartbeat
                  className="mt-0.5"
                  checked={form.heartbeat}
                  onChange={(event) => patch({ heartbeat: event.target.checked })}
                />
                <span>
                  {zh.jobs.heartbeatLabel}
                  <span className="block text-xs text-muted-foreground">
                    {zh.jobs.heartbeatHint}
                  </span>
                </span>
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  data-job-enabled
                  checked={form.enabled}
                  onChange={(event) => patch({ enabled: event.target.checked })}
                />
                {zh.jobs.enabledLabel}
              </label>
            </div>
          </div>

          {formError && (
            <p
              className="mt-3 rounded border border-destructive/40 p-2 text-xs text-destructive"
              data-jobs-form-error
            >
              {formError}
            </p>
          )}

          <div className="mt-4 flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => void submit()}
              disabled={saving}
              data-job-submit
            >
              {saving ? <Loader2 className="animate-spin" size={14} /> : null}
              {saving ? zh.jobs.saving : zh.jobs.save}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setTarget(null)}
              data-job-cancel
            >
              {zh.jobs.cancel}
            </Button>
          </div>
        </section>
      )}

      {error && (
        <p
          className="mt-4 rounded-md border border-destructive/40 bg-card p-3 text-sm text-destructive"
          data-jobs-error
        >
          {t(zh.jobs.loadFailed, { error: messageOf(error) })}
        </p>
      )}
      {!error && isLoading && (
        <p className="mt-4 text-sm text-muted-foreground">{zh.common.loading}</p>
      )}
      {!error && !isLoading && jobs.length === 0 && (
        <div
          className="mt-4 rounded-md border border-dashed border-border p-4 text-center"
          data-jobs-empty
        >
          <p className="text-sm font-medium">{zh.jobs.empty}</p>
          <p className="mt-1 text-xs text-muted-foreground">{zh.jobs.emptyHint}</p>
        </div>
      )}

      {!error && jobs.length > 0 && (
        <ul
          className="mt-4 grid gap-2"
          data-jobs-list
        >
          {jobs.map((job) => (
            <li
              key={job.id}
              className="rounded-md border border-border bg-card p-3"
              data-job-item
              data-job-id={job.id}
              data-job-enabled={job.enabled ? "true" : "false"}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold">{job.name || job.id}</span>
                <span
                  className="rounded border border-border px-1.5 py-0.5 text-[11px]"
                  data-job-state
                >
                  {job.enabled ? zh.jobs.on : zh.jobs.off}
                </span>
                {job.heartbeat && (
                  <span
                    className="rounded border border-border px-1.5 py-0.5 text-[11px]"
                    data-job-heartbeat-tag
                  >
                    {zh.jobs.heartbeatTag}
                  </span>
                )}
                <span className="text-xs text-muted-foreground" data-job-schedule>
                  {scheduleSummary(job)}
                </span>
                <div className="ml-auto flex items-center gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void toggle(job)}
                    data-job-toggle
                  >
                    <Play size={13} />
                    {job.enabled ? zh.jobs.disable : zh.jobs.enable}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => openEdit(job)}
                    aria-label={zh.jobs.edit}
                    title={zh.jobs.edit}
                    data-job-edit
                  >
                    <Pencil size={13} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void remove(job)}
                    aria-label={zh.jobs.delete}
                    title={zh.jobs.delete}
                    data-job-delete
                  >
                    <Trash2 size={13} />
                  </Button>
                </div>
              </div>

              <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                <span data-job-tag-content>
                  {job.content.kind === "text" ? zh.jobs.tagText : zh.jobs.tagAgent}
                </span>
                <span data-job-tag-dispatch>
                  {job.dispatch.mode === "stream"
                    ? zh.jobs.tagDispatchStream
                    : zh.jobs.tagDispatchFinal}
                </span>
                {job.silent && <span data-job-tag-silent>{zh.jobs.tagSilent}</span>}
                {job.nextRunAt && (
                  <span data-job-next>
                    {t(zh.jobs.nextRun, { time: job.nextRunAt })}
                  </span>
                )}
              </div>

              {job.content.text && (
                <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                  {job.content.text}
                </p>
              )}

              <div className="mt-2 text-[11px] text-muted-foreground" data-job-runs>
                <span className="font-medium">{zh.jobs.lastRuns}</span>
                {job.lastRuns && job.lastRuns.length > 0 ? (
                  <ul className="mt-0.5 grid gap-0.5">
                    {job.lastRuns.map((run) => (
                      <li
                        key={`${run.at}-${run.status}`}
                        data-job-run-status={run.status}
                      >
                        {run.at} ·{" "}
                        {
                          {
                            ok: zh.jobs.runOk,
                            error: zh.jobs.runError,
                            skipped: zh.jobs.runSkipped,
                            running: zh.jobs.runRunning,
                          }[run.status]
                        }
                        {run.message ? ` · ${run.message}` : ""}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span className="ml-1">{zh.jobs.lastRunsEmpty}</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}