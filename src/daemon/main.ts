#!/usr/bin/env node
import { createServer, type Socket } from 'node:net';
import { existsSync, rmSync } from 'node:fs';
import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import { defaultSocketPath, defaultLockPath } from '../core/paths.js';
import { acquireSingleInstanceLock, lockFailureMessage } from './lock.js';
import { createMcpServer } from './mcp-server.js';
import { SocketServerTransport } from './socket-transport.js';
import { createHttpApp } from './http.js';
import { selectEmbedder } from './select-embedder.js';
import { selectChatModel } from './select-chat-model.js';
import { VaultIndex } from './vault-index.js';
import { indexVault } from './indexer.js';

async function main(): Promise<void> {
  const socketPath = defaultSocketPath();
  const lockPath = defaultLockPath();
  const httpPort = Number(process.env.VAULTNEXUS_HTTP_PORT ?? 38473);

  // Forward-ref: reassigned to full handler after servers start.
  let shutdown: () => Promise<void> = async () => process.exit(1);
  let shuttingDown = false; // guard against double SIGINT/SIGTERM

  // single-writer guard → exit 1 if another daemon holds the lock
  const release = await acquireSingleInstanceLock(lockPath, (err) => {
    process.stderr.write(`vaultnexus: lock compromised ${err.message}\n`);
    void shutdown();
  }).catch((err): never => {
    process.stderr.write(lockFailureMessage(err));
    process.exit(1);
  });

  // Remove stale socket from prior crash to avoid EADDRINUSE.
  if (existsSync(socketPath)) rmSync(socketPath);

  const embedder = await selectEmbedder();
  const chatModel = selectChatModel(process.env);
  process.stderr.write(`vaultnexus: chat model = ${chatModel.id}\n`);
  const vaultDir = process.env.VAULTNEXUS_VAULT;
  const index = new VaultIndex(embedder, vaultDir, chatModel);
  if (vaultDir) {
    const n = await indexVault(vaultDir, index);
    process.stderr.write(`vaultnexus: indexed ${n} notes from ${vaultDir}\n`);
  }

  const socketServer = createServer((socket: Socket) => {
    const transport = new SocketServerTransport(socket);
    const mcp = createMcpServer({ index: vaultDir ? index : undefined });
    mcp.connect(transport).catch((e) =>
      process.stderr.write(`vaultnexus: connection failed ${String(e)}\n`),
    );
  });
  await new Promise<void>((resolve) => socketServer.listen(socketPath, resolve));

  const http: ServerType = serve({
    fetch: createHttpApp().fetch,
    hostname: '127.0.0.1',
    port: httpPort,
  });

  // Promisify server closes so cleanup completes before exit.
  const closeSocketServer = (): Promise<void> =>
    new Promise<void>((resolve) => socketServer.close(() => resolve()));
  const closeHttp = (): Promise<void> =>
    new Promise<void>((resolve) => http.close(() => resolve()));

  shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await Promise.all([closeSocketServer(), closeHttp()]).catch(() => {/* still clean up */});
    if (existsSync(socketPath)) rmSync(socketPath);
    const e = embedder as { close?: () => void };
    if (typeof e.close === 'function') e.close(); // release cache db handle
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
