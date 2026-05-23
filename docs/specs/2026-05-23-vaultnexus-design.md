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
| Store | **SQLite + sqlite-vec + FTS5** (vectors + BM25 + RRF; relational link + claim tables; CTE traversal) | Orama — chosen only for the renderer constraint we removed; 512 MB snapshot ceiling, no locking, last-write-wins data loss. Kept as a pure-JS fallback only |
| Embeddings | **Nomic Atlas API** (`nomic-embed-text-v1.5`, 768-dim, `task_type` prefix) — **API only, no local embedding model** | per user 2026-05-23: no non-API embedding LLM. Ollama-local + bge-m3 dropped |
| Sentinel cull | **embedding-similarity** (Nomic API) → Judge | local DeBERTa NLI — dropped (API-only ML; kills the ONNX risk + transformers.js/onnxruntime) |
| Reranker | **Voyage rerank-2.5 always** (assume API reachable, even in local-first mode) | local cross-encoder — dropped per user; Voyage assumed available at runtime |
| Sentinel judge | **`Judge` interface**: tool-result-as-judge (default, zero-key) / direct-API / local-LLM | **MCP `sampling`** — dead in Claude Code/Desktop, deprecated protocol-wide |
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
│   ├── providers/ Nomic Atlas API embeddings; Voyage rerank-2.5 API;
│   │              tool-result Judge. NO local ML models (no Ollama/ONNX).
│   ├── server/    stdio MCP server (tools, resources, instructions)
│   └── index/     FS walk + chunker + parser + chokidar watcher + hash-cache
├── docs/specs/    this document
└── (README, LICENSE-MIT, .gitignore, pnpm-workspace.yaml, MCPB manifest)
```

`core` stays I/O-free and unit-testable; all file/network/persistence is injected through interfaces. This keeps the door open to a future plugin (a second `VaultReader`/`LinkGraphSource` impl) without a rewrite — but we do NOT split packages until that second consumer exists.

### Data stores (single SQLite file per vault)
- **sqlite-vec** — chunk embeddings (ANN; int8/Matryoshka to control size).
- **FTS5** — BM25 full-text; fused with vector via **RRF** (k≈60).
- **`links` table** — `(src, dst, type, heading, block, alias)`; 1–2 hop expansion via recursive CTE. Built from a markdown parser (headless) or, if a plugin is present, from Obsidian `metadataCache.resolvedLinks` after its `resolved` event (tagged as canonical; never merged with parser output).
- **`claims` table** — the Claim Index (§6): sentence-grained, deterministic, content-hash-invalidated.
- **content-hash cache** — re-embed only changed chunks.
- *Note:* one writer at a time. A heartbeat **lockfile** guards the db; no lock → read-only mode (reads still served). Snapshots/writes are atomic (temp + fsync + rename). sqlite-vec is one native module — document its single prebuilt-binary step for air-gap (unlike LanceDB's 8-platform sprawl, which is why LanceDB is rejected here).

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
4. **Judge** (the arbiter) via the **`Judge` interface** — default **tool-result-as-judge** (return candidates as `structuredContent`; the Claude session adjudicates contradiction vs agreement vs update, w/ attribution/hypothetical/temporal — zero key, works in every client). Optional direct-API judge for the non-conversational standing view.
5. **Temporal reframe** — if the conflicting note is newer, surface as *"You've changed your mind since [[A]] (Jan 14)"*, not "you contradict yourself." Most vault "contradictions" are just learning.
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

**Future plugin (P2) security:** if it ever serves MCP over HTTP, pin TS SDK ≥1.24.0 (or apply `hostHeaderValidation`), bind loopback only, validate Origin/Host, require a bearer token on every request (GHSA-w48q-cv73-mx4w). Not applicable to the stdio engine.

## 9. Offline build & dependency centralization

**"Offline" = easy offline BUILD + local-first vault DATA. The ML runtime is API-based (Nomic + Voyage) — there are NO local ML models** (per user 2026-05-23). So there is no air-gapped *runtime*; the build is offline-able, the data is local, the inference is cloud.

1. **Offline build** — pnpm `catalog:` centralizes versions; committed `pnpm-lock.yaml`; `pnpm fetch` → `rm -rf node_modules` → `pnpm install --offline --frozen-lockfile` against a warm/vendored store, on a **pinned pnpm version** (`11.0.7`, frozen). CI runs the install from a cold store on a **different arch** than `fetch` ran — the only real proof. **`sqlite-vec` + `better-sqlite3` are the only native deps** (no ONNX/transformers anymore); pre-fetch their prebuilt binaries per platform. Build is fully offline-able.
2. **Runtime (API-based)** — embeddings via **Nomic Atlas API**, rerank via **Voyage `rerank-2.5` API**, Sentinel cull via embedding-similarity (Nomic), Judge via the host Claude session (tool-result-as-judge, zero-key). No Ollama daemon, no ONNX, no local model files. Needs network at query time.
3. **What's local:** the vault markdown, the SQLite index (`sqlite-vec`+FTS5), the link/claim graph, all deterministic code (parser, chunker, assertion filter, RRF, git plumbing). Privacy note: note text is sent to Nomic/Voyage at index/query time — state this plainly (no on-device embedding option in this build).

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
