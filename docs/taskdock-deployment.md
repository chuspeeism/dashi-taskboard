# Deploy TaskDock

TaskDock runs as one Node service with a SQLite database and attachment files. The Docker image builds the Web board and starts `server/taskdock-server.mjs`. Mount `/data` persistently; it holds `taskboard.sqlite` and `attachments/`.

Existing `/api/agentboard/*` session routes and `agentboard_*` SQLite tables are stable internal identifiers. The deployed service, configuration, data directory, and product name use TaskDock.

## Start a new service

Create a `.env` next to `compose.yaml` with unique secrets:

```dotenv
TASKDOCK_USER_KEY=replace-with-a-long-random-admin-key
TASKDOCK_SESSION_SECRET=replace-with-a-long-random-session-secret
TASKDOCK_PORT=47823
```

Then run `docker compose up --build -d` and open `http://localhost:47823`. Compose binds the service to the host loopback address by default; set `TASKDOCK_BIND_HOST` only if a separate reverse proxy must connect over the host network. Put an HTTPS reverse proxy in front of the service when exposing it outside the host, so Agent keys and Web login credentials travel over TLS. Keep `.env` and the `taskdock-data/` directory private.

The container runs as UID 1000. On a Linux host, create `taskdock-data/` and make it writable by UID 1000 before starting Compose (`mkdir -p taskdock-data && sudo chown 1000:1000 taskdock-data`). An imported directory needs the same ownership. Docker Desktop typically handles host folder permissions through its file sharing layer.

TaskDock has one Web login. Use `TASKDOCK_USER_KEY` as the login Key. Every Agent Key can call all management and task REST APIs, including management of all projects, Agent identities, and Keys, with `Authorization: Bearer <key>`. `POST /api/agents` with `{ "id", "name" }` creates an Agent and returns its plaintext Key once. `POST /api/agents/:id/keys` resets that Agent's Key and revokes its previous Key. `DELETE /api/agents/:id/keys/:keyId` revokes a Key. `DELETE /api/agents/:id` removes the Agent from management, deletes its Keys, and releases its claimed tasks while retaining historical activity and artifacts. Project operations include `POST /api/projects`, `POST /api/projects/:id/archive`, `POST /api/projects/:id/restore`, and `DELETE /api/projects/:id` for empty projects. Agent task routes include `POST /api/tasks`, `POST /api/tasks/:id/claim`, `/release`, `/comments`, and `/artifacts`. Upload a file with a raw request body to `POST /api/tasks/:id/attachments` and set `X-Taskboard-Filename`. Claim conflicts and archived-project rules still apply to both Key types. The remote `/mcp` endpoint exposes the task workflow tools; use REST for management operations.

The remote MCP context path is `list_projects` → `get_project_readme` → `list_tasks` → `get_task_context`. The last call returns the complete task, project instructions, comments, activity, artifacts and attachment metadata using the same authenticated data queries as REST. Read attachment bytes through `/api/attachments/<id>/content` or `/download` with the same Bearer header. Existing task claim and handoff tools remain available.

In Web **管理设置**, expand **Agent 接入说明** and use **复制给 Agent** to get an installation prompt. It links to the public `GET /skills/taskdock-collaboration/SKILL.md` file and contains the REST and MCP URLs, but never includes an API Key. Configure each Agent's Key in that Agent's own environment or credential store.

## Deploy the existing homelab service

Use this entry point for subsequent production deployments:

```sh
node scripts/deploy-taskdock.mjs --ref HEAD
```

Run it from a clean, committed checkout containing the currently deployed revision. It uses the configured SSH host `homelab`, the existing Compose files and private `.env` in `/opt/data/appdata/taskdock/app`, and checks `https://taskdock.thisaray.com/health`. It does not read or print credentials.

The script archives the specified commit, uploads it to a new release directory, builds a revision-labelled image, stops only the TaskDock service to back up its database and attachments, switches its Compose image, and checks health and the exact deployed revision. Other services remain running. Failed cutovers restore the previous Compose image; database backups and old images are retained for manual recovery.

With unchanged dependency declarations and lockfile it reuses the running Node/dependency image and rebuilds Web only when Web, shared or package inputs changed. Use `--fresh-build` when dependencies change to build the repository Dockerfile. This requires access to the image and npm registries. Deployment rejects a revision that does not contain the running revision, so previously deployed changes are retained. It does not merge Git branches, change task statuses, or create a tagged desktop release.

Backups are stored in `/opt/data/appdata/taskdock/backups/`; each release keeps `deployment.json` with the revision, image and backup path. To roll back an otherwise healthy deployment, restore the recorded backup's `compose.homelab.yaml` into `app/` and run the same Compose `up -d --no-build --no-deps taskdock` command. Restore data separately only when needed, with the service stopped.

## Import a local Taskboard

Stop the old Taskboard before final cutover so no new writes occur after the snapshot. Run this command **before** the first `docker compose up`:

```sh
node scripts/import-local-data.mjs /path/to/old/.data ./taskdock-data
```

The source directory must contain `taskboard.sqlite`; the import also copies `attachments/` when present. The target directory must not exist. The command uses SQLite's `VACUUM INTO` to include committed WAL data in one consistent database snapshot, then copies files and publishes the new directory. TaskDock upgrades the database schema on first startup. Historical tasks, comments, and attachments remain visible; old assignees are historical display data and do not create a new Agent claim.

On Windows PowerShell, quote paths containing spaces:

```powershell
node scripts/import-local-data.mjs 'D:\old-taskboard\.data' '.\taskdock-data'
```

## Persistence check

Create a project and task, attach a file, and submit an artifact. Restart with `docker compose restart taskdock`, then read the project and task from the API and check the Web board. The project, Agent keys, task history, artifact, and attachment should remain available because `/data` is persisted.
