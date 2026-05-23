import { describe, it, expect } from 'vitest';
import { buildNoteGraph, detectCommunities, resolveLink } from '../../src/daemon/note-graph.js';

describe('resolveLink', () => {
  it('resolves a bare target to a note path by basename, case-insensitive', () => {
    const paths = ['Habits.md', 'sub/Systems.md'];
    expect(resolveLink('Habits', paths)).toBe('Habits.md');
    expect(resolveLink('systems', paths)).toBe('sub/Systems.md');
    expect(resolveLink('Missing', paths)).toBeUndefined();
  });
});

describe('communities', () => {
  it('separates two disconnected link clusters', () => {
    const notes = [
      { path: 'a.md', links: ['b', 'c'] }, { path: 'b.md', links: ['a', 'c'] }, { path: 'c.md', links: ['a', 'b'] },
      { path: 'x.md', links: ['y'] }, { path: 'y.md', links: ['x'] },
    ];
    const comm = detectCommunities(buildNoteGraph(notes));
    expect(comm.get('a.md')).toBe(comm.get('b.md'));
    expect(comm.get('a.md')).toBe(comm.get('c.md'));
    expect(comm.get('x.md')).toBe(comm.get('y.md'));
    expect(comm.get('a.md')).not.toBe(comm.get('x.md'));
  });
  it('an unlinked note is its own community', () => {
    const comm = detectCommunities(buildNoteGraph([{ path: 'lone.md', links: [] }, { path: 'a.md', links: ['b'] }, { path: 'b.md', links: ['a'] }]));
    expect(comm.get('lone.md')).not.toBe(comm.get('a.md'));
  });
  it('edgeless graph → every node its own community (no throw)', () => {
    const comm = detectCommunities(buildNoteGraph([{ path: 'p.md', links: [] }, { path: 'q.md', links: [] }]));
    expect(comm.get('p.md')).not.toBe(comm.get('q.md'));
    expect(comm.size).toBe(2);
  });
});
