import { generateText, type LanguageModel, type ModelMessage } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { ChatModel, ChatMessage, ChatComposeOpts } from '../core/chat-model.js';

const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-6';
const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';

/** Anthropic Claude via @ai-sdk/anthropic. Default → claude-sonnet-4-6. */
export function createAnthropicChatModel(p: { apiKey: string; model?: string }): ChatModel {
  const provider = createAnthropic({ apiKey: p.apiKey });
  const modelId = p.model ?? DEFAULT_ANTHROPIC_MODEL;
  // cast → AnthropicMessagesModelId literal-union accepts strings via `(string & {})` escape hatch
  const model = provider(modelId as never);
  return { id: `anthropic:${modelId}`, compose: (msgs, opts) => call(model, msgs, opts) };
}

/** OpenAI via @ai-sdk/openai. Default → gpt-4o-mini (cheap, cite-aware). */
export function createOpenAIChatModel(p: { apiKey: string; model?: string }): ChatModel {
  const provider = createOpenAI({ apiKey: p.apiKey });
  const modelId = p.model ?? DEFAULT_OPENAI_MODEL;
  const model = provider(modelId);
  return { id: `openai:${modelId}`, compose: (msgs, opts) => call(model, msgs, opts) };
}

/** OpenAI-compatible (Ollama / LM Studio / vLLM / etc.) via @ai-sdk/openai-compatible. */
export function createOpenAICompatibleChatModel(p: {
  baseURL: string;
  apiKey: string;
  model: string;
  name?: string;
}): ChatModel {
  const provider = createOpenAICompatible({
    name: p.name ?? 'vaultnexus-local',
    baseURL: p.baseURL,
    apiKey: p.apiKey,
  });
  const model = provider(p.model);
  return { id: `openai-compatible:${p.model}`, compose: (msgs, opts) => call(model, msgs, opts) };
}

// shared one-shot generateText call → ChatMessage[] → ModelMessage[] (shape compatible)
async function call(
  model: LanguageModel,
  messages: ChatMessage[],
  opts: ChatComposeOpts = {},
): Promise<string> {
  const { text } = await generateText({
    model,
    messages: messages as ModelMessage[],
    maxOutputTokens: opts.maxTokens ?? 800,
    temperature: opts.temperature ?? 0.2,
  });
  return text;
}
