import { describe, it, expect } from 'vitest';
import { createHttpApp } from '../../src/daemon/http.js';
import { health } from '../../src/core/health.js';

describe('createHttpApp', () => {
  it('serves GET /health as JSON', async () => {
    const app = createHttpApp();
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(health());
  });

  it('404s unknown routes', async () => {
    const res = await createHttpApp().request('/nope');
    expect(res.status).toBe(404);
  });
});
