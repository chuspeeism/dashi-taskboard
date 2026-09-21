# Repository Guidelines

## Project Structure & Module Organization

`web/src/` contains the React 19 and TypeScript interface. `server/` provides the Node.js ESM API and local persistence; reusable contracts live in `shared/`. CLI behavior belongs in `cli/`, and Codex integration code is under `inject/` and `scripts/`. Cloudflare Worker code is in `cloud/`; the Tauri shell is in `src-tauri/`. Node tests live in `test/`, while component tests may be colocated under `web/src/`. Put documentation in `docs/`.

## Build, Test, and Development Commands

- `npm ci`: install the locked dependency set (Node.js 22.5 or newer).
- `npm run dev`: start the local server and Vite frontend together.
- `npm run dev:server` / `npm run dev:web`: run one development layer in isolation.
- `npm run build:web`: create the production web bundle.
- `npm run typecheck`: check `web/` with TypeScript without emitting files.
- `npm test`: run Node tests and the Vitest component suite.
- `npm run check`: run type checking, the web build, and all tests; use this before opening a PR.
- `npm run app:dev`: prepare and launch the Tauri desktop app.

## Coding Style & Naming Conventions

Match existing ESM code: two-space indentation, double quotes, semicolons, and trailing commas in multiline structures. Use `PascalCase` for React components and types, `camelCase` for functions and variables, and descriptive kebab-case names for Node modules. Keep platform logic in its platform module. There is no separate lint script; TypeScript and the production build are the primary static checks.

## Testing Guidelines

Use `node:test` with strict assertions for server, CLI, cloud, and injector behavior; name files `test/<feature>.test.mjs`. Use Vitest and Testing Library for React tests named `*.test.tsx`. Add focused coverage near the affected layer and isolate state with temporary fixtures. Run `npm run test:components` for a quick UI-only check.

## Commit & Pull Request Guidelines

Recent history favors concise imperative subjects with `fix:`, `feat:`, or `chore:` prefixes (for example, `fix: keep card metadata inline`). Keep commits scoped. PRs should explain the result, link the issue, list verification commands, and include screenshots for meaningful UI changes. Do not commit generated `dist/`, local `.data/`, credentials, or runtime descriptors.

## Agent-Specific Instructions

For Taskboard work, use the repository's active `taskctl` runtime, work on a feature branch/worktree rather than `main`, verify the direct user path, and do not mark an issue complete without explicit user acceptance.
