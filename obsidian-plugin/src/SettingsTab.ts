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

// Aesthetic: editorial-operator console. Single accent (Obsidian's --interactive-accent).
// Serif display, monospace numerics, broadcast cue lamps, no rounded chips.
export class VaultNexusSettingsTab extends PluginSettingTab {
  private heroVerEl!: HTMLSpanElement;
  private connLampEl!: HTMLSpanElement;
  private connNumEl!: HTMLDivElement;
  private connSubEl!: HTMLDivElement;
  private idxLampEl!: HTMLSpanElement;
  private idxNumEl!: HTMLDivElement;
  private idxSubEl!: HTMLDivElement;
  private chatLampEl!: HTMLSpanElement;
  private chatNumEl!: HTMLDivElement;
  private chatSubEl!: HTMLDivElement;
  private toolsEl!: HTMLDivElement;
  private chatStatusEl!: HTMLDivElement;

  constructor(app: App, private readonly plugin: VaultNexusPluginHost) {
    super(app, plugin);
  }

  display(): void {
    const c = this.containerEl;
    c.empty();
    c.addClass('vaultnexus-settings');
    this.injectStyles(c);
    const s = this.plugin.settings;

    // ── Hero (editorial) ──────────────────────────────────
    const hero = c.createDiv({ cls: 'vn-hero' });
    const eyebrow = hero.createDiv({ cls: 'vn-eyebrow' });
    eyebrow.createEl('span', { text: 'VAULTNEXUS' });
    eyebrow.createEl('span', { text: '·', cls: 'vn-eyebrow-sep' });
    this.heroVerEl = eyebrow.createEl('span', { text: 'connecting…', cls: 'vn-eyebrow-ver' });
    hero.createEl('h1', {
      text: 'Local‑first semantic search',
      cls: 'vn-hero-title',
    });
    hero.createEl('p', {
      text: 'Cross‑community bridges + cited retrieval over your vault. Loopback HTTP to a daemon you control. No cloud round‑trip on query.',
      cls: 'vn-hero-lede',
    });
    hero.createDiv({ cls: 'vn-rule vn-rule-strong' });

    // ── Status grid ───────────────────────────────────────
    const panel = c.createDiv({ cls: 'vn-panel' });
    [
      { label: 'CONNECTION', refs: ['conn'] },
      { label: 'INDEX', refs: ['idx'] },
      { label: 'CHAT MODEL', refs: ['chat'] },
    ].forEach(({ label, refs }) => {
      const cell = panel.createDiv({ cls: 'vn-cell' });
      const head = cell.createDiv({ cls: 'vn-cell-head' });
      head.createEl('span', { text: label, cls: 'vn-cell-label' });
      const lamp = head.createEl('span', { cls: 'vn-lamp vn-lamp-unknown' });
      const num = cell.createEl('div', { text: '—', cls: 'vn-cell-num' });
      const sub = cell.createEl('div', { text: ' ', cls: 'vn-cell-sub' });
      if (refs[0] === 'conn') { this.connLampEl = lamp; this.connNumEl = num; this.connSubEl = sub; }
      if (refs[0] === 'idx')  { this.idxLampEl = lamp;  this.idxNumEl = num;  this.idxSubEl = sub; }
      if (refs[0] === 'chat') { this.chatLampEl = lamp; this.chatNumEl = num; this.chatSubEl = sub; }
    });

    this.toolsEl = c.createDiv({ cls: 'vn-tools' });

    void this.refreshStatus();

    // ── 01 CONNECTION ─────────────────────────────────────
    this.sectionEyebrow(c, '01', 'Connection',
      'Loopback HTTP. The daemon binds to 127.0.0.1; change only if you tunnel.');

    const hp = c.createDiv({ cls: 'vn-row vn-row-3' });
    this.underlineField(hp, 'Host', s.host, '127.0.0.1', async (v) => {
      s.host = v.trim() || '127.0.0.1';
      await this.plugin.saveSettings();
      void this.refreshStatus();
    });
    this.underlineField(hp, 'Port', String(s.port), '38473', async (v) => {
      const n = parseInt(v, 10);
      if (Number.isFinite(n) && n > 0 && n < 65536) {
        s.port = n;
        await this.plugin.saveSettings();
        void this.refreshStatus();
      }
    }, { type: 'number', minWidth: '8ch' });
    const probeWrap = hp.createDiv({ cls: 'vn-field vn-field-action' });
    probeWrap.createEl('label', { text: ' ' });
    const probeBtn = probeWrap.createEl('button', { text: 'PROBE', cls: 'vn-btn vn-btn-primary' });
    probeBtn.addEventListener('click', () => void this.refreshStatus());

    // ── 02 CHAT MODEL ─────────────────────────────────────
    this.sectionEyebrow(c, '02', 'Chat model',
      'Powers reason / narrate / recall tools. Fake is an offline stub. Swap to a real provider for narrative answers — pushed live to the daemon (no restart).');

    new Setting(c)
      .setName('Provider')
      .setDesc('fake → stub · anthropic / openai → managed · openai‑compatible → Ollama, LM Studio, vLLM.')
      .addDropdown((d) => {
        d.addOption('fake', 'fake (offline stub)');
        d.addOption('anthropic', 'anthropic');
        d.addOption('openai', 'openai');
        d.addOption('openai-compatible', 'openai‑compatible (local)');
        d.setValue(s.chatProvider);
        d.onChange(async (v) => {
          s.chatProvider = v as ChatProvider;
          await this.plugin.saveSettings();
          this.display();
        });
      });

    if (s.chatProvider !== 'fake') {
      new Setting(c)
        .setName('API key')
        .setDesc('Plugin data only. Sent over loopback to the daemon. Never leaves this machine.')
        .addText((t) => {
          t.setPlaceholder(s.chatProvider === 'anthropic' ? 'sk‑ant‑…' : 'sk‑…');
          t.setValue(s.chatKey);
          (t.inputEl as HTMLInputElement).type = 'password';
          (t.inputEl as HTMLInputElement).autocomplete = 'off';
          t.onChange(async (v) => {
            s.chatKey = v;
            await this.plugin.saveSettings();
          });
        });

      new Setting(c)
        .setName('Model id')
        .setDesc(this.modelHint(s.chatProvider))
        .addText((t) => {
          t.setPlaceholder(this.modelPlaceholder(s.chatProvider));
          t.setValue(s.chatModel);
          t.onChange(async (v) => {
            s.chatModel = v.trim();
            await this.plugin.saveSettings();
          });
        });

      if (s.chatProvider === 'openai-compatible') {
        new Setting(c)
          .setName('Base URL')
          .setDesc('e.g. http://localhost:11434/v1 (Ollama) · http://localhost:1234/v1 (LM Studio).')
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

    const acts = c.createDiv({ cls: 'vn-actions' });
    const apply = acts.createEl('button', { text: 'APPLY TO DAEMON', cls: 'vn-btn vn-btn-primary' });
    apply.addEventListener('click', () => void this.applyChatConfig());
    const revert = acts.createEl('button', { text: 'REVERT', cls: 'vn-btn vn-btn-ghost' });
    revert.addEventListener('click', async () => {
      s.chatProvider = 'fake';
      s.chatKey = '';
      s.chatModel = '';
      s.chatBaseURL = '';
      await this.plugin.saveSettings();
      this.display();
      void this.applyChatConfig();
    });
    this.chatStatusEl = c.createDiv({ cls: 'vn-chat-status' });

    // ── 03 SEARCH ─────────────────────────────────────────
    this.sectionEyebrow(c, '03', 'Search', 'Defaults for the sidebar search panel.');
    new Setting(c)
      .setName('Default result count')
      .setDesc('Hits returned per query · 1–100.')
      .addSlider((sl) =>
        sl.setLimits(1, 100, 1)
          .setValue(s.defaultK)
          .setDynamicTooltip()
          .onChange(async (v) => {
            s.defaultK = v;
            await this.plugin.saveSettings();
          }),
      );

    // ── 04 DISPLAY ────────────────────────────────────────
    this.sectionEyebrow(c, '04', 'Display', 'How each retrieved chunk is rendered in the sidebar.');
    new Setting(c).setName('Show heading path').setDesc('Breadcrumb of headings under the note title.')
      .addToggle((t) => t.setValue(s.showHeading).onChange(async (v) => {
        s.showHeading = v; await this.plugin.saveSettings();
      }));
    new Setting(c).setName('Show preview').setDesc('Matched chunk text below the heading.')
      .addToggle((t) => t.setValue(s.showPreview).onChange(async (v) => {
        s.showPreview = v; await this.plugin.saveSettings();
      }));
    new Setting(c).setName('Preview length').setDesc('Max characters · 50–800.')
      .addSlider((sl) => sl.setLimits(50, 800, 50).setValue(s.previewLen).setDynamicTooltip()
        .onChange(async (v) => { s.previewLen = v; await this.plugin.saveSettings(); }));
    new Setting(c).setName('Show score').setDesc('Cosine relevance score under each hit.')
      .addToggle((t) => t.setValue(s.showScore).onChange(async (v) => {
        s.showScore = v; await this.plugin.saveSettings();
      }));

    // ── 05 ADVANCED (collapsed) ───────────────────────────
    const adv = c.createEl('details', { cls: 'vn-advanced' });
    const sum = adv.createEl('summary');
    sum.createEl('span', { text: '05', cls: 'vn-section-num' });
    sum.createEl('span', { text: '  Daemon environment', cls: 'vn-section-name' });
    adv.createEl('p', {
      cls: 'vn-advanced-desc',
      text: 'These knobs live on the daemon process, not the plugin. Set them in the shell that launches the daemon, then restart it.',
    });
    const envTable = adv.createEl('table', { cls: 'vn-env' });
    const envRows: Array<[string, string]> = [
      ['VAULTNEXUS_VAULT',           'Absolute path to the vault directory to index.'],
      ['VAULTNEXUS_EMBED_URL',       'OpenAI‑compatible embeddings endpoint (e.g. https://api.voyageai.com/v1).'],
      ['VAULTNEXUS_EMBED_KEY',       'API key for the embedder. Unset → offline FakeEmbedder.'],
      ['VAULTNEXUS_EMBED_MODEL',     'Embedding model id (e.g. voyage‑3‑large).'],
      ['VAULTNEXUS_CHAT_PROVIDER',   'anthropic · openai · openai‑compatible · fake (default fake).'],
      ['VAULTNEXUS_CHAT_KEY',        'Chat‑provider API key. Required when CHAT_PROVIDER ≠ fake.'],
      ['VAULTNEXUS_CHAT_MODEL',      'Chat model id. Defaults: anthropic→claude‑sonnet‑4‑6, openai→gpt‑4o‑mini.'],
      ['VAULTNEXUS_CHAT_URL',        'Base URL for openai‑compatible (Ollama, LM Studio, vLLM).'],
      ['VAULTNEXUS_INDEX_SNAPSHOT',  'On‑disk snapshot path. "off" disables persistence.'],
    ];
    for (const [k, v] of envRows) {
      const row = envTable.createEl('tr');
      row.createEl('td', { text: k, cls: 'vn-env-k' });
      row.createEl('td', { text: v, cls: 'vn-env-v' });
    }

    // ── Footer signature ──────────────────────────────────
    const foot = c.createDiv({ cls: 'vn-foot' });
    foot.createEl('span', { text: '— END —', cls: 'vn-foot-mark' });
  }

  private sectionEyebrow(parent: HTMLElement, num: string, name: string, desc: string): void {
    const head = parent.createDiv({ cls: 'vn-section' });
    const top = head.createDiv({ cls: 'vn-section-top' });
    top.createEl('span', { text: num, cls: 'vn-section-num' });
    top.createEl('span', { text: name, cls: 'vn-section-name' });
    head.createDiv({ cls: 'vn-rule' });
    if (desc) head.createEl('p', { text: desc, cls: 'vn-section-desc' });
  }

  private underlineField(
    parent: HTMLElement,
    label: string,
    value: string,
    placeholder: string,
    onChange: (v: string) => Promise<void> | void,
    opts: { type?: string; minWidth?: string } = {},
  ): HTMLInputElement {
    const wrap = parent.createDiv({ cls: 'vn-field' });
    wrap.createEl('label', { text: label });
    const input = wrap.createEl('input', {
      type: opts.type ?? 'text',
      value,
      attr: { placeholder },
    });
    if (opts.minWidth) input.style.minWidth = opts.minWidth;
    input.addEventListener('change', () => void onChange(input.value));
    return input;
  }

  private modelHint(provider: ChatProvider): string {
    if (provider === 'anthropic') return 'Blank → claude‑sonnet‑4‑6.';
    if (provider === 'openai')    return 'Blank → gpt‑4o‑mini.';
    if (provider === 'openai-compatible') return 'Required. Must match what the local server serves.';
    return 'N/A for fake.';
  }
  private modelPlaceholder(provider: ChatProvider): string {
    if (provider === 'anthropic') return 'claude-sonnet-4-6';
    if (provider === 'openai')    return 'gpt-4o-mini';
    if (provider === 'openai-compatible') return 'llama3.1:8b';
    return '';
  }

  private async refreshStatus(): Promise<void> {
    const s = this.plugin.settings;
    const base = `${s.host}:${s.port}`;
    this.setLamp(this.connLampEl, 'probe');
    this.connNumEl.setText('···');
    this.connSubEl.setText(base);
    this.idxNumEl.setText('···'); this.idxSubEl.setText(' ');
    this.chatNumEl.setText('···'); this.chatSubEl.setText(' ');
    this.heroVerEl.setText('probing…');

    const st = await this.probeStatus(`http://${base}`);
    if (!st.ok) {
      this.setLamp(this.connLampEl, 'down');
      this.connNumEl.setText('OFFLINE');
      this.connSubEl.setText(st.error ?? base);
      this.setLamp(this.idxLampEl, 'unknown');  this.idxNumEl.setText('—'); this.idxSubEl.setText(' ');
      this.setLamp(this.chatLampEl, 'unknown'); this.chatNumEl.setText('—'); this.chatSubEl.setText(' ');
      this.heroVerEl.setText('daemon unreachable');
      new Notice('VaultNexus daemon unreachable. Is it running?');
      return;
    }

    this.heroVerEl.setText(`v${st.version ?? '?'}`);
    this.setLamp(this.connLampEl, 'ok');
    this.connNumEl.setText('LIVE');
    this.connSubEl.setText(base);

    const n = st.indexed ?? 0;
    this.setLamp(this.idxLampEl, n > 0 ? 'ok' : 'warn');
    this.idxNumEl.setText(this.compactNum(n));
    this.idxSubEl.setText(n === 0 ? 'empty · daemon may still be indexing' : 'chunks · snapshot loaded');

    const cm = st.chatModel ?? 'fake';
    const real = cm !== 'fake' && cm !== 'none';
    this.setLamp(this.chatLampEl, real ? 'ok' : 'warn');
    this.chatNumEl.setText(real ? cm : 'FAKE');
    this.chatSubEl.setText(real ? 'real LLM wired' : 'stub · configure under §02');

    this.toolsEl.empty();
    if (st.tools && st.tools.length > 0) {
      const head = this.toolsEl.createDiv({ cls: 'vn-tools-head' });
      head.createEl('span', { text: 'MCP TOOLS', cls: 'vn-tools-label' });
      head.createEl('span', { text: String(st.tools.length), cls: 'vn-tools-count' });
      const list = this.toolsEl.createDiv({ cls: 'vn-tools-list' });
      for (const t of st.tools) list.createEl('span', { text: t, cls: 'vn-tools-item' });
    }
  }

  private setLamp(el: HTMLSpanElement, state: 'ok' | 'warn' | 'down' | 'unknown' | 'probe'): void {
    el.removeClasses(['vn-lamp-ok', 'vn-lamp-warn', 'vn-lamp-down', 'vn-lamp-unknown', 'vn-lamp-probe']);
    el.addClass(`vn-lamp-${state}`);
  }

  private compactNum(n: number): string {
    if (n < 1000) return String(n);
    if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
    return `${(n / 1_000_000).toFixed(1)}M`;
  }

  private async applyChatConfig(): Promise<void> {
    const s = this.plugin.settings;
    const base = `http://${s.host}:${s.port}`;
    this.chatStatusEl.empty();
    this.chatStatusEl.createEl('span', { text: '◐ applying…', cls: 'vn-cs vn-cs-pending' });

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
        this.chatStatusEl.createEl('span', { text: `✕ ${j.error ?? `HTTP ${r.status}`}`, cls: 'vn-cs vn-cs-err' });
        new Notice(`Chat config rejected: ${j.error ?? r.status}`);
        return;
      }
      this.chatStatusEl.createEl('span', { text: `● live · ${j.chatModel}`, cls: 'vn-cs vn-cs-ok' });
      new Notice(`Chat model live: ${j.chatModel}`);
      void this.refreshStatus();
    } catch (e) {
      this.chatStatusEl.empty();
      const msg = e instanceof Error ? e.message : String(e);
      this.chatStatusEl.createEl('span', { text: `✕ ${msg}`, cls: 'vn-cs vn-cs-err' });
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
    // Single style block, scoped under .vaultnexus-settings → never leaks into theme.
    // Obsidian CSS vars do the heavy lifting → light/dark theme parity by construction.
    const style = c.createEl('style');
    style.textContent = `
      .vaultnexus-settings {
        --vn-serif: 'Iowan Old Style', 'Charter', 'Source Serif Pro', 'Source Serif 4',
                    'Cambria', Georgia, ui-serif, serif;
        --vn-mono: var(--font-monospace, ui-monospace, 'JetBrains Mono', 'IBM Plex Mono',
                    Menlo, Consolas, monospace);
        --vn-rule: color-mix(in srgb, var(--text-normal) 22%, transparent);
        --vn-rule-strong: var(--text-normal);
        --vn-accent: var(--interactive-accent);
        --vn-ok:   #2ea043;
        --vn-warn: #d4a526;
        --vn-down: #d05656;
        padding-bottom: 32px;
      }

      /* ── HERO ───────────────────────────────────────── */
      .vaultnexus-settings .vn-hero { margin: 4px 0 28px 0; }
      .vaultnexus-settings .vn-eyebrow {
        display: flex; align-items: center; gap: 8px;
        font-family: var(--vn-mono);
        font-size: 0.68em;
        letter-spacing: 0.18em;
        color: var(--text-muted);
        text-transform: uppercase;
      }
      .vaultnexus-settings .vn-eyebrow-sep { opacity: 0.5; }
      .vaultnexus-settings .vn-eyebrow-ver { color: var(--vn-accent); }
      .vaultnexus-settings .vn-hero-title {
        font-family: var(--vn-serif);
        font-style: italic;
        font-weight: 500;
        font-size: 2.4em;
        letter-spacing: -0.015em;
        margin: 6px 0 8px 0;
        line-height: 1.05;
        color: var(--text-normal);
      }
      .vaultnexus-settings .vn-hero-lede {
        margin: 0 0 18px 0;
        max-width: 56ch;
        color: var(--text-muted);
        font-size: 0.94em;
        line-height: 1.5;
      }
      .vaultnexus-settings .vn-rule {
        height: 1px; background: var(--vn-rule); margin: 0;
      }
      .vaultnexus-settings .vn-rule-strong {
        height: 2px; background: var(--vn-rule-strong); opacity: 0.85;
      }

      /* ── STATUS GRID ────────────────────────────────── */
      .vaultnexus-settings .vn-panel {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 0;
        margin: 18px 0 0 0;
        border: 1px solid var(--vn-rule);
        border-bottom: none;
      }
      .vaultnexus-settings .vn-cell {
        padding: 14px 16px 16px 16px;
        border-right: 1px solid var(--vn-rule);
        border-bottom: 1px solid var(--vn-rule);
        display: flex; flex-direction: column; gap: 6px;
        background:
          repeating-linear-gradient(
            135deg,
            transparent 0,
            transparent 24px,
            color-mix(in srgb, var(--text-normal) 1.5%, transparent) 24px,
            color-mix(in srgb, var(--text-normal) 1.5%, transparent) 25px
          );
      }
      .vaultnexus-settings .vn-cell:last-child { border-right: none; }
      .vaultnexus-settings .vn-cell-head {
        display: flex; align-items: center; justify-content: space-between;
      }
      .vaultnexus-settings .vn-cell-label {
        font-family: var(--vn-mono);
        font-size: 0.62em;
        letter-spacing: 0.22em;
        color: var(--text-muted);
        font-weight: 600;
      }
      .vaultnexus-settings .vn-cell-num {
        font-family: var(--vn-mono);
        font-variant-numeric: tabular-nums;
        font-size: 1.7em;
        font-weight: 500;
        color: var(--text-normal);
        line-height: 1.1;
        letter-spacing: -0.01em;
      }
      .vaultnexus-settings .vn-cell-sub {
        font-size: 0.78em;
        color: var(--text-faint);
        font-style: italic;
        min-height: 1.1em;
      }

      /* Broadcast cue lamp — solid dot with inner glow. */
      .vaultnexus-settings .vn-lamp {
        width: 9px; height: 9px; border-radius: 50%;
        display: inline-block;
        box-shadow: 0 0 0 1px color-mix(in srgb, var(--text-normal) 35%, transparent),
                    inset 0 -1px 0 rgba(0,0,0,0.25);
      }
      .vaultnexus-settings .vn-lamp-ok      { background: var(--vn-ok);
        box-shadow: 0 0 0 1px color-mix(in srgb, var(--vn-ok) 70%, transparent),
                    0 0 8px color-mix(in srgb, var(--vn-ok) 60%, transparent),
                    inset 0 -1px 0 rgba(0,0,0,0.25); }
      .vaultnexus-settings .vn-lamp-warn    { background: var(--vn-warn);
        box-shadow: 0 0 0 1px color-mix(in srgb, var(--vn-warn) 70%, transparent),
                    0 0 8px  color-mix(in srgb, var(--vn-warn) 50%, transparent),
                    inset 0 -1px 0 rgba(0,0,0,0.25); }
      .vaultnexus-settings .vn-lamp-down    { background: var(--vn-down);
        box-shadow: 0 0 0 1px color-mix(in srgb, var(--vn-down) 70%, transparent),
                    0 0 8px  color-mix(in srgb, var(--vn-down) 60%, transparent),
                    inset 0 -1px 0 rgba(0,0,0,0.25); }
      .vaultnexus-settings .vn-lamp-unknown { background: var(--text-faint); }
      .vaultnexus-settings .vn-lamp-probe   {
        background: var(--vn-accent);
        animation: vn-lamp-pulse 1.1s ease-in-out infinite;
      }
      @keyframes vn-lamp-pulse {
        0%, 100% { opacity: 0.35; }
        50%      { opacity: 1; }
      }

      /* ── TOOLS BAR ──────────────────────────────────── */
      .vaultnexus-settings .vn-tools {
        margin: 0 0 28px 0;
        padding: 10px 14px;
        border: 1px solid var(--vn-rule);
        border-top: none;
        background: color-mix(in srgb, var(--text-normal) 2%, transparent);
      }
      .vaultnexus-settings .vn-tools:empty { display: none; }
      .vaultnexus-settings .vn-tools-head {
        display: flex; align-items: center; gap: 8px;
        margin-bottom: 6px;
      }
      .vaultnexus-settings .vn-tools-label {
        font-family: var(--vn-mono);
        font-size: 0.6em;
        letter-spacing: 0.22em;
        color: var(--text-muted);
        font-weight: 600;
      }
      .vaultnexus-settings .vn-tools-count {
        font-family: var(--vn-mono);
        font-variant-numeric: tabular-nums;
        font-size: 0.72em;
        color: var(--vn-accent);
        padding: 0 6px;
        border: 1px solid color-mix(in srgb, var(--vn-accent) 50%, transparent);
      }
      .vaultnexus-settings .vn-tools-list {
        display: flex; flex-wrap: wrap;
        column-gap: 14px; row-gap: 2px;
      }
      .vaultnexus-settings .vn-tools-item {
        font-family: var(--vn-mono);
        font-size: 0.78em;
        color: var(--text-muted);
      }

      /* ── SECTIONS ───────────────────────────────────── */
      .vaultnexus-settings .vn-section { margin: 28px 0 6px 0; }
      .vaultnexus-settings .vn-section-top {
        display: flex; align-items: baseline; gap: 14px;
        margin-bottom: 6px;
      }
      .vaultnexus-settings .vn-section-num {
        font-family: var(--vn-mono);
        font-variant-numeric: tabular-nums;
        font-size: 0.78em;
        letter-spacing: 0.06em;
        color: var(--vn-accent);
        font-weight: 600;
      }
      .vaultnexus-settings .vn-section-name {
        font-family: var(--vn-serif);
        font-style: italic;
        font-weight: 500;
        font-size: 1.4em;
        color: var(--text-normal);
        letter-spacing: -0.005em;
      }
      .vaultnexus-settings .vn-section-desc {
        margin: 8px 0 0 0;
        max-width: 64ch;
        font-size: 0.88em;
        color: var(--text-muted);
        line-height: 1.5;
      }

      /* Field rows w/ underline-only inputs (Bauhaus). */
      .vaultnexus-settings .vn-row { display: grid; gap: 18px; margin: 18px 0 8px 0; }
      .vaultnexus-settings .vn-row-3 { grid-template-columns: 2fr 1fr auto; }
      .vaultnexus-settings .vn-field { display: flex; flex-direction: column; gap: 6px; }
      .vaultnexus-settings .vn-field-action { align-self: end; }
      .vaultnexus-settings .vn-field label {
        font-family: var(--vn-mono);
        font-size: 0.62em;
        letter-spacing: 0.22em;
        text-transform: uppercase;
        color: var(--text-muted);
        font-weight: 600;
      }
      .vaultnexus-settings .vn-field input {
        background: transparent;
        border: none;
        border-bottom: 1px solid var(--vn-rule);
        padding: 4px 0;
        font-family: var(--vn-mono);
        font-size: 0.95em;
        color: var(--text-normal);
        border-radius: 0;
        box-shadow: none;
        transition: border-color 120ms ease;
      }
      .vaultnexus-settings .vn-field input:focus {
        outline: none;
        border-bottom: 1px solid var(--vn-accent);
        box-shadow: none;
      }

      /* Buttons: rectangular, monospace label, accent fill for primary. */
      .vaultnexus-settings .vn-btn {
        font-family: var(--vn-mono);
        font-size: 0.72em;
        letter-spacing: 0.18em;
        padding: 8px 16px;
        border-radius: 0;
        border: 1px solid currentColor;
        cursor: pointer;
        transition: background 120ms ease, color 120ms ease;
      }
      .vaultnexus-settings .vn-btn-primary {
        background: var(--vn-accent);
        color: var(--text-on-accent, #fff);
        border-color: var(--vn-accent);
      }
      .vaultnexus-settings .vn-btn-primary:hover {
        background: color-mix(in srgb, var(--vn-accent) 85%, black);
      }
      .vaultnexus-settings .vn-btn-ghost {
        background: transparent;
        color: var(--text-muted);
        border-color: var(--vn-rule);
      }
      .vaultnexus-settings .vn-btn-ghost:hover {
        color: var(--text-normal);
        border-color: var(--text-normal);
      }

      .vaultnexus-settings .vn-actions {
        display: flex; gap: 10px;
        margin: 18px 0 6px 0;
      }

      .vaultnexus-settings .vn-chat-status {
        min-height: 1.4em;
        font-family: var(--vn-mono);
        font-size: 0.82em;
        margin-top: 2px;
      }
      .vaultnexus-settings .vn-cs-ok      { color: var(--vn-ok); }
      .vaultnexus-settings .vn-cs-warn    { color: var(--vn-warn); }
      .vaultnexus-settings .vn-cs-err     { color: var(--vn-down); }
      .vaultnexus-settings .vn-cs-pending { color: var(--text-muted); }

      /* Re-style Obsidian's <Setting> rows → match section vibe (no rounded). */
      .vaultnexus-settings .setting-item {
        border-top: 1px dashed var(--vn-rule);
        padding: 14px 0;
      }
      .vaultnexus-settings .setting-item:first-of-type { border-top: none; }
      .vaultnexus-settings .setting-item-name {
        font-family: var(--vn-serif);
        font-size: 1.02em;
        letter-spacing: -0.005em;
      }
      .vaultnexus-settings .setting-item-description {
        font-size: 0.85em;
        color: var(--text-muted);
        line-height: 1.5;
      }
      .vaultnexus-settings .setting-item input[type="text"],
      .vaultnexus-settings .setting-item input[type="password"],
      .vaultnexus-settings .setting-item input[type="number"] {
        font-family: var(--vn-mono);
        border-radius: 0;
      }
      .vaultnexus-settings .setting-item .dropdown {
        font-family: var(--vn-mono);
        border-radius: 0;
      }

      /* ── ADVANCED <details> ─────────────────────────── */
      .vaultnexus-settings .vn-advanced {
        margin-top: 36px;
        padding: 12px 16px 16px 16px;
        border: 1px solid var(--vn-rule);
        background: color-mix(in srgb, var(--text-normal) 2%, transparent);
      }
      .vaultnexus-settings .vn-advanced summary {
        cursor: pointer;
        list-style: none;
        display: flex; align-items: baseline; gap: 4px;
        padding: 4px 0;
      }
      .vaultnexus-settings .vn-advanced summary::-webkit-details-marker { display: none; }
      .vaultnexus-settings .vn-advanced summary::before {
        content: '▸';
        font-family: var(--vn-mono);
        color: var(--text-muted);
        margin-right: 6px;
        transition: transform 120ms ease;
        display: inline-block;
      }
      .vaultnexus-settings .vn-advanced[open] summary::before { transform: rotate(90deg); }
      .vaultnexus-settings .vn-advanced-desc {
        margin: 8px 0 12px 0;
        color: var(--text-muted);
        font-size: 0.86em;
        max-width: 64ch;
      }
      .vaultnexus-settings table.vn-env {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.86em;
      }
      .vaultnexus-settings table.vn-env td {
        padding: 6px 0;
        vertical-align: top;
        border-top: 1px dashed var(--vn-rule);
      }
      .vaultnexus-settings table.vn-env tr:first-child td { border-top: none; }
      .vaultnexus-settings table.vn-env td.vn-env-k {
        font-family: var(--vn-mono);
        color: var(--vn-accent);
        padding-right: 18px;
        white-space: nowrap;
        font-size: 0.95em;
      }
      .vaultnexus-settings table.vn-env td.vn-env-v {
        color: var(--text-muted);
      }

      /* ── FOOTER ─────────────────────────────────────── */
      .vaultnexus-settings .vn-foot {
        margin-top: 32px;
        text-align: center;
      }
      .vaultnexus-settings .vn-foot-mark {
        font-family: var(--vn-mono);
        font-size: 0.66em;
        letter-spacing: 0.4em;
        color: var(--text-faint);
      }
    `;
  }
}
