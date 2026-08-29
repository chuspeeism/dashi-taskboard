import { accessSync, constants } from "node:fs";
import os from "node:os";
import path from "node:path";

function executableFile(candidate) {
  try {
    accessSync(candidate, constants.X_OK);
    return candidate;
  } catch {
    return null;
  }
}

function executableOnPath(env, platform) {
  for (const directory of (env.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    if (platform === "win32") {
      const nativeExecutable = executableFile(path.join(directory, "codex.exe"));
      if (nativeExecutable) return nativeExecutable;

      const npmEntry = executableFile(path.join(
        directory,
        "node_modules",
        "@openai",
        "codex",
        "bin",
        "codex.js",
      ));
      if (npmEntry) return npmEntry;
      continue;
    }

    const executable = executableFile(path.join(directory, "codex"));
    if (executable) return executable;
  }
  return null;
}

export function codexExecutableInApp(appPath, platform = process.platform) {
  if (platform === "win32") {
    return path.win32.join(path.win32.dirname(appPath), "resources", "codex.exe");
  }
  if (platform === "linux") return "/usr/lib/chatgpt/resources/codex";
  return path.join(appPath, "Contents", "Resources", "codex");
}

export function resolveCodexExecutable({
  explicit = process.env.CODEX_EXECUTABLE,
  appPath,
  env = process.env,
  platform = process.platform,
  homeDirectory = os.homedir(),
} = {}) {
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();

  if (appPath) {
    const bundled = executableFile(codexExecutableInApp(appPath, platform));
    if (bundled) return bundled;
  }

  const installedCli = executableOnPath(env, platform);
  if (installedCli) return installedCli;

  if (platform === "darwin") {
    for (const applicationDirectory of ["/Applications", path.join(homeDirectory, "Applications")]) {
      for (const applicationName of ["ChatGPT.app", "Codex.app"]) {
        const bundled = executableFile(codexExecutableInApp(
          path.join(applicationDirectory, applicationName),
          platform,
        ));
        if (bundled) return bundled;
      }
    }
  }

  return "codex";
}
