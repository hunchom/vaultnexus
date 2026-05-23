# VaultNexus Plan 01 — Daemon Foundation & MCP Self-Bridge

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A running VaultNexus daemon that Claude Code can reach end-to-end through a thin stdio→socket bridge, exposing one health-probe MCP tool — the walking skeleton every later subsystem builds on.

**Architecture:** One long-running Node 22 process (the daemon) owns all state and is the single writer. It listens on a Unix domain socket (the Claude Code path) and a loopback HTTP port (the future Obsidian path). Claude Code speaks MCP over stdio to a ~15-line **bridge** binary that does nothing but shuttle raw bytes between its stdio and the daemon's socket. The daemon wraps each socket connection in a hand-rolled `SocketServerTransport` (implementing the MCP SDK's stable `Transport` interface with newline-delimited JSON-RPC framing) and connects it to an `McpServer`. `core/` is pure and I/O-free; the daemon injects all I/O.

**Tech Stack:** TypeScript (ESM, `NodeNext`), Node 22, pnpm, vitest, `@modelcontextprotocol/sdk` (v1.x), `hono` + `@hono/node-server`, `proper-lockfile`, `tsx` (dev runner).

**Scope note:** This is Plan 01 of a multi-plan build (see `docs/specs/2026-05-23-vaultnexus-concept.md` §8). It deliberately ships *only* the daemon/bridge spine + a trivial `vaultnexus_ping` tool. No retrieval, no parsing, no epistemic features — those are Plans 02+. The point is to de-risk the trickiest novel plumbing (the self-bridge + single-writer socket transport) first, with a fully tested end-to-end path.

---

## File Structure

| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore` | Toolchain + ESM/NodeNext config |
| `src/core/health.ts` | Pure `health()` + `VERSION` (no I/O) |
| `src/core/paths.ts` | Pure default socket/lock path resolution |
| `src/daemon/socket-transport.ts` | `SocketServerTransport` — MCP `Transport` over a `net.Socket` |
| `src/daemon/mcp-server.ts` | `createMcpServer()` — `McpServer` + `vaultnexus_ping` tool |
| `src/daemon/http.ts` | `createHttpApp()` — Hono app with `GET /health` |
| `src/daemon/lock.ts` | `acquireSingleInstanceLock()` — single-writer guard |
| `src/daemon/main.ts` | Daemon entrypoint: lock → socket server + loopback HTTP → lifecycle |
| `src/bridge/main.ts` | stdio↔socket dumb-pipe bridge binary |
| `test/**` | Co-located vitest unit + integration tests |

---

## Task 1: Project scaffold + toolchain

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `test/smoke.test.ts`

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "vaultnexus",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "bin": {
    "vaultnexus-daemon": "dist/daemon/main.js",
    "vaultnexus-bridge": "dist/bridge/main.js"
  },
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "dev:daemon": "tsx src/daemon/main.ts",
    "dev:bridge": "tsx src/bridge/main.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0",
    "hono": "^4.6.0",
    "@hono/node-server": "^1.13.0",
    "proper-lockfile": "^4.1.2"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^2.1.0",
    "tsx": "^4.19.0",
    "@types/node": "^22.7.0",
    "@types/proper-lockfile": "^4.1.4"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "rootDir": "src",
    "outDir": "dist",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": false,
    "sourceMap": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Write `vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 20000,
  },
});
```

- [ ] **Step 4: Write `.gitignore`**

```gitignore
node_modules/
dist/
*.log
*.sock
*.lock
```

- [ ] **Step 5: Write the smoke test `test/smoke.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';

describe('toolchain', () => {
  it('runs vitest', () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 6: Install and run**

Run: `pnpm install && pnpm test`
Expected: install succeeds; vitest reports `1 passed`.

- [ ] **Step 7: Verify TypeScript compiles (empty src is fine)**

Run: `pnpm build`
Expected: exit 0, `dist/` created (may be empty — no `src/` files yet).

- [ ] **Step 8: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts .gitignore test/smoke.test.ts
git commit -m "chore: scaffold TypeScript/ESM project with vitest"
```

---

## Task 2: `core/health.ts` — pure health probe

**Files:**
- Create: `src/core/health.ts`
- Test: `test/core/health.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/core/health.test.ts
import { describe, it, expect } from 'vitest';
import { health, VERSION } from '../../src/core/health.js';

describe('health', () => {
  it('reports ok status and the package version', () => {
    expect(VERSION).toBe('0.0.1');
    expect(health()).toEqual({ status: 'ok', version: '0.0.1' });
  });

  it('is pure (same result every call)', () => {
    expect(health()).toEqual(health());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/core/health.test.ts`
Expected: FAIL — cannot resolve `../../src/core/health.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/core/health.ts
export const VERSION = '0.0.1';

export interface HealthStatus {
  status: 'ok';
  version: string;
}

/** Pure health/version snapshot. No I/O — the daemon adds runtime fields. */
export function health(): HealthStatus {
  return { status: 'ok', version: VERSION };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/core/health.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/health.ts test/core/health.test.ts
git commit -m "feat(core): pure health/version probe"
```

---

## Task 3: `core/paths.ts` — default socket/lock paths

**Files:**
- Create: `src/core/paths.ts`
- Test: `test/core/paths.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/core/paths.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSocketPath, defaultLockPath } from '../../src/core/paths.js';

const savedSock = process.env.VAULTNEXUS_SOCKET;
const savedLock = process.env.VAULTNEXUS_LOCK;

afterEach(() => {
  if (savedSock === undefined) delete process.env.VAULTNEXUS_SOCKET;
  else process.env.VAULTNEXUS_SOCKET = savedSock;
  if (savedLock === undefined) delete process.env.VAULTNEXUS_LOCK;
  else process.env.VAULTNEXUS_LOCK = savedLock;
});

describe('paths', () => {
  it('defaults to tmpdir when env unset', () => {
    delete process.env.VAULTNEXUS_SOCKET;
    delete process.env.VAULTNEXUS_LOCK;
    expect(defaultSocketPath()).toBe(join(tmpdir(), 'vaultnexus.sock'));
    expect(defaultLockPath()).toBe(join(tmpdir(), 'vaultnexus.lock'));
  });

  it('honors env overrides', () => {
    process.env.VAULTNEXUS_SOCKET = '/tmp/custom.sock';
    process.env.VAULTNEXUS_LOCK = '/tmp/custom.lock';
    expect(defaultSocketPath()).toBe('/tmp/custom.sock');
    expect(defaultLockPath()).toBe('/tmp/custom.lock');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/core/paths.test.ts`
Expected: FAIL — cannot resolve `../../src/core/paths.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/core/paths.ts
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Unix socket the daemon listens on / the bridge connects to. */
export function defaultSocketPath(): string {
  return process.env.VAULTNEXUS_SOCKET ?? join(tmpdir(), 'vaultnexus.sock');
}

/** Single-instance lock file. */
export function defaultLockPath(): string {
  return process.env.VAULTNEXUS_LOCK ?? join(tmpdir(), 'vaultnexus.lock');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/core/paths.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/paths.ts test/core/paths.test.ts
git commit -m "feat(core): default socket/lock path resolution"
```

---

## Task 4: `SocketServerTransport` — MCP transport over a socket

The MCP SDK's `Transport` interface is small and stable: `start()`, `send(message)`, `close()`, plus the `onmessage`/`onclose`/`onerror` callbacks. We implement it over a `net.Socket` with newline-delimited JSON-RPC framing (the same wire format MCP's stdio transport uses), so the bridge can stay a dumb byte pipe.

**Files:**
- Create: `src/daemon/socket-transport.ts`
- Test: `test/daemon/socket-transport.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/daemon/socket-transport.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { SocketServerTransport } from '../../src/daemon/socket-transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

const sockPath = join(tmpdir(), `vn-transport-test-${process.pid}.sock`);
let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
  try { rmSync(sockPath); } catch { /* already gone */ }
});

/** Spin up a server that wraps its one connection in SocketServerTransport. */
function listenWithTransport(): Promise<SocketServerTransport> {
  return new Promise((resolve) => {
    server = createServer((socket: Socket) => {
      const t = new SocketServerTransport(socket);
      void t.start();
      resolve(t);
    });
    server.listen(sockPath);
  });
}

describe('SocketServerTransport', () => {
  it('parses newline-delimited JSON-RPC into onmessage', async () => {
    const transportPromise = listenWithTransport();
    const client = connect(sockPath);
    await new Promise<void>((r) => client.on('connect', () => r()));
    const transport = await transportPromise;

    const received: JSONRPCMessage[] = [];
    transport.onmessage = (m) => received.push(m);

    client.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) + '\n');
    await new Promise<void>((r) => setTimeout(r, 50));

    expect(received).toEqual([{ jsonrpc: '2.0', id: 1, method: 'ping' }]);
    client.destroy();
  });

  it('serializes send() as one JSON line', async () => {
    const transportPromise = listenWithTransport();
    const client = connect(sockPath);
    await new Promise<void>((r) => client.on('connect', () => r()));
    const transport = await transportPromise;

    const chunks: string[] = [];
    client.setEncoding('utf8');
    client.on('data', (c: string) => chunks.push(c));

    await transport.send({ jsonrpc: '2.0', id: 2, result: { ok: true } });
    await new Promise<void>((r) => setTimeout(r, 50));

    expect(chunks.join('')).toBe(
      JSON.stringify({ jsonrpc: '2.0', id: 2, result: { ok: true } }) + '\n',
    );
    client.destroy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/daemon/socket-transport.test.ts`
Expected: FAIL — cannot resolve `../../src/daemon/socket-transport.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/daemon/socket-transport.ts
import type { Socket } from 'node:net';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/** MCP Transport over a net.Socket using newline-delimited JSON-RPC framing. */
export class SocketServerTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private buffer = '';

  constructor(private readonly socket: Socket) {}

  async start(): Promise<void> {
    this.socket.setEncoding('utf8');
    this.socket.on('data', (chunk: string) => this.ingest(chunk));
    this.socket.on('close', () => this.onclose?.());
    this.socket.on('error', (err) => this.onerror?.(err));
  }

  private ingest(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      try {
        this.onmessage?.(JSON.parse(line) as JSONRPCMessage);
      } catch (err) {
        this.onerror?.(err as Error);
      }
    }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.socket.write(JSON.stringify(message) + '\n');
  }

  async close(): Promise<void> {
    this.socket.end();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/daemon/socket-transport.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/socket-transport.ts test/daemon/socket-transport.test.ts
git commit -m "feat(daemon): MCP Transport over a Unix socket (newline JSON framing)"
```

---

## Task 5: `createMcpServer()` — the MCP server + `vaultnexus_ping` tool

**Files:**
- Create: `src/daemon/mcp-server.ts`
- Test: `test/daemon/mcp-server.test.ts`

Tested with the SDK's in-memory transport pair (no socket needed) so the server logic is verified in isolation.

- [ ] **Step 1: Write the failing test**

```typescript
// test/daemon/mcp-server.test.ts
import { describe, it, expect } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createMcpServer } from '../../src/daemon/mcp-server.js';
import { health } from '../../src/core/health.js';

describe('createMcpServer', () => {
  it('exposes vaultnexus_ping returning the health snapshot', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer();
    await server.connect(serverTransport);

    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(clientTransport);

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain('vaultnexus_ping');

    const result = await client.callTool({ name: 'vaultnexus_ping', arguments: {} });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(JSON.parse(text)).toEqual(health());

    await client.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/daemon/mcp-server.test.ts`
Expected: FAIL — cannot resolve `../../src/daemon/mcp-server.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/daemon/mcp-server.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { health } from '../core/health.js';

/** Build the VaultNexus MCP server. Plan 01 ships only the ping probe. */
export function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'vaultnexus', version: health().version });

  server.registerTool(
    'vaultnexus_ping',
    { description: 'Health and version probe for the VaultNexus daemon.' },
    async () => ({ content: [{ type: 'text', text: JSON.stringify(health()) }] }),
  );

  return server;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/daemon/mcp-server.test.ts`
Expected: PASS (1 test). If the import `@modelcontextprotocol/sdk/inMemory.js` fails to resolve, check the installed SDK version's export map (`node -e "require('@modelcontextprotocol/sdk/package.json')"`) and adjust the subpath — the class is `InMemoryTransport` with a static `createLinkedPair()`.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/mcp-server.ts test/daemon/mcp-server.test.ts
git commit -m "feat(daemon): MCP server with vaultnexus_ping probe"
```

---

## Task 6: `createHttpApp()` — loopback HTTP health endpoint

**Files:**
- Create: `src/daemon/http.ts`
- Test: `test/daemon/http.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/daemon/http.test.ts
import { describe, it, expect } from 'vitest';
import { createHttpApp } from '../../src/daemon/http.js';
import { health } from '../../src/core/health.js';

describe('createHttpApp', () => {
  it('serves GET /health as JSON', async () => {
    const app = createHttpApp();
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(health());
  });

  it('404s unknown routes', async () => {
    const res = await createHttpApp().request('/nope');
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/daemon/http.test.ts`
Expected: FAIL — cannot resolve `../../src/daemon/http.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/daemon/http.ts
import { Hono } from 'hono';
import { health } from '../core/health.js';

/** Loopback HTTP surface (the future Obsidian-plugin path). */
export function createHttpApp(): Hono {
  const app = new Hono();
  app.get('/health', (c) => c.json(health()));
  return app;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/daemon/http.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/http.ts test/daemon/http.test.ts
git commit -m "feat(daemon): loopback HTTP /health endpoint"
```

---

## Task 7: `acquireSingleInstanceLock()` — single-writer guard

**Files:**
- Create: `src/daemon/lock.ts`
- Test: `test/daemon/lock.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/daemon/lock.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { acquireSingleInstanceLock } from '../../src/daemon/lock.js';

const lockPath = join(tmpdir(), `vn-lock-test-${process.pid}.lock`);

afterEach(() => {
  try { rmSync(lockPath); } catch { /* ignore */ }
});

describe('acquireSingleInstanceLock', () => {
  it('grants the first holder and rejects a second', async () => {
    const release = await acquireSingleInstanceLock(lockPath);
    await expect(acquireSingleInstanceLock(lockPath)).rejects.toThrow();
    await release();
  });

  it('allows re-acquisition after release', async () => {
    const release1 = await acquireSingleInstanceLock(lockPath);
    await release1();
    const release2 = await acquireSingleInstanceLock(lockPath);
    await release2();
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/daemon/lock.test.ts`
Expected: FAIL — cannot resolve `../../src/daemon/lock.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/daemon/lock.ts
import { existsSync, writeFileSync } from 'node:fs';
import lockfile from 'proper-lockfile';

/**
 * Acquire the single-instance lock. Rejects if another daemon holds it.
 * Returns a release function. proper-lockfile locks an existing path, so we
 * touch the file first.
 */
export async function acquireSingleInstanceLock(lockPath: string): Promise<() => Promise<void>> {
  if (!existsSync(lockPath)) writeFileSync(lockPath, '');
  return lockfile.lock(lockPath, { stale: 30_000, realpath: false });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/daemon/lock.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/lock.ts test/daemon/lock.test.ts
git commit -m "feat(daemon): single-instance lock via proper-lockfile"
```

---

## Task 8: `daemon/main.ts` — wire socket + loopback + lock + lifecycle

**Files:**
- Create: `src/daemon/main.ts`
- Test: `test/daemon/main.integration.test.ts`

The integration test spawns the daemon as a real child process, waits for its `VAULTNEXUS_READY` line on stderr, hits the loopback `/health`, then confirms a second instance exits non-zero (lock held).

- [ ] **Step 1: Write the failing test**

```typescript
// test/daemon/main.integration.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const sock = join(tmpdir(), `vn-main-${process.pid}.sock`);
const lock = join(tmpdir(), `vn-main-${process.pid}.lock`);
const port = '38473';
const env = { ...process.env, VAULTNEXUS_SOCKET: sock, VAULTNEXUS_LOCK: lock, VAULTNEXUS_HTTP_PORT: port };
let children: ChildProcess[] = [];

function startDaemon(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/daemon/main.ts'], { env });
  children.push(child);
  return new Promise((resolve, reject) => {
    let buf = '';
    child.stderr.on('data', (d: Buffer) => {
      buf += d.toString();
      if (buf.includes('VAULTNEXUS_READY')) resolve(child);
    });
    child.on('exit', (code) => reject(new Error(`daemon exited early: ${code}\n${buf}`)));
  });
}

afterEach(async () => {
  for (const c of children) c.kill('SIGTERM');
  children = [];
  await new Promise((r) => setTimeout(r, 200));
  for (const p of [sock, lock]) { try { rmSync(p); } catch { /* ignore */ } }
});

describe('daemon/main', () => {
  it('serves loopback /health once ready', async () => {
    await startDaemon();
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    expect((await res.json() as { status: string }).status).toBe('ok');
  });

  it('refuses a second instance (lock held)', async () => {
    await startDaemon();
    const second = spawn(process.execPath, ['--import', 'tsx', 'src/daemon/main.ts'], { env });
    children.push(second);
    const code = await new Promise<number | null>((r) => second.on('exit', r));
    expect(code).not.toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/daemon/main.integration.test.ts`
Expected: FAIL — daemon exits early (no `src/daemon/main.ts`).

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/daemon/main.ts
import { createServer, type Socket } from 'node:net';
import { existsSync, rmSync } from 'node:fs';
import { serve, type ServerType } from '@hono/node-server';
import { defaultSocketPath, defaultLockPath } from '../core/paths.js';
import { acquireSingleInstanceLock } from './lock.js';
import { createMcpServer } from './mcp-server.js';
import { SocketServerTransport } from './socket-transport.js';
import { createHttpApp } from './http.js';

async function main(): Promise<void> {
  const socketPath = defaultSocketPath();
  const lockPath = defaultLockPath();
  const httpPort = Number(process.env.VAULTNEXUS_HTTP_PORT ?? 38473);

  let release: () => Promise<void>;
  try {
    release = await acquireSingleInstanceLock(lockPath);
  } catch {
    process.stderr.write('vaultnexus: another daemon is already running\n');
    process.exit(1);
  }

  // Stale socket file from a previous crash would block listen().
  if (existsSync(socketPath)) rmSync(socketPath);

  const socketServer = createServer((socket: Socket) => {
    const transport = new SocketServerTransport(socket);
    const mcp = createMcpServer();
    void mcp.connect(transport);
  });
  await new Promise<void>((resolve) => socketServer.listen(socketPath, resolve));

  const http: ServerType = serve({
    fetch: createHttpApp().fetch,
    hostname: '127.0.0.1',
    port: httpPort,
  });

  const shutdown = async (): Promise<void> => {
    socketServer.close();
    http.close();
    if (existsSync(socketPath)) rmSync(socketPath);
    await release();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  // Readiness signal the integration test waits on.
  process.stderr.write('VAULTNEXUS_READY\n');
}

main().catch((err) => {
  process.stderr.write(`vaultnexus: fatal ${String(err)}\n`);
  process.exit(1);
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/daemon/main.integration.test.ts`
Expected: PASS (2 tests). If the daemon never prints `VAULTNEXUS_READY`, run it directly to see the error: `VAULTNEXUS_SOCKET=/tmp/x.sock VAULTNEXUS_LOCK=/tmp/x.lock pnpm dev:daemon`.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/main.ts test/daemon/main.integration.test.ts
git commit -m "feat(daemon): entrypoint wiring socket MCP + loopback HTTP + lock"
```

---

## Task 9: `bridge/main.ts` — stdio↔socket dumb pipe + full end-to-end test

The bridge is what Claude Code spawns. It connects to the daemon's socket and shuttles raw bytes: `stdin → socket`, `socket → stdout`. No MCP parsing. The end-to-end test proves the real Claude-Code path: an SDK `Client` driving `StdioClientTransport` that spawns the bridge, which reaches a running daemon.

**Files:**
- Create: `src/bridge/main.ts`
- Test: `test/bridge/e2e.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/bridge/e2e.test.ts
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { health } from '../../src/core/health.js';

const sock = join(tmpdir(), `vn-e2e-${process.pid}.sock`);
const lock = join(tmpdir(), `vn-e2e-${process.pid}.lock`);
let daemon: ChildProcess | undefined;

beforeEach(async () => {
  const env = { ...process.env, VAULTNEXUS_SOCKET: sock, VAULTNEXUS_LOCK: lock, VAULTNEXUS_HTTP_PORT: '38474' };
  daemon = spawn(process.execPath, ['--import', 'tsx', 'src/daemon/main.ts'], { env });
  await new Promise<void>((resolve, reject) => {
    let buf = '';
    daemon!.stderr!.on('data', (d: Buffer) => {
      buf += d.toString();
      if (buf.includes('VAULTNEXUS_READY')) resolve();
    });
    daemon!.on('exit', (c) => reject(new Error(`daemon exited: ${c}\n${buf}`)));
  });
});

afterEach(async () => {
  daemon?.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 200));
  for (const p of [sock, lock]) { try { rmSync(p); } catch { /* ignore */ } }
});

describe('end-to-end: Claude Code -> bridge -> daemon', () => {
  it('lists and calls vaultnexus_ping through the bridge', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', 'src/bridge/main.ts'],
      env: { PATH: process.env.PATH ?? '', VAULTNEXUS_SOCKET: sock },
    });
    const client = new Client({ name: 'e2e', version: '0.0.0' });
    await client.connect(transport);

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain('vaultnexus_ping');

    const result = await client.callTool({ name: 'vaultnexus_ping', arguments: {} });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(JSON.parse(text)).toEqual(health());

    await client.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/bridge/e2e.test.ts`
Expected: FAIL — bridge spawn produces no MCP responses (no `src/bridge/main.ts`).

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/bridge/main.ts
import { connect } from 'node:net';
import { defaultSocketPath } from '../core/paths.js';

// Dumb byte pipe: Claude Code <-> (stdio) <-> this bridge <-> (socket) <-> daemon.
// No MCP parsing — newline-delimited JSON-RPC passes through untouched.
const socket = connect(defaultSocketPath());

socket.on('connect', () => {
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
});

socket.on('error', (err) => {
  process.stderr.write(`vaultnexus-bridge: ${err.message}\n`);
  process.exit(1);
});

socket.on('close', () => process.exit(0));
process.stdin.on('end', () => socket.end());
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/bridge/e2e.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Run the full suite + build**

Run: `pnpm test && pnpm build`
Expected: all tests pass; `tsc` exits 0 with `dist/daemon/main.js` and `dist/bridge/main.js` emitted.

- [ ] **Step 6: Commit**

```bash
git add src/bridge/main.ts test/bridge/e2e.test.ts
git commit -m "feat(bridge): stdio<->socket pipe + end-to-end MCP test"
```

---

## Task 10: Run/usage docs

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write `README.md`**

````markdown
# VaultNexus

Local-first knowledge engine for an Obsidian/Markdown vault, exposed to Claude Code over MCP. See `docs/specs/2026-05-23-vaultnexus-concept.md` for the design.

## Status

Plan 01 (foundation): a daemon + stdio→socket MCP bridge with a `vaultnexus_ping` health tool. No retrieval yet.

## Develop

```bash
pnpm install
pnpm test          # unit + integration + e2e
pnpm build         # tsc -> dist/
```

## Run

Start the daemon (single instance per machine):

```bash
pnpm dev:daemon    # or: node dist/daemon/main.js
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
````

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: foundation run/usage README"
```

---

## Self-Review (completed during authoring)

**Spec coverage (concept §2 + §8 wave-1 plumbing):**
- Standalone daemon, single writer → Tasks 8 (net server, one connection→one McpServer). ✓
- Unix domain socket (Claude Code path) → Tasks 4, 8. ✓
- Loopback HTTP (Obsidian path) → Tasks 6, 8. ✓
- ~40-line stdio→socket self-bridge, *not* mcp-proxy → Task 9 (pure `net` + pipe). ✓
- Single-instance via lock + socket → Task 7 + stale-socket unlink in Task 8. ✓
- `core/` pure, I/O-free → Tasks 2, 3 (health, paths; no I/O). ✓
- MCP via `@modelcontextprotocol/sdk` → Tasks 5, 9. ✓
- *Out of scope by design (later plans):* retrieval, chunking, vector engine, FTS5, convergence, epistemic layer, providers, MCPB packaging. Tracked in Plans 02+.

**Placeholder scan:** none — every code/command step is complete.

**Type consistency:** `health()`→`HealthStatus` used identically in Tasks 2/5/6/9; `defaultSocketPath`/`defaultLockPath` defined in Task 3, consumed in Tasks 8/9; `SocketServerTransport(socket)` ctor consistent across Tasks 4/8; tool name `vaultnexus_ping` identical in Tasks 5/9.

**Known version-sensitive points (flagged inline, with fallbacks):** `@modelcontextprotocol/sdk` subpaths (`/server/mcp.js`, `/client/index.js`, `/client/stdio.js`, `/inMemory.js`, `/shared/transport.js`, `/types.js`) and `registerTool(name, {description}, cb)` are the v1.x shape; Task 5 Step 4 documents how to confirm against the installed version.
