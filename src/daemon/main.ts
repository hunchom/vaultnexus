import { createServer, type Socket } from 'node:net';
import { existsSync, rmSync } from 'node:fs';
import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
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
    return; // unreachable — satisfies TS definite-assignment for release
  }

  // Remove stale socket from prior crash to avoid EADDRINUSE.
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

  // Readiness signal — integration test waits for this line on stderr.
  process.stderr.write('VAULTNEXUS_READY\n');
}

main().catch((err) => {
  process.stderr.write(`vaultnexus: fatal ${String(err)}\n`);
  process.exit(1);
});
