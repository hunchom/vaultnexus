import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { health } from '../core/health.js';
import type { VaultIndex } from './vault-index.js';

export interface McpServerDeps { index?: VaultIndex; }

/** Build the VaultNexus MCP server. ping always; search when an index is injected. */
export function createMcpServer(deps: McpServerDeps = {}): McpServer {
  const server = new McpServer({ name: 'vaultnexus', version: health().version });

  server.registerTool(
    'vaultnexus_ping',
    { description: 'Health and version probe for the VaultNexus daemon.' },
    async () => ({ content: [{ type: 'text', text: JSON.stringify(health()) }] }),
  );

  const index = deps.index;
  if (index) {
    server.registerTool(
      'vaultnexus_search',
      {
        description: 'Semantic search over the vault. Returns cited block hits (notePath, headingPath, byte offsets, score).',
        inputSchema: { query: z.string(), k: z.number().int().positive().optional() },
      },
      async ({ query, k }) => {
        const hits = await index.query(query, k ?? 10);
        return { content: [{ type: 'text', text: JSON.stringify(hits) }] };
      },
    );

    server.registerTool(
      'vaultnexus_bridges',
      {
        description:
          'Surface chunk pairs semantically similar but in different notes (hidden connections). Each pair carries crossCommunity (different link-clusters) + linked (already wikilinked); crossCommunityOnly=true returns only cross-cluster, never-linked agreements. Suggestions, not assertions.',
        inputSchema: {
          topN: z.number().int().positive().optional(),
          minSimilarity: z.number().optional(),
          crossCommunityOnly: z.boolean().optional(),
        },
      },
      async ({ topN, minSimilarity, crossCommunityOnly }) => {
        const bridges = index.bridges(topN ?? 20, minSimilarity ?? 0.5, crossCommunityOnly ?? false);
        return { content: [{ type: 'text', text: JSON.stringify(bridges) }] };
      },
    );

    server.registerTool(
      'vaultnexus_history',
      {
        description:
          'Walk git history for a note. Returns chronological (newest first) revisions w/ sha + commitDate + message + authorEmail; optional content snapshot + user-declared frontmatter date. Backbone for belief-drift narration; no LLM compose — every revision cites a real git SHA the user can `git show`.',
        inputSchema: {
          notePath: z.string(),
          since: z.string().optional(),
          until: z.string().optional(),
          withContent: z.boolean().optional(),
          maxRevisions: z.number().int().positive().optional(),
        },
      },
      async ({ notePath, since, until, withContent, maxRevisions }) => {
        const revisions = await index.history(notePath, { since, until, withContent, maxRevisions });
        return { content: [{ type: 'text', text: JSON.stringify({ revisions }) }] };
      },
    );

    server.registerTool(
      'vaultnexus_reason',
      {
        description:
          'Cited natural-language answer over the vault. Composes via LLM on top of the citation chain (vaultnexus_trace). Every claim cites [ref:notePath:byteStart-byteEnd] from the chain; unsupported claims are dropped, never invented. Returns { answer, hops, model, invalidCitations } — invalidCitations lists raw [ref:...] markers the model produced that do not match any hop (empty array when clean).',
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
      async ({ question, maxDepth, kSeeds, knnPerHop, simThreshold, maxHops, maxTokens, temperature }) => {
        const result = await index.reason(question, {
          maxDepth, kSeeds, knnPerHop, simThreshold, maxHops, maxTokens, temperature,
        });
        return {
          content: [
            { type: 'text', text: JSON.stringify({ ...result, model: index.chatModelId() }) },
          ],
        };
      },
    );

    server.registerTool(
      'vaultnexus_recall_history',
      {
        description:
          'Cited natural-language narration of how a single note\'s stance shifted across its git timeline. Walks vaultnexus_history under the hood, then composes via LLM. Every cited revision is a real git SHA from the timeline ([sha:<7> @ <YYYY-MM-DD>]); the prompt forbids fabricated SHAs. Returns { narration, revisions, model } — model id reported for transparency. < 2 revisions → fallback narration, no LLM call.',
        inputSchema: {
          notePath: z.string(),
          since: z.string().optional(),
          until: z.string().optional(),
          maxRevisions: z.number().int().positive().optional(),
          maxTokens: z.number().int().positive().optional(),
          temperature: z.number().optional(),
        },
      },
      async ({ notePath, since, until, maxRevisions, maxTokens, temperature }) => {
        const result = await index.narrateHistory(notePath, {
          since, until, maxRevisions, maxTokens, temperature,
        });
        return {
          content: [
            { type: 'text', text: JSON.stringify({ ...result, model: index.chatModelId() }) },
          ],
        };
      },
    );

    server.registerTool(
      'vaultnexus_forecasts',
      {
        description:
          'Walk vault frontmatter forecast: { claim, by, marked_at, probability? } → ledger. Partitions into pending + resolved (notes adding resolved: { outcome, resolved_at }) and reports global Brier score across resolved. Probability defaults to 0.5 when omitted. brier = null when zero resolved forecasts. Returns { pending: Forecast[], resolved: ResolvedForecast[], brier: number|null }.',
      },
      async () => {
        const ledger = await index.forecasts();
        return { content: [{ type: 'text', text: JSON.stringify(ledger) }] };
      },
    );

    server.registerTool(
      'vaultnexus_trace',
      {
        description:
          'Reasoning backbone: ordered citation chain (seed → wikilink → knn hops) over the vault. Each hop cites notePath + byte offsets and the edge that introduced it. No LLM compose; the chain is the contract.',
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
        return { content: [{ type: 'text', text: JSON.stringify({ hops }) }] };
      },
    );
  }
  return server;
}
