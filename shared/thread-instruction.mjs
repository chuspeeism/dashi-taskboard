function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Build the text that prefills the Codex composer when an issue is opened in a
 * thread. The block names the project, the issue, and the workspace so the
 * agent knows what it is looking at, then points it at `taskctl` for the title,
 * the description, and the comments rather than embedding a copy that can go
 * stale.
 */
export function buildThreadInstruction({
  identifier,
  projectName,
  projectId,
  workspacePath,
} = {}) {
  const issue = clean(identifier);
  const name = clean(projectName);
  const id = clean(projectId);
  const workspace = clean(workspacePath);

  const project = name && id ? `${name} (id: ${id})` : name || id;
  const fields = [
    project ? `- 项目: ${project}` : "",
    issue ? `- 议题: ${issue}` : "",
    workspace ? `- 工作区: ${workspace}` : "",
  ].filter(Boolean);

  return [
    "处理下面这个议题：",
    "",
    ...fields,
    "",
    `先执行 taskctl issue get ${issue} 读取标题、描述与评论，再开始。`,
  ].join("\n");
}
