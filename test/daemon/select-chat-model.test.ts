import { describe, it, expect } from 'vitest';
import { selectChatModel } from '../../src/daemon/select-chat-model.js';
import { FakeChatModel } from '../../src/core/fake-chat-model.js';

describe('selectChatModel', () => {
  it('defaults to FakeChatModel when no envs set', () => {
    const m = selectChatModel({});
    expect(m).toBeInstanceOf(FakeChatModel);
    expect(m.id).toBe('fake');
  });

  it('explicit provider=fake → FakeChatModel', () => {
    const m = selectChatModel({ VAULTNEXUS_CHAT_PROVIDER: 'fake' });
    expect(m).toBeInstanceOf(FakeChatModel);
  });

  it('provider=anthropic + key → AnthropicChatModel', () => {
    const m = selectChatModel({
      VAULTNEXUS_CHAT_PROVIDER: 'anthropic',
      VAULTNEXUS_CHAT_KEY: 'k',
    });
    expect(m.id.startsWith('anthropic:')).toBe(true);
  });

  it('provider=anthropic w/ custom model id', () => {
    const m = selectChatModel({
      VAULTNEXUS_CHAT_PROVIDER: 'anthropic',
      VAULTNEXUS_CHAT_KEY: 'k',
      VAULTNEXUS_CHAT_MODEL: 'claude-opus-4-7',
    });
    expect(m.id).toBe('anthropic:claude-opus-4-7');
  });

  it('provider=anthropic + no key → throws mentioning VAULTNEXUS_CHAT_KEY', () => {
    expect(() => selectChatModel({ VAULTNEXUS_CHAT_PROVIDER: 'anthropic' })).toThrow(
      /VAULTNEXUS_CHAT_KEY/,
    );
  });

  it('provider=openai + key → OpenAIChatModel', () => {
    const m = selectChatModel({
      VAULTNEXUS_CHAT_PROVIDER: 'openai',
      VAULTNEXUS_CHAT_KEY: 'k',
    });
    expect(m.id.startsWith('openai:')).toBe(true);
  });

  it('provider=openai + no key → throws mentioning VAULTNEXUS_CHAT_KEY', () => {
    expect(() => selectChatModel({ VAULTNEXUS_CHAT_PROVIDER: 'openai' })).toThrow(
      /VAULTNEXUS_CHAT_KEY/,
    );
  });

  it('provider=openai-compatible + url + key + model → OpenAICompatibleChatModel', () => {
    const m = selectChatModel({
      VAULTNEXUS_CHAT_PROVIDER: 'openai-compatible',
      VAULTNEXUS_CHAT_URL: 'http://localhost:11434/v1',
      VAULTNEXUS_CHAT_KEY: 'unused',
      VAULTNEXUS_CHAT_MODEL: 'llama3',
    });
    expect(m.id).toBe('openai-compatible:llama3');
  });

  it('provider=openai-compatible + no key → throws mentioning VAULTNEXUS_CHAT_KEY', () => {
    expect(() =>
      selectChatModel({
        VAULTNEXUS_CHAT_PROVIDER: 'openai-compatible',
        VAULTNEXUS_CHAT_URL: 'http://x',
        VAULTNEXUS_CHAT_MODEL: 'm',
      }),
    ).toThrow(/VAULTNEXUS_CHAT_KEY/);
  });

  it('provider=openai-compatible + no url → throws mentioning VAULTNEXUS_CHAT_URL', () => {
    expect(() =>
      selectChatModel({
        VAULTNEXUS_CHAT_PROVIDER: 'openai-compatible',
        VAULTNEXUS_CHAT_KEY: 'k',
        VAULTNEXUS_CHAT_MODEL: 'm',
      }),
    ).toThrow(/VAULTNEXUS_CHAT_URL/);
  });

  it('provider=openai-compatible + no model → throws mentioning VAULTNEXUS_CHAT_MODEL', () => {
    expect(() =>
      selectChatModel({
        VAULTNEXUS_CHAT_PROVIDER: 'openai-compatible',
        VAULTNEXUS_CHAT_URL: 'http://x',
        VAULTNEXUS_CHAT_KEY: 'k',
      }),
    ).toThrow(/VAULTNEXUS_CHAT_MODEL/);
  });

  it('unknown provider → throws', () => {
    expect(() => selectChatModel({ VAULTNEXUS_CHAT_PROVIDER: 'cohere' })).toThrow(/cohere/);
  });
});
