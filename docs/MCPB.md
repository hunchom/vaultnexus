# VaultNexus MCPB Install

VaultNexus ships as an [MCPB](https://github.com/anthropics/mcpb) bundle — a self-contained zip containing the MCP server, runtime dependencies, and a manifest declaring its configuration surface. Install once into an MCPB-aware host (Claude Desktop, Claude Code) and configure your vault.

## Install

1. **Get the bundle.** Either download `vaultnexus-<version>.mcpb` from a release, or build it locally:

   ```sh
   pnpm install
   pnpm package:mcpb
   ```

   Output lands in `dist-mcpb/vaultnexus-<version>.mcpb` (~26 MB).

2. **Install into the host.** In Claude Desktop or Claude Code settings, install an MCP server from a local `.mcpb` file and point it at the bundle.

3. **Configure.** The host will prompt for the fields declared in `user_config`:

   - **Vault Path** (required, directory) — absolute path to your Obsidian or Markdown vault.
   - **Chat Provider** (optional) — `anthropic`, `openai`, or empty to disable LLM-cited reasoning.
   - **Chat API Key** (optional, sensitive) — key for the selected provider. Leave empty to run retrieval-only.

   See [user_config caveat](#user_config-only-reaches-the-bridge-today) below — these values currently reach only the bridge process, not the daemon, until the auto-spawn feature lands.

4. **Run.** The bundle launches `node server/dist/bridge/main.js`. The bridge is a stdio shim that pipes MCP JSON-RPC traffic to a persistent daemon over a local socket. The daemon must be running — see [daemon](#daemon).

## Daemon

The MCPB bundle ships both `bridge` (stdio MCP entry) and `daemon` (persistent index + tool server). Today the daemon must be started out-of-band:

```sh
node /path/to/extracted-bundle/server/dist/daemon/main.js
```

A future release will let the bridge auto-spawn the daemon on first connect. Track the socket at `$XDG_RUNTIME_DIR/vaultnexus.sock` (Linux) or the equivalent platform path.

## user_config only reaches the bridge today

**Important caveat.** MCPB hosts inject `user_config` values into the env of the process they spawn — which for this bundle is the **bridge** (`server/dist/bridge/main.js`). The bridge is a thin stdio shim that connects to the daemon over a Unix socket; it does NOT propagate env to the daemon. The daemon is a separate, long-lived process started out-of-band (see above) and reads its own env from the shell that launched it.

Net effect: setting `chat_api_key` or `vault_path` in the host UI populates env on the bridge, where they go unused. The daemon will read whatever was exported in the shell that started it.

**Until auto-spawn lands** (planned), you must export the same env vars in the shell that starts the daemon. The variable names the daemon actually reads (verified against `src/daemon/`):

| user_config field | daemon env var          | source                                |
| ----------------- | ----------------------- | ------------------------------------- |
| `vault_path`      | `VAULTNEXUS_VAULT`      | `src/daemon/main.ts`                  |
| `chat_provider`   | `VAULTNEXUS_CHAT_PROVIDER` | `src/daemon/select-chat-model.ts`  |
| `chat_api_key`    | `VAULTNEXUS_CHAT_KEY`   | `src/daemon/select-chat-model.ts`     |

Example:

```sh
export VAULTNEXUS_VAULT=/path/to/your/vault
export VAULTNEXUS_CHAT_PROVIDER=anthropic
export VAULTNEXUS_CHAT_KEY=sk-ant-...
node /path/to/extracted-bundle/server/dist/daemon/main.js
```

The manifest's `mcp_config.env` uses the daemon-correct names too — so that once auto-spawn lands, no rename will be needed.

## Runtime requirements

- Node `>=22` on the host. The bundle does not embed a Node runtime; the MCPB host (or your shell) provides `node`.
- **Platforms: macOS arm64 only** (today). The bundle ships only the build-host's native `better-sqlite3` and `numkong` binaries. Linux and Windows support requires cross-platform prebuilds that this packaging script does not yet produce. The `compatibility.platforms` field in the manifest reflects that single-platform reality (`["darwin"]`, `architectures: ["arm64"]`).
- Native modules (`better-sqlite3`, `numkong`) ship as prebuilt N-API binaries inside `server/node_modules/.pnpm/<pkg>@<ver>/node_modules/<dep>/` (pnpm flat layout, symlinked from `server/node_modules/<dep>`).

## Building from source

```sh
pnpm install
pnpm build           # tsc → dist/
pnpm package:mcpb    # tsc + pnpm deploy + zip → dist-mcpb/*.mcpb
```

The packaging script lives at `scripts/build-mcpb.ts`. The canonical manifest lives at `mcpb/manifest.json` — version is overwritten from `package.json` at build time.

### How packaging works

The script uses `pnpm deploy --legacy --prod --filter=vaultnexus <tmp>` to produce a self-contained production dependency tree (including pnpm's `.pnpm/` virtual store with all transitive dependencies). It then copies that tree into the bundle with `cpSync({verbatimSymlinks: true})` and zips with `zip -y` to preserve relative symlinks. Node's module resolution follows the symlinks at runtime, so the bundle is functional once extracted.

The earlier walker-based approach silently dropped transitive deps under pnpm's flat layout (e.g. `bindings`, `ajv`, `node-gyp-build`) because they live in `.pnpm/<pkg>/node_modules/<dep>` rather than `node_modules/<dep>/node_modules/<sub>`. The deploy-based approach is the supported pnpm primitive for this use case.
