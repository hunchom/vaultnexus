import type { Embedder } from '../core/embedder.js';
import { chunkDocument } from '../core/chunk.js';
import { l2normalize, dotF32 } from '../core/vectors.js';
import { calibrateScale, quantize } from '../core/quantize.js';
import { search } from '../core/search.js';
import { FtsIndex } from './fts.js';
import { fuseRRF } from '../core/fusion.js';
import { classifyQuery, weightsForIntent, type QueryIntent } from '../core/router.js';
import { dppSelect, type DppItem } from '../core/dpp.js';
import { extractWikilinks } from '../core/wikilinks.js';
import { buildNoteGraph, detectCommunities, resolveLink } from './note-graph.js';
import { traceReasoning, type ReasonHop, type TraceFacade, type TraceOptions } from './reason-trace.js';
import { noteRevisions, type HistoryOptions, type Revision } from './git-history.js';
import type { ChatModel, ChatComposeOpts } from '../core/chat-model.js';
import { composeAnswer } from './reason-compose.js';
import { narrateRecallHistory, type NarrateOptions } from './recall-narrate.js';
import { scanVaultForecasts, type ForecastLedger } from './forecast-scan.js';
import type { IndexSnapshot, SnapshotChunk } from './index-snapshot.js';

// Defensive: legacy snapshots + skip-level headings can leak nulls/undefined → coerce.
function normalizeHeadingPath(p: ReadonlyArray<string | null | undefined>): string[] {
  return p.map((s) => (typeof s === 'string' ? s : ''));
}

export interface IndexedChunk {
  notePath: string;
  headingPath: string[];
  text: string;
  byteStart: number;
  byteEnd: number;
}

export interface SearchHit extends IndexedChunk {
  score: number;
}

/** Plan 25 — optional query-time controls.
 *  router: true → classifyQuery() → fusion weights per intent (default false = balanced 1.0/1.0).
 *  diversity: 0..1 → DPP rerank top-(k*4) chunks with λ = 1-diversity (0 = off, 0.3 = moderate).
 *  ftsOnly: true → fuse with weights [0, 1] → vector list contributes nothing, FTS5 alone ranks.
 *           Used by leakage-floor regression. Mutually exclusive with router (router wins). */
export interface QueryOptions {
  router?: boolean;
  diversity?: number;
  ftsOnly?: boolean;
}

/** Plan 25 telemetry — what the router decided + DPP applied. Returned by queryWithMeta(). */
export interface QueryMeta {
  intent: QueryIntent | null;       // null when router off
  weights: [number, number] | null; // [vec, fts]; null when router off (fused with defaults)
  diversity: number;                // λ-resolved diversity (0 = no DPP applied)
}

export interface Bridge { a: IndexedChunk; b: IndexedChunk; similarity: number; crossCommunity: boolean; linked: boolean; }

/** In-memory semantic index over note block-chunks. Cosine via unit-norm vectors. */
export class VaultIndex {
  private chunks: IndexedChunk[] = [];
  private f32: Float32Array[] = [];
  private dims = 0;
  private flatInt8: Int8Array | null = null;
  private flatF32: Float32Array | null = null;
  private scale = 1;
  private readonly fts = new FtsIndex();
  private readonly noteLinks = new Map<string, string[]>(); // notePath → bare wikilink targets
  private snapshot: IndexSnapshot | null = null; // optional persistence sink (Plan 26)

  constructor(
    private readonly embedder: Embedder,
    private readonly vaultPath?: string,
    private chatModel?: ChatModel,
  ) {}

  /** Inject a snapshot store → subsequent addNote() persists chunks + meta. Plan 26. */
  attachSnapshot(snapshot: IndexSnapshot): void {
    this.snapshot = snapshot;
  }

  /** Hot-swap chat model. Plugin /configure-chat → no daemon restart. */
  setChatModel(next: ChatModel): void {
    this.chatModel = next;
  }

  /** Chat model id for transparency (returned in vaultnexus_reason). 'none' when unset. */
  chatModelId(): string {
    return this.chatModel?.id ?? 'none';
  }

  get size(): number {
    return this.chunks.length;
  }

  /** Snapshot of note paths currently in the index. */
  notePaths(): string[] {
    return [...this.noteLinks.keys()].sort();
  }

  /** Outbound wikilink targets cached for a note. Empty if note unknown. */
  outboundLinks(notePath: string): string[] {
    return [...(this.noteLinks.get(notePath) ?? [])];
  }

  /** Read-only access to the full link map (for analytics tools). */
  linkMap(): Map<string, string[]> {
    return new Map([...this.noteLinks.entries()].map(([k, v]) => [k, [...v]]));
  }

  /** All chunks belonging to a note → cheap outline + neighbors. */
  chunksOfNote(notePath: string): IndexedChunk[] {
    return this.chunks.filter((c) => c.notePath === notePath);
  }

  /** Embed once + rank against the rest of the vault → semantic neighbors of a whole note. */
  async neighborsOf(notePath: string, k = 10): Promise<SearchHit[]> {
    const own = this.chunks.filter((c) => c.notePath === notePath);
    if (own.length === 0) return [];
    // Use the longest own chunk as the seed → most signal w/ a single embed call.
    const seed = own.reduce((a, b) => (a.text.length >= b.text.length ? a : b)).text;
    const hits = await this.query(seed, k * 2);
    return hits.filter((h) => h.notePath !== notePath).slice(0, k);
  }

  /** Drop a note from the index. Rebuilds the int8 + FTS stores so query() stays correct. */
  async removeNote(notePath: string): Promise<void> {
    // Collect kept indices first → filter chunks + f32 in lockstep.
    const keep: number[] = [];
    for (let i = 0; i < this.chunks.length; i += 1) {
      if (this.chunks[i].notePath !== notePath) keep.push(i);
    }
    this.chunks = keep.map((i) => this.chunks[i]);
    this.f32 = keep.map((i) => this.f32[i]);
    this.noteLinks.delete(notePath);
    // FTS rowids were the old indices → easiest: clear + re-add at new compact ids.
    this.fts.clear();
    this.chunks.forEach((c, id) => this.fts.add(id, c.text));
    this.flatInt8 = null;
    if (this.snapshot) this.snapshot.deleteNote(notePath);
  }

  /** Chunk a note, embed its blocks, store unit-norm for search. Persists to snapshot if attached + meta given. */
  async addNote(notePath: string, source: string, meta?: { contentSha: string; mtimeMs: number }): Promise<void> {
    // Register link map first → notePaths()/linkMap() see empty notes too (Fix: review finding #1).
    this.noteLinks.set(notePath, extractWikilinks(source));
    // tokenBudget:0 → one block per paragraph (paragraph = retrieval unit)
    const blocks = chunkDocument(source, { tokenBudget: 0 }).filter((c) => c.granularity === 'block');
    if (blocks.length === 0) {
      if (this.snapshot && meta) {
        this.snapshot.setNote(notePath, meta.contentSha, meta.mtimeMs);
        this.snapshot.putChunks(notePath, []);
      }
      return;
    }
    const vecs = await this.embedder.embed(blocks.map((b) => b.text));
    const unitVecs = vecs.map((v) => l2normalize(v));
    const snapChunks: SnapshotChunk[] = [];
    blocks.forEach((b, i) => {
      const headingPath = normalizeHeadingPath(b.headingPath);
      const id = this.chunks.length;
      this.chunks.push({ notePath, headingPath, text: b.text, byteStart: b.byteStart, byteEnd: b.byteEnd });
      this.f32.push(unitVecs[i]);
      this.fts.add(id, b.text);
      snapChunks.push({
        headingPath, text: b.text, byteStart: b.byteStart, byteEnd: b.byteEnd, vec: unitVecs[i],
      });
    });
    this.dims = this.f32[0].length;
    this.flatInt8 = null; // new data → rebuild flat store on next query
    if (this.snapshot && meta) {
      this.snapshot.setNote(notePath, meta.contentSha, meta.mtimeMs);
      this.snapshot.putChunks(notePath, snapChunks);
    }
  }

  /** Restore a note's chunks + vecs from snapshot rows (no chunking, no embedding). Plan 26. */
  restoreNote(notePath: string, source: string, chunks: SnapshotChunk[]): void {
    if (chunks.length === 0) return;
    this.noteLinks.set(notePath, extractWikilinks(source));
    chunks.forEach((c) => {
      const headingPath = normalizeHeadingPath(c.headingPath);
      const id = this.chunks.length;
      this.chunks.push({ notePath, headingPath, text: c.text, byteStart: c.byteStart, byteEnd: c.byteEnd });
      this.f32.push(c.vec);
      this.fts.add(id, c.text);
    });
    this.dims = this.f32[0].length;
    this.flatInt8 = null;
  }

  /** Indexed notes with their bare wikilink targets (for graph build). */
  private noteList(): Array<{ path: string; links: string[] }> {
    return [...this.noteLinks.entries()].map(([path, links]) => ({ path, links }));
  }

  private build(): void {
    const n = this.f32.length, d = this.dims;
    this.scale = calibrateScale(this.f32);
    const i8 = new Int8Array(n * d);
    const f = new Float32Array(n * d);
    this.f32.forEach((v, i) => {
      i8.set(quantize(v, this.scale), i * d);
      f.set(v, i * d);
    });
    this.flatInt8 = i8;
    this.flatF32 = f;
  }

  /** Cross-note high-similarity chunk pairs ("notes that secretly agree"), top-N descending. FP-safe. */
  bridges(topN = 20, minSimilarity = 0.5, crossCommunityOnly = false): Bridge[] {
    const n = this.chunks.length;
    if (n < 2) return [];
    if (!this.flatInt8) this.build();
    const f = this.flatF32!;
    const d = this.dims;
    const notes = this.noteList();
    // every chunk.notePath ∈ noteLinks (addNote sets it past the empty-blocks guard) → ∈ comm
    const comm = detectCommunities(buildNoteGraph(notes));
    const paths = notes.map((nt) => nt.path);
    const key = (p: string, q: string) => (p < q ? `${p} ${q}` : `${q} ${p}`);
    const linkedPairs = new Set<string>();
    for (const nt of notes) for (const l of nt.links) {
      const t = resolveLink(l, paths);
      if (t && t !== nt.path) linkedPairs.add(key(nt.path, t));
    }
    const out: Bridge[] = [];
    for (let i = 0; i < n; i++) {
      const vi = f.subarray(i * d, (i + 1) * d);
      for (let j = i + 1; j < n; j++) {
        if (this.chunks[i].notePath === this.chunks[j].notePath) continue;
        const s = dotF32(vi, f.subarray(j * d, (j + 1) * d));
        if (s >= minSimilarity) {
          const aP = this.chunks[i].notePath, bP = this.chunks[j].notePath;
          const crossCommunity = comm.get(aP) !== comm.get(bP);
          if (crossCommunityOnly && !crossCommunity) continue;
          out.push({ a: this.chunks[i], b: this.chunks[j], similarity: s, crossCommunity, linked: linkedPairs.has(key(aP, bP)) });
        }
      }
    }
    out.sort((x, y) => y.similarity - x.similarity);
    return out.slice(0, topN);
  }

  /** Embed query, search, return cited hits. vector ⊕ FTS → (optionally weighted) RRF fusion,
   *  then (optionally) DPP rerank for diversity. opts default = Plan 08 behavior. */
  async query(text: string, k = 10, opts: QueryOptions = {}): Promise<SearchHit[]> {
    return (await this.queryWithMeta(text, k, opts)).hits;
  }

  /** Same as query() but also returns router/diversity telemetry. Plan 25. */
  async queryWithMeta(
    text: string,
    k = 10,
    opts: QueryOptions = {},
  ): Promise<{ hits: SearchHit[]; meta: QueryMeta }> {
    if (this.chunks.length === 0) {
      return { hits: [], meta: { intent: null, weights: null, diversity: 0 } };
    }
    if (!this.flatInt8) this.build();
    const [qe] = await this.embedder.embed([text]);
    const q = l2normalize(qe);
    const want = Math.floor(k) * 8; // FTS LIMIT needs int; vec list parity
    const vec = search(q, {
      flatInt8: this.flatInt8!, flatF32: this.flatF32!,
      count: this.chunks.length, dims: this.dims, scale: this.scale, k: want,
    });
    const lex = this.fts.search(text, want);

    // Router → fusion weights. Default (off) → balanced 1.0/1.0 (Plan 08 behavior).
    // ftsOnly → suppress vector list entirely. router wins when both set.
    let intent: QueryIntent | null = null;
    let weights: [number, number] | null = null;
    let fusionWeights: number[] | undefined;
    if (opts.router) {
      intent = classifyQuery(text);
      const w = weightsForIntent(intent);
      weights = [w.vector, w.fts];
      fusionWeights = [w.vector, w.fts];
    } else if (opts.ftsOnly) {
      fusionWeights = [0, 1];
    }

    const fusedAll = fuseRRF(
      [vec.map((r) => r.index), lex.map((r) => r.id)],
      60,
      fusionWeights,
    );

    // DPP rerank (optional). λ = 1 - diversity → diversity=0 means λ=1 means no-op.
    const diversity = Math.max(0, Math.min(1, opts.diversity ?? 0));
    let fusedFinal: number[];
    if (diversity > 0 && fusedAll.length > 0) {
      const cosMap = new Map(vec.map((r) => [r.index, r.score]));
      // Score for DPP relevance: prefer real cosine; FTS-only hits fall back to true cosine.
      const items: DppItem[] = fusedAll.slice(0, k * 4).map((index) => ({
        id: index,
        score: cosMap.get(index) ?? dotF32(q, this.f32[index]),
        vec: this.f32[index],
      }));
      fusedFinal = dppSelect(items, k, 1 - diversity);
    } else {
      fusedFinal = fusedAll.slice(0, k);
    }

    const cos = new Map(vec.map((r) => [r.index, r.score]));
    const hits = fusedFinal.map((index) => ({
      ...this.chunks[index],
      score: cos.get(index) ?? dotF32(q, this.f32[index]),
    }));
    return { hits, meta: { intent, weights, diversity } };
  }

  // shared facade builder → trace() + reason() use the same view
  private makeFacade(): TraceFacade {
    return {
      chunks: this.chunks,
      f32: this.f32,
      noteLinks: this.noteLinks,
      query: (text, k) => this.query(text, k),
      chunkIdOf: (hit) =>
        this.chunks.findIndex((c) => c.notePath === hit.notePath && c.byteStart === hit.byteStart),
    };
  }

  /** Graph-BFS citation chain (seed → wikilink + kNN). No LLM compose. */
  async trace(question: string, opts: TraceOptions = {}): Promise<ReasonHop[]> {
    if (this.chunks.length === 0) return [];
    if (!this.flatInt8) this.build();
    return traceReasoning(this.makeFacade(), question, opts);
  }

  /** Cited LLM answer over the trace chain. Throws when no ChatModel injected (config bug). */
  async reason(
    question: string,
    opts: TraceOptions & ChatComposeOpts = {},
  ): Promise<{ answer: string; hops: ReasonHop[]; invalidCitations: string[] }> {
    if (!this.chatModel) {
      throw new Error(
        'reason() requires a ChatModel — pass via new VaultIndex(embedder, vaultPath, chatModel)',
      );
    }
    if (this.chunks.length === 0)
      return { answer: 'No relevant context found in vault.', hops: [], invalidCitations: [] };
    if (!this.flatInt8) this.build();
    return composeAnswer(this.makeFacade(), this.chatModel, question, opts);
  }

  /** Git-history walker for `notePath` (POSIX-relative to vaultPath). [] when vaultPath unset. */
  async history(notePath: string, opts: HistoryOptions = {}): Promise<Revision[]> {
    if (!this.vaultPath) return [];
    return noteRevisions(this.vaultPath, notePath, opts);
  }

  /** Stance-shift narration over the note's git timeline. Throws when no ChatModel injected. */
  async narrateHistory(
    notePath: string,
    opts: NarrateOptions = {},
  ): Promise<{ narration: string; revisions: Revision[]; invalidShaCitations: string[] }> {
    if (!this.chatModel) {
      throw new Error(
        'narrateHistory() requires a ChatModel — pass via new VaultIndex(embedder, vaultPath, chatModel)',
      );
    }
    if (!this.vaultPath) {
      // no vault root → no git history to walk
      return {
        narration: 'Note has fewer than two revisions; no stance shift to narrate.',
        revisions: [],
        invalidShaCitations: [],
      };
    }
    return narrateRecallHistory(this.vaultPath, this.chatModel, notePath, opts);
  }

  /** Walk vault frontmatter → { pending, resolved, brier }. Throws when vaultPath unset. */
  async forecasts(): Promise<ForecastLedger> {
    if (!this.vaultPath) {
      throw new Error(
        'forecasts() requires a vaultPath — pass via new VaultIndex(embedder, vaultPath, ...)',
      );
    }
    return scanVaultForecasts(this.vaultPath);
  }

  /** Release native FTS db handle. */
  close(): void {
    this.fts.close();
  }
}
