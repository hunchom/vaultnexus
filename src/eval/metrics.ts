/** IR metrics over a ranked id list vs a relevant-id set. ids = note paths. */

/** Fraction of relevant ids appearing in top-k of ranked. 0 if relevant empty. */
export function recallAtK(ranked: string[], relevant: Set<string>, k: number): number {
  if (relevant.size === 0) return 0;
  let hit = 0;
  for (const id of ranked.slice(0, k)) if (relevant.has(id)) hit++;
  return hit / relevant.size;
}

/** 1/rank of first relevant id (1-indexed), 0 if none. */
export function reciprocalRank(ranked: string[], relevant: Set<string>): number {
  for (let i = 0; i < ranked.length; i++) if (relevant.has(ranked[i])) return 1 / (i + 1);
  return 0;
}

/** nDCG@k, binary relevance. gain 1 per relevant, discount 1/log2(rank+1). */
export function ndcgAtK(ranked: string[], relevant: Set<string>, k: number): number {
  if (relevant.size === 0) return 0;
  let dcg = 0;
  ranked.slice(0, k).forEach((id, i) => { if (relevant.has(id)) dcg += 1 / Math.log2(i + 2); });
  let idcg = 0;
  for (let i = 0; i < Math.min(relevant.size, k); i++) idcg += 1 / Math.log2(i + 2);
  return idcg === 0 ? 0 : dcg / idcg;
}
