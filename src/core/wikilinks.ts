/** Obsidian wikilink targets from body. [[t]] [[t|alias]] [[t#h]] ![[t]] → bare t, deduped, first-seen order. */
export function extractWikilinks(body: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(/!?\[\[([^\]]+?)\]\]/g)) {
    const target = m[1].split('|')[0].split('#')[0].trim(); // strip alias + heading
    if (target && !seen.has(target)) { seen.add(target); out.push(target); }
  }
  return out;
}
