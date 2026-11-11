export const REQUEST_TOOLS = new Set([
  "context current", "project list", "project create", "project map", "project readme",
  "cloud login", "cloud status", "cloud logout", "issue list", "issue get",
  "issue create", "issue update", "issue move", "issue archive", "issue restore",
  "issue tree", "issue relation", "comment list", "comment add", "comment update",
  "comment delete", "attachment list", "attachment upload", "attachment download",
  "log list", "log analyze", "log diagnose",
]);
export const UNKNOWN_MODEL = { id: null, provenance: "unavailable_at_tool_boundary" };

function compareBinding(snapshot, source, clientContextThreadId) {
  const declaredCallerThreadId = source?.threadId ?? null;
  const missing = [];
  if (snapshot.bindingState === "missing") missing.push("task_bound_thread");
  if (!declaredCallerThreadId) missing.push("declared_caller_thread");
  const status = !["present", "missing"].includes(snapshot.bindingState) ? "unknown"
    : missing.length ? "missing" : snapshot.boundThreadId === declaredCallerThreadId ? "same" : "different";
  return {
    ...snapshot, declaredCallerThreadId,
    clientContextThreadId: clientContextThreadId ?? null,
    contextComparison: snapshot.bindingState !== "present" || !clientContextThreadId ? "unknown_or_missing"
      : snapshot.boundThreadId === clientContextThreadId ? "same" : "different",
    callerDeclarationSource: source?.declarationSource ?? "unavailable",
    status, missing,
    verifiedCallerThreadId: null, verifiedComparison: "unknown_no_authenticated_caller_identity",
  };
}

// This diagnoses observed evidence, never an unobserved model turn or its intent.
export function diagnoseRequests(serverRecords, clientRecords = [], coverage = {}, filters = {}) {
  const groups = new Map();
  const terminals = serverRecords.filter((r) => r.event === "completed" || r.event === "aborted");
  for (const record of [...clientRecords, ...serverRecords]) {
    if (record.tool?.startsWith("log ")) continue;
    const key = record.invocationId ?? `request:${record.requestId}`;
    const group = groups.get(key) ?? { invocationId: record.invocationId ?? null, records: [] };
    group.records.push(record);
    groups.set(key, group);
  }
  const invocations = [];
  for (const group of groups.values()) {
    const records = group.records.sort((a, b) => a.time.localeCompare(b.time));
    const source = records.find((r) => r.source)?.source ?? { threadId: null, attribution: "unknown" };
    if (filters.sourceThreadId && !records.some((r) => r.source?.threadId === filters.sourceThreadId
      || r.clientContextThreadId === filters.sourceThreadId)) continue;
    if (filters.taskId && !records.some((r) => (
      r.taskId === filters.taskId || r.effect?.taskId === filters.taskId || r.taskRead?.id === filters.taskId
      || r.taskBindings?.some((b) => b.taskId === filters.taskId || b.identifier === filters.taskId)
    ))) continue;
    const requests = new Map();
    for (const record of records) {
      if (!record.clientRequestId && !record.requestId) continue;
      const id = record.clientRequestId ?? record.requestId;
      const entry = requests.get(id) ?? { clientRequestId: record.clientRequestId ?? null, requestId: null };
      if (record.requestId) entry.requestId = record.requestId;
      if (record.event === "request_started") entry.attemptedAt = record.time;
      if (record.event === "received") entry.receivedAt = record.time;
      if (record.event === "http_response") entry.clientHttpStatus = record.status;
      if (record.event === "transport_error") entry.delivery = record.delivery;
      if (record.event === "transport_error") entry.transportCode = record.transportCode;
      if (record.event === "completed" || record.event === "aborted") {
        Object.assign(entry, {
          finishedAt: record.time, status: record.status, result: record.result,
          errorCode: record.errorCode, durationMs: record.durationMs, effect: record.effect ?? null,
        });
      }
      requests.set(id, entry);
    }
    const saves = records.filter((r) => r.effect && r.event === "completed").map((saved) => {
      const effect = saved.effect;
      if (effect.operation === "deleted" || effect.entity === "attachment") return {
        ...effect, readback: effect.operation === "deleted" ? "not_checked_for_deletion" : "not_checked_for_attachment",
        readbackEvidence: null, contentCorrectness: "not_checked_by_metadata_log",
      };
      const reads = source.threadId ? terminals.slice(terminals.indexOf(saved) + 1).filter((r) => (
        r.source?.threadId === source.threadId && r.requestId !== saved.requestId
        && (effect.entity === "task" ? r.taskRead?.id === effect.id
          : r.commentReads?.some((c) => c.id === effect.id))
      )) : [];
      const versions = reads.map((r) => ({
        version: effect.entity === "task" ? r.taskRead.version : r.commentReads.find((c) => c.id === effect.id).version,
        requestId: r.requestId, time: r.time,
      }));
      const matching = versions.find((r) => r.version === effect.version);
      return {
        ...effect,
        readback: matching ? "version_confirmed" : versions.length ? "different_version_observed" : "not_observed",
        readbackEvidence: matching ?? versions[0] ?? null,
        contentCorrectness: "not_checked_by_metadata_log",
      };
    });
    const ended = records.findLast((r) => r.event === "cli_finished");
    const bindingComparisons = records.filter((r) => r.event === "completed" || r.event === "aborted")
      .flatMap((r) => (r.taskBindings ?? []).filter((b) => !filters.taskId
        || b.taskId === filters.taskId || b.identifier === filters.taskId)
        .map((snapshot) => compareBinding(snapshot, r.source, r.clientContextThreadId)));
    const bindingChanges = [];
    for (const taskId of new Set(bindingComparisons.map((b) => b.taskId))) {
      const before = bindingComparisons.findLast((b) => b.taskId === taskId && b.phase === "before");
      const after = bindingComparisons.findLast((b) => b.taskId === taskId && b.phase === "after");
      if (before && after) bindingChanges.push({ taskId, before: before.boundThreadId, after: after.boundThreadId,
        changed: [before, after].every((b) => ["present", "missing"].includes(b.bindingState))
          ? before.boundThreadId !== after.boundThreadId : null });
    }
    const steps = [...requests.values()];
    const rejected = steps.some((r) => r.status >= 400 || r.clientHttpStatus >= 400);
    const onlyReads = records.filter((r) => r.method).every((r) => ["GET", "HEAD"].includes(r.method));
    const noVersionChange = saves.length && saves.every((s) => s.entity === "task" && !s.versionChanged);
    const onlyDeletion = saves.length && saves.every((s) => s.operation === "deleted");
    const onlyAttachments = saves.length && saves.every((s) => s.entity === "attachment");
    const outcome = saves.length ? (rejected || ended?.exitCode > 0 ? "partial_success"
      : onlyDeletion ? "deletion_committed" : onlyAttachments ? "attachment_saved"
        : noVersionChange ? "save_returned_without_version_change" : "save_committed")
      : rejected ? "http_rejected"
        : steps.some((r) => r.delivery === "not_connected") ? "connection_not_established"
          : steps.some((r) => r.delivery === "unknown") ? "transport_outcome_unknown"
            : ended?.exitCode > 0 && steps.length === 0 ? "failed_before_http"
              : ended?.exitCode > 0 ? "failed_after_http_response"
                : steps.some((r) => r.clientHttpStatus) && !steps.some((r) => r.result) ? "server_record_not_observed"
              : steps.some((r) => r.result === "success") && onlyReads ? "read_only"
                : steps.some((r) => r.result === "success") ? "http_success_without_save_evidence"
                  : "incomplete_evidence";
    invocations.push({
      invocationId: group.invocationId, source,
      sourceStatus: source.threadId ? "declared_not_authenticated" : "missing",
      attributionWarning: source.threadId ? null : "来源缺失，不能从卡片绑定反推请求会话。",
      callerIdentity: {
        clientContextThreadId: records.find((r) => r.clientContextThreadId)?.clientContextThreadId ?? null,
        explicitCallerThreadId: records.find((r) => r.explicitCallerThreadId)?.explicitCallerThreadId ?? null,
        clientDeclaredThreadId: records.find((r) => r.event === "cli_started")?.source?.threadId ?? null,
        httpDeclaredThreadIds: [...new Set(records.filter((r) => r.event === "received").map((r) => r.source?.threadId ?? null))],
        verifiedThreadId: null, verification: "no_authenticated_per_conversation_identity",
      },
      bindingObservation: bindingComparisons.length ? "observed" : "not_observed",
      bindingComparisons, bindingChanges,
      clientJournalReport: records.some((r) => r.clientJournalStatus === "failed") ? "write_failure_reported" : "no_failure_report_observed",
      loggingNextAction: records.some((r) => r.clientJournalStatus === "failed")
        ? "修复客户端日志写入问题；业务结果单独核实，不因日志失败重复写卡。" : null,
      model: UNKNOWN_MODEL,
      tool: records.find((r) => r.tool)?.tool ?? null,
      startedAt: records[0].time, lastObservedAt: records.at(-1).time,
      cliExitCode: ended?.exitCode ?? null, cliErrorCode: ended?.errorCode ?? null,
      outcome, requests: steps, saves,
      nextAction: outcome === "failed_before_http" ? "检查CLI参数、输入文件或运行时配置；本机调用记录中未到发送阶段。"
        : outcome === "failed_after_http_response" ? "服务已有HTTP响应，但CLI随后失败；检查响应解析或本地输出，不盲重送写入。"
          : outcome === "server_record_not_observed" ? "客户端已有HTTP响应，当前服务日志未匹配；核日志窗口、来源和服务目标。"
        : rejected ? "按具体HTTP错误码处理；成功保存与失败步骤分别核实，不重放整个流程。"
          : steps.some((r) => r.delivery) ? "用客户端关联ID核查传输结果；unknown时不盲目重送写请求。"
            : saves.some((s) => s.operation === "deleted" || s.entity === "attachment") ? "已有删除或附件的数据库回执；单独核不存在/附件可读，不重复操作。"
              : saves.some((s) => s.readback !== "version_confirmed") ? "独立读取保存的卡片或评论；未观察到读回不等于保存失败。"
              : saves.length ? "保存和版本读回已有证据；仍需核对实际内容与任务验收。"
                : outcome === "read_only" ? "仅观察到读取；若本轮应回写进展，还需核准确原会话的保存回执。"
                  : "证据不足；核原会话与工具回执，不能据缺日志断言未调用。",
    });
  }
  return {
    observation: invocations.length ? "observed" : "not_observed",
    invocations, coverage,
    limits: {
      sourceIdentity: "self_reported_not_authenticated", model: "unknown_without_trusted_runtime_metadata",
      bindingComparison: "identifier_comparison_only_not_authorization_or_authenticated_identity",
      executionCompletion: "not_observed_by_taskctl_or_http_log",
      absence: "not_observed_is_not_proof_of_not_called",
      acceptance: "http_success_or_version_readback_is_not_content_correctness_or_user_acceptance",
    },
    nextAction: invocations.length ? "查看各调用的失败步骤、保存及读回证据。"
      : "本窗口没有可归属证据；核会话完成时间、工具回执、来源缺失及覆盖范围，不判定未调用。",
  };
}
