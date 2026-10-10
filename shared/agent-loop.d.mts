export const AGENT_LOOP_STORAGE_KEY: string;
export const MAX_CONCURRENT_LIMIT: number;
export type ProjectLoopSettings = {
  enabled: boolean;
  maxConcurrent: number;
  repoPath: string | null;
  labelRepos: Record<string, string>;
};
export function parseAgentLoopSettings(raw: string | null | undefined): Record<string, ProjectLoopSettings>;
export function projectLoopSettings(
  settings: Record<string, unknown> | null | undefined,
  projectId: string,
): ProjectLoopSettings;
export function isAgentWorking(task: {
  status: string;
  agentSession?: unknown;
  threadBinding?: unknown;
  threadId?: unknown;
  pausedAt?: string | null;
  resumedAt?: string | null;
}): boolean;
export const DECISION_REQUEST_MARKER: string;
export function decisionState(comments: ReadonlyArray<{
  authorType: string;
  body: string;
  createdAt: string;
  updatedAt?: string;
}>): "none" | "waiting" | "answered";
