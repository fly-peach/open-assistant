import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 关掉 Next 16 自动生成 AGENTS.md / CLAUDE.md 的行为
  agentRules: false,
};

export default nextConfig;