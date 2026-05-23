import { encode } from 'gpt-tokenizer';
import type { RootContent, Heading } from 'mdast';
import { parseMarkdown } from './markdown.js';
import type { Chunk } from './types.js';

export interface ChunkOptions { tokenBudget?: number; }

const NON_MERGEABLE = new Set(['code', 'table', 'thematicBreak', 'html']);
const tokens = (s: string): number => encode(s).length;
const headingText = (n: Heading): string =>
  n.children.map((c) => ('value' in c ? c.value : '')).join('').trim();

/** Parse + chunk a note into a note tier plus offset-faithful block tiers. */
export function chunkDocument(source: string, opts: ChunkOptions = {}): Chunk[] {
  const budget = opts.tokenBudget ?? 512;
  const { body, bodyByteOffset, tree } = parseMarkdown(source);
  const bodyBytes = Buffer.from(body);
  const byteLen = (charOffset: number): number => Buffer.byteLength(body.slice(0, charOffset));
  const spanText = (a: number, b: number): string => bodyBytes.subarray(a, b).toString();

  const out: Chunk[] = [{
    granularity: 'note', text: body,
    byteStart: bodyByteOffset, byteEnd: bodyByteOffset + bodyBytes.length, headingPath: [],
  }];

  const path: string[] = [];
  type Pending = { startByte: number; endByte: number; toks: number; path: string[] };
  let pending: Pending | null = null;
  const flush = (): void => {
    if (!pending) return;
    out.push({
      granularity: 'block', text: spanText(pending.startByte, pending.endByte),
      byteStart: pending.startByte + bodyByteOffset, byteEnd: pending.endByte + bodyByteOffset,
      headingPath: [...pending.path],
    });
    pending = null;
  };

  for (const node of tree.children as RootContent[]) {
    if (!node.position) continue;
    const bStart = byteLen(node.position.start.offset!);
    const bEnd = byteLen(node.position.end.offset!);
    if (node.type === 'heading') {
      flush();
      const depth = (node as Heading).depth;
      path.length = Math.max(0, depth - 1);
      path[depth - 1] = headingText(node as Heading);
      continue;
    }
    const text = spanText(bStart, bEnd);
    const tk = tokens(text);
    const mergeable = !NON_MERGEABLE.has(node.type);
    const pathChanged = pending && pending.path.join('\0') !== path.join('\0');
    if (!mergeable || !pending || pathChanged || pending.toks + tk > budget) {
      flush();
      pending = { startByte: bStart, endByte: bEnd, toks: tk, path: [...path] };
      if (!mergeable) flush();
    } else {
      pending.endByte = bEnd;
      pending.toks += tk;
    }
  }
  flush();
  return out;
}
