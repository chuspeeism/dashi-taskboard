#!/usr/bin/env node

import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const APP_NAME = "Codex + Taskboard";
const APP_BUNDLE_ID = "com.ffcreative.codex-taskboard-launcher";
const SERVICE_LABEL = "com.ffcreative.dashi-taskboard";
const CODEX_LABEL = "com.ffcreative.dashi-taskboard-codex";
const DEFAULT_CODEX_APP = "/Applications/ChatGPT.app";
const DEFAULT_PORT = 47823;
const DEFAULT_CDP_PORT = 9229;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function resolveCodexExecutable(options = {}) {
  const configured = options.codexExecutable ?? process.env.CODEX_EXECUTABLE;
  if (configured && path.isAbsolute(configured)) return configured;
  const executableName = configured || "codex";
  const located = spawnSync("/usr/bin/which", [executableName], {
    encoding: "utf8",
    env: process.env,
  });
  const executable = located.status === 0 ? located.stdout.trim() : "";
  return executable || executableName;
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function plistString(value) {
  return `<string>${xmlEscape(value)}</string>`;
}

function renderPlist(dict) {
  const body = Object.entries(dict).map(([key, value]) => {
    if (Array.isArray(value)) {
      return `  <key>${xmlEscape(key)}</key>\n  <array>\n${value
        .map((item) => `    ${plistString(item)}`)
        .join("\n")}\n  </array>`;
    }
    if (value && typeof value === "object") {
      return `  <key>${xmlEscape(key)}</key>\n  <dict>\n${Object.entries(value)
        .map(([nestedKey, nestedValue]) => `    <key>${xmlEscape(nestedKey)}</key>\n    ${plistString(nestedValue)}`)
        .join("\n")}\n  </dict>`;
    }
    if (typeof value === "boolean") {
      return `  <key>${xmlEscape(key)}</key>\n  <${value ? "true" : "false"}/>`;
    }
    if (typeof value === "number") {
      return `  <key>${xmlEscape(key)}</key>\n  <integer>${value}</integer>`;
    }
    return `  <key>${xmlEscape(key)}</key>\n  ${plistString(value)}`;
  }).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n${body}\n</dict>\n</plist>\n`;
}

function resolveMacOSPaths({
  homeDirectory = homedir(),
  repoRoot = projectRoot,
  nodeBinary = process.execPath,
} = {}) {
  const appPath = path.join(homeDirectory, "Applications", `${APP_NAME}.app`);
  const appContentsPath = path.join(appPath, "Contents");
  const logDirectory = path.join(homeDirectory, "Library", "Logs");
  return {
    homeDirectory,
    repoRoot,
    nodeBinary,
    appPath,
    appContentsPath,
    appInfoPath: path.join(appContentsPath, "Info.plist"),
    appExecutablePath: path.join(appContentsPath, "MacOS", "CodexTaskboardLauncher"),
    serviceLaunchAgentPath: path.join(homeDirectory, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`),
    codexLaunchAgentPath: path.join(homeDirectory, "Library", "LaunchAgents", `${CODEX_LABEL}.plist`),
    taskboardDatabasePath: path.join(repoRoot, ".data", "taskboard.sqlite"),
    serviceLogPath: path.join(logDirectory, "dashi-taskboard.log"),
    serviceErrorLogPath: path.join(logDirectory, "dashi-taskboard-error.log"),
    codexLogPath: path.join(logDirectory, "dashi-taskboard-codex.log"),
    codexErrorLogPath: path.join(logDirectory, "dashi-taskboard-codex-error.log"),
  };
}

function renderLauncherScript(paths, {
  taskboardPort = DEFAULT_PORT,
  cdpPort = DEFAULT_CDP_PORT,
  codexApp = DEFAULT_CODEX_APP,
} = {}) {
  const q = shellQuote;
  const taskboardRoot = q(paths.repoRoot);
  const nodeBinary = q(paths.nodeBinary);
  const injectorScript = q(path.join(paths.repoRoot, "scripts", "codex-injector.mjs"));
  const runtimeDirectory = q(path.join(paths.homeDirectory, "Library", "Application Support", "Dashi Taskboard"));
  const lockDirectory = q(path.join(paths.homeDirectory, "Library", "Application Support", "Dashi Taskboard", "injector.lock"));
  const taskboardLaunchAgentPath = q(paths.serviceLaunchAgentPath);
  const logPath = q(paths.codexLogPath);
  const errorLogPath = q(paths.codexErrorLogPath);
  const codexLaunchAgentPath = q(paths.codexLaunchAgentPath);
  const quotedCodexApp = q(codexApp);

  return `#!/bin/zsh

set -u

TASKBOARD_ROOT=${taskboardRoot}
NODE_BIN=${nodeBinary}
INJECTOR_SCRIPT=${injectorScript}
RUNTIME_DIR=${runtimeDirectory}
CODEX_USER_DATA_PATH="$RUNTIME_DIR/CodexProfile"
LOCK_DIR=${lockDirectory}
TASKBOARD_LAUNCH_AGENT=${taskboardLaunchAgentPath}
TASKBOARD_LAUNCH_LABEL=${q(SERVICE_LABEL)}
CODEX_LAUNCH_AGENT=${codexLaunchAgentPath}
CODEX_LAUNCH_LABEL=${q(CODEX_LABEL)}
CDP_PORT=${q(cdpPort)}
CDP_VERSION_URL="http://127.0.0.1:$CDP_PORT/json/version"
TASKBOARD_PORT=${q(taskboardPort)}
CODEX_APP=${quotedCodexApp}

export CODEX_TASKBOARD_HOST="127.0.0.1"
export CODEX_TASKBOARD_PORT="$TASKBOARD_PORT"
export CODEX_TASKBOARD_DATA_DIR="$TASKBOARD_ROOT/.data"
export CODEX_TASKBOARD_CODEX_USER_DATA_PATH="$CODEX_USER_DATA_PATH"
export PATH="${shellQuote(path.dirname(paths.nodeBinary)).slice(1, -1)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

MODE="\${1:-interactive}"

log() {
  print "[$(/bin/date '+%Y-%m-%d %H:%M:%S')] $*"
}

cdp_reachable() {
  /usr/bin/curl -fsS --max-time 2 "$CDP_VERSION_URL" >/dev/null 2>&1
}

ordinary_codex_running() {
  /usr/bin/pgrep -x "ChatGPT" >/dev/null 2>&1
}

notify_degraded() {
  log "degraded: ordinary Codex has no loopback CDP; open Codex + Taskboard instead"
  /usr/bin/osascript -e 'display notification "普通 Codex 入口无法加载 Taskboard。请打开 Codex + Taskboard。" with title "Codex + Taskboard"' >/dev/null 2>&1 || true
}

resident_pids() {
  /usr/bin/pgrep -f "$INJECTOR_SCRIPT.*--watch.*--port[=[:space:]]$CDP_PORT([[:space:]]|$)" 2>/dev/null || true
}

ensure_runtime_directory() {
  /bin/mkdir -p "$RUNTIME_DIR" || {
    log "unable to create launcher runtime directory"
    exit 1
  }
}

wait_for_taskboard_service() {
  for _ in {1..40}; do
    if /usr/bin/curl -fsS --max-time 2 "http://127.0.0.1:$TASKBOARD_PORT/health" >/dev/null 2>&1; then
      return 0
    fi
    /bin/sleep 0.25
  done
  return 1
}

ensure_taskboard_service() {
  local launch_domain="gui$(printf '/%s' "$(/usr/bin/id -u)")"
  if ! /bin/launchctl print "$launch_domain/$TASKBOARD_LAUNCH_LABEL" >/dev/null 2>&1; then
    /bin/launchctl bootstrap "$launch_domain" "$TASKBOARD_LAUNCH_AGENT" || {
      log "unable to bootstrap Taskboard service"
      return 1
    }
    if wait_for_taskboard_service; then
      return 0
    fi
    log "Taskboard service did not become ready after bootstrap"
    return 1
  fi
  if /usr/bin/curl -fsS --max-time 2 "http://127.0.0.1:$TASKBOARD_PORT/health" >/dev/null 2>&1; then
    return 0
  fi
  /bin/launchctl kickstart -k "$launch_domain/$TASKBOARD_LAUNCH_LABEL" || {
    log "unable to kickstart Taskboard service"
    return 1
  }
  if wait_for_taskboard_service; then
    return 0
  fi
  log "Taskboard service did not become ready"
  return 1
}

refresh_existing() {
  local refresh_result
  refresh_result=$("$NODE_BIN" "$INJECTOR_SCRIPT" --refresh --open --port "$CDP_PORT" 2>&1) || {
    log "existing injector open failed: $refresh_result"
    return 1
  }
  print "$refresh_result"
}

run_resident() {
  local launch_mode="$1"
  if [[ "$launch_mode" == "launch" ]]; then
    "$NODE_BIN" "$INJECTOR_SCRIPT" --launch --watch --managed-taskboard --open --port "$CDP_PORT" &
  else
    "$NODE_BIN" "$INJECTOR_SCRIPT" --watch --managed-taskboard --attach-existing --open --port "$CDP_PORT" &
  fi
  RESIDENT_PID=$!
  log "resident injector pid=$RESIDENT_PID mode=$launch_mode"
  wait "$RESIDENT_PID"
}

if [[ "$MODE" == "--self-test" ]]; then
  [[ -x "$NODE_BIN" ]] || { print -u2 "missing node: $NODE_BIN"; exit 1; }
  [[ -f "$INJECTOR_SCRIPT" ]] || { print -u2 "missing injector: $INJECTOR_SCRIPT"; exit 1; }
  [[ -d "$TASKBOARD_ROOT/.data" ]] || { print -u2 "missing database directory: $TASKBOARD_ROOT/.data"; exit 1; }
  print "node=$($NODE_BIN --version)"
  print "injector=ok"
  print "database-directory=ok"
  exit 0
fi

ensure_runtime_directory
exec >>${logPath} 2>>${errorLogPath}
log "launcher mode=$MODE"

ensure_taskboard_service || exit $?

if [[ "$MODE" != "--login" ]]; then
  if cdp_reachable; then
    /usr/bin/osascript -e 'tell application "ChatGPT" to activate' >/dev/null 2>&1 || true
    if refresh_existing; then
      exit 0
    fi
  fi
  if ordinary_codex_running; then
    notify_degraded
    exit 0
  fi
  LAUNCH_DOMAIN="gui/$(/usr/bin/id -u)"
  if ! /bin/launchctl print "$LAUNCH_DOMAIN/$CODEX_LAUNCH_LABEL" >/dev/null 2>&1; then
    /bin/launchctl bootstrap "$LAUNCH_DOMAIN" "$CODEX_LAUNCH_AGENT" || exit $?
    exit 0
  fi
  /bin/launchctl kickstart -k "$LAUNCH_DOMAIN/$CODEX_LAUNCH_LABEL"
  exit $?
fi

RESIDENT_PIDS=$(resident_pids)
if [[ -n "$RESIDENT_PIDS" ]]; then
  if cdp_reachable && refresh_existing; then
    exit 0
  fi
  STALE_RESIDENT_PIDS="$RESIDENT_PIDS"
  if cdp_reachable; then
    log "resident injector failed open readiness; stopping pids=$(print -r -- "$STALE_RESIDENT_PIDS" | /usr/bin/tr '\\n' ',')"
  else
    log "stale resident injector without CDP; stopping pids=$(print -r -- "$STALE_RESIDENT_PIDS" | /usr/bin/tr '\\n' ',')"
  fi
  for stale_pid in \${=STALE_RESIDENT_PIDS}; do
    /bin/kill -TERM "$stale_pid" 2>/dev/null || true
  done
  for _ in {1..40}; do
    [[ -n "$(resident_pids)" ]] || break
    /bin/sleep 0.25
  done
  if [[ -n "$(resident_pids)" ]]; then
    log "stale resident injector did not stop"
    exit 1
  fi
fi

if [[ -d "$LOCK_DIR" ]]; then
  /bin/rmdir "$LOCK_DIR" 2>/dev/null || true
fi
if ! /bin/mkdir "$LOCK_DIR" 2>/dev/null; then
  if cdp_reachable; then
    refresh_existing
    exit $?
  fi
  exit 0
fi

cleanup_lock() {
  if [[ -n "\${RESIDENT_PID:-}" ]] && /bin/kill -0 "$RESIDENT_PID" 2>/dev/null; then
    /bin/kill -TERM "$RESIDENT_PID" 2>/dev/null || true
  fi
  /bin/rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup_lock EXIT INT TERM HUP

if cdp_reachable; then
  run_resident attach
  exit $?
fi

if ordinary_codex_running; then
  notify_degraded
  exit 0
fi

run_resident launch
`;
}

export function buildMacOSLauncherArtifacts(options = {}) {
  const paths = resolveMacOSPaths(options);
  const codexExecutable = resolveCodexExecutable(options);
  const servicePlist = renderPlist({
    Label: SERVICE_LABEL,
    ProgramArguments: [paths.nodeBinary, path.join(paths.repoRoot, "server", "index.mjs")],
    WorkingDirectory: paths.repoRoot,
    EnvironmentVariables: {
      CODEX_TASKBOARD_HOST: "127.0.0.1",
      CODEX_TASKBOARD_PORT: String(options.taskboardPort ?? DEFAULT_PORT),
      CODEX_TASKBOARD_DATA_DIR: path.join(paths.repoRoot, ".data"),
      CODEX_EXECUTABLE: codexExecutable,
      PATH: `${path.dirname(paths.nodeBinary)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    },
    RunAtLoad: true,
    KeepAlive: true,
    ThrottleInterval: 5,
    ProcessType: "Background",
    StandardOutPath: paths.serviceLogPath,
    StandardErrorPath: paths.serviceErrorLogPath,
  });
  const codexPlist = renderPlist({
    Label: CODEX_LABEL,
    ProgramArguments: [paths.appExecutablePath, "--login"],
    RunAtLoad: true,
    ThrottleInterval: 1,
    ProcessType: "Interactive",
    StandardOutPath: paths.codexLogPath,
    StandardErrorPath: paths.codexErrorLogPath,
  });
  const appInfoPlist = renderPlist({
    CFBundleDevelopmentRegion: "zh_CN",
    CFBundleDisplayName: APP_NAME,
    CFBundleExecutable: "CodexTaskboardLauncher",
    CFBundleIdentifier: APP_BUNDLE_ID,
    CFBundleInfoDictionaryVersion: "6.0",
    CFBundleName: APP_NAME,
    CFBundlePackageType: "APPL",
    CFBundleShortVersionString: "1.1",
    CFBundleVersion: "2",
    LSMultipleInstancesProhibited: true,
    LSUIElement: true,
    NSHighResolutionCapable: true,
  });
  return {
    ...paths,
    appInfoPlist,
    servicePlist,
    codexPlist,
    launcherScript: renderLauncherScript(paths, options),
  };
}

async function writeArtifact(filePath, content, mode = 0o644) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, { mode });
  await chmod(filePath, mode);
}

function launchctl(args) {
  return spawnSync("/bin/launchctl", args, { encoding: "utf8" });
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function launchctlError(result) {
  return (result.stderr || result.stdout || result.error?.message || "unknown error").trim();
}

function signAppBundle(appPath) {
  const result = spawnSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", appPath], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`codesign failed for ${appPath}: ${(result.stderr || result.stdout || "unknown error").trim()}`);
  }
}

export async function loadLaunchAgent(agentPath, label, uid = process.getuid?.(), {
  runLaunchctl = launchctl,
  waitFor = wait,
  removalPollIntervalMs = 100,
  removalTimeoutMs = 10_000,
  bootstrapAttempts = 3,
  bootstrapRetryDelayMs = 200,
} = {}) {
  if (!uid) throw new Error("Cannot load macOS LaunchAgent without a user id");
  const domain = `gui/${uid}`;
  const target = `${domain}/${label}`;
  const loaded = runLaunchctl(["print", target]);
  if (loaded.status === 0) {
    const stopped = runLaunchctl(["bootout", target]);
    if (stopped.status !== 0) {
      const stillLoaded = runLaunchctl(["print", target]);
      if (stillLoaded.status === 0) {
        throw new Error(`launchctl bootout failed for ${label}: ${launchctlError(stopped)}`);
      }
    }

    const removalChecks = Math.max(1, Math.ceil(removalTimeoutMs / removalPollIntervalMs));
    let removed = false;
    for (let check = 0; check <= removalChecks; check += 1) {
      if (runLaunchctl(["print", target]).status !== 0) {
        removed = true;
        break;
      }
      if (check < removalChecks) await waitFor(removalPollIntervalMs);
    }
    if (!removed) {
      throw new Error(`launchctl bootout timed out waiting for ${label} to disappear`);
    }
  }

  let lastFailure = null;
  let attemptsMade = 0;
  for (let attempt = 1; attempt <= bootstrapAttempts; attempt += 1) {
    attemptsMade = attempt;
    const result = runLaunchctl(["bootstrap", domain, agentPath]);
    if (result.status === 0) return;

    lastFailure = result;
    if (runLaunchctl(["print", target]).status === 0) return;
    if (result.status !== 5 || attempt === bootstrapAttempts) break;
    // launchd can briefly return EIO while releasing a just-removed job label.
    await waitFor(bootstrapRetryDelayMs);
  }

  throw new Error(
    `launchctl bootstrap failed for ${label} after ${attemptsMade} attempts: ${launchctlError(lastFailure)}`,
  );
}

export async function installMacOSLauncher({ load = false, ...options } = {}) {
  const artifacts = buildMacOSLauncherArtifacts(options);
  await writeArtifact(artifacts.appInfoPath, artifacts.appInfoPlist);
  await writeArtifact(artifacts.appExecutablePath, artifacts.launcherScript, 0o755);
  signAppBundle(artifacts.appPath);
  await writeArtifact(artifacts.serviceLaunchAgentPath, artifacts.servicePlist);
  await writeArtifact(artifacts.codexLaunchAgentPath, artifacts.codexPlist);
  if (load) {
    await loadLaunchAgent(artifacts.serviceLaunchAgentPath, SERVICE_LABEL);
    await loadLaunchAgent(artifacts.codexLaunchAgentPath, CODEX_LABEL);
  }
  return {
    appPath: artifacts.appPath,
    serviceLaunchAgentPath: artifacts.serviceLaunchAgentPath,
    codexLaunchAgentPath: artifacts.codexLaunchAgentPath,
    loaded: load,
  };
}

function parseArgs(argv) {
  const options = { load: false, repoRoot: projectRoot };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--install") continue;
    if (arg === "--load") options.load = true;
    else if (arg === "--repo-root") options.repoRoot = path.resolve(argv[++index]);
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (!process.argv.slice(2).includes("--install")) {
      throw new Error("Use --install to install the macOS Codex + Taskboard entry");
    }
    console.log(JSON.stringify(await installMacOSLauncher(options), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
