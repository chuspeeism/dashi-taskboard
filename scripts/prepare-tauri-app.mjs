#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  cp,
  link,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const nodeVersion = "22.23.2";
const nodeArchitectures = ["arm64", "x64"];
const nodeArchiveSha256 = {
  arm64: "61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6",
  x64: "58e99022c2ff89395576cc7fd4d98cea24bb68081475d5f88b801ee8729fb026",
};
const windowsTarget = "x86_64-pc-windows-msvc";
const windowsNodeArchiveName = `node-v${nodeVersion}-win-x64.zip`;
const windowsNodeArchiveSha256 =
  "1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97";
const supportedTargets = new Set([
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "universal-apple-darwin",
  windowsTarget,
]);
const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");
const tauriRoot = path.join(projectRoot, "src-tauri");
const binariesDirectory = path.join(tauriRoot, "binaries");
const resourcesDirectory = path.join(tauriRoot, "resources");
const runtimeCacheDirectory = path.join(projectRoot, "dist", "tauri-runtime-cache");
const extractionDirectory = path.join(runtimeCacheDirectory, "extracted");
const target = parseTarget(process.argv.slice(2));

if (target === windowsTarget && process.platform !== "win32") {
  throw new Error("Codex Taskboard for Windows must be prepared on Windows");
}
if (target !== windowsTarget && process.platform !== "darwin") {
  throw new Error("Codex Taskboard for macOS must be prepared on macOS");
}

function parseTarget(argv) {
  let selected = process.platform === "win32" ? windowsTarget : "universal-apple-darwin";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--target") selected = argv[++index];
    else throw new Error(`Unknown option: ${argument}`);
  }
  if (!supportedTargets.has(selected)) {
    throw new Error(`Unsupported Tauri target: ${selected}`);
  }
  return selected;
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `${command} exited with ${result.status}`);
  }
  return result.stdout.trim();
}

async function exists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  hash.update(await readFile(filePath));
  return hash.digest("hex");
}

async function download(url, destination) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText} (${url})`);
  }
  const temporaryPath = `${destination}.download`;
  await writeFile(temporaryPath, Buffer.from(await response.arrayBuffer()));
  await rename(temporaryPath, destination);
}

async function verifiedNodeArchive(archiveName, expectedChecksum) {
  const archivePath = path.join(runtimeCacheDirectory, archiveName);
  if (!(await exists(archivePath)) || (await sha256(archivePath)) !== expectedChecksum) {
    await rm(archivePath, { force: true });
    await download(`https://nodejs.org/dist/v${nodeVersion}/${archiveName}`, archivePath);
  }
  if ((await sha256(archivePath)) !== expectedChecksum) {
    throw new Error(`Checksum verification failed for ${archiveName}`);
  }
  return { archiveName, archivePath };
}

async function extractNodeRuntime(architecture) {
  const archiveName = `node-v${nodeVersion}-darwin-${architecture}.tar.gz`;
  const { archivePath } = await verifiedNodeArchive(
    archiveName,
    nodeArchiveSha256[architecture],
  );
  const destination = path.join(extractionDirectory, architecture);
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  run("/usr/bin/tar", ["-xzf", archivePath, "-C", destination]);
  return path.join(destination, `node-v${nodeVersion}-darwin-${architecture}`);
}

async function prepareMacNodeRuntime() {
  const runtimes = new Map();
  for (const architecture of nodeArchitectures) {
    runtimes.set(architecture, await extractNodeRuntime(architecture));
  }

  const universalNodePath = path.join(binariesDirectory, "node-universal-apple-darwin");
  await mkdir(binariesDirectory, { recursive: true });
  run("/usr/bin/lipo", [
    "-create",
    path.join(runtimes.get("arm64"), "bin", "node"),
    path.join(runtimes.get("x64"), "bin", "node"),
    "-output",
    universalNodePath,
  ]);
  await chmod(universalNodePath, 0o755);
  const architectures = run("/usr/bin/lipo", ["-archs", universalNodePath]);
  if (!architectures.includes("arm64") || !architectures.includes("x86_64")) {
    throw new Error(`Universal Node runtime has unexpected architectures: ${architectures}`);
  }

  for (const targetTriple of ["aarch64-apple-darwin", "x86_64-apple-darwin"]) {
    const targetPath = path.join(binariesDirectory, `node-${targetTriple}`);
    await rm(targetPath, { force: true });
    await link(universalNodePath, targetPath);
  }
  await mkdir(path.join(resourcesDirectory, "licenses"), { recursive: true });
  await copyFile(
    path.join(runtimes.get("arm64"), "LICENSE"),
    path.join(resourcesDirectory, "licenses", "Node-LICENSE"),
  );
  await copyFile(
    path.join(tauriRoot, "licenses", "Lobe-Icons-LICENSE.txt"),
    path.join(resourcesDirectory, "licenses", "Lobe-Icons-LICENSE.txt"),
  );
}

async function prepareWindowsNodeRuntime() {
  const { archivePath } = await verifiedNodeArchive(
    windowsNodeArchiveName,
    windowsNodeArchiveSha256,
  );
  const destination = path.join(extractionDirectory, "win-x64");
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  run(path.join(process.env.SystemRoot, "System32", "tar.exe"), [
    "-xf",
    archivePath,
    "-C",
    destination,
  ]);

  const runtime = path.join(destination, `node-v${nodeVersion}-win-x64`);
  const targetPath = path.join(binariesDirectory, `node-${windowsTarget}.exe`);
  await mkdir(binariesDirectory, { recursive: true });
  await rm(targetPath, { force: true });
  await copyFile(path.join(runtime, "node.exe"), targetPath);
  await mkdir(path.join(resourcesDirectory, "licenses"), { recursive: true });
  await copyFile(
    path.join(runtime, "LICENSE"),
    path.join(resourcesDirectory, "licenses", "Node-LICENSE"),
  );
  await copyFile(
    path.join(tauriRoot, "licenses", "Lobe-Icons-LICENSE.txt"),
    path.join(resourcesDirectory, "licenses", "Lobe-Icons-LICENSE.txt"),
  );
}

async function copyApplicationResources() {
  const appResources = path.join(resourcesDirectory, "app");
  await rm(resourcesDirectory, { recursive: true, force: true });
  await mkdir(appResources, { recursive: true });
  await Promise.all([
    cp(path.join(projectRoot, "server"), path.join(appResources, "server"), { recursive: true }),
    cp(path.join(projectRoot, "shared"), path.join(appResources, "shared"), { recursive: true }),
    cp(path.join(projectRoot, "dist", "web"), path.join(appResources, "dist", "web"), {
      recursive: true,
    }),
    cp(
      path.join(projectRoot, "skills", "manage-taskboard"),
      path.join(appResources, "skills", "manage-taskboard"),
      { recursive: true },
    ),
  ]);

  await mkdir(path.join(appResources, "scripts"), { recursive: true });
  for (const fileName of [
    "codex-cdp-pipe.mjs",
    "codex-injector.mjs",
    "codex-injector-runtime.mjs",
    "codex-rate-limits.mjs",
    "taskboard-supervisor.mjs",
  ]) {
    await copyFile(
      path.join(projectRoot, "scripts", fileName),
      path.join(appResources, "scripts", fileName),
    );
  }
  await mkdir(path.join(appResources, "inject"), { recursive: true });
  await copyFile(
    path.join(projectRoot, "inject", "codex-taskboard.user.js"),
    path.join(appResources, "inject", "codex-taskboard.user.js"),
  );
  await mkdir(path.join(appResources, "cli"), { recursive: true });
  await copyFile(
    path.join(projectRoot, "cli", "taskctl.mjs"),
    path.join(appResources, "cli", "taskctl.mjs"),
  );

  if (target === windowsTarget) {
    const taskctlWrapper = [
      "@echo off",
      "setlocal",
      "set \"CODEX_TASKBOARD_DATA_DIR=%APPDATA%\\Codex Taskboard\"",
      "set \"CODEX_TASKBOARD_RUNTIME_FILE=%CODEX_TASKBOARD_DATA_DIR%\\launcher-runtime.json\"",
      "\"%~dp0..\\node.exe\" \"%~dp0..\\app\\cli\\taskctl.mjs\" %*",
      "exit /b %ERRORLEVEL%",
      "",
    ].join("\r\n");
    const taskctlPath = path.join(resourcesDirectory, "bin", "taskctl.cmd");
    await mkdir(path.dirname(taskctlPath), { recursive: true });
    await writeFile(taskctlPath, taskctlWrapper);
    return;
  }

  const taskctlWrapper = `#!/bin/zsh
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONTENTS_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
export CODEX_TASKBOARD_DATA_DIR="$HOME/Library/Application Support/Codex Taskboard"
export CODEX_TASKBOARD_RUNTIME_FILE="$CODEX_TASKBOARD_DATA_DIR/launcher-runtime.json"
exec "$CONTENTS_DIR/MacOS/node" "$CONTENTS_DIR/Resources/app/cli/taskctl.mjs" "$@"
`;
  const taskctlPath = path.join(resourcesDirectory, "bin", "taskctl");
  await mkdir(path.dirname(taskctlPath), { recursive: true });
  await writeFile(taskctlPath, taskctlWrapper);
  await chmod(taskctlPath, 0o755);
}

await mkdir(runtimeCacheDirectory, { recursive: true });
await copyApplicationResources();
if (target === windowsTarget) await prepareWindowsNodeRuntime();
else await prepareMacNodeRuntime();
await rm(extractionDirectory, { recursive: true, force: true });
console.log(`Prepared Tauri resources for ${target} with Node.js ${nodeVersion}`);
