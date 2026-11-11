import { appendFile, mkdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";

// File location comes from the selected runtime descriptor, never its URL/token.
export function invocationLogFile(runtimeFile) {
  return path.join(path.dirname(path.resolve(runtimeFile)), "logs", "taskctl-invocations.jsonl");
}

export function createInvocationLog(file, context) {
  const coverage = { writeFailures: 0, lastErrorCode: null };
  const audit = async (event) => {
    try {
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await appendFile(file, `${JSON.stringify({ ...context, ...event, time: new Date().toISOString() })}\n`, { mode: 0o600 });
    } catch (error) {
      coverage.writeFailures += 1;
      coverage.lastErrorCode = ["EACCES", "EPERM", "ENOSPC", "EDQUOT", "EROFS", "EISDIR", "ENOTDIR",
        "ENOENT", "EMFILE", "ENFILE", "EIO"].includes(error.code) ? error.code : "UNKNOWN_IO_ERROR";
    }
  };
  audit.coverage = coverage;
  return audit;
}

export async function readInvocationLog(file, limit, sourceThreadId, since, until, taskId, correlatedInvocationIds = new Set()) {
  const records = [];
  const coverage = { scope: "selected_runtime_client_journal", filePresent: true, truncated: false, unreadableRecords: 0 };
  try {
    const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    for await (const line of lines) {
      let record;
      try { record = JSON.parse(line); } catch { coverage.unreadableRecords += 1; continue; }
      if (sourceThreadId && record.source?.threadId !== sourceThreadId && record.clientContextThreadId !== sourceThreadId) continue;
      if (taskId && record.taskId !== taskId && !correlatedInvocationIds.has(record.invocationId)) continue;
      if (since && Date.parse(record.time) < Date.parse(since)) continue;
      if (until && Date.parse(record.time) > Date.parse(until)) continue;
      records.push(record);
      if (records.length > limit) { records.shift(); coverage.truncated = true; }
    }
  } catch (error) {
    coverage.filePresent = error.code === "ENOENT" ? false : null;
    coverage.errorCode = error.code === "ENOENT" ? "JOURNAL_NOT_FOUND" : "JOURNAL_UNREADABLE";
  }
  return { records, coverage };
}
