import {
  cloneMirrorJson,
  createMirrorEnvelope,
  immutableMirrorJson,
  packageFromOutbox,
  prepareIdeaPromotion,
  prepareTaskboardMirror,
  TaskboardMirrorError,
} from "./mirror-package.mjs";
import { hashCanonicalJson, parseFeishuBaseExternalKey } from "./contracts.mjs";

export const TASKBOARD_MIRROR_EVENT_TYPES = Object.freeze([
  "task.created",
  "task.updated",
  "task.moved",
  "task.reassigned",
]);

export const MIRROR_DRY_RUN_MODE = "dry_run";

const ALLOWED_TABLE_KEYS = new Set(["productIdeas", "requirements"]);
const FORMAL_TABLE_KEY = "requirements";
const IDEA_TABLE_KEY = "productIdeas";
const UNASSIGNED_PROJECT_IDS = new Set([
  "",
  "inbox",
  "inbox-unclassified",
  "idea-inbox",
  "uncategorized",
  "unclassified",
  "待归类需求",
  "灵感收件箱",
]);

export class MirrorProjectorError extends TaskboardMirrorError {
  constructor(code, message, details = undefined) {
    super(code, message, details);
    this.name = "MirrorProjectorError";
  }
}

function fail(code, message, details = undefined) {
  throw new MirrorProjectorError(code, message, details);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function optionalString(value, label, maxLength = 4096) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > maxLength || value !== value.trim() || value.includes("\0")) {
    fail("INVALID_PROJECTOR_VALUE", `${label} must be a trimmed string`);
  }
  return value;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null) ?? null;
}

function sameJson(left, right) {
  return canonicalValue(left) === canonicalValue(right);
}

function canonicalValue(value) {
  try {
    return JSON.stringify(immutableMirrorJson(value));
  } catch {
    return String(value);
  }
}

function versionValue(value, label) {
  if (value === undefined || value === null) return null;
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 1) fail("INVALID_VERSION", `${label} must be a positive integer or null`);
    return value;
  }
  if (typeof value === "string" && value.trim()) return value;
  fail("INVALID_VERSION", `${label} must be a positive version value or null`);
}

function sideHash(payload, suppliedHash = undefined) {
  if (suppliedHash !== undefined && suppliedHash !== null) return optionalString(suppliedHash, "side.hash", 256);
  if (payload === undefined || payload === null) return null;
  return hashCanonicalJson(payload);
}

function normalizeSide(value, label) {
  if (value === undefined || value === null) return { version: null, hash: null, payload: null };
  if (!isPlainObject(value)) fail("INVALID_SIDE_OBSERVATION", `${label} must be an object`);
  const payload = firstDefined(value.payload, value.fields, value.value);
  const normalizedPayload = payload === undefined ? null : cloneMirrorJson(payload);
  const version = versionValue(
    firstDefined(value.version, value.observedVersion, value.baseVersion, value.sourceVersion),
    `${label}.version`,
  );
  const hash = sideHash(normalizedPayload, firstDefined(value.hash, value.payloadHash, value.sourceHash, value.baseHash));
  return { version, hash, payload: normalizedPayload };
}

function sideChanged(baseline, current) {
  if (!baseline || !current) return false;
  const baselineVersion = firstDefined(baseline.version, baseline.sourceVersion, baseline.baseVersion, baseline.taskboardVersion);
  const currentVersion = firstDefined(current.version, current.sourceVersion, current.baseVersion, current.taskboardVersion);
  const baselineHash = firstDefined(baseline.hash, baseline.sourceHash, baseline.baseHash, baseline.taskboardHash);
  const currentHash = firstDefined(current.hash, current.sourceHash, current.baseHash, current.taskboardHash);
  if (baselineVersion === null && baselineHash === null) return false;
  return !sameJson(baselineVersion, currentVersion) || !sameJson(baselineHash, currentHash);
}

function tableKeyForLink(link, config) {
  const direct = link?.tableKey ?? link?.sourceTableKey ?? link?.source_table_key;
  if (direct) return direct;
  let identity;
  try {
    identity = parseFeishuBaseExternalKey(link?.externalKey ?? link?.external_key);
  } catch {
    return null;
  }
  for (const key of ALLOWED_TABLE_KEYS) {
    if (config?.tableIds?.[key] && config.tableIds[key] === identity.tableId) return key;
  }
  return null;
}

function normalizeConfig(options) {
  const config = isPlainObject(options.config) ? options.config : {};
  const allowedTableKeys = options.allowedTableKeys
    ?? options.scope?.tableKeys
    ?? config.allowedTableKeys
    ?? [...ALLOWED_TABLE_KEYS];
  if (!Array.isArray(allowedTableKeys) || allowedTableKeys.some((key) => !ALLOWED_TABLE_KEYS.has(key))) {
    fail("INVALID_SCOPE", "Only productIdeas and requirements are valid mirror table keys");
  }
  const projectIds = options.allowedProjectIds
    ?? options.scope?.projectIds
    ?? config.allowedProjectIds
    ?? null;
  if (projectIds !== null && (!Array.isArray(projectIds) || projectIds.some((id) => typeof id !== "string" || !id.trim()))) {
    fail("INVALID_SCOPE", "allowedProjectIds must be an array of non-empty strings");
  }
  const projectNames = options.projectNames ?? config.projectNames ?? {};
  if (!isPlainObject(projectNames)) fail("INVALID_SCOPE", "projectNames must be an object");
  const clock = options.clock ?? (() => new Date().toISOString());
  if (typeof clock !== "function") fail("INVALID_PROJECTOR_OPTIONS", "clock must be a function");
  const taskboardStore = options.taskboardStore ?? null;
  const taskReader = options.taskReader
    ?? options.readTask
    ?? (typeof taskboardStore?.readTask === "function" ? taskboardStore.readTask.bind(taskboardStore) : null);
  const commentsReader = options.commentsReader
    ?? options.listComments
    ?? (typeof taskboardStore?.listComments === "function" ? taskboardStore.listComments.bind(taskboardStore) : null);
  const attachmentsReader = options.attachmentsReader
    ?? options.listAttachments
    ?? (typeof taskboardStore?.listAttachments === "function" ? taskboardStore.listAttachments.bind(taskboardStore) : null);
  for (const [label, reader] of [["taskReader", taskReader], ["commentsReader", commentsReader], ["attachmentsReader", attachmentsReader]]) {
    if (reader !== null && typeof reader !== "function") fail("INVALID_PROJECTOR_OPTIONS", `${label} must be a function`);
  }
  return {
    config,
    allowedTableKeys: new Set(allowedTableKeys),
    allowedProjectIds: projectIds === null ? null : new Set(projectIds),
    projectNames: cloneMirrorJson(projectNames),
    projectNameResolver: options.projectNameResolver ?? options.resolveProjectName ?? null,
    taskReader,
    commentsReader,
    attachmentsReader,
    taskboardBaseUrl: options.taskboardBaseUrl ?? options.taskboardUrl ?? "http://127.0.0.1:47823",
    formalAppToken: options.formalAppToken ?? config.formalAppToken ?? config.appToken ?? null,
    formalTableId: options.formalTableId ?? config.formalTableId ?? config.tableIds?.[FORMAL_TABLE_KEY] ?? null,
    clock,
    mode: MIRROR_DRY_RUN_MODE,
  };
}

function eventRunId(event) {
  return optionalString(
    event.runId
      ?? event.run_id
      ?? event.syncRunId
      ?? event.sync_run_id
      ?? event.metadata?.runId
      ?? event.metadata?.run_id,
    "event.runId",
    512,
  );
}

function eventId(event, task) {
  return optionalString(
    event.eventId
      ?? event.event_id
      ?? event.id
      ?? event.metadata?.eventId
      ?? event.metadata?.event_id,
    "event.eventId",
    512,
  ) ?? `taskboard:${task.id}:v${task.version}`;
}

function eventOriginValues(event) {
  return [
    event.source,
    event.origin,
    event.producer,
    event.direction,
    event.metadata?.source,
    event.metadata?.origin,
    event.metadata?.direction,
  ].filter((value) => typeof value === "string").map((value) => value.toLowerCase());
}

function isProjectionEcho(event) {
  if (event.echo === true || event.isEcho === true || event.fromOutbound === true || event.replayedFromOutbox === true) {
    return true;
  }
  const origins = eventOriginValues(event);
  return origins.some((origin) => (
    origin === "feishu-base"
      || origin === "feishu_base"
      || origin === "hermes"
      || origin === "mirror-projector"
      || origin === "taskboard_to_feishu"
      || origin === "taskboard-to-feishu"
      || origin === "outbound"
  ));
}

function isAutomatedMove(event) {
  if (event.manual === false || event.automated === true || event.readinessReview === true || event.internal === true) {
    return true;
  }
  const actorType = event.actor?.type ?? event.actorType ?? event.actor_type;
  if (actorType === "agent" && event.manual !== true) return true;
  const source = event.source ?? event.origin;
  return typeof source === "string" && ["system", "automation", "task-coordinator", "readiness"].includes(source.toLowerCase());
}

function taskProjectId(task) {
  return task?.projectId ?? task?.project_id ?? null;
}

function isUnassignedProject(projectId) {
  return UNASSIGNED_PROJECT_IDS.has(String(projectId ?? "").trim().toLowerCase());
}

function projectIsInScope(task, settings) {
  const projectId = taskProjectId(task);
  if (!projectId || settings.allowedProjectIds && !settings.allowedProjectIds.has(projectId)) return false;
  return !isUnassignedProject(projectId);
}

function projectNameFor(task, settings, event, { requireExplicit = false } = {}) {
  const projectId = taskProjectId(task);
  const eventProject = event.project ?? event.projectContext ?? event.projectAssignment;
  const direct = task.projectName
    ?? task.project?.name
    ?? eventProject?.name
    ?? settings.projectNames[projectId]
    ?? null;
  if (direct) return direct;
  if (typeof settings.projectNameResolver === "function") {
    const resolved = settings.projectNameResolver(task, event);
    if (resolved && typeof resolved.then === "function") {
      fail("ASYNC_PROJECT_RESOLVER", "projectNameResolver must be synchronous for an event projector");
    }
    if (resolved) return resolved;
  }
  if (requireExplicit && !projectIsInScope(task, settings)) return null;
  return projectId;
}

function explicitProjectAssignment(event, task, settings) {
  if (isAutomatedMove(event)) return null;
  if (event.type !== "task.reassigned" && event.projectAssignmentConfirmed !== true && event.projectAssigned !== true) {
    return null;
  }
  const projectId = taskProjectId(task);
  if (!projectIsInScope(task, settings)) return null;
  const assignedProjectId = event.projectId ?? event.project?.id ?? event.projectAssignment?.projectId ?? projectId;
  if (assignedProjectId !== projectId || isUnassignedProject(assignedProjectId)) return null;
  return {
    projectId,
    projectName: projectNameFor(task, settings, event, { requireExplicit: true }),
    eventId: eventId(event, task),
  };
}

function linkExternalKey(link) {
  return link?.externalKey ?? link?.external_key ?? null;
}

function validLink(link, task, settings) {
  if (!isPlainObject(link)) return false;
  const externalKey = linkExternalKey(link);
  if (typeof externalKey !== "string" || !externalKey.trim()) return false;
  let identity;
  try {
    identity = parseFeishuBaseExternalKey(externalKey);
  } catch {
    return false;
  }
  if (link.taskId !== undefined && link.taskId !== null && link.taskId !== task.id) return false;
  if (link.task_id !== undefined && link.task_id !== null && link.task_id !== task.id) return false;
  const recordId = link.recordId ?? link.record_id;
  if (recordId !== undefined && recordId !== null && recordId !== identity.recordId) return false;
  const tableKey = tableKeyForLink(link, settings.config);
  if (!tableKey || !settings.allowedTableKeys.has(tableKey)) return false;
  if (settings.config.appToken && identity.appToken !== settings.config.appToken) return false;
  if (settings.config.tableIds?.[tableKey] && identity.tableId !== settings.config.tableIds[tableKey]) return false;
  return true;
}

function linksForTask(state, task, settings, event) {
  const links = [];
  if (typeof state.listLinks === "function") {
    const listed = state.listLinks({ taskId: task.id, limit: 10_000 });
    if (Array.isArray(listed)) links.push(...listed);
  }
  const requestedExternalKey = event.externalKey ?? event.external_key;
  if (requestedExternalKey && typeof state.getLink === "function") {
    const requested = state.getLink(requestedExternalKey);
    if (requested) links.push(requested);
  }
  const unique = new Map();
  for (const link of links) {
    const key = linkExternalKey(link);
    if (key && !unique.has(key) && validLink(link, task, settings)) unique.set(key, link);
  }
  return [...unique.values()].sort((left, right) => linkExternalKey(left).localeCompare(linkExternalKey(right)));
}

function sourceObservation(event, link) {
  const raw = event.baseObservation
    ?? event.base_observation
    ?? event.observedBase
    ?? event.observed_base
    ?? event.feishuObservation
    ?? event.feishu_observation
    ?? event.base
    ?? null;
  const rawObject = isPlainObject(raw) ? raw : {};
  const hasExplicitObservation = raw !== null
    || event.baseObservedVersion !== undefined
    || event.base_observed_version !== undefined
    || event.observedBaseVersion !== undefined
    || event.observed_base_version !== undefined
    || event.baseFields !== undefined
    || event.base_fields !== undefined;
  const fallback = hasExplicitObservation ? null : link?.lastSourceObservation ?? link?.last_source_observation ?? link?.lastReadback ?? null;
  const value = isPlainObject(fallback) ? fallback : {};
  const payload = firstDefined(
    rawObject.payload,
    rawObject.fields,
    event.baseFields,
    event.base_fields,
    value.payload,
    value.fields,
  );
  const version = versionValue(
    firstDefined(
      rawObject.version,
      rawObject.observedVersion,
      event.baseObservedVersion,
      event.base_observed_version,
      event.observedBaseVersion,
      event.observed_base_version,
      value.version,
      value.baseVersion,
      value.sourceVersion,
    ),
    "baseObservation.version",
  );
  const hash = sideHash(payload, firstDefined(
    rawObject.hash,
    rawObject.payloadHash,
    event.baseHash,
    event.base_hash,
    value.hash,
    value.payloadHash,
    value.sourceHash,
  ));
  return {
    explicit: hasExplicitObservation,
    version,
    hash,
    payload: payload === undefined ? null : cloneMirrorJson(payload),
  };
}

function baselineSide(baseline, side) {
  if (!baseline) return null;
  if (side === "source") {
    return {
      version: firstDefined(baseline.sourceVersion, baseline.baseVersion),
      hash: firstDefined(baseline.sourceHash, baseline.baseHash),
      payload: firstDefined(baseline.sourcePayload, null),
    };
  }
  return {
    version: baseline.taskboardVersion,
    hash: baseline.taskboardHash,
    payload: baseline.taskboardPayload,
  };
}

function unresolvedConflict(state, externalKey) {
  if (typeof state.listUnresolvedConflicts === "function") {
    return state.listUnresolvedConflicts({ externalKey, limit: 100 }).at(0) ?? null;
  }
  if (typeof state.listConflicts === "function") {
    return state.listConflicts({ externalKey, unresolvedOnly: true, limit: 100 }).at(0) ?? null;
  }
  return null;
}

function recordConflict(state, input) {
  if (typeof state.recordConflict !== "function") return null;
  return state.recordConflict(input);
}

function synchronizeCheck(state, {
  link,
  projection,
  event,
  base,
  expectedBaseVersion,
}) {
  const externalKey = linkExternalKey(link);
  const existingConflict = unresolvedConflict(state, externalKey);
  if (existingConflict) return { status: "conflict", conflict: existingConflict, reason: "UNRESOLVED_CONFLICT" };

  const storedBaseline = typeof state.getBaseline === "function" ? state.getBaseline(externalKey) : null;
  const linkSource = link.lastSourceObservation ?? link.last_source_observation ?? null;
  const linkTaskboard = link.lastTaskboardObservation ?? link.last_taskboard_observation ?? null;
  const hasLinkBaseline = Boolean(
    linkSource?.version !== null && linkSource?.version !== undefined
      || linkSource?.hash
      || linkTaskboard?.version !== null && linkTaskboard?.version !== undefined
      || linkTaskboard?.hash,
  );
  const baseline = storedBaseline ?? (hasLinkBaseline ? {
    externalKey,
    taskId: projection.task.id,
    sourceVersion: linkSource?.version ?? null,
    sourceHash: linkSource?.hash ?? null,
    sourcePayload: linkSource?.payload ?? null,
    taskboardVersion: linkTaskboard?.version ?? null,
    taskboardHash: linkTaskboard?.hash ?? null,
    taskboardPayload: linkTaskboard?.payload ?? null,
  } : null);
  const taskboard = {
    version: projection.task.version,
    hash: projection.taskboardHash,
    payload: projection.taskboardSnapshot,
  };
  const source = {
    version: base.version,
    hash: base.hash,
    payload: base.payload,
  };
  const baselineSource = baselineSide(baseline, "source");
  const baselineTaskboard = baselineSide(baseline, "taskboard");
  const sourceKnown = base.version !== null || base.hash !== null || base.payload !== null;
  const sourceChanged = sourceKnown && sideChanged(baselineSource, source);
  const taskboardChanged = sideChanged(baselineTaskboard, taskboard);

  if (sourceChanged && taskboardChanged) {
    const details = {
      eventId: eventId(event, projection.task),
      runId: eventRunId(event),
      expectedBaseVersion: expectedBaseVersion ?? null,
      observedBaseVersion: base.version,
    };
    const dual = typeof state.recordDualChangeConflict === "function"
      ? state.recordDualChangeConflict({
        externalKey,
        taskId: projection.task.id,
        baseline,
        source,
        taskboard,
        reason: "DUAL_SIDE_CHANGE",
        details,
      })
      : { conflict: recordConflict(state, {
        externalKey,
        taskId: projection.task.id,
        baseline,
        source,
        taskboard,
        reason: "DUAL_SIDE_CHANGE",
        details,
      }) };
    if (dual?.conflict) return { status: "conflict", conflict: dual.conflict, reason: "DUAL_SIDE_CHANGE" };
  }

  const explicitExpected = expectedBaseVersion !== null && expectedBaseVersion !== undefined;
  const observedVersion = base.version;
  if (explicitExpected && observedVersion !== null && !sameJson(expectedBaseVersion, observedVersion)) {
    const conflict = recordConflict(state, {
      externalKey,
      taskId: projection.task.id,
      baseline,
      source,
      taskboard,
      reason: "BASE_OBSERVED_VERSION_MISMATCH",
      details: {
        eventId: eventId(event, projection.task),
        runId: eventRunId(event),
        expectedBaseVersion,
        observedBaseVersion: observedVersion,
      },
    });
    return { status: "conflict", conflict, reason: "BASE_OBSERVED_VERSION_MISMATCH" };
  }

  if (sourceChanged) {
    return {
      status: "blocked",
      reason: "BASE_CHANGE_PENDING",
      error: {
        code: "BASE_CHANGE_PENDING",
        message: "Base changed after the last successful baseline; inbound reconciliation is required before mirroring",
      },
    };
  }
  return {
    status: "ready",
    baseline,
    taskboard,
    source,
  };
}

function expectedBaseVersionFor(state, link, event) {
  const explicit = firstDefined(
    event.expectedBaseVersion,
    event.expected_base_version,
    event.baseExpectedVersion,
    event.base_expected_version,
  );
  if (explicit !== null) return versionValue(explicit, "expectedBaseVersion");
  const baseline = typeof state.getBaseline === "function" ? state.getBaseline(linkExternalKey(link)) : null;
  return firstDefined(
    baseline?.sourceVersion,
    baseline?.baseVersion,
    link.lastSourceObservation?.version,
    link.lastReadback?.version,
    null,
  );
}

function outboxByKey(state, idempotencyKey) {
  if (typeof state.getOutboxByIdempotencyKey !== "function") return null;
  return state.getOutboxByIdempotencyKey(idempotencyKey);
}

function storedPackageMatches(stored, envelope) {
  if (!stored) return true;
  const storedMessage = stored.message ?? stored.payload;
  return sameJson(stablePackageMessage(storedMessage), stablePackageMessage(envelope))
    && stored.externalKey === envelope.externalKey
    && stored.taskId === envelope.taskId
    && stored.idempotencyKey === envelope.idempotencyKey;
}

function stablePackageMessage(message) {
  const copy = cloneMirrorJson(message);
  delete copy.generatedAt;
  delete copy.eventId;
  delete copy.runId;
  const removeReconciliationTime = (value) => {
    if (!isPlainObject(value)) return;
    delete value["最后对账时间"];
  };
  removeReconciliationTime(copy.payload?.fields);
  removeReconciliationTime(copy.payload?.formalRequirement?.fields);
  removeReconciliationTime(copy.payload?.formal_requirement?.fields);
  return copy;
}

function enqueuePackage(state, envelope, projection, link, source, event) {
  const existing = outboxByKey(state, envelope.idempotencyKey);
  if (existing) {
    if (!storedPackageMatches(existing, envelope)) {
      const conflict = recordConflict(state, {
        externalKey: envelope.externalKey,
        taskId: envelope.taskId,
        outboxId: existing.outboxId,
        reason: "IDEMPOTENCY_CONFLICT",
        source,
        taskboard: {
          version: projection.task.version,
          hash: projection.taskboardHash,
          payload: projection.taskboardSnapshot,
        },
        details: {
          eventId: eventId(event, projection.task),
          existingOutboxId: existing.outboxId,
          idempotencyKey: envelope.idempotencyKey,
        },
      });
      return { status: "conflict", conflict, reason: "IDEMPOTENCY_CONFLICT" };
    }
    return {
      status: "dry_run",
      replayed: true,
      package: packageFromOutbox(existing),
      outbox: existing,
    };
  }

  let outbox;
  try {
    outbox = state.enqueueOutbox({
      idempotencyKey: envelope.idempotencyKey,
      externalKey: envelope.externalKey,
      taskId: envelope.taskId,
      mappingVersion: envelope.mappingVersion,
      payload: envelope.payload,
      message: envelope,
      sourceVersion: source.version,
      sourceHash: source.hash,
      sourcePayload: source.payload,
      taskboardVersion: projection.task.version,
      taskboardHash: projection.taskboardHash,
      taskboardPayload: projection.taskboardSnapshot,
      createdAt: envelope.generatedAt,
    });
  } catch (error) {
    if (error?.code === "IDEMPOTENCY_CONFLICT" && typeof state.getOutboxByIdempotencyKey === "function") {
      const replay = state.getOutboxByIdempotencyKey(envelope.idempotencyKey);
      if (replay && storedPackageMatches(replay, envelope)) {
        return {
          status: "dry_run",
          replayed: true,
          package: packageFromOutbox(replay),
          outbox: replay,
        };
      }
    }
    throw error;
  }
  return {
    status: "dry_run",
    created: outbox?.created !== false,
    replayed: outbox?.reused === true,
    package: packageFromOutbox(outbox),
    outbox,
  };
}

function projectionFromEnvelope(envelope) {
  return {
    generatedAt: envelope.generatedAt,
    task: envelope.payload.task,
    fields: envelope.payload.fields ?? envelope.payload.formalRequirement?.fields,
    preserved: envelope.payload.preserved,
    taskboardSnapshot: envelope.payload.taskboardSnapshot,
    taskboardHash: envelope.taskboardHash,
    payload: envelope.payload,
  };
}

function summarize(event, results, extra = {}) {
  const packages = results.filter((result) => result.package).map((result) => result.package);
  const outboxes = results.filter((result) => result.outbox).map((result) => result.outbox);
  const conflicts = results.filter((result) => result.conflict).map((result) => result.conflict);
  const blocked = results.filter((result) => result.status === "blocked");
  let status = "skipped";
  if (conflicts.length > 0) status = "conflict";
  else if (packages.length > 0) status = "dry_run";
  else if (blocked.length > 0) status = "blocked";
  return Object.freeze({
    status,
    mode: MIRROR_DRY_RUN_MODE,
    eventType: event?.type ?? null,
    eventId: extra.eventId ?? null,
    runId: extra.runId ?? null,
    packages: Object.freeze(packages),
    outboxes: Object.freeze(outboxes),
    conflicts: Object.freeze(conflicts),
    results: Object.freeze(results),
    package: packages[0] ?? null,
    outbox: outboxes[0] ?? null,
    ...extra,
  });
}

function skip(event, reason, details = undefined) {
  return summarize(event, [{ status: "skipped", reason, details }], {
    reason,
    details: details ?? null,
  });
}

function blocked(event, reason, error = undefined) {
  return summarize(event, [{ status: "blocked", reason, error }], {
    reason,
    error: error ?? null,
  });
}

function conflictResult(event, result) {
  return summarize(event, [result], {
    reason: result.reason,
    conflict: result.conflict ?? null,
  });
}

export class TaskboardMirrorProjector {
  constructor(options = {}) {
    if (!isPlainObject(options)) fail("INVALID_PROJECTOR_OPTIONS", "projector options must be an object");
    if (!options.state) fail("MISSING_STATE_STORE", "A FeishuBaseStateStore is required for outbound projection");
    this.state = options.state;
    this.settings = normalizeConfig(options);
    this.projectAssignments = new Map();
  }

  subscribe(eventHub) {
    if (!eventHub || typeof eventHub.subscribe !== "function") {
      fail("EVENT_HUB_NOT_CONFIGURED", "eventHub.subscribe is required");
    }
    return eventHub.subscribe((event) => this.handleEvent(event));
  }

  handleEvent(event) {
    if (!isPlainObject(event)) return skip({}, "INVALID_EVENT");
    if (!TASKBOARD_MIRROR_EVENT_TYPES.includes(event.type)) return skip(event, "UNSUPPORTED_EVENT");
    if (isProjectionEcho(event)) return skip(event, "PROJECTION_ECHO");
    let task;
    try {
      task = this.#taskSnapshot(event.task, event);
    } catch (error) {
      return blocked(event, "TASK_DETAILS_UNAVAILABLE", {
        code: error?.code ?? "TASK_DETAILS_UNAVAILABLE",
        message: error?.message ?? String(error),
      });
    }
    if (!isPlainObject(task) || event.taskExists === false || event.task_exists === false) {
      return skip(event, "TASK_NOT_FOUND");
    }
    const projectId = taskProjectId(task);
    if (!projectId || this.settings.allowedProjectIds && !this.settings.allowedProjectIds.has(projectId)) {
      return skip(event, "TASK_OUT_OF_SCOPE");
    }
    const links = linksForTask(this.state, task, this.settings, event);
    const assignment = explicitProjectAssignment(event, task, this.settings);
    if (assignment) this.projectAssignments.set(task.id ?? task.taskId, assignment);
    if (links.length === 0) return skip(event, "NO_VALID_EXTERNAL_LINK");

    const results = [];
    for (const link of links) {
      const tableKey = tableKeyForLink(link, this.settings.config);
      if (tableKey === IDEA_TABLE_KEY) {
        results.push(this.#projectIdeaEvent(event, task, link));
      } else if (tableKey === FORMAL_TABLE_KEY) {
        results.push(this.#projectFormalEvent(event, task, link));
      }
    }
    const result = summarize(event, results, {
      eventId: eventId(event, task),
      runId: eventRunId(event),
    });
    return result;
  }

  #taskSnapshot(task, event) {
    if (!isPlainObject(task)) return null;
    const id = task.id ?? task.taskId;
    if (!id) return task;
    const reader = this.settings.taskReader;
    let loaded = task;
    if (reader) {
      const value = reader(id, task, event);
      if (value && typeof value.then === "function") {
        fail("ASYNC_TASK_READER", "taskReader must be synchronous for an event projector");
      }
      const candidate = value?.task ?? value;
      if (candidate === null) return null;
      if (isPlainObject(candidate)) loaded = { ...task, ...candidate };
    }
    if (!Object.hasOwn(loaded, "comments") && this.settings.commentsReader) {
      const comments = this.settings.commentsReader(id, loaded, event);
      if (comments && typeof comments.then === "function") fail("ASYNC_COMMENTS_READER", "commentsReader must be synchronous");
      if (comments !== undefined) loaded = { ...loaded, comments };
    }
    if (!Object.hasOwn(loaded, "attachments") && this.settings.attachmentsReader) {
      const attachments = this.settings.attachmentsReader(id, loaded, event);
      if (attachments && typeof attachments.then === "function") fail("ASYNC_ATTACHMENTS_READER", "attachmentsReader must be synchronous");
      if (attachments !== undefined) loaded = { ...loaded, attachments };
    }
    return loaded;
  }

  reconcileTask({ task, event = {}, explicit = false, ...overrides } = {}) {
    if (explicit !== true) {
      return blocked(event, "EXPLICIT_RECONCILIATION_REQUIRED", {
        code: "EXPLICIT_RECONCILIATION_REQUIRED",
        message: "Reconciliation is opt-in and cannot be used as a batch backfill",
      });
    }
    return this.handleEvent({
      ...event,
      ...overrides,
      type: event.type ?? "task.updated",
      task,
      explicit: true,
    });
  }

  #projectFormalEvent(event, rawTask, link) {
    let projection;
    try {
      const task = rawTask;
      projection = projectionFromEnvelope(prepareTaskboardMirror({
        task,
        link,
        projectName: projectNameFor(task, this.settings, event),
        taskboardBaseUrl: this.settings.taskboardBaseUrl,
        generatedAt: event.at ?? this.settings.clock(),
        eventId: eventId(event, task),
        runId: eventRunId(event),
        expectedBaseVersion: expectedBaseVersionFor(this.state, link, event),
        threadMetadata: {
          codexThreadId: event.codexThreadId ?? event.codex_thread_id,
          aiThreadId: event.aiThreadId ?? event.ai_thread_id,
        },
      }));
    } catch (error) {
      return {
        status: "blocked",
        reason: error?.code ?? "INVALID_PROJECTION",
        error: {
          code: error?.code ?? "INVALID_PROJECTION",
          message: error?.message ?? String(error),
        },
      };
    }
    const base = sourceObservation(event, link);
    const check = synchronizeCheck(this.state, {
      link,
      projection,
      event,
      base,
      expectedBaseVersion: projection.expectedBaseVersion ?? expectedBaseVersionFor(this.state, link, event),
    });
    if (check.status !== "ready") return check;
    const envelope = projectionEnvelope(projection, link, event, "mirror_task", {
      target: projection.payload?.target,
      expectedBaseVersion: expectedBaseVersionFor(this.state, link, event),
    });
    return enqueuePackage(this.state, envelope, projection, link, base, event);
  }

  #projectIdeaEvent(event, rawTask, link) {
    const taskId = rawTask.id ?? rawTask.taskId;
    if (event.type !== "task.moved") {
      return { status: "skipped", reason: "PRODUCT_IDEA_WAITING_FOR_MANUAL_PROMOTION" };
    }
    const previousStatus = event.fromStatus ?? event.from_status ?? event.previousStatus ?? event.previous_status;
    if (previousStatus !== "backlog" || rawTask.status !== "todo") {
      return { status: "skipped", reason: "PROMOTION_REQUIRES_BACKLOG_TO_TODO" };
    }
    if (isAutomatedMove(event)) {
      return { status: "skipped", reason: "PROMOTION_REQUIRES_MANUAL_MOVE" };
    }
    const assignment = this.projectAssignments.get(taskId);
    if (!assignment || assignment.projectId !== taskProjectId(rawTask)) {
      return { status: "skipped", reason: "PROJECT_ASSIGNMENT_NOT_CONFIRMED" };
    }
    const projectName = assignment.projectName ?? projectNameFor(rawTask, this.settings, event, { requireExplicit: true });
    if (!projectName) return { status: "blocked", reason: "PROJECT_ASSIGNMENT_UNRESOLVED", error: {
      code: "PROJECT_ASSIGNMENT_UNRESOLVED",
      message: "The product idea has no explicitly resolved target project",
    } };
    if (!this.settings.formalTableId || !this.settings.formalAppToken) {
      return { status: "blocked", reason: "FORMAL_TARGET_UNCONFIGURED", error: {
        code: "FORMAL_TARGET_UNCONFIGURED",
        message: "A configured requirements table and app token are required for promote_idea",
      } };
    }
    const existingFormalLink = typeof this.state.listLinks === "function"
      ? this.state.listLinks({ taskId, limit: 10_000 }).find((candidate) => (
        tableKeyForLink(candidate, this.settings.config) === FORMAL_TABLE_KEY
      ))
      : null;
    if (existingFormalLink) {
      return {
        status: "blocked",
        reason: "ALREADY_PROMOTED",
        error: {
          code: "ALREADY_PROMOTED",
          message: "The Taskboard task already has a formal requirement link",
          externalKey: linkExternalKey(existingFormalLink),
        },
      };
    }

    let projection;
    try {
      projection = projectionFromEnvelope(prepareIdeaPromotion({
        task: rawTask,
        ideaLink: link,
        formalAppToken: this.settings.formalAppToken,
        formalTableId: this.settings.formalTableId,
        projectName,
        taskboardBaseUrl: this.settings.taskboardBaseUrl,
        previousStatus,
        generatedAt: event.at ?? this.settings.clock(),
        eventId: eventId(event, rawTask),
        runId: eventRunId(event),
        expectedBaseVersion: expectedBaseVersionFor(this.state, link, event),
        threadMetadata: {
          codexThreadId: event.codexThreadId ?? event.codex_thread_id,
          aiThreadId: event.aiThreadId ?? event.ai_thread_id,
        },
      }));
    } catch (error) {
      return {
        status: "blocked",
        reason: error?.code ?? "INVALID_PROMOTION",
        error: {
          code: error?.code ?? "INVALID_PROMOTION",
          message: error?.message ?? String(error),
        },
      };
    }
    const base = sourceObservation(event, link);
    const check = synchronizeCheck(this.state, {
      link,
      projection,
      event,
      base,
      expectedBaseVersion: expectedBaseVersionFor(this.state, link, event),
    });
    if (check.status !== "ready") return check;
    const envelope = projectionEnvelope(projection, link, event, "promote_idea", {
      stableTarget: {
        sourceExternalKey: linkExternalKey(link),
        formalAppToken: this.settings.formalAppToken,
        formalTableId: this.settings.formalTableId,
        transition: { from: "backlog", to: "todo" },
      },
      expectedBaseVersion: expectedBaseVersionFor(this.state, link, event),
    });
    return enqueuePackage(this.state, envelope, projection, link, base, event);
  }
}

function projectionEnvelope(projection, link, event, operation, {
  stableTarget = undefined,
  expectedBaseVersion = null,
} = {}) {
  const payload = operation === "mirror_task"
    ? {
      task: projection.task,
      target: projection.payload?.target ?? null,
      fields: projection.fields,
      preserved: projection.preserved,
      taskboardSnapshot: projection.taskboardSnapshot,
    }
    : {
      task: projection.task,
      transition: projection.payload?.transition,
      sourceIdea: projection.payload?.sourceIdea,
      sourceUpdateFields: projection.payload?.sourceUpdateFields,
      formalRequirement: projection.payload?.formalRequirement,
      preserved: projection.preserved,
      taskboardSnapshot: projection.taskboardSnapshot,
    };
  const target = stableTarget
    ?? (operation === "mirror_task" ? projection.payload?.target : stableTarget);
  return createMirrorEnvelope({
    operation,
    externalKey: linkExternalKey(link),
    taskId: projection.task.id,
    taskboardVersion: projection.task.version,
    taskboardHash: projection.taskboardHash,
    generatedAt: projection.generatedAt,
    payload,
    stableTarget: target,
    eventId: eventId(event, projection.task),
    runId: eventRunId(event),
    expectedBaseVersion,
  });
}

export function createMirrorProjector(options = {}) {
  return new TaskboardMirrorProjector(options);
}

export const MirrorProjector = TaskboardMirrorProjector;
export const projectTaskEvent = (projectorOrOptions, event) => {
  if (event === undefined && isPlainObject(projectorOrOptions) && projectorOrOptions.event) {
    const { event: actualEvent, ...options } = projectorOrOptions;
    const projector = new TaskboardMirrorProjector(options);
    return projector.handleEvent(actualEvent);
  }
  const projector = projectorOrOptions instanceof TaskboardMirrorProjector
    ? projectorOrOptions
    : new TaskboardMirrorProjector(projectorOrOptions);
  return projector.handleEvent(event);
};

export const projectTaskboardEvent = projectTaskEvent;
export const handleTaskEvent = projectTaskEvent;

export function subscribeTaskboardMirror(eventHub, projectorOrOptions) {
  const projector = projectorOrOptions instanceof TaskboardMirrorProjector
    ? projectorOrOptions
    : new TaskboardMirrorProjector(projectorOrOptions);
  return projector.subscribe(eventHub);
}

export default createMirrorProjector;
