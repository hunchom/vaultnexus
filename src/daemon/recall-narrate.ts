import type { ChatModel, ChatComposeOpts } from '../core/chat-model.js';
import { buildNarratePrompt } from '../core/narrate-prompt.js';
import { extractShaCitations, validateShaCitations } from '../core/narration-validity.js';
import { noteRevisions, type HistoryOptions, type Revision } from './git-history.js';

export interface NarrateOptions extends HistoryOptions, ChatComposeOpts {}

/** Walk note history → compose stance-shift narration → post-hoc SHA-citation check. < 2 revisions → fallback. */
export async function narrateRecallHistory(
  vaultPath: string,
  chat: ChatModel,
  notePath: string,
  opts: NarrateOptions = {},
): Promise<{ narration: string; revisions: Revision[]; invalidShaCitations: string[] }> {
  // withContent always true → narration prompt needs body snippets per revision
  const newestFirst = await noteRevisions(vaultPath, notePath, { ...opts, withContent: true });
  if (newestFirst.length < 2) {
    // chronological oldest-first contract → reverse even on fallback path
    const chronological = [...newestFirst].reverse();
    return {
      narration: 'Note has fewer than two revisions; no stance shift to narrate.',
      revisions: chronological,
      invalidShaCitations: [],
    };
  }
  const messages = buildNarratePrompt(notePath, newestFirst);
  const narration = await chat.compose(messages, {
    maxTokens: opts.maxTokens,
    temperature: opts.temperature,
  });
  // post-hoc check → Plan 19 contract enforced by regex, not just prompt-instruction
  const { invalid } = validateShaCitations(extractShaCitations(narration), newestFirst);
  const chronological = [...newestFirst].reverse();
  return { narration, revisions: chronological, invalidShaCitations: invalid.map((c) => c.raw) };
}
