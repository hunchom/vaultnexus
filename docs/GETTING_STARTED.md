# Getting started

A guided 10-minute walkthrough: build VaultNexus, start the daemon against your vault, and wire up the Obsidian plugin + Claude Code + Claude Desktop.

> **Prereqs** — macOS or Linux. Node 22+. An Obsidian vault. Optional: an OpenAI-compatible embeddings endpoint + key (Voyage, OpenAI, Ollama, etc.). Without one, you get the offline `FakeEmbedder` which is fine for smoke tests but produces low-quality hits.

---

## 1. Clone + build

```bash
git clone https://github.com/<your-fork>/vaultnexus.git
cd vaultnexus
pnpm install
pnpm run build
```

The build produces:

```
dist/
  daemon/main.js     ← the long-running indexer + HTTP server
  bridge/main.js     ← stdio ↔ unix-socket bridge (for MCP clients)
obsidian-plugin/
  main.js            ← already built; reload if you change source
```

---

## 2. First start (offline / fake embedder)

The simplest way to verify everything compiled and the daemon is reachable:

```bash
VAULTNEXUS_VAULT="$HOME/Documents/MyVault" \
  /opt/homebrew/opt/node@22/bin/node dist/daemon/main.js
```

You should see:

```
vaultnexus: chat model = fake
vaultnexus: indexed 124 notes from /Users/you/Documents/MyVault (...)
VAULTNEXUS_READY
```

In another terminal:

```bash
curl http://127.0.0.1:38473/status
```

```json
{
  "status": "ok",
  "version": "0.0.1",
  "indexed": 1287,
  "chatModel": "fake",
  "tools": ["vaultnexus_ping", "vaultnexus_search", ...]
}
```

The `FakeEmbedder` hashes chunks into deterministic vectors. Search will run, but relevance will be bad. Wire up a real embedder next.

---

## 3. Hook up a real embedder

Pick any **OpenAI-compatible** `/embeddings` endpoint. Three common choices:

#### Voyage AI (cloud, high recall)

```bash
export VAULTNEXUS_EMBED_URL="https://api.voyageai.com/v1"
export VAULTNEXUS_EMBED_KEY="pa-..."
export VAULTNEXUS_EMBED_MODEL="voyage-3-large"
```

#### OpenAI

```bash
export VAULTNEXUS_EMBED_URL="https://api.openai.com/v1"
export VAULTNEXUS_EMBED_KEY="sk-..."
export VAULTNEXUS_EMBED_MODEL="text-embedding-3-small"
```

#### Ollama (local, offline)

```bash
# ollama pull nomic-embed-text
export VAULTNEXUS_EMBED_URL="http://localhost:11434/v1"
export VAULTNEXUS_EMBED_KEY="ollama"      # any non-empty string
export VAULTNEXUS_EMBED_MODEL="nomic-embed-text"
```

Then restart the daemon. Watch `~/.vaultnexus/embeddings.db` grow — that's the content-hash cache. Restarts after the first run are millisecond-fast.

> **Tip** — when you switch embedders, vector dimensions probably change. Wipe the snapshot before restarting: `rm -rf ~/.vaultnexus/index-snapshot.db*`. The cache stays, but the snapshot rebuilds with the new model's vectors.

---

## 4. Run the daemon as a launchd / systemd service

The daemon is a normal Node process. Here's a minimal `launchd` plist that keeps it alive across reboots and logins:

```xml
<!-- ~/Library/LaunchAgents/com.vaultnexus.daemon.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>com.vaultnexus.daemon</string>
    <key>ProgramArguments</key>
    <array>
      <string>/opt/homebrew/opt/node@22/bin/node</string>
      <string>/abs/path/to/vaultnexus/dist/daemon/main.js</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
      <key>VAULTNEXUS_VAULT</key><string>/Users/you/Documents/MyVault</string>
      <key>VAULTNEXUS_EMBED_URL</key><string>https://api.voyageai.com/v1</string>
      <key>VAULTNEXUS_EMBED_KEY</key><string>pa-...</string>
      <key>VAULTNEXUS_EMBED_MODEL</key><string>voyage-3-large</string>
    </dict>
    <key>KeepAlive</key><true/>
    <key>RunAtLoad</key><true/>
    <key>StandardOutPath</key><string>/tmp/vaultnexus.log</string>
    <key>StandardErrorPath</key><string>/tmp/vaultnexus.log</string>
  </dict>
</plist>
```

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.vaultnexus.daemon.plist
launchctl print gui/$(id -u)/com.vaultnexus.daemon | grep state
```

---

## 5. Obsidian plugin

```bash
VAULT="$HOME/Documents/MyVault"
mkdir -p "$VAULT/.obsidian/plugins/vaultnexus"
cp obsidian-plugin/main.js \
   obsidian-plugin/manifest.json \
   "$VAULT/.obsidian/plugins/vaultnexus/"
```

In Obsidian:

1. **Settings → Community plugins** → flip **Restricted mode** off if it isn't already.
2. Hit refresh on the **Installed plugins** list.
3. Toggle **VaultNexus** on.
4. Click the gear icon next to **VaultNexus** to open the settings panel.

What you should see:

- **Hero** — `VAULTNEXUS · v0.0.1` and a 3-cell status panel showing `Connection LIVE`, `Index N chunks`, `Chat model FAKE`.
- **MCP tools** row directly below, listing the 8 tools the daemon exposes.
- **01 Connection** — host + port + a `PROBE` button.
- **02 Chat model** — provider dropdown, key/model fields, `APPLY TO DAEMON` button (pushes config live, no restart).
- **03 Search · 04 Display · 05 Daemon environment** — tunables.

Open the sidebar with the **🔍 ribbon** or `Cmd+P → "Search vault via VaultNexus"`. Type a query and hit Enter. Hits are clickable and open at the matching heading.

---

## 6. Claude Code

```bash
claude mcp add vaultnexus \
  /opt/homebrew/opt/node@22/bin/node \
  /abs/path/to/vaultnexus/dist/bridge/main.js
```

Restart Claude Code. In a fresh session:

```
> What tools does the vaultnexus server expose?
```

Claude Code should list the 8 `vaultnexus_*` tools. Try:

```
> Use vaultnexus_search to find notes about journald
> Use vaultnexus_bridges to surface cross-cluster connections in my vault
```

---

## 7. Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (create if missing):

```json
{
  "mcpServers": {
    "vaultnexus": {
      "command": "/opt/homebrew/opt/node@22/bin/node",
      "args": ["/abs/path/to/vaultnexus/dist/bridge/main.js"]
    }
  }
}
```

Quit and reopen Claude Desktop. The 🔌 icon in the prompt area should show `vaultnexus` connected.

---

## Troubleshooting

#### `Cannot reach daemon at http://127.0.0.1:38473`

- Daemon not running? `ps aux | grep daemon/main.js`
- Port collision? `lsof -i :38473`
- Stale lock from a previous unclean exit?
  ```bash
  rm -rf "$TMPDIR/vaultnexus.lock"* "$TMPDIR/vaultnexus.sock"
  ```

#### `another daemon is already running`

The daemon uses a `proper-lockfile` on `$TMPDIR/vaultnexus.lock`. Clean stale lock with the command above, then restart.

#### `score: null` on all hits

Vector dimensions changed under you (you switched embedders without wiping the snapshot). Fix:

```bash
rm -rf ~/.vaultnexus/index-snapshot.db*
# restart the daemon → it re-embeds (uses the embedding cache for unchanged chunks)
```

#### Chat tools return "fake" output

You haven't wired a chat model. Either:

- Set `VAULTNEXUS_CHAT_PROVIDER` + `VAULTNEXUS_CHAT_KEY` in the daemon env and restart, **or**
- Open the Obsidian plugin settings, fill in the **02 Chat model** section, hit `APPLY TO DAEMON`. The daemon hot-swaps the chat model — no restart.

#### Re-indexing is slow

Per-chunk embedding API calls dominate first-run cost. Subsequent runs reuse `~/.vaultnexus/embeddings.db` for unchanged chunks. Wipe it only if you want a full re-embed.

#### Obsidian plugin didn't pick up my code change

Obsidian caches `main.js` until you toggle the plugin off and on. **Settings → Community plugins** → toggle VaultNexus off, then on.

---

## What next

- Read the [architecture diagram](../README.md#architecture) in the main README to understand how the daemon, bridge, plugin, and MCP clients fit together.
- Skim `docs/specs/` for the per-plan design + implementation notes — the build history is in the open.
- Tweak `VAULTNEXUS_HTTP_PORT` if `:38473` collides with something on your box.
- Open the **Daemon environment** disclosure in the plugin settings for the canonical env reference.

Have fun.
