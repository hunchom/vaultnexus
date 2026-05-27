# Roadmap

What might land next. None of this is committed; treat the list as a public planning artifact, not a promise.

## Near-term

- **Per-block drift detection** — long-lived notes drift in meaning. Plan 30: detect when a note's vector centroid shifts beyond a threshold relative to its prior snapshot and surface "this note has substantively changed" cues to the plugin.
- **Background incremental re-indexing** — Plan 27. Today the daemon re-indexes on startup; FSWatch the vault and re-embed on change, debounced.
- **Memoized retrieval pipeline** — Plan 24. Same query in flight twice within N seconds → second call returns the first call's promise.
- **Reindex button in plugin** — wire a POST `/reindex` endpoint and a button in §01 Connection. Today users restart the daemon.
- **Plugin chat-key keychain** — store `chatKey` in macOS Keychain / Linux secret-service instead of plugin data.json.

## Mid-term

- **Multi-vault support** — one daemon hosting N indexes, plugin picks which to query. Useful for users with split personal/work vaults.
- **Browser extension** — query the vault from any web context, results render in a popover. Same `/search` surface, no plugin needed.
- **Drift dashboard** — visualize community membership changes + note-vector drift over git history.
- **Streaming reason responses** — `POST /reason/stream` SSE for token-by-token output in the plugin sidebar.

## Speculative

- **Cross-vault bridges** — when given two indexed vaults, surface bridges across them (e.g. "your private journal mentions X; your shared team vault mentions X").
- **Voice query** — Whisper transcription → `/search` → result spoken back. Probably not actually useful.
- **VS Code extension** — same MCP surface, native VS Code sidebar.
- **Local LLM autopilot** — for offline reason / narrate, default chat model auto-selected from the first running Ollama install on the box.

## Won't do

- **A cloud-hosted version** — VaultNexus is local-first by design. The threat model assumes the user's vault never leaves the machine.
- **Encrypted indexes at rest** — out of scope; the snapshot file inherits the user's filesystem permissions. If you need at-rest encryption, use FileVault / LUKS.
- **A web UI** — Obsidian + the MCP clients are the supported surfaces.

## How to influence the list

Open an issue with the [feature template](https://github.com/hunchom/vaultnexus/issues/new?template=feature.yml). Be specific about your use case. The shortest path from idea → merged is a PR with tests.
