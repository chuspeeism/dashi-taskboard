import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  aggregateBatchExitCodes,
  discoverLoopbackTestFiles,
  partitionLoopbackTestFiles,
} from "./run-loopback-safe-lib.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const batches = partitionLoopbackTestFiles(await discoverLoopbackTestFiles(projectRoot));
if (batches.serial.length !== 1) {
  throw new Error(`Expected one full-height serial fixture, found ${batches.serial.length}`);
}

function runBatch(name, files, serial = false) {
  console.log(`[loopback-safe] ${name}: ${files.length} files`);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      "--test",
      ...(serial ? ["--test-concurrency=1"] : []),
      ...files,
    ], {
      cwd: projectRoot,
      env: { ...process.env, CODEX_TASKBOARD_LOOPBACK_ONLY: "1" },
      stdio: "inherit",
    });
    let settled = false;
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      console.error(`[loopback-safe] ${name} failed to start`, error);
      resolve(1);
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      resolve(code ?? 1);
    });
  });
}

const mainCode = await runBatch("main", batches.main);
const serialCode = await runBatch("full-height serial", batches.serial, true);
console.log(`[loopback-safe] complete: main=${mainCode} serial=${serialCode}`);
process.exitCode = aggregateBatchExitCodes([mainCode, serialCode]);
