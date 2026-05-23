# VaultNexus — Design Spec (v3.0)

> **VaultNexus finds where your scattered ideas secretly agree — and thinks about your notes while you sleep.**
> A Claude Code ↔ Obsidian knowledge engine: best-in-class semantic + graph retrieval over your vault, a **Convergence/Bridge** engine that surfaces hidden agreement across distant notes, an opt-in **Sentinel** that catches genuine self-contradiction and belief-drift, and a **Decision & Prediction Ledger** that makes the vault improve your judgment. **Standalone-daemon architecture** (one lean Node engine bears all CPU and consolidates on idle cycles; every UI is a thin client), fully offline-capable, one-command GitHub build.

Status: **Design v3.0 — incorporates two rounds of adversarial review (8 agents) + a 10-agent best-of-breed validation wave + a 10-agent "think-different / model-agnostic" relaunch. Models are pluggable via a 3-category registry and are deliberately not pinned. Pending user approval.**
Date: 2026-05-23
Spec owner: Roger

---

## 1. Problem & opportunity

Existing Obsidian AI tools fall in three buckets, all leaving the same gap:

- **Smart Connections** (5k★) — local cosine similarity computed *in the Obsidian renderer* (freezes the app), no graph reasoning, no API/MCP, no write-back.
- **basic-memory / Mem / Reflect** — connection-surfacing is commoditized; flat/atemporal.
- **Every Obsidian MCP server** — thin CRUD-over-REST wrappers; the one real semantic one (`jacksteamdev`) archived 2026-05-13. Topic-level gap-finding is already owned by **InfraNodus** (Louvain + betweenness + structural-gap research-questions).

White space, verified against the 2026 landscape (mem0 *State of Agent Memory 2026* lists these as explicitly **unsolved**): (a) frontier semantic+graph retrieval, MCP-exposed; (b) **epistemic intelligence** — convergence/bridge detection at the *claim* level (not InfraNodus's topic level), belief-drift, contradiction, and decision-calibration; (c) an idle daemon that **consolidates knowledge while you sleep**. The moat is the **retrieval brain + the epistemic engine**, not CRUD.

## 2. Goals / non-goals

**Goals**
- Best-quality retrieval: hierarchical (sentence→chunk→note) contextual vectors + BM25, fused (CC/TMM) + **reranker-guided adaptive graph expansion (GAR/RGS)**, cited to `path#heading^block`.
- **Convergence/Bridge detection** as the headline differentiator; the **Sentinel** (contradiction + belief-drift) as an opt-in, pull-first, FP-gated companion; the **Decision & Prediction Ledger** as the behavior-changing hook.
- **Standalone daemon** owns 100% of compute and is the single source of truth; clients are thin. Uses idle cycles for **sleep-time consolidation**.
- **Offline-capable, honestly scoped**; local models run in the daemon (never a renderer). **Local-first registry is a first-class privacy default.**
- **GitHub-ready, offline-buildable, lean dep set** (the lean store deletes the embedded-Postgres packaging risk).
- **Blazing fast**: query path = brute-force binary scan (~1ms@8-core local) + two API round-trips, with a predictive cache that turns the common case into a cache hit; zero generative LLM in the hot path.
- Agentic write-back: our own tools, dry-run + confirm, link-safe.

**Non-goals**
- Competing on CRUD; topic-level gap-finding (InfraNodus owns it — we do *claim-level* epistemic bridging instead).
- A persistent LLM-extracted fact graph (killed — §10). *(The deterministic Claim Index in §6 is NOT this.)*
- Plugin-first; the Obsidian plugin is a P2 thin client.
- Multi-user / cloud sync.
- Running models in the Obsidian renderer.
- Any expensive LLM call in the hot retrieval path, or any **push** ("we caught something") notification before precision is proven (§6, §7).

## 3. Guiding decisions (and what was rejected)

| Decision | Choice | Rejected & why |
|---|---|---|
| Vehicle | **Standalone engine daemon + thin clients**, justified by FS-watch + keep-compute-out-of-renderer + **sleep-time consolidation** (not "overkill for its own sake") | plugin-first/monorepo; a Skill+CLI-only tool (real steelman — but loses the watcher, the resident embedder, and the idle consolidation engine) |
| Language / runtime | **TypeScript on Node 22** | Bun (JSC can't load native ABI; RSS leaks), Deno (MCPB pinned to Node-22 ABI) |
| Store | **REVERSED to a lean embedded default behind one `Store` interface.** Default = **sqlite-vec/vectorlite (FTS5 BM25) + simsimd binary-quant brute-force scan + a kNN adjacency graph (usearch mmap, built at index time) + LMDB** (CSR wikilink graph, claims, content-hash cache). **No ANN index for search at ≤1M** (binary brute-force ~1ms@8-core, exact filtered search, instant mmap restart). **Overkill tier (opt-in `PG_URL`, Linux): your own Postgres + pgvectorscale + pg_search/VectorChord.** | **Embedded-PostgreSQL-as-default** (its pgvector-bundling pipeline was the #1 packaging risk; MVCC solves a concurrency problem the single-writer topology designs away; `-march=native`/symlink/Windows-full minefield); HNSW-as-default (build/corruption/restart cost for no latency win at this scale); DuckDB (data-loss on unclean shutdown); LanceDB (no SQL graph/claims) |
| Retrieval representation | **REVERSED to hierarchical small-to-big**: index sentence + chunk + note granularities in one store (discriminated by a `granularity` field), retrieve precise, return the parent. The **sentence tier doubles as the Claim Index**; the **kNN edges double as the convergence/bridge edges** — one shared structure. | flat 256–512 chunks only (467% precision swing with chunk size; no universal size); proposition/atomic-fact indexing (LLM index tax + breaks the `slice(start,end)===text` provenance contract — kept *only* as the Claim Index) |
| **Provider registry** (one layer, 3 roles) | **Bring-what-you-have, any vendor, local OR API, multiples allowed.** A **recommendation engine** assigns each registered model a **role — embed / rerank / judge** — via **capability probing + a vault-grounded micro-benchmark**, not a static table. | hardcoding any vendor; pinning rerank/judge; a static metadata table as the capability oracle (dims aren't lookuppable from any OpenAI-compat endpoint) |
| ↳ embed role | **any embedder** (vendor or local); **dims discovered by probe** (`bit`/`halfvec` sized at index time). Contextual-chunk mode (whole-note context at index time) used if the embedder supports it; else plain. **A warm resident local embedder is a first-class hot-path option** (~10ms vs ~800ms cloud), optionally **hedged-raced** against a cloud embedder. | pinning any one model; cloud-only |
| ↳ rerank role | **OPTIONAL** — any reranker (vendor or local); absent → graceful degradation (the compiler widens first-stage). **Owned via a ~150-LOC undici client** (Voyage/Cohere/Jina rerank are the same 6-field shape), not the AI SDK. | making rerank mandatory; bundling non-commercial weights |
| ↳ judge role | **any chat LLM** — the host session (tool-result-as-judge, zero-key default) or any configured LLM; **cascade** (cheap/local first, escalate on low confidence). **Via Vercel AI SDK v6** (its one genuinely polyglot, low-churn surface). | pinning the judge; MCP `sampling` (dead) |
| Provider implementation | **AI SDK v6 for chat/judge ONLY; own embed + rerank in ~150 LOC undici** (the SDK's `rerank()` is Cohere/Bedrock/Together-only and `embedMany()`'s flat-array contract can't express contextual list-of-lists; V2→V3 churn breaks community providers). **Capability negotiation** (probe dims/ctx/limits at registration) + **vault-grounded micro-benchmark router** (score the user's providers on ~30 Q→note pairs from their own vault; route per-call) + a pure **degradation compiler** (`capability_card → pipeline params`). | depending on the AI SDK for all three roles; LiteLLM/Portkey/LangChain (gateway hop / Python sidecar / bloat) |
| Fusion | **convex-combination + theoretical-min-max normalization, IDF-adaptive weights**; **RRF k=60 cold-start fallback**; **per-query expansion gate** (conceptual → expand, exact-match → skip) | fixed-weight RRF only; SPLADE/learned-sparse third leg (GPU-bound, tokenizer-destructive on personal jargon) |
| Graph / expansion | **REVERSED: GAR/RGS reranker-guided adaptive expansion** — traverse the kNN graph (+ wikilink edges, weighted higher) around *cross-encoder-confirmed* notes, within the existing rerank budget (+8–20% NDCG at ~0 added cost). The 1-hop wikilink CTE is repurposed as a frontier neighbor-source *inside* the loop. | 1-hop CTE + RRF alone (fixed-pool relevance ceiling); HippoRAG entity-seeded PPR (hub-bias) — but **dense-seeded, hub-pruned PPR is restored for the bridge/Epistemic view**, not the hot path |
| Temporal | **git history + mtime + frontmatter + user-confirmed `supersedes` edges** (the confirm-loop already collects "it's-an-update" — capture it as a deterministic typed edge; lets retrieval down-rank superseded claims) | Graphiti bi-temporal LLM fact graph (drift, cost); throwing away the supersedes signal |
| Sentinel substrate | **REVERSED to a Belief-State Energy Model** (Ising/cognitive-dissonance: `H = Σωᵢⱼ|bᵢ−bⱼ|`, edges from the wikilink graph + claim similarity, signs cached from the judge) → contradiction = an edit that spikes a tightly-bound cluster's dissonance (structural surprise). Front-ended by a **winkNLP negation/polarity router** (kills "Semantic Collapse" symbolically). Drift via **BOCPD** change-point detection. | a pure pairwise filter-funnel; embedding similarity as a standalone contradiction pre-filter (negation-blind); local NLI model |
| Headline vs Sentinel | **Convergence/Bridge is the headline** (FP-safe, ~5× hit-rate, dodges reference-indeterminacy). **Contradiction is opt-in, pull-only, behind a hard FP kill-criterion.** | leading with contradiction (REFNLI: >80% false-contradiction under context-mismatch; a false "you contradicted yourself" erodes trust) |
| Proactivity / UX | **Pull-first.** On-demand checks; a daily **morning brief** the user opens (not a push). Ambient push is the *last* thing built, opt-in, affirming-framed. | proactive "we caught something" notifications ("When Help Backfires": confirm-steps don't remove the threat) |
| First-run config | config file (+ plugin settings UI later) | MCP `elicitation` (unsupported) |
| MCP SDK + shim | TS SDK v1.x (≥1.24.0 for HTTP). Claude Code shim = **~40-line self-bridge** (SDK `StdioServerTransport` → daemon over undici `socketPath`) | `mcp-proxy` npm (pulls a public-tunneling SaaS dep) |

## 4. Architecture

```
vaultnexus/   ONE lean Node package (pnpm; catalog centralizes dep versions)
├── src/
│   ├── core/      pure compute (no I/O): hierarchical chunking · fusion
│   │              (CC/TMM/RRF, IDF-adaptive) · GAR/RGS expansion · DPP
│   │              coverage · adaptive-k · belief-energy model · BOCPD ·
│   │              QBAF semantics · Bayesian-surprise · degradation compiler ·
│   │              eval · INTERFACES (EmbeddingProvider, Reranker, Judge,
│   │              Clock, VaultReader, VaultWriter, LinkGraphSource, Store)
│   ├── store/     Store interface + SqliteStore (default: sqlite-vec/vectorlite
│   │              + FTS5 + LMDB CSR graph/claims/cache + usearch kNN) /
│   │              PostgresStore (opt-in PG_URL). simsimd + Accelerate distance.
│   ├── providers/ REGISTRY — roles {embed, rerank?, judge}; capability probe +
│   │              vault-grounded micro-benchmark router; AI SDK (chat/judge) +
│   │              ~150-LOC undici embed/rerank clients
│   ├── engine/    the DAEMON: Hono(Unix-socket + loopback) server, FS watcher,
│   │              single-writer index, RCU lock-free hot cache, predictive
│   │              prefetch, sleep-time consolidation loop. Bears 100% of CPU.
│   ├── server/    MCP surface (tools/resources/instructions + notifications)
│   ├── shim/      ~40-line stdio→daemon self-bridge (Claude Code)
│   └── index/     FS walk + parser + hierarchical chunker + chokidar + cache
├── clients/
│   └── obsidian/  THIN Obsidian plugin: UI + HTTP calls only, ZERO compute
├── docs/specs/    this document
└── (README, LICENSE-MIT, .gitignore, pnpm-workspace.yaml, MCPB manifest)
```

### Process model: standalone engine daemon + thin clients

**The #1 Smart Connections problem: it embeds/indexes inside Obsidian's renderer → freezes the app.** VaultNexus inverts this: **one long-running engine daemon owns all compute; every UI is a thin client; idle cycles are spent thinking, not idling.**

- **`vaultnexus` engine (daemon)** — a standalone Node 22 process (HTTP server = **Hono** + `@hono/node-server`; Web-standard one-handler-for-socket-and-HTTP, zero-dep, built-in auth/CORS — the wire is ~0.05% of query latency, so chosen for ergonomics, not speed). Single-instance via a **socket-connect probe** + `proper-lockfile` heartbeat; `spawn(detached).unref()`.
- **Dual transport:** **Unix domain socket** (Claude Code shim — 130µs, no network surface) **AND loopback HTTP** (Obsidian plugin — renderer can't reach a socket, `fetch` is CORS-blocked).
- **Clients are thin:** Claude Code → a **~40-line self-bridge** (SDK `StdioServerTransport` + undici `{ socketPath }`, keeps it on the zero-network path; not `mcp-proxy`). Obsidian → thin plugin via `requestUrl()` over loopback, **zero compute**. Claude Desktop / Cursor → HTTP-MCP.
- **Single writer by topology** ⇒ no concurrency/lockfile problem by construction.

### Provider registry & router (bring-what-you-have, model-agnostic)

The daemon hardcodes NO vendor. Three categories — **embed (required)**, **rerank (optional)**, **judge (host session counts)** — bound by a recommender that *measures* rather than tabulates:

- **Capability negotiation:** at registration, probe each endpoint — embed one string → `.length` is the ground-truth **dims** (no OpenAI-compat endpoint exposes this); oversized request → parse error for **max-context/batch**; sniff `/rerank` and contextual list-of-lists support; test `output_dimension` for Matryoshka. Write a `capability_card`. The static cost table (LiteLLM JSON + models.dev) is demoted to a **cost hint + cold-start prior**.
- **Vault-grounded micro-benchmark:** carve ~30 Q→note pairs from the user's own vault (built for eval anyway), score every registered embedder/reranker by **nDCG on this specific vault**, feed that as the quality prior into a **renewal-reward + LinUCB router** (`u/(1+τ/Lref)`). One mechanism delivers routing + fallback + offline + hedging.
- **Routing scope:** embedder is **per-space** (index and query must share a model) with a fast **resident-local embedder** option for the Sentinel cull / cache pre-warm; **reranker is per-call**; **judge is a cascade**.
- **Degradation compiler** (pure `core/` function, `capability_card → pipeline params`): no reranker → widen first-stage + lean on MMR/DPP; short-context embedder → shrink chunk target; no contextual mode → flat embed + BM25 blurb; slow provider → smaller batches. Any registry config "just works."
- **Implementation:** **Vercel AI SDK v6 for chat/judge only** (its polyglot, low-churn surface); **own embed + rerank in ~150 LOC undici** over the daemon's pre-warmed pools (the SDK's `rerank()` is Cohere/Bedrock/Together-only and can't express contextual list-of-lists embed; the raw endpoints are 6 fields each).

### Data store — lean embedded default; Postgres opt-in

**Default `SqliteStore` (lean, install-nothing, no Docker, smallest air-gap bundle):**
- **Vectors:** stored as **binary-quantized codes** (`bit`) + a quantized rescore lane (int8/`halfvec`); **searched by simsimd brute-force popcount** — ~1ms across 8 cores / ~9ms single-core / 128MB RAM at 1M×1024-dim, *beating* HNSW (5–8ms) with **zero build time, zero index corruption, instant mmap restart, and exact (not approximate) filtered search**. `vectorlite` (hnswlib-in-SQLite, SIMD) available if a graph index is ever wanted.
- **kNN adjacency graph:** built once at index time (usearch, k≈8–16) and stored as CSR — this is the GAR/RGS expansion graph **and** the convergence/bridge edge set (shared infra).
- **BM25 / FTS:** SQLite **FTS5 `bm25()`** (real BM25 — better-ranked than Postgres `ts_rank`).
- **Graph + claims + cache:** **LMDB** (CSR wikilink adjacency, the Claim Index, content-hash→embedding cache, labels) — ACID, ~500K writes/s, lock-free parallel readers, mmap.
- **Hierarchical index:** sentence / chunk / note rows discriminated by `granularity`; the sentence tier *is* the Claim Index.

**Overkill tier (opt-in `PG_URL`, Linux, no Docker required):** your own Postgres + pgvectorscale (StreamingDiskANN) + pg_search/VectorChord (real BM25 + RaBitQ) for tens-of-millions. ⚠️ AGPL — separate server, never bundled.

This **deletes the v2.2 #1 packaging risk** (no embedded-Postgres + hand-built pgvector pipeline) and makes the default trivially air-gappable.

### Throughput & blazing-fast systems

The reframe: **~95–99% of hot-path latency is the embedding network round-trip** (200ms p50, 5s p99); local search is ~1–3ms. So speed work targets the network, not local compute.
- **Predictive "slow-thinker" prefetch (the headline latency win):** the daemon watches the Claude Code session's working set (open files, recent edits, the `Stop`-hook stream) and **pre-embeds + pre-retrieves the agent's likely next query into the cache before it's asked** — turning "blazing fast" from a wire claim into a prediction claim (~316× on a cache hit; 75% hit rate; erases the p90/p99 embedding tail). FP-safe (a wrong prefetch costs only idle CPU).
- **Resident local embedder option** (~10ms CPU / <100ms Apple-Silicon) as the default hot-path embed role, optionally **hedged-raced** against a cloud embedder — the single biggest latency reduction available.
- **RCU double-buffered, columnar, lock-free hot cache** (10–30× read throughput; SIMD-dense Structure-of-Arrays feeds simsimd) + a **τ-bounded approximate result cache** (reuse a prior query's set within a similarity tolerance, near-100% recall).
- **SIMD distance** via **simsimd** (up to 200× over scalar JS, f32/int8/binary in one dep) + **Accelerate/AMX sgemm** (~2× over NEON) for batched/all-pairs math; **declared-recall early termination** (DARTH-style) + **Extended RaBitQ** if/when a graph index is used.
- **Index pipeline:** **Piscina** workers with a **SharedArrayBuffer ring buffer** thread→thread (zero-copy vectors); `undici` pre-warmed pools; `p-queue` backpressure + `Retry-After`.
- **Streaming push** (in-process fanout over the socket → MCP notifications) for index progress + standing-intelligence findings; the synchronous query stays plain request/response.

## 5. Retrieval pipeline (v3 — adaptive cascade)

**Index time:** parse → OFM → offset-faithful **hierarchical chunk** (sentence / chunk / note) → embed (contextual-chunk mode if supported; resident-local or cloud) → store binary codes + rescore lane + the deterministic BM25 blurb; build the kNN adjacency graph (shared with convergence). The sentence tier becomes the Claim Index.

**Query time** (hot path; zero generative LLM):
```
query
 → ROUTER (cached TF-IDF/SVM + heuristics, ~0.1ms, NO embed call)
     → strategy: α-prior, expansion on/off, rerank-disposition
 → FIRST STAGE (speculative overlap): embed(query) ‖ BM25 ‖ wikilink-CTE
     → convex-combination fusion (TMM norm, IDF-adaptive α; RRF cold-start)
 → CONFIDENCE GATE (free, on fused scores: top1−top2 gap, lexical∩semantic, entropy)
     ├─ HIGH → EARLY EXIT: DPP/coverage select → adaptive-k → return  (no rerank)
     └─ LOW  → GAR/RGS adaptive expansion: rerank a batch → add kNN + wikilink
               neighbors of cross-encoder-confirmed notes → rerank → repeat
               (within the rerank budget) → DPP coverage → adaptive-k → return
 → cited hits { path#heading^block, snippet, score, why-retrieved }
```
- **Auto mode-switch:** small/cheap-enough vault → stuff whole vault into context (prompt caching). This is a first-class path, not an afterthought.
- The **confidence gate self-warms** from the eval harness's existing rerank-ablation labels (model-free, online).
- **Fold-later** (behind the A/B switchboard): per-query dynamic α, online-learned fusion weights, an optional ColBERT tier on the `PG_URL` overkill backend.

## 6. The Sentinel (opt-in, pull-first) + Convergence (the headline)

**Convergence/Bridge detection (headline, FP-safe, ships first).** Over the kNN/claim graph: for each high-similarity claim pair whose endpoints sit in **different** Louvain communities (with **no existing edge**), flag a bridge candidate; rank by **Bayesian surprise** (KL of the vault's belief distribution before/after — only surface bridges that *move* your thinking). This is **claim-level epistemic bridging**, distinct from InfraNodus's topic-level structural holes. A wrong bridge costs nothing.

**Contradiction (opt-in, pull-only, FP-gated) — Belief-State Energy Model substrate:**
1. **Claim Index lookup** (the sentence tier).
2. **Assertion pre-filter** (biggest precision lever): first-person, assertive, settled sentences only.
3. **Negation/polarity router** (winkNLP + a NegEx cue lexicon, pure-TS): *force* polarity-reversed pairs forward, *veto* same-polarity look-alikes — fixes "Semantic Collapse" symbolically (dense vectors are negation-blind).
4. **Belief-energy update:** the edit moves a belief node `bᵢ`; recompute local **dissonance `ΔH = Σⱼ ωᵢⱼ|bᵢ−bⱼ|`** over its neighborhood (edges from the wikilink graph + claim similarity, signs cached from the judge). Only edits that spike a **well-connected** cluster past τ become candidates — the connectivity gate kills the daily-note-one-liner FP class; structural **self-resolution** distinguishes *update* from *contradiction* before any LLM call.
5. **Judge** (bias-hardened tool-result-as-judge; cascade cheap→frontier) adjudicates only the survivors and **sets the edge signs** that feed back into the energy graph.
6. **Temporal:** record a user-confirmed **`supersedes` edge** on "it's-an-update"; **BOCPD** change-point detection narrates only confirmed, dated mind-changes; shrinking-variance runs = convergence-over-time ("you're settling").
7. **Confirm-and-learn:** every dismissal re-fits τ per topic, online — FP rate monotonically improves.

**Precision is the product.** Eval's **primary metric is false-positive rate**, with a hard **kill-criterion**: if FP can't beat a stated threshold (e.g. <1 false contradiction per 50 edits) by end of P1.5, contradiction ships **off by default** and only convergence is surfaced.

## 7. Standing intelligence + sleep-time consolidation

- **Sleep-time consolidation (the moonshot).** The daemon is idle ~99% of the time and watches the whole corpus. On idle cycles it walks recently-changed clusters, pre-computes the convergence/contradiction/energy graph, and **synthesizes a pull-based "morning brief"** of genuinely surprising syntheses (Bayesian-surprise-ranked) — *"three notes this month converge on X; here's the thesis you haven't written."* The leap from "fast search that argues" to "a second brain that thinks overnight." (Letta sleep-time compute: 18% accuracy, 2.5× cost.)
- **Decision & Prediction Ledger (build-first new feature).** Extract forecast-claims from notes (reusing the assertion filter), record `confidence`/`resolves_when`, resurface on outcome-date/topic ("5 months ago you predicted X at 60% — how'd it go?"), and compute a **per-topic Brier score / calibration curve**. Makes the vault improve your *judgment*. Zero new always-on LLM (cosine + date math; judge narrates on demand).
- **Grounded Steelman.** On-demand `challenge_claim`: mount the strongest counter-case grounded in *your* vault (reverse the contradiction cull + an evidence-absence check), remembering what it already challenged. "Argues back **and** keeps score."
- **Epistemic Integrity view.** Whole-vault map: least-stable beliefs via **QBAF gradual semantics** (handles reinstatement; ~30-LOC fixpoint, no external lib), connector notes via **dense-seeded, hub-pruned PPR** importance (not plain betweenness). Built with `graphology` (sub-100ms at sparse scale; no native binary).
- **Ambient Inbox / Capture** — push only, built **last**, opt-in, affirming-framed, gated on the FP kill-criterion.

## 8. MCP surface

Transport: **stdio self-bridge → daemon over Unix socket**; loopback HTTP for the plugin. All tools: `outputSchema` + `structuredContent`, correct hints. Server `instructions` (≤2 KB) front-loaded. **Streaming notifications** for index progress + standing-intelligence (not the synchronous query). **No `sampling`/`elicitation`.**

**Read:** `semantic_search`, `note_context` (flagship), `what_links_here`, `find_bridges` (convergence — headline), `recall_history` (git temporal), `decision_ledger` / `recall_predictions`, `challenge_claim` (steelman), `sentinel_check` (opt-in), `epistemic_report`, `vault_diff`, `vault_stats`. *(P2: `note_ripple`, `graph_query`, `tag_map`, `moc_map`.)*

**Write** (dry-run + confirm; our own tools, FS atomic): `create_note`, `edit_note`, `safe_rename_note`. *(P2: `suggest_links`, `synthesize_moc`.)*

**Resources:** `note://{path}` + `vault://index`; `listChanged` on create/delete.

**HTTP security (loopback surface):** TS SDK ≥1.24.0, **bind 127.0.0.1**, `Origin`/`Host` allowlist, **bearer token on every request** (GHSA-w48q-cv73-mx4w). The socket path needs only filesystem perms.

## 9. Offline build & dependency centralization

**"Offline" = easy offline BUILD + local-first vault DATA.** Local-first registry (local embedder + reranker + judge) = a true air-gapped runtime and the **privacy default** for the Obsidian crowd; a cloud registry is the max-quality opt-in. Privacy is stated per provider (with cloud, note text leaves at index/query time).

1. **Offline build** — pnpm `catalog:` + committed lockfile; `pnpm fetch` → offline `--frozen-lockfile` install on pinned pnpm `11.0.7`; CI cold-store cross-arch. Native deps = **`better-sqlite3`/`sqlite-vec` (or `vectorlite`), `simsimd`, `usearch`, `lmdb`** — all with prebuilt binaries; **no embedded-Postgres, no hand-built pgvector pipeline** (the lean store deletes that risk).
2. **Runtime = the registry** — three roles bound to whatever the user registered; no ML bundled.
3. **Always local:** the vault, the index, the link/claim/kNN graphs, all deterministic code (parser, chunker, fusion, energy model, BOCPD, git).

**Distribution:** MCPB bundle (per-platform, vendored) = primary; `npx -y @vaultnexus/mcp` = convenience.
**Secrets:** keys via env (`VOYAGE_API_KEY`), never committed.

## 10. Explicitly rejected (kept for the record)

- **Embedded-PostgreSQL as the default store** — packaging minefield (`-march=native`, npm symlinks, no Windows-full), MVCC solves a designed-away problem; demoted to opt-in `PG_URL`.
- **HNSW/ANN index for search at ≤1M** — binary brute-force is faster with no build/corruption/restart cost; a kNN *adjacency* graph is still built (for expansion/convergence), which is different.
- **Persistent bi-temporal LLM fact graph** — the deterministic Claim Index + `supersedes` edges replace it.
- **Contradiction as the headline / push-by-default UX** — REFNLI false-contradiction rates + "When Help Backfires" → convergence-led, pull-first, FP-gated.
- **SPLADE / learned-sparse third leg** — GPU-bound, domain-fragile, tokenizer-destructive on personal jargon; contextual-dense is the learned-expansion leg minus the cost.
- **HippoRAG entity-seeded PPR** (hub-bias) — but dense-seeded, hub-pruned PPR is restored for the bridge/Epistemic view.
- **Proposition indexing for retrieval** — LLM index tax + breaks provenance; kept only as the Claim Index.
- **HyDE / query rewriting / GraphRAG build / manual Contextual Retrieval** — LLM in the hot/index path for low marginal value.
- **SEDA, io_uring, query compilation, Arrow-everything, GPU hot-path rescore, product quantization, plain msgpackr on the wire, Bun/Deno, uWebSockets.js, ngraph-native** — each trades a real constraint for throughput this workload never uses (the wire is ~0.05% of latency).
- **MCP `sampling` / `elicitation`** — unsupported.
- **Forking `cyanheads/obsidian-mcp-server`** — vendor its edit-tool module (Apache-2.0).

## 11. Evaluation

- Golden **Q→note** set from the user's own vault (also seeds the provider micro-benchmark); Recall@k, **MRR**, **NDCG@10** — hand-rolled TS, validated once against the **`pytrec_eval`** dev oracle (MRR = `recip_rank`). Don't add ranx/ir-measures/BEIR.
- A/B switchboard (dense / +BM25 / +CC-fusion / +GAR expansion / +DPP / +rerank) → the failure-rate ladder (and the confidence gate's self-warming labels); bootstrap CI + paired permutation on `simple-statistics`.
- **Sentinel FP rate = primary metric**, with the hard **kill-criterion** above and a "messy notes" negative set. Judge/Sentinel quality = a TS reimpl of the RAGAS prompts (from autoevals, MIT). **promptfoo rejected** (84 deps + a second `better-sqlite3`).
- **Convergence/Bridge precision** + **Decision-Ledger calibration (Brier)** = secondary metrics.

## 12. Phasing

- **P0 — scaffold (de-risked):** Node 22 package, pnpm catalog, the `Store` interface + `SqliteStore` (sqlite-vec/vectorlite + FTS5 + LMDB + usearch), `simsimd` brute-force scan, `core` interfaces, hierarchical chunker (chonkie-ts pinned + offset round-trip contract test), config, CI cold-store cross-arch. **Spikes:** ① provider capability-probe + round-trip via the registry (one API + one OpenAI-compat local); ② brute-force scan latency at target vault size; ③ resident-local-embedder warm path. *(The embedded-Postgres bundling spike is gone — risk deleted.)*
- **P1 — retrieval base:** incremental hash-cache index, hierarchical small-to-big, contextual embeddings (if supported), CC+TMM fusion (IDF-adaptive) + per-query gate + **GAR/RGS expansion** + DPP coverage + adaptive-k + confidence-gate cascade, own-embed/rerank undici clients, vault-grounded micro-benchmark router + degradation compiler, RCU cache + predictive prefetch, `semantic_search`/`note_context`/`what_links_here`/`create_note`/`edit_note`, eval harness, stdio self-bridge MCP server.
- **P1.5 — the differentiators:** 🎯 **Convergence/Bridge (`find_bridges`)** first; then the **Decision & Prediction Ledger**; then **Grounded Steelman**; then the opt-in **Sentinel** (energy model + negation router + cascade judge + `supersedes` + online τ-calibration) behind the FP kill-criterion; `recall_history`, `safe_rename_note`.
- **P2 — standing + consolidation:** **sleep-time consolidation / morning brief**, **Epistemic Integrity** (QBAF + dense-seeded PPR), BOCPD drift narration, streaming push, MCPB bundle, optional Obsidian plugin, remaining read tools, Ambient Inbox/Capture (opt-in, FP-gated).
- **P3 / moonshot:** cross-source life-graph (vault + GitNexus code-graph + read-later), learned per-user fusion weights, optional ColBERT tier, multimodal.

## 13. Open questions

- **Brute-force vs usearch-HNSW crossover:** measure where the binary brute-force scan stops being interactive on weak hardware (likely well past 1M on x86, maybe ~2M on slow Apple cores) and the kNN graph should also serve search.
- **Belief-energy edge weights & τ:** how to set `ωᵢⱼ` (wikilink vs similarity blend) and the dissonance threshold for low FP — calibrate on the golden + negative sets.
- **Resident-local-embedder default?** Is local embed-by-default (cloud hedged) the right privacy+latency posture, or cloud-default with local opt-in? Decide from the micro-benchmark on real hardware.
- **FP kill-criterion threshold:** the exact "false contradictions per N edits" gate that contradiction must beat to ship on by default.
- **Sleep-time consolidation budget:** how much idle CPU/API spend per night, and the morning-brief surface (note vs tool vs plugin view).
- **Headless graph parity vs `metadataCache`** — measure divergence; document known-unequal cases (shortest-path, case-fold, embeds).
