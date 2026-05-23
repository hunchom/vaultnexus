import { describe, it, expect } from 'vitest';
import { chunkDocument } from '../../src/core/chunk.js';
const blocks = (cs: ReturnType<typeof chunkDocument>) => cs.filter((c) => c.granularity === 'block');
describe('chunkDocument', () => {
  it('emits a note tier spanning the whole body', () => {
    const src = '# H\n\npara one\n';
    const note = chunkDocument(src).find((c) => c.granularity === 'note')!;
    expect(Buffer.from(src).subarray(note.byteStart, note.byteEnd).toString()).toBe(note.text);
  });
  it('tracks heading paths', () => {
    const src = '# A\n\nunder a\n\n## B\n\nunder b\n';
    const cs = blocks(chunkDocument(src));
    expect(cs.find((c) => c.text.includes('under b'))!.headingPath).toEqual(['A', 'B']);
    expect(cs.find((c) => c.text.includes('under a'))!.headingPath).toEqual(['A']);
  });
  it('never merges a code block with prose', () => {
    const src = 'para before\n\n```js\nconst x = 1;\n```\n\npara after\n';
    const code = blocks(chunkDocument(src)).find((c) => c.text.includes('const x'))!;
    expect(code.text).toContain('```js');
    expect(code.text).not.toContain('para before');
    expect(code.text).not.toContain('para after');
  });
  it('merges small adjacent paragraphs under the token budget', () => {
    const cs = blocks(chunkDocument('p1\n\np2\n\np3\n', { tokenBudget: 1000 }));
    expect(cs.length).toBe(1);
    expect(cs[0].text).toContain('p1'); expect(cs[0].text).toContain('p3');
  });
  it('splits when the token budget is exceeded', () => {
    expect(blocks(chunkDocument('p1\n\np2\n\np3\n', { tokenBudget: 1 })).length).toBe(3);
  });
});
