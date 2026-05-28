# Changelog

All notable changes to this project are documented here.
Format adapted from [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) — semantic versioning where the major number bumps on breaking surface changes (HTTP, MCP tools, env vars), minor on additive features, patch on fixes.

## [Unreleased]

### Added

- **MCP tool surface expanded 8 → 26.** New tools:
  - Retrieval: `vaultnexus_neighbors`
  - Vault read + analytics: `vaultnexus_list`, `vaultnexus_read_page`, `vaultnexus_outline`, `vaultnexus_stats`, `vaultnexus_tags`, `vaultnexus_recent`, `vaultnexus_orphans`, `vaultnexus_link_graph`
  - Vault write: `vaultnexus_create_page`, `vaultnexus_create_folder`, `vaultnexus_append_to_page`, `vaultnexus_insert_after_heading`, `vaultnexus_replace_in_page`, `vaultnexus_delete_page`, `vaultnexus_delete_folder`, `vaultnexus_move`, `vaultnexus_copy_page`
- **Live re-indexing via `fs.watch`** — external writes (Obsidian saving a note) trigger debounced reindex (250ms). Tool-side writes synchronously reindex before returning.
- **Safe FS layer** — every write/delete tool routes through `safeJoin()` which rejects `..`/absolute paths so the surface stays bounded to the vault root.
- **Soft-delete** — deletes move into `<vault>/.trash/<timestamp>/` instead of unlinking.

### Fixed

- Race where a tool-side write + the subsequent `fs.watch` event both triggered `reindexNote()` against the same path → could shift array indices mid-traversal in a concurrent `vaultnexus_reason` call. Fixed via a per-path self-write suppression window.

## [0.1.0] — 2026-05-27

First public release.

### Added

- **Daemon** — long-running Node 22 process, binds `127.0.0.1:38473`, indexes a Markdown vault into an in-memory hybrid index (int8 SIMD coarse + exact f32 rescore + FTS5 BM25, fused via Reciprocal Rank Fusion).
- **Cross-community bridges** — wikilink graph → Louvain communities → surface semantically aligned chunks across different link clusters that were never linked.
- **8 MCP tools** — `vaultnexus_ping`, `vaultnexus_search`, `vaultnexus_bridges`, `vaultnexus_trace`, `vaultnexus_reason`, `vaultnexus_history`, `vaultnexus_recall_history`, `vaultnexus_forecasts`. All payloads include verbatim byte-range citations.
- **HTTP surface** — `GET /health`, `GET /status` (returns version, indexed chunk count, embedder id, chat model id, tool list), `POST /search`, `POST /bridges`, `POST /configure-chat`. CORS open to any origin for the Obsidian Electron renderer.
- **Obsidian plugin** — sidebar search panel + settings tab. 4-cell status panel (Connection / Index / Embedder / Chat model) with broadcast-cue status lamps. Live chat-model configuration pushed to the daemon via `POST /configure-chat` — no daemon restart. Numbered editorial sections (01 Connection / 02 Chat model / 03 Search / 04 Display / 05 Daemon environment). Auto-applies stored chat config on plugin load (10s retry × 5min window).
- **Stdio bridge** — `dist/bridge/main.js` proxies stdio ↔ Unix socket for MCP clients (Claude Code, Claude Desktop).
- **Snapshot persistence** — SQLite-backed snapshot at `~/.vaultnexus/index-snapshot.db`. Restart restores unchanged notes in milliseconds.
- **Content-hash embedding cache** — SQLite at `~/.vaultnexus/embeddings.db`. Unchanged chunks skip the API call.
- **Provider-agnostic embedder** — any OpenAI-compatible `/embeddings` endpoint. Bundled `FakeEmbedder` for offline smoke tests.
- **Hot-swap chat model** — `VAULTNEXUS_CHAT_PROVIDER` env or live `POST /configure-chat`. Providers: `fake` · `anthropic` · `openai` · `openai-compatible` (Ollama, LM Studio, vLLM).
- **GitHub Actions CI** — ubuntu + macos matrix on Node 22. Typecheck, build, vitest (449+ tests), plugin bundle build.
- **Docs** — `README.md`, `docs/GETTING_STARTED.md` (10-min walkthrough), `docs/ARCHITECTURE.md` (5-min system tour), `CONTRIBUTING.md`, `LICENSE` (MIT).

### Fixed

- **Chunker** — when a doc starts at a heading depth > 1 (e.g. `####` with no `h1`/`h2`/`h3` above), ancestor slots stayed undefined and JSON-serialized to `null`. Now fills with empty strings.
- **Vault index defense** — `headingPath` normalized on both add + restore. Legacy snapshots written before the chunker fix are coerced cleanly.
- **CORS** — daemon's Hono app now serves `Access-Control-Allow-*` headers on the loopback surface so the Obsidian Electron renderer (`app://obsidian.md`) can fetch without preflight rejection.

### Validated

- 449 vitest cases + 4 integration cases pass (Node 22).
- Eval harness on seeded paraphrase corpus, `voyage-code-3`: queries=26 recall@1=0.923 recall@3=1.000 nDCG@10=0.967 MRR=0.955.

[unreleased]: https://github.com/hunchom/vaultnexus/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/hunchom/vaultnexus/releases/tag/v0.1.0
