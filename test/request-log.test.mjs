import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { main } from "../cli/taskctl.mjs";
import { createTaskboardServer } from "../server/app.mjs";
import { diagnoseRequests } from "../shared/request-diagnostics.mjs";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../cli/taskctl.mjs", import.meta.url));
// Declared test sources, not assertions of authenticated native conversation identity.
const A = "10000000-0000-4000-8000-000000000001";
const B = "10000000-0000-4000-8000-000000000002";

async function command(runtimeFile, threadId, args) {
  const env = { ...process.env, CODEX_TASKBOARD_RUNTIME_FILE: runtimeFile, CODEX_THREAD_ID: threadId };
  delete env.CODEX_TASKBOARD_URL;
  delete env.CODEX_TASKBOARD_COMPANION_URL;
  try {
    const result = await exec(process.execPath, [cli, ...args, "--json"], { env });
    return { exitCode: 0, value: JSON.parse(result.stdout) };
  } catch (error) {
    return { exitCode: error.code, value: JSON.parse(error.stderr) };
  }
}

test("real CLI sources, HTTP success/rejection, persistence, and no sensitive request material", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-request-log-"));
  const runtimeFile = path.join(directory, "runtime.json");
  const token = "private-launcher-token-1234567890123456";
  const secrets = [token, "PRIVATE_AUTH_SENTINEL", "PRIVATE_BODY_SENTINEL", "PRIVATE_QUERY_SENTINEL", "PRIVATE_PATH_SENTINEL"];
  let app;
  async function start() {
    app = createTaskboardServer({ dataDirectory: directory, instanceToken: token, instanceSecret: "a".repeat(64) });
    const address = await app.listen({ port: 0 });
    const url = `http://127.0.0.1:${address.port}/${token}`;
    await writeFile(runtimeFile, JSON.stringify({ version: 1, url }));
    return url;
  }
  try {
    let url = await start();
    const created = await fetch(`${url}/api/tasks?private=PRIVATE_QUERY_SENTINEL`, {
      method: "POST",
      headers: {
        "content-type": "application/json", "x-taskboard-client": "taskctl",
        "x-taskboard-source-thread": A, authorization: "Bearer PRIVATE_AUTH_SENTINEL",
      },
      body: JSON.stringify({
        projectId: "local", title: "Log fixture", threadId: A,
        description: "**目标：** 保留摘要和关系\n**当前进展：** 日志已合并\n**下一步：** 读取结果\n\n## 技术详情与原始记录\nPRIVATE_BODY_SENTINEL",
      }),
    });
    assert.equal(created.status, 201);
    const task = (await created.json()).task;

    const parentResponse = await fetch(`${url}/api/tasks`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: "local", title: "Summary parent fixture", threadId: A }),
    });
    assert.equal(parentResponse.status, 201);
    const parent = (await parentResponse.json()).task;
    const relation = await fetch(`${url}/api/tasks/${task.id}/relations/parent/${parent.id}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: task.version, threadId: A }),
    });
    assert.equal(relation.status, 200);

    const defaultFull = await command(runtimeFile, B, ["issue", "get", task.id]);
    const full = await command(runtimeFile, B, ["issue", "get", task.id, "--view", "full"]);
    assert.deepEqual(defaultFull.value, full.value);
    const summaryGet = await command(runtimeFile, B, ["issue", "get", task.id, "--view", "summary"]);
    const summaryList = await command(runtimeFile, B, ["issue", "list", "--view", "summary"]);
    assert.equal(summaryGet.exitCode, 0);
    assert.equal(summaryList.exitCode, 0);
    const summary = summaryGet.value.task;
    assert.deepEqual(summary, summaryList.value.tasks.find((value) => value.id === task.id));
    assert.deepEqual(summary.summary, { goal: "保留摘要和关系", progress: "日志已合并", next: "读取结果" });
    assert.equal(summary.summaryComplete, true);
    assert.equal("description" in summary, false);
    assert.equal(JSON.stringify(summary).includes("PRIVATE_BODY_SENTINEL"), false);
    assert.equal(summary.relations.parent.id, parent.id);
    for (const field of ["id", "version", "threadId", "threadBinding", "relations"]) {
      assert.deepEqual(summary[field], full.value.task[field]);
    }

    assert.equal((await command(runtimeFile, A, ["issue", "list"])).exitCode, 0);
    assert.equal((await command(runtimeFile, B, ["issue", "get", task.id])).exitCode, 0);
    const failed = await command(runtimeFile, B, ["issue", "get", "PRIVATE_PATH_SENTINEL"]);
    assert.equal(failed.exitCode, 4);
    assert.equal(failed.value.error.code, "TASK_NOT_FOUND");
    assert.equal(failed.value.error.trace.delivery, "http_response");
    assert.ok(failed.value.error.trace.requestId);

    const denied = await fetch(`${url}/api/tasks?secret=PRIVATE_QUERY_SENTINEL`, {
      headers: { origin: "https://untrusted.example", "x-taskboard-client": "taskctl", "x-taskboard-source-thread": A },
    });
    assert.equal(denied.status, 403);
    const deniedCode = (await denied.json()).error.code;

    const listed = await command(runtimeFile, A, ["log", "list", "--limit", "1000"]);
    assert.equal(listed.exitCode, 0);
    assert.equal(listed.value.coverage.attribution, "self_reported_not_authenticated");
    assert.equal(listed.value.coverage.writeFailures, 0);
    const records = listed.value.records;
    assert.ok(records.some((v) => v.source.threadId === A && v.method === "GET" && v.route === "/api/tasks" && v.result === "success"));
    assert.ok(records.some((v) => v.source.threadId === B && v.taskId === task.id && v.result === "success"));
    const correlated = records.filter((v) => v.requestId === failed.value.error.trace.requestId);
    assert.equal(correlated.length, 2);
    assert.equal(correlated[0].event, "received");
    assert.equal(correlated[1].status, 404);
    assert.equal(correlated[1].errorCode, "TASK_NOT_FOUND");
    assert.equal(correlated[1].clientRequestId, failed.value.error.trace.clientRequestId);
    assert.ok(correlated[1].durationMs >= 0);
    assert.ok(records.some((v) => v.event === "completed" && v.status === 403 && v.errorCode === deniedCode));

    const analysis = await command(runtimeFile, A, ["log", "analyze", "--limit", "1000"]);
    assert.equal(analysis.exitCode, 0);
    assert.ok(analysis.value.sources.some((v) => v.source.threadId === A && v.success > 0));
    assert.ok(analysis.value.sources.some((v) => v.source.threadId === B && v.rejected > 0));
    assert.equal(analysis.value.coverage.absenceIsNotProofOfNoRequest, true);

    const byId = await command(runtimeFile, A, ["log", "list", "--request-id", failed.value.error.trace.clientRequestId]);
    assert.equal(byId.value.records.length, 2);
    const bySource = await command(runtimeFile, A, ["log", "list", "--source-thread", B]);
    assert.ok(bySource.value.records.length > 0);
    assert.ok(bySource.value.records.every((v) => v.source.threadId === B));

    await app.close();
    app = null;
    const logFile = path.join(directory, "logs", "api-requests.jsonl");
    const raw = await readFile(logFile, "utf8");
    for (const secret of secrets) assert.equal(raw.includes(secret), false, `leaked ${secret}`);

    url = await start();
    const persisted = await command(runtimeFile, A, ["log", "list", "--source-thread", B]);
    assert.ok(persisted.value.records.some((v) => v.requestId === failed.value.error.trace.requestId));
    await app.close();
    app = null;
    const beforeFailedConnect = await readFile(logFile, "utf8");
    const disconnected = await command(runtimeFile, A, ["issue", "list"]);
    assert.equal(disconnected.exitCode, 3);
    assert.equal(disconnected.value.error.trace.delivery, "not_connected");
    assert.equal(disconnected.value.error.trace.requestId, null);
    assert.equal(disconnected.value.error.trace.transportCode, "ECONNREFUSED");
    assert.equal(await readFile(logFile, "utf8"), beforeFailedConnect);
    assert.equal(JSON.stringify(disconnected.value).includes(token), false);
  } finally {
    if (app) await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an unclassified transport failure stays unknown instead of claiming the server never received it", async () => {
  let output = "";
  const code = await main(["issue", "list"], {
    env: { CODEX_TASKBOARD_URL: "http://127.0.0.1:12345/private-secret-token", CODEX_THREAD_ID: A },
    fetch: async () => { throw new Error("PRIVATE_TRANSPORT_DETAIL"); },
    stdout: { write() {} }, stderr: { write: (value) => { output += value; } },
  });
  assert.equal(code, 3);
  const failure = JSON.parse(output).error;
  assert.equal(failure.trace.delivery, "unknown");
  assert.ok(failure.trace.clientRequestId);
  assert.equal(output.includes("private-secret-token"), false);
  assert.equal(output.includes("PRIVATE_TRANSPORT_DETAIL"), false);
});

test("diagnosis locates CLI failures, saves and independent readbacks without inventing a model or a missing call", async () => {
  const responseOnly = [
    { invocationId: A, event: "http_response", clientRequestId: B, status: 200, time: "2026-01-01T00:00:00Z", tool: "issue get" },
    { invocationId: A, event: "cli_finished", exitCode: 4, errorCode: "INVALID_RESPONSE", time: "2026-01-01T00:00:01Z", tool: "issue get" },
  ];
  assert.equal(diagnoseRequests([], responseOnly).invocations[0].outcome, "failed_after_http_response");
  assert.equal(diagnoseRequests([], [{ ...responseOnly[0] }, { ...responseOnly[1], exitCode: 0 }]).invocations[0].outcome, "server_record_not_observed");
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-diagnosis-"));
  const runtimeFile = path.join(directory, "runtime.json");
  const app = createTaskboardServer({ dataDirectory: directory, instanceToken: "", instanceSecret: "" });
  let closed = false;
  try {
    const address = await app.listen({ port: 0 });
    const url = `http://127.0.0.1:${address.port}`;
    await writeFile(runtimeFile, JSON.stringify({ version: 1, url }));
    const response = await fetch(`${url}/api/tasks`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: "local", title: "Diagnosis fixture", threadId: A }),
    });
    const initial = (await response.json()).task;
    const saved = await command(runtimeFile, A, ["issue", "update", initial.id,
      "--title", "PRIVATE_DIAGNOSIS_BODY", "--if-version", String(initial.version)]);
    assert.equal(saved.exitCode, 0);
    // Another declared source's GET does not establish the writer's own readback.
    assert.equal((await command(runtimeFile, B, ["issue", "get", initial.id])).exitCode, 0);
    let diagnosis = await command(runtimeFile, A, ["log", "diagnose", "--source-thread", A]);
    let write = diagnosis.value.invocations.find((r) => r.tool === "issue update");
    assert.equal(write.outcome, "save_committed");
    assert.equal(write.saves[0].beforeVersion, initial.version);
    assert.equal(write.saves[0].version, saved.value.task.version);
    assert.deepEqual(write.saves[0].requestedFields, ["title"]);
    assert.equal(write.saves[0].readback, "not_observed");
    assert.equal(write.model.id, null);
    assert.equal(write.model.provenance, "unavailable_at_tool_boundary");
    await command(runtimeFile, A, ["issue", "get", initial.id, "--view", "summary"]);
    diagnosis = await command(runtimeFile, A, ["log", "diagnose", "--source-thread", A]);
    write = diagnosis.value.invocations.find((r) => r.tool === "issue update");
    assert.equal(write.saves[0].readback, "version_confirmed");
    assert.equal(write.saves[0].contentCorrectness, "not_checked_by_metadata_log");

    const comment = await command(runtimeFile, A, ["comment", "add", initial.id, "--body", "PRIVATE_COMMENT_BODY"]);
    assert.equal(comment.exitCode, 0);
    await command(runtimeFile, A, ["comment", "list", initial.id]);
    const taskAfterComment = await command(runtimeFile, A, ["issue", "get", initial.id]);
    assert.equal(taskAfterComment.value.task.version, saved.value.task.version);
    diagnosis = await command(runtimeFile, A, ["log", "diagnose", "--source-thread", A]);
    const commentWrite = diagnosis.value.invocations.find((r) => r.tool === "comment add");
    assert.equal(commentWrite.saves[0].entity, "comment");
    assert.equal(commentWrite.saves[0].readback, "version_confirmed");

    const beforeHttpFailure = await command(runtimeFile, A, ["issue", "update", initial.id,
      "--description-file", path.join(directory, "PRIVATE_MISSING_FILE"), "--if-version", String(saved.value.task.version)]);
    assert.notEqual(beforeHttpFailure.exitCode, 0);
    const rejected = await command(runtimeFile, A, ["issue", "update", initial.id,
      "--title", "PRIVATE_REJECTED_BODY", "--if-version", String(initial.version)]);
    assert.equal(rejected.exitCode, 5);
    await fetch(`${url}/api/tasks/${initial.id}`); // Real source is unavailable; never infer it from the card binding.
    diagnosis = await command(runtimeFile, A, ["log", "diagnose"]);
    assert.ok(diagnosis.value.invocations.some((r) => r.outcome === "failed_before_http"));
    assert.ok(diagnosis.value.invocations.some((r) => r.outcome === "http_rejected" && r.requests.some((v) => v.errorCode === "VERSION_CONFLICT")));
    assert.ok(diagnosis.value.invocations.some((r) => r.source.threadId === null && r.tool === null));
    const reader = await command(runtimeFile, A, ["log", "diagnose", "--source-thread", B]);
    assert.equal(reader.value.invocations[0].outcome, "read_only");
    assert.equal(reader.value.invocations[0].saves.length, 0);
    const absent = await command(runtimeFile, A, ["log", "diagnose", "--source-thread", "10000000-0000-4000-8000-000000000099"]);
    assert.equal(absent.value.observation, "not_observed");
    assert.equal(absent.value.limits.absence, "not_observed_is_not_proof_of_not_called");
    const window = await command(runtimeFile, A, ["log", "diagnose", "--source-thread", A, "--until", "2000-01-01T00:00:00Z"]);
    assert.equal(window.value.observation, "not_observed");
    assert.equal(window.value.coverage.server.requestedWindow.until, "2000-01-01T00:00:00Z");
    let invalidLogResponse;
    const invalidLogCode = await main(["log", "diagnose"], {
      env: { CODEX_TASKBOARD_RUNTIME_FILE: runtimeFile },
      fetch: async () => new Response("{}"), stdout: { write: (v) => { invalidLogResponse = JSON.parse(v); } },
    });
    assert.equal(invalidLogCode, 0);
    assert.equal(invalidLogResponse.coverage.server.errorCode, "INVALID_RESPONSE");

    await app.close(); closed = true;
    const disconnected = await command(runtimeFile, A, ["issue", "list"]);
    assert.equal(disconnected.value.error.trace.delivery, "not_connected");
    const offlineDiagnosis = await command(runtimeFile, A, ["log", "diagnose", "--source-thread", A]);
    assert.equal(offlineDiagnosis.exitCode, 0);
    assert.equal(offlineDiagnosis.value.coverage.server.errorCode, "SERVICE_UNAVAILABLE");
    assert.ok(offlineDiagnosis.value.invocations.some((r) => r.outcome === "connection_not_established"));
    for (const file of ["api-requests.jsonl", "taskctl-invocations.jsonl"]) {
      const raw = await readFile(path.join(directory, "logs", file), "utf8");
      for (const secret of ["PRIVATE_DIAGNOSIS_BODY", "PRIVATE_COMMENT_BODY", "PRIVATE_MISSING_FILE", "PRIVATE_REJECTED_BODY"]) {
        assert.equal(raw.includes(secret), false, `${file} leaked ${secret}`);
      }
    }
  } finally {
    if (!closed) await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
