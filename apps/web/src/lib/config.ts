export interface StandaloneConfig {
  deploymentUrl: string;
  assistantId: string;
  langsmithApiKey?: string;
}

const CONFIG_KEY = "deep-agent-config";

/**
 * 开发默认值：本项目的后端跑在 langgraph dev（见 apps/server）。
 * 可用 NEXT_PUBLIC_* 覆盖；用户在 Settings 里保存过的配置优先级最高。
 */
const DEFAULT_CONFIG: StandaloneConfig = {
  deploymentUrl: process.env.NEXT_PUBLIC_DEPLOYMENT_URL ?? "http://localhost:2024",
  assistantId: process.env.NEXT_PUBLIC_ASSISTANT_ID ?? "assistant",
  langsmithApiKey: process.env.NEXT_PUBLIC_LANGSMITH_API_KEY,
};

export function getConfig(): StandaloneConfig | null {
  if (typeof window === "undefined") return DEFAULT_CONFIG;

  const stored = localStorage.getItem(CONFIG_KEY);
  if (!stored) return DEFAULT_CONFIG;

  try {
    return JSON.parse(stored);
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function saveConfig(config: StandaloneConfig): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}