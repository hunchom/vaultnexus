# VaultNexus — Implementation Notes (build bible, v3.1)

Distilled from three best-of-breed agent waves (10 validate · 10 think-different/model-agnostic · 10 OP/find-the-ceiling, 2026-05-23). Companion to `2026-05-23-vaultnexus-design.md`. Build-ready: pinned versions, APIs, gotchas, P0 risks.

> Convention: pin every version; quoted ids/issues verbatim.
> **Models are AGNOSTIC** (3-category registry is the contract; vendor names = example adapters).
> **OP + blazing-fast is one design** (quantized-graph + exact-rescore + hardware acceleration), not a trade. Brute-force is the refine kernel, never the engine.

## 0. Pinned versions (pnpm catalog)

| Dep | Version | Note |
|---|---|---|
| node | **>=22** (`.nvmrc=22`) | Claude Desktop ABI 127; ships WebGPU-via-Dawn (Metal backend) |
| pnpm | **11.0.7** (frozen) | offline-fetch regressions |
| **usearch** | 2.x | **the vector ENGINE** (not just kNN builder): mmap, b1/i8/f16, SimSIMD; RaBitQ cascade; Apache, N-API prebuilts |
| **simsimd** | latest | SIMD distance (cosine/dot f32/i8 + **Hamming popcount** for the binary tier); NEON/AMX/AVX-512; NAPI |
| better-sqlite3 + sqlite-vec | 12.x / 0.1.9 | metadata + FTS5 `bm25()`; sqlite-vec holds vector blobs (search via usearch/simsimd, not its ANN) |
| vectorlite | latest | optional persisted-HNSW-in-SQLite alt |
| **lmdb** (Doerr) | 3.x | CSR wikilink graph + Claim Index + **MV token-vector store** + cache + labels; ACID, mmap |
| **cuvs-node** | latest | **opt-in GPU tier** (IVF-RaBitQ/CAGRA); Apache, true N-API; auto-lit on NVIDIA only |
| WebGPU (Dawn) / `webgpu` or `kmamal/gpu` | latest | **Compute backend** Metal path; prebuilt arm64-mac |
| ai (Vercel AI SDK v6) + `@ai-sdk/*` | 6.x | **chat/judge role ONLY** |
| @modelcontextprotocol/sdk | ≥1.24.0 (1.29.x) | self-bridge + streaming notifications |
| unified/remark-parse/-gfm/-frontmatter | 11/11/4/5 | mdast |
| gray-matter + js-yaml | 4.0.3 + 4.1.1 | frontmatter |
| sentence-splitter | 5.x | sentence tier (= Claim Index), offsets |
| wink-nlp (+ model) | 2.x | negation/polarity router (Semantic-Collapse fix) |
| gpt-tokenizer | 3.x | `isWithinTokenLimit` early-exit |
| chonkie (chonkie-ts) | **pinned exact** | hierarchical chunker; offset contract test gates it |
| chokidar | 4.x | watcher |
| hono + @hono/node-server | 4.x / 2.x | daemon HTTP (socket + loopback) |
| proper-lockfile | latest | single-instance (+ socket-connect probe) |
| simple-git | latest | belief-drift pickaxe |
| graphology + -communities-louvain + -metrics | latest | Epistemic view (Louvain + bridgeness/PPR) |
| simple-statistics | latest | bootstrap CI + Brier; ISC |
| tsup | 8.x | ESM-only, target node22 |
| VectorChord / pgvectorscale / pg_search | — | **opt-in `PG_URL` disk/cluster tier ONLY** (AGPL server-only) |
| ~~embedded-postgres / mcp-proxy / @hf/transformers~~ | — | DROPPED (packaging / tunneling-dep / no bundled ML) |

**Algorithms built in `core/` (no dep):** RaBitQ + Extended-RaBitQ quantization, the binary→int8→f32 cascade, MUVERA FDE, FIRST single-token listwise extraction, signed belief-propagation + Reasoning Zones (Harary 2-coloring), Forward-Push PPR, GAR/RGS, DPP/facility-location, BOCPD, QBAF gradual semantics, CRAG evaluator, active-inference (EFE) scoring, the Compute-backend abstraction, DARTH early-termination, ADSampling.

## 1. The vector engine + store (`src/store/`, `core/compute/`) — OP quantized-graph, exact, scales to 1B

**One capability-probed `VectorIndex` interface, three backends:**
- **Core (all platforms) = `usearch` running a RaBitQ cascade.** Navigable graph over **1-bit RaBitQ codes** → oversample 3–5× → **int8 rescore** (~99% recall) → **exact f32 refine** on final k (recall 0.95–1.0, *exact* ranking). RaBitQ's theoretical error bound makes the 1-bit prune trustworthy; the f32 refine preserves exact search. usearch already gives mmap view-from-disk (4B+ via uint40), b1/i8/f16, SimSIMD kernels. **This is the search engine — usearch is no longer just the kNN-graph builder.** ~32× less RAM, ~40× faster scan; 130K–274K QPS @ ~99% recall (i8 *faster* than f32).
- **GPU tier (opt-in, auto-lit on NVIDIA) = `cuvs-node`** IVF-RaBitQ/CAGRA: 1.3–5.6× QPS @0.95 vs CAGRA, builds 7.7×; **build-on-GPU → convert to CPU usearch/HNSW graph → serve-on-CPU** (keeps instant restart). CUDA-only → not on Mac; the probe lights it only where present.
- **Disk tier (100M–1B, opt-in `PG_URL`) = VectorChord DiskANN** (server-only, AGPL): 1B/64GB/<3ms/95%. Plain usearch-mmap-DiskANN is the embeddable single-file path to ~1B.
- **Scale switch (measured):** binary-cascade ≤~10M (GPU/AMX-accelerated, exact) → usearch-DiskANN to 1B → cuvs on NVIDIA. **DARTH** declared-recall early-term (6.8×) + **ADSampling** (−90% dims) + **SPFresh** in-place updates (constant-latency, billion-scale). ⚠️ **binary needs ≥1024-dim** → degradation compiler defaults to int8-primary below. Brute-force = refine kernel + exact-filtered fallback (ACORN predicate traversal avoids the filtered-recall cliff).

**Compute backend (`core/compute/`) — the single biggest multiplier.** Hardware-probed accelerator behind one interface fronting (a) embed forward-pass, (b) index build, (c) batched distance/rescore. Probe order: macOS **Accelerate/AMX (in-OS, ~2× NEON sgemm) → Metal/MPS or WebGPU-Dawn → ANE/Core ML**; Linux/NVIDIA **cuVS/CAGRA**. Hardware `capability_card` mirrors the provider one. No accelerator → simsimd-CPU floor (strict superset). **Resident local embedder on ANE (~1ms vs ~800ms cloud)**, hedged-raced vs cloud. Embeddable, no Docker (Dawn prebuilt arm64; Accelerate/Core ML in-OS).

**Other store structures:** FTS5 `bm25()` (keyword); **LMDB** = CSR wikilink graph + Claim Index + **MV token-vector store** (1–2-bit residual-quantized, ~20–36 B/token, note+chunk tiers only, gated behind confidence escalation) + content-hash cache + labels. Hierarchical `chunks` rows carry `granularity ∈ {sentence,chunk,note}` + `parent_id`; sentence tier = Claim Index. Single writer; atomic note writes (temp+fsync+rename). Migrations: `index_meta` fingerprint; model swap → re-embed.

## 2. Parsing & representation (`src/index/`) — hierarchical + multi-vector

- **Stack:** `unified`+`remark-*`+`gray-matter` → mdast (JS parser stays — parse ≪ embed; wasm breaks byte-offset citations). **Wikilink tokenizer** = landakram micromark ext; **resolution** reimplemented in `core` (obsidian-export algo, BSD-2). **OFM delta** copied from Quartz `ofm.ts`. **NFC normalize** filenames + link text.
- **Hierarchical chunker:** sentence (`sentence-splitter`, = Claim Index) + chunk (`chonkie`, recursive, native offsets, OFM-zone-guard pre-pass, **offset contract test gates it**) + note tier. Target 512 tok, ~10–15% overlap; `gpt-tokenizer` `isWithinTokenLimit`. Contextual-chunk mode if the embedder supports it; deterministic BM25 blurb otherwise.
- **Multi-vector tier:** for note+chunk tiers, store ColBERT-style **token vectors** (1–2-bit residual quant). At query, **MUVERA FDE** collapses them to a single fixed-dim vector queryable on the same usearch MIPS scan → Chamfer/MaxSim rerank the shortlist. Storage gated behind confidence escalation.
- **Piscina** workers + **SharedArrayBuffer ring buffer** (zero-copy). kNN graph harvested from usearch (k≈8–16) → CSR in LMDB (shared with convergence). Dirty-span re-embed (content hash).

## 3. Provider registry (`src/providers/`) — model-agnostic; AI SDK chat/judge only

- **Interfaces** (`core`): `Embedding.embed(texts,{kind})`, `Reranker.rerank(query,cands,{topK,instruction?})` (instruction-following), `Judge`. `descriptor` discovered by probe.
- **Chat/judge → Vercel AI SDK v6** (`generateText`, `wrapLanguageModel` for retry/fallback/cascade; host-session judge = special non-SDK impl). **Embed+rerank → own ~150-LOC undici** (SDK rerank() = Cohere/Bedrock/Together-only; can't express contextual list-of-lists; V2→V3 churn). Voyage/Cohere/Jina rerank = same 6-field shape, one client.
- **Capability negotiation:** probe dims (embed a string → `.length`; not lookuppable from any OpenAI-compat endpoint), max-context (oversized→parse error), `/rerank` + contextual-shape + Matryoshka. Write `capability_card`; static cost data (LiteLLM+models.dev, vendored) = cold-start prior only.
- **Vault-grounded micro-benchmark router:** score the user's providers on ~30 Q→note pairs from their own vault (nDCG) → renewal-reward + LinUCB (`u/(1+τ/Lref)`). Per-space embed, per-call rerank, cascade judge. One mechanism = routing + fallback + offline + hedging.
- **Degradation compiler** (pure `core/` fn): no reranker → widen first-stage + DPP; short-context → shrink chunks; no contextual → flat + BM25 blurb; supports binary → enable binary tier; slow → smaller batches.
- **FIRST single-token listwise rerank** runs on the host-session judge (extract candidate-ID first-token logits in one forward pass = full ranking, no decode; 78.8 BEIR, beats RankZephyr); graceful-degrade to the undici pointwise reranker.

## 4. Retrieval pipeline (`core/retrieve/`) — two-speed reasoning retriever

```
0 PREFETCH   speculative embed+retrieve → RCU cache (slow-thinker, Claude-Code working set)  ~316×/hit
1 ROUTER     cached TF-IDF/SVM (no embed) → {α, expand?, MV?, rerank tier}                    ~0.1ms
2 LOOKUP LANE (zero-LLM):
    usearch RaBitQ-cascade scan ‖ FTS5 BM25 ‖ wikilink-CTE (speculative overlap)
    → CC/TMM fusion, ONLINE-learned weights (RRF cold-start)
    → CONFIDENCE GATE (free, self-warming from eval rerank-ablation labels)
       ├ HIGH → DPP coverage → adaptive-k → RETURN                                            ~5ms
       └ LOW  → REASONING LANE ↓
3 REASONING LANE (analytical / convergence / multi-hop):
    host-session CoT query decomposition (BRIGHT +12.2 nDCG; the judge is already there)
    → dense-seeded Forward-Push PPR over kNN+wikilink (HippoRAG-2-grade, hub-pruned)
    → MUVERA-FDE multi-vector shortlist → Chamfer/MaxSim rerank   (breaks the proven
      single-vector dimensional ceiling — DeepMind 2508.21038/LIMIT)                          ~10–20ms
    → FIRST single-token listwise rerank (host judge) / undici pointwise (instruction)
    → CRAG self-correction {sufficient | reformulate | fetch-the-bridge}
    → GAR/RGS frontier expansion (kNN + wikilink, weighted; L2G corpus-graph from logs)
    → DPP coverage → adaptive-k
4 cited hits { path#heading^block, snippet, score, why-retrieved, evidence-chain? }
```
- **No mandatory LLM in the lookup path**; reasoning-lane CoT/listwise reuse the host session (already paid for in an agentic loop), hidden behind prefetch/cache.
- **RCU double-buffered columnar lock-free cache** (SoA feeds simsimd/AMX) + **τ-bounded approximate result cache** + undici pre-warmed pools + p-queue backpressure.
- **Fold-later (A/B):** WARP MV-engine escalation (CPU 171ms, 3× PLAID), learned-sparse leg (lexical-heavy vaults only), full per-query dynamic α, Matryoshka funnel (coarse-dim shortlist → full-dim rescore; capability already probed).

## 5. MCP server (`src/server/`)

- SDK 1.29.x; `.js` import suffix; never `console.log` to stdout. **Shim = ~40-line self-bridge** (`StdioServerTransport` ↔ undici `{socketPath}` → daemon over the socket; autostart + reconnect; not `mcp-proxy`).
- Tools → `{content:[text], structuredContent}`; reads `readOnlyHint`, rename `destructiveHint`. New: `reason_over_vault`/`prove`, `find_bridges`, `what_if_i_drop`, `decision_ledger`/`recall_predictions`, `challenge_claim`, `sentinel_check` (opt-in), `accept_draft`.
- **Streaming notifications** (in-process fanout) for index progress + standing intelligence; synchronous query = request/response.
- Dry-run + confirm (writes): 2-call + `expectedHash` (TOCTOU). `instructions` ≤2 KB front-loaded. Output budget 10k/25k; paginate.

## 6. Intelligence (`core/sentinel/`, `core/reason/`) — signed belief-propagation

**Convergence/Bridge (headline, ships first):** kNN/claim graph → high-sim claim pairs across different Louvain communities, no existing edge → bridge candidates → **Bayesian-surprise** rank. Works because the MV tier supplies the conjunctive-query capability. FP-safe.

**Signed Belief-Propagation graph + Reasoning Zones (the Sentinel substrate):**
- Node `bᵢ∈[−1,1]`; edge `ωᵢⱼ` signed (wikilink graph + claim similarity). **Damped contractive operator → guaranteed unique fixed point** computes **credibility Ψ** (a-priori source trust per zone) + **confidence Φ** (emergent) — confidence emerges, killing the per-topic edge-weight/τ dials. **Reasoning Zones** = Harary-balanced subgraphs (signed 2-coloring, `O(n+m)`) where multi-hop inference is sound. Contradiction = an edit that breaks balance / spikes dissonance in a well-connected zone (structural surprise). Connectivity gate + balance + structural self-resolution (update vs contradiction) = three free FP gates. **Shock updates** adapt without oscillation. Sparse forward-push, µs, offline.
- Pipeline: Claim Index lookup → assertion pre-filter (deterministic, zero models) → **winkNLP negation/polarity router** (NegEx lexicon from `negspacy`; force polarity-reversed pairs, veto same-polarity look-alikes) → belief-propagation update → **Judge** (bias-hardened tool-result-as-judge, cascade) adjudicates survivors + sets edge signs → temporal reframe + **`supersedes` + bi-temporal validity edges** → confirm-and-learn (online τ; `pair_fingerprint` permanent suppression).
- **FP kill-criterion (HARD):** <1 false contradiction/50 edits on a real vault by end P1.5, else contradiction ships off; convergence always surfaces.

**Cited reasoning (`reason_over_vault`/`prove`):** LLM decomposes → BFS over the belief graph **within Reasoning Zones** → evidence chain with `path#heading^block` per hop → judge composes a cited answer, refusing to cross a flagged contradiction. <3s graph overhead (StepChain); LLM on-demand.

**Counterfactual surgery (`what_if_i_drop(X)`):** drop/reverse a claim → re-run forward-push → report lost-support beliefs, resolved contradictions, re-balanced zones (CFKGR/COULDD). One extra propagation run.

**Self-improving + proactive:** listwise-DPO/LinUCB from confirm/dismiss + citation signal (no GPU); self-edited procedural memory on idle. One **active-inference objective** (Bayesian surprise = expected free energy) ranks every proactive surface. **Sleep-time consolidation drafts the unwritten note** (dry-run → pull morning brief).

**Decision & Prediction Ledger:** forecast-claim detection (assertion filter + confidence/`resolves_when`) → resurface on outcome → per-topic **Brier** (`simple-statistics`). **Grounded Steelman:** reverse the cull + evidence-absence check. **Epistemic view:** QBAF gradual semantics (incremental) + dense-seeded hub-pruned PPR + Louvain.

## 7. Eval harness (`core/eval/`)

- Golden Q→note (seeds the router micro-benchmark) + a **LIMIT-style conjunctive negative set** (proves the MV tier earns its keep). Recall@k / MRR (`recip_rank`) / NDCG@10 — TS, validated vs `pytrec_eval` (1e-6). Don't add ranx/BEIR.
- A/B switchboard: `dense→+bm25→+CC-online-fusion→+PPR→+MUVERA→+FIRST→+CRAG` → failure-rate ladder; labels self-warm the confidence gate + train the online fusion weights.
- **Sentinel FP = primary** + kill-criterion + 8-category messy negative set. Convergence precision + Decision-Ledger Brier + reasoning-chain faithfulness = secondary. RAGAS reimpl on the Judge (autoevals MIT prompts). **promptfoo rejected** (84 deps + 2nd better-sqlite3). CI smoke-eval on a fixture vault.

## 8. Packaging / offline / distribution

- pnpm `11.0.7` frozen; catalog; committed lockfile. Air-gap: `pnpm fetch`→`rm -rf node_modules`→`--offline --frozen-lockfile`; `supportedArchitectures`.
- **Native deps (lean-but-OP):** `better-sqlite3`/`sqlite-vec`, `usearch`, `lmdb`, `simsimd`, the Compute backend (WebGPU-Dawn prebuilt arm64; Accelerate/Core ML in-OS; **cuvs-node only on NVIDIA boxes**). All prebuilt; **no embedded-Postgres, no pgvector pipeline**.
- **CI gate:** x64 fetch → arm64 offline install from cold store + registry blackhole + native-load smoke (all native deps).
- **MCPB (primary):** manifest v0.3; `user_config` keys `sensitive`→env; flat `npm install --production`; build natives against Node 22; one `.mcpb`/platform. Lean (no weights). `.gitignore` (`*.db*`,`.env`,`*.mcpb`), MIT, README (per-provider privacy + local-first default). **No AI/Claude attribution anywhere.** tsup ESM-only target node22.

## 9. P0 risk-retirement spikes

1. **Capability-probe + registry round-trip** (one cloud API + one OpenAI-compat local; dims/contextual/rerank sniff).
2. **RaBitQ-cascade latency + recall** at 1M/10M via usearch (binary→int8→f32 refine); confirm exact-quality + the scale switch points.
3. **Compute backend** — CPU floor + one accelerator (Metal/ANE on the Mac); confirm WebGPU-Dawn loads + resident-embedder warm path (~1ms).
4. **binary-needs-≥1024-dim** degradation behavior.
5. **Belief-propagation FP** on a real messy vault vs the kill-criterion (assertion filter + negation router + balance gate, before the judge).
6. **MUVERA-FDE recall** on the LIMIT-style set (does FDE suffice, or is WARP needed?).
7. **chonkie-ts offset contract test**; **pnpm air-gap** cross-arch with all native deps.

## 10. Version landmines

- pnpm `packageManager` self-bump (#11808) → freeze the pin.
- `better-sqlite3` ABI mismatch (MCPB #180); build against Node 22.
- chokidar v4 dropped globs/rename → watch dir, hash-cache.
- AI SDK V2→V3 churn breaks community embedding providers (#14425/#12009) → embed+rerank are own-undici.
- cuvs-node = CUDA-only → guard behind the hardware probe (never required on Mac).
- chonkie-ts v0.0.x not at parity → pin exact + contract test.
- MCP sampling/elicitation minority-supported → tool-result-judge + 2-call-confirm.
- `mcp-proxy` npm pulls a tunneling SaaS dep → self-bridge.

## 11. Assembly plan (reuse map)

**License: only MIT/Apache/ISC/BSD in "take"; AGPL/no-compete = STUDY-ONLY.**

### npm-depend
| Need | Package | License |
|---|---|---|
| Vector ENGINE (core) | `usearch` (RaBitQ cascade, mmap, SimSIMD) | Apache |
| GPU tier (opt-in, NVIDIA) | `cuvs-node` | Apache |
| Disk tier (opt-in `PG_URL`) | VectorChord / pgvectorscale | AGPL (server-only) |
| SIMD distance | `simsimd` | Apache |
| Metadata + FTS | `better-sqlite3` + `sqlite-vec` | MIT/Apache |
| Graph/claims/MV/cache | `lmdb` | MIT |
| Compute backend (Metal) | WebGPU-via-Dawn (`webgpu`/`kmamal/gpu`); Accelerate/Core ML in-OS | MIT/OS |
| Chat/judge | Vercel AI SDK + `@openrouter/ai-sdk-provider` | Apache/MIT |
| Embed/rerank | **own ~150-LOC undici** | — |
| Markdown→mdast | `unified`+`remark-*`+`gray-matter` | MIT |
| Wikilink tokenizer | landakram micromark/mdast ext | MIT |
| Sentence/Claim tier | `sentence-splitter` | MIT |
| Negation router | `wink-nlp` | MIT |
| Token budget | `gpt-tokenizer` | MIT |
| Chunker | `chonkie` (pinned + contract test) | MIT |
| Git drift | `simple-git` | MIT |
| Stats/Brier | `simple-statistics` | ISC |
| Watcher | `chokidar` | MIT |
| Clustering + centrality | `graphology` + `-communities-louvain` + `-metrics` | MIT |
| Daemon HTTP | `hono` + `@hono/node-server` | MIT |
| Single-instance | `proper-lockfile` (+ socket probe) | MIT |
| MCPB (devDep) | `@anthropic-ai/mcpb` | MIT |
| Plugin scaffold | `obsidian-sample-plugin` | MIT |

### Vendor
- `cyanheads/obsidian-mcp-server` (Apache) → `section-extractor.ts` + `frontmatter-ops.ts` (edit brain).

### Copy-pattern (code/SQL/prompts; permissive)
- Quartz `ofm.ts` (MIT) → OFM delta. obsidian-export (BSD-2) → wikilink resolution. autoevals `js/ragas.ts` (MIT) → RAGAS prompts. ragas `TestsetGenerator` (Apache) → golden-gen taxonomy. `negspacy` (MIT) → NegEx cue lexicon.

### Build fresh = the moat (papers → reimplement in `core`)
RaBitQ + Extended-RaBitQ cascade, **MUVERA FDE**, **FIRST** listwise extraction, **signed belief-propagation + Reasoning Zones** (the uncopyable substrate — edges from wikilink graph + Claim Index + cached verdicts in one store), **Forward-Push PPR**, GAR/RGS (+ L2G), DPP coverage, **CRAG** self-correction, BOCPD, QBAF, **active-inference (EFE)** scoring, counterfactual surgery, the **Compute backend** abstraction, DARTH + ADSampling, the Decision Ledger, sleep-time consolidation/note-drafting, self-improving DPO + procedural memory, the eval harness shell.

### Wrap-subprocess (dev/CI only)
`pytrec_eval` (MIT) oracle; `ragas` (Apache, Python) ±0.05 cross-check.

### STUDY-ONLY (AGPL/no-compete/Python — ideas not code)
`basic-memory`/`khoj`/`Reor` (AGPL), `smart-connections` (no-compete), **Letta** (sleep-time compute idea), **HippoRAG 2 / G-reasoner** (PPR + cross-source life-graph ideas), InfraNodus (topic-gap → we do claim-level), `remark-obsidian` (GPL — banned).

**Net:** plumbing + parsing + edit brain + packaging ~80% **assembled from MIT/Apache/ISC/BSD**; the reasoning brain + the belief engine are bespoke (the moat) and are exactly what makes VaultNexus OP — quantized-graph + multi-vector retrieval past the proven single-vector ceiling, a convergent belief graph powering convergence + cited reasoning + counterfactual surgery, and a system that gets smarter on your vault with use.
