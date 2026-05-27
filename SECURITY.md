# Security policy

## Supported versions

Only the latest minor release line gets security updates.

| Version | Supported |
|---|---|
| 0.1.x   | yes |
| < 0.1.0 | no  |

## Reporting a vulnerability

Open a private security advisory on GitHub:

→ [github.com/hunchom/vaultnexus/security/advisories/new](https://github.com/hunchom/vaultnexus/security/advisories/new)

Please do NOT open a public issue for security problems.

I aim to respond within 7 days. Coordinated-disclosure timelines depend on severity but I'll target a fix or mitigation within 30 days for anything exploitable.

## Threat model

VaultNexus binds `127.0.0.1` loopback only. The threat model assumes a trusted local user. Specifically:

- **In scope:** logic bugs in the daemon, the MCP server, or the plugin that could exfiltrate vault contents to a third party, escalate via injection in MCP responses, or corrupt the snapshot. CORS / CSRF on the loopback surface (since browser-origin requests do reach it).
- **Out of scope:** an attacker who already has shell access on the user's machine (they can read the vault directly). Embedding-API endpoints (those are third-party services and trust their own surface). Obsidian itself (upstream concern).

## Sensitive data handling

- API keys for embedders and chat models live in env vars or plugin `data.json`. Keys are sent over loopback to the daemon but are never logged, never echoed in `/status`, and never persisted by the daemon itself.
- The vault path is on the local filesystem and never transmitted off-machine. Embedding requests send chunk text to the configured provider — choose your provider with that in mind.
- The snapshot SQLite at `~/.vaultnexus/index-snapshot.db` contains chunk text + vectors. Treat as sensitive if your vault is.
