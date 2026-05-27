#!/usr/bin/env node
// Plan 23 — streaming reason CLI. Mirror of `pnpm eval` shape: tsx invocation, prints to stdout.
// Streams text chunks as the chat model emits them, then prints final hops + invalidCitations footer.
import { argv, stdout, stderr } from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { VaultIndex } from '../daemon/vault-index.js';
import { indexVault } from '../daemon/indexer.js';
import { selectEmbedder } from '../daemon/select-embedder.js';
import { selectChatModel } from '../daemon/select-chat-model.js';
import { composeAnswerStream } from '../daemon/reason-stream.js';
import type { TraceFacade } from '../daemon/reason-trace.js';
import type { IndexedChunk, SearchHit } from '../daemon/vault-index.js';

// VaultIndex internals → facade required by composeAnswerStream. mirrors test helper shape.
function facadeOver(idx: VaultIndex): TraceFacade {
  const internals = idx as unknown as {
    chunks: IndexedChunk[];
    f32: Float32Array[];
    noteLinks: Map<string, string[]>;
  };
  return {
    chunks: internals.chunks,
    f32: internals.f32,
    noteLinks: internals.noteLinks,
    query: (text, k) => idx.query(text, k),
    chunkIdOf: (hit: SearchHit) =>
      internals.chunks.findIndex(
        (c) => c.notePath === hit.notePath && c.byteStart === hit.byteStart,
      ),
  };
}

function parseArgs(args: string[]): { question: string; vault: string } | null {
  // shape: <question> [--vault <path>]. question = first positional, vault optional flag.
  let question: string | undefined;
  let vault: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--vault' && i + 1 < args.length) {
      vault = args[i + 1];
      i++;
    } else if (!question) {
      question = a;
    }
  }
  if (!question) return null;
  return { question, vault: vault ? resolve(vault) : process.cwd() };
}

async function main(): Promise<void> {
  const parsed = parseArgs(argv.slice(2));
  if (!parsed) {
    stderr.write('usage: reason-stream <question> [--vault <path>]\n');
    process.exit(2);
  }
  const { question, vault } = parsed;
  const embedder = await selectEmbedder();
  const chat = selectChatModel(process.env);
  stderr.write(`reason-stream: embedder=${embedder.constructor.name} chat=${chat.id} vault=${vault}\n`);
  const idx = new VaultIndex(embedder, undefined, chat);
  const n = await indexVault(vault, idx);
  stderr.write(`reason-stream: indexed ${n} notes\n`);

  const facade = facadeOver(idx);
  const { stream, finalize } = composeAnswerStream(facade, chat, question);
  for await (const chunk of stream) stdout.write(chunk);
  const final = await finalize();
  stdout.write(`\n---\nhops: ${final.hops.length}, invalidCitations: ${final.invalidCitations.length}\n`);

  const ec = embedder as { close?: () => void };
  if (typeof ec.close === 'function') ec.close();
}

// CLI shim → fires only when invoked directly (tsx scripts or compiled bin), not on import
const invokedAsCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsCli) {
  main().catch((e) => {
    stderr.write(`reason-stream: fatal ${String(e)}\n`);
    process.exit(1);
  });
}
