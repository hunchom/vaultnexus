# VaultNexus — Obsidian Plugin

Thin Obsidian shell that talks to the VaultNexus daemon over loopback HTTP. Gives you semantic search across your vault from the sidebar.

## What it does

- One command: **VaultNexus: Search vault via VaultNexus** (also a ribbon icon).
- Opens a right-sidebar view with a search input.
- On Enter, POSTs the query to `http://127.0.0.1:38473/search`, renders the cited hits, click to jump to the note.

The daemon does the work — chunking, embedding, hybrid search, the whole pipeline. The plugin is a UI shell only.

## Install (manual, dev workflow)

1. Start the VaultNexus daemon pointed at your vault:

   ```sh
   VAULTNEXUS_VAULT=/path/to/your/vault pnpm dev:daemon
   ```

   Wait for `VAULTNEXUS_READY` on stderr. The daemon listens on loopback port `38473` by default (override via `VAULTNEXUS_HTTP_PORT`).

2. Build the plugin bundle:

   ```sh
   cd obsidian-plugin
   pnpm install --ignore-workspace
   pnpm build
   ```

   This produces `obsidian-plugin/main.js`.

3. Copy the plugin into your vault:

   ```sh
   VAULT=/path/to/your/vault
   mkdir -p "$VAULT/.obsidian/plugins/vaultnexus"
   cp manifest.json main.js "$VAULT/.obsidian/plugins/vaultnexus/"
   ```

4. In Obsidian: **Settings → Community plugins → Installed plugins → enable VaultNexus**. (You may need to toggle off Restricted Mode first.)

## First search

1. Open the command palette (`Cmd/Ctrl+P`).
2. Run **VaultNexus: Search vault via VaultNexus** — a sidebar pane opens on the right.
3. Type a query (e.g. `the quick brown fox`) and press `Enter`.
4. Results render as clickable links — `notePath`, heading breadcrumb, preview snippet, similarity score.
5. Click any result to jump to the note in your main editor.

If the pane shows `Daemon error: HTTP 503` or `Fetch failed`, the daemon isn't running or wasn't given a `VAULTNEXUS_VAULT`. Restart it.

## How it's wired

- Plugin → `POST http://127.0.0.1:38473/search { query, k }` → daemon's Hono loopback server (`src/daemon/http.ts`).
- Daemon → `VaultIndex.query()` → vector + FTS hybrid, RRF fusion → cited `SearchHit[]`.
- Plugin renders the JSON, click handler calls `app.workspace.openLinkText(notePath, '')`.

No auth (loopback only), no telemetry, no remote calls — everything stays on `127.0.0.1`.

## Configuration

- `VAULTNEXUS_HTTP_PORT` — daemon port (default `38473`). The plugin reads `process.env.VAULTNEXUS_HTTP_PORT` at load time; in normal Obsidian use this env var won't be set and the default applies.

## Limitations (Plan 29 scaffold)

- Search only. No bridges / reasoning UI yet — the daemon's `/bridges` endpoint exists but the plugin doesn't surface it.
- Desktop only — loopback HTTP is unavailable on Obsidian mobile.
- No settings tab — port is wired at plugin load.
