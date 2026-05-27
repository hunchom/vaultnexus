import { describe, it, expect } from 'vitest';
import { FakeChatModel } from '../../src/core/fake-chat-model.js';
import type { ChatModel, ChatMessage } from '../../src/core/chat-model.js';

describe('FakeChatModel', () => {
  it('is a ChatModel with id === "fake"', () => {
    const m: ChatModel = new FakeChatModel();
    expect(m.id).toBe('fake');
  });

  it('echoes the user message content in the response', async () => {
    const m = new FakeChatModel();
    const msgs: ChatMessage[] = [{ role: 'user', content: 'hello world' }];
    const out = await m.compose(msgs);
    expect(out).toContain('hello world');
  });

  it('deterministic across calls + instances for same input', async () => {
    const a = new FakeChatModel();
    const b = new FakeChatModel();
    const msgs: ChatMessage[] = [{ role: 'user', content: 'same text' }];
    const r1 = await a.compose(msgs);
    const r2 = await a.compose(msgs);
    const r3 = await b.compose(msgs);
    expect(r1).toBe(r2);
    expect(r1).toBe(r3);
  });

  it('only echoes user-role content (ignores system/assistant)', async () => {
    const m = new FakeChatModel();
    const out = await m.compose([
      { role: 'system', content: 'SYSTEM-MARKER' },
      { role: 'user', content: 'USER-MARKER' },
      { role: 'assistant', content: 'ASSISTANT-MARKER' },
    ]);
    expect(out).toContain('USER-MARKER');
    expect(out).not.toContain('SYSTEM-MARKER');
    expect(out).not.toContain('ASSISTANT-MARKER');
  });
});

describe('FakeChatModel.streamCompose (Plan 23)', () => {
  it('streamCompose yields chunks summing to compose() output', async () => {
    const m = new FakeChatModel();
    const msgs: ChatMessage[] = [{ role: 'user', content: 'streaming test input' }];
    const expected = await m.compose(msgs);
    expect(typeof m.streamCompose).toBe('function');
    const chunks: string[] = [];
    for await (const chunk of m.streamCompose!(msgs)) chunks.push(chunk);
    expect(chunks.length).toBeGreaterThan(1); // genuine multi-chunk stream, not single emit
    expect(chunks.join('')).toBe(expected);
  });

  it('streamCompose deterministic across calls + instances', async () => {
    const a = new FakeChatModel();
    const b = new FakeChatModel();
    const msgs: ChatMessage[] = [{ role: 'user', content: 'same input' }];
    const collect = async (m: FakeChatModel): Promise<string[]> => {
      const out: string[] = [];
      for await (const c of m.streamCompose(msgs)) out.push(c);
      return out;
    };
    const r1 = await collect(a);
    const r2 = await collect(a);
    const r3 = await collect(b);
    expect(r1).toEqual(r2);
    expect(r1).toEqual(r3);
  });

  it('streamCompose ignores system/assistant content like compose', async () => {
    const m = new FakeChatModel();
    const out: string[] = [];
    for await (const c of m.streamCompose([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'U' },
      { role: 'assistant', content: 'ASST' },
    ])) out.push(c);
    const joined = out.join('');
    expect(joined).toContain('U');
    expect(joined).not.toContain('SYS');
    expect(joined).not.toContain('ASST');
  });
});
