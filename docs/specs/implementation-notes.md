# VaultNexus — Implementation Notes (build bible)

Distilled from 8 parallel implementation-research agents (2026-05-23). Companion to `2026-05-23-vaultnexus-design.md` (the design; this is the *how*). Everything here is build-ready: pinned versions, exact APIs, gotchas, and the P0 risks to retire first. Verified against live npm/docs May 2026.

> Convention: pin every version. Track no `latest`. All quoted error strings / model ids / issue numbers are verbatim.

## 0. Pinned versions (one source of truth → pnpm catalog)

| Dep | Version | Note |
|---|---|---|
| node | **>=22** (`.nvmrc=22`) | matches Claude Desktop's bundled Node (ABI 127) |
| pnpm | **11.0.7** (frozen) | offline-fetch regressions; freeze one patch for the whole air-gap cycle |
| **postgres (default)** | PG **17** + pgvector **0.8** | embedded via `embedded-postgres` (npm prebuilt, no Docker); driver `pg` 8.x; MVCC |
| pgvectorscale / pg_search | latest | **opt-in `PG_URL` tier** (StreamingDiskANN / Tantivy BM25); pg_search AGPL = server-only |
| undici / p-queue / Piscina | latest / 8.x / 4.x | HTTP pools / API concurrency+backpressure / worker-thread parse-chunk pool |
| better-sqlite3 (fallback) | 12.x (≥12.10.0) | FTS5 built-in; ABI-bound native `.node` |
| sqlite-vec (fallback) | 0.1.9 | loadable ext, pure optionalDependencies (clean air-gap); brute-force only (ANN is 0.1.10-alpha) |
| @modelcontextprotocol/sdk | ≥1.24.0 (1.29.x ok) | ≥1.24.0 only matters if HTTP (DNS-rebinding); stdio fine |
| zod | 4.x | SDK accepts v3/v4/Standard-Schema |
| ~~@huggingface/transformers~~ | — | **DROPPED** (no local ML models per user 2026-05-23) |
| ~~onnxruntime-node~~ | — | **DROPPED** (no local NLI/reranker) |
| ~~ollama~~ | — | **DROPPED for embeddings** (Nomic Atlas API instead) |
| unified / remark-parse / remark-gfm / remark-frontmatter | 11 / 11 / 4 / 5 | mdast pipeline |
| gray-matter + js-yaml | 4.0.3 + 4.1.1 (inject yaml) | frontmatter |
| sentence-splitter | 5.x | Claim-Index segmentation (preserves offsets) |
| gpt-tokenizer | 3.x (`o200k_base`) | chunk-size *proxy* only, not billing-exact |
| chokidar | 4.x | watcher; v4 dropped globs+rename → watch dir, filter in code |
| tsup | 8.x | ESM-only, `target node22`, native deps external |

## 1. Storage engine (`src/store/`) — pluggable `Store`, PostgreSQL-default (no Docker)

- **DEFAULT `PostgresStore` = daemon-managed embedded PostgreSQL 17 + pgvector 0.8** (driver `pg` async + `pg.Pool`). Prebuilt PG binaries via `embedded-postgres` (npm, 5 platforms) — **no Docker, install-nothing**; daemon owns lifecycle. **MVCC → unlimited concurrent r/w** ⇒ the SQLite lockfile + WAL-single-writer are **deleted**. DDL: `chunks.embedding vector(dim)` + HNSW (`vector_cosine_ops`, 0.8 iterative-scan for filtered ANN); FTS = `tsvector` **generated column** + GIN + `ts_rank_cd` (no sync triggers); `links`/`claims`/`vec_claims`/`content_hash` as before; recursive-CTE graph + RRF CTE port verbatim. Throughput: **reader+writer pools** (no PgBouncer), prepared statements, `COPY`/multi-row insert.
- **Overkill tier (opt-in `PG_URL`, no Docker required):** own Postgres + **pgvectorscale** (StreamingDiskANN) + **pg_search** (Tantivy BM25) via prebuilt extension packages; daemon detects → DiskANN+Tantivy paths. pg_search AGPL → server-only, never bundled.
- **FALLBACK `SqliteStore`** (zero-server, smallest air-gap, CI smoke) ↓ keeps the full sqlite-vec design below:
- **Driver: `better-sqlite3`** (sync, FTS5 built-in). `node:sqlite` rejected — no FTS5. Pragmas every connection: `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=5000`.
- **Vectors: `sqlite-vec`** via `import * as sqliteVec from 'sqlite-vec'; sqliteVec.load(db)` → resolves `sqlite-vec-<os>-<arch>/vec0.<ext>`. 5 triples; **no musl/Alpine, no win-arm64** (build from source there).
- **Schema** (full DDL in the sqlite-vec agent report): `index_meta`(embedding fingerprint), `notes`, `chunks`, **`vec_chunks`** vec0 `float[<model-dim>] distance_metric=cosine` (768 for Gemini-768/Nomic; → `int8[]` at scale), **`fts_chunks`** FTS5 external-content (+3 sync triggers — mandatory), `links`(src,dst,type,heading,block,alias,source), `claims`, **`vec_claims`** (sentence-grained vec0), soft-delete via `state`. **Use a vec0 `partition key` column** (folder/notebook) — shipped in 0.1.9 — to pre-filter before the brute-force scan; raises the comfortable-scale ceiling past 250k without ANN.
- **Hybrid RRF** = single CTE: vec KNN ⟗ FTS5 `FULL OUTER JOIN`, `1/(k+rank)`, **k=60**, equal weights, pool 50 → final ~30 → reranker. (sqlite-vec has no native RRF.)
- **Wikilink expansion** = recursive CTE over `links`, `UNION` (cycle-safe), undirected, depth 1 (2 on explore), `LIMIT max_neighbors`.
- **Scale (answers design §13):** brute-force; **<75 ms @ 100k×1024 float32** (768-dim Nomic is faster/smaller); comfortable ≤250k; warn ~400k → switch `int8` (`vec_quantize_int8`, 4× smaller); binary/ANN beyond. Storage @768: float32 3 KB/vec, int8 768 B, binary 96 B.
- **Concurrency:** WAL = many readers + 1 writer. App-level **heartbeat lockfile** `<db>.lock{pid,host,mtime}`; no lock → read-only mode (reads still served). Atomic note writes = temp + `fsync` + `rename`. One writer connection (indexer), separate reader connection(s) (server).
- **Migrations:** `PRAGMA user_version` ladder + `index_meta` fingerprint. dims/dtype/metric change → drop+recreate vec0 + re-embed. **Key the content-hash cache by model** → model swap auto-invalidates + re-embeds.

## 2. Parsing & chunking (`src/index/`)

- **Stack:** `unified` + `remark-parse` + `remark-gfm` + `remark-frontmatter(['yaml'])` → mdast. Keep frontmatter **in the string** (gate w/ remark-frontmatter) so `position.offset` stays true for provenance; use `gray-matter` (+ injected `js-yaml` 4) for typed YAML values.
- **⚠️ Biggest build item — DIY wikilink resolution.** No lib does block-refs + Obsidian shortest-path. Use `micromark-extension-wiki-link` + `mdast-util-wiki-link` (landakram, MIT) as **tokenizer only**; implement resolution in `core`. (`remark-obsidian` is **GPL-3.0** → banned; `remark-obsidian-md` is MIT + most-complete but **1★, no block-refs** → don't adopt; `@portaljs/remark-wiki-link` stale → reference only.)
- **OFM extras (block-refs/callouts/comments): copy only the DELTA from Quartz `ofm.ts`** (MIT), not the whole file — the remark+micromark stack already covers `[[ ]]`/frontmatter/gfm; only `^block-id`, callout `[!type]`, and `%%comment%%` handling are missing from npm. (No npm pkg ships block-refs — confirmed across the field.)
- **Resolution precedence:** exact-path → exact-name(ci, ignore `.md`) → normalized(space/`-`/`_` equivalent) → **shortest-distinguishing-path** tiebreak; attachments keep extension; subpath `#heading`/`#^block` resolved against target's parsed structure; unresolved → recorded, never auto-created.
- **⚠️ NFC normalization mandatory** on both filenames and link text (macOS hands back NFD → silent unresolved links). Key = `lower(NFC(name)).replace(/[\s_-]+/g,' ').trim()`.
- **Tags** from `text` nodes only (skip code/links); charset `[\p{L}][\p{L}\p{N}_/-]*`, not all-numeric; emit nesting prefixes. **Block-ids** `^id` via regex on leaf-node source slice. **Dataview** `key:: value` (3 forms) on `text` nodes, require whitespace/bracket boundary.
- **Chunker: depend on `chonkie` (chonkie-ts, MIT)** for recursive packing + **native `startIndex`/`endIndex` offsets** (kills the bespoke offset math — the most bug-prone part). Feed custom `RecursiveLevel.delimiters` (`["\n## ","\n### ","\n\n","\n", …]`; the `markdown` recipe is Python-only). **Build only the OFM-zone-guard pre-pass** (~50 LOC): emit code fences/tables/callouts as atomic units *before* handing prose to chonkie, then merge offsets — chonkie does NOT guarantee code/table integrity. Target 512 tok (min 256), ~10–15% overlap. **Deterministic BM25 blurb** = `title — header-path — tags — linked-note-titles` (FTS column only). Token budget via `gpt-tokenizer` o200k (proxy). (benbrandt `text-splitter` is technically best but Rust/Python-only — no npm/wasm; revisit as a P3 wasm-bridge spike.)
- **Sentence segmentation (Claim Index):** `sentence-splitter` per-leaf-block on `mdast-util-to-string` flattened text + `block.position.start.offset` base → **exact file offsets** per sentence → `path#heading^block` provenance. Skip code/tables/callouts/quotes.
- **Link graph:** forward-links → `links` table; backlinks = SQL inversion (`WHERE dst=?`); no materialized reverse map. Tag rows `source='parser'|'canonical'` — never merge. Incremental: on change, delete file's rows + re-insert; recheck unresolved touching the changed filename.

## 3. Embedding providers (`src/providers/`)

- **Interface** (`core`): `embed(texts, {kind:'doc'|'query'}) → {vectors, usageTokens?}` + **sync `descriptor{providerId, modelId, dims, dtype, spaceId, normalized}`**. `kind` mandatory. Provider owns batching.
- **Embeddings = pluggable provider REGISTRY** (per user 2026-05-23: not pinned to one model). All providers are API/endpoint adapters behind `EmbeddingProvider`; user picks via config. Ship adapters for: **Nomic** (Atlas API + the nomic-ai HF family: `nomic-embed-text-v1.5`, `v2-moe`), **Google Gemini** (`gemini-embedding-001`), **EmbeddingGemma**, **Voyage-4**, **OpenAI-3**, **Cohere/Jina**, and a **generic OpenAI-compatible** adapter (any base URL → covers self/hosted open models). Each maps `kind:'doc'|'query'` → that model's task-prefix/`input_type`/`task_type` convention.
- **Dims are MODEL-DRIVEN** (e.g. Nomic 768, Gemini up to 3072 w/ Matryoshka, EmbeddingGemma 768). vec0 column dimension is set from the active model's `descriptor.dims` **at index time**; a model switch → drop+recreate vec0 + re-embed (already handled by `index_meta` fingerprint). **Env**: `EMBEDDING_PROVIDER`, `EMBEDDING_MODEL`, `EMBEDDING_DIMS`, `EMBEDDING_BASE_URL`, `<PROVIDER>_API_KEY`.
- **DEFAULT = `gemini-embedding-001` @ 768-dim** (Matryoshka 3072→768) — #1 MTEB-English-v2 (68.32), keeps the 768 vec0 schema, `task_type=RETRIEVAL_DOCUMENT/RETRIEVAL_QUERY` ← `kind`, $0.15/1M ($0.075 batch). **Privacy default** = `embeddinggemma-300m` @768 via the generic adapter (Ollama/Vertex/TEI), one-line env swap. **Apache baseline** = `nomic-embed-text-v1.5` @768.
- **STEAL — don't write 8 adapters: depend on Vercel AI SDK v6** (`ai` + `@ai-sdk/*`, Apache-2.0, 24k★). It unifies all 3 categories: `embed()`/`embedMany()` (`maxParallelCalls` batching), native **`rerank()`** (AI SDK 6, Dec 2025), `generateText()` — across OpenAI/Google/Anthropic/Cohere/Mistral/Bedrock + **local** via `@ai-sdk/openai-compatible` + Ollama community provider. Voyage via `voyageai-ai-provider` (embed + rerank); Nomic via openai-compatible. `EmbeddingProvider`/`Reranker`/`Judge` (`core/`) = thin pass-throughs to `embed`/`rerank`/`generateText`. Registration via `createProviderRegistry`/`customProvider` aliasing each registered model → role. At most ONE ~30-line `RerankingModelV2` adapter for long-tail local rerankers. (host-session judge stays a special non-AI-SDK `Judge` impl.)
- **Endpoint types (user 2026-05-23): must support OpenAI-format + OpenRouter.** `@ai-sdk/openai-compatible` = any OpenAI-format base-URL (LM-Studio/llama.cpp/vLLM/TEI/Together/Groq/Nomic/self-host) for embed+chat; `@openrouter/ai-sdk-provider` = OpenRouter (chat/LLM only — no embeddings → LLM/judge category). Registry entry = `{category, providerType, baseURL?, apiKeyEnv, modelId}`.
- **Recommender data — pull, don't hardcode:** vendor `models.dev/api.json` (chat cost+context) + LiteLLM `model_prices_and_context_window.json` (embeddings cost **+ `output_vector_size` dims** — models.dev omits embeddings). Refresh on a cadence; tiny override map for brand-new local models. Add `EMBEDDING_TASK_DOC`/`EMBEDDING_TASK_QUERY` overrides for open models that disagree on prefix wording.
- **Matryoshka `reduce_dims` migration:** to shrink an existing index (768→512/256) **truncate stored vectors + L2-renormalize locally — no re-embed** (distinct from the model-swap re-embed path). Storage ladder @768: f32 3KB → int8 768B → binary 96B; ×3 more via 768→256. ⚠️ `nomic-embed-text-v2-moe` ctx = **512 tok** (chunks only, self-host only).
- **Model-switch guard:** compare **`spaceId`** (e.g. `nomic-v1.5:768:float32`); real change → confirmed full re-embed (atomic db swap). Content-hash cache keyed by model.
- **Cost:** Nomic Atlas has a free tier; check rate limits + per-1M pricing before a big cold index. Voyage rerank → 200M free. Incremental hash-cache → ~$0 after cold index. **Privacy: note text is sent to Nomic + Voyage** at index/query time — no on-device option in this build; state plainly in the README.

## 4. Rerank + contradiction cull + assertion filter (`src/providers/`, `core/sentinel/`)

- **Reranker interface:** `rerank(query, candidates, {topK, instruction?}) → [{id,index,score}]`. Pool ~20–30 → 5–8.
- **Reranker = Voyage `rerank-2.5` API (default)** `POST /v1/rerank`; **instruction prepended to the `query` string** (no separate field); `top_k`; $0.05/M, 200M free. **+ `zerank-2` (ZeroEntropy) as a 2nd adapter** — ELO #1, $0.025/M, **Apache-2.0 self-hostable → the privacy/air-gap reranker**. Both fit `rerank(query, candidates, {topK, instruction?})` unchanged. (Cohere rerank-v4 / Jina-reranker = further alts.)
- **Contradiction cull = embedding-similarity** (Nomic API), NOT a local NLI model (per user 2026-05-23). Rank related claims by cosine distance, keep top-K above `SIM_FLOOR`, cap at `JUDGE_BUDGET` → hand to the Judge. **Dropped:** `Xenova/nli-deberta-v3-small`, `@huggingface/transformers`, `onnxruntime`, the DeBERTa ONNX gremlins, and all NLI thresholds (`NLI_CONTRA_HI`/`NLI_ENTAIL_CAP`). The Judge (host Claude session) is the arbiter; precision rests on the assertion filter + Judge.
- **Assertion pre-filter (biggest FP lever): rules-first, deterministic, ZERO models** (regex + lexicon + chunk-metadata zone drops). KEEP: first-person + assertive + settled. DROP: questions, quoted/attributed, hedged/modal, hypothetical/conditional, future-intent, imperative, fragments, non-settled zones (`## Counterarguments`, `#draft`/`#fleeting`, daily notes). (SetFit dropped — it's a local model.)
- **No model vendoring / air-gap weights** — there are no local ML models in this build.

## 5. MCP server (`src/server/`)

- **SDK `@modelcontextprotocol/sdk` 1.29.x, stdio.** Imports need `.js` suffix (`/server/mcp.js`, `/server/stdio.js`). `new McpServer({name,version},{instructions, capabilities:{resources:{listChanged:true}}})`. **Never `console.log` to stdout** (corrupts JSON-RPC) → stderr / `sendLoggingMessage`.
- **Tools:** `registerTool(name,{title,description,inputSchema,outputSchema,annotations,_meta},handler)`; return `{content:[{type:'text',text:JSON.stringify(out)}], structuredContent:out}`. Annotate reads `readOnlyHint:true, openWorldHint:false`; writes `readOnlyHint:false`; rename `destructiveHint:true`. Errors → `{isError:true, content:[text]}` (no structuredContent on error).
- **Dry-run + confirm (writes):** 2-call + `expectedHash` (TOCTOU guard) — *keep this even though Claude Code now supports elicitation* (portability + concurrency safety). confirm=false → diff/preview/brokenLinks/expectedHash; confirm=true + expectedHash → re-check hash, atomic write.
- **Resources:** `note://{path}` template w/ `complete:{path:(v)=>string[]}` (returns bare `string[]`) + `vault://index`; fire `sendResourceListChanged()` on chokidar add/unlink.
- **`instructions` ≤2 KB** (front-loaded — Claude Code defers tools via Tool Search; discovery depends on it). Draft written (mcp-server agent report).
- **Output budget:** 10k warn / 25k cap (`MAX_MCP_OUTPUT_TOKENS`); `_meta["anthropic/maxResultSizeChars"]` (≤500k) only on big-blob tools (`note_context`, `epistemic_report`), NOT `semantic_search`; paginate everything (cursor/nextCursor), snippets not bodies.
- **Registration:** `claude mcp add --transport stdio --scope project --env VOYAGE_API_KEY=$VOYAGE_API_KEY --env VAULTNEXUS_VAULT_PATH=... vaultnexus -- node dist/server/index.js`. `.mcp.json` w/ `${VAR:-default}` (unset+no-default → whole config fails to parse), `timeout:600000` (first index). stdio servers NOT auto-reconnected → be robust.

## 6. Sentinel + Epistemic Integrity (`core/sentinel/`)

- **Cascade = recall-funnel → precision-gate:** claim-grained ANN (active embed provider) → candidate bound (topic gate + temporal cone + `SIM_FLOOR`) → assertion pre-filter → **Judge (arbiter, bias-hardened)** → temporal reframe (deterministic) → label gate → emit. No local NLI (the relevance-cull→classify split is itself validated by arXiv 2508.17127). Assertion filter + Judge (~0.9 precision) carry precision; bound Judge volume with `SIM_FLOOR` + `JUDGE_BUDGET`.
- **Judge bias-hardening (arXiv 2509.26072):** contradiction call is **order-blinded + timestamp-blinded** (randomize candidate order, strip dates/recency, "ignore length"). Temporal "you changed your mind" framing is a **separate deterministic step** on `asserted_at` AFTER the verdict — never fed to the judge (else recency bias).
- **Claim extraction:** assertion pre-filter (deterministic) **+ AFEV reverse-check** (arXiv 2506.07446: ask the LLM to confirm each atomic claim is faithful-to-source + standalone/de-deixis) → sharper Claim Index.
- **Output format:** render Sentinel hits as Obsidian **`[!contradiction]` callouts** (steal the format from `claude-obsidian`, MIT) — native, clean, dismissable.
- **`ClaimRecord`:** raw+canonical text, polarity, topic_key, `asserted_at`(git/frontmatter/mtime) vs `observed_at`, source_zone, `state`(active/superseded/retracted)+`superseded_by`, `content_hash`+`filter_version`. Soft-delete retracted (drift history).
- **Judge = tool-result-as-judge (default, zero-key, every client):** `sentinel_check` returns candidates as `structuredContent` + a `VERDICT_RUBRIC` ({CONTRADICTION, UPDATE, NOT_CONTRADICTION, PARAPHRASE}) → live Claude session adjudicates → `resolve_sentinel{id,verdict}` writes the label. Direct-API/local-LLM judge for the non-conversational standing view.
- **Params (per-vault calibratable):** `K_ANN=50, SIM_FLOOR=0.55, JUDGE_BUDGET=8, JUDGE_EMIT_MIN=0.70` (precision dial), `EMIT_CAP=5`. (NLI thresholds removed — no NLI stage.)
- **Scale:** incremental (only changed claims) + ANN + topic gate + Judge-budget → **per-edit cost constant in vault size**.
- **Confirm-and-learn (3-tier suppression):** exact-pair (hard, permanent, `pair_fingerprint` survives edits) → embedding-neighborhood (threshold-lift, `SUPPRESS_RADIUS=0.90`) → per-topic (lift after N≥3, decays). Checked **before** Judge compute → dismissed pairs cost ~0.
- **Belief-drift (`recall_history`):** `git log -G<topic> --all` → `git show <sha>:<path>` re-derive claims → **arc compression** (narrate only stance-change points via embedding-distance) → Judge narrates. Needs git-backed vault (else mtime/frontmatter fallback).
- **Epistemic Integrity view (P2 batch):** contradiction graph → connected-components + **Louvain** clusters (edge weight=Judge confidence, reuse cached verdicts); least-stable (git revision count); stale (¬reaffirmed ∧ old ∧ contradicted-by-newer); drift-vs-convergence (stance-embedding variance over time).
- **Precision tactics ranked:** zone+assertion filter (#1) > Judge-arbiter (#2) > temporal reframe (#3) > confirm-learn (#4) > `SIM_FLOOR`/similarity cull (#5) … + failure-mode→mitigation table (sentinel agent report).

## 7. Eval harness (`core/eval/`, `src/eval/`)

- **Golden Q→note:** LLM reads a chunk → generates a question it answers; source chunk = gold. Anti-leakage prompt rules ("no verbatim phrases / no deixis"), answerability + retrievability gates, dedup (exact/semantic/per-note-cap). **25 bootstrap → 100 proof** (tight CIs). JSON keyed by vault-hash; record generator model + prompt SHA.
- **IR metrics:** Recall@k, MRR, **NDCG@10** (`2^rel−1` gain) — **validate against `pytrec_eval`** so numbers are Voyage/BEIR-comparable. `Fail@20 = 1−Recall@20` = Anthropic analog.
- **A/B switchboard:** `dense → +bm25 → +expand → +rerank → +claim` via a `RetrievalConfig` toggle (same index reused) → failure-rate ladder + **bootstrap CI + paired permutation test** (claim a win only at p<0.05).
- **Sentinel FP (PRIMARY metric):** "messy notes" negative set across 8 categories (quoted/question/hypothetical/hedged/paraphrase/negation-overlap/temporal-update/different-subject), built by **mining the vault at low similarity threshold + hand-label**; positive set by mining + controlled synthetic injection. **Per-vault calibration loop:** sweep `SIM_FLOOR` × assertion-mode × `JUDGE_EMIT_MIN` → pick highest recall s.t. FP ≤ target (default 5%). This is the demo gate.
- **RAGAS** (faithfulness/answer-rel/context-precision/context-recall): lightweight TS reimpl on existing Judge+Embedding (copy autoevals MIT prompts), cross-checked ±0.05 vs Python `ragas` once (dev-only).
- **Head-to-head: CUT** (per user — bge-micro-v2 is a local model). Eval proves quality via our own metrics: NDCG@10 vs Voyage's published numbers + the A/B ladder + Sentinel FP. No competitor reimpl.
- **Reproducibility:** per-run manifest records **active graph source** (parser vs canonical — design §11 requirement) + every model-id + golden hash + seed. **CI smoke-eval** on a committed 12-note fixture vault + deterministic stub embedder, asserts hard thresholds.

## 8. Packaging / offline / distribution

- **pnpm `11.0.7` frozen** (`packageManager` + hash; offline regressions #9744/#11488; #11808 = bump invalidates warm store). **catalog** in `pnpm-workspace.yaml` (even for one package — seam for P2 plugin split). `minimumReleaseAge` explicit. Committed lockfile.
- **Air-gap install:** `pnpm fetch` → **`rm -rf node_modules`** → `pnpm install --offline --frozen-lockfile` (the universal workaround). `supportedArchitectures` to fetch all platform binaries. Always `--frozen-lockfile` (avoids `ERR_PNPM_NO_OFFLINE_TARBALL` #10715).
- **Two native deps:** `sqlite-vec` (ABI-agnostic loadable ext, 5 platform optionalDeps, clean) + **`better-sqlite3`** (⚠️ ABI-bound `.node` — the real risk; build against **Node 22** ABI 127 = Claude Desktop; #180). 
- **CI gate (the only real proof):** x64 `fetch` → **arm64** `install --offline` from cold store + `/etc/hosts` registry blackhole + native-load smoke test.
- **MCPB (primary):** manifest v0.3; `user_config` (vault_path, `nomic_api_key` `sensitive`, `voyage_api_key` `sensitive` → env); **flat `npm install --production` tree** (not pnpm symlinks); build better-sqlite3 against Node 22; **one `.mcpb` per platform**. Lean bundle (no model weights — none exist). `npx` = online convenience.
- **No model distribution** — there are no local ML models to ship (embeddings + rerank are API; cull is embedding-similarity; Judge is the host session).
- **Repo:** `.gitignore` (`*.db*`, `.env`, `*.mcpb`), MIT LICENSE (deps compatible), README (quickstart + privacy note: text → Nomic/Voyage), `.nvmrc=22`, `engine-strict`. **No AI/Claude attribution anywhere.**
- **Build: tsup** ESM-only, `target node22`, entries `cli` + `server`, native deps `external`, shebang on `cli.ts` only.

## 9. P0 risk-retirement spikes (do these FIRST, ~an afternoon each)

1. ~~DeBERTa NLI ONNX~~ / ~~bge-reranker ONNX~~ — **both dropped** (no local ML models). No ONNX spikes.
2. **sqlite-vec brute-force latency at scale** — the one real CPU cost now: benchmark a hybrid query at 50k/100k/250k chunks @768-dim in the standalone server process; confirm it stays interactive and set the int8/warn thresholds.
3. **better-sqlite3 + sqlite-vec** load + `vec_version()` + a hybrid query on the **target platform/Node 22**; confirm the `.mcpb` ABI path (#180).
4. **pnpm air-gap** cross-arch cold-store install (the CI gate) green before depending on the offline-build story.
5. **Nomic Atlas API** embeddings round-trip — confirm `task_type` (`search_document`/`search_query`) + 768-dim + rate limits; smoke the Voyage `rerank-2.5` call.

## 10. Version landmines (watch list)

- pnpm self-upgrade bumps `packageManager` → warm store can't resolve new pnpm (#11808, open) → **freeze the pin**.
- `better-sqlite3` `NODE_MODULE_VERSION` mismatch if bundle Node ≠ host Node (#1367/#1384, MCPB #180).
- chokidar v4 dropped globs + rename events → watch dir, filter `.md` in code, treat rename as unlink+add (hash-cache makes it cheap).
- sqlite-vec brute-force only until 0.1.10 ANN ships stable — don't depend on ANN for v1.
- MCP `sampling`/`elicitation` minority-supported → tool-result-as-judge + 2-call-confirm sidestep both.

## 11. Assembly plan (reuse map — glue, don't write)

Goal: maximize reuse of permissive OSS. **License posture: only MIT / Apache-2.0 / ISC / BSD-2 in the "take" column. AGPL + no-compete quarantined to STUDY-ONLY (architecture/ideas, never code or license text).** Every mature *whole-app* RAG-over-Obsidian is AGPL / no-compete / archived / Python → reuse is **component-level**, not app-level.

### npm-depend (drop in + thin adapter)
| Need | Package | License |
|---|---|---|
| Store (default) | embedded **PostgreSQL 17 + pgvector** via `embedded-postgres` + `pg` (no Docker, MVCC) | PostgreSQL / MIT |
| Store (overkill opt-in) | `pgvectorscale` + `pg_search` into your own PG | PostgreSQL / **AGPL (server-only)** |
| Store (fallback) | `sqlite-vec` 0.1.9 + `better-sqlite3` | Apache / MIT |
| Throughput | `undici` (HTTP pools) + `p-queue` (API governor) + `Piscina` (worker pool) | MIT |
| Provider layer | **Vercel AI SDK** (`ai`+`@ai-sdk/*`) + `voyageai-ai-provider` + `@openrouter/ai-sdk-provider` | Apache/MIT |
| Recommender data | `models.dev` json + LiteLLM prices json | MIT |
| Markdown→mdast | `unified`+`remark-parse`+`remark-gfm`+`remark-frontmatter`+`gray-matter` | MIT |
| Wikilink **tokenizer** (resolution stays ours) | `micromark-extension-wiki-link`+`mdast-util-wiki-link` (stale → pin SHA or vendor ~200 LOC) | MIT (npm) |
| Sentence segmentation (offset-preserving via `splitAST`) | `sentence-splitter` | MIT |
| Token budget proxy | `gpt-tokenizer` (`o200k_base`) | MIT |
| Embeddings | `@nomic-ai/atlas` (verify LICENSE) or raw `fetch` to Atlas API | TBD/—  |
| Rerank | `voyageai` (official SDK; instruction-prepend-to-query confirmed) | MIT |
| Git (belief-drift) | `simple-git` (`.raw(['log','-G…','--all'])` pickaxe + `.show()`) | MIT |
| MCPB packer (devDep) | `@anthropic-ai/mcpb` | MIT |
| Stats primitives | `simple-statistics` | ISC |
| Watcher | `chokidar` 4.x | MIT |
| Community clustering (Epistemic view) | `graphology-communities-louvain` | MIT |
| REST-bridge client (codegen) | `@hey-api/openapi-ts` (devDep) from coddingtonbear OpenAPI | MIT |
| Offset-faithful chunker | `chonkie` (chonkie-ts; native start/endIndex) — build only OFM-zone guard | MIT |
| stdio↔daemon shim | `mcp-proxy` (`startStdioServer`) — don't hand-write | BSD-2 |
| Daemon HTTP (Unix socket + loopback) | `hono` + `@hono/node-server` | MIT |
| Single-instance lock | `proper-lockfile` (heartbeat) | MIT |
| Plugin scaffold | `obsidian-sample-plugin`; plugin→daemon via Obsidian `requestUrl()` (loopback HTTP; renderer can't reach socket, `fetch` is CORS-blocked) | MIT |

**Rejected as the eval harness: `promptfoo`** — 84 deps incl. a *second* better-sqlite3 + drizzle ORM + express + socket.io + telemetry; doubles the bundle, violates lean single-package. Thin custom TS harness stays. (deepeval/ragas = Python dev-oracles only.)

### Vendor (pinned, kept out of git)
- **`cyanheads/obsidian-mcp-server` (Apache-2.0)** → `section-extractor.ts` + `frontmatter-ops.ts` (pure in-memory; swap one `notFound` import) + keep NOTICE. The surgical heading/block/frontmatter edit brain = taken.
- *(DeBERTa ONNX vendoring removed — no local models.)*

### Copy-pattern (lift code/SQL/prompts into repo; permissive)
- 🏆 **Quartz `ofm.ts` (MIT)** → Obsidian-flavored-markdown handler (block-refs `^id`, callouts, embeds, tags). Biggest parsing lift.
- **Alex Garcia's RRF CTE (Apache, sqlite-vec)** → copy the hybrid query verbatim, adapt schema, k=60.
- **obsidian-export (BSD-2)** → wikilink shortest-path/longest-match **resolution algorithm** → reimplement in `core`.
- **LangChain.js Markdown separator list (MIT)** → chunker recursive-pack (it drops offsets → don't wrap the class).
- **autoevals `js/ragas.ts` (MIT)** → the 4 RAGAS metric prompt templates, rewired onto our `Judge`+`Embedding`.
- **ragas `TestsetGenerator` (Apache)** → golden-gen taxonomy (single/multi-hop 50/25/25) + anti-leakage prompt rules.
- **`negspacy` (MIT)** → port the 4 NegEx/ConText cue categories to a TS regex lexicon (data, not code) for the assertion filter.
- TS SDK `examples/server-quickstart` → seed the stdio server (⚠️ verify the import surface the installed 1.29.x actually ships; README shows a newer alias).
- Cyanheads tool-input-schema shapes; `wink-nlp` negation handling (reference); MCPB `examples/hello-world-node` manifest.

### Wrap-subprocess (dev/CI only — NEVER shipped, gated behind a dev extra)
- **`pytrec_eval` (MIT)** = the BEIR oracle → assert our TS NDCG@10/Recall@k/MRR match within 1e-6 (matching it = BEIR-comparable by construction). `ir_measures` (Apache) = friendlier-CLI alt.
- **`ragas` (Apache, Python)** → one-time ±0.05 cross-check of faithfulness/context-precision/recall.

### STUDY-ONLY (AGPL / no-compete / Python — ideas, not code)
`basic-memory` (AGPL — Entity/Observation/Relation markdown grammar idea only), `khoj`/`Reor` (AGPL), `smart-connections` (no-compete), Graphiti/mem0/cognee/Letta (Apache but Python + LLM-graph shape we rejected), `remark-obsidian` (GPL — banned dep).

### Build fresh = the moat (no OSS exists; this IS the product)
Sentinel orchestration cascade · assertion pre-filter policy · confirm-and-learn 3-tier suppression + per-vault τ-calibration · Claim Index (deterministic, content-hash-invalidated) · Epistemic Integrity construction · `Judge` interface + tool-result-as-judge · offset-faithful chunker (never split code/tables/callouts) · wikilink **resolution** · the eval harness shell (FP-primary, A/B ladder, bootstrap CI + paired permutation test ~40 lines — no JS lib does these).

**Net:** plumbing + parsing front-end + edit brain + packaging + metric-validation are ~80–90% **assembled from MIT/Apache/ISC/BSD**. Bespoke = exactly the spec's stated moat (retrieval intelligence + Sentinel), nothing more. Open license check: `@nomic-ai/atlas` LICENSE (use raw `fetch` to the Atlas API if awkward — it's just a POST).
