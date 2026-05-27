import { describe, it, expect } from 'vitest';
import {
  createAnthropicChatModel,
  createOpenAIChatModel,
  createOpenAICompatibleChatModel,
} from '../../src/daemon/ai-chat-model.js';

describe('ai-chat-model factories (offline shape checks)', () => {
  it('createAnthropicChatModel returns id "anthropic:<model>" + default model', () => {
    const m = createAnthropicChatModel({ apiKey: 'k' });
    expect(m.id).toBe('anthropic:claude-sonnet-4-6');
    expect(typeof m.compose).toBe('function');
  });

  it('createAnthropicChatModel honors custom model id', () => {
    const m = createAnthropicChatModel({ apiKey: 'k', model: 'claude-haiku-4-5' });
    expect(m.id).toBe('anthropic:claude-haiku-4-5');
  });

  it('createOpenAIChatModel returns id "openai:<model>" + default model', () => {
    const m = createOpenAIChatModel({ apiKey: 'k' });
    expect(m.id).toBe('openai:gpt-4o-mini');
  });

  it('createOpenAIChatModel honors custom model id', () => {
    const m = createOpenAIChatModel({ apiKey: 'k', model: 'gpt-4o' });
    expect(m.id).toBe('openai:gpt-4o');
  });

  it('createOpenAICompatibleChatModel returns id "openai-compatible:<model>"', () => {
    const m = createOpenAICompatibleChatModel({
      baseURL: 'http://localhost:11434/v1',
      apiKey: 'unused',
      model: 'llama3',
    });
    expect(m.id).toBe('openai-compatible:llama3');
  });
});

// gated tests → run only when matching API key in env. default-skip CI safety.

describe.skipIf(!process.env.VAULTNEXUS_TEST_ANTHROPIC_KEY)(
  'AnthropicChatModel (gated, real API)',
  () => {
    it('responds with PONG to a literal-word prompt', async () => {
      const m = createAnthropicChatModel({
        apiKey: process.env.VAULTNEXUS_TEST_ANTHROPIC_KEY!,
        model: process.env.VAULTNEXUS_TEST_ANTHROPIC_MODEL,
      });
      const out = await m.compose([
        { role: 'user', content: 'Reply with the single literal word: PONG' },
      ]);
      expect(out.toUpperCase()).toContain('PONG');
    }, 30_000);
  },
);

describe.skipIf(!process.env.VAULTNEXUS_TEST_OPENAI_KEY)(
  'OpenAIChatModel (gated, real API)',
  () => {
    it('responds with PONG to a literal-word prompt', async () => {
      const m = createOpenAIChatModel({
        apiKey: process.env.VAULTNEXUS_TEST_OPENAI_KEY!,
        model: process.env.VAULTNEXUS_TEST_OPENAI_MODEL,
      });
      const out = await m.compose([
        { role: 'user', content: 'Reply with the single literal word: PONG' },
      ]);
      expect(out.toUpperCase()).toContain('PONG');
    }, 30_000);
  },
);

describe.skipIf(
  !process.env.VAULTNEXUS_TEST_OPENAI_COMPATIBLE_KEY ||
    !process.env.VAULTNEXUS_TEST_OPENAI_COMPATIBLE_URL ||
    !process.env.VAULTNEXUS_TEST_OPENAI_COMPATIBLE_MODEL,
)('OpenAICompatibleChatModel (gated, real API)', () => {
  it('responds with PONG to a literal-word prompt', async () => {
    const m = createOpenAICompatibleChatModel({
      baseURL: process.env.VAULTNEXUS_TEST_OPENAI_COMPATIBLE_URL!,
      apiKey: process.env.VAULTNEXUS_TEST_OPENAI_COMPATIBLE_KEY!,
      model: process.env.VAULTNEXUS_TEST_OPENAI_COMPATIBLE_MODEL!,
    });
    const out = await m.compose([
      { role: 'user', content: 'Reply with the single literal word: PONG' },
    ]);
    expect(out.toUpperCase()).toContain('PONG');
  }, 30_000);
});
