# Manus MCP connector

Taskboard's Cloudflare Worker can expose a remote MCP endpoint for Manus at `https://YOUR-WORKER-ORIGIN/mcp`. This is for a Taskboard instance already deployed to Cloudflare. Do not expose a laptop-only Taskboard server or its local port to the public internet; Manus needs a reachable HTTPS endpoint.

The MCP endpoint uses a dedicated `TASKBOARD_MANUS_MCP_TOKEN` Bearer credential. It does not accept the Taskboard shared password as its MCP token, and the token does not replace `TASKBOARD_SHARED_SECRET` used by the Taskboard web app and HTTP API. MCP mutations are attributed to **Manus Agent** and trigger the board's normal realtime refresh.

## Enable the endpoint

From an authenticated checkout that owns the Cloudflare Worker, generate a high-entropy token and save it as a Worker secret:

```bash
openssl rand -hex 32
npx wrangler secret put TASKBOARD_MANUS_MCP_TOKEN
```

Paste the generated value only into Wrangler's private prompt and into Manus's credential field. Do not add it to `.dev.vars`, `wrangler.jsonc`, source control, Taskboard issues, or logs. Deploy the Worker code using the repository's normal release process (`npm run cloud:deploy`). This command publishes a Worker; do not run it until you intend to update the deployed service.

In Manus, open **Settings → Integrations → Custom MCP Servers → Add Server**. Set the server URL to `https://YOUR-WORKER-ORIGIN/mcp`, select Bearer-token authentication, and paste the same token. Test the connection and enable the connector for the desired Manus task.

If a request includes an `Origin` header, the Worker accepts its own HTTPS origin or an exact origin listed in the optional `TASKBOARD_MANUS_MCP_ALLOWED_ORIGINS` Worker variable. Leave this unset unless Manus sends an `Origin` header that needs to be explicitly allowed.

## Open the visual panel from Manus

The visual board is available at `https://YOUR-WORKER-ORIGIN/`. In a Manus task, call `taskboard_get_dashboard_url` and open the returned URL as a separate web page; the panel uses the same Taskboard Basic Authentication username and shared password as browser-only access. Changes made by Manus MCP are persisted in the same board and the open panel refreshes through the existing realtime channel. The link is an independent HTTPS page, not an embedded view inside the Manus chat.

## Available tools

- `taskboard_get_dashboard_url` returns the HTTPS root URL for opening the board in a separate web page.
- `taskboard_list_projects` lists projects and their exact IDs.
- `taskboard_list_issues` lists issues, optionally filtered by project ID, status, or archive state.
- `taskboard_get_issue` reads an issue by its exact ID or identifier.
- `taskboard_list_comments` reads issue comments and returns a cursor for later incremental reads.
- `taskboard_move_issue` changes an issue status. Read the issue first and pass its current `version`.
- `taskboard_add_comment` adds a comment to an issue.

MCP access uses the same Cloudflare Taskboard data and permissions as the shared cloud board. Anyone holding the MCP token can read and update its projects and issues, so share it only with trusted users. Rotate it by running `npx wrangler secret put TASKBOARD_MANUS_MCP_TOKEN` again. Disable Manus access with `npx wrangler secret delete TASKBOARD_MANUS_MCP_TOKEN`.

Manus's custom MCP connector expects a remotely reachable HTTPS server. It lets Manus discover and call Taskboard tools from an agent task; the panel link opens the existing Taskboard Web UI separately.
