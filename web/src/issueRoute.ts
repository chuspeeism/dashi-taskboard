const ISSUE_QUERY_PARAM = "issue";
const PROJECTS_QUERY_PARAM = "projects";

function uniqueProjectIds(projectIds: string[]): string[] {
  return [...new Set(projectIds.map((projectId) => projectId.trim()).filter(Boolean))];
}

export function readIssueIdentifier(search: string): string | null {
  const identifier = new URLSearchParams(search).get(ISSUE_QUERY_PARAM)?.trim().toUpperCase();
  return identifier || null;
}

export function readSelectedProjectIds(search: string): string[] {
  const params = new URLSearchParams(search);
  const projectIds = uniqueProjectIds((params.get(PROJECTS_QUERY_PARAM) ?? "").split(","));
  if (projectIds.length > 0) return projectIds;
  const projectId = params.get("project")?.trim();
  return projectId ? [projectId] : [];
}

export function buildIssueUrl(
  href: string,
  projectId: string | null,
  issueIdentifier: string | null,
  selectedProjectIds: string[] = projectId ? [projectId] : [],
): URL {
  const url = new URL(href);
  const projectIds = uniqueProjectIds(selectedProjectIds);

  if (projectId) url.searchParams.set("project", projectId);
  else url.searchParams.delete("project");

  if (projectIds.length > 1) url.searchParams.set(PROJECTS_QUERY_PARAM, projectIds.join(","));
  else url.searchParams.delete(PROJECTS_QUERY_PARAM);

  if (issueIdentifier) url.searchParams.set(ISSUE_QUERY_PARAM, issueIdentifier.trim().toUpperCase());
  else url.searchParams.delete(ISSUE_QUERY_PARAM);

  return url;
}
