import type { ChatModel, ChatComposeOpts } from '../core/chat-model.js';
import { buildComposePrompt } from '../core/compose-prompt.js';
import { extractCitations, validateCitations } from '../core/citation-validity.js';
import {
  traceReasoning,
  type TraceFacade,
  type TraceOptions,
  type ReasonHop,
} from './reason-trace.js';

/** Final summary surfaced once stream completes → matches composeAnswer() shape. */
export interface ReasonStreamFinal {
  answer: string;
  hops: ReasonHop[];
  invalidCitations: string[];
}

/** Streaming sibling of composeAnswer().
 *  stream → yields text chunks as the model emits them.
 *  finalize() → resolves AFTER stream drains, returns answer+hops+invalidCitations.
 *  Caller MUST fully consume stream before awaiting finalize().
 *  Models without streamCompose → fall back to one-shot compose(), emit single chunk. */
export function composeAnswerStream(
  facade: TraceFacade,
  chat: ChatModel,
  question: string,
  opts: TraceOptions & ChatComposeOpts = {},
): { stream: AsyncIterable<string>; finalize: () => Promise<ReasonStreamFinal> } {
  let resolvedFinal: ReasonStreamFinal | null = null;
  let streamErr: unknown = null;

  async function* run(): AsyncGenerator<string, void, void> {
    const hops = await traceReasoning(facade, question, opts);
    if (hops.length === 0) {
      resolvedFinal = {
        answer: 'No relevant context found in vault.',
        hops: [],
        invalidCitations: [],
      };
      return;
    }
    const messages = buildComposePrompt(question, hops);
    const composeOpts: ChatComposeOpts = { maxTokens: opts.maxTokens, temperature: opts.temperature };
    let accumulated = '';
    if (chat.streamCompose) {
      for await (const chunk of chat.streamCompose(messages, composeOpts)) {
        accumulated += chunk;
        yield chunk;
      }
    } else {
      // fallback → one-shot, single yield. preserves backwards-compat surface.
      accumulated = await chat.compose(messages, composeOpts);
      yield accumulated;
    }
    const { invalid } = validateCitations(extractCitations(accumulated), hops);
    resolvedFinal = {
      answer: accumulated,
      hops,
      invalidCitations: invalid.map((c) => c.raw),
    };
  }

  const iter = run();
  // wrap iter → capture errors so finalize() can re-surface them
  const stream: AsyncIterable<string> = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          try {
            return await iter.next();
          } catch (e) {
            streamErr = e;
            throw e;
          }
        },
      };
    },
  };

  async function finalize(): Promise<ReasonStreamFinal> {
    if (streamErr) throw streamErr;
    // caller may have skipped iteration (zero-hop case → stream returns immediately).
    // drain remaining to ensure resolvedFinal populated.
    if (!resolvedFinal) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of stream) {
        /* drain */
      }
    }
    if (!resolvedFinal) throw new Error('composeAnswerStream: stream ended without final state');
    return resolvedFinal;
  }

  return { stream, finalize };
}
