import { describe, it, expect } from 'vitest';
import { parseMarkdown, extractFrontmatterDate } from '../../src/core/markdown.js';

describe('parseMarkdown', () => {
  it('splits frontmatter and reports body byte offset', () => {
    const src = '---\ntitle: T\n---\n# Head\n\nBody text.\n';
    const r = parseMarkdown(src);
    expect(r.frontmatter).toEqual({ title: 'T' });
    expect(Buffer.from(src).subarray(r.bodyByteOffset).toString()).toContain('# Head');
    expect(r.tree.type).toBe('root');
    expect(r.tree.children.length).toBeGreaterThan(0);
    expect(r.tree.children[0].position?.start.offset).toBeDefined();
  });

  it('handles no frontmatter (body offset 0)', () => {
    const src = '# Just a heading\n\ntext\n';
    const r = parseMarkdown(src);
    expect(r.frontmatter).toEqual({});
    expect(r.bodyByteOffset).toBe(0);
  });

  it('body offset is exact for unicode frontmatter', () => {
    // frontmatter contains multi-byte chars; byte offset must account for them
    const src = '---\ntitle: "Héllo"\n---\n# Body\n';
    const r = parseMarkdown(src);
    const sliced = Buffer.from(src).subarray(r.bodyByteOffset).toString();
    expect(sliced).toMatch(/^# Body/);
  });

  it('body offset holds for empty frontmatter block', () => {
    // gray-matter with empty --- block returns {} data and content starts after
    const src = '---\n---\n# Heading\n';
    const r = parseMarkdown(src);
    expect(r.frontmatter).toEqual({});
    const sliced = Buffer.from(src).subarray(r.bodyByteOffset).toString();
    expect(sliced).toMatch(/^# Heading/);
  });

  it('extractFrontmatterDate: ISO string from valid date field', () => {
    const iso = extractFrontmatterDate('---\ndate: 2024-02-15\n---\n# Hello\n');
    expect(iso).toBeDefined();
    expect(Number.isNaN(Date.parse(iso!))).toBe(false);
    // gray-matter parses bare ISO date → Date; impl normalizes to ISO string.
    expect(iso!.startsWith('2024-02-15')).toBe(true);
  });

  it('extractFrontmatterDate: undefined when no frontmatter', () => {
    expect(extractFrontmatterDate('# Just body\n')).toBeUndefined();
  });

  it('extractFrontmatterDate: undefined when frontmatter has no `date` field', () => {
    expect(extractFrontmatterDate('---\ntitle: T\n---\n# B\n')).toBeUndefined();
  });

  it('extractFrontmatterDate: undefined when date is invalid', () => {
    expect(extractFrontmatterDate('---\ndate: not-a-date\n---\n# B\n')).toBeUndefined();
  });

  it('body string round-trips through byteOffset slice', () => {
    const src = '---\nfoo: bar\nbaz: 42\n---\n\nSome **bold** text.\n';
    const r = parseMarkdown(src);
    const fromOffset = Buffer.from(src).subarray(r.bodyByteOffset).toString();
    // body and slice must agree on content
    expect(fromOffset.trimStart()).toBe(r.body.trimStart());
  });
});
