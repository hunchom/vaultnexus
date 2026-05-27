// Lexicon perturbations for Plan 21 — §10.9 precision-gate spike de-risker.
// Deterministic → same input → same list. Pure: no I/O.
//
// Drop-1 sampling budget: positions 0/1/2 of each lexicon (deliberate n=10 cap).
// Full exhaustive coverage = 14 hedge + 12 assertion drops + 3 swaps + 1 baseline = 30 perturbations;
// callers can opt in via larger `n` arg at CLI — default keeps harness cost flat.

/** One perturbed lexicon variant. `id` is human-readable, deterministic. */
export interface Perturbation {
  id: string;
  hedge: string[];
  assertion: string[];
}

// Synonym maps trimmed to only the entries actually consumed below (2 hedge swaps + 1 assertion swap).
// Single mapping per word → swap stays deterministic.
const HEDGE_SYNONYMS: Record<string, string> = {
  maybe: 'mayhap',
  perhaps: 'conceivably',
};

const ASSERTION_SYNONYMS: Record<string, string> = {
  definitely: 'undoubtedly',
};

/**
 * Produce ≤10 deterministic perturbations:
 *  - 1 baseline (id `v1`) — identity
 *  - up to 6 drop-one (3 hedge + 3 assertion, sampled at positions 0/1/2 only — see file header for budget)
 *  - up to 3 swap-synonym (2 hedge + 1 assertion from trimmed synonym maps)
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

  // drop-one hedge → sample first 3 positions (budget cap, not exhaustive)
  const hedgeDropPositions = sampleFirstPositions(baseHedge.length, 3);
  for (const pos of hedgeDropPositions) {
    out.push({
      id: `drop-hedge-${pos}`,
      hedge: dropAt([...baseHedge], pos),
      assertion: [...baseAssertion],
    });
  }

  // drop-one assertion → sample first 3 positions (budget cap, not exhaustive)
  const assertionDropPositions = sampleFirstPositions(baseAssertion.length, 3);
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

// Sample first `count` positions in [0,len) — deliberate budget cap, NOT exhaustive coverage.
// len<count → returns [0..len-1].
function sampleFirstPositions(len: number, count: number): number[] {
  const k = Math.min(count, len);
  return Array.from({ length: k }, (_, i) => i);
}

// remove item at position; out-of-range → no-op copy.
function dropAt(arr: string[], pos: number): string[] {
  if (pos < 0 || pos >= arr.length) return arr;
  return [...arr.slice(0, pos), ...arr.slice(pos + 1)];
}

// replace first occurrence of `from` with `to`. Caller contract: `from` MUST exist in `arr`
// (all current call sites use keys from trimmed synonym maps that are present in base lexicons).
function swapWord(arr: string[], from: string, to: string): string[] {
  const idx = arr.indexOf(from);
  const out = [...arr];
  out[idx] = to;
  return out;
}
