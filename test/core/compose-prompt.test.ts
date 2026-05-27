import { describe, it, expect } from 'vitest';
import { buildComposePrompt } from '../../src/core/compose-prompt.js';
import type { ReasonHop } from '../../src/daemon/reason-trace.js';

function makeHop(over: Partial<ReasonHop> & Pick<ReasonHop, 'toChunkId'>): ReasonHop {
  return {
    step: 0,
    fromChunkId: null,
    edgeType: 'seed',
    score: 0.8,
    ...over,
    chunk: {
      notePath: 'notes/foo.md',
      headingPath: ['Heading', 'Sub'],
      text: 'sample text body for this hop',
      byteStart: 10,
      byteEnd: 42,
      ...(over.chunk ?? {}),
    },
  } as ReasonHop;
}

describe('buildComposePrompt', () => {
  const hops: ReasonHop[] = [
    makeHop({
      toChunkId: 0,
      chunk: {
        notePath: 'gtd/inbox.md',
        headingPath: ['GTD', 'Inbox'],
        text: 'capture everything in one trusted inbox',
        byteStart: 100,
        byteEnd: 142,
      },
    }),
    makeHop({
      toChunkId: 1,
      step: 1,
      fromChunkId: 0,
      edgeType: 'wikilink',
      chunk: {
        notePath: 'gtd/review.md',
        headingPath: ['GTD', 'Weekly Review'],
        text: 'review weekly to keep the system trustworthy',
        byteStart: 200,
        byteEnd: 246,
      },
    }),
  ];

  const question = 'What did I conclude about GTD?';
  const msgs = buildComposePrompt(question, hops);

  it('returns a 2-message conversation (system + user)', () => {
    expect(msgs.length).toBe(2);
    expect(msgs[0].role).toBe('system');
    expect(msgs[1].role).toBe('user');
  });

  it('system prompt carries the citation marker convention + no-fabrication rule', () => {
    const sys = msgs[0].content;
    expect(sys).toContain('[ref:');
    expect(sys).toContain('do not invent');
  });

  it('user prompt contains the question text VERBATIM', () => {
    expect(msgs[1].content).toContain(question);
  });

  it('user prompt contains every hop notePath', () => {
    const user = msgs[1].content;
    expect(user).toContain('gtd/inbox.md');
    expect(user).toContain('gtd/review.md');
  });

  it('user prompt contains [ref:notePath:byteStart-byteEnd] for every hop', () => {
    const user = msgs[1].content;
    expect(user).toContain('[ref:gtd/inbox.md:100-142]');
    expect(user).toContain('[ref:gtd/review.md:200-246]');
  });

  it('user prompt formats headingPath via " > " join', () => {
    const user = msgs[1].content;
    expect(user).toContain('GTD > Inbox');
    expect(user).toContain('GTD > Weekly Review');
  });

  it('numbers the citations 1..N in order', () => {
    const user = msgs[1].content;
    expect(user).toContain('#1');
    expect(user).toContain('#2');
    expect(user.indexOf('#1')).toBeLessThan(user.indexOf('#2'));
  });

  it('truncates long hop text → user prompt stays bounded', () => {
    const big = 'x'.repeat(5000);
    const hugeHops: ReasonHop[] = [
      makeHop({
        toChunkId: 0,
        chunk: {
          notePath: 'big.md',
          headingPath: ['X'],
          text: big,
          byteStart: 0,
          byteEnd: 5000,
        },
      }),
    ];
    const out = buildComposePrompt('Q', hugeHops);
    expect(out[1].content.length).toBeLessThan(2000);
  });

  it('empty hops list → still produces 2 messages with the question', () => {
    const out = buildComposePrompt('alone question', []);
    expect(out.length).toBe(2);
    expect(out[1].content).toContain('alone question');
  });
});
