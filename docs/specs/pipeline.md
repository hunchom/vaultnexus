# VaultNexus — Pipeline & Process Diagram (v3.1, OP)

## Process model (the anti-Smart-Connections design)

Smart Connections embeds **inside Obsidian's renderer** → freezes the app. VaultNexus puts **100% of compute (and the machine's accelerators) in a standalone daemon**; every UI is a thin client. The daemon **reasons, consolidates, and drafts on idle cycles** — not just serves.

```
        THIN CLIENTS  (zero compute)
   ┌────────────────┐   ┌────────────────────┐   ┌─────────────────────┐
   │  Claude Code   │   │ Obsidian (thin      │   │ Claude Desktop /    │
   │ (self-bridge→  │   │ plugin: UI + calls) │   │ Cursor (HTTP-MCP)   │
   │  Unix socket)  │   └─────────┬──────────┘   └──────────┬──────────┘
   └───────┬────────┘  socket (130µs) / loopback HTTP (hardened)
           └──────────────────────┼───────────────────────────┘
                                   ▼
   ╔═══════════════════════ VAULTNEXUS ENGINE (daemon) ═══════════════════════╗
   ║              ALL CPU + GPU/ANE here · single writer by topology           ║
   ║                                                                          ║
   ║  ── INDEX (incremental, Piscina + SharedArrayBuffer ring) ──────────────  ║
   ║   vault/*.md ─chokidar─► parse ─► HIERARCHICAL chunk ─► embed(accel) ─►   ║
   ║         (remark+ofm,    (sentence/chunk/note,  (resident ANE ~1ms        ║
   ║          obsidian-export  offset-true)          or cloud, hedged)         ║
   ║                │                       │                                  ║
   ║        sentence = CLAIM INDEX   ─► RaBitQ codes + int8/f32 rescore lanes  ║
   ║                                    + MV token vectors + usearch kNN graph ║
   ║                                                                          ║
   ║  ── QUERY (two-speed reasoning retriever) ──────────────────────────────  ║
   ║   0 PREFETCH (slow-thinker, Claude-Code working set) → RCU cache  316×/hit║
   ║   1 ROUTER (TF-IDF/SVM, no embed) → strategy                              ║
   ║   2 LOOKUP LANE: usearch RaBitQ scan ‖ BM25 ‖ wikilink-CTE                ║
   ║        → CC/TMM online-learned fusion → CONFIDENCE GATE                   ║
   ║          ├ HIGH → DPP → adaptive-k → cited           (~5ms, zero-LLM)     ║
   ║          └ LOW  → REASONING LANE ↓                                        ║
   ║   3 REASONING LANE: CoT decompose → dense-seeded PPR → MUVERA multi-vec   ║
   ║        → FIRST listwise → CRAG self-correct → GAR/RGS → DPP → adaptive-k  ║
   ║        (breaks the proven single-vector ceiling; cited evidence chain)    ║
   ║                                                                          ║
   ║  ── CONVERGENCE (headline · FP-safe) ──────────────────────────────────  ║
   ║   claim pairs across DIFFERENT communities, no edge → Bayesian-surprise   ║
   ║                                                                          ║
   ║  ── SENTINEL (opt-in · pull-only · FP-gated) ──────────────────────────  ║
   ║   assertion filter → winkNLP negation → SIGNED BELIEF-PROPAGATION         ║
   ║   (Ψ credibility / Φ confidence, unique fixed point; Reasoning Zones,     ║
   ║    Harary balance) → Judge → supersedes + bi-temporal validity edges      ║
   ║                                                                          ║
   ║  ── REASON / COUNTERFACTUAL / LEDGER / DRIFT ──────────────────────────  ║
   ║   reason_over_vault (cited, within Reasoning Zones) · what_if_i_drop(X)   ║
   ║   · Decision&Prediction Ledger (Brier) · BOCPD drift · Grounded Steelman  ║
   ║                                                                          ║
   ║  ── SELF-IMPROVE + SLEEP-TIME (idle) ──────────────────────────────────  ║
   ║   DPO from confirm/dismiss + procedural memory · active-inference (EFE)   ║
   ║   ranks every surface · DRAFTS the unwritten note → pull morning brief    ║
   ╚══════════════════════════════════════════════════════════════════════════╝
     COMPUTE BACKEND: Accelerate/AMX → Metal/WebGPU(Dawn) → ANE/CoreML →
                      cuVS/CAGRA(NVIDIA); degrades to simsimd-CPU floor
     VECTOR ENGINE: usearch RaBitQ cascade (exact + ~1ms + scales 1B) →
                    cuvs GPU tier → VectorChord DiskANN (opt-in PG_URL)
        │ writes: FS-atomic (temp+fsync+rename)        ▲ Obsidian user edits
        ▼                                              │
                              vault/*.md  ◄────────────┘
```

Key property: OP *and* blazing-fast are the same design — quantized-graph + exact-rescore + accelerators. Exact top-k at ~1ms@1M, ~30–60ms@100M, <3ms@1B; reasoning where it matters, lookup where it doesn't.

## Stages → what → tool/API → reuse → link

| # | Stage | What | Tool / API | Reuse | Link |
|---|---|---|---|---|---|
| 1 | Watch | vault changes | `chokidar` 4 | depend | https://github.com/paulmillr/chokidar |
| 2 | Parse | md→AST, OFM | `unified`+`remark-*`; Quartz `ofm.ts` | depend + copy | https://github.com/jackyzha0/quartz |
| 3 | Resolve | wikilink shortest-path + block | obsidian-export algo | copy | https://github.com/zoni/obsidian-export |
| 4 | Chunk | hierarchical sentence/chunk/note | `chonkie` (pinned + contract test) | depend | https://github.com/chonkie-inc/chonkiejs |
| 5 | Claim tier | sentence offsets = Claim Index | `sentence-splitter` | depend | https://github.com/textlint-rule/sentence-splitter |
| 6 | Embed | vectors (accelerated, model-agnostic) | own undici embed; **resident on ANE/Metal** | build + Compute backend | (registry; vendor-neutral) |
| 7 | **Engine** | RaBitQ cascade, exact, 1B | **usearch** (core) · **cuvs** (GPU) · **VectorChord** (disk) | depend | https://github.com/unum-cloud/usearch · https://github.com/rapidsai/cuvs |
| 8 | SIMD/accel | distance/rescore/build | **simsimd** + Compute backend (AMX/Metal/ANE/cuVS) | depend + build | https://github.com/ashvardanian/SimSIMD |
| 9 | Keyword | BM25 | FTS5 `bm25()` | depend | https://sqlite.org/fts5.html |
| 10 | Graph/claims/MV | CSR graph + Claim Index + token vectors + cache | **LMDB** | depend | https://github.com/kriszyp/lmdb-js |
| 11 | Router + gate | per-query strategy + early-exit | TF-IDF/SVM; self-warming gate | build | https://arxiv.org/abs/2604.03455 |
| 12 | Fusion | CC/TMM, online-learned weights | Bruch (CC>RRF) + learned-to-rank | build | https://arxiv.org/abs/2210.11934 |
| 13 | PPR expand | dense-seeded forward-push PPR | HippoRAG-2-grade, hub-pruned | build | https://arxiv.org/abs/2502.14802 |
| 14 | Multi-vector | late-interaction precision tier | **MUVERA FDE** (+ WARP escalation) | build | https://arxiv.org/abs/2405.19504 · https://arxiv.org/abs/2501.17788 |
| 15 | Rerank | listwise / instruction-following | **FIRST** single-token on host judge; own undici | build | https://arxiv.org/abs/2406.15657 |
| 16 | Self-correct | retrieval-quality gate + reformulate | **CRAG** | build | https://arxiv.org/abs/2401.15884 |
| 17 | Diversity | coverage select | DPP / facility-location | build | https://arxiv.org/abs/2406.15657 |
| 18 | Convergence | bridges across communities | Bayesian-surprise over graph | build (headline) | https://arxiv.org/abs/2604.12243 |
| 19 | Sentinel | signed belief-propagation + zones | damped contractive op; Harary balance | **build (moat)** | https://arxiv.org/html/2510.10042 |
| 20 | Negation | Semantic-Collapse fix | `wink-nlp` + NegEx (`negspacy`) | depend + copy | https://github.com/winkjs/wink-nlp |
| 21 | Reason | cited multi-hop within zones | StepChain-style BFS | build | https://arxiv.org/html/2510.02827v1 |
| 22 | Counterfactual | what_if_i_drop(X) | CFKGR/COULDD | build | https://arxiv.org/abs/2403.06936 |
| 23 | Drift / temporal | change-points + supersedes/validity | BOCPD + `simple-git` | depend + build | https://github.com/steveukx/git-js |
| 24 | Ledger | forecast calibration | Brier via `simple-statistics` | build (new) | https://github.com/simple-statistics/simple-statistics |
| 25 | Epistemic | least-stable + connectors | QBAF + dense-seeded PPR; `graphology` | depend + build | https://github.com/graphology/graphology |
| 26 | Self-improve | learn from confirm/dismiss | listwise-DPO/LinUCB + procedural memory | build | https://arxiv.org/html/2602.08575 |
| 27 | Consolidation | draft the unwritten note | active-inference (EFE) + sleep-time | build (moonshot) | https://www.letta.com/blog/sleep-time-compute |
| 28 | Edit tools | surgical heading/block/frontmatter | vendor cyanheads (Apache) | vendor | https://github.com/cyanheads/obsidian-mcp-server |
| 29 | MCP | tools/resources/notifications + self-bridge | `@modelcontextprotocol/sdk` | depend | https://github.com/modelcontextprotocol/typescript-sdk |
| 30 | Daemon HTTP | socket + loopback | `hono` + `@hono/node-server` | depend | https://github.com/honojs/hono |
| 31 | Package | desktop install | `@anthropic-ai/mcpb` | depend (dev) | https://github.com/anthropics/mcpb |
| — | Eval oracle | validate metrics | `pytrec_eval` (dev) | wrap | https://github.com/cvangysel/pytrec_eval |

*(OP + blazing-fast is one design. Build the moat — the quantized-graph + multi-vector engine past the single-vector ceiling, the signed-belief-propagation graph powering convergence + cited reasoning + counterfactual surgery, the Compute backend, and a system that gets smarter with use. Models stay vendor-neutral behind the 3-category registry.)*
