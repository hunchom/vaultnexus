// Lexicon perturbations for Plan 21 — §10.9 precision-gate spike de-risker.
// Deterministic → same input → same list. Pure: no I/O.

/** One perturbed lexicon variant. `id` is human-readable, deterministic. */
export interface Perturbation {
  id: string;
  hedge: string[];
  assertion: string[];
}

// hedge → near-synonym, keeps word-bounded matching honest. Single mapping each → swap stays deterministic.
const HEDGE_SYNONYMS: Record<string, string> = {
  maybe: 'mayhap',
  perhaps: 'conceivably',
  might: 'mightbe',
  probably: 'likely',
};

const ASSERTION_SYNONYMS: Record<string, string> = {
  definitely: 'undoubtedly',
  clearly: 'plainly',
  obviously: 'evidently',
  essential: 'crucial',
};

/**
 * Produce ≤10 deterministic perturbations:
 *  - 1 baseline (id `v1`) — identity
 *  - up to 6 drop-one (3 hedge + 3 assertion, fixed positions)
 *  - up to 3 swap-synonym (mix hedge/assertion swaps from synonym maps)
 *
 * `n` caps total; default 10. Order: baseline → drops → swaps → truncated.
 */
export function perturbations(
  baseHedge: readonly string[],
  baseAssertion: readonly string[],
  n: number = 10,
): Perturbation[] {
  const out: Perturbation[] = [];

  // baseline → identity, always first
  out.push({ id: 'v1', hedge: [...baseHedge], assertion: [...baseAssertion] });

  // drop-one hedge → first 3 positions (deterministic)
  const hedgeDropPositions = pickPositions(baseHedge.length, 3);
  for (const pos of hedgeDropPositions) {
    out.push({
      id: `drop-hedge-${pos}`,
      hedge: dropAt([...baseHedge], pos),
      assertion: [...baseAssertion],
    });
  }

  // drop-one assertion → first 3 positions
  const assertionDropPositions = pickPositions(baseAssertion.length, 3);
  for (const pos of assertionDropPositions) {
    out.push({
      id: `drop-assertion-${pos}`,
      hedge: [...baseHedge],
      assertion: dropAt([...baseAssertion], pos),
    });
  }

  // swap-synonym → up to 3 swaps, deterministic order from synonym maps
  const hedgeSwaps = Object.entries(HEDGE_SYNONYMS).slice(0, 2);
  const assertionSwaps = Object.entries(ASSERTION_SYNONYMS).slice(0, 1);

  for (const [from, to] of hedgeSwaps) {
    out.push({
      id: `swap-hedge-${from}`,
      hedge: swapWord([...baseHedge], from, to),
      assertion: [...baseAssertion],
    });
  }
  for (const [from, to] of assertionSwaps) {
    out.push({
      id: `swap-assertion-${from}`,
      hedge: [...baseHedge],
      assertion: swapWord([...baseAssertion], from, to),
    });
  }

  return out.slice(0, n);
}

// pick first `count` valid positions in [0,len). len<count → returns [0..len-1].
function pickPositions(len: number, count: number): number[] {
  const k = Math.min(count, len);
  return Array.from({ length: k }, (_, i) => i);
}

// remove item at position; out-of-range → no-op copy.
function dropAt(arr: string[], pos: number): string[] {
  if (pos < 0 || pos >= arr.length) return arr;
  return [...arr.slice(0, pos), ...arr.slice(pos + 1)];
}

// replace first occurrence of `from` with `to`; absent → append `to`.
function swapWord(arr: string[], from: string, to: string): string[] {
  const idx = arr.indexOf(from);
  if (idx === -1) return [...arr, to];
  const out = [...arr];
  out[idx] = to;
  return out;
}
