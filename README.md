<div align="center">

```
╔══════════════════════════════════════════════════════════╗
║                                                          ║
║   ██╗   ██╗ █████╗ ██╗   ██╗██╗  ████████╗               ║
║   ██║   ██║██╔══██╗██║   ██║██║  ╚══██╔══╝               ║
║   ██║   ██║███████║██║   ██║██║     ██║                  ║
║   ╚██╗ ██╔╝██╔══██║██║   ██║██║     ██║                  ║
║    ╚████╔╝ ██║  ██║╚██████╔╝███████╗██║                  ║
║     ╚═══╝  ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝                  ║
║      ███╗   ██╗███████╗██╗  ██╗██╗   ██╗███████╗         ║
║      ████╗  ██║██╔════╝╚██╗██╔╝██║   ██║██╔════╝         ║
║      ██╔██╗ ██║█████╗   ╚███╔╝ ██║   ██║███████╗         ║
║      ██║╚██╗██║██╔══╝   ██╔██╗ ██║   ██║╚════██║         ║
║      ██║ ╚████║███████╗██╔╝ ██╗╚██████╔╝███████║         ║
║      ╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝         ║
║                                                          ║
║     local-first semantic search over your Obsidian vault ║
║          cited retrieval · cross-cluster bridges         ║
║                                                          ║
╚══════════════════════════════════════════════════════════╝
```

**A local knowledge engine for Markdown vaults.**
Semantic search, citation-grade retrieval, cross-community bridges.
Talks to Claude Code, Claude Desktop, and an Obsidian sidebar — over loopback HTTP.
No cloud round-trip on query.

[![CI](https://github.com/hunchom/vaultnexus/actions/workflows/ci.yml/badge.svg)](https://github.com/hunchom/vaultnexus/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node ≥22](https://img.shields.io/badge/node-%E2%89%A522-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-compatible-7c3aed)](https://modelcontextprotocol.io/)
[![Obsidian plugin](https://img.shields.io/badge/Obsidian-plugin-7c3aed?logo=obsidian)](https://obsidian.md/)

[Install](#install) · [Getting started](docs/GETTING_STARTED.md) · [Architecture](docs/ARCHITECTURE.md) · [HTTP API](docs/HTTP_API.md) · [MCP tools](#mcp-tools) · [Configuration](#configuration) · [Roadmap](docs/ROADMAP.md) · [Contributing](CONTRIBUTING.md)

</div>

---

## What you get

| | |
|---|---|
| **Hybrid retrieval** | int8 SIMD coarse + exact f32 rescore (dense) fused with FTS5 BM25 (lexical) via Reciprocal Rank Fusion. Offset-faithful chunking → every hit is a verbatim byte range you can re-open in the editor. |
| **Cross-community bridges** | Wikilink graph → Louvain communities → surfaces semantically aligned chunks that live in *different* link clusters and were never linked. The "notes that secretly agree across your silos" problem, solved. |
| **Lives on loopback** | A single daemon binds `127.0.0.1`. Plugins, MCP clients, and shell tools all hit the same HTTP + Unix-socket surface. Nothing is exposed beyond your machine. |
| **Provider-agnostic** | Any OpenAI-compatible embeddings endpoint (Voyage, OpenAI, local Ollama, vLLM). Chat model is optional and configurable live from the Obsidian plugin — no daemon restart. |
| **Content-hash caching** | Re-embedding skipped when chunks unchanged. Restart cost is milliseconds, not minutes. |
| **Snapshot persistence** | Vectors + chunks persist to an on-disk SQLite snapshot. The daemon survives reboots without re-embedding the vault. |
| **Validated** | On a paraphrase gold set where queries share no distinctive token with their target, `voyage-3-large` hits recall@1 = 0.958 / MRR = 1.000. Lexical baseline: 0.500 / 0.600. |

---

## Try it in 30 seconds

No vault? No API key? Run against the bundled 33-note demo vault with the offline `FakeEmbedder`:

```bash
git clone https://github.com/hunchom/vaultnexus.git
cd vaultnexus
pnpm install
pnpm run build
pnpm run demo            # → starts daemon against demo-vault-seeded/ on :38473
```

In another terminal:

```bash
curl http://127.0.0.1:38473/status
# → {"status":"ok","indexed":207,"embedder":"fake",...}

curl -X POST http://127.0.0.1:38473/search \
  -H 'content-type: application/json' \
  -d '{"query":"deep work blocks","k":3}'
# → top hit: notes/decisions/remote-work-future.md (score 0.937)
```

For real semantic quality (recall@3 = 1.000 on the bundled paraphrase eval), point `VAULTNEXUS_EMBED_*` at any OpenAI-compatible endpoint — see [Configuration](#configuration).

---

## Why VaultNexus?

If you already have an Obsidian vault, you've probably tried other "smart search" approaches. Here's how they compare:

| | VaultNexus | Obsidian core search | Smart Connections plugin | grep / ripgrep |
|---|---|---|---|---|
| Semantic (paraphrase) recall | ✅ recall@3=1.000 (eval) | ❌ exact-string only | ✅ | ❌ |
| Lexical (typo / quoted terms) | ✅ FTS5 BM25 fused via RRF | ✅ | ⚠️ semantic-only | ✅ |
| Cited byte ranges | ✅ every hit | ⚠️ note-level | ⚠️ note-level | ✅ |
| Cross-cluster bridges | ✅ Louvain + cosine | ❌ | ❌ | ❌ |
| Exposed to Claude / MCP clients | ✅ 8 tools | ❌ | ❌ | ❌ |
| Snapshot persistence (warm start) | ✅ ms | n/a | ⚠️ rebuilds | n/a |
| API key required | ❌ optional (fake mode works) | ❌ | ✅ OpenAI required | ❌ |
| Runs offline | ✅ w/ Ollama or fake | ✅ | ❌ | ✅ |
| Open source | ✅ MIT | proprietary | MIT | various |

**Built for the case where you live in Obsidian + use Claude/MCP daily** and want the same retrieval surface in both places, with citations Claude can click through.

---

## Performance

Numbers from a concurrent-load smoke against a 606-chunk vault, voyage-code-3 embedder, warm cache:

```
parallel × 30 reqs · wall=26ms · p50=15ms · p95=24ms · 0 failures
```

- Cold restart (snapshot restore): ~150ms for 600 chunks
- Cold rebuild from scratch (real embedder, 600 chunks): ~12s on Voyage
- Warm-cache re-embed (single chunk): ~5ms

The daemon is single-process Node; concurrency is handled by `undici`'s connection pool to the embedder + per-request promises. There is no thread pool to tune.

---

## Install

> **Requirements** — Node 22+, an Obsidian vault, and (optionally) an OpenAI-compatible embeddings endpoint + key. The bundled `FakeEmbedder` works offline for smoke tests.

### 1. Build the daemon

```bash
git clone https://github.com/hunchom/vaultnexus.git
cd vaultnexus
pnpm install
pnpm run build
```

### 2. Start it (one-liner)

```bash
VAULTNEXUS_VAULT="$HOME/path/to/your/vault" \
VAULTNEXUS_EMBED_URL="https://api.voyageai.com/v1" \
VAULTNEXUS_EMBED_KEY="$VOYAGE_API_KEY" \
VAULTNEXUS_EMBED_MODEL="voyage-3-large" \
  node dist/daemon/main.js
```

Health check:

```bash
curl http://127.0.0.1:38473/status
# → {"status":"ok","version":"0.0.1","indexed":N,...}
```

### 3. Pick your client

<table>
<tr>
<td valign="top" width="33%">

#### Obsidian plugin

```bash
mkdir -p \
  "$VAULT/.obsidian/plugins/vaultnexus"
cp obsidian-plugin/main.js \
   obsidian-plugin/manifest.json \
  "$VAULT/.obsidian/plugins/vaultnexus/"
```

Open Obsidian → **Settings → Community plugins** → enable **VaultNexus**.

</td>
<td valign="top" width="33%">

#### Claude Code (MCP)

```bash
claude mcp add vaultnexus \
  /opt/homebrew/opt/node@22/bin/node \
  $(pwd)/dist/bridge/main.js
```

Restart Claude Code. The 8 `vaultnexus_*` tools appear in `tools/list`.

</td>
<td valign="top" width="34%">

#### Claude Desktop (MCP)

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "vaultnexus": {
      "command": "node",
      "args": ["/abs/path/to/dist/bridge/main.js"]
    }
  }
}
```

</td>
</tr>
</table>

A full step-by-step is in **[Getting started →](docs/GETTING_STARTED.md)**.

### Docker

```bash
# One-shot — bind-mount your vault, point at Voyage:
docker run --rm -it \
  -v "$HOME/Documents/MyVault:/vault:ro" \
  -v vaultnexus-state:/var/lib/vaultnexus \
  -e VAULTNEXUS_VAULT=/vault \
  -e VAULTNEXUS_EMBED_URL=https://api.voyageai.com/v1 \
  -e VAULTNEXUS_EMBED_KEY=$VOYAGE_API_KEY \
  -e VAULTNEXUS_EMBED_MODEL=voyage-3-large \
  -p 127.0.0.1:38473:38473 \
  $(docker build -q .)

# Or docker-compose w/ bundled Ollama for offline embeddings:
VAULT_PATH="$HOME/Documents/MyVault" docker compose up -d
docker compose exec ollama ollama pull nomic-embed-text
```

---

## MCP tools

Every tool returns a JSON payload. Every payload includes citations: `notePath`, `headingPath`, `byteStart`, `byteEnd`.

| Tool | Purpose |
|---|---|
| `vaultnexus_ping` | Health probe. Returns `{status, version}`. |
| `vaultnexus_search` | Hybrid semantic + keyword search. Returns ranked cited chunks. |
| `vaultnexus_bridges` | Cross-community bridge pairs from the wikilink graph. |
| `vaultnexus_trace` | Multi-hop reasoning chain over the retrieval graph. |
| `vaultnexus_reason` | Composed answer with inline citations (requires chat model). |
| `vaultnexus_history` | Git revisions for a note (vault must be a git repo). |
| `vaultnexus_recall_history` | Time-ordered narration of a note's evolution. |
| `vaultnexus_forecasts` | Mined `[forecast: ... by YYYY-MM-DD]` ledger entries from the vault. |

---

## Architecture

```
   ┌──────────────────┐      ┌──────────────────────────────┐
   │  Obsidian plugin │──────│   loopback HTTP :38473       │
   └──────────────────┘      │   ┌──────────────────────┐   │
   ┌──────────────────┐      │   │      daemon          │   │
   │  Claude Code     │──┐   │   │  ┌────────────────┐  │   │
   └──────────────────┘  │   │   │  │  vault index   │  │   │
   ┌──────────────────┐  │   │   │  │  (in-memory)   │  │   │
   │  Claude Desktop  │──┴───│   │  └───────┬────────┘  │   │
   └──────────────────┘      │   │          │           │   │
                             │   │  ┌───────▼────────┐  │   │
                             │   │  │ SQLite snapshot│  │   │
                             │   │  │  ~/.vaultnexus │  │   │
                             │   │  └────────────────┘  │   │
   ┌──────────────────┐      │   │                      │   │
   │  stdio bridge    │──────┘   │  ┌────────────────┐  │   │
   │  (Unix socket)   │          │  │  embedder      │  │   │
   └──────────────────┘          │  │  (HTTP API)    │  │   │
                                 │  └───────┬────────┘  │   │
                                 │          │           │   │
                                 │  ┌───────▼────────┐  │   │
                                 │  │  chat model    │  │   │
                                 │  │  (hot-swap)    │  │   │
                                 │  └────────────────┘  │   │
                                 └──────────────────────┘
```

One daemon. Three surfaces (HTTP for the plugin, Unix socket for stdio MCP clients, stdio bridge for the same). Everything else is config.

---

## Configuration

All knobs are environment variables on the daemon (the plugin reads `host`/`port` from its own settings). Chat-side config can also be pushed live from the Obsidian plugin via `POST /configure-chat` — no restart.

| Variable | Default | Notes |
|---|---|---|
| `VAULTNEXUS_VAULT` | — | Absolute path to the vault directory. Required. |
| `VAULTNEXUS_HTTP_PORT` | `38473` | Loopback port the daemon binds. |
| `VAULTNEXUS_EMBED_URL` | unset | OpenAI-compatible embeddings endpoint. Unset → offline `FakeEmbedder`. |
| `VAULTNEXUS_EMBED_KEY` | unset | API key for the embedder. |
| `VAULTNEXUS_EMBED_MODEL` | unset | Embedding model id (e.g. `voyage-3-large`, `nomic-embed-text-v1.5`). |
| `VAULTNEXUS_INDEX_SNAPSHOT` | `~/.vaultnexus/index-snapshot.db` | On-disk snapshot path. `off` disables. |
| `VAULTNEXUS_CHAT_PROVIDER` | `fake` | `anthropic` · `openai` · `openai-compatible` · `fake`. |
| `VAULTNEXUS_CHAT_KEY` | unset | Chat-provider API key. Required for non-fake. |
| `VAULTNEXUS_CHAT_MODEL` | provider default | Defaults: anthropic → `claude-sonnet-4-6`, openai → `gpt-4o-mini`. |
| `VAULTNEXUS_CHAT_URL` | unset | Base URL for openai-compatible (Ollama, LM Studio, vLLM). |

---

## Develop

Targets **Node 22**. If the system `node` is older, prepend a Node 22 install to `PATH`:

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH

pnpm install
pnpm run build       # daemon + bridge → dist/
pnpm test            # 449 tests
```

The Obsidian plugin builds independently:

```bash
cd obsidian-plugin
node esbuild.config.mjs           # → main.js
node esbuild.config.mjs --watch   # dev mode
```

---

## Repo layout

```
src/
  core/          embedding-agnostic primitives (chunker, vectors, search, fusion)
  daemon/        HTTP + MCP server, vault index, snapshot, hot-swap chat
  bridge/        stdio ↔ unix-socket pipe for MCP clients
obsidian-plugin/
  src/           plugin entry, sidebar search view, settings tab
  main.js        bundled artifact (esbuild)
test/            449 vitest cases (chunker, retrieval, MCP, HTTP, snapshot, integration)
docs/specs/      design docs + per-plan implementation notes
```

---

## License

MIT — see [LICENSE](LICENSE).
