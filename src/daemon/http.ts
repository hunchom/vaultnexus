import { Hono } from 'hono';
import { health } from '../core/health.js';

/** Loopback HTTP surface (the future Obsidian-plugin path). */
export function createHttpApp(): Hono {
  const app = new Hono();
  app.get('/health', (c) => c.json(health()));
  return app;
}
