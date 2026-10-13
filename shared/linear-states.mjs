// Linear workflow state names and the board status each maps to. Resolved by
// state name within the team; MM7 and Development share names but not state ids.
export const LINEAR_STATE_STATUSES = [
  ["Backlog", "backlog"],
  ["Triage", "backlog"],
  ["Defining Requirements", "backlog"],
  ["Ready For Dev", "todo"],
  ["In Development", "in_progress"],
  ["Staging Ready For QA", "in_progress"],
  ["In QA", "in_progress"],
  ["Staging Failed", "in_progress"],
  ["Code Review", "in_review"],
  ["Blocked", "blocked"],
  ["Ready For Release", "done"],
  ["Commercial Verification", "done"],
  ["Released", "done"],
  ["Won't Do", "canceled"],
  ["Failed To Resolve", "canceled"],
  ["Duplicate", "canceled"],
];

export function linearStatesForStatus(status) {
  return LINEAR_STATE_STATUSES.filter(([, mapped]) => mapped === status).map(([name]) => name);
}

// In-progress Linear states that wait on QA rather than on an agent or the user.
const QA_STATES = new Map([
  ["staging ready for qa", "waiting"],
  ["in qa", "waiting"],
  ["staging failed", "failed"],
]);

// "waiting" | "failed" | null for an in_progress Linear task.
export function linearQaState(task) {
  if (task?.source !== "linear" || task.status !== "in_progress") return null;
  return QA_STATES.get(String(task.externalState ?? "").trim().toLowerCase()) ?? null;
}
