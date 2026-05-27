import { describe, it, expect } from 'vitest';
import { VaultIndex } from '../../src/daemon/vault-index.js';
import { FakeEmbedder } from '../../src/core/embedder.js';
import { FakeChatModel } from '../../src/core/fake-chat-model.js';
import type { ChatModel, ChatMessage } from '../../src/core/chat-model.js';
import { composeAnswerStream } from '../../src/daemon/reason-stream.js';
import type { TraceFacade } from '../../src/daemon/reason-trace.js';
import type { IndexedChunk, SearchHit } from '../../src/daemon/vault-index.js';

async function facadeOver(idx: VaultIndex): Promise<TraceFacade> {
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

async function seededIndex(): Promise<VaultIndex> {
  const idx = new VaultIndex(new FakeEmbedder(64), undefined, new FakeChatModel());
  await idx.addNote('gtd/inbox.md', '# Inbox\n\nGTD says capture everything in one trusted place\n');
  await idx.addNote(
    'gtd/review.md',
    '# Weekly Review\n\nWeekly review keeps the GTD system trustworthy\n\nlink [[inbox]]\n',
  );
  return idx;
}

describe('composeAnswerStream (Plan 23 orchestrator)', () => {
  it('zero hops → empty stream, finalize() returns fallback', async () => {
    const idx = new VaultIndex(new FakeEmbedder(32));
    const facade = await facadeOver(idx);
    const { stream, finalize } = composeAnswerStream(facade, new FakeChatModel(), 'anything');
    const chunks: string[] = [];
    for await (const c of stream) chunks.push(c);
    expect(chunks).toEqual([]);
    const final = await finalize();
    expect(final.answer).toBe('No relevant context found in vault.');
    expect(final.hops).toEqual([]);
    expect(final.invalidCitations).toEqual([]);
  });

  it('hops present + streaming model → stream yields chunks, finalize returns hops + concatenated answer', async () => {
    const idx = await seededIndex();
    const facade = await facadeOver(idx);

    const piecesEmitted = ['part-A ', 'part-B ', 'part-C'];
    let composeCalled = false;
    let streamCalled = false;
    const chat: ChatModel = {
      id: 'streamspy',
      async compose() {
        composeCalled = true;
        return piecesEmitted.join('');
      },
      async *streamCompose() {
        streamCalled = true;
        for (const p of piecesEmitted) yield p;
      },
    };

    const { stream, finalize } = composeAnswerStream(facade, chat, 'What about GTD?', {
      maxDepth: 1,
    });
    const got: string[] = [];
    for await (const c of stream) got.push(c);
    const final = await finalize();
    expect(streamCalled).toBe(true);
    expect(composeCalled).toBe(false); // streaming path → never call one-shot
    expect(got).toEqual(piecesEmitted);
    expect(final.answer).toBe(piecesEmitted.join(''));
    expect(final.hops.length).toBeGreaterThan(0);
  });

  it('citation validity runs over full accumulated text → mixed valid + fabricated', async () => {
    const idx = await seededIndex();
    const facade = await facadeOver(idx);

    // probe → grab one real hop triple
    const probe: ChatModel = { id: 'probe', async compose() { return ''; } };
    const { finalize: probeFin } = composeAnswerStream(facade, probe, 'GTD', { maxDepth: 0 });
    // probe path: no streamCompose → falls back to compose. Consume stream + finalize.
    const probeFinal = await probeFin();
    const realHops = probeFinal.hops;
    expect(realHops.length).toBeGreaterThan(0);
    const real = realHops[0].chunk;
    const goodRef = `[ref:${real.notePath}:${real.byteStart}-${real.byteEnd}]`;
    const badRef = '[ref:fake.md:99-100]';

    // emit valid + fabricated across TWO chunks → ensure accumulation works
    const chat: ChatModel = {
      id: 'split-emit',
      async compose() { return `valid ${goodRef} and bad ${badRef}.`; },
      async *streamCompose() {
        yield `valid ${goodRef} and `;
        yield `bad ${badRef}.`;
      },
    };

    const { stream, finalize } = composeAnswerStream(facade, chat, 'GTD', { maxDepth: 0 });
    const out: string[] = [];
    for await (const c of stream) out.push(c);
    const final = await finalize();
    expect(out.length).toBe(2);
    expect(final.invalidCitations).toEqual([badRef]);
    expect(final.answer).toBe(`valid ${goodRef} and bad ${badRef}.`);
  });

  it('chat model w/o streamCompose → falls back to compose, emits single chunk', async () => {
    const idx = await seededIndex();
    const facade = await facadeOver(idx);
    let composeCalls = 0;
    const oneShot: ChatModel = {
      id: 'oneshot',
      async compose(msgs: ChatMessage[]) {
        composeCalls++;
        return `one-shot ${msgs.length}msgs`;
      },
    };
    const { stream, finalize } = composeAnswerStream(facade, oneShot, 'GTD', { maxDepth: 0 });
    const got: string[] = [];
    for await (const c of stream) got.push(c);
    const final = await finalize();
    expect(composeCalls).toBe(1);
    expect(got).toEqual([final.answer]);
    expect(final.answer).toMatch(/^one-shot/);
  });
});
