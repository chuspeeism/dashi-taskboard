const HIGH_IMPACT_PATTERN = /\b(?:deploy|publish|push|merge|trade|submit|credential|password|token|delete|payment|purchase)\b|部署|發佈|发布|推送|合併|合并|交易|提交比賽|提交比赛|憑證|凭证|密碼|密码|令牌|刪除|删除|付款|購買|购买/i;

function sectionBody(markdown, headingPattern) {
  const match = markdown.match(new RegExp(
    `^#{2,6}\\s*(?:${headingPattern})\\s*:?\\s*$([\\s\\S]*?)(?=^#{2,6}\\s|(?![\\s\\S]))`,
    "im",
  ));
  return match?.[1]?.trim() ?? "";
}

function field(body, name) {
  const match = body.match(new RegExp(`^(?:${name})\\s*:\\s*(.+)$`, "im"));
  return match?.[1]?.trim() ?? "";
}

export function parseTaskContinuation(description) {
  const markdown = String(description ?? "");
  const policyBody = sectionBody(markdown, "Completion policy|完成策略");
  const rawPolicy = field(policyBody, "continuation").toLowerCase();
  const policy = ["auto", "approval", "stop"].includes(rawPolicy) ? rawPolicy : "none";
  const nextBody = sectionBody(markdown, "Next task|下一步任務|下一步任务");
  const title = field(nextBody, "Title|標題|标题");
  const goal = field(nextBody, "Goal|目標|目标");
  const acceptanceBody = sectionBody(markdown, "Acceptance|驗收|验收");
  const acceptance = acceptanceBody
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
    .filter(Boolean);
  const hasNextTask = Boolean(title && (goal || acceptance.length > 0));
  const highImpact = HIGH_IMPACT_PATTERN.test([title, goal, ...acceptance].join("\n"));

  if (policy === "stop") {
    return { policy, outcome: "stopped", nextTask: null };
  }
  if (policy === "none" || !hasNextTask) {
    return { policy, outcome: "missing_next_task", nextTask: null };
  }

  const effectivePolicy = policy === "auto" && highImpact ? "approval" : policy;
  return {
    policy,
    outcome: effectivePolicy === "auto" ? "todo_created" : "backlog_created",
    nextTask: {
      title,
      description: [
        goal ? `## Goal\n${goal}` : "",
        acceptance.length > 0
          ? `## Acceptance\n${acceptance.map((item) => `- ${item}`).join("\n")}`
          : "",
        `\nCreated automatically from the accepted parent task. Original continuation policy: ${policy}.`,
        highImpact ? "High-impact work requires explicit approval before execution." : "",
      ].filter(Boolean).join("\n\n"),
      status: effectivePolicy === "auto" ? "todo" : "backlog",
      highImpact,
    },
  };
}
