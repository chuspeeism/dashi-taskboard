import { readdir } from "node:fs/promises";
import path from "node:path";

export const SPECIAL_SERIAL_FIXTURE = "test/inject-fullheight-regression.test.mjs";

export function partitionLoopbackTestFiles(files) {
  const normalized = [...files].map((file) => file.split(path.sep).join("/")).sort();
  return {
    main: normalized.filter((file) => file !== SPECIAL_SERIAL_FIXTURE),
    serial: normalized.filter((file) => file === SPECIAL_SERIAL_FIXTURE),
  };
}

export function aggregateBatchExitCodes(codes) {
  return codes.find((code) => code !== 0) ?? 0;
}

export async function discoverLoopbackTestFiles(projectRoot) {
  const testRoot = path.join(projectRoot, "test");
  const files = [];

  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile() && /\.(?:cjs|js|mjs)$/.test(entry.name)) {
        files.push(path.relative(projectRoot, absolute));
      }
    }
  }

  await visit(testRoot);
  return files.sort();
}
