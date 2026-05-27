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
