/** Reciprocal Rank Fusion over ranked id-lists (order lists by trust, earliest=most trusted).
 *  score(id)=Σ 1/(kRRF+rank). Ties → better best-rank, then earlier list, then id. */
export function fuseRRF(lists: number[][], kRRF = 60): number[] {
  const score = new Map<number, number>();
  const bestRank = new Map<number, number>(); // lowest rank id reached in any list
  const bestList = new Map<number, number>(); // list index where bestRank achieved
  lists.forEach((list, li) => {
    for (let rank = 0; rank < list.length; rank++) {
      const id = list[rank];
      score.set(id, (score.get(id) ?? 0) + 1 / (kRRF + rank + 1));
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
