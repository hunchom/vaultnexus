import { App, Plugin, PluginSettingTab, Setting, Notice } from 'obsidian';
import type { ChatProvider, VaultNexusSettings } from './settings.js';

// Structural type → breaks circular import w/ main.ts.
interface VaultNexusPluginHost extends Plugin {
  settings: VaultNexusSettings;
  saveSettings(): Promise<void>;
}

interface DaemonStatus {
  ok: boolean;
  version?: string;
  indexed?: number;
  chatModel?: string;
  tools?: string[];
  error?: string;
}

export class VaultNexusSettingsTab extends PluginSettingTab {
  private connBadgeEl!: HTMLSpanElement;
  private connDetailEl!: HTMLDivElement;
  private idxBadgeEl!: HTMLSpanElement;
  private idxDetailEl!: HTMLDivElement;
  private chatBadgeEl!: HTMLSpanElement;
  private chatDetailEl!: HTMLDivElement;
  private toolsEl!: HTMLDivElement;
  private chatStatusEl!: HTMLDivElement;

  constructor(app: App, private readonly plugin: VaultNexusPluginHost) {
    super(app, plugin);
  }

  display(): void {
    const c = this.containerEl;
    c.empty();
    c.addClass('vaultnexus-settings');
    const s = this.plugin.settings;
    this.injectStyles(c);

    // ── Hero ──────────────────────────────────────────────
    const hero = c.createDiv({ cls: 'vn-hero' });
    const heroLeft = hero.createDiv({ cls: 'vn-hero-left' });
    heroLeft.createEl('div', { text: 'VaultNexus', cls: 'vn-hero-title' });
    heroLeft.createEl('div', {
      text: 'Local-first semantic search + cross-community bridges over your vault.',
      cls: 'vn-hero-sub',
    });

    // ── Status panel (3-up grid) ──────────────────────────
    const panel = c.createDiv({ cls: 'vn-status-panel' });
    const connCard = panel.createDiv({ cls: 'vn-card' });
    connCard.createEl('div', { text: 'Connection', cls: 'vn-card-label' });
    this.connBadgeEl = connCard.createEl('span', { text: '…', cls: 'vn-badge vn-badge-unknown' });
    this.connDetailEl = connCard.createDiv({ cls: 'vn-card-detail' });

    const idxCard = panel.createDiv({ cls: 'vn-card' });
    idxCard.createEl('div', { text: 'Index', cls: 'vn-card-label' });
    this.idxBadgeEl = idxCard.createEl('span', { text: '…', cls: 'vn-badge vn-badge-unknown' });
    this.idxDetailEl = idxCard.createDiv({ cls: 'vn-card-detail' });

    const chatCard = panel.createDiv({ cls: 'vn-card' });
    chatCard.createEl('div', { text: 'Chat model', cls: 'vn-card-label' });
    this.chatBadgeEl = chatCard.createEl('span', { text: '…', cls: 'vn-badge vn-badge-unknown' });
    this.chatDetailEl = chatCard.createDiv({ cls: 'vn-card-detail' });

    this.toolsEl = c.createDiv({ cls: 'vn-tools-row' });

    void this.refreshStatus();

    // ── Connection ────────────────────────────────────────
    this.section(c, 'Connection', 'plug-zap',
      'How the plugin reaches the daemon. Loopback by default.');

    const hpRow = c.createDiv({ cls: 'vn-inline-row' });
    const hostWrap = hpRow.createDiv({ cls: 'vn-inline-field' });
    hostWrap.createEl('label', { text: 'Host' });
    const hostIn = hostWrap.createEl('input', {
      type: 'text', value: s.host, attr: { placeholder: '127.0.0.1' },
    });
    hostIn.addEventListener('change', async () => {
      s.host = hostIn.value.trim() || '127.0.0.1';
      await this.plugin.saveSettings();
      void this.refreshStatus();
    });
    const portWrap = hpRow.createDiv({ cls: 'vn-inline-field vn-inline-field-narrow' });
    portWrap.createEl('label', { text: 'Port' });
    const portIn = portWrap.createEl('input', {
      type: 'number', value: String(s.port), attr: { min: '1', max: '65535' },
    });
    portIn.addEventListener('change', async () => {
      const n = parseInt(portIn.value, 10);
      if (Number.isFinite(n) && n > 0 && n < 65536) {
        s.port = n;
        await this.plugin.saveSettings();
        void this.refreshStatus();
      }
    });
    const testWrap = hpRow.createDiv({ cls: 'vn-inline-field vn-inline-field-action' });
    testWrap.createEl('label', { text: ' ' });
    const testBtn = testWrap.createEl('button', { text: 'Test connection', cls: 'mod-cta vn-btn' });
    testBtn.addEventListener('click', () => void this.refreshStatus());

    // ── Chat model (real LLM) ─────────────────────────────
    this.section(c, 'Chat model', 'sparkles',
      'Powers the reason / narrate tools. Default fake → swap to a real provider for narrative answers. Pushed to daemon live (no restart).');

    new Setting(c)
      .setName('Provider')
      .setDesc('fake = stub. anthropic / openai = managed. openai-compatible = Ollama / LM Studio / vLLM.')
      .addDropdown((d) => {
        d.addOption('fake', 'fake (offline stub)');
        d.addOption('anthropic', 'anthropic');
        d.addOption('openai', 'openai');
        d.addOption('openai-compatible', 'openai-compatible (local)');
        d.setValue(s.chatProvider);
        d.onChange(async (v) => {
          s.chatProvider = v as ChatProvider;
          await this.plugin.saveSettings();
          this.display(); // re-render → conditional fields
        });
      });

    if (s.chatProvider !== 'fake') {
      new Setting(c)
        .setName('API key')
        .setDesc('Stored in plugin data only. Sent over loopback to the daemon. Never leaves your machine.')
        .addText((t) => {
          t.setPlaceholder(s.chatProvider === 'anthropic' ? 'sk-ant-…' : 'sk-…');
          t.setValue(s.chatKey);
          (t.inputEl as HTMLInputElement).type = 'password';
          t.onChange(async (v) => {
            s.chatKey = v;
            await this.plugin.saveSettings();
          });
        });

      new Setting(c)
        .setName('Model id')
        .setDesc(this.defaultModelHint(s.chatProvider))
        .addText((t) => {
          t.setPlaceholder(this.placeholderModel(s.chatProvider));
          t.setValue(s.chatModel);
          t.onChange(async (v) => {
            s.chatModel = v.trim();
            await this.plugin.saveSettings();
          });
        });

      if (s.chatProvider === 'openai-compatible') {
        new Setting(c)
          .setName('Base URL')
          .setDesc('e.g. http://localhost:11434/v1 (Ollama), http://localhost:1234/v1 (LM Studio).')
          .addText((t) => {
            t.setPlaceholder('http://localhost:11434/v1');
            t.setValue(s.chatBaseURL);
            t.onChange(async (v) => {
              s.chatBaseURL = v.trim();
              await this.plugin.saveSettings();
            });
          });
      }
    }

    const chatActions = c.createDiv({ cls: 'vn-actions-row' });
    const applyBtn = chatActions.createEl('button', { text: 'Apply to daemon', cls: 'mod-cta vn-btn' });
    applyBtn.addEventListener('click', () => void this.applyChatConfig());
    const resetBtn = chatActions.createEl('button', { text: 'Revert to fake', cls: 'vn-btn vn-btn-ghost' });
    resetBtn.addEventListener('click', async () => {
      s.chatProvider = 'fake';
      s.chatKey = '';
      s.chatModel = '';
      s.chatBaseURL = '';
      await this.plugin.saveSettings();
      this.display();
      void this.applyChatConfig();
    });
    this.chatStatusEl = c.createDiv({ cls: 'vn-chat-status' });

    // ── Search ────────────────────────────────────────────
    this.section(c, 'Search', 'search',
      'Defaults for the sidebar search panel.');

    new Setting(c)
      .setName('Default result count')
      .setDesc('How many hits to fetch per query (1–100).')
      .addSlider((sl) =>
        sl.setLimits(1, 100, 1)
          .setValue(s.defaultK)
          .setDynamicTooltip()
          .onChange(async (v) => {
            s.defaultK = v;
            await this.plugin.saveSettings();
          }),
      );

    // ── Display ───────────────────────────────────────────
    this.section(c, 'Display', 'layout',
      'How hits render in the search sidebar.');

    new Setting(c)
      .setName('Show heading path')
      .setDesc("Breadcrumb of each hit's heading hierarchy under the note title.")
      .addToggle((t) =>
        t.setValue(s.showHeading).onChange(async (v) => {
          s.showHeading = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(c)
      .setName('Show preview')
      .setDesc('Matched chunk text rendered below the heading.')
      .addToggle((t) =>
        t.setValue(s.showPreview).onChange(async (v) => {
          s.showPreview = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(c)
      .setName('Preview length')
      .setDesc('Max characters of preview text (50–800).')
      .addSlider((sl) =>
        sl.setLimits(50, 800, 50)
          .setValue(s.previewLen)
          .setDynamicTooltip()
          .onChange(async (v) => {
            s.previewLen = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(c)
      .setName('Show score')
      .setDesc('Cosine relevance score under each hit.')
      .addToggle((t) =>
        t.setValue(s.showScore).onChange(async (v) => {
          s.showScore = v;
          await this.plugin.saveSettings();
        }),
      );

    // ── Daemon environment (expert) ───────────────────────
    const adv = c.createEl('details', { cls: 'vn-advanced' });
    adv.createEl('summary', { text: 'Daemon environment (advanced)' });
    adv.createEl('p', {
      cls: 'setting-item-description',
      text: 'These knobs live on the daemon process, not the plugin. Set them in the shell that launches the daemon, then restart it.',
    });
    const envTable = adv.createEl('table', { cls: 'vn-env-table' });
    const envRows: Array<[string, string]> = [
      ['VAULTNEXUS_VAULT', 'Absolute path to the vault directory to index.'],
      ['VAULTNEXUS_EMBED_URL', 'OpenAI-compatible embeddings endpoint (e.g. https://api.voyageai.com/v1).'],
      ['VAULTNEXUS_EMBED_KEY', 'API key for the embedder. Leave unset → offline FakeEmbedder.'],
      ['VAULTNEXUS_EMBED_MODEL', 'Embedding model id (e.g. voyage-3-large).'],
      ['VAULTNEXUS_CHAT_PROVIDER', 'anthropic | openai | openai-compatible | fake (default fake).'],
      ['VAULTNEXUS_CHAT_KEY', 'Chat-provider API key. Required when CHAT_PROVIDER ≠ fake.'],
      ['VAULTNEXUS_CHAT_MODEL', 'Chat model id. Defaults: anthropic→claude-sonnet-4-6, openai→gpt-4o-mini.'],
      ['VAULTNEXUS_CHAT_URL', 'Base URL for openai-compatible (Ollama, LM Studio, vLLM).'],
      ['VAULTNEXUS_INDEX_SNAPSHOT', 'On-disk index snapshot path. "off" disables.'],
    ];
    for (const [k, v] of envRows) {
      const row = envTable.createEl('tr');
      const kc = row.createEl('td', { text: k, cls: 'vn-env-key' });
      kc.setAttr('data-key', k);
      row.createEl('td', { text: v, cls: 'vn-env-val' });
    }
  }

  private section(parent: HTMLElement, title: string, _icon: string, desc: string): void {
    const header = parent.createDiv({ cls: 'vn-section-header' });
    header.createEl('div', { text: title, cls: 'vn-section-title' });
    if (desc) header.createEl('div', { text: desc, cls: 'vn-section-desc' });
  }

  private defaultModelHint(provider: ChatProvider): string {
    if (provider === 'anthropic') return 'Leave blank → claude-sonnet-4-6.';
    if (provider === 'openai') return 'Leave blank → gpt-4o-mini.';
    if (provider === 'openai-compatible') return 'Required. Match what the local server serves.';
    return 'N/A for fake.';
  }

  private placeholderModel(provider: ChatProvider): string {
    if (provider === 'anthropic') return 'claude-sonnet-4-6';
    if (provider === 'openai') return 'gpt-4o-mini';
    if (provider === 'openai-compatible') return 'llama3.1:8b';
    return '';
  }

  private async refreshStatus(): Promise<void> {
    const s = this.plugin.settings;
    const base = `http://${s.host}:${s.port}`;
    this.setBadge(this.connBadgeEl, 'unknown', 'probing…');
    this.connDetailEl.setText(base);
    this.idxDetailEl.setText('—');
    this.chatDetailEl.setText('—');

    const st = await this.probeStatus(base);
    if (!st.ok) {
      this.setBadge(this.connBadgeEl, 'down', 'unreachable');
      this.connDetailEl.setText(st.error ? `${base} · ${st.error}` : base);
      this.setBadge(this.idxBadgeEl, 'unknown', '—');
      this.setBadge(this.chatBadgeEl, 'unknown', '—');
      new Notice('VaultNexus daemon unreachable. Is it running?');
      return;
    }

    this.setBadge(this.connBadgeEl, 'ok', `v${st.version ?? '?'}`);
    this.connDetailEl.setText(base);

    const n = st.indexed ?? 0;
    this.setBadge(this.idxBadgeEl, n > 0 ? 'ok' : 'warn', `${n} chunks`);
    this.idxDetailEl.setText(n === 0 ? 'empty — daemon may still be indexing' : 'snapshot loaded');

    const cm = st.chatModel ?? 'fake';
    const cmReal = cm !== 'fake' && cm !== 'none';
    this.setBadge(this.chatBadgeEl, cmReal ? 'ok' : 'warn', cm);
    this.chatDetailEl.setText(
      cmReal ? 'real LLM wired' : 'stub — configure under Chat model below',
    );

    this.toolsEl.empty();
    if (st.tools && st.tools.length > 0) {
      this.toolsEl.createEl('div', { text: `MCP tools (${st.tools.length})`, cls: 'vn-tools-title' });
      const grid = this.toolsEl.createDiv({ cls: 'vn-tools-grid' });
      for (const t of st.tools) grid.createEl('span', { text: t, cls: 'vn-tool-chip' });
    }
  }

  private setBadge(el: HTMLSpanElement, state: 'ok' | 'warn' | 'down' | 'unknown', text: string): void {
    el.removeClasses(['vn-badge-ok', 'vn-badge-warn', 'vn-badge-down', 'vn-badge-unknown']);
    el.addClass(`vn-badge-${state}`);
    el.setText(text);
  }

  private async applyChatConfig(): Promise<void> {
    const s = this.plugin.settings;
    const base = `http://${s.host}:${s.port}`;
    this.chatStatusEl.empty();
    this.chatStatusEl.createEl('span', { text: 'Applying…', cls: 'vn-chat-status-pending' });

    const body: Record<string, string> = { provider: s.chatProvider };
    if (s.chatKey) body.key = s.chatKey;
    if (s.chatModel) body.model = s.chatModel;
    if (s.chatBaseURL) body.baseURL = s.chatBaseURL;

    try {
      const r = await fetch(`${base}/configure-chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = (await r.json()) as { ok?: boolean; chatModel?: string; error?: string };
      this.chatStatusEl.empty();
      if (!r.ok || j.error) {
        this.chatStatusEl.createEl('span', {
          text: `✗ ${j.error ?? `HTTP ${r.status}`}`,
          cls: 'vn-chat-status-err',
        });
        new Notice(`Chat config rejected: ${j.error ?? r.status}`);
        return;
      }
      this.chatStatusEl.createEl('span', {
        text: `✓ Daemon now using ${j.chatModel}`,
        cls: 'vn-chat-status-ok',
      });
      new Notice(`Chat model live: ${j.chatModel}`);
      void this.refreshStatus();
    } catch (e) {
      this.chatStatusEl.empty();
      const msg = e instanceof Error ? e.message : String(e);
      this.chatStatusEl.createEl('span', { text: `✗ ${msg}`, cls: 'vn-chat-status-err' });
      new Notice(`Cannot reach daemon: ${msg}`);
    }
  }

  private async probeStatus(base: string): Promise<DaemonStatus> {
    try {
      let r = await fetch(`${base}/status`);
      if (!r.ok) r = await fetch(`${base}/health`);
      if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
      const j = (await r.json()) as {
        status: string; version: string;
        indexed?: number; chatModel?: string; tools?: string[];
      };
      return {
        ok: j.status === 'ok',
        version: j.version,
        indexed: j.indexed,
        chatModel: j.chatModel,
        tools: j.tools,
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private injectStyles(c: HTMLElement): void {
    const style = c.createEl('style');
    style.textContent = `
      .vaultnexus-settings .vn-hero {
        margin: 0 0 18px 0;
        padding: 16px 18px;
        border-radius: 10px;
        background: linear-gradient(135deg,
          var(--background-secondary) 0%,
          var(--background-modifier-form-field) 100%);
        border: 1px solid var(--background-modifier-border);
      }
      .vaultnexus-settings .vn-hero-title {
        font-size: 1.6em;
        font-weight: 700;
        letter-spacing: -0.01em;
      }
      .vaultnexus-settings .vn-hero-sub {
        margin-top: 4px;
        color: var(--text-muted);
        font-size: 0.92em;
      }
      .vaultnexus-settings .vn-status-panel {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 10px;
        margin: 0 0 8px 0;
      }
      .vaultnexus-settings .vn-card {
        padding: 12px 14px;
        border-radius: 8px;
        background: var(--background-secondary);
        border: 1px solid var(--background-modifier-border);
        display: flex; flex-direction: column; gap: 6px;
      }
      .vaultnexus-settings .vn-card-label {
        font-size: 0.72em;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--text-muted);
        font-weight: 600;
      }
      .vaultnexus-settings .vn-card-detail {
        font-size: 0.78em;
        color: var(--text-faint);
        font-family: var(--font-monospace);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .vaultnexus-settings .vn-badge {
        display: inline-block;
        padding: 3px 10px;
        border-radius: 999px;
        font-size: 0.78em;
        font-weight: 600;
        font-family: var(--font-monospace);
        width: fit-content;
        border: 1px solid transparent;
      }
      .vaultnexus-settings .vn-badge-ok      { background: rgba(46,160,67,0.15); color: var(--text-success, #2ea043); border-color: rgba(46,160,67,0.4); }
      .vaultnexus-settings .vn-badge-warn    { background: rgba(212,165,38,0.15); color: var(--text-warning, #d4a526); border-color: rgba(212,165,38,0.4); }
      .vaultnexus-settings .vn-badge-down    { background: rgba(208,86,86,0.15);  color: var(--text-error,   #d05656); border-color: rgba(208,86,86,0.4); }
      .vaultnexus-settings .vn-badge-unknown { background: var(--background-modifier-border); color: var(--text-muted); }

      .vaultnexus-settings .vn-tools-row {
        margin: 4px 0 18px 0;
        padding: 10px 14px;
        border-radius: 8px;
        background: var(--background-secondary);
        border: 1px dashed var(--background-modifier-border);
      }
      .vaultnexus-settings .vn-tools-row:empty { display: none; }
      .vaultnexus-settings .vn-tools-title {
        font-size: 0.72em;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--text-muted);
        margin-bottom: 6px;
      }
      .vaultnexus-settings .vn-tools-grid {
        display: flex;
        flex-wrap: wrap;
        gap: 4px 6px;
      }
      .vaultnexus-settings .vn-tool-chip {
        font-family: var(--font-monospace);
        font-size: 0.74em;
        padding: 2px 8px;
        border-radius: 4px;
        background: var(--background-modifier-form-field);
        color: var(--text-muted);
        border: 1px solid var(--background-modifier-border);
      }

      .vaultnexus-settings .vn-section-header {
        margin: 22px 0 6px 0;
        padding-bottom: 6px;
        border-bottom: 1px solid var(--background-modifier-border);
      }
      .vaultnexus-settings .vn-section-title {
        font-size: 1.1em;
        font-weight: 600;
        letter-spacing: -0.005em;
      }
      .vaultnexus-settings .vn-section-desc {
        margin-top: 2px;
        font-size: 0.85em;
        color: var(--text-muted);
      }

      .vaultnexus-settings .vn-inline-row {
        display: grid;
        grid-template-columns: 2fr 1fr auto;
        gap: 10px;
        margin: 10px 0;
      }
      .vaultnexus-settings .vn-inline-field { display: flex; flex-direction: column; gap: 4px; }
      .vaultnexus-settings .vn-inline-field label {
        font-size: 0.78em;
        color: var(--text-muted);
        font-weight: 500;
      }
      .vaultnexus-settings .vn-inline-field input {
        width: 100%;
        font-family: var(--font-monospace);
      }
      .vaultnexus-settings .vn-inline-field-action { justify-content: end; }

      .vaultnexus-settings .vn-actions-row {
        display: flex;
        gap: 8px;
        margin: 8px 0 4px 0;
      }
      .vaultnexus-settings .vn-btn { padding: 6px 14px; }
      .vaultnexus-settings .vn-btn-ghost {
        background: transparent;
        color: var(--text-muted);
        border: 1px solid var(--background-modifier-border);
      }
      .vaultnexus-settings .vn-chat-status { min-height: 1.4em; font-size: 0.85em; margin-top: 4px; }
      .vaultnexus-settings .vn-chat-status-ok      { color: var(--text-success, #2ea043); }
      .vaultnexus-settings .vn-chat-status-err     { color: var(--text-error,   #d05656); }
      .vaultnexus-settings .vn-chat-status-pending { color: var(--text-muted); }

      .vaultnexus-settings .vn-advanced {
        margin-top: 24px;
        padding: 8px 14px;
        border-radius: 8px;
        border: 1px solid var(--background-modifier-border);
        background: var(--background-secondary);
      }
      .vaultnexus-settings .vn-advanced summary {
        cursor: pointer;
        font-weight: 600;
        padding: 4px 0;
      }
      .vaultnexus-settings table.vn-env-table {
        width: 100%;
        margin-top: 8px;
        border-spacing: 0;
        line-height: 1.5;
      }
      .vaultnexus-settings table.vn-env-table td { padding: 4px 0; vertical-align: top; }
      .vaultnexus-settings table.vn-env-table td.vn-env-key {
        font-family: var(--font-monospace);
        color: var(--text-accent);
        padding-right: 14px;
        white-space: nowrap;
      }
      .vaultnexus-settings table.vn-env-table td.vn-env-val {
        color: var(--text-muted);
        font-size: 0.9em;
      }
    `;
  }
}
