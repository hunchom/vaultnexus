#!/usr/bin/env node
import { createServer, type Socket } from 'node:net';
import { existsSync, rmSync, unlinkSync } from 'node:fs';
import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import { defaultSocketPath, defaultLockPath, defaultIndexSnapshotPath } from '../core/paths.js';
import { acquireSingleInstanceLock, lockFailureMessage } from './lock.js';
import { createMcpServer } from './mcp-server.js';
import { SocketServerTransport } from './socket-transport.js';
import { createHttpApp } from './http.js';
import { selectEmbedder } from './select-embedder.js';
import { selectChatModel } from './select-chat-model.js';
import { VaultIndex } from './vault-index.js';
import { indexVault } from './indexer.js';
import { IndexSnapshot } from './index-snapshot.js';
import { restoreOrRebuildIndex } from './index-restore.js';

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
  const snapPath = defaultIndexSnapshotPath(process.env);
  let snapshot: IndexSnapshot | null = null;
  let index: VaultIndex;
  if (vaultDir && snapPath !== 'off') {
    // Plan 26 — restore unchanged notes from disk, rebuild only the deltas.
    // Corruption-recovery: SQLITE_NOTADB / garbage file → unlink + retry once → fall through to indexVault.
    const openWithRecovery = async (): Promise<{ snap: IndexSnapshot; idx: VaultIndex; stats: import('./index-restore.js').RestoreStats } | null> => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const snap = new IndexSnapshot(snapPath);
          const { index: idx, stats } = await restoreOrRebuildIndex(vaultDir, embedder, snap, chatModel);
          return { snap, idx, stats };
        } catch (e) {
          process.stderr.write(`vaultnexus: snapshot open failed (attempt ${attempt + 1}) ${String(e)}\n`);
          try { unlinkSync(snapPath); } catch { /* file may not exist → ignore */ }
          // sqlite WAL/SHM sidecars → drop too, else next open re-reads corrupt journal
          for (const ext of ['-wal', '-shm', '-journal']) {
            try { unlinkSync(snapPath + ext); } catch { /* ignore */ }
          }
        }
      }
      return null;
    };
    const t0 = process.hrtime.bigint();
    const recovered = await openWithRecovery();
    if (recovered) {
      snapshot = recovered.snap;
      index = recovered.idx;
      const ms = Number((process.hrtime.bigint() - t0) / 1_000_000n);
      process.stderr.write(
        `vaultnexus: indexed ${recovered.stats.total} notes from ${vaultDir} ` +
        `(restored=${recovered.stats.restored} rebuilt=${recovered.stats.rebuilt} pruned=${recovered.stats.pruned}, ${ms}ms)\n`,
      );
    } else {
      // snapshot unusable after recovery attempts → fall back to plain indexVault (Plan 06 path)
      process.stderr.write('vaultnexus: snapshot disabled after corruption-recovery failure → using plain indexVault\n');
      index = new VaultIndex(embedder, vaultDir, chatModel);
      const n = await indexVault(vaultDir, index);
      process.stderr.write(`vaultnexus: indexed ${n} notes from ${vaultDir}\n`);
    }
  } else {
    index = new VaultIndex(embedder, vaultDir, chatModel);
    if (vaultDir) {
      const n = await indexVault(vaultDir, index);
      process.stderr.write(`vaultnexus: indexed ${n} notes from ${vaultDir}\n`);
    }
  }

  const socketServer = createServer((socket: Socket) => {
    const transport = new SocketServerTransport(socket);
    const mcp = createMcpServer({ index: vaultDir ? index : undefined });
    mcp.connect(transport).catch((e) =>
      process.stderr.write(`vaultnexus: connection failed ${String(e)}\n`),
    );
  });
  await new Promise<void>((resolve) => socketServer.listen(socketPath, resolve));

  // Await actual bind → race-free readiness signal for integration tests
  let httpReady: () => void;
  const httpListening = new Promise<void>((r) => { httpReady = r; });
  const http: ServerType = serve(
    {
      fetch: createHttpApp({ index: vaultDir ? index : undefined }).fetch,
      hostname: '127.0.0.1',
      port: httpPort,
    },
    () => httpReady(),
  );
  await httpListening;

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
    if (snapshot) snapshot.close(); // release index snapshot db handle
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
