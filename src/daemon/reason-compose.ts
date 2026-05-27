import type { ChatModel, ChatComposeOpts } from '../core/chat-model.js';
import { buildComposePrompt } from '../core/compose-prompt.js';
import {
  traceReasoning,
  type TraceFacade,
  type TraceOptions,
  type ReasonHop,
} from './reason-trace.js';

/** Trace → compose. zero hops → fallback. otherwise → cited answer + hop chain. */
export async function composeAnswer(
  facade: TraceFacade,
  chat: ChatModel,
  question: string,
  opts: TraceOptions & ChatComposeOpts = {},
): Promise<{ answer: string; hops: ReasonHop[] }> {
  const hops = await traceReasoning(facade, question, opts);
  if (hops.length === 0) return { answer: 'No relevant context found in vault.', hops: [] };
  const messages = buildComposePrompt(question, hops);
  const answer = await chat.compose(messages, {
    maxTokens: opts.maxTokens,
    temperature: opts.temperature,
  });
  return { answer, hops };
}
