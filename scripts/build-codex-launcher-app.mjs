#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

if (process.platform !== "darwin") {
  throw new Error("Codex Taskboard.app can only be built on macOS");
}

const nodeVersion = "24.18.0";
const nodeArchitectures = ["arm64", "x64"];
const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");
const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
const outputDir = path.join(projectRoot, "dist", "macos");
const runtimeCacheDir = path.join(projectRoot, "dist", "runtime-cache");
const appDir = path.join(outputDir, "Codex Taskboard.app");
const contentsDir = path.join(appDir, "Contents");
const executableDir = path.join(contentsDir, "MacOS");
const resourcesDir = path.join(contentsDir, "Resources");
const bundledAppDir = path.join(resourcesDir, "app");
const executablePath = path.join(executableDir, "CodexTaskboardLauncher");
const iconPath = path.join(resourcesDir, "codex-taskboard.icns");
const iconSource = path.join(projectRoot, "web", "public", "codex-app-icon.png");

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

async function downloadNodeRuntime(architecture) {
  const archiveName = `node-v${nodeVersion}-darwin-${architecture}.tar.gz`;
  const archivePath = path.join(runtimeCacheDir, archiveName);
  if (await exists(archivePath)) return archivePath;

  const downloadUrl = `https://nodejs.org/dist/v${nodeVersion}/${archiveName}`;
  const temporaryPath = `${archivePath}.download`;
  console.log(`Downloading ${downloadUrl}`);
  const response = await fetch(downloadUrl);
  if (!response.ok) {
    throw new Error(`Node runtime download failed: ${response.status} ${response.statusText}`);
  }
  await writeFile(temporaryPath, Buffer.from(await response.arrayBuffer()));
  await rename(temporaryPath, archivePath);
  return archivePath;
}

async function bundleNodeRuntime(architecture) {
  const archivePath = await downloadNodeRuntime(architecture);
  const extractedDirectory = path.join(runtimeCacheDir, `node-v${nodeVersion}-darwin-${architecture}`);
  const runtimeSourceDirectory = path.join(
    extractedDirectory,
    `node-v${nodeVersion}-darwin-${architecture}`,
  );
  const runtimeDestinationDirectory = path.join(
    resourcesDir,
    "node",
    `darwin-${architecture}`,
    "bin",
  );

  await rm(extractedDirectory, { recursive: true, force: true });
  await mkdir(extractedDirectory, { recursive: true });
  run("/usr/bin/tar", ["-xzf", archivePath, "-C", extractedDirectory]);
  await mkdir(runtimeDestinationDirectory, { recursive: true });
  const nodeDestination = path.join(runtimeDestinationDirectory, "node");
  await copyFile(path.join(runtimeSourceDirectory, "bin", "node"), nodeDestination);
  await chmod(nodeDestination, 0o755);
  if (architecture === "arm64") {
    await copyFile(path.join(runtimeSourceDirectory, "LICENSE"), path.join(resourcesDir, "node", "LICENSE"));
  }
  await rm(extractedDirectory, { recursive: true, force: true });
  return nodeDestination;
}

await rm(appDir, { recursive: true, force: true });
await mkdir(executableDir, { recursive: true });
await mkdir(resourcesDir, { recursive: true });
await mkdir(runtimeCacheDir, { recursive: true });
run("/usr/bin/sips", ["-s", "format", "icns", iconSource, "--out", iconPath]);

await Promise.all([
  cp(path.join(projectRoot, "server"), path.join(bundledAppDir, "server"), { recursive: true }),
  cp(path.join(projectRoot, "shared"), path.join(bundledAppDir, "shared"), { recursive: true }),
  cp(path.join(projectRoot, "dist", "web"), path.join(bundledAppDir, "dist", "web"), {
    recursive: true,
  }),
  cp(
    path.join(projectRoot, "skills", "manage-taskboard"),
    path.join(bundledAppDir, "skills", "manage-taskboard"),
    { recursive: true },
  ),
]);

await mkdir(path.join(bundledAppDir, "scripts"), { recursive: true });
for (const fileName of [
  "codex-injector.mjs",
  "codex-injector-runtime.mjs",
  "codex-rate-limits.mjs",
]) {
  await copyFile(
    path.join(projectRoot, "scripts", fileName),
    path.join(bundledAppDir, "scripts", fileName),
  );
}
await mkdir(path.join(bundledAppDir, "inject"), { recursive: true });
await copyFile(
  path.join(projectRoot, "inject", "codex-taskboard.user.js"),
  path.join(bundledAppDir, "inject", "codex-taskboard.user.js"),
);
await mkdir(path.join(bundledAppDir, "cli"), { recursive: true });
await copyFile(
  path.join(projectRoot, "cli", "taskctl.mjs"),
  path.join(bundledAppDir, "cli", "taskctl.mjs"),
);

const bundledNodePaths = [];
for (const architecture of nodeArchitectures) {
  bundledNodePaths.push(await bundleNodeRuntime(architecture));
}

const launcher = `#!/bin/zsh
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONTENTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RESOURCES_DIR="$CONTENTS_DIR/Resources"
APP_ROOT="$RESOURCES_DIR/app"
DATA_DIR="$HOME/Library/Application Support/Codex Taskboard"
LOG_DIR="$HOME/Library/Logs/Codex Taskboard"

MACHINE_ARCH="$(/usr/bin/uname -m)"
if [[ "$(/usr/sbin/sysctl -in sysctl.proc_translated 2>/dev/null)" == "1" ]]; then
  MACHINE_ARCH="arm64"
fi

case "$MACHINE_ARCH" in
  arm64) NODE_BIN="$RESOURCES_DIR/node/darwin-arm64/bin/node" ;;
  x86_64) NODE_BIN="$RESOURCES_DIR/node/darwin-x64/bin/node" ;;
  *) exit 1 ;;
esac

mkdir -p "$DATA_DIR" "$LOG_DIR"
export CODEX_TASKBOARD_DATA_DIR="$DATA_DIR"
export CODEX_TASKBOARD_HOST=127.0.0.1
export PATH="$RESOURCES_DIR/bin:$PATH"

CODEX_APP_PATH=""
for CANDIDATE in \
  "/Applications/ChatGPT.app" \
  "$HOME/Applications/ChatGPT.app" \
  "/Applications/Codex.app" \
  "$HOME/Applications/Codex.app"
do
  if [[ -d "$CANDIDATE" ]]; then
    CODEX_APP_PATH="$CANDIDATE"
    break
  fi
done

if [[ -z "$CODEX_APP_PATH" ]]; then
  print -r -- "Official Codex app was not found." >>"$LOG_DIR/codex-taskboard-launcher.log"
  exit 1
fi

cd "$APP_ROOT" || exit 1
/usr/bin/nohup "$NODE_BIN" "$APP_ROOT/scripts/codex-injector.mjs" \
  --launch \
  --watch \
  --open \
  --port 9231 \
  --app-path "$CODEX_APP_PATH" \
  </dev/null \
  >>"$LOG_DIR/codex-taskboard-launcher.log" 2>&1 &

exit 0
`;

const taskctlWrapper = `#!/bin/zsh
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RESOURCES_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MACHINE_ARCH="$(/usr/bin/uname -m)"
if [[ "$(/usr/sbin/sysctl -in sysctl.proc_translated 2>/dev/null)" == "1" ]]; then
  MACHINE_ARCH="arm64"
fi

case "$MACHINE_ARCH" in
  arm64) NODE_BIN="$RESOURCES_DIR/node/darwin-arm64/bin/node" ;;
  x86_64) NODE_BIN="$RESOURCES_DIR/node/darwin-x64/bin/node" ;;
  *) exit 1 ;;
esac

export CODEX_TASKBOARD_DATA_DIR="$HOME/Library/Application Support/Codex Taskboard"
exec "$NODE_BIN" "$RESOURCES_DIR/app/cli/taskctl.mjs" "$@"
`;

const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>Codex Taskboard</string>
  <key>CFBundleDisplayName</key>
  <string>Codex Taskboard</string>
  <key>CFBundleIdentifier</key>
  <string>local.codex-taskboard.launcher</string>
  <key>CFBundleVersion</key>
  <string>${packageJson.version}</string>
  <key>CFBundleShortVersionString</key>
  <string>${packageJson.version}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleExecutable</key>
  <string>CodexTaskboardLauncher</string>
  <key>CFBundleIconFile</key>
  <string>codex-taskboard.icns</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
`;

await writeFile(executablePath, launcher);
await chmod(executablePath, 0o755);
await mkdir(path.join(resourcesDir, "bin"), { recursive: true });
const taskctlPath = path.join(resourcesDir, "bin", "taskctl");
await writeFile(taskctlPath, taskctlWrapper);
await chmod(taskctlPath, 0o755);
await writeFile(path.join(contentsDir, "Info.plist"), infoPlist);
await writeFile(path.join(contentsDir, "PkgInfo"), "APPL????");

run("/usr/bin/plutil", ["-lint", path.join(contentsDir, "Info.plist")]);
for (const nodePath of bundledNodePaths) {
  run("/usr/bin/codesign", ["--force", "--sign", "-", nodePath]);
}
run("/usr/bin/codesign", ["--force", "--sign", "-", executablePath]);
run("/usr/bin/codesign", ["--force", "--sign", "-", appDir]);
run("/usr/bin/codesign", ["--verify", "--deep", "--strict", appDir]);

console.log(appDir);
