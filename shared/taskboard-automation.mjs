import path from "node:path";
import { fileURLToPath } from "node:url";

const taskctlCliPath = fileURLToPath(new URL("../cli/taskctl.mjs", import.meta.url));

const AUTOMATION_OPERATIONS = new Set(["ensure-active", "pause", "list", "apply-policy"]);
const INTERVAL_MINUTES = new Set([5, 10, 15, 30, 60]);
const HOST_REQUEST_FIELDS = new Set([
  "id",
  "action",
  "requestId",
  "operation",
  "taskboardProjectId",
  "codexProjectId",
  "codexProjectKind",
  "codexHostId",
  "projectName",
  "workspacePath",
  "remoteProjects",
  "skillPath",
  "automationId",
  "enabledByUser",
  "quotaAware",
  "intervalMinutes",
  "model",
  "reasoningEffort",
]);

export function parseTaskboardAutomationHostRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (Object.keys(value).some((field) => !HOST_REQUEST_FIELDS.has(field))) return null;
  if (value.action !== "automation") return null;
  if (!validIdentifier(value.id, 80) || !validIdentifier(value.requestId, 100)) return null;
  if (!AUTOMATION_OPERATIONS.has(value.operation)) return null;
  if (!validProjectId(value.taskboardProjectId)) return null;
  if (!validText(value.codexProjectId, 256) || !validText(value.projectName, 200)) return null;
  const codexProjectKind = value.codexProjectKind ?? "local";
  const codexHostId = value.codexHostId ?? "local";
  if (codexProjectKind !== "local" && codexProjectKind !== "remote") return null;
  if (!validText(codexHostId, 256)) return null;
  if (codexProjectKind === "local" && codexHostId !== "local") return null;
  if (codexProjectKind === "remote" && codexHostId === "local") return null;
  if (!validAbsolutePath(value.workspacePath) || !validAbsolutePath(value.skillPath)) return null;
  const remoteProjects = value.remoteProjects === undefined ? [] : value.remoteProjects;
  if (
    !Array.isArray(remoteProjects)
    || remoteProjects.some((project) => (
      !project
      || typeof project !== "object"
      || Array.isArray(project)
      || Object.keys(project).some((field) => ![
        "codexProjectId",
        "codexProjectKind",
        "codexHostId",
        "workspacePath",
      ].includes(field))
      || !validText(project.codexProjectId, 256)
      || project.codexProjectKind !== "remote"
      || project.codexHostId !== codexHostId
      || !validAbsolutePath(project.workspacePath)
    ))
    || (codexProjectKind === "local" && remoteProjects.length > 0)
  ) return null;
  if (!INTERVAL_MINUTES.has(value.intervalMinutes)) return null;
  if (!validText(value.model, 256) || !validText(value.reasoningEffort, 100)) return null;
  if (value.automationId !== undefined && !validText(value.automationId, 256)) return null;
  if (typeof value.enabledByUser !== "boolean" || typeof value.quotaAware !== "boolean") return null;

  return {
    id: value.id,
    action: "automation",
    requestId: value.requestId,
    operation: value.operation,
    taskboardProjectId: value.taskboardProjectId,
    codexProjectId: value.codexProjectId,
    codexProjectKind,
    codexHostId,
    projectName: value.projectName,
    workspacePath: value.workspacePath,
    ...(value.remoteProjects === undefined ? {} : { remoteProjects }),
    skillPath: value.skillPath,
    ...(value.automationId === undefined ? {} : { automationId: value.automationId }),
    enabledByUser: value.enabledByUser,
    quotaAware: value.quotaAware,
    intervalMinutes: value.intervalMinutes,
    model: value.model,
    reasoningEffort: value.reasoningEffort,
  };
}

export function buildTaskboardAutomationName(request) {
  return `Taskboard 自动认领 · ${request.taskboardProjectId}`;
}

export function buildTaskboardAutomationPrompt(request) {
  const taskctlCommand = buildTaskctlCommand(request);
  const remoteProject = request.codexProjectKind === "remote";
  const remoteProjects = request.remoteProjects ?? [];
  const executionInstructions = remoteProject
    ? [
        `本自动化仅在本机作为任务面板控制器运行；实际开发必须派发到 Codex SSH 远程项目。导入项目的基础 identity 是 projectId=${JSON.stringify(request.codexProjectId)}、hostId=${JSON.stringify(request.codexHostId)}、workspacePath=${JSON.stringify(request.workspacePath)}；同一保存主机当前可用的精确远程项目映射是 ${JSON.stringify(remoteProjects)}。不要在当前本地自动化会话修改项目文件。`,
        "从返回的 todo 中只选择依赖已完成的议题：relations.blockedBy 为空，或其中每个依赖的 status 都严格等于 done。无依赖的 todo 仍可并行处理。若有 todo 但全部被未完成依赖阻塞，本轮直接结束，不暂停自动化，也不创建或打开新的任务会话。",
        "每次仅处理一个符合依赖条件的 todo：选定后先用 issue get 读取最新议题内容，并用 comment list 读取全部评论。根据描述和最新评论判断是否允许开始；若其中写明等待、暂不执行或当前不应开始，立即跳过并报告，不改状态。评论也包含已完成后被打回的返工要求。",
        "完成 issue get 和 comment list 后、移动状态前，必须再次运行 issue get，并复核 relations.blockedBy 仍为空或其中每个依赖的 status 都严格等于 done。若依赖条件不再满足，立即跳过并结束本轮，不改状态，也不暂停自动化。",
        "先检查 issue get 的 projectId、version、status、archivedAt、threadId 和 threadBinding。完整 threadBinding 包含 threadId、codexProjectId、codexProjectKind、codexHostId、workspacePath，且它是该议题后续 send、wait 和状态写回的唯一目标；当前自动化的项目和主机只能作为未绑定议题的首次目标，不能替换已有绑定。若存在 threadId 但没有完整 threadBinding，这是只能由 UI 打开的 legacy local 绑定：使用 comment add 说明自动化无法确认项目和主机，再使用首次读取的 version 作为 --if-version、用 --binding-thread-id 保留原 threadId 将议题移动到 blocked；若冲突立即停止。不得 send、create 或覆盖该绑定。",
        `未绑定议题必须先从上述精确远程项目映射解析 actualTarget。若 developmentContext.type 是 worktree，只保留 codexProjectKind="remote"、codexHostId=${JSON.stringify(request.codexHostId)} 且 workspacePath 与 developmentContext.path 完全相同的项；必须恰好命中一项，并使用该项自己的 codexProjectId、codexHostId 和 workspacePath。零项或多项时使用 comment add 明确记录“目标 SSH worktree 未映射”，随后结束本轮，不认领、不 create、不写基础项目 binding。若没有 worktree，actualTarget 才是上述基础 identity，并且它必须存在于精确映射中。不得回退到基础 root、local、项目名、其他主机或同路径的其他主机。`,
        "确认允许开始后，只有未绑定且仍为未归档 todo 的议题才可在读取代码、下载附件、分析或实施前，由当前本地控制器使用刚读取的 version 移到 in_progress。已有完整 threadBinding 时，issue move 必须同时传 --binding-thread-id、--binding-codex-project-id、--binding-codex-project-kind、--binding-codex-host-id、--binding-workspace-path 的保存值，但在旧会话 send/stale 判断完成前不得把这个 todo 移到 in_progress；stale 清除步骤按后文显式使用 --clear-binding-thread。未绑定时必须传 --clear-binding-thread，避免把本地控制器 CODEX_THREAD_ID 写成任务绑定。写入成功后记录响应 task 的 version 为 ownedVersion、projectId 为 ownedProjectId，并记录本轮 binding；以后本轮每次 issue move 都必须显式传 --if-version ownedVersion，成功后再用响应 version 更新 ownedVersion。不得省略 --if-version 后让 taskctl 自动读取最新 version。写入成功前不得继续。所有认领、评论和状态写入只由当前本地控制器完成，不得要求远程会话运行 taskctl。",
        "若因 version 陈旧发生版本冲突，重新运行 issue get 和 comment list；仅当仍为可认领 todo、绑定身份未变化、未归档且描述和最新评论未变化时，用最新 version 重试一次。若已被认领、绑定、状态或要求已变、已归档、服务或永久 API 错误，或重试仍失败，立即跳过该议题、退出并报告；不得抢占或循环重试。",
        "认领成功后，已有完整 threadBinding 时，只能使用其保存的 threadId 和 codexHostId 调用 Codex send_message_to_thread。send 成功后必须重新 issue get 一次，确认 projectId 未变、未归档、status 仍为 todo 且完整 threadBinding 与保存值完全相同；然后由当前本地控制器使用这次复核返回的最新 version、完整旧 binding 和 --if-version 执行 issue move --status in_progress，传入 --binding-thread-id、--binding-codex-project-id、--binding-codex-project-kind、--binding-codex-host-id、--binding-workspace-path，并记录响应 task.version 为 ownedVersion。认领成功后继续执行后文现有 Codex wait_threads、结果评论和 in_review 写回路径，不得结束本轮；若认领发生 409，立即停止，不得重读新 version 覆盖。只有旧会话工具明确返回终态 NOT_FOUND 或 CLOSED 等会话不存在或已关闭结果时，才确认 stale。timeout、network failure、Codex host 暂时不可达或 Taskboard service unavailable 都不是 stale：保留 binding 并结束本轮，不得猜测、clear、create 或抢占。若任务已是 in_progress、活跃、已归档、状态或 binding 已变化，立即停止，不得在当前自动化目标创建替代会话。只有未绑定议题才使用 Codex create_thread 创建远程任务，target 必须是 {type:\"project\",projectId:actualTarget.codexProjectId,environment:{type:\"local\"}}，首次 identity 必须使用 actualTarget 的 projectId、kind=\"remote\"、hostId 和 workspacePath。发送给远程会话的指令必须包含议题编号、标题、完整描述、全部评论和开发上下文，并说明远程会话不运行 taskctl，只需完成实现、验证并返回改动、结果和剩余风险。",
        "确认旧会话 stale 后，必须先用 comment add 保存一条历史记录，并同时传 --thread-id、--binding-thread-id、--binding-codex-project-id、--binding-codex-project-kind、--binding-codex-host-id 和 --binding-workspace-path 的完整旧 binding；评论写入成功后，再使用同一次 issue get 的 version 执行 issue move --status todo --clear-binding-thread --if-version。评论或清除失败立即停止，不得认领。然后只重新 issue get 一次；仅当 projectId 未变、未归档、status 仍为 todo、threadId 为空且 threadBinding 为空时，才进入未绑定议题的现有认领和 create_thread 路径。",
        "仅当 send_message_to_thread 成功，或 create_thread 成功返回远程 threadId，才视为远程 worker 已确认。未绑定议题在 create_thread 失败时，使用 comment add 记录失败工具和错误；随后用 ownedVersion、显式 --if-version 和 --clear-binding-thread 将当前议题移回 todo 并结束。若发生 409，说明其他控制端已修改任务，立即停止且不得重读最新 version 后覆盖。此补偿只处理本轮当前已认领议题；不得扫描或接管其他 in_progress。",
        "新建远程任务成功后，使用 ownedVersion 和显式 --if-version 再次移动到 in_progress；必须用完整 binding 参数保存 create_thread 返回的 threadId，以及 actualTarget 的 projectId、kind=\"remote\"、hostId 和 workspacePath。成功后用响应 version 更新 ownedVersion 和本轮 binding。若请求响应丢失或结果不确定，只允许重新 issue get 一次；仅当 projectId 等于 ownedProjectId、未归档、状态仍为本轮 in_progress，且 threadBinding 为空或与本轮五字段 binding 完全相同时才可继续。读到相同 binding 视为前次保存成功；读到空 binding 时才可用本次核对后的 version 重试一次；读到不同 binding 或任一其他核对项变化时立即退出，不得写回。若确定绑定写入失败，使用 comment add 记录失败和远程 threadId，再用 ownedVersion、显式 --if-version 和同一完整 binding 将议题移动到 blocked；409 时停止且不得重复派发。",
        "使用 Codex wait_threads 等待远程会话时，目标必须使用任务保存的 threadBinding.threadId 和 threadBinding.codexHostId。wait_threads 失败、远程会话明确需要用户输入或无法继续时，使用 comment add 记录原因，再用 ownedVersion、显式 --if-version 和完整保存 binding 将议题移动到 blocked；409 时立即停止。远程会话完成后，使用 comment add 写入改动、验证结果、执行结果和剩余风险，再用 ownedVersion、显式 --if-version 和完整保存 binding 将议题移动到 in_review。worker 确认后的每一次 issue move 都必须显式传完整远程 binding；不要把未完成工作标记为 in_review。",
      ]
    : [
        "从返回的 todo 中只选择依赖已完成的议题：relations.blockedBy 为空，或其中每个依赖的 status 都严格等于 done。无依赖的 todo 仍可并行处理。若有 todo 但全部被未完成依赖阻塞，本轮直接结束，不暂停自动化，也不创建或打开新的任务会话。",
        "每次仅处理一个符合依赖条件的 todo：选定后先用 issue get 读取最新议题内容，并用 comment list 读取全部评论。根据描述和最新评论判断是否允许开始；若其中写明等待、暂不执行或当前不应开始，立即跳过并报告，不改状态。评论也包含已完成后被打回的返工要求。",
        "完成 issue get 和 comment list 后、移动状态前，必须再次运行 issue get，并复核 relations.blockedBy 仍为空或其中每个依赖的 status 都严格等于 done。若依赖条件不再满足，立即跳过并结束本轮，不改状态，也不暂停自动化。",
        `确认允许开始后，只有 threadId 和 threadBinding 都为空且仍为未归档 todo 的议题才可在读取代码、下载附件、分析或实施前认领。认领必须使用刚读取的 version 移到 in_progress，并显式传 --binding-thread-id "$CODEX_THREAD_ID"、--binding-codex-project-id ${JSON.stringify(request.codexProjectId)}、--binding-codex-project-kind "local"、--binding-codex-host-id ${JSON.stringify(request.codexHostId)}、--binding-workspace-path ${JSON.stringify(request.workspacePath)}，把当前自动化会话一次写成完整 binding；记录响应 task.version 为 ownedVersion。写入成功前不得继续。已有完整 binding 或 legacy local binding 的议题必须先按旧会话规则处理，不得先认领；不得认领已被其他会话绑定或其他 Agent 领取的议题。认领后的每一次 issue move 都必须显式传 ownedVersion 和这五个完整 binding 字段，成功后更新 ownedVersion。`,
        "若因 version 陈旧发生版本冲突，重新运行 issue get 和 comment list；仅当仍为可认领 todo、未绑定其他会话、未归档且描述和最新评论未变化时，用最新 version 重试一次。若已被认领、状态或要求已变、已归档、服务或永久 API 错误，或重试仍失败，立即跳过该议题、退出并报告；不得抢占或循环重试。",
        `若首次 issue get 返回完整 threadBinding，议题已绑定原会话：不要在当前自动化会话认领；只能使用保存的 threadId 和 codexHostId 调用 Codex send_message_to_thread。send 成功时保留 binding 并结束本轮；只有工具明确返回终态 NOT_FOUND 或 CLOSED 等会话不存在或已关闭结果时才确认 stale。timeout、network failure、Codex host 暂时不可达或 Taskboard service unavailable 都保留 binding 并结束本轮，不得猜测 stale。确认 stale 后，先用 comment add 同时传 --thread-id 和完整旧 binding 保存历史，再用同一次 issue get 的 version 执行 issue move --status todo --clear-binding-thread --if-version；然后只重新 issue get 一次，仍为未归档 todo 且 threadId、threadBinding 都为空时，才在当前自动化会话处理。若任务已是 in_progress、活跃、已归档、状态或 binding 已变化，或发生 409，立即停止，不得抢占。若返回 threadId 但没有完整 threadBinding，这是 legacy local 绑定：先调用 Codex list_threads（limit=50），合并 pinnedThreads 与 threads，并按完整 threadId 精确查找。只有恰好一项 kind="codex"、projectId=${JSON.stringify(request.codexProjectId)}、hostId=${JSON.stringify(request.codexHostId)}、cwd=${JSON.stringify(request.workspacePath)} 全部一致时，才把该项视为可核验旧会话；使用最新 issue version 执行 issue move --status todo --if-version，并显式传旧 threadId 及上述 projectId、kind="local"、hostId、workspacePath 五字段，将 legacy local 原位升级为完整 binding。升级成功后只向该旧 threadId 和 hostId 调用 send_message_to_thread，随后结束本轮，由旧会话按议题最新要求继续。若 list_threads 未找到、出现多项或任一字段不一致，不得迁移或发送；使用 comment add 记录实际不一致项，再用首次读取的 version 和 --if-version、--binding-thread-id 保留原 threadId 将议题移到 blocked。若升级发生 409，立即停止，不得用新 version 覆盖。若没有 threadId，则按未绑定议题处理。`,
        "若议题已绑定 branch 或 worktree，必须在该议题绑定的开发上下文执行，避免并行 Agent 修改同一工作目录。",
        "执行完成并验证后，先用 comment add 记录关键改动、验证结果、执行结果和剩余风险，再使用 ownedVersion、显式 --if-version 和认领时保存的完整 binding 将议题移动到 in_review；成功后更新 ownedVersion。不要省略 binding，避免把完整绑定降级为 legacy local；不要直接标记为 done。",
      ];
  return [
    `[$manage-taskboard](${request.skillPath}) e-taskboard 每 ${request.intervalMinutes} 分钟检查任务面板中的「${request.projectName}」项目（项目 ID：${request.taskboardProjectId}，项目目录：${request.workspacePath}）。`,
    `本轮所有 taskctl 操作都使用完整命令前缀 ${taskctlCommand}，不要使用 PATH 中的 taskctl。`,
    `开始时先运行 ${taskctlCommand} issue list --project ${request.taskboardProjectId} --status todo --json。若没有 todo，直接结束；Taskboard 主机侧会暂停当前自动化，不要创建或打开新的任务会话。`,
    ...executionInstructions,
    `本次处理或交接后，再次运行 ${taskctlCommand} issue list --project ${request.taskboardProjectId} --status todo --json。若没有 todo，直接结束；Taskboard 主机侧会暂停当前自动化，避免后续创建空会话。`,
  ].join("\n");
}

function buildTaskctlCommand(request) {
  const command = `${shellQuote(process.execPath)} ${shellQuote(taskctlCliPath)}`;
  const runtimeFilePath = process.env.CODEX_TASKBOARD_RUNTIME_FILE;
  return runtimeFilePath
    ? `${command} --runtime-file ${shellQuote(runtimeFilePath)}`
    : command;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function buildTaskboardAutomationSpec(request) {
  return {
    kind: "cron",
    name: buildTaskboardAutomationName(request),
    prompt: buildTaskboardAutomationPrompt(request),
    projectId: request.codexProjectKind === "remote" ? null : request.codexProjectId,
    executionEnvironment: "local",
    localEnvironmentConfigPath: null,
    model: request.model,
    reasoningEffort: request.reasoningEffort,
    rrule: `RRULE:FREQ=MINUTELY;INTERVAL=${request.intervalMinutes}`,
  };
}

export function taskboardAutomationPolicyOperation(request, {
  explicit,
  hasTodo,
  previousQuotaState,
  quotaState,
  currentStatus,
}) {
  if (!request.enabledByUser) return "pause";
  if (hasTodo === false) return "pause";
  if (
    !explicit
    && currentStatus === "PAUSED"
    && (!request.quotaAware || previousQuotaState === "available")
  ) return "list";
  if (request.quotaAware && quotaState !== "available") return "pause";
  if (
    explicit
    || currentStatus === undefined
    || (request.quotaAware && previousQuotaState !== "available")
  ) return "ensure-active";
  return "ensure-active";
}

export async function reconcileTaskboardAutomation(request, rpc) {
  const listed = await rpc("list-automations", {});
  const items = Array.isArray(listed?.items) ? listed.items : [];
  const name = buildTaskboardAutomationName(request);
  const matchingItems = items.filter((item) => item?.name === name);

  if (request.operation === "list") {
    return { items: matchingItems.map(sanitizeAutomation).filter(Boolean) };
  }

  const existing = (
    request.automationId
      ? matchingItems.find((item) => item?.id === request.automationId)
      : null
  ) ?? matchingItems[0];
  const spec = buildTaskboardAutomationSpec(request);

  if (request.operation === "pause") {
    if (!existing) return { error: "not-found" };
    if (automationMatchesSpec(existing, spec, "PAUSED")) return { item: existing };
    return rpc("automation-update", { ...spec, id: existing.id, status: "PAUSED" });
  }

  if (request.operation !== "ensure-active") {
    throw new Error(`Unsupported automation operation: ${request.operation}`);
  }
  if (existing) {
    if (automationMatchesSpec(existing, spec, "ACTIVE")) return { item: existing };
    return rpc("automation-update", {
      ...spec,
      id: existing.id,
      status: "ACTIVE",
    });
  }
  return rpc("automation-create", spec);
}

function sanitizeAutomation(item) {
  if (
    !validText(item?.id, 256)
    || (item.status !== "ACTIVE" && item.status !== "PAUSED")
    || !validText(item.model, 256)
    || !validText(item.reasoningEffort, 100)
    || !validRrule(item.rrule)
  ) return null;
  return {
    id: item.id,
    status: item.status,
    model: item.model,
    reasoningEffort: item.reasoningEffort,
    rrule: item.rrule,
    ...(
      item.nextRunAt === null || Number.isFinite(item.nextRunAt)
        ? { nextRunAt: item.nextRunAt }
        : {}
    ),
  };
}

function validRrule(value) {
  return typeof value === "string"
    && /^RRULE:FREQ=MINUTELY;INTERVAL=(5|10|15|30|60)$/.test(value);
}

function automationMatchesSpec(item, spec, status) {
  return item?.status === status
    && Object.entries(spec).every(([field, value]) => (
      field === "projectId"
        ? (item.projectId ?? item.target?.projectId ?? null) === value
        : item[field] === value
    ));
}

function validIdentifier(value, maxLength) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && /^[a-z0-9-]+$/i.test(value);
}

function validProjectId(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 128
    && /^[a-z0-9._-]+$/i.test(value);
}

function validText(value, maxLength) {
  return typeof value === "string"
    && value.trim() === value
    && value.length > 0
    && value.length <= maxLength
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function validAbsolutePath(value) {
  return validText(value, 2_048)
    && (path.posix.isAbsolute(value) || path.win32.isAbsolute(value));
}
