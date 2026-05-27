/** Reciprocal Rank Fusion over ranked id-lists (order lists by trust, earliest=most trusted).
 *  score(id)=Σ wᵢ/(kRRF+rank). Ties → better best-rank, then earlier list, then id.
 *
 *  Plan 25: optional per-list weights. Default = all 1.0 → backwards-compat with Plan 08.
 *  Weight 0 → list contributes nothing (e.g. router='broad' suppresses FTS). */
export function fuseRRF(lists: number[][], kRRF = 60, weights?: number[]): number[] {
  const w = weights ?? lists.map(() => 1);
  if (w.length !== lists.length) {
    throw new Error(`fuseRRF: weights.length=${w.length} ≠ lists.length=${lists.length}`);
  }
  const score = new Map<number, number>();
  const bestRank = new Map<number, number>(); // lowest rank id reached in any list
  const bestList = new Map<number, number>(); // list index where bestRank achieved
  lists.forEach((list, li) => {
    const lw = w[li];
    if (lw === 0) return; // zero weight → skip; id won't appear unless another list adds it
    for (let rank = 0; rank < list.length; rank++) {
      const id = list[rank];
      score.set(id, (score.get(id) ?? 0) + lw / (kRRF + rank + 1));
      if (rank < (bestRank.get(id) ?? Infinity)) {
        bestRank.set(id, rank);
        bestList.set(id, li);
      }
    }
  });
  return [...score.keys()]
    .sort(
      (a, b) =>
        score.get(b)! - score.get(a)! ||
        bestRank.get(a)! - bestRank.get(b)! ||
        bestList.get(a)! - bestList.get(b)! ||
        a - b,
    );
}
