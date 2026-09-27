import type { AgentPlatform } from "./types";

export function agentPlatformLabel(platform: AgentPlatform | "codex") {
  switch (platform) {
    case "codex": return "Codex";
    case "claude": return "Claude Code";
    case "pi": return "Pi";
    case "agy": return "Google Antigravity (AGY)";
    case "grok": return "Grok";
    case "chatgpt": return "ChatGPT 网页";
  }
}

// CLI agents use fixed resume commands. ChatGPT web has no verified resume route,
// so return only its original ID for copying.
// Quote CLI arguments for POSIX shells (sh/bash/zsh).
export function sessionResumeCommand(platform: AgentPlatform | "codex", sessionId?: string) {
  if (platform === "chatgpt") return sessionId ?? "";
  if (!sessionId) return "";
  const argument = /^[A-Za-z0-9_./:@+-]+$/.test(sessionId)
    ? sessionId
    : "'" + sessionId.replace(/'/g, "'\"'\"'") + "'";
  switch (platform) {
    case "codex": return `codex resume ${argument}`;
    case "claude": return `claude --resume ${argument}`;
    case "pi": return `pi --session ${argument}`;
    case "agy": return `agy --conversation ${argument}`;
    case "grok": return `grok --resume ${argument}`;
  }
}
