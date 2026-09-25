// Stored sandbox values are product permission choices, not literal Codex sandbox modes.
export function resolveCodexPermissions(sandbox) {
  const fullAccess = sandbox === "danger-full-access";
  return {
    sandbox: fullAccess ? "danger-full-access" : "workspace-write",
    approvalPolicy: fullAccess ? "never" : "on-request",
    reviewer: fullAccess ? null : sandbox === "read-only" ? "user" : "auto_review",
  };
}
