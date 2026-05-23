import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import matter from 'gray-matter';
import type { Root } from 'mdast';

export interface ParsedMarkdown {
  frontmatter: Record<string, unknown>;
  body: string;
  /** UTF-8 byte offset of body start within original source. */
  bodyByteOffset: number;
  tree: Root;
}

const processor = unified().use(remarkParse).use(remarkGfm);

/**
 * Locate body start char index by scanning frontmatter delimiters.
 * More robust than indexOf(body) — handles body text appearing verbatim in YAML values.
 */
function bodyCharStart(source: string): number {
  if (!source.startsWith('---')) return 0;
  const firstNl = source.indexOf('\n');
  if (firstNl === -1) return 0;
  const rest = source.slice(firstNl + 1);
  const closing = /^---[ \t]*$/m.exec(rest);
  if (!closing) return 0;
  const afterClose = firstNl + 1 + closing.index + closing[0].length;
  // skip single newline after closing ---
  return source[afterClose] === '\n' ? afterClose + 1 : afterClose;
}

/** Parse a note: strip frontmatter, parse body to positioned mdast. */
export function parseMarkdown(source: string): ParsedMarkdown {
  const parsed = matter(source);
  const body = parsed.content as string;
  const charOff = bodyCharStart(source);
  const bodyByteOffset = charOff > 0 ? Buffer.byteLength(source.slice(0, charOff)) : 0;
  const tree = processor.parse(body) as Root;
  return {
    frontmatter: (parsed.data ?? {}) as Record<string, unknown>,
    body,
    bodyByteOffset,
    tree,
  };
}
