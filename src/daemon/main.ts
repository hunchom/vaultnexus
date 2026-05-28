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

  // Recent self-writes suppress the next fs.watch reindex for that path → prevents
  // double reindex churn from a tool write + the subsequent inotify event.
  const recentSelfWrites = new Map<string, number>();
  const suppressNextWatch = (notePath: string): void => {
    recentSelfWrites.set(notePath, Date.now() + 1500);
  };

  // Re-index a single note → called by MCP write tools + fs.watch.
  const reindexNote = async (notePath: string): Promise<void> => {
    if (!vaultDir) return;
    suppressNextWatch(notePath);
    try {
      const { createHash } = await import('node:crypto');
      const { readFile, stat } = await import('node:fs/promises');
      const { join: pjoin } = await import('node:path');
      const abs = pjoin(vaultDir, notePath);
      const buf = await readFile(abs);
      const st = await stat(abs);
      const contentSha = createHash('sha256').update(buf).digest('hex');
      await index.removeNote(notePath); // drop stale chunks; addNote re-fills snapshot too
      await index.addNote(notePath, buf.toString('utf8'), { contentSha, mtimeMs: st.mtimeMs });
    } catch (e) {
      process.stderr.write(`vaultnexus: reindex failed for ${notePath}: ${String(e)}\n`);
    }
  };
  const removeNote = async (notePath: string): Promise<void> => {
    suppressNextWatch(notePath);
    try { await index.removeNote(notePath); } catch { /* ignore */ }
  };

  const mcpDeps = {
    index: vaultDir ? index : undefined,
    vaultDir,
    embedderId: embedder.id ?? 'fake',
    onNoteChanged: reindexNote,
    onNoteRemoved: removeNote,
  } as const;

  const socketServer = createServer((socket: Socket) => {
    const transport = new SocketServerTransport(socket);
    const mcp = createMcpServer(mcpDeps);
    mcp.connect(transport).catch((e) =>
      process.stderr.write(`vaultnexus: connection failed ${String(e)}\n`),
    );
  });
  await new Promise<void>((resolve) => socketServer.listen(socketPath, resolve));

  // fs.watch: external writes (Obsidian saving a note) → debounced reindex.
  // Bursty writes coalesce → one reindex per 250ms quiet window per path.
  if (vaultDir) {
    const { watch } = await import('node:fs');
    const { relative: prel } = await import('node:path');
    const debounce = new Map<string, NodeJS.Timeout>();
    try {
      watch(vaultDir, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        if (filename.startsWith('.')) return;
        if (filename.includes('/.')) return; // skip .obsidian/, .trash/, etc.
        if (!filename.toLowerCase().endsWith('.md')) return;
        // filename from recursive fs.watch is vault-relative — use as-is.
        const key = filename;
        const prev = debounce.get(key);
        if (prev) clearTimeout(prev);
        debounce.set(key, setTimeout(async () => {
          debounce.delete(key);
          // Skip if we just did this write ourselves through a tool handler.
          const expiry = recentSelfWrites.get(key);
          if (expiry && expiry > Date.now()) {
            recentSelfWrites.delete(key);
            return;
          }
          try {
            const { stat } = await import('node:fs/promises');
            const { join: pjoin2 } = await import('node:path');
            await stat(pjoin2(vaultDir, key));
            await reindexNote(key);
          } catch {
            // file vanished → drop from index
            await removeNote(key);
          }
        }, 250));
      });
    } catch (e) {
      process.stderr.write(`vaultnexus: fs.watch unavailable (${String(e)}) — live reindex disabled\n`);
    }
  }

  // Await actual bind → race-free readiness signal for integration tests
  let httpReady: () => void;
  const httpListening = new Promise<void>((r) => { httpReady = r; });
  const http: ServerType = serve(
    {
      fetch: createHttpApp({ index: vaultDir ? index : undefined, embedderId: embedder.id ?? 'fake' }).fetch,
      // Reuse the same MCP server factory for any future HTTP-MCP transport; for now HTTP is just REST.
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
