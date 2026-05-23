import { UndirectedGraph } from 'graphology';
import louvainMod from 'graphology-communities-louvain';

// graphology-communities-louvain ships types but its package has no "exports" map;
// under NodeNext esModuleInterop the default-import callable shape is preserved via this cast.
const louvain = louvainMod as unknown as (graph: UndirectedGraph, options?: Record<string, unknown>) => Record<string, number>;

/** Resolve bare wikilink target → note path by basename (case-insensitive). */
export function resolveLink(target: string, paths: string[]): string | undefined {
  const t = target.toLowerCase();
  return paths.find((p) => p.slice(p.lastIndexOf('/') + 1).replace(/\.md$/i, '').toLowerCase() === t);
}

/** Undirected note-link graph: nodes=note paths, edges=resolved wikilinks. */
export function buildNoteGraph(notes: Array<{ path: string; links: string[] }>): UndirectedGraph {
  const g = new UndirectedGraph();
  const paths = notes.map((n) => n.path);
  for (const n of notes) g.mergeNode(n.path);
  for (const n of notes) {
    for (const l of n.links) {
      const target = resolveLink(l, paths);
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
