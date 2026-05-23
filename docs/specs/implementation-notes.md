# VaultNexus — Implementation Notes (build bible, v3.0)

Distilled from 8 implementation-research agents + a 10-agent best-of-breed validation wave + a 10-agent "think-different / model-agnostic" relaunch (2026-05-23). Companion to `2026-05-23-vaultnexus-design.md` (the design; this is the *how*). Build-ready: pinned versions, exact APIs, gotchas, P0 risks.

> Convention: pin every version; track no `latest`. Quoted error strings / ids / issue numbers are verbatim.
> **Models are AGNOSTIC.** The 3-category registry (embed / rerank / judge) is the contract; vendor names below are *example adapters*, never defaults baked into the build.

## 0. Pinned versions (one source of truth → pnpm catalog)

| Dep | Version | Note |
|---|---|---|
| node | **>=22** (`.nvmrc=22`) | matches Claude Desktop's bundled Node (ABI 127) |
| pnpm | **11.0.7** (frozen) | offline-fetch regressions; freeze one patch for the whole air-gap cycle |
| **better-sqlite3** | 12.x (≥12.10.0) | DEFAULT store driver; FTS5 `bm25()` built-in; ABI-bound native `.node` |
| **sqlite-vec** | 0.1.9 | loadable ext; vectors live here; brute-force scan (we don't need its ANN) |
| **vectorlite** | latest | optional: hnswlib-in-SQLite (SIMD, persisted) if a graph index is ever wanted |
| **lmdb** (Doerr) | 3.x | CSR wikilink graph + Claim Index + content-hash cache + labels; ACID, ~500K writes/s, mmap |
| **usearch** | 2.x | kNN *adjacency* graph (built at index time, k≈8–16) + mmap-HNSW scale tier; Apache, N-API prebuilts |
| **simsimd** | latest | SIMD distance (cosine/dot f32/int8 + **Hamming popcount** for binary brute-force); NAPI zero-copy |
| undici / p-queue / Piscina | latest / 8.x / 4.x | HTTP pools / API governor / worker pool (+ SharedArrayBuffer ring buffer) |
| **ai** (Vercel AI SDK v6) + `@ai-sdk/*` | 6.x | **chat/judge role ONLY** (see §3); embed+rerank are own-undici |
| @modelcontextprotocol/sdk | ≥1.24.0 (1.29.x ok) | self-bridge transports + streaming notifications |
| zod | 4.x | SDK accepts v3/v4/Standard-Schema |
| unified / remark-parse / remark-gfm / remark-frontmatter | 11 / 11 / 4 / 5 | mdast pipeline |
| gray-matter + js-yaml | 4.0.3 + 4.1.1 | frontmatter |
| sentence-splitter | 5.x | hierarchical sentence tier (= Claim Index); preserves offsets |
| **wink-nlp** + model | 2.x | negation/polarity router (pure-TS, 650k tok/s) — Sentinel "Semantic Collapse" fix |
| gpt-tokenizer | 3.x (`o200k_base`) | chunk-size proxy; use `isWithinTokenLimit` early-exit |
| chonkie (chonkie-ts) | **pinned exact** | hierarchical chunker; ⚠️ v0.0.x "not at parity" → offset contract test gates adoption |
| chokidar | 4.x | watcher; v4 dropped globs+rename → watch dir, filter in code |
| hono + @hono/node-server | 4.x / 2.x | daemon HTTP (Unix socket + loopback) |
| proper-lockfile | latest | single-instance heartbeat (+ socket-connect probe) |
| simple-git | latest | belief-drift pickaxe (`log -G`) |
| graphology + graphology-communities-louvain + graphology-metrics | latest | Epistemic view (Louvain + bridgeness/PPR) |
| simple-statistics | latest | bootstrap CI + Brier; ISC |
| tsup | 8.x | ESM-only, `target node22`, native deps external |
| Postgres / pgvector / pgvectorscale / pg_search | — | **opt-in `PG_URL` tier ONLY** (no longer the default; AGPL exts = server-only) |
| ~~embedded-postgres~~ | — | **DROPPED as default** (packaging minefield; lean store replaces it) |
| ~~mcp-proxy~~ | — | **DROPPED** (npm pkg pulls a `pipenet` tunneling SaaS dep) → ~40-line self-bridge |
| ~~@huggingface/transformers / onnxruntime~~ | — | no *bundled* local ML; the user may register their own local model (runs in daemon) |

## 1. Storage engine (`src/store/`) — lean embedded default; Postgres opt-in

The relaunch reversed Postgres-default. At ≤1M chunks a single-user/single-writer tool does not need an RDBMS or an ANN index.

- **DEFAULT `SqliteStore` (lean, install-nothing, no Docker, smallest air-gap bundle):**
  - **Driver `better-sqlite3`** (sync, FTS5). Pragmas per connection: `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=5000`.
  - **Vectors `sqlite-vec`** stored as **binary codes** (`bit`) + a quantized rescore lane (int8/f16). **Search = `simsimd` brute-force Hamming popcount** over the binary codes → rescore top-N with int8/f16. **No ANN index** — ~1ms across 8 cores / ~9ms single-core / ~128MB RAM at 1M×1024-dim, *beating* HNSW (5–8ms) with zero build time, zero index corruption, instant mmap restart, and **exact filtered search** (predicate on the scan — sidesteps the pgvector iterative-scan + filtered-ANN-recall-cliff problem). `vectorlite` available if a persisted graph index is ever wanted.
  - **kNN adjacency graph (`usearch`)** built once at index time (k≈8–16), stored as CSR — this is the **GAR/RGS expansion graph AND the convergence/bridge edge set** (shared infra, §6).
  - **BM25/FTS = FTS5 `bm25()`** (real BM25 — better-ranked than Postgres `ts_rank`).
  - **Graph + claims + cache = `lmdb`:** CSR wikilink adjacency, the Claim Index, content-hash→embedding cache, dismissal/`supersedes` labels. Single writer (the indexer); lock-free parallel readers.
  - **Hierarchical index:** `chunks` rows carry a `granularity ∈ {sentence,chunk,note}` field + `parent_id`; one flat vec0 table discriminated by `granularity` (RAPTOR collapsed-tree style). The **sentence tier IS the Claim Index** (`vec_claims` collapses into it).
  - **Schema:** `index_meta`(embedding fingerprint/`spaceId`), `notes`, `chunks`(+granularity,parent_id), `vec_chunks` (binary + rescore lanes), `fts_chunks` (FTS5 external-content + 3 sync triggers), `links` + CSR in LMDB, `claims` (= sentence tier), soft-delete via `state`(active/superseded/retracted)+`superseded_by`.
- **Hybrid fusion** = **convex-combination + theoretical-min-max norm, IDF-adaptive α** (RRF k=60 cold-start fallback); pool → confidence gate → GAR/RGS (§4). Port Alex-Garcia's RRF CTE as the cold-start path.
- **Wikilink expansion** = the 1-hop recursive CTE / CSR lookup, but repurposed as a **frontier neighbor-source inside the GAR loop** (§4), not a one-shot pre-rerank step.
- **Concurrency:** single writer by topology; WAL many-readers; heartbeat lockfile + socket-connect probe. Atomic note writes = temp + `fsync` + `rename`.
- **Migrations:** `PRAGMA user_version` ladder + `index_meta` fingerprint. dims/dtype change → drop+recreate vec0 + re-embed. Content-hash cache keyed by model → model swap auto-invalidates.

- **Overkill tier (opt-in `PG_URL`, Linux, no Docker required):** your own Postgres + **pgvectorscale** (StreamingDiskANN) + **pg_search**/**VectorChord** (real BM25 + RaBitQ) for tens-of-millions. Daemon detects extensions → lights up the DiskANN/Tantivy paths. ⚠️ AGPL/Elastic → separate server, never bundle.

- **⚠️ Packaging note:** the lean default's native deps are `better-sqlite3` + `sqlite-vec` + `lmdb` + `usearch` + `simsimd` — all ship prebuilt binaries. This **deletes the v2.2 #1 risk** (embedded-Postgres + a hand-built cross-platform pgvector pipeline).

## 2. Parsing & chunking (`src/index/`) — hierarchical, offset-faithful

- **Stack:** `unified` + `remark-parse` + `remark-gfm` + `remark-frontmatter(['yaml'])` → mdast. Keep frontmatter in the string so `position.offset` stays true; `gray-matter`(+`js-yaml`) for typed values. (JS parser stays — parse is 5–25ms/note vs 100–300ms embed; wasm parsers either lack JS bindings (markdown-rs) or emit line:col not byte offsets (comrak-wasm) → break citations.)
- **⚠️ DIY wikilink resolution.** `micromark-extension-wiki-link`+`mdast-util-wiki-link` (landakram, MIT) as **tokenizer only**; resolution algorithm reimplemented in `core` (copied from obsidian-export, BSD-2). `remark-obsidian` GPL → banned.
- **OFM extras:** copy only the **DELTA** from Quartz `ofm.ts` (MIT) — `^block-id`, callout `[!type]`, `%%comment%%` (no npm ships block-refs).
- **⚠️ NFC normalization mandatory** on filenames + link text (macOS NFD → silent unresolved). Key = `lower(NFC(name)).replace(/[\s_-]+/g,' ').trim()`.
- **Hierarchical chunker (the representation reversal):** index **three granularities** — sentence, chunk, note — in one store, retrieve precise / return parent ("small-to-big"). Flat 512-tok-only is the weakest link (467% precision swing with chunk size; Chroma). 
  - **Chunk tier:** `chonkie` (chonkie-ts) recursive packing + native `startIndex`/`endIndex`. Feed custom `RecursiveLevel.delimiters` (markdown recipe is Python-only). Target 512 tok (min 256), ~10–15% overlap. **OFM-zone-guard pre-pass** (~50 LOC): emit code fences/tables/callouts atomic before chonkie (it does NOT guarantee code/table integrity). **⚠️ chonkie-ts is v0.0.x "not at parity" → a contract test (`source.slice(start,end)===chunk.text` over code/table/callout fixtures) GATES adoption.**
  - **Sentence tier (= Claim Index):** `sentence-splitter` per-leaf-block on `mdast-util-to-string` + `block.position.start.offset` → exact offsets → `path#heading^block`. Skip code/tables/quotes.
  - **Note tier:** one vector per note for analytical/whole-vault queries.
  - Contextual-chunk embeddings (whole-note context at index time) used **if the registered embedder supports it** (capability-probed) — else plain per-chunk; deterministic BM25 blurb (`title — header-path — tags — linked-titles`) is the model-free contextual-BM25.
- **Token budget** via `gpt-tokenizer` o200k `isWithinTokenLimit(text, 512)` (O(limit) early-exit, not full `encode().length`).
- **Throughput:** parse+chunk+sentence-split run in `Piscina` workers with a **SharedArrayBuffer ring buffer** thread→thread (zero-copy source/offset buffers).
- **kNN graph build:** after embedding, harvest the usearch neighbor lists (k≈8–16) → CSR in LMDB (shared with convergence).
- **Link graph:** forward-links → CSR; backlinks = inversion. Tag rows `source='parser'|'canonical'` — never merge. Incremental: dirty-span re-embed (only changed chunks via content hash).

## 3. Provider registry (`src/providers/`) — model-AGNOSTIC; AI SDK for chat/judge only

The AI-SDK-for-all-roles premise cracked: `rerank()` is Cohere/Bedrock/Together-only (no public rerank spec), and `embedMany()`'s flat-`string[]` contract can't express contextual list-of-lists embed; the V2→V3 churn breaks community embedding providers. So:

- **Interfaces** (`core`): `EmbeddingProvider.embed(texts,{kind})→{vectors,descriptor}`, `Reranker.rerank(query,cands,{topK,instruction?})`, `Judge`. `descriptor{providerId,modelId,dims,dtype,spaceId,normalized}` discovered by probe (below).
- **Chat / judge role → Vercel AI SDK v6** (`generateText`, `wrapLanguageModel` middleware for retry/fallback/cascade). Its one genuinely polyglot, low-churn surface; covers OpenAI/Google/Anthropic/local via `@ai-sdk/openai-compatible` + OpenRouter via `@openrouter/ai-sdk-provider` (OpenRouter now does embeddings too, but we don't route embed through it). Host-session judge = a special non-AI-SDK `Judge` impl (tool-result-as-judge).
- **Embed + rerank roles → own ~150-LOC undici clients** over the daemon's pre-warmed pools: one generic OpenAI-compat embed/chat client, one contextual-embed client (list-of-lists shape for embedders that support it), one generic rerank client (Voyage/Cohere/Jina rerank are the same 6-field `{query,documents,top_n}`→`[{index,relevance_score}]` shape). Zero SDK indirection; nothing in the air-gap bundle for these roles but our code. Long-tail rerankers = the same client with a base-URL.
- **Capability negotiation (replaces the static metadata table as the oracle):** at registration, probe each endpoint —
  - embed one string → `response.data[0].embedding.length` = ground-truth **dims** (no OpenAI-compat endpoint exposes this; vLLM closed the request "not planned"). vec0 column sized from this at index time.
  - oversized request → parse the error for **max-context / batch limits**.
  - sniff `/rerank`; test `output_dimension:256` for **Matryoshka** truncatability (auto-enables the coarse-scan tier); test the contextual list-of-lists shape.
  - Write a `capability_card` keyed by `{baseURL,modelId}` hash; re-validate on `index_meta` mismatch (provider silently swapped → catch before corrupting the index). Static cost data (LiteLLM `model_prices_and_context_window.json` + `models.dev/api.json`, vendored) demoted to **cost hint + cold-start prior**.
- **Vault-grounded micro-benchmark router:** carve ~30 Q→note pairs from the user's own vault (the eval golden set), score every registered embedder/reranker by **nDCG on this vault**, feed as the quality prior `u` into a renewal-reward + LinUCB router (`u/(1+τ/Lref)`, τ = live latency EMA). Scope: **embedder per-space** (index+query must match), **reranker per-call**, **judge cascade** (cheap→frontier on low confidence). One mechanism = routing + fallback + offline + hedging.
- **Degradation compiler** (pure `core/` fn, `capability_card → pipeline params`): no reranker → widen first-stage + lean on DPP; short-context embedder → shrink chunk target; no contextual mode → flat embed + BM25 blurb; slow provider → smaller batches/lower concurrency; supports binary dtype → enable the binary tier. Any registry config "just works."
- **Resident local embedder option (the biggest latency win):** the user may register a local embedder (Ollama/LM-Studio/TEI/ONNX) the daemon keeps **warm and resident** (~10ms CPU / <100ms Apple-Silicon vs ~800ms cloud), optionally **hedged-raced** against a cloud embedder. We bundle no weights; it's the user's model running in the daemon (never Obsidian). Also used for the Sentinel cull + cache pre-warm (internal vectors, never compared against the main index → per-task routing safe).
- **Dims model-driven; Matryoshka `reduce_dims`** = truncate stored vectors + L2-renorm locally, no re-embed. Storage ladder @1024: bit ~128B → int8 1KB → f16 2KB.
- **Privacy:** with a cloud registry, note text leaves at index/query; with a local registry, nothing leaves. Local-first is the **privacy default** for the Obsidian crowd; cloud is the max-quality opt-in. State per provider in the README.

## 4. Retrieval pipeline (`core/retrieve/`) — adaptive cascade

Reversed from a fixed funnel. ~95–99% of hot-path latency is the embedding network round-trip; the cascade + prefetch attack that, not local compute.

```
query
 → ROUTER (cached TF-IDF/SVM + heuristics, ~0.1ms, NO embed call) → α-prior, expand?, rerank-disposition
 → FIRST STAGE (speculative overlap): embed(query) ‖ BM25 ‖ wikilink-CTE
     → CC + theoretical-min-max fusion (IDF-adaptive α; RRF k=60 cold-start)
 → CONFIDENCE GATE (free: top1−top2 gap, lexical∩semantic, entropy; self-warming from eval rerank-ablation labels)
     ├─ HIGH → EARLY EXIT: DPP/facility-location coverage select → adaptive-k → return   (no rerank)
     └─ LOW  → GAR/RGS adaptive expansion: rerank a batch → add kNN + wikilink neighbors of
               cross-encoder-confirmed notes → rerank → repeat (WITHIN the rerank budget)
               → DPP coverage → adaptive-k (largest-gap) → return
 → cited hits { path#heading^block, snippet, score, why-retrieved }
```
- **GAR/RGS** (MacAvaney CIKM'22 / arXiv 2509.07163): traverse the usearch kNN graph (+ wikilink edges, weighted higher) around reranker-confirmed notes → +8–20% NDCG at ~0 added cost (same rerank budget spent smarter; finds the note ranked ~2800th by embedding). Co-citation weighting (cheap `links` self-join) as an extra edge signal.
- **DPP/facility-location coverage** replaces MMR (same SIMD cost, principled relevance×coverage — a vault is a coverage instrument).
- **Confidence gate** self-warms from the A/B switchboard's existing `+rerank` vs no-rerank labels (model-free, online) — early-exits ~50–60% of queries past the reranker.
- **Predictive "slow-thinker" prefetch:** the daemon watches the Claude Code session working set (open files, recent edits, `Stop`-hook stream) and **pre-embeds + pre-retrieves the agent's likely next query into the RCU cache before it's asked** (~316× on a hit; erases the p90/p99 embed tail; FP-safe). Plus τ-bounded approximate result-cache reuse (near-100% recall within a similarity tolerance).
- **RCU double-buffered, columnar, lock-free hot cache:** readers hit an immutable snapshot; the watcher swaps in the rebuilt version on the debounce tick. Columnar Structure-of-Arrays feeds simsimd. (Document that pgvector-HNSW isn't snapshot-stable under concurrent insert — moot for the lean store, relevant only in the `PG_URL` tier.)
- **Auto mode-switch:** small/cheap-enough vault → stuff whole vault into context (prompt caching) — a first-class path.
- **Fold-later (A/B switchboard):** per-query dynamic α classifier, online-learned fusion weights, an optional ColBERT tier on the `PG_URL` backend.

## 5. MCP server (`src/server/`)

- **SDK 1.29.x.** Imports need `.js` suffix. `new McpServer({name,version},{instructions, capabilities:{resources:{listChanged:true}}})`. **Never `console.log` to stdout** → stderr / `sendLoggingMessage`.
- **Shim = ~40-line self-bridge** (not `mcp-proxy`): SDK `StdioServerTransport` ↔ an undici client with `{ socketPath }` → forwards JSON-RPC to the daemon **over the Unix socket** (Claude Code stays on the zero-network path). Owns autostart + reconnect.
- **Tools:** `registerTool(...)` → `{content:[text], structuredContent:out}`. Reads `readOnlyHint:true, openWorldHint:false`; writes `readOnlyHint:false`; rename `destructiveHint:true`. New tools: `find_bridges` (convergence, headline), `decision_ledger`/`recall_predictions`, `challenge_claim` (steelman), `sentinel_check` (opt-in).
- **Streaming notifications** (Streamable-HTTP / in-process fanout) for index progress + standing-intelligence findings; the synchronous query stays request/response.
- **Dry-run + confirm (writes):** 2-call + `expectedHash` (TOCTOU). confirm=false → diff/preview/brokenLinks/expectedHash; confirm=true → re-check, atomic write.
- **Resources:** `note://{path}` (+`complete`) + `vault://index`; `sendResourceListChanged()` on chokidar add/unlink.
- **`instructions` ≤2 KB** front-loaded (Claude Code defers tools via Tool Search). **Output budget:** 10k warn / 25k cap; paginate; snippets not bodies.

## 6. Convergence + Sentinel + Epistemic Integrity (`core/sentinel/`)

**Convergence/Bridge (headline, FP-safe, ships FIRST):** over the kNN/claim graph, for each high-similarity claim pair whose endpoints sit in **different** Louvain communities with **no existing edge** → bridge candidate; rank by **Bayesian surprise** (KL of the vault's belief distribution before/after — only surface bridges that *move* your thinking). Claim-level epistemic bridging (distinct from InfraNodus topic-level holes). A wrong bridge costs nothing → ships before contradiction FP is tamed.

**Contradiction (opt-in, pull-only, FP-gated) — Belief-State Energy Model:**
- **Substrate:** topic = a belief network; node `bᵢ∈[−1,1]` = a settled stance; edge `ωᵢⱼ` = signed relatedness from the **wikilink graph + claim similarity** (sign cached from the judge). Dissonance `Hᵢ = Σⱼ ωᵢⱼ|bᵢ−bⱼ|`. A contradiction = an edit that **spikes ΔH of a tightly-bound cluster** (structural surprise, not pairwise similarity). FP gates fall out free: **connectivity gate** (weakly-tied claims can't alarm → kills the daily-note-one-liner FP class), **ΔH-magnitude threshold** (single τ dial), **structural self-resolution** (network prefers to flip the old belief → it's an *update*, detected before any LLM call). Sparse mat-vec over a per-topic neighborhood (graphology adjacency + simsimd dot) → µs, offline.
- **Pipeline:** Claim Index lookup (sentence tier) → **assertion pre-filter** (deterministic, ZERO models: first-person + assertive + settled; drop questions/quotes/hedged/zones) → **winkNLP negation/polarity router** (force polarity-reversed pairs forward, veto same-polarity look-alikes — fixes "Semantic Collapse"; dense MRR on contradiction is ~0.023, lexical negation is the only viable fix; port `negspacy` NegEx cues to a TS lexicon) → belief-energy ΔH gate → **Judge** (bias-hardened tool-result-as-judge, order-blinded + timestamp-blinded; cascade cheap→frontier) adjudicates survivors and **sets edge signs** (closing the loop) → temporal reframe (deterministic, on `asserted_at`).
- **Temporal:** record a user-confirmed **`supersedes` edge** on "it's-an-update" (the confirm-loop already collects this — capture it as a deterministic typed edge; retrieval down-ranks superseded claims; belief-drift becomes instant). Drift detection via **BOCPD** change-point on per-topic stance trajectories (single hazard knob λ; narrate only confirmed, dated mind-changes; shrinking-variance = convergence-over-time).
- **Confirm-and-learn (3-tier suppression + online τ-calibration):** exact-pair (permanent, `pair_fingerprint`) → embedding-neighborhood (`SUPPRESS_RADIUS=0.90`) → per-topic (re-fit `JUDGE_EMIT_MIN`/τ after N≥3 dismissals, decays). Checked **before** Judge compute.
- **`ClaimRecord`:** raw+canonical, polarity, topic_key, `asserted_at` vs `observed_at`, source_zone, `state`(active/superseded/retracted)+`superseded_by`, `content_hash`+`filter_version`.
- **Judge = tool-result-as-judge** (default, zero-key): `sentinel_check` returns candidates as `structuredContent` + a `VERDICT_RUBRIC` ({CONTRADICTION,UPDATE,NOT_CONTRADICTION,PARAPHRASE}); `resolve_sentinel{id,verdict}` writes the label + edge sign + supersedes edge. Optional local fact-verifier as a drop-in `Judge` for users who run one.
- **FP kill-criterion (HARD):** if FP can't beat a stated threshold (e.g. <1 false contradiction per 50 edits) on a real messy vault by end of P1.5, contradiction ships **off by default**; only convergence is surfaced. (REFNLI: >80% false-contradiction under context-mismatch; frontier judges cap ~80% — precision must come from the filter + energy gate, not the judge.)

**Decision & Prediction Ledger (build-first new feature):** detect forecast-claims (reuse the assertion filter + a confidence/`resolves_when` pattern), resurface on outcome-date/topic (cosine + date math, no LLM), compute per-topic **Brier score / calibration curve** (`simple-statistics`); judge narrates on demand. Makes the vault improve the user's judgment.

**Grounded Steelman:** `challenge_claim` reverses the contradiction cull (instruction: "rank by likelihood of contradicting/reversing this stance") + an evidence-absence check (claim has no supporting neighbor above the floor); judge writes the strongest counter-case grounded in the user's own vault; remembers what it challenged.

**Epistemic Integrity view (P2 batch):** least-stable beliefs via **QBAF gradual semantics** (handles reinstatement; ~30-LOC monotone fixpoint — skip the pedagogic `arguegraph` lib); connector notes via **dense-seeded, hub-pruned PPR** importance (top-1% hub prune costs −0.002 recall, −16–28% latency) instead of plain betweenness; Louvain clusters via `graphology-communities-louvain` (sub-100ms at sparse scale; no native binary).

**Sleep-time consolidation (P2, the moonshot):** on idle cycles, walk recently-changed clusters, pre-compute the convergence/contradiction/energy graph, synthesize a pull-based **morning brief** (Bayesian-surprise-ranked) the user opens — never a push.

## 7. Eval harness (`core/eval/`, `src/eval/`)

- **Golden Q→note** (also seeds the provider micro-benchmark): LLM reads a chunk → generates an answerable question; source = gold. Anti-leakage rules; 25 bootstrap → 100 proof; JSON keyed by vault-hash.
- **IR metrics:** Recall@k, **MRR** (surfaces as `recip_rank`), **NDCG@10** — hand-rolled TS, validated once against **`pytrec_eval`** (dev subprocess; matching it within 1e-6 = BEIR-comparable). Don't add ranx/ir-measures/BEIR.
- **A/B switchboard:** `dense → +bm25 → +CC-fusion → +GAR-expand → +DPP → +rerank` via a `RetrievalConfig` toggle → failure-rate ladder; **its `+rerank` labels self-warm the confidence gate**. Bootstrap CI + paired permutation test on `simple-statistics` (~40 LOC).
- **Sentinel FP (PRIMARY) + kill-criterion:** "messy notes" negative set across 8 categories (quoted/question/hypothetical/hedged/paraphrase/negation-overlap/temporal-update/different-subject); per-vault calibration sweep of τ × assertion-mode × `JUDGE_EMIT_MIN`. Demo gate.
- **Convergence/Bridge precision** + **Decision-Ledger calibration (Brier)** = secondary metrics.
- **RAGAS** (faithfulness/context-precision): TS reimpl on the Judge+Embedding (copy autoevals MIT prompts), ±0.05 cross-check vs Python `ragas` once. **promptfoo rejected** (84 deps + a 2nd better-sqlite3 = ABI poison).
- **Reproducibility:** per-run manifest = active graph source + every model-id + golden hash + seed. CI smoke-eval on a 12-note fixture + stub embedder.

## 8. Packaging / offline / distribution

- **pnpm `11.0.7` frozen**; catalog; committed lockfile. **Air-gap install:** `pnpm fetch` → `rm -rf node_modules` → `pnpm install --offline --frozen-lockfile`; `supportedArchitectures` for all platform binaries.
- **Native deps (lean):** `better-sqlite3` (⚠️ ABI-bound — build against Node 22 ABI 127), `sqlite-vec` (ABI-agnostic loadable ext), `lmdb`, `usearch`, `simsimd` — all prebuilt. **No embedded-Postgres, no pgvector pipeline** (risk deleted).
- **CI gate:** x64 `fetch` → arm64 `install --offline` from cold store + registry blackhole + native-load smoke test (all five native deps).
- **MCPB (primary):** manifest v0.3; `user_config` (vault_path, provider keys `sensitive` → env); flat `npm install --production` tree; build native deps against Node 22; one `.mcpb` per platform. Lean (no model weights). `npx` = online convenience.
- **Repo:** `.gitignore` (`*.db*`, `.env`, `*.mcpb`, model caches), MIT LICENSE, README (quickstart + per-provider privacy note + local-first default), `.nvmrc=22`, `engine-strict`. **No AI/Claude attribution anywhere.**
- **Build: tsup** ESM-only, `target node22`, entries `cli`+`server`, native deps `external`.

## 9. P0 risk-retirement spikes (do FIRST)

1. **Provider capability-probe + round-trip** — register one cloud API + one OpenAI-compat local; confirm dims-probe, contextual-shape sniff, rerank sniff, and a clean round-trip via the registry.
2. **Binary brute-force latency at scale** — benchmark a hybrid query (simsimd Hamming + rescore) at 50k/100k/250k/1M chunks; confirm interactive; set the int8/binary/usearch-graph crossover.
3. **Resident-local-embedder warm path** — measure warm latency on the target hardware; decide local-default-vs-cloud-default + the hedged-race trigger.
4. **chonkie-ts offset contract test** — `source.slice(start,end)===chunk.text` over code/table/callout fixtures; gates the chunker dep.
5. **Belief-energy FP** — on a real messy vault, measure the FP rate of the ΔH gate + assertion filter + negation router (before the judge) against the kill-criterion.
6. **pnpm air-gap** cross-arch cold-store install with all five native deps (the CI gate).
7. **better-sqlite3 + sqlite-vec + lmdb + usearch + simsimd** load on the target platform/Node 22; confirm the `.mcpb` ABI path.

## 10. Version landmines (watch list)

- pnpm self-upgrade bumps `packageManager` → warm store can't resolve (#11808) → **freeze the pin**.
- `better-sqlite3` `NODE_MODULE_VERSION` mismatch if bundle Node ≠ host (MCPB #180).
- chokidar v4 dropped globs + rename → watch dir, filter `.md`, treat rename as unlink+add (hash-cache makes it cheap).
- Vercel AI SDK V2→V3 provider-spec churn breaks community embedding providers (#14425/#12009) — another reason embed+rerank are own-undici, not SDK.
- chonkie-ts v0.0.x not at parity → pin exact + the offset contract test.
- MCP `sampling`/`elicitation` minority-supported → tool-result-as-judge + 2-call-confirm sidestep both.
- `mcp-proxy` npm pulls a `pipenet` tunneling SaaS dep → never depend on it; self-bridge.

## 11. Assembly plan (reuse map — glue, don't write)

**License posture: only MIT / Apache-2.0 / ISC / BSD-2 in the "take" column. AGPL / no-compete = STUDY-ONLY.**

### npm-depend (drop in + thin adapter)
| Need | Package | License |
|---|---|---|
| Store (default) | `better-sqlite3` + `sqlite-vec` (+ optional `vectorlite`) | MIT / Apache |
| Graph/claims/cache | `lmdb` (Doerr) | MIT |
| kNN adjacency + scale-tier ANN | `usearch` | Apache |
| SIMD distance (incl. binary popcount) | `simsimd` | Apache |
| Throughput | `undici` + `p-queue` + `Piscina` (+ SharedArrayBuffer ring) | MIT |
| Chat/judge provider layer | Vercel AI SDK (`ai`+`@ai-sdk/*`) + `@openrouter/ai-sdk-provider` | Apache/MIT |
| Embed/rerank | **own ~150-LOC undici clients** (not the SDK) | — |
| Recommender cost data | `models.dev` json + LiteLLM prices json (vendored, cold-start prior only) | MIT |
| Markdown→mdast | `unified`+`remark-*`+`gray-matter` | MIT |
| Wikilink tokenizer (resolution = ours) | `micromark-extension-wiki-link`+`mdast-util-wiki-link` | MIT |
| Sentence tier / Claim Index | `sentence-splitter` (`splitAST`) | MIT |
| Negation/polarity router | `wink-nlp` (+ model) | MIT |
| Token budget proxy | `gpt-tokenizer` (`isWithinTokenLimit`) | MIT |
| Offset-faithful chunker | `chonkie` (pinned + contract test) | MIT |
| Git (belief-drift) | `simple-git` | MIT |
| Stats (bootstrap CI, Brier) | `simple-statistics` | ISC |
| Watcher | `chokidar` 4.x | MIT |
| Community clustering + centrality | `graphology` + `-communities-louvain` + `-metrics` | MIT |
| Daemon HTTP (socket + loopback) | `hono` + `@hono/node-server` | MIT |
| Single-instance lock | `proper-lockfile` (+ socket-connect probe) | MIT |
| MCPB packer (devDep) | `@anthropic-ai/mcpb` | MIT |
| Plugin scaffold | `obsidian-sample-plugin` (plugin→daemon via `requestUrl()` loopback) | MIT |
| Store (overkill opt-in) | `pgvectorscale` + `pg_search`/VectorChord into your own PG | PostgreSQL / **AGPL (server-only)** |

**Rejected:** `embedded-postgres`-as-default (packaging minefield), `mcp-proxy` (tunneling SaaS dep), `promptfoo` (84 deps + 2nd better-sqlite3), SPLADE/learned-sparse stack, the AI SDK for embed/rerank.

### Vendor (pinned, out of git)
- **`cyanheads/obsidian-mcp-server` (Apache-2.0)** → `section-extractor.ts` + `frontmatter-ops.ts` (surgical heading/block/frontmatter edit brain) + keep NOTICE.

### Copy-pattern (lift code/SQL/prompts; permissive)
- 🏆 **Quartz `ofm.ts` (MIT)** → block-refs/callouts/embeds DELTA.
- **Alex Garcia's RRF CTE (Apache)** → the cold-start fusion path (CC+TMM is ours on top).
- **obsidian-export (BSD-2)** → wikilink shortest-path resolution algorithm → `core`.
- **autoevals `js/ragas.ts` (MIT)** → the 4 RAGAS metric prompts, rewired onto our Judge+Embedding.
- **ragas `TestsetGenerator` (Apache)** → golden-gen taxonomy + anti-leakage rules.
- **`negspacy` (MIT)** → NegEx/ConText cue categories → TS lexicon (data) for the negation router.
- **GAR/RGS (papers)** → the reranker-guided graph-traversal loop (algorithm, reimplemented in `core`).

### Wrap-subprocess (dev/CI only — never shipped)
- **`pytrec_eval` (MIT)** = the BEIR oracle; **`ragas` (Apache, Python)** = one-time ±0.05 cross-check.

### STUDY-ONLY (AGPL / no-compete / Python — ideas, not code)
`basic-memory` (AGPL), `khoj`/`Reor` (AGPL), `smart-connections` (no-compete), Graphiti/mem0/cognee/**Letta** (Apache but Python — Letta's *sleep-time compute* is the consolidation idea we steal as architecture), InfraNodus (topic-gap product — we do claim-level instead), `remark-obsidian` (GPL — banned dep).

### Build fresh = the moat (no OSS exists; this IS the product)
The **Belief-State Energy Model** Sentinel (edges from wikilink graph + Claim Index + cached verdicts — uncopyable) · Convergence/Bridge + Bayesian-surprise · the adaptive cascade + GAR/RGS + confidence-gate self-warming · the vault-grounded micro-benchmark router + capability probing + degradation compiler · the Decision & Prediction Ledger · sleep-time consolidation · the offset-faithful hierarchical chunker · wikilink resolution · the eval harness shell (FP-primary, A/B ladder, bootstrap CI + paired permutation).

**Net:** plumbing + parsing + edit brain + packaging + metric-validation are ~80% **assembled from MIT/Apache/ISC/BSD**. Bespoke = exactly the spec's stated moat (the epistemic engine + the retrieval intelligence), nothing more.
