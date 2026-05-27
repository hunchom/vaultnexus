import type { ChatMessage } from './chat-model.js';
import type { Revision } from '../daemon/git-history.js';

// per-revision body cap → bounds total prompt size for default 50-revision walk
const REV_TEXT_CHARS = 300;

const SYSTEM_PROMPT = `You narrate how a single note's stance evolved across a chronological git timeline. Every revision you cite MUST appear in the list below, using the exact form \`[sha:<7-char-short> @ <YYYY-MM-DD>]\`. Cite the SHA + date for each turning point in the narration. do not invent SHAs, dates, or revisions that are not in the supplied timeline; if a claim cannot be tied to a listed revision, drop the claim. Be concise; under 250 words. Focus on stance shifts → what changed and when.`;

/** Build chat-message pair → system contract + user (notePath + chronological revisions w/ truncated bodies). Pure. */
export function buildNarratePrompt(notePath: string, revisionsNewestFirst: Revision[]): ChatMessage[] {
  // noteRevisions emits newest-first → narration reads oldest→newest
  const chronological = [...revisionsNewestFirst].reverse();
  const lines: string[] = [];
  lines.push(`Note: ${notePath}`);
  lines.push('');
  if (chronological.length > 0) {
    lines.push('Revisions (oldest first):');
    chronological.forEach((r, i) => {
      const shortSha = r.sha.slice(0, 7);
      const date = r.commitDate.slice(0, 10);
      lines.push(`#${i + 1} [sha:${shortSha} @ ${date}] ${r.message}`);
      const body = r.content ?? '(content unavailable)';
      const snippet = body.length > REV_TEXT_CHARS ? `${body.slice(0, REV_TEXT_CHARS)}…` : body;
      lines.push(`   body: ${snippet}`);
    });
  } else {
    lines.push('Revisions: (none)');
  }
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: lines.join('\n') },
  ];
}
