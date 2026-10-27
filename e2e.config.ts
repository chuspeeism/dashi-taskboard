import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';

// Model-free config: every step is deterministic locators + expect, no agents.
// The runner starts tests/server.mjs (isolated Taskboard server, temp data
// dir) and waits for /health. `npm run build:web` must have produced dist/web.
export default {
  projectId: 'dashi-taskboard',
  workers: 1,
  retries: 0,
  timeout: 120000,
  cache: 'off',
  targets: [{
    engine: web(),
    app: {
      url: 'http://127.0.0.1:4310',
      readyUrl: 'http://127.0.0.1:4310/health',
      command: {
        executable: 'node',
        args: ['tests/server.mjs', '4310'],
        log: '.e2e/logs/app.log',
      },
    },
  }],
} satisfies E2EConfig;
