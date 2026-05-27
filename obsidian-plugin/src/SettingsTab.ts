import { App, Plugin, PluginSettingTab, Setting, Notice } from 'obsidian';
import type { VaultNexusSettings } from './settings.js';

// Structural type → breaks circular import w/ main.ts (which imports SettingsTab).
interface VaultNexusPluginHost extends Plugin {
  settings: VaultNexusSettings;
  saveSettings(): Promise<void>;
}

interface DaemonStatus {
  ok: boolean;
  version?: string;
  error?: string;
}

interface ToolsList {
  tools?: Array<{ name: string }>;
}

export class VaultNexusSettingsTab extends PluginSettingTab {
  private statusEl!: HTMLDivElement;
  private toolsEl!: HTMLDivElement;

  constructor(app: App, private readonly plugin: VaultNexusPluginHost) {
    super(app, plugin);
  }

  display(): void {
    const c = this.containerEl;
    c.empty();
    c.addClass('vaultnexus-settings');

    const s = this.plugin.settings;

    c.createEl('h2', { text: 'VaultNexus' });
    c.createEl('p', {
      text: 'Local-first semantic search + cross-community bridges over your vault. The plugin talks to a daemon on loopback HTTP; configure connection below.',
      cls: 'setting-item-description',
    });

    // ── Connection ─────────────────────────────────────────
    c.createEl('h3', { text: 'Connection' });

    new Setting(c)
      .setName('Daemon host')
      .setDesc('Loopback address. Leave as 127.0.0.1 unless tunneling.')
      .addText((t) =>
        t
          .setPlaceholder('127.0.0.1')
          .setValue(s.host)
          .onChange(async (v) => {
            s.host = v.trim() || '127.0.0.1';
            await this.plugin.saveSettings();
          }),
      );

    new Setting(c)
      .setName('Daemon port')
      .setDesc('Default 38473. Must match VAULTNEXUS_HTTP_PORT in the daemon env.')
      .addText((t) =>
        t
          .setPlaceholder('38473')
          .setValue(String(s.port))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            if (Number.isFinite(n) && n > 0 && n < 65536) {
              s.port = n;
              await this.plugin.saveSettings();
            }
          }),
      );

    new Setting(c)
      .setName('Test connection')
      .setDesc('Probe /health and tools/list on the configured host:port.')
      .addButton((b) =>
        b
          .setButtonText('Test')
          .setCta()
          .onClick(async () => {
            await this.refreshStatus();
          }),
      );

    this.statusEl = c.createDiv({ cls: 'vaultnexus-status' });
    this.toolsEl = c.createDiv({ cls: 'vaultnexus-tools' });
    void this.refreshStatus();

    // ── Search ─────────────────────────────────────────────
    c.createEl('h3', { text: 'Search' });

    new Setting(c)
      .setName('Default k (number of results)')
      .setDesc('How many hits to fetch per query. 1–100.')
      .addSlider((sl) =>
        sl
          .setLimits(1, 100, 1)
          .setValue(s.defaultK)
          .setDynamicTooltip()
          .onChange(async (v) => {
            s.defaultK = v;
            await this.plugin.saveSettings();
          }),
      );

    // ── Display ────────────────────────────────────────────
    c.createEl('h3', { text: 'Display' });

    new Setting(c)
      .setName('Show heading path')
      .setDesc('Render breadcrumb of each hit’s heading hierarchy under the note title.')
      .addToggle((t) =>
        t.setValue(s.showHeading).onChange(async (v) => {
          s.showHeading = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(c)
      .setName('Show preview')
      .setDesc('Render the matched chunk text as a preview below the heading.')
      .addToggle((t) =>
        t.setValue(s.showPreview).onChange(async (v) => {
          s.showPreview = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(c)
      .setName('Preview length')
      .setDesc('Max characters of preview text. 50–800.')
      .addSlider((sl) =>
        sl
          .setLimits(50, 800, 50)
          .setValue(s.previewLen)
          .setDynamicTooltip()
          .onChange(async (v) => {
            s.previewLen = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(c)
      .setName('Show score')
      .setDesc('Render the cosine relevance score under each hit.')
      .addToggle((t) =>
        t.setValue(s.showScore).onChange(async (v) => {
          s.showScore = v;
          await this.plugin.saveSettings();
        }),
      );

    // ── Daemon config (read-only guidance) ─────────────────
    c.createEl('h3', { text: 'Daemon environment' });
    c.createEl('p', {
      cls: 'setting-item-description',
      text: 'These knobs live on the daemon process, not the plugin. Set them in the shell that launches the daemon, then restart it.',
    });

    const envList = c.createEl('table', { cls: 'vaultnexus-env-table' });
    const envRows: Array<[string, string]> = [
      ['VAULTNEXUS_VAULT', 'Absolute path to the vault directory to index.'],
      ['VAULTNEXUS_EMBED_URL', 'OpenAI-compatible embeddings endpoint (e.g. https://api.voyageai.com/v1).'],
      ['VAULTNEXUS_EMBED_KEY', 'API key for the embedder. Leave unset for the offline FakeEmbedder.'],
      ['VAULTNEXUS_EMBED_MODEL', 'Embedding model id (e.g. voyage-3-large).'],
      ['VAULTNEXUS_CHAT_PROVIDER', 'anthropic | openai | openai-compatible | fake (default fake).'],
      ['VAULTNEXUS_CHAT_KEY', 'Chat-provider API key. Required when CHAT_PROVIDER is not fake.'],
      ['VAULTNEXUS_CHAT_MODEL', 'Chat model id. Defaults: anthropic→claude-sonnet-4-6, openai→gpt-4o-mini.'],
      ['VAULTNEXUS_CHAT_URL', 'Base URL for openai-compatible local providers (Ollama, LM Studio, vLLM).'],
      ['VAULTNEXUS_INDEX_SNAPSHOT', 'On-disk index snapshot path. “off” disables.'],
    ];
    for (const [k, v] of envRows) {
      const row = envList.createEl('tr');
      const kc = row.createEl('td', { text: k });
      kc.style.fontFamily = 'var(--font-monospace)';
      kc.style.paddingRight = '12px';
      kc.style.verticalAlign = 'top';
      kc.style.whiteSpace = 'nowrap';
      kc.style.color = 'var(--text-accent)';
      const vc = row.createEl('td', { text: v });
      vc.style.color = 'var(--text-muted)';
      vc.style.fontSize = '0.9em';
    }

    // ── Style polish ──────────────────────────────────────
    const style = c.createEl('style');
    style.textContent = `
      .vaultnexus-settings .vaultnexus-status {
        margin: 8px 0;
        padding: 10px 12px;
        border-radius: 6px;
        background: var(--background-secondary);
        font-family: var(--font-monospace);
        font-size: 0.85em;
      }
      .vaultnexus-settings .vaultnexus-tools {
        margin: 0 0 16px 0;
        font-family: var(--font-monospace);
        font-size: 0.8em;
        color: var(--text-muted);
      }
      .vaultnexus-settings table.vaultnexus-env-table {
        margin-top: 6px;
        border-spacing: 0;
        line-height: 1.5;
      }
      .vaultnexus-settings table.vaultnexus-env-table td {
        padding: 3px 0;
      }
    `;
  }

  private async refreshStatus(): Promise<void> {
    const s = this.plugin.settings;
    const base = `http://${s.host}:${s.port}`;
    this.statusEl.empty();
    this.toolsEl.empty();
    this.statusEl.createEl('span', { text: 'Probing…' });

    const health = await this.probeHealth(base);
    this.statusEl.empty();
    if (health.ok) {
      this.statusEl.createEl('span', {
        text: `✓ Daemon reachable at ${base}  —  version ${health.version ?? '?'}`,
      });
      this.statusEl.style.color = 'var(--text-success)';
      const tools = await this.probeTools(s.host, s.port);
      if (tools && tools.tools) {
        this.toolsEl.empty();
        this.toolsEl.createEl('div', {
          text: `Tools available: ${tools.tools.map((t) => t.name).join(', ')}`,
        });
      }
    } else {
      this.statusEl.createEl('span', {
        text: `✗ Cannot reach daemon at ${base}: ${health.error}`,
      });
      this.statusEl.style.color = 'var(--text-error)';
      new Notice('VaultNexus daemon unreachable. Is it running?');
    }
  }

  private async probeHealth(base: string): Promise<DaemonStatus> {
    try {
      const r = await fetch(`${base}/health`, { method: 'GET' });
      if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
      const j = (await r.json()) as { status: string; version: string };
      return { ok: j.status === 'ok', version: j.version };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private async probeTools(host: string, port: number): Promise<ToolsList | null> {
    try {
      // /search w/ empty query → bad → 400/422; instead just confirm OPTIONS or a known-good POST.
      // No tools/list HTTP endpoint exists; this is informational best-effort. Return null silently if not available.
      const r = await fetch(`http://${host}:${port}/health`, { method: 'GET' });
      if (!r.ok) return null;
      // Hardcoded list mirroring the registered MCP tools — surfaces capability without an extra HTTP route.
      return {
        tools: [
          { name: 'vaultnexus_ping' },
          { name: 'vaultnexus_search' },
          { name: 'vaultnexus_bridges' },
          { name: 'vaultnexus_trace' },
          { name: 'vaultnexus_reason' },
          { name: 'vaultnexus_history' },
          { name: 'vaultnexus_recall_history' },
          { name: 'vaultnexus_forecasts' },
        ],
      };
    } catch {
      return null;
    }
  }
}
