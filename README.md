# VaultNexus

Local-first knowledge engine for an Obsidian/Markdown vault, exposed to Claude Code over MCP. See `docs/specs/2026-05-23-vaultnexus-concept.md` for the design.

## Status

Plan 01 (foundation): a daemon + stdio→socket MCP bridge with a `vaultnexus_ping` health tool. No retrieval yet — that is Plan 02.

## Develop

This project targets **Node 22**. With nvm-style setups where the default `node` is older, prepend a Node 22 install to `PATH` (e.g. `export PATH=/opt/homebrew/opt/node@22/bin:$PATH`).

```bash
pnpm install
pnpm test          # unit + integration + e2e
pnpm typecheck     # tsc, no emit (type-checks src + test)
pnpm build         # tsc -> dist/
```

## Run

Start the daemon (single instance per machine):

```bash
pnpm dev:daemon    # or, after build: node dist/daemon/main.js
```

Register the bridge with Claude Code as an MCP server:

```json
{
  "mcpServers": {
    "vaultnexus": { "command": "node", "args": ["dist/bridge/main.js"] }
  }
}
```

Environment overrides: `VAULTNEXUS_SOCKET`, `VAULTNEXUS_LOCK`, `VAULTNEXUS_HTTP_PORT`.

## Architecture

A single long-running daemon owns all state and is the single writer. It listens on a Unix domain socket (the Claude Code path) and loopback HTTP on `127.0.0.1` (the future Obsidian-plugin path). Claude Code speaks MCP over stdio to a thin bridge that shuttles raw bytes between its stdio and the daemon's socket; the daemon wraps each connection in an MCP transport and serves it. `core/` is pure and I/O-free; the daemon injects all I/O.
