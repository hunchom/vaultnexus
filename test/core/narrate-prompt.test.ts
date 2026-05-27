import { describe, it, expect } from 'vitest';
import { buildNarratePrompt } from '../../src/core/narrate-prompt.js';
import type { Revision } from '../../src/daemon/git-history.js';

// newest-first ordering → matches noteRevisions() contract; builder reverses to chronological
const REVS_NEWEST_FIRST: Revision[] = [
  {
    sha: 'cccccccccccccccccccccccccccccccccccccccc',
    commitDate: '2024-10-22T10:00:00Z',
    message: 'GTD: the only viable system',
    authorEmail: 'demo@vaultnexus',
    content: 'GTD is the only system I trust now. Everything else is half-measures.\n',
  },
  {
    sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    commitDate: '2024-06-10T10:00:00Z',
    message: 'GTD: weekly review pays off',
    authorEmail: 'demo@vaultnexus',
    content: 'Weekly review changed my mind. GTD compounds when reviews are honored.\n',
  },
  {
    sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    commitDate: '2024-03-15T10:00:00Z',
    message: 'first impressions of GTD',
    authorEmail: 'demo@vaultnexus',
    content: 'GTD looks promising but feels like overhead.\n',
  },
];

const NOTE_PATH = 'notes/productivity/gtd-effectiveness.md';

describe('buildNarratePrompt', () => {
  const msgs = buildNarratePrompt(NOTE_PATH, REVS_NEWEST_FIRST);

  it('returns a 2-message conversation (system + user)', () => {
    expect(msgs.length).toBe(2);
    expect(msgs[0].role).toBe('system');
    expect(msgs[1].role).toBe('user');
  });

  it('system prompt carries citation marker convention [sha: + no-fabrication rule', () => {
    const sys = msgs[0].content;
    expect(sys).toContain('[sha:');
    expect(sys).toContain('do not invent');
  });

  it('user prompt mentions the notePath', () => {
    expect(msgs[1].content).toContain(NOTE_PATH);
  });

  it('user prompt contains every revision short sha (7 chars)', () => {
    const user = msgs[1].content;
    for (const r of REVS_NEWEST_FIRST) {
      expect(user).toContain(r.sha.slice(0, 7));
    }
  });

  it('user prompt contains every revision commitDate (date portion)', () => {
    const user = msgs[1].content;
    for (const r of REVS_NEWEST_FIRST) {
      expect(user).toContain(r.commitDate.slice(0, 10));
    }
  });

  it('user prompt orders revisions chronologically (oldest first)', () => {
    const user = msgs[1].content;
    const oldestShort = REVS_NEWEST_FIRST[2].sha.slice(0, 7); // aaaa...
    const middleShort = REVS_NEWEST_FIRST[1].sha.slice(0, 7); // bbbb...
    const newestShort = REVS_NEWEST_FIRST[0].sha.slice(0, 7); // cccc...
    expect(user.indexOf(oldestShort)).toBeLessThan(user.indexOf(middleShort));
    expect(user.indexOf(middleShort)).toBeLessThan(user.indexOf(newestShort));
  });

  it('user prompt contains each revision message', () => {
    const user = msgs[1].content;
    for (const r of REVS_NEWEST_FIRST) {
      expect(user).toContain(r.message);
    }
  });

  it('truncates revision content to ~300 chars per revision', () => {
    const big = 'y'.repeat(5000);
    const huge: Revision[] = [
      {
        sha: 'd'.repeat(40),
        commitDate: '2024-01-01T00:00:00Z',
        message: 'big body',
        authorEmail: 't@t',
        content: big,
      },
    ];
    const out = buildNarratePrompt(NOTE_PATH, huge);
    // single revision @ ~300 char body cap → user prompt stays well below 2000 chars
    expect(out[1].content.length).toBeLessThan(2000);
    expect(out[1].content).not.toContain(big);
  });

  it('handles revision w/ undefined content gracefully (pre-rename SHA case)', () => {
    const mixed: Revision[] = [
      {
        sha: 'e'.repeat(40),
        commitDate: '2024-02-01T00:00:00Z',
        message: 'no body available',
        authorEmail: 't@t',
        content: undefined,
      },
    ];
    const out = buildNarratePrompt(NOTE_PATH, mixed);
    expect(out.length).toBe(2);
    expect(out[1].content).toContain('eeeeeee');
    expect(out[1].content).toContain('no body available');
  });

  it('empty revisions list → still produces 2 messages w/ notePath', () => {
    const out = buildNarratePrompt(NOTE_PATH, []);
    expect(out.length).toBe(2);
    expect(out[1].content).toContain(NOTE_PATH);
  });
});
