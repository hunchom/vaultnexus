import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import { health } from '../core/health.js';
import { chatConfigToEnv, selectChatModel } from './select-chat-model.js';
import type { VaultIndex } from './vault-index.js';

export interface HttpAppDeps { index?: VaultIndex; embedderId?: string; }

// Origin allowlist: Electron renderer for the Obsidian plugin + null (curl / non-browser).
// Other browser pages get a 403 from the manual middleware below — a stolen Origin header
// can't be forged by JS, so this stops the drive-by exfil class of attack.
const ORIGIN_ALLOWLIST = new Set<string>(['app://obsidian.md']);

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
  // Origin gate: refuse browser-originated requests unless the Origin is the Electron renderer.
  // Non-browser clients (curl, Claude Desktop's stdio bridge, etc.) don't send Origin → allow.
  app.use('*', async (c, next) => {
    const origin = c.req.header('origin');
    if (origin && !ORIGIN_ALLOWLIST.has(origin)) {
      return c.json({ error: 'forbidden origin' }, 403);
    }
    await next();
  });
  // CORS scoped to the Electron origin only → no more drive-by exfil from arbitrary tabs.
  app.use('*', cors({
    origin: (incoming): string | null => ORIGIN_ALLOWLIST.has(incoming) ? incoming : null,
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['content-type'],
  }));
  app.get('/health', (c) => c.json(health()));

  // GET /status → richer diagnostic (index size, chat-model id) for the plugin settings tab.
  app.get('/status', (c) => {
    const idx = deps.index;
    return c.json({
      ...health(),
      indexed: idx ? idx.size : 0,
      embedder: deps.embedderId ?? 'fake',
      chatModel: idx ? idx.chatModelId() : 'none',
      tools: [
        // retrieval
        'vaultnexus_ping','vaultnexus_search','vaultnexus_bridges','vaultnexus_neighbors',
        // reasoning
        'vaultnexus_trace','vaultnexus_reason',
        // history + forecasts
        'vaultnexus_history','vaultnexus_recall_history','vaultnexus_forecasts',
        // read
        'vaultnexus_list','vaultnexus_read_page','vaultnexus_outline',
        'vaultnexus_stats','vaultnexus_tags','vaultnexus_recent',
        'vaultnexus_orphans','vaultnexus_link_graph',
        // write
        'vaultnexus_create_page','vaultnexus_create_folder',
        'vaultnexus_append_to_page','vaultnexus_insert_after_heading','vaultnexus_replace_in_page',
        'vaultnexus_rename_heading','vaultnexus_search_replace_vault',
        'vaultnexus_delete_page','vaultnexus_delete_folder',
        'vaultnexus_move','vaultnexus_copy_page',
        // discovery + convenience
        'vaultnexus_find_by_tag','vaultnexus_broken_links',
        'vaultnexus_get_partial','vaultnexus_patch_section',
        'vaultnexus_daily_note','vaultnexus_periodic_note','vaultnexus_fetch_url',
        // obsidian-adjacent
        'vaultnexus_list_bookmarks','vaultnexus_execute_template',
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
