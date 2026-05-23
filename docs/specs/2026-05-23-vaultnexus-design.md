# VaultNexus — Design Spec (v3.1)

> **VaultNexus reasons over your vault — it doesn't just search it.**
> A Claude Code ↔ Obsidian knowledge engine: an OP retrieval brain (quantized-graph ANN + multi-vector late-interaction, scales to a billion chunks, exact and blazing fast), a two-speed pipeline that *reasons* on hard queries, a **Convergence/Bridge** engine that surfaces hidden agreement across distant notes, an opt-in **Sentinel** built on a convergent signed-belief-propagation graph that catches genuine self-contradiction and belief-drift, a **Decision & Prediction Ledger** that sharpens your judgment, and a daemon that **consolidates and drafts overnight**. Standalone-daemon architecture (one engine bears all CPU/GPU; thin clients), fully offline-capable, one-command GitHub build.

Status: **Design v3.1 — folds three best-of-breed agent waves: (1) 10× "validate each is the absolute best", (2) 10× "think-different / model-agnostic relaunch", (3) 10× "OP / find-the-ceiling" (the previous pass over-rotated to minimalism; this restores maximum ambition). Models are pluggable via a 3-category registry and never pinned. Pending user approval.**
Date: 2026-05-23
Spec owner: Roger

---

## 1. Problem & opportunity

Existing Obsidian AI tools: **Smart Connections** (cosine in the renderer — freezes the app), **Mem/Reflect** (connection-surfacing, commoditized), every Obsidian MCP server (CRUD wrappers), **InfraNodus** (topic-level structural gaps). mem0's *State of Agent Memory 2026* lists the real white space as **unsolved**: claim-level convergence, belief tracking, contradiction, surprise-retrieval, proactive consolidation, self-improving memory.

The opportunity is not "better search" — search is becoming commoditized. It is a **reasoning knowledge engine**: one that retrieves at the SOTA frontier (multi-vector late-interaction past the proven single-vector ceiling), *reasons* over the result with citations, models your beliefs as a convergent graph, surfaces where your ideas secretly agree, and gets smarter the more you use it. The moat is the **reasoning brain + the belief engine**, not CRUD.

## 2. Goals / non-goals

**Goals**
- **OP retrieval**: quantized-graph ANN + exact rescore (exact top-k, HNSW-latency, scales to ~1B) + a **multi-vector late-interaction precision tier** that breaks the proven single-vector dimensional ceiling; hierarchical (sentence→chunk→note) contextual representation; cited to `path#heading^block`.
- **Reasons, doesn't just retrieve**: a two-speed pipeline — a zero-LLM lookup lane for "find that note", and a reasoning lane (CoT query decomposition → graph PPR → multi-vector → listwise rerank → self-correction) for analytical/convergence/multi-hop queries.
- **Convergence/Bridge** as the headline; the **Sentinel** (signed belief-propagation) as an opt-in, pull-first, FP-gated companion; the **Decision & Prediction Ledger** as the judgment hook; **cited reasoning** + **counterfactual belief surgery** as the smart differentiators.
- **Standalone daemon** owns all CPU **and the machine's accelerators** (a hardware-probed Compute backend); uses idle cycles for **sleep-time consolidation and note-drafting**; gets measurably smarter on *your* vault with use.
- **Blazing fast AND OP at every scale** (not a trade): <1ms@1M, ~30–60ms@100M, <3ms@1B (DiskANN tier); the embedding round-trip is killed by a resident on-accelerator embedder + predictive prefetch.
- **Model-agnostic, local-first-capable**, embeddable (no mandatory Docker), offline-buildable, lean-but-powerful dep set.
- Agentic write-back: our own tools, dry-run + confirm.

**Non-goals**
- Competing on CRUD; topic-level gap-finding (InfraNodus owns it — we do *claim-level* epistemic work).
- A persistent LLM-extracted fact graph (killed — §10). The deterministic Claim Index + the belief graph are NOT this.
- Plugin-first; the Obsidian plugin is a P2 thin client.
- Multi-user / cloud sync; running models in the renderer.
- An **expensive LLM in the *lookup* path** (the reasoning lane is opt-in, routed, and cached); any **push** notification before precision is proven.

## 3. Guiding decisions (and what was rejected)

| Decision | Choice | Rejected & why |
|---|---|---|
| Vehicle | **Standalone engine daemon + thin clients**, justified by FS-watch + keep-compute-out-of-renderer + **sleep-time consolidation** + owning the **accelerators** | plugin-first; a Skill+CLI-only tool (loses the watcher, the resident accelerated embedder, the belief engine, the idle consolidation) |
| Runtime | **TypeScript on Node 22** | Bun/Deno (native-ABI / MCPB pin) |
| **Compute / acceleration** | **A hardware-probed `Compute` backend in `core/`** — `Accelerate(AMX) → Metal/MPS/WebGPU(Dawn) → ANE(Core ML) → cuVS/CAGRA(CUDA)` — behind one interface fronting embed forward-pass + index build + distance/rescore. The model-agnostic registry pattern applied to silicon; **degrades to the simsimd-CPU floor** when no accelerator exists. Embeddable, no Docker (Node 22 ships WebGPU-via-Dawn Metal backend, prebuilt arm64; Accelerate + Core ML are in-OS). | "no acceleration, brute-force forever" (self-contradicts the resident-embedder goal; incompatible with 100M+ scale) |
| Store / engine | **OP quantized-graph vector engine** behind one capability-probed `VectorIndex`: **usearch** (Apache, mmap, b1/i8/f16, SimSIMD) as the universal embeddable core, a **RaBitQ binary→int8→exact-f32 rescore cascade** (exact top-k, ~32× less RAM, ~40× faster scan), a **cuvs IVF-RaBitQ/CAGRA GPU tier** auto-lit on NVIDIA, and **VectorChord DiskANN** (server-only) for 100M–1B. **FTS5 `bm25()`** for keyword; **LMDB** for the CSR wikilink graph, Claim Index, multi-vector token store, cache. | **embedded-Postgres-default** (packaging minefield → opt-in `PG_URL`); **brute-force-as-the-engine / no ANN** (a regression — caps at ~1M, ignores the graph it already builds; demoted to the refine kernel + exact-filtered fallback); **naive PQ** (RaBitQ dominates it); DuckDB/LanceDB (see notes) |
| Retrieval representation | **Hierarchical small-to-big** (sentence/chunk/note, one index, `granularity` field) + a **multi-vector (ColBERT-style) token store for the note+chunk tiers** (1–2-bit residual-quantized, ~20–36 B/token, gated behind confidence escalation). The sentence tier = the Claim Index; the kNN edges = the convergence edges. | flat 512 chunks only (proven precision ceiling); proposition-for-retrieval (LLM tax + breaks provenance) |
| Retrieval pipeline | **Two-speed reasoning retriever** (REVERSED from a fixed funnel): **lookup lane** (router → dense binary scan + BM25 → CC/TMM fusion w/ **online-learned weights** → confidence gate → DPP → adaptive-k, zero-LLM, ~5ms); **reasoning lane** on escalation (CoT decomposition → dense-seeded **PPR** over kNN+wikilink → **MUVERA multi-vector** → **FIRST single-token listwise rerank** → **CRAG self-correction** → DPP → adaptive-k). | single dense vector + BM25 only (proven dimensional ceiling on the conjunctive/convergence queries that matter most); HyDE / blind query rewriting |
| **Provider registry** (3 model-agnostic roles) | embed (required) / rerank (optional) / judge (host session counts). **Capability probing** (dims aren't lookuppable → probe `.length`) + a **vault-grounded micro-benchmark router** (score the user's providers on ~30 Q→note pairs from their own vault; per-space embed, per-call rerank, cascade judge) + a pure **degradation compiler**. **AI SDK v6 for chat/judge only; own embed+rerank in ~150 LOC undici** (SDK rerank() is Cohere/Bedrock/Together-only; can't express contextual list-of-lists). Reranker interface carries an **`instruction?`** field (instruction-following rerank). | pinning any vendor/model; the AI SDK for all three roles; a static metadata table as the capability oracle |
| Fusion | **CC + theoretical-min-max, ONLINE-learned weights** (the eval golden set + confidence-gate labels are the supervision; RRF k=60 = zero-shot fallback); per-query expansion/MV gate | fixed-weight RRF only; SPLADE as a default (tokenizer-destructive on personal jargon — A/B opt-in only for lexical-heavy vaults) |
| Graph / expansion | **Dense-seeded PPR (Forward-Push, `O(1/αε)`) + GAR/RGS reranker-guided traversal** over the unified kNN+wikilink graph, as a **first-class retrieval signal** (HippoRAG-2-grade; the bridge engine and the retriever share one PPR core). Hub-bias solved by top-1% hub-pruning. | 1-hop CTE alone (fixed-pool ceiling); entity-seeded PPR (hub-bias); GraphRAG LLM-built graph |
| Sentinel substrate | **Signed Belief-Propagation graph with Reasoning Zones** (credibility Ψ vs confidence Φ; a damped contractive operator with a **guaranteed unique fixed point** → confidence emerges, killing the edge-weight/τ dials; **Harary-balanced Reasoning Zones**, linear-time, where multi-hop inference is sound; shock updates). Front-ended by a **winkNLP negation/polarity router**. One operator → contradiction + drift + **cited reasoning** + **counterfactual surgery**. | a static pairwise energy snapshot; embedding similarity as a standalone contradiction filter (negation-blind); local NLI |
| Temporal | git + mtime + frontmatter + **user-confirmed `supersedes` edges** + **bi-temporal edge validity intervals** (`valid_from`/`valid_to`/`invalidated_by`); **BOCPD** change-point drift | Graphiti bi-temporal LLM fact graph; throwing away the supersedes/validity signal |
| Headline vs Sentinel | **Convergence/Bridge is the headline** (FP-safe, ~5× hit-rate; *now actually works* because the multi-vector tier supplies the conjunctive-query capability it needs). **Contradiction is opt-in, pull-only, behind a hard FP kill-criterion.** | leading with contradiction (REFNLI: >80% false-contradiction under context-mismatch) |
| Self-improvement | **The system gets smarter on your vault with use** — listwise DPO / LinUCB from the confirm/dismiss + citation signal already collected (no GPU, no retraining); a self-edited **procedural memory** (learned retrieval strategies) on idle cycles | a static system that never learns from its own usage |
| Proactivity / UX | **Pull-first.** One **active-inference objective** (Bayesian surprise = expected free energy) ranks every proactive surface; the daemon **drafts the unwritten note** as a dry-run for a morning brief the user opens — never a push. | proactive "we caught something" notifications ("When Help Backfires") |
| First-run config | config file (+ plugin settings UI later) | MCP `elicitation` |
| MCP SDK + shim | TS SDK v1.x (≥1.24.0 for HTTP); **~40-line self-bridge** over the Unix socket | `mcp-proxy` npm (tunneling SaaS dep) |

## 4. Architecture

```
vaultnexus/   ONE Node package (pnpm; catalog centralizes versions)
├── src/
│   ├── core/      pure compute (no I/O): Compute backend (AMX/Metal/ANE/cuVS) ·
│   │              hierarchical chunking · CC/TMM online-learned fusion ·
│   │              PPR (forward-push) · GAR/RGS · MUVERA FDE · DPP · adaptive-k ·
│   │              signed belief-propagation + Reasoning Zones · BOCPD · QBAF ·
│   │              counterfactual surgery · active-inference scoring · eval ·
│   │              INTERFACES (Embedding, Reranker, Judge, VectorIndex, Store, …)
│   ├── store/     VectorIndex (usearch RaBitQ-cascade core · cuvs GPU tier ·
│   │              VectorChord disk tier) + FTS5 + LMDB (graph/claims/MV/cache)
│   ├── providers/ REGISTRY — capability probe + vault-grounded router; AI SDK
│   │              (chat/judge) + ~150-LOC undici embed/rerank (instruction-following)
│   ├── engine/    the DAEMON: Hono(socket+loopback), watcher, single writer,
│   │              RCU lock-free cache, predictive prefetch, sleep-time consolidation
│   ├── server/    MCP surface (tools/resources/instructions + notifications)
│   ├── shim/      ~40-line stdio→daemon self-bridge (Claude Code)
│   └── index/     FS walk + parser + hierarchical chunker + chokidar + cache
├── clients/obsidian/  THIN plugin: UI + HTTP calls only, ZERO compute
├── docs/specs/   this document
└── (README, LICENSE-MIT, pnpm-workspace.yaml, MCPB manifest)
```

### Process model: standalone daemon + thin clients
- **Daemon** (Node 22, Hono over Unix socket + loopback) owns all compute **and the accelerators**; single-instance via socket-connect probe + `proper-lockfile`. Clients are thin: Claude Code → ~40-line self-bridge over the socket; Obsidian → thin plugin via `requestUrl()` over loopback (zero compute, 60fps); Desktop/Cursor → HTTP-MCP. Single writer by topology.

### The Compute backend (the single biggest power-multiplier)
A hardware-probed accelerator behind one `core/` interface fronting **(a)** the resident embedder forward-pass, **(b)** index build, **(c)** batched distance + rescore (`sgemm`/Hamming). Probe order on macOS: **Accelerate/AMX → Metal/MPS or WebGPU(Dawn) → ANE/Core ML**; on Linux/NVIDIA: **cuVS/CAGRA**. A hardware `capability_card` mirrors the provider one. No accelerator → the backend *is* the simsimd-CPU floor (strict superset, never worse). The **resident local embedder runs on the ANE (~1ms vs ~800ms cloud)**, optionally hedged-raced against a cloud embedder — the single biggest hot-path latency win.

### The vector engine (OP — quantized graph, exact, scales to 1B)
One capability-probed `VectorIndex`:
- **Core (all platforms): usearch** (Apache, single-file, mmap view-from-disk, b1/i8/f16, SimSIMD NEON/AMX/AVX-512) running a **RaBitQ cascade**: traverse a navigable graph over **1-bit RaBitQ codes** (≈40× faster, ≈32× less RAM) → oversample 3–5× → **int8 rescore** (~99% recall) → **exact f32 refine** on the final k (recall 0.95–1.0, *exact* ranking). RaBitQ's error bound is what makes the 1-bit prune trustworthy; the f32 refine preserves the design's exact-search virtue. `usearch` is *already* the kNN-graph builder — now it is the search engine too (one structure, two jobs).
- **GPU tier (opt-in, auto-lit on NVIDIA): cuvs-node** IVF-RaBitQ/CAGRA — beats CAGRA 1.3–5.6× QPS @0.95, builds 7.7× faster; build-on-GPU→serve-on-CPU handoff keeps instant restart.
- **Disk tier (100M–1B, opt-in `PG_URL`): VectorChord DiskANN** (server-only) — 1B on 64 GB RAM + SSD, <3 ms, 95% recall, 15–50× less RAM than HNSW. Plain `usearch`-mmap-DiskANN covers the embeddable single-file path to ~1B.
- **Scale switch (measured, not dogma):** binary-cascade ≤~10M (GPU/AMX-accelerated, exact) → usearch-DiskANN mmap to 1B → cuvs on NVIDIA. **DARTH declared-recall early-termination** (6.8×) + **ADSampling** (−90% dims touched) + **SPFresh** in-place updates (constant-latency at billion scale). ⚠️ binary needs ≥1024-dim → the degradation compiler defaults to int8-primary below that. Brute-force stays only as the refine kernel + the exact-filtered fallback (ACORN-style predicate traversal avoids the filtered-recall cliff).

### Retrieval representation
Hierarchical sentence/chunk/note in one index (RAPTOR collapsed-tree, `granularity` field) on the contextual-embedding substrate (used if the embedder supports it). The **note+chunk tiers also store ColBERT-style token vectors** (1–2-bit residual-quantized, ~20–36 B/token) for the multi-vector tier — gated behind the confidence escalation so storage stays bounded. The sentence tier *is* the Claim Index.

### Throughput & blazing-fast systems
Resident on-ANE embedder (~1ms) + **predictive "slow-thinker" prefetch** keyed to the Claude Code working set (pre-embed the agent's next query → ~316×/cache-hit, erases the p90/p99 tail; FP-safe) + **τ-bounded approximate result cache** + **RCU double-buffered columnar lock-free cache** (Structure-of-Arrays feeds SimSIMD/AMX) + `undici` pre-warmed pools + `p-queue` backpressure + Piscina workers with a **SharedArrayBuffer ring buffer** (zero-copy) + speculative stage overlap. Streaming push (in-process fanout) for index progress + standing intelligence; the synchronous query stays request/response.

## 5. Retrieval pipeline (v3.1 — two-speed reasoning retriever)

**Index time:** parse → OFM → offset-faithful hierarchical chunk → embed (contextual if supported; resident-accelerated) → store RaBitQ codes + int8/f32 rescore lanes + (note/chunk) token vectors + the deterministic BM25 blurb; build the usearch kNN graph (shared with convergence). Sentence tier = Claim Index.

**Query time:**
```
0. PREFETCH      speculative embed+retrieve → RCU cache         p(hit)=75% → 0ms
1. ROUTER        cached TF-IDF/SVM (no embed) → {α, expand?, MV?, rerank tier}   ~0.1ms
2. LOOKUP LANE (zero-LLM, the common case):
     dense RaBitQ-cascade scan ‖ FTS5 BM25 ‖ wikilink-CTE (speculative overlap)
     → CC/TMM fusion (online-learned weights; RRF cold-start)
     → CONFIDENCE GATE (free, self-warming from eval rerank-ablation labels)
        ├ HIGH → DPP coverage → adaptive-k → RETURN              ~5ms
        └ LOW  → escalate ↓
3. REASONING LANE (analytical / convergence / multi-hop):
     host-session CoT query decomposition (the judge is already there)
     → dense-seeded PPR over the kNN+wikilink graph (HippoRAG-2-grade)
     → MUVERA-FDE multi-vector shortlist → Chamfer/MaxSim rerank   ~10–20ms
       (breaks the proven single-vector dimensional ceiling)
     → FIRST single-token listwise rerank on the host judge (or undici pointwise)
     → CRAG self-correction gate {sufficient | reformulate | fetch-the-bridge}
     → GAR/RGS frontier expansion (kNN + wikilink, weighted) within budget
     → DPP coverage → adaptive-k
4. cited hits { path#heading^block, snippet, score, why-retrieved, evidence-chain? }
```
- **Auto mode-switch:** tiny vault → stuff whole vault into context (prompt caching) — first-class.
- The reasoning lane keeps **no *mandatory* LLM in the lookup path**; its CoT/listwise calls reuse the host session the user is already paying for in an agentic loop, hidden behind prefetch/cache.
- **Fold-later (A/B switchboard):** WARP as the MV escalation engine; learned-sparse leg for lexical-heavy vaults; full per-query dynamic α.

## 6. Convergence + Sentinel (signed belief-propagation)

**Convergence/Bridge (headline, FP-safe, ships first):** over the kNN/claim graph, high-similarity claim pairs across **different** Louvain communities with **no existing edge** → bridge candidates, ranked by **Bayesian surprise** (KL of the belief distribution before/after). Claim-level epistemic bridging — and it *works* because the multi-vector tier can finally rank the conjunctive patterns convergence depends on. A wrong bridge costs nothing.

**Contradiction (opt-in, pull-only, FP-gated) — Signed Belief-Propagation graph with Reasoning Zones:**
- Topic = a belief graph; node `bᵢ∈[−1,1]` = a stance; edge `ωᵢⱼ` = signed relatedness (wikilink graph + claim similarity). A **damped contractive propagation operator** computes **credibility Ψ** (a-priori source trust) and **confidence Φ** (emergent) with a **guaranteed unique fixed point** — confidence *emerges*, eliminating the per-topic edge-weight/τ dials. **Reasoning Zones** = Harary-balanced subgraphs (signed 2-coloring, linear time) where multi-hop inference is internally consistent. A contradiction = an edit that **spikes dissonance / breaks balance** in a well-connected zone (structural surprise). Connectivity gate + balance + structural self-resolution (update vs contradiction) are three FP gates that fall out free; **shock updates** adapt without oscillation.
- Pipeline: Claim Index lookup → assertion pre-filter → **winkNLP negation/polarity router** (fixes "Semantic Collapse" — dense vectors are negation-blind) → belief-propagation update → **Judge** (bias-hardened tool-result-as-judge; cascade) adjudicates survivors and sets edge signs (closing the loop) → temporal reframe + `supersedes`/validity edges → confirm-and-learn (online).
- **FP kill-criterion (HARD):** if FP can't beat a stated threshold (e.g. <1 false contradiction per 50 edits) on a real messy vault by end of P1.5, contradiction ships **off by default**; only convergence surfaces.

**Cited reasoning — `reason_over_vault` / `prove` (the "thinks, not just retrieves" tool):** LLM decomposes the question → BFS over the belief graph within **Reasoning Zones** → each path is an **evidence chain with `path#heading^block` provenance per hop** → the judge composes a cited answer, **refusing to reason across a flagged contradiction**. <3 s graph overhead (StepChain); LLM-on-demand only. No other tool can do this — it requires the signed belief graph.

**Counterfactual belief surgery — `what_if_I_drop(X)`:** drop/reverse a claim → re-run the forward-push propagation → report which beliefs lose support, which contradictions resolve, which zones re-balance (CFKGR/COULDD). Interventional, not just descriptive.

## 7. Standing intelligence + sleep-time consolidation

- **One active-inference objective:** Bayesian surprise = expected free energy ranks bridges, contradictions, steelman targets, prediction-resurfacing, **and** the prefetcher — "what will most move the user's beliefs / resolve their uncertainty?" — replacing per-feature heuristics and generating proactive questions at the vault's structural gaps.
- **Sleep-time consolidation (the moonshot):** on idle cycles the daemon walks high-surprise clusters, pre-computes the belief/convergence graphs, and **drafts the unwritten note** ("three notes converge on X; here's the thesis, cited") as a dry-run for a pull-based morning brief — never a push (Letta sleep-time: 18% acc, 2.5× cost).
- **Self-improving / procedural memory:** the daemon distills successful retrieval trajectories + confirm/dismiss patterns into a self-edited playbook that primes the router and Sentinel — generalizing confirm-and-learn from "tune τ" to "learn how Roger reasons." Listwise-DPO/LinUCB from implicit feedback, no GPU.
- **Decision & Prediction Ledger:** extract forecast-claims, resurface on outcome-date/topic, per-topic **Brier calibration** (cosine + date math; judge narrates on demand).
- **Grounded Steelman:** the strongest counter-case grounded in *your* vault (reverse the contradiction cull + evidence-absence check).
- **Epistemic Integrity view:** least-stable beliefs via QBAF gradual semantics (incremental); connector notes via dense-seeded hub-pruned PPR; Louvain via `graphology` (no native binary).
- **Ambient push** — last, opt-in, affirming, FP-gated.
- **P3 cross-source life-graph:** vault + GitNexus code-graph + read-later as one belief network (G-reasoner/QuadGraph 34M graph foundation model) — uncopyable; only VaultNexus is positioned for it.

## 8. MCP surface

stdio self-bridge → daemon over Unix socket; loopback HTTP for the plugin. Tools carry `outputSchema`+`structuredContent`, correct hints; `instructions` ≤2 KB front-loaded; **streaming notifications** for progress + standing intelligence. No `sampling`/`elicitation`.

**Read:** `semantic_search`, `note_context` (flagship), `reason_over_vault` / `prove` (cited inference), `find_bridges` (convergence, headline), `what_if_i_drop` (counterfactual), `what_links_here`, `recall_history`, `decision_ledger` / `recall_predictions`, `challenge_claim` (steelman), `sentinel_check` (opt-in), `epistemic_report`, `vault_diff`, `vault_stats`. *(P2: `note_ripple`, `graph_query`, `tag_map`, `moc_map`.)*

**Write** (dry-run + confirm; our own tools, FS atomic): `create_note`, `edit_note`, `safe_rename_note`, `accept_draft` (the consolidation drafts). *(P2: `suggest_links`, `synthesize_moc`.)*

**HTTP security:** SDK ≥1.24.0, bind 127.0.0.1, Origin/Host allowlist, bearer token (GHSA-w48q-cv73-mx4w). Socket path = filesystem perms only.

## 9. Offline build & dependency centralization

Local-first registry (local accelerated embedder + reranker + judge) = a true air-gapped runtime and the **privacy default**; cloud is the max-quality opt-in (privacy stated per provider).
- **Offline build:** pnpm `catalog:` + committed lockfile; `pnpm fetch` → offline `--frozen-lockfile` on pinned pnpm `11.0.7`; CI cold-store cross-arch. Native deps: **`better-sqlite3`/`sqlite-vec` (or `vectorlite`), `usearch`, `lmdb`, `simsimd`**, + the Compute backend (WebGPU-via-Dawn prebuilt arm64; Accelerate/Core ML in-OS; cuvs-node only on NVIDIA boxes) — all prebuilt; **no embedded-Postgres, no pgvector pipeline**.
- **Runtime = the registry** (no ML bundled; local models are the user's own, run accelerated in the daemon).
- **Always local:** vault, index, graphs (kNN/wikilink/claim/belief), all deterministic code.
- **Distribution:** MCPB (per-platform, vendored) primary; `npx` convenience. Secrets via env, never committed.

## 10. Explicitly rejected / un-rejected (kept for the record)

**Un-rejected by the OP pass (the minimalist pass wrongly killed these):** ANN/graph index as the engine (RaBitQ-graph beats brute-force on every axis); GPU/Metal/ANE acceleration (the resident-embedder + 100M-scale goals require it); RaBitQ quantization; **multi-vector late-interaction** (the only architecture past the proven single-vector ceiling); **dense-seeded PPR as a retrieval signal** (HippoRAG-2-grade); a **reasoning lane with a routed LLM** (BRIGHT +12.2 nDCG — but only on the escalation path, never the lookup path).

**Still rejected:** **naive Product Quantization** (RaBitQ dominates); **full PLAID** (MUVERA/WARP dominate on CPU); **embedded-Postgres as default** (→ opt-in); **brute-force as the *engine*** (→ refine kernel only); **HyDE / blind query rewriting / GraphRAG LLM-build**; **test-time-compute reasoning rerankers in the hot path** (→ sleep-time consolidation only); **SPLADE as a default** (A/B opt-in for lexical-heavy vaults); proposition-for-retrieval; persistent bi-temporal LLM fact graph; **push-by-default UX**; SEDA / io_uring / query-compilation / Arrow-on-the-wire / Bun-Deno; MCP `sampling`/`elicitation`; `mcp-proxy` dep; forking cyanheads (vendor the module).

## 11. Evaluation

- Golden **Q→note** set (also seeds the provider micro-benchmark) + a **LIMIT-style conjunctive negative set** (proves the multi-vector tier earns its keep on the queries single-vector can't rank); Recall@k, **MRR** (`recip_rank`), **NDCG@10** — hand-rolled TS validated once vs **`pytrec_eval`** (1e-6).
- A/B switchboard: `dense → +bm25 → +CC-online-fusion → +PPR → +MUVERA → +FIRST → +CRAG` → the failure-rate ladder; its labels self-warm the confidence gate **and** train the online fusion weights.
- **Sentinel FP = primary metric** + the hard kill-criterion + the 8-category messy negative set. **Convergence precision** + **Decision-Ledger Brier** + **reasoning-chain faithfulness** = secondary. RAGAS reimpl on the Judge (autoevals prompts). promptfoo rejected.
- Per-run manifest: graph source + every model-id + golden hash + seed. CI smoke-eval on a fixture vault.

## 12. Phasing

- **P0 — scaffold + de-risk:** Node 22 package, pnpm catalog, `VectorIndex` + `SqliteStore` (sqlite-vec/usearch + FTS5 + LMDB), the **Compute backend** (CPU floor + one accelerator path), **RaBitQ cascade**, `core` interfaces, hierarchical chunker (+ offset contract test), config, CI cold-store. **Spikes:** ① capability-probe + registry round-trip; ② RaBitQ-cascade latency/recall at 1M/10M; ③ resident-accelerated-embedder warm path (ANE/Metal); ④ binary-needs-≥1024-dim degradation; ⑤ belief-propagation FP on a real vault vs the kill-criterion.
- **P1 — OP retrieval base:** quantized-graph engine + GPU tier auto-detect, hierarchical index, contextual embeddings, **lookup lane** (CC online-learned fusion + DPP + adaptive-k + confidence cascade), own-embed/rerank undici (instruction-following), vault-grounded router + degradation compiler, RCU cache + predictive prefetch, core read/write tools, eval harness (incl. LIMIT set), stdio self-bridge.
- **P1.5 — reasoning + differentiators:** the **reasoning lane** (CoT → PPR → **MUVERA multi-vector** → **FIRST listwise** → CRAG); **Convergence (`find_bridges`)** first; **`reason_over_vault`**; the **Decision & Prediction Ledger**; **Grounded Steelman**; the opt-in **Sentinel** (signed belief-propagation + negation router + `supersedes`/validity edges) behind the FP kill-criterion; `recall_history`, `safe_rename_note`.
- **P2 — standing + scale + self-improvement:** `what_if_i_drop` counterfactual; **self-improving** DPO/procedural memory; **sleep-time consolidation + note-drafting**; **scale tiers** (usearch-DiskANN, cuvs/CAGRA build, DARTH, SPFresh); Epistemic Integrity (QBAF + PPR); BOCPD drift; streaming push; MCPB bundle; optional Obsidian plugin; Ambient (opt-in, FP-gated).
- **P3 / moonshot:** cross-source life-graph (vault + GitNexus + read-later), multimodal/ColPali retrieval, learned graph foundation model resident in the daemon.

## 13. Open questions

- **Binary-dim threshold + MV storage budget:** confirm the ≥1024-dim binary floor and the token-vector storage ceiling (gate MV strictly behind confidence escalation).
- **FDE-vs-WARP crossover:** does MUVERA-FDE recall suffice on a real vault, or is the WARP engine needed? (build FDE first; WARP = documented escalation.)
- **Reasoning-lane latency budget:** the p95 target for the escalation path and the router threshold that sends queries to it.
- **Belief-propagation params:** credibility priors Ψ per source-zone; validate convergence + FP on the golden + negative sets (far fewer dials than the energy model, but Ψ needs setting).
- **Resident-embedder default:** local-accelerated-by-default (cloud hedged) vs cloud-default — decide from the on-hardware micro-benchmark.
- **Scale crossover:** measured binary-cascade → DiskANN → GPU switch points on real hardware.
- **Headless graph parity vs `metadataCache`** — measure divergence; document known-unequal cases.
