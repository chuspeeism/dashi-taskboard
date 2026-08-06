#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");
const launcherApp = "/Applications/ChatGPT.app";
const officialApp = "/Applications/.ChatGPT Official.app";
const officialBundleId = "com.openai.codex";
const launcherBundleId = "com.dashi.taskboard.chatgpt-launcher";
const launcherExecutable = "taskboard-chatgpt-launcher";
const debuggingPort = 9231;
const launchServices = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

function parseArgs(argv) {
  const options = { uninstall: false };
  for (const arg of argv) {
    if (arg === "--uninstall") options.uninstall = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function readBundleId(appPath) {
  const result = spawnSync(
    "/usr/bin/plutil",
    ["-extract", "CFBundleIdentifier", "raw", path.join(appPath, "Contents", "Info.plist")],
    { encoding: "utf8" },
  );
  return result.status === 0 ? result.stdout.trim() : null;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function launcherPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>ChatGPT</string>
  <key>CFBundleExecutable</key>
  <string>${xmlEscape(launcherExecutable)}</string>
  <key>CFBundleIconFile</key>
  <string>app.icns</string>
  <key>CFBundleIdentifier</key>
  <string>${xmlEscape(launcherBundleId)}</string>
  <key>CFBundleName</key>
  <string>ChatGPT</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
`;
}

function launcherScript() {
  const injectorPath = path.join(projectRoot, "scripts", "codex-injector.mjs");
  const logPath = path.join(projectRoot, ".data", "chatgpt-launcher.log");
  return `#!/bin/zsh
set -u

OFFICIAL_APP=${shellQuote(officialApp)}
NODE_BIN=${shellQuote(process.execPath)}
INJECTOR=${shellQuote(injectorPath)}
PROJECT_ROOT=${shellQuote(projectRoot)}
LOG_PATH=${shellQuote(logPath)}
DEBUG_PORT=${debuggingPort}

/bin/mkdir -p "$PROJECT_ROOT/.data"
exec >>"$LOG_PATH" 2>&1
echo "[$(/bin/date '+%Y-%m-%d %H:%M:%S')] launcher invoked"

if [[ ! -d "$OFFICIAL_APP" ]]; then
  echo "Official ChatGPT app is missing: $OFFICIAL_APP"
  /usr/bin/osascript -e 'display notification "找不到官方 ChatGPT 应用" with title "Taskboard 启动失败"'
  exit 1
fi

if ! /usr/bin/curl -fsS --max-time 1 "http://127.0.0.1:$DEBUG_PORT/json/version" >/dev/null 2>&1; then
  existing_chatgpt_pids=$(/usr/bin/pgrep -x ChatGPT || true)
  if [[ -n "$existing_chatgpt_pids" ]]; then
    echo "Restarting ChatGPT so Taskboard can enable the CDP port"
    /usr/bin/osascript -e 'tell application id "com.openai.codex" to quit'
    stopped=false
    for _ in {1..80}; do
      if ! /usr/bin/pgrep -x ChatGPT >/dev/null 2>&1; then
        stopped=true
        break
      fi
      /bin/sleep 0.25
    done
    if [[ "$stopped" != true ]]; then
      echo "Timed out waiting for the existing ChatGPT process to quit"
      /usr/bin/osascript -e 'display notification "请完全退出 ChatGPT 后重试" with title "Taskboard 启动失败"'
      exit 1
    fi
  fi

  /usr/bin/open -n -a "$OFFICIAL_APP" --args \
    "--remote-debugging-port=$DEBUG_PORT" \
    "--remote-allow-origins=http://127.0.0.1:$DEBUG_PORT"

  ready=false
  for _ in {1..120}; do
    if /usr/bin/curl -fsS --max-time 1 "http://127.0.0.1:$DEBUG_PORT/json/version" >/dev/null 2>&1; then
      ready=true
      break
    fi
    /bin/sleep 0.25
  done
  if [[ "$ready" != true ]]; then
    echo "Timed out waiting for ChatGPT CDP on port $DEBUG_PORT"
    /usr/bin/osascript -e 'display notification "ChatGPT 调试端口未就绪" with title "Taskboard 启动失败"'
    exit 1
  fi
fi

if ! CODEX_TASKBOARD_HOST=127.0.0.1 "$NODE_BIN" "$INJECTOR" \
  --daemon --port "$DEBUG_PORT" --open; then
  echo "Failed to start the resident Taskboard injector"
  /usr/bin/osascript -e 'display notification "注入器启动失败，请查看启动日志" with title "Taskboard 启动失败"'
  exit 1
fi

/usr/bin/open -a "$OFFICIAL_APP"
echo "Taskboard launcher completed"
`;
}

function registerApplication(appPath) {
  spawnSync(launchServices, ["-f", appPath], { stdio: "ignore" });
}

async function install() {
  const launcherExists = await exists(launcherApp);
  const officialExists = await exists(officialApp);
  const currentBundleId = launcherExists ? readBundleId(launcherApp) : null;

  if (launcherExists && currentBundleId === officialBundleId) {
    if (officialExists) {
      throw new Error(`${officialApp} already exists; refusing to overwrite it`);
    }
    await rename(launcherApp, officialApp);
  } else if (launcherExists && currentBundleId !== launcherBundleId) {
    throw new Error(`${launcherApp} is not the official ChatGPT app or the Taskboard launcher`);
  }

  if (readBundleId(officialApp) !== officialBundleId) {
    throw new Error(`Official ChatGPT app was not found at ${officialApp}`);
  }

  if (await exists(launcherApp)) await rm(launcherApp, { recursive: true });
  const contents = path.join(launcherApp, "Contents");
  const macOS = path.join(contents, "MacOS");
  const resources = path.join(contents, "Resources");
  await mkdir(macOS, { recursive: true });
  await mkdir(resources, { recursive: true });
  await writeFile(path.join(contents, "Info.plist"), launcherPlist());
  await writeFile(path.join(macOS, launcherExecutable), launcherScript());
  await chmod(path.join(macOS, launcherExecutable), 0o755);
  await copyFile(path.join(officialApp, "Contents", "Resources", "app.icns"), path.join(resources, "app.icns"));
  registerApplication(launcherApp);

  console.log(`Installed Taskboard launcher at ${launcherApp}`);
  console.log(`Official ChatGPT app is preserved at ${officialApp}`);
}

async function uninstall() {
  if (readBundleId(launcherApp) !== launcherBundleId) {
    throw new Error(`Taskboard launcher was not found at ${launcherApp}`);
  }
  if (readBundleId(officialApp) !== officialBundleId) {
    throw new Error(`Official ChatGPT app was not found at ${officialApp}`);
  }

  await rm(launcherApp, { recursive: true });
  await rename(officialApp, launcherApp);
  registerApplication(launcherApp);
  console.log(`Restored official ChatGPT app at ${launcherApp}`);
}

const options = parseArgs(process.argv.slice(2));
if (options.uninstall) await uninstall();
else await install();
