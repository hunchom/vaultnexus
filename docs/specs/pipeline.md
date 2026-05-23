# VaultNexus — Pipeline & Process Diagram (v3.0)

## Process model (the anti-Smart-Connections design)

Smart Connections embeds **inside Obsidian's renderer** → freezes the app. VaultNexus puts **100% of compute in a standalone daemon**; every UI is a thin client. The daemon also spends **idle cycles consolidating** (a morning brief), not just serving.

```
        THIN CLIENTS  (no embedding, no indexing, no search — zero heavy CPU)
   ┌────────────────┐   ┌────────────────────┐   ┌─────────────────────┐
   │  Claude Code   │   │ Obsidian (thin      │   │ Claude Desktop /    │
   │ (stdio self-   │   │ plugin: UI + calls) │   │ Cursor (HTTP-MCP)   │
   │  bridge→socket)│   └─────────┬──────────┘   └──────────┬──────────┘
   └───────┬────────┘  Unix socket (130µs, no net surface)  │ loopback HTTP
           └──────────────────────┼───────────────────────────┘  (hardened)
                                   ▼
   ╔═══════════════════════ VAULTNEXUS ENGINE (daemon) ═══════════════════════╗
   ║                  ALL CPU lives here · single writer by topology           ║
   ║                                                                          ║
   ║  ── INDEX (incremental, content-hash cached, Piscina workers) ──────────  ║
   ║   vault/*.md ─chokidar─► parse ─► HIERARCHICAL chunk ─► embed(doc) ─►     ║
   ║          (remark+Quartz ofm,    (sentence/chunk/note,  (pluggable        ║
   ║           obsidian-export        offset-true, OFM-zone   registry,        ║
   ║           wikilink-resolve)      guard)                  contextual?)     ║
   ║                │                          │                               ║
   ║          sentence tier = CLAIM INDEX      └─► binary codes + rescore lane ║
   ║                                               + usearch kNN graph (=conv) ║
   ║                                                                          ║
   ║  ── QUERY (adaptive cascade — zero generative LLM in hot path) ─────────  ║
   ║   q ─► ROUTER (TF-IDF/SVM, no embed) ─► strategy                          ║
   ║   q ─► embed(query) ┐  (speculative overlap)                              ║
   ║   q ─► BM25 (FTS5)  ├─► CC/TMM fusion (IDF-adaptive; RRF cold-start)      ║
   ║   q ─► wikilink-CTE ┘            │                                        ║
   ║                       CONFIDENCE GATE (free; self-warming)                ║
   ║                       ├─ HIGH ─► DPP coverage ─► adaptive-k  (no rerank)  ║
   ║                       └─ LOW  ─► GAR/RGS expansion (kNN+wikilink frontier ║
   ║                                  around reranker-confirmed) ─► rerank ─►  ║
   ║                                  DPP ─► adaptive-k                        ║
   ║                                  │                                        ║
   ║                       cited hits  path#heading^block                      ║
   ║   (predictive slow-thinker prefetch + RCU lock-free cache erase the tail) ║
   ║                                                                          ║
   ║  ── CONVERGENCE (headline · FP-safe) ──────────────────────────────────  ║
   ║   high-sim claim pairs across DIFFERENT Louvain communities, no edge ─►  ║
   ║   Bayesian-surprise rank ─► find_bridges                                  ║
   ║                                                                          ║
   ║  ── SENTINEL (opt-in · pull-only · FP-gated) ──────────────────────────  ║
   ║   claim ─► assertion filter ─► winkNLP negation router ─►                ║
   ║   belief-energy ΔH gate (H=Σω|bi−bj|) ─► Judge (tool-result) ─►          ║
   ║   temporal reframe + supersedes edge ─► confirm-and-learn (online τ)     ║
   ║                                                                          ║
   ║  ── LEDGER / DRIFT / EPISTEMIC ────────────────────────────────────────  ║
   ║   Decision&Prediction Ledger (Brier) · BOCPD drift · QBAF least-stable · ║
   ║   dense-seeded PPR connectors · Grounded Steelman                         ║
   ║                                                                          ║
   ║  ── SLEEP-TIME CONSOLIDATION (idle) ───────────────────────────────────  ║
   ║   walk changed clusters ─► precompute graphs ─► morning brief (pull)     ║
   ╚══════════════════════════════════════════════════════════════════════════╝
        │ LEAN STORE: sqlite-vec + FTS5 bm25() + simsimd binary brute-force    
        │ (no ANN ≤1M) + usearch kNN + LMDB (CSR graph·claims·cache)           
        │ writes: FS-atomic (temp+fsync+rename)        ▲ Obsidian user edits
        ▼                                              │
                              vault/*.md  ◄────────────┘
   (opt-in PG_URL tier: your own Postgres + pgvectorscale + pg_search/VectorChord)
```

Key property: a 100k-note vault re-indexes in the daemon while Obsidian holds 60fps; the query path is a ~1ms binary brute-force scan + (usually cached) embed + a conditional rerank; the idle daemon thinks.

## Stages → what → tool/API → reuse mode → link

| # | Stage | What | Tool / API | Reuse | Link |
|---|---|---|---|---|---|
| 1 | Watch | detect vault changes | `chokidar` 4 | **depend** | https://github.com/paulmillr/chokidar |
| 2 | Parse | md→AST, OFM (`^block`, callouts, embeds, tags) | `unified`+`remark-*`; **Quartz `ofm.ts`** | depend + **copy delta** | https://github.com/jackyzha0/quartz/blob/v4/quartz/plugins/transformers/ofm.ts |
| 3 | Wikilink resolve | shortest-path + block/heading | algorithm from **obsidian-export** | copy algorithm | https://github.com/zoni/obsidian-export |
| 4 | Chunk | **hierarchical** sentence/chunk/note, offset-faithful | `chonkie` (pinned + contract test) | **depend** | https://github.com/chonkie-inc/chonkiejs |
| 5 | Sentence tier (= Claim Index) | provenance + claims | `sentence-splitter` (`splitAST`) | **depend** | https://github.com/textlint-rule/sentence-splitter |
| 6 | Embed | doc/query vectors (model-driven dims) | **pluggable registry — model-AGNOSTIC** (own undici embed client; contextual mode if supported) | **build (thin)** | (registry; vendor-neutral) |
| 7 | Store | binary codes + rescore + kNN + graph + claims | **sqlite-vec + FTS5 + simsimd + usearch + LMDB** (lean, no ANN); Postgres opt-in | **depend** | https://github.com/asg017/sqlite-vec · https://github.com/ashvardanian/SimSIMD · https://github.com/unum-cloud/usearch · https://github.com/kriszyp/lmdb-js |
| 8 | Fusion | CC + theoretical-min-max, IDF-adaptive | Bruch et al. (CC>RRF); Alex Garcia RRF CTE = cold-start | build + copy SQL | https://arxiv.org/abs/2210.11934 · https://alexgarcia.xyz/blog/2024/sqlite-vec-hybrid-search/index.html |
| 9 | Router + confidence gate | per-query strategy + early-exit | TF-IDF/SVM (no embed); self-warming gate | **build** | https://arxiv.org/abs/2604.03455 · https://arxiv.org/abs/2510.14337 |
| 10 | Graph expand | **GAR/RGS reranker-guided** (kNN + wikilink frontier) | GAR/RGS algorithm over usearch graph | **build** | https://arxiv.org/abs/2208.08942 · https://arxiv.org/abs/2509.07163 |
| 11 | Diversity | DPP / facility-location coverage | fast-greedy DPP MAP | **build** | http://papers.neurips.cc/paper/7805-fast-greedy-map-inference-for-determinantal-point-process-to-improve-recommendation-diversity.pdf |
| 12 | Rerank | precision (registered reranker) | **own ~150-LOC undici** (Voyage/Cohere/Jina same shape) | **build (thin)** | (registry; vendor-neutral) |
| 13 | Negation router | Semantic-Collapse fix | `wink-nlp` + NegEx lexicon (`negspacy`) | depend + copy data | https://github.com/winkjs/wink-nlp · https://github.com/jenojp/negspacy |
| 14 | Sentinel | belief-energy contradiction (opt-in) | Ising dissonance `H=Σω|bi−bj|` | **build (moat)** | https://www.science.org/doi/10.1126/sciadv.abm0137 |
| 15 | Convergence | bridges across communities | Bayesian-surprise over kNN/claim graph | **build (headline)** | https://arxiv.org/abs/2604.12243 · https://arxiv.org/abs/2308.06368 |
| 16 | Judge | contradiction arbiter | tool-result-as-judge (host LLM, cascade) | build | (MCP) |
| 17 | Drift / temporal | belief change-points + supersedes | BOCPD + `simple-git` `log -G` | depend + build | https://github.com/steveukx/git-js |
| 18 | Epistemic view | least-stable + connectors | QBAF semantics + dense-seeded PPR; `graphology` Louvain | depend + build | https://github.com/graphology/graphology |
| 19 | Ledger | forecast calibration | Brier via `simple-statistics` | **build (new feature)** | https://github.com/simple-statistics/simple-statistics |
| 20 | Edit tools | surgical heading/block/frontmatter | **vendor cyanheads modules** (Apache) | **vendor** | https://github.com/cyanheads/obsidian-mcp-server |
| 21 | MCP surface | tools/resources/notifications + self-bridge | `@modelcontextprotocol/sdk` | **depend** | https://github.com/modelcontextprotocol/typescript-sdk |
| 22 | Daemon HTTP | Unix socket + loopback | `hono` + `@hono/node-server` | **depend** | https://github.com/honojs/hono |
| 23 | Package | desktop install | `@anthropic-ai/mcpb` | depend (dev) | https://github.com/anthropics/mcpb |
| — | Eval oracle | validate metrics | `pytrec_eval` (dev subprocess) | wrap | https://github.com/cvangysel/pytrec_eval |

*(Reuse modes per the best-of-breed waves: depend/copy where MIT/Apache/ISC/BSD allow; build the moat — the belief-energy Sentinel, convergence, the adaptive cascade, GAR/RGS, the vault-grounded router, the Ledger, sleep-time consolidation. Models stay vendor-neutral behind the 3-category registry.)*
