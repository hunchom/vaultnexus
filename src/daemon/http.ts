import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import { health } from '../core/health.js';
import { chatConfigToEnv, selectChatModel } from './select-chat-model.js';
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
const configureChatBody = z.object({
  provider: z.enum(['fake', 'anthropic', 'openai', 'openai-compatible']),
  key: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  baseURL: z.string().regex(/^https?:\/\//, 'must start with http(s)://').optional(),
});

/** Loopback HTTP surface for the Obsidian plugin. /health always; /search + /bridges when index injected. */
export function createHttpApp(deps: HttpAppDeps = {}): Hono {
  const app = new Hono();
  // Obsidian renderer (Electron app://) + browser clients on localhost issue cross-origin → allow all.
  // Loopback-only bind keeps the surface single-host; CORS just unblocks the browser-side preflight.
  app.use('*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'OPTIONS'], allowHeaders: ['content-type'] }));
  app.get('/health', (c) => c.json(health()));

  // GET /status → richer diagnostic (index size, chat-model id) for the plugin settings tab.
  app.get('/status', (c) => {
    const idx = deps.index;
    return c.json({
      ...health(),
      indexed: idx ? idx.size : 0,
      chatModel: idx ? idx.chatModelId() : 'none',
      tools: [
        'vaultnexus_ping','vaultnexus_search','vaultnexus_bridges',
        'vaultnexus_trace','vaultnexus_reason','vaultnexus_history',
        'vaultnexus_recall_history','vaultnexus_forecasts',
      ],
    });
  });

  // POST /search { query, k? } → SearchHit[]
  app.post('/search', async (c) => {
    if (!deps.index) return c.json({ error: 'no index' }, 503);
    const raw = await c.req.json().catch(() => null);
    const parsed = searchBody.safeParse(raw);
    if (!parsed.success) return c.json({ error: 'bad request', issues: parsed.error.issues }, 400);
    const hits = await deps.index.query(parsed.data.query, parsed.data.k ?? 10);
    return c.json(hits);
  });

  // POST /configure-chat → hot-swap chat model. No daemon restart. Key never echoed back.
  app.post('/configure-chat', async (c) => {
    if (!deps.index) return c.json({ error: 'no index' }, 503);
    const raw = await c.req.json().catch(() => null);
    const parsed = configureChatBody.safeParse(raw);
    if (!parsed.success) return c.json({ error: 'bad request', issues: parsed.error.issues }, 400);
    try {
      const next = selectChatModel(chatConfigToEnv(parsed.data));
      deps.index.setChatModel(next);
      return c.json({ ok: true, chatModel: deps.index.chatModelId() });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: msg }, 400);
    }
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
