# VaultNexus — Pipeline & Process Diagram

## Process model (the anti-Smart-Connections design)

Smart Connections embeds **inside Obsidian's renderer** → freezes the app. VaultNexus puts **100% of compute in a standalone daemon**; every UI is a thin client.

```
        THIN CLIENTS  (no embedding, no indexing, no search — zero heavy CPU)
   ┌────────────────┐   ┌────────────────────┐   ┌─────────────────────┐
   │  Claude Code   │   │ Obsidian (thin      │   │ Claude Desktop /    │
   │  (stdio shim)  │   │ plugin: UI + calls) │   │ Cursor (HTTP-MCP)   │
   └───────┬────────┘   └─────────┬──────────┘   └──────────┬──────────┘
           │  Unix domain socket (default, no network surface)│
           └──────────────────────┼───────────────────────────┘
                                   ▼
   ╔═══════════════════════ VAULTNEXUS ENGINE (daemon) ═══════════════════════╗
   ║                       ALL CPU lives here · single writer                  ║
   ║                                                                          ║
   ║  ── INDEX (incremental, content-hash cached) ──────────────────────────  ║
   ║   vault/*.md ─chokidar─► parse ─► chunk ─► embed(doc) ─► SQLite          ║
   ║              (remark+Quartz ofm   (header→512t,  (Nomic API   (vec_chunks ║
   ║               wikilink-resolve)    offset-true,   search_doc:) +fts+links ║
   ║                                    BM25 blurb)                +claims)    ║
   ║              └─► sentence-split ─► Claim Index (assertion filter)         ║
   ║                                                                          ║
   ║  ── QUERY ─────────────────────────────────────────────────────────────  ║
   ║   q ─► embed(query) ┐                                                     ║
   ║       Nomic API     ├─► sqlite-vec ⊕ FTS5 → RRF(k=60) → pool             ║
   ║   q ─► BM25 ────────┘            │                                        ║
   ║                       1-hop wikilink expansion (SQL CTE)                  ║
   ║                                  │                                        ║
   ║                       Voyage rerank-2.5 (API) → top 5-8                   ║
   ║                                  │                                        ║
   ║                       cited hits  path#heading^block                      ║
   ║                                                                          ║
   ║  ── SENTINEL (on write / on demand) ───────────────────────────────────  ║
   ║   new claim ─► similarity cull (Nomic) ─► assertion filter ─►            ║
   ║   Judge (host LLM via tool-result) ─► temporal reframe ─►                ║
   ║   confirm-and-learn (3-tier suppression, labels in SQLite)              ║
   ║                                                                          ║
   ║  ── BELIEF-DRIFT (recall_history) ─────────────────────────────────────  ║
   ║   git log -G<topic> ─► git show <sha>:<path> ─► re-derive claims ─►      ║
   ║   arc-compress (embedding distance) ─► Judge narrates                    ║
   ║                                                                          ║
   ║  ── EPISTEMIC INTEGRITY (batch) ───────────────────────────────────────  ║
   ║   contradiction graph ─► Louvain clusters · least-stable ·              ║
   ║   stale claims · drift-vs-convergence                                    ║
   ╚══════════════════════════════════════════════════════════════════════════╝
        │ writes: FS-atomic (temp+fsync+rename)        ▲ Obsidian user edits
        ▼                                              │
                              vault/*.md  ◄────────────┘
```

Key property: a 100k-note vault can be re-indexing in the daemon while Obsidian stays at 60fps — the plugin never does more than render JSON.

## Stages → what → tool/API → reuse mode → link

| # | Stage | What | Tool / API | Reuse | Link |
|---|---|---|---|---|---|
| 1 | Watch | detect vault changes | `chokidar` 4 | **depend** | https://github.com/paulmillr/chokidar |
| 2 | Parse | md→AST, OFM (`^block`, callouts, embeds, tags) | `unified`+`remark-*`; **Quartz `ofm.ts`** | depend + **steal file** | https://github.com/jackyzha0/quartz/blob/v4/quartz/plugins/transformers/ofm.ts |
| 3 | Wikilink resolve | shortest-path + block/heading | algorithm from **obsidian-export** | steal algorithm | https://github.com/zoni/obsidian-export |
| 4 | Chunk | header→512tok, offset-faithful, BM25 blurb | sep-list from LangChain.js | steal pattern | https://github.com/langchain-ai/langchainjs |
| 5 | Sentence-split | Claim Index provenance | `sentence-splitter` (`splitAST`) | **depend** | https://github.com/textlint-rule/sentence-splitter |
| 6 | Embed | doc/query vectors (model-dim) | **pluggable registry** (default `gemini-embedding-001` @768; Nomic/Gemma/Voyage/OpenAI/Cohere/Jina/generic) | **depend (API)** | https://ai.google.dev/gemini-api/docs/embeddings |
| 7 | Store | vectors+BM25+graph+claims | `sqlite-vec`+`better-sqlite3`+FTS5 | **depend** | https://github.com/asg017/sqlite-vec |
| 8 | Hybrid search | vec⊕BM25 RRF k=60 | Alex Garcia RRF CTE | steal SQL | https://alexgarcia.xyz/blog/2024/sqlite-vec-hybrid-search/index.html |
| 9 | Graph expand | 1-2 hop wikilinks | SQL recursive CTE | build | (SQLite) |
| 10 | Rerank | precision top-5-8 | **Voyage `rerank-2.5` API** | **depend** | https://docs.voyageai.com/docs/reranker |
| 11 | Judge | contradiction arbiter | tool-result-as-judge (host LLM) | build | (MCP) |
| 12 | Git/drift | belief history | `simple-git` | **depend** | https://github.com/steveukx/git-js |
| 13 | Clustering | epistemic integrity | `graphology-communities-louvain` | **depend** | https://github.com/graphology/graphology |
| 14 | Edit tools | surgical heading/block/frontmatter | **vendor cyanheads modules** (Apache) | **steal modules** | https://github.com/cyanheads/obsidian-mcp-server |
| 15 | MCP surface | tools/resources | `@modelcontextprotocol/sdk` | **depend** | https://github.com/modelcontextprotocol/typescript-sdk |
| 16 | Package | desktop install | `@anthropic-ai/mcpb` | depend (dev) | https://github.com/anthropics/mcpb |
| — | Eval oracle | validate metrics | `pytrec_eval` (dev subprocess) | wrap | https://github.com/cvangysel/pytrec_eval |

*(Reuse modes being re-validated by the best-of-breed wave: steal/depend where licenses allow, copy only when a thing isn't packaged or drops a feature we need.)*
