export const DECISION_REQUEST_MARKER: string;
export function decisionState(comments: ReadonlyArray<{
  authorType: string;
  body: string;
}>): "none" | "waiting" | "answered";
