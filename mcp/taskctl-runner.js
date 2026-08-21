// Utility to spawn taskctl process and return parsed JSON output

const { spawn } = require("node:child_process");
const path = require("node:path");

function fileURLToPath(url) {
  return require("url").pathToFileURL(url).href;
}

const taskctlPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli/taskctl.mjs");

export async function spawnTaskctl(args, { threadId }) {
  const env = { ...process.env };
  const effectiveThreadId = threadId || env.TASKBOARD_THREAD_ID || env.CODEX_THREAD_ID;
  if (effectiveThreadId) env.TASKBOARD_THREAD_ID = effectiveThreadId;

  return new Promise((resolve, reject) => {
    const child = spawn("node", [taskctlPath, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("error", (error) => {
      reject(new Error(`Failed to spawn taskctl: ${error.message}`));
    });

    child.on("close", (code) => {
      if (code !== 0) {
        try {
          const errorJson = JSON.parse(stderr);
          reject(new Error(errorJson.error.message));
        } catch {
          reject(new Error(`taskctl exited with code ${code}: ${stderr}`));
        }
        return;
      }

      try {
        const result = JSON.parse(stdout);
        resolve(result);
      } catch {
        reject(new Error(`Invalid JSON from taskctl: ${stdout}`));
      }
    });
  });
}