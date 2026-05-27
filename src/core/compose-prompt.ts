import type { ChatMessage } from './chat-model.js';
import type { ReasonHop } from '../daemon/reason-trace.js';

// per-hop body cap → keeps total user prompt under ~4k tokens for default hop set
const HOP_TEXT_CHARS = 300;

const SYSTEM_PROMPT = `You answer questions about a knowledge vault. Every claim in your answer MUST be backed by one of the citations listed below, using the exact form \`[ref:notePath:byteStart-byteEnd]\`. If a citation does not support a claim, do not invent the link — drop the claim. Use the citations inline (mid-prose), not as footnotes. Be concise; under 200 words.`;

/** Build the chat-message pair → system contract + user (question + numbered cited chain). Pure. */
export function buildComposePrompt(question: string, hops: ReasonHop[]): ChatMessage[] {
  const lines: string[] = [];
  lines.push(`Question: ${question}`);
  lines.push('');
  if (hops.length > 0) {
    lines.push('Available citations:');
    hops.forEach((hop, i) => {
      const c = hop.chunk;
      const ref = `[ref:${c.notePath}:${c.byteStart}-${c.byteEnd}]`;
      const heading = c.headingPath.join(' > ');
      const text = c.text.length > HOP_TEXT_CHARS ? `${c.text.slice(0, HOP_TEXT_CHARS)}…` : c.text;
      lines.push(`#${i + 1} ${ref} heading: ${heading}`);
      lines.push(`   text: ${text}`);
    });
  } else {
    lines.push('Available citations: (none)');
  }
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: lines.join('\n') },
  ];
}
