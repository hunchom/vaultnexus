import { UndirectedGraph } from 'graphology';
import louvainMod from 'graphology-communities-louvain';

// graphology-communities-louvain ships types but its package has no "exports" map;
// under NodeNext esModuleInterop the default-import callable shape is preserved via this cast.
const louvain = louvainMod as unknown as (graph: UndirectedGraph, options?: Record<string, unknown>) => Record<string, number>;

/** Resolve bare wikilink target → note path by basename (case-insensitive). First-match on dup basenames. */
export function resolveLink(target: string, paths: string[]): string | undefined {
  const t = target.toLowerCase();
  return paths.find((p) => p.slice(p.lastIndexOf('/') + 1).replace(/\.md$/i, '').toLowerCase() === t);
}

/** Same as resolveLink but uses a pre-built basename index → O(1) per lookup. */
export function resolveLinkIndexed(target: string, byBase: Map<string, string>): string | undefined {
  return byBase.get(target.toLowerCase());
}

/** Undirected note-link graph: nodes=note paths, edges=resolved wikilinks. O(N+L) (Fix: review MEDIUM #3). */
export function buildNoteGraph(notes: Array<{ path: string; links: string[] }>): UndirectedGraph {
  const g = new UndirectedGraph();
  const byBase = new Map<string, string>();
  for (const n of notes) {
    const base = n.path.slice(n.path.lastIndexOf('/') + 1).replace(/\.md$/i, '').toLowerCase();
    // First wins on collisions → matches resolveLink semantics.
    if (!byBase.has(base)) byBase.set(base, n.path);
    g.mergeNode(n.path);
  }
  for (const n of notes) {
    for (const l of n.links) {
      const target = resolveLinkIndexed(l, byBase);
      if (target && target !== n.path) g.mergeEdge(n.path, target);
    }
  }
  return g;
}

/** Louvain communities → Map<notePath, communityId>. Edgeless → each node own id. */
export function detectCommunities(graph: UndirectedGraph): Map<string, number> {
  if (graph.size === 0) {
    let i = 0;
    const m = new Map<string, number>();
    graph.forEachNode((n: string) => m.set(n, i++));
    return m;
  }
  return new Map(Object.entries(louvain(graph)));
}
