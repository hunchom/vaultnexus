/** Reciprocal Rank Fusion over ranked id-lists. score(id)=Σ 1/(kRRF+rank). Returns ids, fused desc. */
export function fuseRRF(lists: number[][], kRRF = 60): number[] {
  const score = new Map<number, number>();
  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const id = list[rank];
      score.set(id, (score.get(id) ?? 0) + 1 / (kRRF + rank + 1));
    }
  }
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([id]) => id);
}
