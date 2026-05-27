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
