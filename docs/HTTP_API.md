# HTTP API reference

Loopback-only. Binds `127.0.0.1:38473` by default (override via `VAULTNEXUS_HTTP_PORT`).
CORS is open (`*`) so the Obsidian Electron renderer can fetch without preflight rejection — the surface is loopback-bound anyway.

All response bodies are JSON. Errors carry `{ error: string, issues?: zod-issues[] }`.

## `GET /health`

Liveness probe.

```bash
$ curl http://127.0.0.1:38473/health
{ "status": "ok", "version": "0.0.1" }
```

## `GET /status`

Richer diagnostic — used by the Obsidian plugin's status panel.

```bash
$ curl http://127.0.0.1:38473/status
{
  "status":    "ok",
  "version":   "0.0.1",
  "indexed":   606,
  "embedder":  "voyage-code-3",
  "chatModel": "fake",
  "tools":     ["vaultnexus_ping", "vaultnexus_search", "vaultnexus_bridges",
                "vaultnexus_trace", "vaultnexus_reason", "vaultnexus_history",
                "vaultnexus_recall_history", "vaultnexus_forecasts"]
}
```

| Field | Type | Meaning |
|---|---|---|
| `status`    | `"ok"` | Always `"ok"` if the daemon answered. |
| `version`   | string | Daemon version (semver). |
| `indexed`   | number | Total chunks in the in-memory index. |
| `embedder`  | string | Embedder id — `"fake"` for offline, model id otherwise. |
| `chatModel` | string | `"none"` if no index, `"fake"` for offline stub, `"<provider>:<model>"` otherwise. |
| `tools`     | string[] | MCP tool names exposed by the bridge. |

## `POST /search`

Hybrid semantic + lexical retrieval. Returns ranked cited hits.

**Request**

```json
{
  "query": "string",
  "k": 10
}
```

| Field | Required | Default | Notes |
|---|---|---|---|
| `query` | yes | — | Non-empty string. |
| `k`     | no  | 10  | Positive integer. Cap not enforced by daemon — sanity is on the client. |

**Response**

```jsonc
[
  {
    "notePath":    "Notes/UNIX Logging.md",
    "headingPath": ["Linux Logging Architecture", "08 · Sockets"],
    "byteStart":   8842,
    "byteEnd":     9304,
    "text":        "> [!info] Application → syslog() → /dev/log → journald → ...",
    "score":       0.799
  },
  ...
]
```

| Field | Type | Notes |
|---|---|---|
| `notePath`    | string   | Relative to the vault root. |
| `headingPath` | string[] | Breadcrumb. Empty strings for skipped depths (e.g. doc starts at `####` → `["", "", "", "deep heading"]`). |
| `byteStart`   | number   | Offset in the source file (bytes, not chars). |
| `byteEnd`     | number   | Inclusive end offset. |
| `text`        | string   | Verbatim chunk text. |
| `score`       | number   | Fused cosine + BM25 rank (RRF). Higher is better. Domain ~[-0.5, 1.0]. |

**Errors**

| Status | Body | When |
|---|---|---|
| `400` | `{ error: "bad request", issues: [...] }` | zod validation failed (e.g. empty query). |
| `503` | `{ error: "no index" }` | Daemon started without `VAULTNEXUS_VAULT`. |

## `POST /bridges`

Cross-community bridge pairs from the wikilink graph.

**Request**

```json
{
  "topN": 20,
  "minSimilarity": 0.5,
  "crossCommunityOnly": false
}
```

All fields optional. Defaults: `topN=20`, `minSimilarity=0.5`, `crossCommunityOnly=false`.

**Response**

```jsonc
[
  {
    "a":             { "notePath": "a.md", "headingPath": [...], "text": "...", ... },
    "b":             { "notePath": "b.md", "headingPath": [...], "text": "...", ... },
    "similarity":    0.872,
    "crossCommunity": true,
    "linked":        false
  },
  ...
]
```

## `POST /configure-chat`

Hot-swap the chat model. No daemon restart.

**Request**

```json
{
  "provider": "anthropic",
  "key":      "sk-ant-...",
  "model":    "claude-sonnet-4-6",
  "baseURL":  "https://api.anthropic.com/v1"
}
```

| Field | Required | Allowed |
|---|---|---|
| `provider` | yes | `"fake"` · `"anthropic"` · `"openai"` · `"openai-compatible"` |
| `key`      | depends | Required for `anthropic` · `openai` · `openai-compatible`. Optional for `fake`. |
| `model`    | depends | Optional for `anthropic` · `openai` (provider defaults apply). Required for `openai-compatible`. |
| `baseURL`  | depends | Required for `openai-compatible`. Must start with `http://` or `https://`. |

**Response**

```jsonc
{ "ok": true, "chatModel": "anthropic:claude-sonnet-4-6" }
```

**Errors**

| Status | When |
|---|---|
| `400` | Missing required field per provider, or bad body shape. |
| `503` | No index injected. |

The key is never echoed back in any subsequent `/status` response.

## Quick smoke

```bash
# Liveness
curl http://127.0.0.1:38473/health

# Richer diagnostic
curl http://127.0.0.1:38473/status

# Search (loopback is open, no auth)
curl -X POST http://127.0.0.1:38473/search \
  -H 'content-type: application/json' \
  -d '{"query":"deep work blocks","k":3}'

# Bridges
curl -X POST http://127.0.0.1:38473/bridges \
  -H 'content-type: application/json' \
  -d '{"topN":5,"minSimilarity":0.6}'

# Swap chat model live
curl -X POST http://127.0.0.1:38473/configure-chat \
  -H 'content-type: application/json' \
  -d '{"provider":"anthropic","key":"sk-ant-...","model":"claude-sonnet-4-6"}'
```
