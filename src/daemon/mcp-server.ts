import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { health } from '../core/health.js';
import type { VaultIndex } from './vault-index.js';
import * as fsops from './vault-fs.js';
import { outlineFromSource, tagCounts, recentNotes, orphanNotes, linkGraph, notesByTag, brokenLinks, unlinkedMentions, linkCountsPerNote, inboundRanking } from './vault-analytics.js';

export interface McpServerDeps {
  index?: VaultIndex;
  vaultDir?: string;
  embedderId?: string;
  /** Called after FS writes so the in-memory index re-syncs (re-embed changed note). */
  onNoteChanged?: (notePath: string) => Promise<void>;
  /** Called after FS deletes so the in-memory index drops the note. */
  onNoteRemoved?: (notePath: string) => Promise<void>;
}

// All tool responses go through this → JSON.stringify uniform, no per-tool formatting drift.
function payload(obj: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }] };
}
function errPayload(message: string): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

/** Build the VaultNexus MCP server. ping always; everything else when an index + vaultDir is injected. */
export function createMcpServer(deps: McpServerDeps = {}): McpServer {
  const server = new McpServer({ name: 'vaultnexus', version: health().version });

  // ─────────────────────────────────────────── always-on
  server.registerTool(
    'vaultnexus_ping',
    { description: 'Health and version probe.' },
    async () => payload({ ...health(), embedder: deps.embedderId ?? 'fake' }),
  );

  const index = deps.index;
  const vaultDir = deps.vaultDir;
  if (!index) return server;

  // ─────────────────────────────────────────── retrieval
  server.registerTool(
    'vaultnexus_search',
    {
      description: 'Hybrid semantic + lexical search. Returns ranked cited chunks {notePath, headingPath, byteStart, byteEnd, text, score}.',
      inputSchema: { query: z.string().min(1), k: z.number().int().positive().optional() },
    },
    async ({ query, k }) => payload(await index.query(query, k ?? 10)),
  );

  server.registerTool(
    'vaultnexus_bridges',
    {
      description: 'Chunk pairs semantically similar but in different notes (hidden connections). crossCommunityOnly returns only cross-cluster never-linked pairs.',
      inputSchema: {
        topN: z.number().int().positive().optional(),
        minSimilarity: z.number().optional(),
        crossCommunityOnly: z.boolean().optional(),
      },
    },
    async ({ topN, minSimilarity, crossCommunityOnly }) =>
      payload(index.bridges(topN ?? 20, minSimilarity ?? 0.5, crossCommunityOnly ?? false)),
  );

  server.registerTool(
    'vaultnexus_neighbors',
    {
      description: 'Semantically near chunks to a given note (whole-note seed). Drops chunks from the source note.',
      inputSchema: { notePath: z.string(), k: z.number().int().positive().optional() },
    },
    async ({ notePath, k }) => payload(await index.neighborsOf(notePath, k ?? 10)),
  );

  // ─────────────────────────────────────────── reasoning
  server.registerTool(
    'vaultnexus_trace',
    {
      description: 'Ordered citation chain (seed → wikilink + knn hops). No LLM compose; the chain is the contract.',
      inputSchema: {
        question: z.string(),
        maxDepth: z.number().int().nonnegative().optional(),
        kSeeds: z.number().int().positive().optional(),
        knnPerHop: z.number().int().positive().optional(),
        simThreshold: z.number().optional(),
        maxHops: z.number().int().positive().optional(),
      },
    },
    async ({ question, maxDepth, kSeeds, knnPerHop, simThreshold, maxHops }) => {
      const hops = await index.trace(question, { maxDepth, kSeeds, knnPerHop, simThreshold, maxHops });
      return payload({ hops });
    },
  );

  server.registerTool(
    'vaultnexus_reason',
    {
      description: 'Cited natural-language answer composed over the citation chain. Every claim cites [ref:notePath:byteStart-byteEnd].',
      inputSchema: {
        question: z.string(),
        maxDepth: z.number().int().nonnegative().optional(),
        kSeeds: z.number().int().positive().optional(),
        knnPerHop: z.number().int().positive().optional(),
        simThreshold: z.number().optional(),
        maxHops: z.number().int().positive().optional(),
        maxTokens: z.number().int().positive().optional(),
        temperature: z.number().optional(),
      },
    },
    async (args) => payload({ ...(await index.reason(args.question, args)), model: index.chatModelId() }),
  );

  // ─────────────────────────────────────────── history + forecasts
  server.registerTool(
    'vaultnexus_history',
    {
      description: 'Git revisions for a note (newest first). Every entry cites a real git SHA the user can `git show`.',
      inputSchema: {
        notePath: z.string(),
        since: z.string().optional(),
        until: z.string().optional(),
        withContent: z.boolean().optional(),
        maxRevisions: z.number().int().positive().optional(),
      },
    },
    async (args) => payload({ revisions: await index.history(args.notePath, args) }),
  );

  server.registerTool(
    'vaultnexus_recall_history',
    {
      description: 'Cited narration of how a single note shifted across its git timeline.',
      inputSchema: {
        notePath: z.string(),
        since: z.string().optional(),
        until: z.string().optional(),
        maxRevisions: z.number().int().positive().optional(),
        maxTokens: z.number().int().positive().optional(),
        temperature: z.number().optional(),
      },
    },
    async (args) => payload({ ...(await index.narrateHistory(args.notePath, args)), model: index.chatModelId() }),
  );

  server.registerTool(
    'vaultnexus_forecasts',
    { description: 'Vault forecast ledger w/ Brier score across resolved entries.' },
    async () => payload(await index.forecasts()),
  );

  // Below: orphans + link_graph need only the index (no vaultDir).
  server.registerTool(
    'vaultnexus_orphans',
    { description: 'Notes with no inbound wikilinks from any other note (vault-internal islands).' },
    async () => payload({ orphans: orphanNotes(index.linkMap()) }),
  );

  server.registerTool(
    'vaultnexus_link_graph',
    {
      description: 'Inbound + outbound wikilinks for a note. {outbound:[], inbound:[]}',
      inputSchema: { notePath: z.string() },
    },
    async ({ notePath }) => payload(linkGraph(index.linkMap(), notePath)),
  );

  // ─────────────────────────────────────────── FS-backed tools require vaultDir
  if (!vaultDir) return server;

  // ─────────────────────────────────────────── read
  server.registerTool(
    'vaultnexus_list',
    {
      description: 'List subfolders + .md notes in a vault-relative folder. Empty path = vault root.',
      inputSchema: { path: z.string().optional() },
    },
    async ({ path }) => {
      try { return payload(await fsops.listFolder(vaultDir, path ?? '')); }
      catch (e) { return errPayload((e as Error).message); }
    },
  );

  server.registerTool(
    'vaultnexus_read_page',
    {
      description: 'Read a note. Returns {notePath, bytes, text}. Optional byte slice.',
      inputSchema: {
        notePath: z.string(),
        byteStart: z.number().int().nonnegative().optional(),
        byteEnd: z.number().int().nonnegative().optional(),
      },
    },
    async ({ notePath, byteStart, byteEnd }) => {
      try { return payload(await fsops.readPage(vaultDir, notePath, { byteStart, byteEnd })); }
      catch (e) { return errPayload((e as Error).message); }
    },
  );

  server.registerTool(
    'vaultnexus_outline',
    {
      description: 'Heading tree of a note. Returns [{depth, text, byteOffset}].',
      inputSchema: { notePath: z.string() },
    },
    async ({ notePath }) => {
      try {
        const { text } = await fsops.readPage(vaultDir, notePath);
        return payload({ notePath, headings: outlineFromSource(text) });
      } catch (e) { return errPayload((e as Error).message); }
    },
  );

  server.registerTool(
    'vaultnexus_stats',
    {
      description: 'Vault metrics: notes, chunks, total bytes, avg chunk bytes, embedder + chat model id.',
    },
    async () => {
      // stat() instead of readFile() → no file content load just to sum sizes (Fix: review finding #6).
      const notes = index.notePaths();
      let bytes = 0;
      let chunkBytes = 0;
      const chunks = index.size;
      const { stat } = await import('node:fs/promises');
      const { join: pjoin } = await import('node:path');
      for (const n of notes) {
        try {
          const s = await stat(pjoin(vaultDir, n));
          bytes += s.size;
        } catch { /* skip notes that vanished mid-walk */ }
      }
      for (const c of notes.flatMap((n) => index.chunksOfNote(n))) chunkBytes += Buffer.byteLength(c.text, 'utf8');
      return payload({
        notes: notes.length,
        chunks,
        bytes,
        avgChunkBytes: chunks > 0 ? Math.round(chunkBytes / chunks) : 0,
        embedder: deps.embedderId ?? 'fake',
        chatModel: index.chatModelId(),
      });
    },
  );

  server.registerTool(
    'vaultnexus_tags',
    {
      description: 'Count #tag occurrences across the vault. Sorted by count desc.',
      inputSchema: { limit: z.number().int().positive().optional() },
    },
    async ({ limit }) => {
      const tags = await tagCounts(vaultDir, async (abs) => (await readFile(abs)).toString('utf8'));
      return payload(limit ? tags.slice(0, limit) : tags);
    },
  );

  server.registerTool(
    'vaultnexus_recent',
    {
      description: 'Most recently modified notes (mtime desc).',
      inputSchema: { limit: z.number().int().positive().optional() },
    },
    async ({ limit }) => payload(await recentNotes(vaultDir, limit ?? 20)),
  );

  // ─────────────────────────────────────────── write
  server.registerTool(
    'vaultnexus_create_page',
    {
      description: 'Create a new note. Refuses overwrite unless overwrite=true. Re-indexes immediately.',
      inputSchema: {
        notePath: z.string(),
        content: z.string(),
        overwrite: z.boolean().optional(),
      },
    },
    async ({ notePath, content, overwrite }) => {
      try {
        const r = await fsops.createPage(vaultDir, notePath, content, { overwrite });
        await deps.onNoteChanged?.(notePath);
        return payload(r);
      } catch (e) { return errPayload((e as Error).message); }
    },
  );

  server.registerTool(
    'vaultnexus_create_folder',
    {
      description: 'mkdir -p under the vault.',
      inputSchema: { folderPath: z.string() },
    },
    async ({ folderPath }) => {
      try { return payload(await fsops.createFolder(vaultDir, folderPath)); }
      catch (e) { return errPayload((e as Error).message); }
    },
  );

  server.registerTool(
    'vaultnexus_append_to_page',
    {
      description: 'Append text to the end of a note. Re-indexes the note.',
      inputSchema: { notePath: z.string(), text: z.string() },
    },
    async ({ notePath, text }) => {
      try {
        const r = await fsops.appendToPage(vaultDir, notePath, text);
        await deps.onNoteChanged?.(notePath);
        return payload(r);
      } catch (e) { return errPayload((e as Error).message); }
    },
  );

  server.registerTool(
    'vaultnexus_insert_after_heading',
    {
      description: 'Insert text after the first heading line whose text matches exactly. Re-indexes the note.',
      inputSchema: {
        notePath: z.string(),
        heading: z.string(),
        insertion: z.string(),
      },
    },
    async ({ notePath, heading, insertion }) => {
      try {
        const r = await fsops.insertAfterHeading(vaultDir, notePath, heading, insertion);
        await deps.onNoteChanged?.(notePath);
        return payload(r);
      } catch (e) { return errPayload((e as Error).message); }
    },
  );

  server.registerTool(
    'vaultnexus_replace_in_page',
    {
      description: 'Literal find/replace inside a note. all=true replaces every occurrence; default = first only. Re-indexes the note.',
      inputSchema: {
        notePath: z.string(),
        find: z.string(),
        replace: z.string(),
        all: z.boolean().optional(),
      },
    },
    async ({ notePath, find, replace, all }) => {
      try {
        const r = await fsops.replaceInPage(vaultDir, notePath, find, replace, { all });
        if (r.replacements > 0) await deps.onNoteChanged?.(notePath);
        return payload(r);
      } catch (e) { return errPayload((e as Error).message); }
    },
  );

  server.registerTool(
    'vaultnexus_delete_page',
    {
      description: 'Soft-delete a note (moves into <vault>/.trash/<timestamp>/). Drops it from the index.',
      inputSchema: { notePath: z.string() },
    },
    async ({ notePath }) => {
      try {
        const r = await fsops.deletePage(vaultDir, notePath);
        await deps.onNoteRemoved?.(notePath);
        return payload(r);
      } catch (e) { return errPayload((e as Error).message); }
    },
  );

  server.registerTool(
    'vaultnexus_delete_folder',
    {
      description: 'Soft-delete a folder. Refuses non-empty unless force=true. Drops all contained notes from the index.',
      inputSchema: { folderPath: z.string(), force: z.boolean().optional() },
    },
    async ({ folderPath, force }) => {
      try {
        const notesUnder = index.notePaths().filter((n) => n.startsWith(folderPath.replace(/\/+$/, '') + '/'));
        const r = await fsops.deleteFolder(vaultDir, folderPath, { force });
        for (const n of notesUnder) await deps.onNoteRemoved?.(n);
        return payload({ ...r, droppedFromIndex: notesUnder.length });
      } catch (e) { return errPayload((e as Error).message); }
    },
  );

  server.registerTool(
    'vaultnexus_move',
    {
      description: 'Rename / move a note or folder within the vault. Re-indexes (drops old paths, adds new).',
      inputSchema: { from: z.string(), to: z.string() },
    },
    async ({ from, to }) => {
      try {
        // Collect notes-under-folder BEFORE the rename so the index can mirror the move (Fix: review finding #3).
        const isFolderSrc = !from.toLowerCase().endsWith('.md');
        const prefix = from.replace(/\/+$/, '') + '/';
        const notesUnder = isFolderSrc
          ? index.notePaths().filter((n) => n.startsWith(prefix))
          : [];
        const r = await fsops.renamePath(vaultDir, from, to);
        if (isFolderSrc) {
          const toPrefix = to.replace(/\/+$/, '') + '/';
          for (const oldPath of notesUnder) {
            const newPath = toPrefix + oldPath.slice(prefix.length);
            await deps.onNoteRemoved?.(oldPath);
            await deps.onNoteChanged?.(newPath);
          }
        } else {
          await deps.onNoteRemoved?.(from);
          if (to.toLowerCase().endsWith('.md')) await deps.onNoteChanged?.(to);
        }
        return payload({ ...r, droppedFromIndex: isFolderSrc ? notesUnder.length : 1 });
      } catch (e) { return errPayload((e as Error).message); }
    },
  );

  server.registerTool(
    'vaultnexus_rename_heading',
    {
      description: 'Rename one heading inside a note by exact text match. Depth preserved.',
      inputSchema: { notePath: z.string(), oldText: z.string(), newText: z.string() },
    },
    async ({ notePath, oldText, newText }) => {
      try {
        const r = await fsops.renameHeading(vaultDir, notePath, oldText, newText);
        if (r.replacements > 0) await deps.onNoteChanged?.(notePath);
        return payload(r);
      } catch (e) { return errPayload((e as Error).message); }
    },
  );

  server.registerTool(
    'vaultnexus_find_by_tag',
    {
      description: 'Notes that contain a specific #tag (case-insensitive). Returns paths.',
      inputSchema: { tag: z.string() },
    },
    async ({ tag }) => {
      const notes = await notesByTag(vaultDir, tag, async (abs) => (await readFile(abs)).toString('utf8'));
      return payload({ tag, notes });
    },
  );

  server.registerTool(
    'vaultnexus_broken_links',
    { description: 'Wikilinks pointing at vault paths that do not resolve to any indexed note.' },
    async () => payload({ broken: brokenLinks(index.linkMap()) }),
  );

  server.registerTool(
    'vaultnexus_search_replace_vault',
    {
      description: 'Apply find/replace across the entire vault. all=true replaces every occurrence per note; default = first only per note. Re-indexes every touched note.',
      inputSchema: {
        find: z.string(),
        replace: z.string(),
        all: z.boolean().optional(),
        pathPrefix: z.string().optional(),
      },
    },
    async ({ find, replace, all, pathPrefix }) => {
      const notes = index.notePaths().filter((n) => !pathPrefix || n.startsWith(pathPrefix));
      const touched: Array<{ notePath: string; replacements: number }> = [];
      for (const n of notes) {
        try {
          const r = await fsops.replaceInPage(vaultDir, n, find, replace, { all });
          if (r.replacements > 0) {
            touched.push({ notePath: n, replacements: r.replacements });
            await deps.onNoteChanged?.(n);
          }
        } catch (e) { /* skip notes that disappeared mid-walk */ }
      }
      return payload({ touched, totalNotes: touched.length, totalReplacements: touched.reduce((s, t) => s + t.replacements, 0) });
    },
  );

  server.registerTool(
    'vaultnexus_get_partial',
    {
      description: 'Slice of a note by selector. kind=heading requires text. kind=frontmatter|outline ignores text.',
      inputSchema: {
        notePath: z.string(),
        kind: z.enum(['heading', 'frontmatter', 'outline']),
        text: z.string().optional(),
      },
    },
    async ({ notePath, kind, text }) => {
      // Heading mode w/o text would silently match no heading → bail early (Fix: review finding #9).
      if (kind === 'heading' && (!text || !text.trim())) return errPayload('text required when kind=heading');
      try {
        const sel = kind === 'heading' ? { kind: 'heading' as const, text: text! }
          : kind === 'frontmatter' ? { kind: 'frontmatter' as const }
          : { kind: 'outline' as const };
        return payload(await fsops.getPartial(vaultDir, notePath, sel));
      } catch (e) { return errPayload((e as Error).message); }
    },
  );

  server.registerTool(
    'vaultnexus_patch_section',
    {
      description: 'Replace the body of a heading section (heading line preserved). Re-indexes the note.',
      inputSchema: { notePath: z.string(), heading: z.string(), newBody: z.string() },
    },
    async ({ notePath, heading, newBody }) => {
      try {
        const r = await fsops.patchHeadingSection(vaultDir, notePath, heading, newBody);
        await deps.onNoteChanged?.(notePath);
        return payload(r);
      } catch (e) { return errPayload((e as Error).message); }
    },
  );

  server.registerTool(
    'vaultnexus_periodic_note',
    {
      description: 'Get or create a periodic note: daily (YYYY-MM-DD.md), weekly (YYYY-Www.md), monthly (YYYY-MM.md), yearly (YYYY.md). Defaults to today.',
      inputSchema: {
        period: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
        date: z.string().optional(),
        folder: z.string().optional(),
        template: z.string().optional(),
      },
    },
    async ({ period, date, folder, template }) => {
      const d = date ? new Date(date) : new Date();
      if (Number.isNaN(d.getTime())) return errPayload(`bad date: ${date}`);
      const yyyy = d.getUTCFullYear();
      const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(d.getUTCDate()).padStart(2, '0');
      // ISO week: Thursday-of-the-week trick → reliable across years
      const weekOf = (dt: Date): string => {
        const t = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()));
        const day = (t.getUTCDay() + 6) % 7; // Mon = 0
        t.setUTCDate(t.getUTCDate() - day + 3);
        const jan4 = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
        const week = 1 + Math.round(((t.getTime() - jan4.getTime()) / 86_400_000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
        return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
      };
      const stem = period === 'daily' ? `${yyyy}-${mm}-${dd}`
        : period === 'weekly' ? weekOf(d)
        : period === 'monthly' ? `${yyyy}-${mm}`
        : `${yyyy}`;
      const notePath = (folder ? `${folder.replace(/\/$/, '')}/` : '') + `${stem}.md`;
      try {
        const r = await fsops.readPage(vaultDir, notePath);
        return payload({ ...r, period, stem, created: false });
      } catch {
        const initial = template ?? `# ${stem}\n\n`;
        const r = await fsops.createPage(vaultDir, notePath, initial);
        await deps.onNoteChanged?.(notePath);
        return payload({ ...r, period, stem, created: true, text: initial });
      }
    },
  );

  server.registerTool(
    'vaultnexus_note_hash',
    {
      description: 'SHA-256 of a note. Cheap change-detection + dedup key.',
      inputSchema: { notePath: z.string() },
    },
    async ({ notePath }) => {
      try { return payload(await fsops.noteHash(vaultDir, notePath)); }
      catch (e) { return errPayload((e as Error).message); }
    },
  );

  server.registerTool(
    'vaultnexus_find_exact_duplicates',
    { description: 'Groups of notes with identical SHA-256 content. Groups of 2+, sorted by group size.' },
    async () => {
      try { return payload({ groups: await fsops.findExactDuplicates(vaultDir) }); }
      catch (e) { return errPayload((e as Error).message); }
    },
  );

  server.registerTool(
    'vaultnexus_find_empty_notes',
    {
      description: 'Notes with body-only word count under threshold (frontmatter + heading-only lines stripped). Default 5.',
      inputSchema: { maxBodyWords: z.number().int().nonnegative().max(100).optional() },
    },
    async ({ maxBodyWords }) => {
      try { return payload({ notes: await fsops.findEmptyNotes(vaultDir, maxBodyWords ?? 5) }); }
      catch (e) { return errPayload((e as Error).message); }
    },
  );

  server.registerTool(
    'vaultnexus_find_notes_without_frontmatter',
    { description: 'Notes that lack any leading --- frontmatter block.' },
    async () => {
      try { return payload({ notes: await fsops.findNotesWithoutFrontmatter(vaultDir) }); }
      catch (e) { return errPayload((e as Error).message); }
    },
  );

  server.registerTool(
    'vaultnexus_find_notes_with_property',
    {
      description: 'Notes whose frontmatter contains the given key (any value). Returns notePath + value.',
      inputSchema: { key: z.string().regex(/^[A-Za-z_][\w-]*$/) },
    },
    async ({ key }) => {
      try { return payload({ notes: await fsops.findNotesWithProperty(vaultDir, key) }); }
      catch (e) { return errPayload((e as Error).message); }
    },
  );

  server.registerTool(
    'vaultnexus_wikilink_audit',
    { description: 'Vault-wide wikilink resolution audit. Returns counts + unresolved [{from, target}] + per-target reference counts.' },
    async () => payload(await fsops.wikilinkAudit(index.linkMap())),
  );

  server.registerTool(
    'vaultnexus_archive_note',
    {
      description: 'Move a note into an Archive folder + add archived: <date> to its frontmatter. Re-indexes.',
      inputSchema: { notePath: z.string(), archiveFolder: z.string().optional() },
    },
    async ({ notePath, archiveFolder }) => {
      try {
        const r = await fsops.archiveNote(vaultDir, notePath, { archiveFolder });
        await deps.onNoteRemoved?.(notePath);
        await deps.onNoteChanged?.(r.to);
        return payload(r);
      } catch (e) { return errPayload((e as Error).message); }
    },
  );

  server.registerTool(
    'vaultnexus_prune_empty_folders',
    {
      description: 'Recursively rmdir empty folders under root. Skips dotfolders + the root itself.',
      inputSchema: { root: z.string().optional() },
    },
    async ({ root }) => {
      try { return payload(await fsops.pruneEmptyFolders(vaultDir, root ?? '')); }
      catch (e) { return errPayload((e as Error).message); }
    },
  );

  server.registerTool(
    'vaultnexus_token_count',
    {
      description: 'BPE token count (gpt-tokenizer) for a note. Useful for context-window planning.',
      inputSchema: { notePath: z.string() },
    },
    async ({ notePath }) => {
      try { return payload(await fsops.tokenCount(vaultDir, notePath)); }
      catch (e) { return errPayload((e as Error).message); }
    },
  );

  server.registerTool(
    'vaultnexus_extract_links',
    {
      description: 'Pull every link from a note — wikilinks [[X]], embeds ![[X]], markdown [text](url). Unique-deduped wikilinks/embeds; markdown links keep duplicates.',
      inputSchema: { notePath: z.string() },
    },
    async ({ notePath }) => {
      try { return payload(await fsops.extractLinks(vaultDir, notePath)); }
      catch (e) { return errPayload((e as Error).message); }
    },
  );

  server.registerTool(
    'vaultnexus_extract_tables',
    {
      description: 'Extract every markdown table from a note. Returns [{startLine, rows: string[][]}]. Skip the separator row.',
      inputSchema: { notePath: z.string() },
    },
    async ({ notePath }) => {
      try { return payload(await fsops.extractTables(vaultDir, notePath)); }
      catch (e) { return errPayload((e as Error).message); }
    },
  );

  server.registerTool(
    'vaultnexus_extract_quotes',
    {
      description: 'Pull every blockquote (lines starting with >) from a note. Returns [{startLine, text}].',
      inputSchema: { notePath: z.string() },
    },
    async ({ notePath }) => {
      try { return payload(await fsops.extractQuotes(vaultDir, notePath)); }
      catch (e) { return errPayload((e as Error).message); }
    },
  );

  server.registerTool(
    'vaultnexus_convert_links',
    {
      description: 'Convert link syntax inside a note. mode=wiki-to-md → [[X]] becomes [X](X.md); md-to-wiki → [text](path.md) becomes [[path|text]]. Re-indexes.',
      inputSchema: { notePath: z.string(), mode: z.enum(['wiki-to-md', 'md-to-wiki']) },
    },
    async ({ notePath, mode }) => {
      try {
        const r = await fsops.convertLinks(vaultDir, notePath, mode);
        if (r.replacements > 0) await deps.onNoteChanged?.(notePath);
        return payload(r);
      } catch (e) { return errPayload((e as Error).message); }
    },
  );

  server.registerTool(
    'vaultnexus_render_toc',
    {
      description: "Render a note's outline as a markdown table-of-contents string w/ anchor links.",
      inputSchema: { notePath: z.string(), maxDepth: z.number().int().positive().max(6).optional() },
    },
    async ({ notePath, maxDepth }) => {
      try { return payload(await fsops.renderToc(vaultDir, notePath, { maxDepth })); }
      catch (e) { return errPayload((e as Error).message); }
    },
  );

  server.registerTool(
    'vaultnexus_find_by_size',
    {
      description: 'Find files in a byte-size band. Returns paths sorted largest first.',
      inputSchema: { minBytes: z.number().int().nonnegative(), maxBytes: z.number().int().positive(), folderPath: z.string().optional() },
    },
    async ({ minBytes, maxBytes, folderPath }) => {
      try { return payload({ files: await fsops.findBySizeRange(vaultDir, minBytes, maxBytes, folderPath ?? '') }); }
      catch (e) { return errPayload((e as Error).message); }
    },
  );

  server.registerTool(
    'vaultnexus_find_todos',
    {
      description: 'Find TODO / FIXME / NOTE / HACK / XXX markers (configurable) across the vault.',
      inputSchema: {
        markers: z.array(z.string().min(1).max(40)).max(20).optional(),
        pathPrefix: z.string().optional(),
        limit: z.number().int().positive().max(1000).optional(),
      },
    },
    async ({ markers, pathPrefix, limit }) => {
      try { return payload({ todos: await fsops.findTodos(vaultDir, { markers, pathPrefix, limit }) }); }
      catch (e) { return errPayload((e as Error).message); }
    },
  );

  server.registerTool(
    'vaultnexus_find_unreferenced_attachments',
    { description: 'Attachments (non-md files) that no note references via wikilink/embed/markdown link.' },
    async () => {
      try { return payload({ unreferenced: await fsops.findUnreferencedAttachments(vaultDir) }); }
      catch (e) { return errPayload((e as Error).message); }
    },
  );

  server.registerTool(
    'vaultnexus_bulk_frontmatter',
    {
      description: 'Fetch frontmatter for N notes in one call. Per-note error surfaced inline; never aborts the batch.',
      inputSchema: { notePaths: z.array(z.string()).min(1).max(200) },
    },
    async ({ notePaths }) => {
      try { return payload({ results: await fsops.bulkFrontmatter(vaultDir, notePaths) }); }
      catch (e) { return errPayload((e as Error).message); }
    },
  );

  server.registerTool(
    'vaultnexus_index_export',
    { description: 'Vault-wide link + tag map dump → JSON snapshot for downstream tooling.' },
    async () => {
      try { return payload(await fsops.vaultIndexExport(vaultDir, index.linkMap())); }
      catch (e) { return errPayload((e as Error).message); }
    },
  );

  server.registerTool(
    'vaultnexus_split_note',
    {
      description: 'Split a note at every level-N heading → one new note per section in a folder. Optionally remove the original (soft-delete).',
      inputSchema: { notePath: z.string(), atDepth: z.number().int().positive().max(6).optional(), outputFolder: z.string().optional(), keepOriginal: z.boolean().optional() },
    },
    async (args) => {
      try {
        const r = await fsops.splitNote(vaultDir, args.notePath, args);
        for (const c of r.created) await deps.onNoteChanged?.(c);
        if (r.removed) await deps.onNoteRemoved?.(args.notePath);
        return payload(r);
      } catch (e) { return errPayload((e as Error).message); }
    },
  );

  server.registerTool(
    'vaultnexus_merge_notes',
    {
      description: 'Concat N source notes into one target note. Optional deleteSources (soft → .trash). Re-indexes target + sources.',
      inputSchema: { sourcePaths: z.array(z.string()).min(1).max(100), targetPath: z.string(), separator: z.string().optional(), deleteSources: z.boolean().optional() },
    },
    async (args) => {
      try {
        const r = await fsops.mergeNotes(vaultDir, args.sourcePaths, args.targetPath, args);
        await deps.onNoteChanged?.(args.targetPath);
        for (const sp of r.mergedFrom) if (args.deleteSources && sp !== args.targetPath) await deps.onNoteRemoved?.(sp);
        return payload(r);
      } catch (e) { return errPayload((e as Error).message); }
    },
  );

  server.registerTool(
    'vaultnexus_find_by_extension',
    {
      description: 'Find files under the vault by extension(s). e.g. ["canvas","pdf"]. Returns paths + sizes + ext.',
      inputSchema: { exts: z.array(z.string().min(1)).min(1).max(20), folderPath: z.string().optional() },
    },
    async ({ exts, folderPath }) => {
      try { return payload({ files: await fsops.findByExtension(vaultDir, exts, folderPath ?? '') }); }
      catch (e) { return errPayload((e as Error).message); }
    },
  );

  server.registerTool(
    'vaultnexus_block_ids',
    {
      description: 'List every Obsidian block id (^id) in a note, w/ line number.',
      inputSchema: { notePath: z.string() },
    },
    async ({ notePath }) => {
      try { return payload(await fsops.blockIds(vaultDir, notePath)); }
      catch (e) { return errPayload((e as Error).message); }
    },
  );

  server.registerTool(
    'vaultnexus_bulk_rename',
    {
      description: 'Apply multiple rename/move pairs in one call. Returns per-pair status; failures do not abort the batch.',
      inputSchema: { renames: z.array(z.object({ from: z.string(), to: z.string() })).min(1).max(200) },
    },
    async ({ renames }) => {
      try {
        const r = await fsops.bulkRename(vaultDir, renames);
        for (const item of r) {
          if (!item.ok) continue;
          await deps.onNoteRemoved?.(item.from);
          if (item.to.toLowerCase().endsWith('.md')) await deps.onNoteChanged?.(item.to);
        }
        return payload({ results: r });
      } catch (e) { return errPayload((e as Error).message); }
    },
  );

  server.registerTool(
    'vaultnexus_find_long_lines',
    {
      description: 'Notes containing at least one line longer than minLineLen chars. Sorted longest-line first.',
      inputSchema: { minLineLen: z.number().int().positive().max(100_000), limit: z.number().int().positive().max(500).optional() },
    },
    async ({ minLineLen, limit }) => {
      try { return payload({ notes: await fsops.findLongLines(vaultDir, minLineLen, limit ?? 50) }); }
      catch (e) { return errPayload((e as Error).message); }
    },
  );

  server.registerTool(
    'vaultnexus_link_counts',
    {
      description: 'Outbound wikilink counts per note. Most-linking first.',
      inputSchema: { limit: z.number().int().positive().max(500).optional() },
    },
    async ({ limit }) => payload({ counts: linkCountsPerNote(index.linkMap()).slice(0, limit ?? 50) }),
  );

  server.registerTool(
    'vaultnexus_inbound_ranking',
    {
      description: 'Notes ranked by inbound wikilink count. Most-linked first.',
      inputSchema: { limit: z.number().int().positive().max(500).optional() },
    },
    async ({ limit }) => payload({ ranking: inboundRanking(index.linkMap()).slice(0, limit ?? 50) }),
  );

  server.registerTool(
    'vaultnexus_communities',
    {
      description: 'List Louvain communities + member counts (semantic clustering via the wikilink graph).',
    },
    async () => {
      const { buildNoteGraph, detectCommunities } = await import('./note-graph.js');
      const notes = [...index.linkMap().entries()].map(([path, links]) => ({ path, links }));
      const graph = buildNoteGraph(notes);
      const comm = detectCommunities(graph);
      const counts = new Map<number, number>();
      for (const c of comm.values()) counts.set(c, (counts.get(c) ?? 0) + 1);
      const out = [...counts.entries()]
        .map(([id, size]) => ({ communityId: id, size }))
        .sort((a, b) => b.size - a.size);
      return payload({ communities: out, total: out.length });
    },
  );

  server.registerTool(
    'vaultnexus_freshness_report',
    {
      description: 'Combined freshness snapshot: most-recently-changed N + most-stale N, single call.',
      inputSchema: { limit: z.number().int().positive().max(100).optional() },
    },
    async ({ limit }) => {
      const cap = limit ?? 10;
      const recent = await fsops.notesSince(vaultDir, 0, cap);
      const stale = await fsops.staleNotes(vaultDir, 0, cap);
      return payload({ recent, stale: stale.slice(0, cap) });
    },
  );

  server.registerTool(
    'vaultnexus_excerpt',
    {
      description: 'First N lines or N bytes of a note. Token-efficient peek before a full read.',
      inputSchema: { notePath: z.string(), lines: z.number().int().positive().max(500).optional(), bytes: z.number().int().positive().max(50_000).optional() },
    },
    async ({ notePath, lines, bytes }) => {
      try { return payload(await fsops.excerpt(vaultDir, notePath, { lines, bytes })); }
      catch (e) { return errPayload((e as Error).message); }
    },
  );

  server.registerTool(
    'vaultnexus_random_note',
    {
      description: 'Pick N random note paths from the indexed set (daily-review style).',
      inputSchema: { n: z.number().int().positive().max(50).optional() },
    },
    async ({ n }) => payload({ notes: fsops.randomNotes(index.notePaths(), n ?? 1) }),
  );

  server.registerTool(
    'vaultnexus_recent_changes',
    {
      description: 'Notes modified since a unix-ms timestamp. Sorted newest first.',
      inputSchema: { sinceMs: z.number().int().nonnegative(), limit: z.number().int().positive().max(500).optional() },
    },
    async ({ sinceMs, limit }) => {
      try { return payload({ notes: await fsops.notesSince(vaultDir, sinceMs, limit ?? 50) }); }
      catch (e) { return errPayload((e as Error).message); }
    },
  );

  server.registerTool(
    'vaultnexus_stale_notes',
    {
      description: 'Notes unchanged for at least ageDays. Oldest first.',
      inputSchema: { ageDays: z.number().positive().max(3650), limit: z.number().int().positive().max(500).optional() },
    },
    async ({ ageDays, limit }) => {
      try { return payload({ notes: await fsops.staleNotes(vaultDir, ageDays, limit ?? 50) }); }
      catch (e) { return errPayload((e as Error).message); }
    },
  );

  server.registerTool(
    'vaultnexus_size_breakdown',
    {
      description: 'Per-folder note count + byte total under root (one level deep).',
      inputSchema: { root: z.string().optional() },
    },
    async ({ root }) => {
      try { return payload(await fsops.sizeBreakdown(vaultDir, root ?? '')); }
      catch (e) { return errPayload((e as Error).message); }
    },
  );

  server.registerTool(
    'vaultnexus_wikilink_completions',
    {
      description: 'Autocomplete: indexed notes whose path or basename starts w/ prefix.',
      inputSchema: { prefix: z.string().min(1), limit: z.number().int().positive().max(100).optional() },
    },
    async ({ prefix, limit }) => payload({ completions: fsops.wikilinkCompletions(index.notePaths(), prefix, limit ?? 20) }),
  );

  server.registerTool(
    'vaultnexus_replace_lines',
    {
      description: 'Replace lines [startLine..endLine] in a note (1-indexed, inclusive). newText may contain newlines; file line count adjusts accordingly. Re-indexes.',
      inputSchema: { notePath: z.string(), startLine: z.number().int().positive(), endLine: z.number().int().positive(), newText: z.string() },
    },
    async ({ notePath, startLine, endLine, newText }) => {
      try {
        const r = await fsops.replaceLines(vaultDir, notePath, startLine, endLine, newText);
        await deps.onNoteChanged?.(notePath);
        return payload(r);
      } catch (e) { return errPayload((e as Error).message); }
    },
  );

  server.registerTool(
    'vaultnexus_unlinked_mentions',
    {
      description: 'Plain-text mentions of indexed note titles that are NOT wikilinked. Suggests link upgrades.',
      inputSchema: { limit: z.number().int().positive().max(1000).optional() },
    },
    async ({ limit }) => {
      try {
        const out = await unlinkedMentions(vaultDir, index.notePaths(), async (abs) => (await readFile(abs)).toString('utf8'), limit ?? 200);
        return payload({ mentions: out });
      } catch (e) { return errPayload((e as Error).message); }
    },
  );

  server.registerTool(
    'vaultnexus_find_long_notes',
    {
      description: 'Notes whose word count exceeds minWords. Sorted longest first.',
      inputSchema: { minWords: z.number().int().nonnegative().optional(), limit: z.number().int().positive().max(500).optional() },
    },
    async ({ minWords, limit }) => {
      const cutoff = minWords ?? 1000;
      const cap = limit ?? 50;
      const out: Array<{ notePath: string; words: number }> = [];
      for (const np of index.notePaths()) {
        try {
          const wc = await fsops.wordCount(vaultDir, np);
          if (wc.words >= cutoff) out.push({ notePath: np, words: wc.words });
        } catch { /* skip */ }
      }
      out.sort((a, b) => b.words - a.words);
      return payload({ notes: out.slice(0, cap) });
    },
  );

  server.registerTool(
    'vaultnexus_dedupe_candidates',
    {
      description: 'Near-duplicate chunk pairs across notes via cosine similarity > minSimilarity. Powered by the bridges algorithm but tuned for dedup (high similarity, no community filter).',
      inputSchema: { minSimilarity: z.number().min(0.5).max(1).optional(), topN: z.number().int().positive().max(200).optional() },
    },
    async ({ minSimilarity, topN }) => {
      const pairs = index.bridges(topN ?? 50, minSimilarity ?? 0.92, false);
      const out = pairs.map((b) => ({
        a: b.a.notePath, b: b.b.notePath, similarity: b.similarity,
        aText: b.a.text.slice(0, 200), bText: b.b.text.slice(0, 200),
      }));
      return payload({ duplicates: out });
    },
  );

  server.registerTool(
    'vaultnexus_prepend_to_page',
    {
      description: 'Prepend text to the top of a note (above existing content). Re-indexes.',
      inputSchema: { notePath: z.string(), text: z.string() },
    },
    async ({ notePath, text }) => {
      try {
        const r = await fsops.prependToPage(vaultDir, notePath, text);
        await deps.onNoteChanged?.(notePath);
        return payload(r);
      } catch (e) { return errPayload((e as Error).message); }
    },
  );

  server.registerTool(
    'vaultnexus_extract_code',
    {
      description: 'Extract every fenced ``` codeblock from a note. Returns [{lang, code, startLine}].',
      inputSchema: { notePath: z.string() },
    },
    async ({ notePath }) => {
      try { return payload(await fsops.extractCode(vaultDir, notePath)); }
      catch (e) { return errPayload((e as Error).message); }
    },
  );

  server.registerTool(
    'vaultnexus_note_meta',
    {
      description: 'One-call snapshot: frontmatter + headings + tags-in-note + word count + inbound/outbound links. Token-efficient combined read.',
      inputSchema: { notePath: z.string() },
    },
    async ({ notePath }) => {
      try {
        const [fm, wc, page] = await Promise.all([
          fsops.getFrontmatter(vaultDir, notePath).catch(() => ({ frontmatter: {} })),
          fsops.wordCount(vaultDir, notePath),
          fsops.readPage(vaultDir, notePath),
        ]);
        const headings = outlineFromSource(page.text);
        const tags = [...new Set([...page.text.matchAll(/(?:^|\s)#([A-Za-z0-9][\w/-]*)/gm)].map((m) => m[1]))];
        const links = linkGraph(index.linkMap(), notePath);
        return payload({
          notePath,
          frontmatter: (fm as { frontmatter: unknown }).frontmatter,
          words: wc.words, chars: wc.chars, lines: wc.lines, bytes: wc.bytes,
          headings, tags, inboundLinks: links.inbound, outboundLinks: links.outbound,
        });
      } catch (e) { return errPayload((e as Error).message); }
    },
  );

  server.registerTool(
    'vaultnexus_replace_wikilink_target',
    {
      description: 'Rename every [[oldTarget]] / [[oldTarget|alias]] / [[oldTarget#anchor]] wikilink across the vault → newTarget. Re-indexes every touched note.',
      inputSchema: { oldTarget: z.string().min(1), newTarget: z.string().min(1) },
    },
    async ({ oldTarget, newTarget }) => {
      try {
        const r = await fsops.replaceWikilinkTarget(vaultDir, oldTarget, newTarget);
        for (const t of r.touched) await deps.onNoteChanged?.(t.notePath);
        return payload(r);
      } catch (e) { return errPayload((e as Error).message); }
    },
  );

  server.registerTool(
    'vaultnexus_restore_trashed',
    {
      description: 'Restore a soft-deleted note from <vault>/.trash/ back to its original path. Picks the latest trash entry. Re-indexes.',
      inputSchema: { notePath: z.string() },
    },
    async ({ notePath }) => {
      try {
        const r = await fsops.restoreTrashed(vaultDir, notePath);
        await deps.onNoteChanged?.(notePath);
        return payload(r);
      } catch (e) { return errPayload((e as Error).message); }
    },
  );

  server.registerTool(
    'vaultnexus_cleanup_trash',
    { description: 'Permanently delete every note in <vault>/.trash/. Returns counts.' },
    async () => {
      try { return payload(await fsops.cleanupTrash(vaultDir)); }
      catch (e) { return errPayload((e as Error).message); }
    },
  );

  server.registerTool(
    'vaultnexus_search_in_note',
    {
      description: 'Semantic search restricted to chunks of one note. Useful for navigating long notes.',
      inputSchema: { notePath: z.string(), query: z.string().min(1), k: z.number().int().positive().optional() },
    },
    async ({ notePath, query, k }) => {
      const all = await index.query(query, (k ?? 5) * 4);
      const filtered = all.filter((h) => h.notePath === notePath).slice(0, k ?? 5);
      return payload({ notePath, query, hits: filtered });
    },
  );

  server.registerTool(
    'vaultnexus_export_bundle',
    {
      description: 'Concat several notes into one markdown bundle. Each is prefaced w/ # notePath; separator between.',
      inputSchema: {
        notePaths: z.array(z.string()).min(1).max(200),
        separator: z.string().optional(),
      },
    },
    async ({ notePaths, separator }) => {
      try { return payload(await fsops.exportBundle(vaultDir, notePaths, { separator })); }
      catch (e) { return errPayload((e as Error).message); }
    },
  );

  server.registerTool(
    'vaultnexus_tag_notes',
    {
      description: 'Append a #tag to the body of every named note (skips ones that already contain the exact tag). Re-indexes.',
      inputSchema: { tag: z.string().regex(/^[A-Za-z0-9][\w/-]*$/), notePaths: z.array(z.string()).min(1).max(200) },
    },
    async ({ tag, notePaths }) => {
      const touched: string[] = [];
      const re = new RegExp(`(?:^|\\s)#${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`, 'm');
      for (const np of notePaths) {
        try {
          const { text } = await fsops.readPage(vaultDir, np);
          if (re.test(text)) continue;
          await fsops.appendToPage(vaultDir, np, `\n\n#${tag}\n`);
          await deps.onNoteChanged?.(np);
          touched.push(np);
        } catch { /* skip missing */ }
      }
      return payload({ tag, tagged: touched });
    },
  );

  server.registerTool(
    'vaultnexus_vault_doctor',
    {
      description: 'Vault hygiene scan: counts notes/chunks, lists orphans, broken-link count, top tag, average words. Single-call summary.',
    },
    async () => {
      const notes = index.notePaths();
      const orphans = (await import('./vault-analytics.js')).orphanNotes(index.linkMap());
      const broken = (await import('./vault-analytics.js')).brokenLinks(index.linkMap());
      const tags = await (await import('./vault-analytics.js')).tagCounts(vaultDir, async (abs) => (await readFile(abs)).toString('utf8'));
      let totalWords = 0;
      for (const np of notes.slice(0, 200)) {
        try { totalWords += (await fsops.wordCount(vaultDir, np)).words; } catch { /* skip */ }
      }
      return payload({
        notes: notes.length,
        chunks: index.size,
        orphans: orphans.length,
        brokenLinks: broken.length,
        topTag: tags[0] ?? null,
        sampledNotes: Math.min(notes.length, 200),
        avgWordsSampled: notes.length > 0 ? Math.round(totalWords / Math.min(notes.length, 200)) : 0,
      });
    },
  );

  server.registerTool(
    'vaultnexus_grep',
    {
      description: 'Plain-text or regex search across notes w/ line numbers + optional pre/post context. Complements vaultnexus_search (semantic).',
      inputSchema: {
        pattern: z.string().min(1),
        regex: z.boolean().optional(),
        ignoreCase: z.boolean().optional(),
        context: z.number().int().nonnegative().max(5).optional(),
        pathPrefix: z.string().optional(),
        maxHits: z.number().int().positive().max(1000).optional(),
      },
    },
    async (args) => {
      try { return payload(await fsops.grepVault(vaultDir, args.pattern, args)); }
      catch (e) { return errPayload((e as Error).message); }
    },
  );

  server.registerTool(
    'vaultnexus_word_count',
    {
      description: 'Word / character / line / byte count for a note.',
      inputSchema: { notePath: z.string() },
    },
    async ({ notePath }) => {
      try { return payload(await fsops.wordCount(vaultDir, notePath)); }
      catch (e) { return errPayload((e as Error).message); }
    },
  );

  server.registerTool(
    'vaultnexus_list_attachments',
    {
      description: 'Recursively list non-markdown files (images, PDFs, etc.) under a vault folder. Path + bytes + extension.',
      inputSchema: { folderPath: z.string().optional() },
    },
    async ({ folderPath }) => {
      try { return payload(await fsops.listAttachments(vaultDir, folderPath ?? '')); }
      catch (e) { return errPayload((e as Error).message); }
    },
  );

  server.registerTool(
    'vaultnexus_get_frontmatter',
    {
      description: 'Parse + return the leading YAML frontmatter as JSON.',
      inputSchema: { notePath: z.string() },
    },
    async ({ notePath }) => {
      try { return payload(await fsops.getFrontmatter(vaultDir, notePath)); }
      catch (e) { return errPayload((e as Error).message); }
    },
  );

  server.registerTool(
    'vaultnexus_set_frontmatter',
    {
      description: 'Replace (or insert) the leading YAML frontmatter block. Preserves the body. Re-indexes the note.',
      inputSchema: { notePath: z.string(), frontmatter: z.record(z.string(), z.any()) },
    },
    async ({ notePath, frontmatter }) => {
      try {
        const r = await fsops.setFrontmatter(vaultDir, notePath, frontmatter as Record<string, unknown>);
        await deps.onNoteChanged?.(notePath);
        return payload(r);
      } catch (e) { return errPayload((e as Error).message); }
    },
  );

  server.registerTool(
    'vaultnexus_append_to_periodic',
    {
      description: 'Append text to a periodic note (daily/weekly/monthly/yearly). Creates the note if missing. Re-indexes.',
      inputSchema: {
        period: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
        text: z.string(),
        date: z.string().optional(),
        folder: z.string().optional(),
        template: z.string().optional(),
      },
    },
    async (args) => {
      try {
        const r = await fsops.appendToPeriodic(vaultDir, args.period, args.text, args);
        await deps.onNoteChanged?.(r.notePath);
        return payload(r);
      } catch (e) { return errPayload((e as Error).message); }
    },
  );

  server.registerTool(
    'vaultnexus_diff_notes',
    {
      description: 'Line-level diff between two notes. Token-efficient — caps at 200 changed lines each side.',
      inputSchema: { a: z.string(), b: z.string() },
    },
    async ({ a, b }) => {
      try { return payload(await fsops.diffNotes(vaultDir, a, b)); }
      catch (e) { return errPayload((e as Error).message); }
    },
  );

  server.registerTool(
    'vaultnexus_query_frontmatter',
    {
      description: 'Find notes whose frontmatter satisfies key=value filters (string equality, or `_in` for membership). Lightweight Dataview substitute.',
      inputSchema: {
        filter: z.record(z.string(), z.any()),
        limit: z.number().int().positive().max(500).optional(),
      },
    },
    async ({ filter, limit }) => {
      const matches: Array<{ notePath: string; frontmatter: Record<string, unknown> }> = [];
      const want = limit ?? 100;
      for (const np of index.notePaths()) {
        try {
          const { frontmatter } = await fsops.getFrontmatter(vaultDir, np);
          let ok = true;
          for (const [k, want] of Object.entries(filter ?? {})) {
            const got = frontmatter[k];
            if (Array.isArray(want)) { if (!want.includes(got as never)) { ok = false; break; } }
            else if (got !== want) { ok = false; break; }
          }
          if (ok) matches.push({ notePath: np, frontmatter });
          if (matches.length >= want) break;
        } catch { /* skip un-readable */ }
      }
      return payload({ matches });
    },
  );

  server.registerTool(
    'vaultnexus_list_bookmarks',
    {
      description: 'Read .obsidian/bookmarks.json → flat list of bookmarked notes + headings. Empty when no bookmarks file.',
    },
    async () => {
      try {
        const { readFile } = await import('node:fs/promises');
        const { join: pjoin } = await import('node:path');
        const raw = await readFile(pjoin(vaultDir, '.obsidian', 'bookmarks.json'), 'utf8');
        const data = JSON.parse(raw) as { items?: Array<{ type?: string; path?: string; subpath?: string; title?: string }> };
        const flat: Array<{ type: string; path: string; subpath: string; title: string }> = [];
        const walk = (items: Array<{ type?: string; path?: string; subpath?: string; title?: string; items?: unknown[] }>): void => {
          for (const it of items) {
            if (it.type === 'group' && Array.isArray((it as { items?: unknown[] }).items)) {
              walk((it as { items: Array<{ type?: string; path?: string; subpath?: string; title?: string }> }).items);
            } else if (it.path) {
              flat.push({ type: it.type ?? '?', path: it.path, subpath: it.subpath ?? '', title: it.title ?? '' });
            }
          }
        };
        walk(data.items ?? []);
        return payload({ bookmarks: flat });
      } catch (e) {
        // Missing bookmarks file → empty list, not error.
        if ((e as { code?: string }).code === 'ENOENT') return payload({ bookmarks: [] });
        return errPayload((e as Error).message);
      }
    },
  );

  server.registerTool(
    'vaultnexus_execute_template',
    {
      description: 'Apply a Templater-style template (.md file in vault) → new note. Substitutes {{date}}, {{time}}, {{title}}, and any user-supplied variables.',
      inputSchema: {
        templatePath: z.string(),
        targetPath: z.string(),
        title: z.string().optional(),
        variables: z.record(z.string(), z.string()).optional(),
      },
    },
    async ({ templatePath, targetPath, title, variables }) => {
      try {
        const { text: tmpl } = await fsops.readPage(vaultDir, templatePath);
        const now = new Date();
        const yyyy = now.getUTCFullYear();
        const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(now.getUTCDate()).padStart(2, '0');
        const hh = String(now.getUTCHours()).padStart(2, '0');
        const min = String(now.getUTCMinutes()).padStart(2, '0');
        const built: Record<string, string> = {
          date: `${yyyy}-${mm}-${dd}`,
          time: `${hh}:${min}`,
          title: title ?? targetPath.replace(/\.md$/i, '').split('/').pop() ?? '',
          ...(variables ?? {}),
        };
        // Replace {{var}} literally; no eval, no JS execution. Simple Templater compat surface.
        const filled = tmpl.replace(/\{\{\s*([a-zA-Z_][\w-]*)\s*\}\}/g, (m, k: string) =>
          built[k] !== undefined ? built[k] : m,
        );
        const r = await fsops.createPage(vaultDir, targetPath, filled);
        await deps.onNoteChanged?.(targetPath);
        return payload({ ...r, templatePath, substitutions: Object.keys(built).length });
      } catch (e) { return errPayload((e as Error).message); }
    },
  );

  server.registerTool(
    'vaultnexus_fetch_url',
    {
      description: 'HTTP GET a URL → response text. Blocks private/localhost/cloud-metadata IPs on every hop (no SSRF). Streams body w/ a hard byte cap (default 200KB).',
      inputSchema: { url: z.string().regex(/^https?:\/\//), maxBytes: z.number().int().positive().max(5_000_000).optional() },
    },
    async ({ url, maxBytes }) => {
      try {
        // Block private + loopback + link-local + cloud-metadata literals upfront.
        const isPrivateUrl = (u: string): boolean => {
          try {
            const host = new URL(u).hostname.toLowerCase();
            if (host === 'localhost' || host === '0.0.0.0' || host === '::' || host === '::1') return true;
            if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return true;
            if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return true;
            if (host === 'metadata.google.internal' || host === 'metadata' || host === '169.254.169.254') return true;
            if (host.startsWith('fc') || host.startsWith('fd')) return true; // fc00::/7
            return false;
          } catch { return true; }
        };
        if (isPrivateUrl(url)) return errPayload('blocked: private/loopback/metadata target');
        // Manual redirects → re-check each hop.
        let current = url;
        let r: Response | undefined;
        for (let i = 0; i < 5; i += 1) {
          r = await fetch(current, { headers: { 'user-agent': 'vaultnexus/0.1' }, redirect: 'manual' });
          const loc = r.headers.get('location');
          if (r.status >= 300 && r.status < 400 && loc) {
            const next = new URL(loc, current).toString();
            if (isPrivateUrl(next)) return errPayload(`blocked: redirect to private target ${new URL(next).hostname}`);
            current = next;
            continue;
          }
          break;
        }
        if (!r) return errPayload('no response');
        if (!r.ok) return errPayload(`HTTP ${r.status}`);
        // Streaming byte cap → never buffer more than `cap` bytes regardless of Content-Length.
        const cap = maxBytes ?? 200_000;
        const reader = r.body?.getReader();
        if (!reader) return errPayload('no body');
        const chunks: Uint8Array[] = [];
        let total = 0;
        let truncated = false;
        while (total < cap) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          total += value.length;
        }
        if (total >= cap) { truncated = true; await reader.cancel().catch(() => undefined); }
        const buf = new Uint8Array(total);
        let off = 0; for (const c of chunks) { buf.set(c.subarray(0, Math.min(c.length, cap - off)), off); off += c.length; if (off >= cap) break; }
        let text = new TextDecoder('utf-8').decode(buf.subarray(0, Math.min(total, cap)));
        if (truncated) text += '\n\n... (truncated)';
        return payload({ url: current, status: r.status, contentType: r.headers.get('content-type') ?? '', returnedBytes: Math.min(total, cap), truncated, text });
      } catch (e) { return errPayload((e as Error).message); }
    },
  );

  server.registerTool(
    'vaultnexus_daily_note',
    {
      description: 'Get or create a daily note in YYYY-MM-DD.md format. Defaults to today. Returns existing content if file exists, otherwise creates it w/ optional template.',
      inputSchema: {
        date: z.string().optional(),
        folder: z.string().optional(),
        template: z.string().optional(),
      },
    },
    async ({ date, folder, template }) => {
      const today = new Date();
      const yyyy = today.getUTCFullYear();
      const mm = String(today.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(today.getUTCDate()).padStart(2, '0');
      const d = date ?? `${yyyy}-${mm}-${dd}`;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return errPayload(`bad date format: ${d} (expected YYYY-MM-DD)`);
      const notePath = (folder ? `${folder.replace(/\/$/, '')}/` : '') + `${d}.md`;
      try {
        // Already exists → just return it
        const r = await fsops.readPage(vaultDir, notePath);
        return payload({ ...r, created: false });
      } catch {
        // Missing → create
        const initial = template ?? `# ${d}\n\n`;
        const r = await fsops.createPage(vaultDir, notePath, initial);
        await deps.onNoteChanged?.(notePath);
        return payload({ ...r, created: true, text: initial });
      }
    },
  );

  server.registerTool(
    'vaultnexus_copy_page',
    {
      description: 'Duplicate a note to a new path. Refuses overwrite unless overwrite=true.',
      inputSchema: { from: z.string(), to: z.string(), overwrite: z.boolean().optional() },
    },
    async ({ from, to, overwrite }) => {
      try {
        const r = await fsops.copyPage(vaultDir, from, to, { overwrite });
        await deps.onNoteChanged?.(to);
        return payload(r);
      } catch (e) { return errPayload((e as Error).message); }
    },
  );

  return server;
}
