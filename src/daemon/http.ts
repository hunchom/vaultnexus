import { Hono } from 'hono';
import { z } from 'zod';
import { health } from '../core/health.js';
import type { VaultIndex } from './vault-index.js';

export interface HttpAppDeps { index?: VaultIndex; }

// Body schemas mirror MCP tool surface → keep client surfaces aligned.
const searchBody = z.object({
  query: z.string().min(1),
  k: z.number().int().positive().optional(),
});
const bridgesBody = z.object({
  topN: z.number().int().positive().optional(),
  minSimilarity: z.number().optional(),
  crossCommunityOnly: z.boolean().optional(),
});

/** Loopback HTTP surface for the Obsidian plugin. /health always; /search + /bridges when index injected. */
export function createHttpApp(deps: HttpAppDeps = {}): Hono {
  const app = new Hono();
  app.get('/health', (c) => c.json(health()));

  // POST /search { query, k? } → SearchHit[]
  app.post('/search', async (c) => {
    if (!deps.index) return c.json({ error: 'no index' }, 503);
    const raw = await c.req.json().catch(() => null);
    const parsed = searchBody.safeParse(raw);
    if (!parsed.success) return c.json({ error: 'bad request', issues: parsed.error.issues }, 400);
    const hits = await deps.index.query(parsed.data.query, parsed.data.k ?? 10);
    return c.json(hits);
  });

  // POST /bridges { topN?, minSimilarity?, crossCommunityOnly? } → Bridge[]
  app.post('/bridges', async (c) => {
    if (!deps.index) return c.json({ error: 'no index' }, 503);
    const raw = await c.req.json().catch(() => ({}));
    const parsed = bridgesBody.safeParse(raw ?? {});
    if (!parsed.success) return c.json({ error: 'bad request', issues: parsed.error.issues }, 400);
    const { topN, minSimilarity, crossCommunityOnly } = parsed.data;
    const bridges = deps.index.bridges(topN ?? 20, minSimilarity ?? 0.5, crossCommunityOnly ?? false);
    return c.json(bridges);
  });

  return app;
}
