export interface ThreadInstructionInput {
  readonly identifier: string;
  readonly projectName?: string | null;
  readonly projectId?: string | null;
  readonly workspacePath?: string | null;
}

export function buildThreadInstruction(input: ThreadInstructionInput): string;
