import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { health } from '../core/health.js';
import type { VaultIndex } from './vault-index.js';
import * as fsops from './vault-fs.js';
import { outlineFromSource, tagCounts, recentNotes, orphanNotes, linkGraph, notesByTag, brokenLinks } from './vault-analytics.js';

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
      const notes = index.notePaths();
      let bytes = 0;
      let chunkBytes = 0;
      const chunks = index.size;
      for (const n of notes) {
        try {
          const r = await fsops.readPage(vaultDir, n);
          bytes += r.bytes;
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
      description: 'Rename / move a note or folder within the vault. Re-indexes (drops old path, adds new).',
      inputSchema: { from: z.string(), to: z.string() },
    },
    async ({ from, to }) => {
      try {
        const r = await fsops.renamePath(vaultDir, from, to);
        await deps.onNoteRemoved?.(from);
        if (to.toLowerCase().endsWith('.md')) await deps.onNoteChanged?.(to);
        return payload(r);
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
