import { describe, it, expect } from 'vitest';
import { chunkDocument } from '../../src/core/chunk.js';
const SAMPLES: Array<[string, string]> = [
  ['plain', '# Title\n\nHello world.\n\nSecond para.\n'],
  ['frontmatter', '---\ntitle: X\ntags: [a,b]\n---\n# H\n\nbody after fm\n'],
  ['unicode', '# Café ☕ 日本語\n\nnaïve façade — emoji 🚀 and 漢字.\n\nmore.\n'],
  ['code', 'before\n\n```python\ndef f(x):\n    return x  # 日本語 comment\n```\n\nafter\n'],
  ['table', '# T\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\ntail\n'],
  ['nested', '# A\n\na text\n\n## B\n\nb text\n\n### C\n\nc text\n'],
  ['mixed-unicode-code', '# 🎯\n\npara ☕\n\n```\nliteral ☕ block\n```\n\nend ☕\n'],
];
describe('byte-offset contract', () => {
  for (const [name, src] of SAMPLES) {
    it(`every chunk slices the source exactly: ${name}`, () => {
      const buf = Buffer.from(src);
      const chunks = chunkDocument(src);
      expect(chunks.length).toBeGreaterThan(0);
      for (const c of chunks) {
        expect(c.byteStart).toBeGreaterThanOrEqual(0);
        expect(c.byteEnd).toBeLessThanOrEqual(buf.length);
        expect(c.byteStart).toBeLessThan(c.byteEnd);
        expect(buf.subarray(c.byteStart, c.byteEnd).toString('utf8')).toBe(c.text);
      }
    });
  }
  it('note tier covers the body for every sample', () => {
    for (const [, src] of SAMPLES) {
      const note = chunkDocument(src).find((c) => c.granularity === 'note')!;
      expect(Buffer.from(src).subarray(note.byteStart, note.byteEnd).toString()).toBe(note.text);
    }
  });
});
