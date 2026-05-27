# Architecture

A 5-minute tour of how VaultNexus is put together, for people who want to understand the system before they extend it.

## One daemon, three surfaces

VaultNexus is one long-running Node 22 process that owns the index and exposes it three ways:

```
                                ┌────────────────────────────────┐
                                │                                │
   Obsidian plugin  ─── HTTP ───┤    daemon (process)            │
   (browser fetch)              │    binds 127.0.0.1:38473       │
                                │                                │
   Claude Code        ─── pipe ─┤    unix socket                 │
   stdio bridge                 │    $TMPDIR/vaultnexus.sock     │
                                │                                │
   Claude Desktop     ─── pipe ─┤                                │
   stdio bridge                 └────────────────────────────────┘
```

- **HTTP** for the Obsidian plugin (because the plugin runs inside Electron's renderer and `fetch()` is the only practical IPC).
- **Unix socket** for MCP clients (because the spec is stdio-based JSON-RPC; a Node bridge proxies stdio ↔ socket).
- Same daemon, same in-memory index. No duplication. No second cache.

## The index lifecycle

```
                                                  ┌──────────────────┐
                                                  │  embedding cache │
                                                  │  ~/.vaultnexus/  │
                                                  │  embeddings.db   │
                                                  └────────▲─────────┘
                                                           │
   ┌────────┐    chunkDocument()   ┌───────┐   embed()    │
   │ note   │─────────────────────▶│ chunk │──────────────┘
   │ *.md   │                      │ list  │
   └────────┘                      └───┬───┘
                                       │
                                       ▼
                                 ┌───────────┐
                                 │  vectors  │  (Float32Array per chunk)
                                 └─────┬─────┘
                                       │
        ┌──────────────────────────────┼────────────────────────┐
        │                              │                        │
        ▼                              ▼                        ▼
   ┌──────────┐                ┌──────────────┐         ┌─────────────────┐
   │ FTS5     │                │ flat f32     │         │ int8 quantized  │
   │ BM25     │                │ (exact)      │         │ (SIMD coarse)   │
   └────┬─────┘                └──────┬───────┘         └─────────┬───────┘
        │                             │                           │
        └────────────┬────────────────┴──────────────┬────────────┘
                     │                               │
              ┌──────▼──────┐                  ┌─────▼─────┐
              │ ranked hits │  RRF             │ snapshot  │
              │ (cited)     │ ─────────────────│ ~/.vault- │
              └─────────────┘                  │ nexus/    │
                                               │ index-    │
                                               │ snapshot  │
                                               │ .db       │
                                               └───────────┘
```

A note's lifecycle, in order:

1. `chunkDocument` parses the Markdown AST, walks heading depth, and splits into offset-faithful blocks (paragraph-level by default). Every block knows its byte range and heading path.
2. Block text → `Embedder.embed()` → 1×D `Float32Array`. The `CachingEmbedder` decorator hashes `model‖text`; cache hit = zero network.
3. Vectors are L2-normalized and stored three ways: a flat F32 buffer for exact rescore, an int8-quantized buffer for SIMD-coarse search, and an FTS5 row for keyword.
4. Snapshot persistence (`index-snapshot.db`) writes chunks + vectors + content-hash + mtime. On restart, unchanged notes restore from disk (microseconds), changed notes re-chunk + re-embed (cache often spares the API call).

## Querying

`POST /search { query, k? }` → `[SearchHit]`:

1. Embed the query (one API call).
2. Coarse top-N via int8 SIMD dot product (cheap).
3. Rescore the top-N with exact F32 cosine.
4. In parallel, query FTS5 with the same string.
5. Reciprocal-Rank-Fuse the two rankings.
6. Return ranked cited hits.

For multi-hop questions (`vaultnexus_trace`), the daemon walks the wikilink graph + retrieval graph to gather an answer chain. For narrative answers (`vaultnexus_reason`), it composes a response via the configured chat model.

## Cross-community bridges

1. Build the wikilink graph from `[[...]]` references inside notes.
2. Run Louvain community detection → each note gets a community id.
3. For each cross-community pair of chunks, compute cosine similarity.
4. Filter to pairs where `similarity > threshold` and `linked = false`. Those are the "secretly aligned" cross-cluster bridges.

This is interesting because most note-takers maintain link silos (one project ↔ one folder ↔ one heavily-linked sub-graph). Genuinely cross-cutting ideas are invisible to local navigation. Bridges surface them.

## Hot-swap chat model

The plugin posts `POST /configure-chat { provider, key?, model?, baseURL? }`. The daemon validates, instantiates a new `ChatModel`, and assigns it to the `VaultIndex.chatModel` slot — no restart, no index rebuild. The next `vaultnexus_reason` call uses the new model.

The plugin auto-pushes this config on every `loadSettings()` + every `saveSettings()`, with a 10-second retry loop that runs for the first 5 minutes after plugin load (handles the case where the daemon isn't up yet). Idempotent — re-pushing the same config is fine.

## Why a daemon and not a CLI

- The vector index lives in memory. A CLI would re-read the snapshot on every invocation; the daemon pays that cost once.
- Three consumers (plugin + Claude Code + Claude Desktop) hit the same index without coordinating.
- Hot-swap config (chat model) is impossible across short-lived CLI invocations.

## Why a snapshot in addition to a cache

- The **cache** is keyed by `model‖text` content hash. It saves the API call. It does NOT know which chunks belong to which note, or what order, or what byte ranges.
- The **snapshot** stores the fully-assembled per-note chunk set. Restart restores into memory in milliseconds.
- Together: snapshot for warm-start latency, cache for the case where snapshot is missing or a note changed.

## What's offset-faithful chunking?

When you click a hit in the Obsidian plugin, it should open the note at the exact heading. To do that, every chunk needs to know its byte range in the original source — not the chunk-after-tokenization-after-cleanup range, but the byte range in the file on disk. VaultNexus tracks this from the AST level using `position.start.offset` / `position.end.offset` on every block. Hits include `byteStart` + `byteEnd` for downstream consumers who want to highlight or edit the range.

## Code layout

```
src/
  core/                  embedding-agnostic primitives, no Node-specific deps
    chunk.ts             AST → offset-faithful blocks
    embedder.ts          Embedder interface + FakeEmbedder
    embed-protocol.ts    OpenAI-compatible /embeddings request/response
    vectors.ts           l2normalize, dotF32
    quantize.ts          calibrateScale, quantize
    search.ts            int8 coarse → f32 rescore
    fusion.ts            Reciprocal Rank Fusion
    router.ts            query intent classifier (lexical/conceptual/mixed)
    dpp.ts               Determinantal Point Process for diverse top-k
    wikilinks.ts         [[...]] extractor
    chat-model.ts        ChatModel interface + FakeChatModel
    fake-chat-model.ts   offline stub
    health.ts            version stamp
  daemon/                long-running process pieces
    main.ts              entrypoint
    http.ts              Hono app (/health, /status, /search, /bridges, /configure-chat)
    mcp-server.ts        MCP server (8 tools)
    socket-transport.ts  Unix socket transport for the MCP server
    vault-index.ts       in-memory index, snapshot attach, hot-swap chatModel
    indexer.ts           crawl vault dir, dispatch to addNote
    select-embedder.ts   env → Embedder factory
    select-chat-model.ts env → ChatModel factory + ChatConfig translator
    openai-embedder.ts   OpenAI-compatible client
    caching-embedder.ts  decorator
    embedding-cache.ts   SQLite-backed K/V (sha256 → vec bytes)
    index-snapshot.ts    SQLite-backed snapshot
    index-restore.ts     restore-or-rebuild, content-hash diff
    lock.ts              proper-lockfile single-instance guard
    note-graph.ts        Louvain community detection
    reason-{trace,compose,stream}.ts  multi-hop answer construction
    git-history.ts       git log → note revisions
    recall-narrate.ts    chat-model narrated history
    forecast-scan.ts     vault-wide [forecast: ...] ledger
    fts.ts               better-sqlite3 FTS5 wrapper
    ai-chat-model.ts     anthropic / openai / openai-compatible adapters
  bridge/
    main.ts              stdio ↔ unix-socket dumb pipe (no MCP parsing)
obsidian-plugin/
  src/
    main.ts              Plugin entry, auto-apply chat config
    SearchView.ts        sidebar search panel
    SettingsTab.ts       4-cell status panel + numbered sections
    settings.ts          settings schema + defaults
test/                    449+ vitest cases
docs/
  ARCHITECTURE.md        you are here
  GETTING_STARTED.md     10-minute install walkthrough
  specs/                 internal design + per-plan implementation notes
```
