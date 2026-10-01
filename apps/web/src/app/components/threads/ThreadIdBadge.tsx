"use client";

/**
 * 当前会话的 thread 标识（任务 5.7，对齐 design D5）：
 * 顶部展示**短 id**（uuid 前 8 位）+ 一个复制按钮，复制得到**完整 uuid**。
 * URL 里的 `?threadId=` 始终是完整标识（可分享、可刷新）。
 */
import { useCallback, useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import zh from "@/i18n/zh";
import { shortId } from "@/app/utils/agentConfig";

export function ThreadIdBadge({ threadId }: { threadId: string }) {
  const [copied, setCopied] = useState(false);

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(threadId);
      setCopied(true);
      toast.success(zh.threadId.copied);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(zh.threadId.copyFailed);
    }
  }, [threadId]);

  return (
    <span
      className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-1.5 py-0.5 text-[11px]"
      data-thread-id={threadId}
      title={`${zh.threadId.fullLabel}: ${threadId}`}
    >
      <span className="text-muted-foreground">{zh.threadId.label}</span>
      <code data-thread-id-short>{shortId(threadId)}</code>
      <button
        type="button"
        onClick={() => void onCopy()}
        aria-label={zh.threadId.copy}
        title={zh.threadId.copy}
        data-thread-id-copy
        className="rounded p-0.5 text-muted-foreground hover:bg-accent"
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
      {copied && (
        <span
          className="text-muted-foreground"
          data-thread-id-copied
        >
          {zh.common.copied}
        </span>
      )}
    </span>
  );
}

export default ThreadIdBadge;