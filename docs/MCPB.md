# VaultNexus MCPB Install

VaultNexus ships as an [MCPB](https://github.com/anthropics/mcpb) bundle — a self-contained zip containing the MCP server, runtime dependencies, and a manifest declaring its configuration surface. Install once into an MCPB-aware host (Claude Desktop, Claude Code) and configure your vault.

## Install

1. **Get the bundle.** Either download `vaultnexus-<version>.mcpb` from a release, or build it locally:

   ```sh
   pnpm install
   pnpm package:mcpb
   ```

   Output lands in `dist-mcpb/vaultnexus-<version>.mcpb` (~30 MB).

2. **Install into the host.** In Claude Desktop or Claude Code settings, install an MCP server from a local `.mcpb` file and point it at the bundle.

3. **Configure.** The host will prompt for the fields declared in `user_config`:

   - **Vault Path** (required, directory) — absolute path to your Obsidian or Markdown vault.
   - **Chat Provider** (optional) — `anthropic`, `openai`, or empty to disable LLM-cited reasoning.
   - **Chat API Key** (optional, sensitive) — key for the selected provider. Leave empty to run retrieval-only.

4. **Run.** The bundle launches `node server/dist/bridge/main.js`. The bridge is a stdio shim that pipes MCP JSON-RPC traffic to a persistent daemon over a local socket. The daemon must be running — see [daemon](#daemon).

## Daemon

The MCPB bundle ships both `bridge` (stdio MCP entry) and `daemon` (persistent index + tool server). Today the daemon must be started out-of-band:

```sh
node /path/to/extracted-bundle/server/dist/daemon/main.js
```

A future release will let the bridge auto-spawn the daemon on first connect. Track the socket at `$XDG_RUNTIME_DIR/vaultnexus.sock` (Linux) or the equivalent platform path.

## Runtime requirements

- Node `>=22` on the host. The bundle does not embed a Node runtime; the MCPB host (or your shell) provides `node`.
- Platforms: `darwin`, `linux`, `win32`.
- Native modules (`better-sqlite3`, etc.) ship as prebuilt N-API binaries inside `server/node_modules/`.

## Building from source

```sh
pnpm install
pnpm build           # tsc → dist/
pnpm package:mcpb    # tsc + copy + zip → dist-mcpb/*.mcpb
```

The packaging script lives at `scripts/build-mcpb.ts`. The canonical manifest lives at `mcpb/manifest.json` — version is overwritten from `package.json` at build time.
