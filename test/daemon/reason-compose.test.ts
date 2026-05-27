import { describe, it, expect } from 'vitest';
import { VaultIndex } from '../../src/daemon/vault-index.js';
import { FakeEmbedder } from '../../src/core/embedder.js';
import { FakeChatModel } from '../../src/core/fake-chat-model.js';
import type { ChatModel, ChatMessage, ChatComposeOpts } from '../../src/core/chat-model.js';
import { composeAnswer } from '../../src/daemon/reason-compose.js';
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

describe('composeAnswer (orchestrator)', () => {
  it('zero hops → fallback answer + empty hops', async () => {
    const idx = new VaultIndex(new FakeEmbedder(32));
    const facade = await facadeOver(idx);
    const res = await composeAnswer(facade, new FakeChatModel(), 'anything');
    expect(res.answer).toBe('No relevant context found in vault.');
    expect(res.hops).toEqual([]);
  });

  it('hops present → calls chat.compose w/ buildComposePrompt output, returns hops verbatim', async () => {
    const idx = await seededIndex();
    const facade = await facadeOver(idx);

    let receivedMsgs: ChatMessage[] | null = null;
    let receivedOpts: ChatComposeOpts | undefined;
    const chat: ChatModel = {
      id: 'spy',
      async compose(msgs, opts) {
        receivedMsgs = msgs;
        receivedOpts = opts;
        return 'composed answer';
      },
    };

    const res = await composeAnswer(facade, chat, 'What about GTD?', {
      maxDepth: 1,
      maxTokens: 500,
      temperature: 0.1,
    });
    expect(res.answer).toBe('composed answer');
    expect(res.hops.length).toBeGreaterThan(0);
    // forwarded prompt → 2 messages (system + user), user contains question
    expect(receivedMsgs).not.toBeNull();
    expect(receivedMsgs!.length).toBe(2);
    expect(receivedMsgs![0].role).toBe('system');
    expect(receivedMsgs![1].content).toContain('What about GTD?');
    expect(receivedOpts).toEqual({ maxTokens: 500, temperature: 0.1 });
  });
});

describe('VaultIndex.reason', () => {
  it('throws when no ChatModel injected', async () => {
    const idx = new VaultIndex(new FakeEmbedder(32));
    await idx.addNote('a.md', 'x\n');
    await expect(idx.reason('q')).rejects.toThrow(/ChatModel/);
  });

  it('returns { answer, hops } with FakeChatModel echo + ≥ 1 hop', async () => {
    const idx = await seededIndex();
    const res = await idx.reason('What about GTD?', { maxDepth: 1 });
    expect(res.hops.length).toBeGreaterThan(0);
    expect(res.answer).toContain('[fake-compose]');
    // FakeChatModel echoes user prompt → answer contains at least one seed notePath
    const paths = res.hops.map((h) => h.chunk.notePath);
    const matched = paths.some((p) => res.answer.includes(p));
    expect(matched).toBe(true);
  });

  it('chatModelId() returns "fake" with FakeChatModel; "none" w/o model', async () => {
    const a = new VaultIndex(new FakeEmbedder(32), undefined, new FakeChatModel());
    expect(a.chatModelId()).toBe('fake');
    const b = new VaultIndex(new FakeEmbedder(32));
    expect(b.chatModelId()).toBe('none');
  });
});
