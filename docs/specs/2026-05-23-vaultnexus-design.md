# VaultNexus — Design Spec (v2.1)

> **VaultNexus doesn't just search your second brain — it argues back.**
> A Claude Code ↔ Obsidian knowledge engine: best-in-class semantic + graph retrieval over your vault, plus a Sentinel that catches you contradicting yourself and shows how your thinking drifts over time. **Headless-first** (one Node package, stdio MCP), fully offline-capable, one-command GitHub build. Obsidian plugin is an optional later enhancement.

Status: **Design v2.1 — incorporates two rounds of adversarial review (8 agents). Pending user approval.**
Date: 2026-05-23
Spec owner: Roger

---

## 1. Problem & opportunity

Existing Obsidian AI tools fall in three buckets, all leaving the same gap:

- **Smart Connections** (5k★) — local 384-dim cosine similarity, no graph reasoning, no API/MCP, no write-back.
- **basic-memory** — good data model, flat/atemporal retrieval.
- **Every Obsidian MCP server** — thin CRUD-over-REST wrappers; the one real semantic one (`jacksteamdev`) **archived 2026-05-13**. Local REST API now ships built-in `/mcp/` CRUD.

White space, verified against the 2026 landscape: (a) frontier semantic retrieval *fused with the wikilink graph* + reranking, MCP-exposed (no shipping tool reranks); (b) a tool that **protects the integrity of your thinking** — contradiction + belief-drift. No published false-positive benchmark for personal-vault contradiction detection exists; that absence *is* the opportunity. The moat is the **retrieval brain + the Sentinel**, not CRUD.

## 2. Goals / non-goals

**Goals**
- Best-quality retrieval: hybrid (vector + BM25 + RRF) + bounded wikilink expansion + cross-encoder rerank, cited to `path#heading^block`.
- The **Contradiction & Belief-Drift Sentinel** + a standing **Epistemic Integrity** view as the defining novelty.
- **Headless-first**: one Node package, stdio MCP server, reads the vault from the filesystem. Works with Obsidian open or closed. Usable by Claude Code, Claude Desktop, Cursor, etc.
- **Offline-capable, honestly scoped**: three distinct "offline"s (build / engine-runtime) handled explicitly. Local embeddings + reranker + NLI run in the Node engine (never a UI renderer). Online mode (Voyage-4 + rerank-2.5) is the max-quality option.
- **GitHub-ready, offline-buildable, deps centralized**: pnpm catalog + committed lockfile, MCPB bundle with vendored deps for air-gap.
- Agentic write-back: our own tools, dry-run + confirm, link-safe.

**Non-goals**
- Competing on CRUD (it's commoditized).
- A persistent LLM-extracted entity/fact graph (killed — §10). *(The minimal deterministic Claim Index in §6 is NOT this — see §10.)*
- Plugin-first. The Obsidian plugin is a **P2 optional enhancement**, not the primary vehicle.
- Multi-user / cloud sync. Single-user, local-first.
- Running models in the Obsidian renderer (proven infeasible — §9).

## 3. Guiding decisions (and what was rejected)

| Decision | Choice | Rejected & why |
|---|---|---|
| Vehicle | **One headless Node package, stdio MCP** | Monorepo + plugin-first — over-rotated; renderer can't host models; stdio sidesteps the HTTP DNS-rebinding CVE; plugin's only edge (canonical graph) ~90% recovered by a parser |
| Language | **TypeScript** | — |
| Store | **Dual backend behind one `Store` interface** (user wants overkill + zero concurrency worries + **no Docker**). **Default = daemon-managed embedded PostgreSQL 17 + pgvector 0.8** — **npm-prebuilt binaries, NO Docker, install-nothing**; **MVCC = unlimited concurrent readers AND writers** (kills the single-writer ceiling). One ACID store: vectors(`vector`/HNSW) + FTS(`tsvector`/GIN) + graph(recursive CTE) + claims + labels, one txn. **Fallback = sqlite-vec + FTS5** (zero-server, smallest air-gap). **Overkill tier (opt-in, `PG_URL`): your own Postgres + pgvectorscale (StreamingDiskANN→tens of millions) + pg_search (Tantivy BM25)** via prebuilt extension packages (Docker optional, NOT required). | Docker-required setups; pglite (single-connection); Milvus (no Node SDK); DuckDB (experimental HNSW persistence = data-loss); LanceDB (no graph + native sprawl); bundling AGPL pg_search into the MIT build |
| **Provider registry** (one layer, 3 roles) | **Bring-what-you-have, any vendor, local OR API, multiples allowed** (user 2026-05-23). User registers their providers/models once; VaultNexus assigns each to a **role — embed / rerank / judge** — and a **recommendation engine** suggests the best assignment from what's available. **Local is fine — it runs in the daemon, not Obsidian** (so no SC freeze). Nothing pinned to one vendor. | hardcoding OpenAI; pinning rerank/judge; requiring a rerank or a specific host LLM |
| ↳ embed role | any embedder in the registry (Gemini / Nomic / EmbeddingGemma / Voyage / OpenAI / Cohere / Jina / **local via Ollama/LM-Studio/TEI** / generic OpenAI-compat). **Dims model-driven** (vec0 sized at index time). | — |
| ↳ rerank role | **OPTIONAL** — any reranker the user has (Voyage / Cohere / Jina / zerank / local), else **graceful skip** (hybrid+expansion only). Never required. | making rerank mandatory |
| ↳ judge role | **any chat LLM the user has** — the host session (tool-result-as-judge, zero-key default) **or** any configured LLM (Claude/GPT/Gemini/local). Not pinned. | pinning the judge to one model; relying on MCP `sampling` (dead) |
| Sentinel cull | **embedding-similarity** (whatever embedder is in the embed role) → Judge | local NLI model dropped (the cull rides the embed provider) |
| First-run config | **config file** (+ plugin settings UI later) | **MCP `elicitation`** — unsupported in flagship clients |
| Graph | wikilinks as free structure; **bounded 1-hop expansion** via SQL CTE | HippoRAG PPR + global PageRank — hub-bias on sparse vaults, hurts single-hop QA |
| Temporal | **git history + mtime + frontmatter dates** | Graphiti bi-temporal LLM fact graph — contradicts thesis, drifts, costly |
| Context | standard embedding + **deterministic** BM25 blurb (title+header-path+tags+linked-titles) | Anthropic Haiku contextual-prefix — redundant + worse |
| Writes | **our own tools**; FS atomic (temp+fsync+rename); REST only as a headless→live-Obsidian bridge | routing in-process writes through localhost REST; pointing clients at two MCP servers (tool-overlap confusion) |
| MCP SDK | TS SDK v1.x (≥1.24.0 if HTTP ever used) | — |

## 4. Architecture

```
vaultnexus/   ONE Node package (pnpm; catalog centralizes dep versions)
├── src/
│   ├── core/      pure compute (no I/O): chunking · RRF fusion · wikilink
│   │              expansion · Sentinel precision stack · eval · INTERFACES
│   │              (EmbeddingProvider, Reranker, Judge, Clock,
│   │               VaultReader, VaultWriter, LinkGraphSource)
│   ├── store/     SQLite (sqlite-vec + FTS5): chunk vectors, BM25, link table,
│   │              claim table, content-hash cache. Single .db file per vault.
│   ├── providers/ PROVIDER REGISTRY — roles {embed, rerank?, judge};
│   │              any vendor, local-or-API; recommend-by-availability engine
│   ├── engine/    the DAEMON: HTTP(localhost)+Unix-socket server, FS watcher,
│   │              single-writer index, all stages. Bears 100% of the CPU.
│   ├── server/    MCP surface (tools/resources/instructions) over the daemon
│   ├── shim/      thin stdio-MCP proxy → daemon (for Claude Code)
│   └── index/     FS walk + chunker + parser + chokidar watcher + hash-cache
├── clients/
│   └── obsidian/  THIN Obsidian plugin: UI + HTTP calls only, ZERO compute
├── docs/specs/    this document
└── (README, LICENSE-MIT, .gitignore, pnpm-workspace.yaml, MCPB manifest)
```

### Process model: standalone engine daemon + thin clients (fixes the Smart Connections slowdown)

**The #1 Smart Connections problem: it embeds/indexes *inside Obsidian's renderer* → freezes the app.** VaultNexus inverts this: **one long-running engine daemon owns all compute; every UI is a thin client.**

- **`vaultnexus` engine (daemon)** — a standalone Node process (HTTP server = **Hono** + `@hono/node-server`, which binds both a Unix socket and loopback). Watches the vault, owns the single SQLite index (single writer → no concurrent-writer corruption), runs parse/chunk/embed-calls/hybrid-search/Sentinel/git. **All CPU lives here — never in Obsidian.** Embeddings + rerank are API calls, so it's mostly I/O-bound; the only real CPU is sqlite-vec brute-force search + parsing. Single-instance via **`proper-lockfile`** heartbeat; process model = bare-stdlib `spawn(detached).unref()` (`vaultnexus daemon` foreground / `vaultnexus start` detached) — **not** PM2. Validated by research: `obsidian-local-rest-api` runs its server *in the renderer* — exactly the freeze anti-pattern we avoid.
- **Dual transport from one Hono app:** **Unix domain socket** (for the Claude Code shim — no network surface, no DNS-rebinding) **AND loopback HTTP on 127.0.0.1** (REQUIRED for the Obsidian plugin — see below). Stale-socket guard: unlink+relisten only if the lockfile shows no live owner.
- **Clients are thin:**
  - **Claude Code** → `shim/`: depend on **`mcp-proxy`** `startStdioServer({serverType, url})` (~30 LOC: check lock → autostart daemon if down → proxy stdio↔daemon). Don't hand-write it (same lib FastMCP trusts).
  - **Obsidian** → `clients/obsidian/` thin plugin (seed from official `obsidian-sample-plugin`): renders results, calls the daemon via Obsidian's **`requestUrl()` over loopback HTTP** — ⚠️ the renderer **cannot** reach a Unix socket and plain `fetch` is CORS-blocked (`app://obsidian.md` origin), so loopback HTTP is mandatory for the plugin. **Zero embedding/indexing/search in the renderer** → Obsidian stays at 60fps regardless of vault size.
  - Claude Desktop / Cursor → HTTP-MCP to the same daemon.
- **MCP framework:** stay on raw `@modelcontextprotocol/sdk` — FastMCP/xmcp/mcp-framework all just wrap it and add HTTP-deploy DX the daemon makes redundant. (Borrow only FastMCP's `UserError` shape for clean tool errors.)
- **Single source of truth + single writer:** because exactly one daemon touches the index, the lockfile/concurrency problem disappears by construction. The daemon is the only writer; clients only read/request.

`core` stays I/O-free and unit-testable; all file/network/persistence is injected through interfaces. The daemon composes them; the shims/plugin are dumb transports.

### Provider registry & recommendation engine (bring-what-you-have)

The daemon hardcodes NO vendor. The user registers whatever models they have, **tagging each with one of three categories**. VaultNexus binds the best of each category to its job and a **recommendation engine** suggests the picks from what's present.

**The three model categories (the user's mental model):**
| Category | What it does | Required? | Examples (any vendor, local or API) |
|---|---|---|---|
| **1. Embedding model** | text → vectors (indexing + query + the Sentinel similarity-cull) | **Yes** (the one hard requirement) | Gemini-embedding, Nomic, EmbeddingGemma, OpenAI-3, Voyage-4, Cohere, Jina, BGE/Qwen3 local |
| **2. Reranker** ("ranking" model) | reorder candidates by relevance | **No — optional** (skip → hybrid+expansion only) | Voyage rerank-2.5, Cohere rerank, Jina reranker, zerank-2 (local) |
| **3. LLM** (the "judge"/generator) | adjudicate contradictions, narrate drift, synthesize | **Yes**, but the **host Claude session counts** (zero-key default) | the host session, or any Claude/GPT/Gemini/local chat model |

- **Bring-what-you-have:** register any number per category (e.g. *3 OpenAI embedders*, or *3 local embedders*), any vendor, local or API. Local models run **in the daemon, never Obsidian** → no SC freeze.
- **Recommendation engine** (deterministic, runs at setup + on registry change): from the registered set + a built-in quality/cost/latency table, it proposes one pick per category with a one-line rationale — e.g. *"Embedding → `gemini-embedding-001` (highest-quality you registered); Reranker → none registered → skipped (add one for +precision); LLM → your host Claude session (zero-key)."* User overrides any pick.
- **Fully decoupled:** swap any category's model without touching the others. Reranker absent = fine. LLM = host session or your own keyed model. Only an **embedding-model** change forces a re-index (dims/space guard); reranker/LLM swaps are free.
- **Implementation = STEAL, not 8 adapters:** depend on **Vercel AI SDK v6** (`ai` + `@ai-sdk/*`, Apache-2.0) — it unifies **all three categories**: `embed()`/`embedMany()`, native **`rerank()`** (AI SDK 6, Dec 2025), and `generateText()`, across OpenAI/Google/Anthropic/Cohere/Mistral/Bedrock + **local** (`@ai-sdk/openai-compatible`, Ollama community provider). Voyage via `voyageai-ai-provider`; Nomic via openai-compatible. The `EmbeddingProvider`/`Reranker`/`Judge` interfaces become **thin pass-throughs** to those calls; registration uses `createProviderRegistry`/`customProvider` to alias each registered model to its role. Only the long-tail local reranker may need one ~30-line `RerankingModelV2` adapter.
- **First-class endpoint TYPES (user 2026-05-23):** the registry must accept **(a) OpenAI-format endpoints** — any base-URL + key via `@ai-sdk/openai-compatible` (covers LM-Studio, llama.cpp, vLLM, TEI, Together, Groq, Nomic, self-hosted) for embed + chat; and **(b) OpenRouter** via `@openrouter/ai-sdk-provider` (chat/LLM + reasoning; ⚠️ OpenRouter has **no embeddings endpoint** → it serves the **LLM/judge** category only). A registry entry is just `{category, providerType: openai|openai-compatible|openrouter|google|anthropic|voyage|ollama|…, baseURL?, apiKeyEnv, modelId}`.
- **Recommender data = pulled, not hardcoded:** `models.dev/api.json` (chat/LLM cost+context) **+** LiteLLM `model_prices_and_context_window.json` (embeddings cost **+ dims** — models.dev omits embeddings). Vendored at build, refreshed on a cadence; tiny local override map for brand-new local models.

### Data store — pluggable `Store`; PostgreSQL-default (Docker-free), SQLite-fallback

**Default `PostgresStore` = daemon-managed embedded PostgreSQL 17 + pgvector 0.8.** Prebuilt PG binaries via npm (`embedded-postgres`-style); the daemon owns `start/stop` — **no Docker, install-nothing, real multi-connection server.** **MVCC** → unlimited concurrent readers + writers, so the SQLite single-writer apparatus (heartbeat lockfile, read-only-on-no-lock, WAL writer-serialization) is **deleted**. Tables, all in one ACID txn:
- `chunks.embedding vector(<model-dim>)` + **HNSW** index (`vector_cosine_ops`); pgvector 0.8 **iterative scan** fixes over-filtering when constraining ANN by folder/tag/`state`.
- FTS = `tsvector` **generated column** + GIN + `ts_rank_cd` → fused with vector via the same **RRF** CTE (k≈60). *(No external-content sync triggers — the generated column self-maintains.)*
- `links(src,dst,type,heading,block,alias,source)` — 1–2 hop via **recursive CTE** (ports verbatim from the SQLite design). `claims` (Claim Index) + `vec_claims`. `content_hash` cache (re-embed only changed chunks/spans).
- `index_meta` fingerprint + a migrations runner; the `spaceId` model-swap guard is store-agnostic (reuse).

**Overkill tier (opt-in, `PG_URL`, NO Docker required):** point at your own Postgres carrying **pgvectorscale** (StreamingDiskANN, label-filtered, disk-resident → tens of millions) + **pg_search** (Tantivy BM25) — installed via prebuilt extension packages (apt/rpm/pgxn; Docker optional). Daemon detects extensions at boot → lights up DiskANN + Tantivy paths, else HNSW + native FTS. ⚠️ pg_search is **AGPL → use as a separate server, never bundle** its binary in the MIT MCPB.

**Fallback `SqliteStore` = sqlite-vec + FTS5** — zero-server, smallest air-gap, CI smoke backend; transparently used if embedded-PG fails on a platform.

**Migration from the prior SQLite DDL is mechanical and net-simpler:** recursive-CTE graph + RRF port near-verbatim; FTS triggers **and** the lockfile both vanish; only real cost is sync(`better-sqlite3`)→async(`pg`) at the `Store` boundary (`core` is already async-friendly).

### Throughput — "gets hammered, never throttles"
- **DB:** one `pg.Pool` split into **reader + writer pools** over MVCC (no PgBouncer — single local process); prepared statements for hot queries; multi-row `INSERT`/`COPY` for bulk index. Pipelining deprioritized (local Unix socket = ~no RTT).
- **API (the real bottleneck):** **`undici`** keep-alive `Pool` per provider host; **embedding micro-batching** (provider-max arrays); **`p-queue`** with per-provider concurrency caps + **backpressure** + `Retry-After`/429 backoff — the governor that makes a 100k-note cold index shape to the rate limit instead of erroring.
- **CPU:** **`Piscina`** worker-thread pool for parse/chunk/sentence-split → event loop stays free (100k-note re-index while Obsidian holds 60fps).
- **Cache (2 tiers, DB-backed, delta-invalidated):** content-hash→embedding cache + short-TTL query-result cache (query-embedding + RetrievalConfig hash → ranked hits).

## 5. Retrieval pipeline

```
query
  → embed(query, "search_query: ") → sqlite-vec vector search  ┐
  → query terms → FTS5 BM25                                     ┘→ RRF → candidate pool
        │
        ├─ bounded wikilink expansion: 1-hop neighbors of top seeds via SQL CTE
        │     (2-hop only on explicit "explore/related" intent), capped, deduped
        ├─ light structural boosts (small weight): recency, link-overlap-with-seeds, tag-match
        └─ rerank (Voyage rerank-2.5, assumed reachable): ~20–30 in → 5–8 out
                → cited hits { path, heading, blockId?, snippet, score }
```

- **Auto mode-switch:** small/cheap-enough vault → stuff whole vault into context via prompt caching (retrieval adds error below a budget). Gated on a cost/latency **budget**, not a hard token line.
- **Chunking:** header-split → recursive 256–512 tok, ~10–15% overlap; never split code/tables/callouts. Frontmatter/tags/links/header-path → metadata. **Deterministic BM25 blurb** (`title + header-path + tags + linked-note titles`) — no LLM.
- **Incremental index:** per-chunk content hash; chokidar watcher, ~400 ms debounce; renames cheap via hash match.

## 6. The Sentinel (the differentiator)

**Contradiction detection** — on note create/edit, or on-demand `sentinel_check`:
1. **Claim Index lookup** — retrieve semantically-related prior *claims* (sentence-grained, not chunks — chunks are too coarse for pair contradiction).
2. **Assertion pre-filter** (the biggest precision lever) — only first-person, assertive, settled sentences. Drop questions, quoted/attributed spans (`>` blockquotes, "X said", citations), hedged/hypothetical/draft sentences, and zones the user marked non-settled (`## Counterarguments`, `#draft`/`#fleeting` tags, daily-note free-writing).
3. **Similarity cull** — rank related claims by **Nomic-embedding distance** (API), keep top-K above a similarity floor, capped at `JUDGE_BUDGET`. *No local NLI model* (per user 2026-05-23: API-only ML) — the Judge is the arbiter anyway; the assertion pre-filter (step 2, deterministic) does the heavy precision lifting before this.
4. **Judge** (the arbiter) via the **`Judge` interface** — default **tool-result-as-judge** (return candidates as `structuredContent`; the Claude session adjudicates contradiction vs agreement — zero key, works in every client). **Bias-hardened (arXiv 2509.26072 "Silent Judge"):** the contradiction call is **order-blinded + timestamp-blinded** — no recency/date cue, candidate order randomized, "ignore length" instruction — so the judge decides *contradiction-or-not* on content alone, never nudged toward the newer note.
5. **Temporal reframe — a SEPARATE deterministic step** (not the judge's job): once a contradiction is confirmed, compare `asserted_at` (git/frontmatter) and frame it — newer ⇒ *"You've changed your mind since [[A]] (Jan 14)"*, else a standing tension. Most vault "contradictions" are just learning, but the *framing* is computed by us, not inferred by a bias-prone LLM.
6. **Confirm-and-learn** — surface as a question with exact citations + one-click *not-a-contradiction / it's-an-update / reconcile*; every dismissal is a stored label that raises the threshold for similar pairs.

**Belief-drift** (`recall_history`) — on demand, walk git history + dated notes for a topic, hand the chronology to the Judge to *narrate the arc*. No maintained fact graph. (Frontier judge recommended; local judge is mushier — labeled.)

**Precision is the product.** Eval's **primary** metric is *false-positive rate on the user's own vault* (above recall). The demo gate is a measured FP number on Roger's real vault + a "messy notes" negative set, not a cherry-picked hit.

## 7. Standing intelligence

- **Epistemic Integrity view** (the standing artifact, novel) — whole-vault map built from the Claim Index + embeddings + NLI + git: clusters of mutually-contradictory claims, least-stable beliefs (most-revised), stale claims (asserted once, never reaffirmed, contradicted by newer notes), drift-vs-convergence per topic. Answers *"where is my thinking weakest / most in flux?"* — same engine as the Sentinel, aimed at the whole vault. A mirror for the structure of your thinking.
- **Ambient Inbox** — background loop deposits "things your vault noticed" into a dashboard note; triaged on the user's schedule. Strict notification budget; turned on **only after** the FP rate is proven. Needs a non-conversational judge (direct-API / local-LLM).
- **Ambient Capture** — Claude Code `Stop` hook distills decisions/insights into atomic notes (correct backlinks, dedup via Claim Index), into an **opt-in review queue** — no silent writes.

## 8. MCP surface

Transport: **stdio** (no HTTP → no DNS-rebinding exposure). All tools: `outputSchema` + `structuredContent`, correct `readOnlyHint`/`destructiveHint`. Server `instructions` (≤2 KB) front-loaded (Claude Code defers MCP tools → discovery depends on it). **No reliance on `sampling`/`elicitation`** (unsupported in flagship clients).

**Read** (`readOnlyHint`): `semantic_search`, `note_context` (flagship), `what_links_here`, `recall_history` (git temporal), `vault_diff`, `vault_stats`, `sentinel_check`, `epistemic_report`. *(P2: `note_ripple`, `graph_query`, `tag_map`, `moc_map`.)*

**Write** (dry-run + confirm; **our own tools**, FS atomic writes; REST bridge only when a headless run targets a live Obsidian): `create_note`, `edit_note`, `safe_rename_note` (rewrites every backlink/alias/embed). *(P2: `suggest_links`, `synthesize_moc`.)*

**Resources:** `note://{path}` + `vault://index`; `listChanged` on create/delete.

**HTTP security (REQUIRED — the daemon serves loopback HTTP for the Obsidian plugin):** pin TS SDK ≥1.24.0 (or apply `hostHeaderValidation`), **bind 127.0.0.1 only**, validate `Origin`/`Host` against a loopback allowlist, **require a bearer token on every request** (GHSA-w48q-cv73-mx4w DNS-rebinding). The Unix-socket path (Claude Code shim) has no network surface and needs only filesystem perms. Token lives in daemon config; the plugin reads it from a user setting.

## 9. Offline build & dependency centralization

**"Offline" = easy offline BUILD + local-first vault DATA. The ML runtime is whatever the user registered** — API providers and/or **local models (run in the daemon, never Obsidian)**. A fully-local registry (local embedder + local reranker + local LLM via Ollama/LM-Studio/TEI) yields a **true air-gapped runtime**; an all-API registry is cloud. The user chooses per category.

1. **Offline build** — pnpm `catalog:` centralizes versions; committed `pnpm-lock.yaml`; `pnpm fetch` → `rm -rf node_modules` → `pnpm install --offline --frozen-lockfile` against a warm/vendored store, on a **pinned pnpm version** (`11.0.7`, frozen). CI runs the install from a cold store on a **different arch** than `fetch` ran. **`sqlite-vec` + `better-sqlite3` are the only native deps**; pre-fetch their prebuilt binaries per platform. Build is fully offline-able.
2. **Runtime = the provider registry** — the three model categories (embedder / reranker / LLM) are bound to whatever the user registered: cloud APIs, local endpoints, or a mix. No ML models are *bundled* with VaultNexus; local ones are the user's own, called over a local endpoint from the **daemon** (not Obsidian → no SC freeze).
3. **What's always local:** the vault markdown, the SQLite index (`sqlite-vec`+FTS5), the link/claim graph, all deterministic code (parser, chunker, assertion filter, RRF, git). **Privacy:** with API providers, note text leaves the machine at index/query time — state this; with a local registry, nothing leaves. The README surfaces this per chosen provider.

**Distribution:** **MCPB bundle** with vendored `node_modules` = primary (Node ships inside Claude Desktop/Code; only `sqlite-vec`/`better-sqlite3` natives ride along, per-platform). `npx -y @vaultnexus/mcp` = online convenience. `claude mcp add --transport stdio -- …` for dev.

**Secrets:** keys via env (`VOYAGE_API_KEY`), never committed; `.gitignore` covers the `.db`, model caches, `.env`.

## 10. Explicitly rejected (kept for the record)

- **Persistent bi-temporal LLM fact graph** — contradicts the thesis, drifts, costly. *Distinct from the Claim Index, which is sentence-grained, deterministic, non-LLM, rebuildable — the same kind of derived/disposable artifact as the link graph. The Claim Index is restored; the fact graph stays dead.*
- **HippoRAG PPR + global PageRank** — hub-bias on sparse vaults, hurts single-hop.
- **Anthropic Haiku contextual-prefix** — redundant with, and worse than, the contextual embedder.
- **MCP `sampling` / `elicitation`** — unsupported in Claude Code/Desktop, sampling deprecated protocol-wide.
- **Plugin-first / monorepo (now)** — over-rotated; renderer can't host models; reverts to one headless package, plugin as P2.
- **Orama / LanceDB as default store** — Orama: 512 MB ceiling, no locking; LanceDB: native-binding sprawl breaks air-gap + can't load in a renderer.
- **Routing in-process writes through REST; two MCP servers to the client** — write contradiction + tool-overlap confusion.
- **RAPTOR / GraphRAG community summaries / ColBERT / Ebbinghaus resurfacing** — low marginal value for single-user; defer or never.
- **Forking `cyanheads/obsidian-mcp-server`** — vendor its edit-tool *module* (Apache-2.0) as reference; don't fork as skeleton.

## 11. Evaluation

- Golden **Q→note** set from the user's own vault; Recall@k, MRR, **NDCG@10**.
- A/B switchboard (dense / +BM25 / +expansion / +rerank) → the failure-rate ladder that *proves* each addition.
- **Sentinel: false-positive rate is the primary metric**, with a "messy notes" negative set (quotes, questions, hypotheticals, paraphrases). Per-vault NLI-threshold + assertion-filter calibration. Contradiction recall on a hand-built set secondary.
- Every eval run records the active graph source (canonical vs parser) → reproducible.

## 12. Phasing

- **P0 — scaffold:** Node package, pnpm catalog, SQLite + sqlite-vec + FTS5, `core` interfaces, FS parser + chunker, config file, CI (incl. cold-store cross-arch offline build). **Prove-it-early spikes:** validate the NLI ONNX model runs end-to-end in Node, and each embedding provider round-trips.
- **P1 — retrieval base (ships fast, already category-leading):** incremental hash-cache index, `semantic_search` / `note_context` / `what_links_here` / `create_note` / `edit_note` (FS atomic), rerank, **Claim Index**, eval harness (incl. FP negative set), stdio MCP server, Voyage-4 + Ollama-bge-m3 providers + local reranker.
- **P1.5 — the differentiator:** 🎯 Sentinel (`sentinel_check`: claim lookup → assertion filter → NLI cull → tool-result-judge → temporal reframe → confirm-loop), `recall_history`, `safe_rename_note`.
- **P2:** **Epistemic Integrity** standing view, Ambient Inbox (after FP proven) + direct-API/local judge, Ambient Capture (Stop hook), gardening (`suggest_links`/orphan/`synthesize_moc`), MCPB bundle, **optional Obsidian plugin** (canonical graph + live `/active/` context + settings UI), remaining read tools.
- **P3 / moonshot:** cross-source life-graph (vault + GitNexus code-graph + read-later), learned per-user fusion weights, multimodal "see-the-graph" reasoning.

## 13. Open questions

- Embedding model: **Nomic Atlas API** `nomic-embed-text-v1.5` (768-dim, `task_type` prefix) — API only, no local model. Confirm dim (768 vs Matryoshka 512) + Atlas rate limits/pricing/free-tier on a sample vault.
- Sentinel cull = embedding-similarity + Judge (no local NLI). Watch Judge volume per check (bound via `SIM_FLOOR` + `JUDGE_BUDGET`); revisit if precision/cost needs a cheap pre-cull.
- Vault path + git-backed? (enables temporal/drift) — from config at first run.
- sqlite-vec vault-size ceiling vs a pure-JS fallback — measure; document the crossover.
- Headless graph parity vs `metadataCache` — measure divergence on a sample vault; document the known-unequal cases (shortest-path, case-fold, embeds).
