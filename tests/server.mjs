// Local E2E harness: boots an isolated Taskboard server on 127.0.0.1.
// - Data lives in a throwaway temp directory (never the developer's `.data`).
// - The Codex executable is pointed at a nonexistent path and external
//   fetches are disabled, so a test can never reach Codex or the network.
// - Static web UI is served from dist/web (run `npm run build:web` first).
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTaskboardServer } from '../server/app.mjs';

const port = Number(process.argv[2] ?? '4310');
const directory = await mkdtemp(path.join(os.tmpdir(), 'dashi-e2e-'));
const app = createTaskboardServer({
  dataDirectory: directory,
  codexStatePath: path.join(directory, 'codex-state.json'),
  codexProcessesPath: path.join(directory, 'codex-processes.json'),
  codexExecutable: path.join(directory, 'disabled-codex'),
  processEnv: { PATH: '', HOME: directory, CODEX_HOME: directory },
  remoteFetch: async () => {
    throw new Error('External requests disabled in local E2E');
  },
});
await app.listen({ host: '127.0.0.1', port });

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await app.close();
  await rm(directory, { recursive: true, force: true });
  process.exit(0);
}
process.on('SIGINT', close);
process.on('SIGTERM', close);
