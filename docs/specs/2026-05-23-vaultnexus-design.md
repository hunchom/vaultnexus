# VaultNexus — Design Spec

> **VaultNexus doesn't just search your second brain — it argues back.**
> A Claude Code ↔ Obsidian knowledge engine: best-in-class semantic + graph retrieval over your vault, plus a Sentinel that catches you contradicting yourself and shows how your thinking drifts over time. Plugin-first, MCP-exposed, fully offline-capable, one-command GitHub build.

Status: **Design — pending user approval**
Date: 2026-05-23
Spec owner: Roger

---

## 1. Problem & opportunity

Existing Obsidian AI tools fall in three buckets, and all leave the same gap:

- **Smart Connections** (5k★) — local 384-dim `bge-micro` cosine similarity, no graph reasoning, no API/MCP, no write-back.
- **basic-memory** — good data model (typed observations + relations in markdown), but flat, atemporal retrieval.
- **Every Obsidian MCP server** — thin CRUD-over-REST wrappers. The only one doing real semantic search (`jacksteamdev`) **archived 2026-05-13**. The Local REST API plugin now ships built-in `/mcp/` CRUD, commoditizing the write-tool layer.

**Nobody** does: (a) frontier-grade semantic retrieval fused with the wikilink graph, exposed over MCP; (b) a tool that *protects the integrity of your thinking* by surfacing contradictions and belief-drift. That second one is genuine white space — confirmed unbuilt.

The timing is ideal and the moat is the **retrieval brain + the Sentinel**, not CRUD.

## 2. Goals / non-goals

**Goals**
- Best-quality retrieval over a personal vault: hybrid (vector + BM25) + bounded wikilink expansion + cross-encoder rerank, cited to `path#heading^block`.
- The **Contradiction & Belief-Drift Sentinel** as the defining, novel capability.
- **Plugin-first**: run in-process in Obsidian for the canonical link graph; serve MCP over HTTP so every MCP client (Claude Code, Desktop, Cursor, Copilot, Smart Composer) can use it; ship a headless stdio MCP for the Obsidian-closed/CI case.
- **Fully offline mode**: local embeddings + local reranker + local NLI via Ollama/transformers.js. Online mode (Voyage-4 + rerank-2.5) is the max-quality option, not a requirement.
- **GitHub-ready, offline-buildable, centralized deps**: pure-JS/TS stack (no native compilation), pnpm workspace + catalog, committed lockfile.
- Agentic write-back with verifiable, dry-run-by-default, link-safe edits.

**Non-goals**
- Competing on CRUD (delegate to Local REST API `/mcp/`).
- A persistent LLM-extracted entity/fact graph (killed — see §10).
- Multi-user / cloud sync. Single-user, local-first.
- Mobile (desktop-first; plugin may degrade gracefully).

## 3. Guiding decisions (and what was rejected)

| Decision | Choice | Rejected alternative & why |
|---|---|---|
| Language | **TypeScript**, pure-JS deps | Python — against the Obsidian grain; native deps hurt offline build |
| Vehicle | **pnpm/turbo monorepo**: `core` + `plugin` + `mcp` | Standalone stdio-only — loses canonical graph + cedes plugin surface to competitor (`aaronsb/obsidian-mcp-plugin`) |
| Vector store | **Orama** (pure-JS: vector + BM25 + hybrid) | LanceDB — native `.node` binaries can't load in Obsidian's Electron renderer; hurts offline build. Kept behind interface for huge headless vaults only |
| Embeddings | **Provider interface**: Voyage-4 (online best) / **Ollama-local (offline default)** / OpenAI | Hardcoded Voyage — breaks offline + privacy; Voyage-4 > context-3 (newer, 3× cheaper, shared space) |
| Reranker | rerank-2.5 (online) / local cross-encoder (offline) | none — rerank is the single highest-ROI quality lever |
| Graph | wikilinks as free structure; **bounded 1-hop expansion** | HippoRAG PPR + global PageRank — drops single-hop QA 5–10 F1, hub-bias on sparse vaults, needs LLM extraction we reject |
| Temporal | **git history + mtime + frontmatter dates** | Graphiti bi-temporal LLM fact graph — contradicts thesis, drifts from notes, costly per-edit |
| Context | voyage/native contextual embedding + **deterministic** BM25 blurb | Anthropic Haiku contextual-prefix — double-pays for what the embedder already does, *worse* per Voyage benchmarks |
| Writes | delegate to Local REST API `/mcp/`; FS fallback | shipping our own CRUD tools — commoditized |
| MCP SDK | TS SDK v1.x, structured for v2 (Q1 2026) | — |

## 4. Architecture

```
vaultnexus/  (pnpm + turbo monorepo, pnpm catalog centralizes all dep versions)
├── packages/
│   ├── core/      pure-TS, ZERO native deps. compiles to node + browser.
│   │              chunking · ranking/RRF fusion · wikilink expansion ·
│   │              Sentinel engine · eval harness · INTERFACES (EmbeddingProvider,
│   │              VectorStore, Reranker, NLIJudge, VaultSource, Clock)
│   ├── plugin/    thin Obsidian shell. canonical graph via metadataCache
│   │              (+ backlink cache), live /active/ context, in-app UI,
│   │              SERVES MCP over Streamable HTTP on localhost.
│   └── mcp/       thin stdio shell. headless / CI / Obsidian-closed path.
│                  filesystem-first indexing. LanceDB backend permitted here.
├── docs/specs/    this document
└── (README, LICENSE-MIT, .gitignore, turbo.json, pnpm-workspace.yaml)
```

**Why this shape:** `core` holds the value and stays portable by contract (no native deps → runs in the Electron renderer AND node AND offline). The two shells are thin adapters over `core` interfaces. Clients point at whichever shell is running.

### Data stores
- **Orama** — chunk vectors + BM25 full-text + hybrid RRF. Pure-JS, persists to disk, runs everywhere. Default backend for both shells.
- **In-memory link graph** — adjacency built from `metadataCache.resolvedLinks` (plugin) or the parser (headless). Rebuilt on load; vaults are small (1k–50k notes). 1-hop expansion is a trivial lookup; deeper traversal via the same structure.
- **Temporal** — git (`log -p`, `show`) + file mtime + frontmatter dates. No separate temporal DB.
- *(Optional, behind `VectorStore` interface)* LanceDB for headless huge-vault users; SQLite if relational link queries ever justify it. Not in the default offline path.

### Embedding / rerank / NLI providers (pluggable)
- **Online (max quality):** Voyage-4 (`voyage-4-large` index / `voyage-4` query, shared Matryoshka space, 1024-dim int8) + `rerank-2.5`.
- **Offline (default for `--offline`):** Ollama embeddings (e.g. `bge-m3` / `nomic-embed-text`) + local cross-encoder reranker (bge-reranker via Ollama/transformers.js) + local NLI model for the Sentinel.
- Store `{provider, model, dims, dtype}` with the index; refuse cross-model queries (Voyage shared-space is the one exception).
- Reuse Smart Connections `.smart-env/` embeddings when present → instant first-run.

## 5. Retrieval pipeline

```
query
  → embed(query) → vector search (Orama)  ┐
  → query terms  → BM25 (Orama)           ┘→ Orama native hybrid RRF → candidate pool
        │
        ├─ bounded wikilink expansion: 1-hop neighbors of top seeds
        │     (2-hop only on explicit "explore/related" intent), capped fan-out, deduped
        │
        ├─ light structural boosts (small weight): recency (mtime/frontmatter),
        │     link-overlap-with-seeds, tag-match. NO global PageRank.
        │
        └─ rerank (rerank-2.5 online / local cross-encoder offline): ~20–30 in → 5–8 out
                │
                └─ return cited hits: { path, heading, blockId?, snippet, score }
```

- **Auto mode-switch:** small/cheap-enough vault → skip RAG, stuff the whole vault into context via prompt caching (retrieval *adds error* below a budget). Gated on a **cost/latency budget**, not a hard token line.
- **Chunking:** header-split → recursive 256–512 tok, ~10–15% overlap; never split code blocks/tables/callouts. Frontmatter/tags/links/header-path → metadata columns. **Deterministic BM25 blurb** prepended for lexical recall: `title + header-path + tags + linked-note titles` (no LLM).
- **Incremental index:** per-chunk content hash → re-embed only changed chunks. File watcher (chokidar headless / vault events in plugin), ~400ms debounce. Renames cheap via hash match.

## 6. The Sentinel (the differentiator)

**Contradiction detection** — on note create/edit:
1. Retrieve semantically-related prior claims (embeddings — already have).
2. Cheap **NLI filter** (local model) over candidate sentence/claim pairs → cull 99% of non-contradictions.
3. **Claude-as-judge** via MCP **sampling** (borrows the client's LLM — no extra key) on the high-confidence survivors.
4. Surface: *"Conflicts with [[Note]] (Jan 14): 'X'. Reconcile?"* — with exact citations.

**Belief-drift** — for a topic, walk git history + dated notes to show the trajectory of your stance over time (on-demand, over git — no maintained fact graph).

- Implemented **without** the rejected fact-graph: embeddings + on-demand NLI/judge + git temporal. Cheap, thesis-consistent.
- **Precision is the product.** A sentinel that fires on paraphrases gets muted in a week. The eval harness's **primary** metric is *false-positive rate on proactive surfacing*, ranked above recall.

## 7. Ambient layer

- **Ambient Inbox** — background loop deposits "things your vault noticed" (contradictions, knowledge gaps, stale-but-relevant notes, weekly synthesis) into a dashboard note / daily-note section. Triaged on the user's schedule — no interruptions. Strict notification budget (start weekly, go event-driven only as precision proves out).
- **Ambient Capture** — Claude Code `Stop`/`SubagentStop` hook feeds the transcript to an extraction pass → distills decisions/insights/gotchas into atomic notes with correct backlinks, into an **opt-in review queue** (no silent writes, no orphan/dup spam). Reuses the Sentinel's dedup.

## 8. MCP surface

Transport: **Streamable HTTP** (plugin) + **stdio** (headless). All tools: `outputSchema` + `structuredContent`, correct `readOnlyHint`/`destructiveHint`. Server `instructions` (≤2KB) front-loaded (Claude Code defers MCP tools → discovery depends on it). Uses **sampling** (Sentinel judge, synthesis) and **elicitation** (first-run config: provider, key, vault path).

**Read** (`readOnlyHint`): `semantic_search`, `note_context` (flagship: note + out/back-links + neighbors + tags), `what_links_here`, `recall_history` (git temporal — "what did I think about X in March"), `vault_diff`, `vault_stats`. *(P2: `note_ripple`, `graph_query`, `tag_map`, `moc_map`.)*

**Write** (dry-run + `elicit` confirm; delegate to REST `/mcp/` when Obsidian open, FS when closed): `create_note`, `edit_note`, `safe_rename_note` (rewrites every backlink/alias/embed). *(P2: `suggest_links`, `synthesize_moc`.)*

**Sentinel:** `sentinel_check` (on demand for a note/claim), `sentinel_review` (triage the inbox).

**Resources:** `note://{path}` (template, `@`-mentionable) + `vault://index`; `listChanged` on create/delete.

## 9. Offline build & dependency centralization

- **Pure-JS/TS only** — no native compilation in the default path (Orama, transformers.js, graphology are all pure-JS). Native LanceDB lives only in the optional headless backend, never required.
- **pnpm workspace + catalog** — `pnpm-workspace.yaml` `catalog:` pins every dependency version in one place; packages reference `catalog:`.
- **Committed `pnpm-lock.yaml`**; `pnpm install --offline` works against a warm store. Document populating the store (`pnpm fetch`) and an optional vendored `node_modules` tarball for air-gapped builds.
- **Offline runtime** — `--offline` selects Ollama embeddings + local reranker + local NLI; document one-time `ollama pull` of the required models. Zero network calls at query time in offline mode.
- **Secrets** — Voyage/OpenAI keys via env (`VOYAGE_API_KEY`), never committed; `.gitignore` covers index sidecars + `.env`.
- **One-command build** — `pnpm install && pnpm build` from a clean checkout, no external services for the offline path.

## 10. Explicitly rejected (kept for the record)

- **Persistent bi-temporal LLM fact graph** — contradicts the "wikilinks are the graph" thesis, drifts from notes, costly per-edit. Git gives real bitemporality free.
- **HippoRAG PPR + global PageRank** — hurts dominant single-hop queries, hub-bias on sparse vaults.
- **Anthropic Haiku contextual-prefix** — redundant with (and worse than) the contextual embedder.
- **RAPTOR / GraphRAG community summaries / ColBERT / Ebbinghaus resurfacing** — heavyweight, low marginal value for single-user; defer or never.
- **Forking `cyanheads/obsidian-mcp-server`** — reimplement its edit-tool *semantics* as a reference (Apache-2.0), don't vendor its framework.

## 11. Evaluation

- Golden **Q→note** set bootstrapped from the user's own vault (LLM reads a note → generates a question it answers). 25–100 pairs to start.
- Retrieval: Recall@k, MRR, **NDCG@10** (comparable to Voyage's published numbers).
- A/B switchboard across configs (dense / +BM25 / +expansion / +rerank) → the failure-rate ladder that *proves* each addition before it ships.
- **Sentinel: false-positive rate is the primary metric.** Plus contradiction recall on a hand-built set.

## 12. Phasing

- **P0 — scaffold:** monorepo, pnpm catalog, `core` interfaces, Obsidian-correct parser + metadataCache path, config/elicitation, offline-build setup, CI.
- **P1 — retrieval base (ships fast, already category-leading):** Orama hybrid index + incremental hash-cache, `semantic_search` / `note_context` / `what_links_here` / `create_note` / `edit_note`, rerank, eval harness, plugin shell + HTTP MCP, Voyage-4 + Ollama-local providers.
- **P1.5 — the differentiator (novel-first):** 🎯 Sentinel (contradiction + belief-drift) + Ambient Inbox + `recall_history` + `safe_rename_note`.
- **P2:** Ambient Capture, gardening (`suggest_links` / orphan / `synthesize_moc`), knowledge-gap detection, headless stdio shell + MCPB bundle, remaining read tools, selective agentic escalation.
- **P3 / moonshot:** learned per-user fusion weights, cross-source life-graph (vault + GitNexus code-graph + read-later), multimodal "see-the-graph" reasoning.

## 13. Open questions

- Default offline embedding model (`bge-m3` vs `nomic-embed-text`) — decide via eval on a sample vault.
- Vault path + whether it's git-backed (enables temporal features) — from user at first run via elicitation.
- Plugin distribution: Obsidian community review vs BRAT beta channel for early releases.
