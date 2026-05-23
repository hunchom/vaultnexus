import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { health } from '../core/health.js';

/** Build the VaultNexus MCP server. Plan 01 ships only the ping probe. */
export function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'vaultnexus', version: health().version });

  server.registerTool(
    'vaultnexus_ping',
    { description: 'Health and version probe for the VaultNexus daemon.' },
    async () => ({ content: [{ type: 'text', text: JSON.stringify(health()) }] }),
  );

  return server;
}
