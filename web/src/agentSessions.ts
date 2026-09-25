import type { AgentPlatform } from "./types";

export function agentPlatformLabel(platform: AgentPlatform | "codex") {
  switch (platform) {
    case "codex": return "Codex";
    case "claude": return "Claude Code";
    case "pi": return "Pi";
    case "agy": return "Google Antigravity (AGY)";
    case "grok": return "Grok";
  }
}

// These are fixed CLI entry points, not user-configurable command templates.
// Quote for POSIX shells (sh/bash/zsh); preserve the complete, original argument.
export function sessionResumeCommand(platform: AgentPlatform | "codex", sessionId: string) {
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
