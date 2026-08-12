#!/usr/bin/env node

import { randomBytes, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";

const appPath = process.argv[2] ? path.resolve(process.argv[2]) : null;
if (!appPath) throw new Error("Usage: verify-packaged-taskctl.mjs <App.app>");

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error("Packaged Taskboard server did not exit")),
      timeoutMs,
    )),
  ]);
}

function runTaskctl(wrapperPath, homeDirectory, args) {
  const result = spawnSync(wrapperPath, args, {
    encoding: "utf8",
    env: {
      HOME: homeDirectory,
      PATH: "/usr/bin:/bin",
      CODEX_THREAD_ID: "00000000-0000-4000-8000-000000000001",
    },
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "Packaged taskctl failed");
  }
  return JSON.parse(result.stdout);
}

const temporaryHome = await mkdtemp(path.join(os.tmpdir(), "codex-taskboard-taskctl."));
const dataDirectory = path.join(
  temporaryHome,
  "Library",
  "Application Support",
  "Codex Taskboard",
);
await mkdir(dataDirectory, { recursive: true });
const runtimeFile = path.join(dataDirectory, "launcher-runtime.json");
const nodePath = path.join(appPath, "Contents", "MacOS", "node");
const appRoot = path.join(appPath, "Contents", "Resources", "app");
const wrapperPath = path.join(appPath, "Contents", "Resources", "bin", "taskctl");
const reservation = createServer();
await new Promise((resolve, reject) => {
  reservation.once("error", reject);
  reservation.listen(0, "127.0.0.1", resolve);
});
const address = reservation.address();
const inheritedFd = reservation._handle?.fd;
if (!address || typeof address === "string" || !Number.isInteger(inheritedFd)) {
  throw new Error("Could not reserve the packaged Taskboard listener");
}

const instanceToken = randomUUID();
const instanceSecret = randomBytes(32).toString("hex");
const server = spawn(nodePath, [path.join(appRoot, "server", "index.mjs")], {
  cwd: appRoot,
  env: {
    ...process.env,
    CODEX_TASKBOARD_DATA_DIR: dataDirectory,
    CODEX_TASKBOARD_HOST: "127.0.0.1",
    CODEX_TASKBOARD_PORT: String(address.port),
    CODEX_TASKBOARD_LISTEN_FD: "5",
    CODEX_TASKBOARD_INSTANCE_TOKEN: instanceToken,
    CODEX_TASKBOARD_INSTANCE_SECRET: instanceSecret,
    CODEX_TASKBOARD_VERSION: "preflight",
  },
  stdio: ["ignore", "pipe", "pipe", "ignore", "ignore", inheritedFd],
});
reservation._handle.readStop();

let stderr = "";
server.stderr.setEncoding("utf8");
server.stderr.on("data", (chunk) => { stderr += chunk; });
try {
  await new Promise((resolve, reject) => {
    let stdout = "";
    const timeout = setTimeout(() => reject(new Error(stderr || "Packaged server did not start")), 15_000);
    server.stdout.setEncoding("utf8");
    server.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("Codex Taskboard listening")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    server.once("exit", () => {
      clearTimeout(timeout);
      reject(new Error(stderr || "Packaged server exited during startup"));
    });
  });

  await writeFile(
    runtimeFile,
    `${JSON.stringify({
      version: 1,
      pid: server.pid,
      url: `http://127.0.0.1:${address.port}/${instanceToken}`,
    })}\n`,
    { mode: 0o600 },
  );
  if ((await stat(runtimeFile)).mode % 0o1000 !== 0o600) {
    throw new Error("Packaged Taskboard runtime descriptor must use mode 0600");
  }

  const projects = runTaskctl(wrapperPath, temporaryHome, ["project", "list", "--json"]);
  const projectId = projects.projects?.[0]?.id;
  if (!projectId) throw new Error("Packaged taskctl did not list the local project");
  const cloudStatus = runTaskctl(wrapperPath, temporaryHome, ["cloud", "status", "--json"]);
  if (cloudStatus.mode !== "local") throw new Error("Packaged cloud status used the wrong endpoint");
  const mapping = runTaskctl(wrapperPath, temporaryHome, [
    "project", "map", projectId,
    "--workspace-path", appRoot,
    "--json",
  ]);
  if (mapping.projectId !== projectId || mapping.workspacePath !== appRoot) {
    throw new Error("Packaged project map used the wrong endpoint");
  }
  const created = runTaskctl(wrapperPath, temporaryHome, [
    "issue", "create",
    "--project", projectId,
    "--title", "Packaged taskctl preflight",
    "--status", "todo",
    "--thread-id", "00000000-0000-4000-8000-000000000001",
    "--json",
  ]).task;
  const fetched = runTaskctl(wrapperPath, temporaryHome, ["issue", "get", created.id, "--json"]).task;
  if (fetched.title !== "Packaged taskctl preflight") throw new Error("Packaged issue get failed");
  const updated = runTaskctl(wrapperPath, temporaryHome, [
    "issue", "update", created.id,
    "--title", "Packaged taskctl verified",
    "--if-version", String(fetched.version),
    "--thread-id", "00000000-0000-4000-8000-000000000001",
    "--json",
  ]).task;
  if (updated.title !== "Packaged taskctl verified") throw new Error("Packaged issue update failed");
  const comment = runTaskctl(wrapperPath, temporaryHome, [
    "comment", "add", created.id,
    "--body", "packaged endpoint verified",
    "--thread-id", "00000000-0000-4000-8000-000000000001",
    "--json",
  ]).comment;
  if (comment.body !== "packaged endpoint verified") throw new Error("Packaged comment add failed");

  server.kill("SIGTERM");
  await waitForExit(server, 10_000);
  const takeover = createServer();
  const takeoverError = await new Promise((resolve) => {
    takeover.once("error", resolve);
    takeover.listen(address.port, "127.0.0.1", () => resolve(null));
  });
  if (!takeoverError || takeoverError.code !== "EADDRINUSE") {
    takeover.close();
    throw new Error("The launcher-owned listener was replaceable after server exit");
  }
} finally {
  if (server.exitCode === null && server.signalCode === null) {
    server.kill("SIGKILL");
    await waitForExit(server, 2_000).catch(() => {});
  }
  await new Promise((resolve) => reservation.close(resolve));
  await rm(temporaryHome, { recursive: true, force: true });
}

console.log("Verified packaged taskctl discovery and launcher-owned listener");
