# VaultNexus

Local-first knowledge engine for an Obsidian/Markdown vault, exposed to Claude Code over MCP. Best-engineered hybrid retrieval plus cross-community convergence ("notes that secretly agree across your link silos"), run entirely on your machine. See `docs/specs/2026-05-23-vaultnexus-concept.md` for the design and `docs/specs/plans/` for the build plans.

## Status

Working end-to-end (Plans 01–11):

- **Hybrid retrieval** — dense vector (int8 SIMD coarse + exact f32 rescore) ⊕ FTS5 keyword (bm25), fused with Reciprocal Rank Fusion. Offset-faithful Markdown chunking with cited byte ranges.
- **Cross-community bridges** — wikilink graph → Louvain communities → surfaces semantically similar chunks that live in *different* link-clusters and were never linked.
- **Persistent embedding cache** — content-hash → vector store (model-scoped); restarts reuse embeddings instead of re-calling a paid embedder.
- **Provider-agnostic embedder** — deterministic offline `FakeEmbedder` for tests; any OpenAI-compatible `/embeddings` endpoint (Voyage, OpenAI, local) for real use.
- **Validated** — on a clean paraphrase gold set (queries share no distinctive token with their target note), `voyage-3-large` reaches recall@1 0.958 / MRR 1.000 versus a lexical baseline at 0.500 / 0.600. See `docs/specs/plans/2026-05-23-vaultnexus-09-eval-harness.md`.

## Develop

Targets **Node 22**. With nvm-style setups where the default `node` is older, prepend a Node 22 install to `PATH` (e.g. `export PATH=/opt/homebrew/opt/node@22/bin:$PATH`).

```bash
pnpm install
pnpm test          # unit + integration + e2e (one gated test skips without a real embedder)
pnpm typecheck     # tsc, no emit (type-checks src + test)
pnpm build         # tsc -> dist/
```

## Run

Start the daemon (single instance per machine). Point it at a vault and, for real semantics, an embedding endpoint:

```bash
export VAULTNEXUS_VAULT=/path/to/your/vault          # indexed on startup
export VAULTNEXUS_EMBED_URL=https://api.voyageai.com/v1
export VAULTNEXUS_EMBED_KEY=...                       # never commit this
export VAULTNEXUS_EMBED_MODEL=voyage-3-large          # best for prose
pnpm dev:daemon                                       # or, after build: node dist/daemon/main.js
```

Without `VAULTNEXUS_EMBED_*`, the daemon uses the offline `FakeEmbedder` (non-semantic — fine for wiring tests, not for real retrieval). Without `VAULTNEXUS_VAULT`, only `vaultnexus_ping` is served.

Register the bridge with Claude Code as an MCP server:

```json
{
  "mcpServers": {
    "vaultnexus": { "command": "node", "args": ["dist/bridge/main.js"] }
  }
}
```

### Environment

| Variable | Purpose | Default |
|---|---|---|
| `VAULTNEXUS_VAULT` | Markdown vault directory to index | none (ping-only) |
| `VAULTNEXUS_EMBED_URL` / `_KEY` / `_MODEL` | OpenAI-compatible embedder | offline `FakeEmbedder` |
| `VAULTNEXUS_CACHE` | Embedding cache DB path; `off` disables | `~/.vaultnexus/embeddings.db` |
| `VAULTNEXUS_SOCKET` / `VAULTNEXUS_LOCK` / `VAULTNEXUS_HTTP_PORT` | transport overrides | tmpdir / tmpdir / 38473 |

## MCP tools

- `vaultnexus_ping` — health and version probe.
- `vaultnexus_search` — hybrid search; returns cited block hits (`notePath`, `headingPath`, byte offsets, `score`). Params: `query`, `k?`.
- `vaultnexus_bridges` — cross-note semantically-similar chunk pairs, each tagged `crossCommunity` (different link-clusters) and `linked` (already wikilinked). Params: `topN?`, `minSimilarity?`, `crossCommunityOnly?`. Suggestions, not assertions.

## Eval

```bash
pnpm eval                                              # FakeEmbedder baseline
VAULTNEXUS_EMBED_URL=... VAULTNEXUS_EMBED_KEY=... VAULTNEXUS_EMBED_MODEL=voyage-3-large pnpm eval
```

Prints recall@1 / recall@3 / recall@10 / nDCG@10 / MRR over a paraphrase gold set (`eval/corpus/` + `src/eval/gold.ts`). recall@1 and MRR are the load-bearing metrics; recall@10 saturates on the small corpus.

## Architecture

A single long-running daemon owns all state and is the single writer. It listens on a Unix domain socket (the Claude Code path) and loopback HTTP on `127.0.0.1` (the future Obsidian-plugin path). Claude Code speaks MCP over stdio to a thin bridge that shuttles raw bytes between its stdio and the daemon's socket; the daemon wraps each connection in an MCP transport and serves it. `core/` is pure and I/O-free (chunking, quantization, int8 search, fusion, metrics); the daemon injects all I/O (embedder, FTS, cache, graph). Embeddings are L2-normalized so cosine equals dot product; int8 uses a symmetric single-scale quantization that composes with the integer dot kernel, with exact f32 rescore for the final ranking.
