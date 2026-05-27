import type { ChatModel, ChatComposeOpts } from '../core/chat-model.js';
import { buildComposePrompt } from '../core/compose-prompt.js';
import { extractCitations, validateCitations } from '../core/citation-validity.js';
import {
  traceReasoning,
  type TraceFacade,
  type TraceOptions,
  type ReasonHop,
} from './reason-trace.js';

/** Trace → compose → post-hoc citation regex check. zero hops → fallback. */
export async function composeAnswer(
  facade: TraceFacade,
  chat: ChatModel,
  question: string,
  opts: TraceOptions & ChatComposeOpts = {},
): Promise<{ answer: string; hops: ReasonHop[]; invalidCitations: string[] }> {
  const hops = await traceReasoning(facade, question, opts);
  if (hops.length === 0)
    return { answer: 'No relevant context found in vault.', hops: [], invalidCitations: [] };
  const messages = buildComposePrompt(question, hops);
  const answer = await chat.compose(messages, {
    maxTokens: opts.maxTokens,
    temperature: opts.temperature,
  });
  // post-hoc check → Plan 16 contract enforced by regex, not just prompt-instruction
  const { invalid } = validateCitations(extractCitations(answer), hops);
  return { answer, hops, invalidCitations: invalid.map((c) => c.raw) };
}
