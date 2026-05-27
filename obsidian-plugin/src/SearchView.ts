import { ItemView, WorkspaceLeaf, Notice, setIcon } from 'obsidian';
import type { VaultNexusSettings } from './settings.js';

export const VIEW_TYPE_VAULTNEXUS_SEARCH = 'vaultnexus-search';

interface SearchHit {
  notePath: string;
  headingPath: string[];
  byteStart: number; // reserved → future range-highlight in editor
  byteEnd: number;   // reserved → future range-highlight in editor
  text: string;
  score: number;
}

// Loopback chatter minimal; ticks feel live.
const HEALTH_PROBE_MS = 8000;

export class VaultNexusSearchView extends ItemView {
  private inputEl!: HTMLInputElement;
  private resultsEl!: HTMLDivElement;
  private statusEl!: HTMLDivElement;
  private connLampEl!: HTMLSpanElement;
  private connTextEl!: HTMLSpanElement;
  private probeTimer?: number;

  constructor(leaf: WorkspaceLeaf, private readonly getSettings: () => VaultNexusSettings) {
    super(leaf);
  }

  getViewType(): string { return VIEW_TYPE_VAULTNEXUS_SEARCH; }
  getDisplayText(): string { return 'VaultNexus'; }
  getIcon(): string { return 'search'; }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass('vaultnexus-search-view');
    this.injectStyles(root);

    // Eyebrow + title in editorial style → matches settings tab.
    const eyebrow = root.createDiv({ cls: 'vn-sv-eyebrow' });
    eyebrow.createEl('span', { text: 'VAULTNEXUS' });
    eyebrow.createEl('span', { text: '·', cls: 'vn-sv-sep' });
    this.connLampEl = eyebrow.createEl('span', { cls: 'vn-sv-lamp vn-sv-lamp-unknown' });
    this.connTextEl = eyebrow.createEl('span', { text: '…', cls: 'vn-sv-conn-text' });

    root.createEl('h3', { text: 'Semantic search', cls: 'vn-sv-title' });
    root.createDiv({ cls: 'vn-sv-rule' });

    const inputWrap = root.createDiv({ cls: 'vn-sv-input-wrap' });
    const iconEl = inputWrap.createEl('span', { cls: 'vn-sv-input-icon' });
    setIcon(iconEl, 'search');
    this.inputEl = inputWrap.createEl('input', {
      type: 'text',
      placeholder: 'query…',
      cls: 'vn-sv-input',
    });

    this.statusEl = root.createDiv({ cls: 'vn-sv-status' });
    this.resultsEl = root.createDiv({ cls: 'vn-sv-results' });

    this.inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') void this.runSearch();
    });
    this.inputEl.focus();

    void this.probeHealth();
    this.probeTimer = window.setInterval(() => void this.probeHealth(), HEALTH_PROBE_MS);
  }

  async onClose(): Promise<void> {
    if (this.probeTimer !== undefined) window.clearInterval(this.probeTimer);
  }

  private async probeHealth(): Promise<void> {
    const s = this.getSettings();
    try {
      const r = await fetch(`http://${s.host}:${s.port}/health`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { status: string; version: string };
      this.setConn('ok', `v${j.version} · ${s.host}:${s.port}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.setConn('down', `offline · ${s.host}:${s.port} (${msg})`);
    }
  }

  private setConn(state: 'ok' | 'down' | 'unknown', text: string): void {
    this.connLampEl.removeClasses(['vn-sv-lamp-ok', 'vn-sv-lamp-down', 'vn-sv-lamp-unknown']);
    this.connLampEl.addClass(`vn-sv-lamp-${state}`);
    this.connTextEl.setText(text);
  }

  private async runSearch(): Promise<void> {
    const q = this.inputEl.value.trim();
    if (!q) return;
    const s = this.getSettings();
    this.resultsEl.empty();
    this.statusEl.setText(`◐ searching "${q}"…`);

    const t0 = performance.now();
    try {
      const res = await fetch(`http://${s.host}:${s.port}/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: q, k: s.defaultK }),
      });

      if (!res.ok) {
        this.statusEl.setText('');
        this.renderError(`Daemon returned HTTP ${res.status}.`);
        return;
      }
      const hits = (await res.json()) as SearchHit[];
      const dt = Math.round(performance.now() - t0);
      this.statusEl.setText(`${hits.length} hit${hits.length === 1 ? '' : 's'} · ${dt}ms`);
      if (hits.length === 0) {
        this.renderEmpty(q);
        return;
      }
      hits.forEach((h, i) => this.renderHit(h, s, i + 1));
    } catch (err) {
      this.statusEl.setText('');
      const msg = err instanceof Error ? err.message : String(err);
      this.renderError(`Fetch failed: ${msg}`);
      new Notice(`VaultNexus daemon unreachable @ ${s.host}:${s.port}.`);
    }
  }

  private renderEmpty(q: string): void {
    const e = this.resultsEl.createDiv({ cls: 'vn-sv-empty' });
    e.createEl('div', { text: `no matches for "${q}"`, cls: 'vn-sv-empty-title' });
    e.createEl('div', {
      text: 'Try a broader paraphrase. Check daemon indexed your vault.',
      cls: 'vn-sv-empty-sub',
    });
  }

  private renderError(message: string): void {
    const e = this.resultsEl.createDiv({ cls: 'vn-sv-error' });
    e.createEl('div', { text: message, cls: 'vn-sv-error-title' });
    e.createEl('div', {
      text: 'Settings → VaultNexus → Probe for diagnostics.',
      cls: 'vn-sv-error-sub',
    });
  }

  private renderHit(h: SearchHit, s: VaultNexusSettings, rank: number): void {
    const item = this.resultsEl.createDiv({ cls: 'vn-sv-hit' });

    const head = item.createDiv({ cls: 'vn-sv-hit-head' });
    head.createEl('span', { text: String(rank).padStart(2, '0'), cls: 'vn-sv-hit-rank' });
    const link = head.createEl('a', { text: h.notePath, href: '#', cls: 'vn-sv-hit-link' });
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const linktext = h.headingPath.length
        ? `${h.notePath}#${h.headingPath.join('#')}`
        : h.notePath;
      this.app.workspace.openLinkText(linktext, '', false);
    });

    if (s.showHeading && h.headingPath.length > 0) {
      item.createEl('div', { text: '› ' + h.headingPath.join(' / '), cls: 'vn-sv-hit-heading' });
    }
    if (s.showPreview && h.text) {
      const txt = h.text.length > s.previewLen ? h.text.slice(0, s.previewLen) + '…' : h.text;
      item.createEl('div', { text: txt, cls: 'vn-sv-hit-preview' });
    }
    if (s.showScore && typeof h.score === 'number') {
      item.createEl('div', { text: h.score.toFixed(3), cls: 'vn-sv-hit-score' });
    }
  }

  private injectStyles(root: HTMLElement): void {
    const style = root.createEl('style');
    style.textContent = `
      .vaultnexus-search-view {
        --vn-serif: 'Iowan Old Style','Charter','Source Serif Pro','Source Serif 4','Cambria',Georgia,ui-serif,serif;
        --vn-mono: var(--font-monospace, ui-monospace,'JetBrains Mono','IBM Plex Mono',Menlo,Consolas,monospace);
        --vn-rule: color-mix(in srgb, var(--text-normal) 22%, transparent);
        --vn-accent: var(--interactive-accent);
        --vn-ok: #2ea043; --vn-down: #d05656;
        padding: 4px 2px;
      }
      .vaultnexus-search-view .vn-sv-eyebrow {
        display: flex; align-items: center; gap: 6px;
        font-family: var(--vn-mono);
        font-size: 0.66em;
        letter-spacing: 0.18em;
        text-transform: uppercase;
        color: var(--text-muted);
      }
      .vaultnexus-search-view .vn-sv-sep { opacity: 0.5; }
      .vaultnexus-search-view .vn-sv-lamp {
        width: 7px; height: 7px; border-radius: 50%;
        display: inline-block;
        background: var(--text-faint);
      }
      .vaultnexus-search-view .vn-sv-lamp-ok      { background: var(--vn-ok);
        box-shadow: 0 0 6px color-mix(in srgb, var(--vn-ok) 60%, transparent); }
      .vaultnexus-search-view .vn-sv-lamp-down    { background: var(--vn-down);
        box-shadow: 0 0 6px color-mix(in srgb, var(--vn-down) 60%, transparent); }
      .vaultnexus-search-view .vn-sv-lamp-unknown { background: var(--text-faint); }
      .vaultnexus-search-view .vn-sv-conn-text {
        font-family: var(--vn-mono);
        text-transform: none;
        letter-spacing: 0;
        color: var(--text-muted);
      }
      .vaultnexus-search-view .vn-sv-title {
        font-family: var(--vn-serif);
        font-style: italic;
        font-weight: 500;
        font-size: 1.35em;
        margin: 4px 0 8px 0;
        letter-spacing: -0.005em;
      }
      .vaultnexus-search-view .vn-sv-rule {
        height: 1px; background: var(--vn-rule); margin: 0 0 12px 0;
      }
      .vaultnexus-search-view .vn-sv-input-wrap {
        position: relative;
        margin-bottom: 10px;
      }
      .vaultnexus-search-view .vn-sv-input-icon {
        position: absolute; left: 2px; top: 50%;
        transform: translateY(-50%);
        color: var(--text-muted);
        pointer-events: none;
        display: inline-flex;
      }
      .vaultnexus-search-view .vn-sv-input {
        width: 100%;
        background: transparent;
        border: none;
        border-bottom: 1px solid var(--vn-rule);
        border-radius: 0;
        padding: 6px 4px 6px 24px;
        font-family: var(--vn-mono);
        font-size: 0.95em;
        color: var(--text-normal);
        box-shadow: none;
      }
      .vaultnexus-search-view .vn-sv-input:focus {
        outline: none;
        border-bottom: 1px solid var(--vn-accent);
        box-shadow: none;
      }
      .vaultnexus-search-view .vn-sv-status {
        font-family: var(--vn-mono);
        font-size: 0.72em;
        letter-spacing: 0.06em;
        color: var(--text-muted);
        min-height: 1.2em;
        margin-bottom: 10px;
      }
      .vaultnexus-search-view .vn-sv-hit {
        padding: 10px 0;
        border-top: 1px dashed var(--vn-rule);
      }
      .vaultnexus-search-view .vn-sv-hit:first-child { border-top: none; }
      .vaultnexus-search-view .vn-sv-hit-head {
        display: flex; align-items: baseline; gap: 8px;
      }
      .vaultnexus-search-view .vn-sv-hit-rank {
        font-family: var(--vn-mono);
        font-variant-numeric: tabular-nums;
        font-size: 0.72em;
        color: var(--vn-accent);
        font-weight: 600;
      }
      .vaultnexus-search-view .vn-sv-hit-link {
        font-family: var(--vn-serif);
        font-style: italic;
        font-size: 1.02em;
        font-weight: 500;
        cursor: pointer;
        color: var(--text-normal);
      }
      .vaultnexus-search-view .vn-sv-hit-link:hover {
        color: var(--vn-accent);
      }
      .vaultnexus-search-view .vn-sv-hit-heading {
        margin: 3px 0 0 26px;
        font-family: var(--vn-mono);
        font-size: 0.74em;
        color: var(--text-muted);
        letter-spacing: 0.02em;
      }
      .vaultnexus-search-view .vn-sv-hit-preview {
        margin: 6px 0 0 26px;
        font-size: 0.86em;
        color: var(--text-normal);
        line-height: 1.5;
      }
      .vaultnexus-search-view .vn-sv-hit-score {
        margin: 4px 0 0 26px;
        font-family: var(--vn-mono);
        font-variant-numeric: tabular-nums;
        font-size: 0.7em;
        color: var(--text-faint);
        letter-spacing: 0.04em;
      }
      .vaultnexus-search-view .vn-sv-empty,
      .vaultnexus-search-view .vn-sv-error {
        padding: 18px 12px;
        text-align: center;
        border: 1px dashed var(--vn-rule);
        color: var(--text-muted);
        font-family: var(--vn-mono);
        font-size: 0.84em;
      }
      .vaultnexus-search-view .vn-sv-error { border-color: color-mix(in srgb, var(--vn-down) 50%, transparent); }
      .vaultnexus-search-view .vn-sv-empty-title,
      .vaultnexus-search-view .vn-sv-error-title { font-weight: 600; color: var(--text-normal); }
      .vaultnexus-search-view .vn-sv-empty-sub,
      .vaultnexus-search-view .vn-sv-error-sub {
        margin-top: 6px;
        font-size: 0.84em;
        color: var(--text-faint);
        font-family: var(--vn-mono);
      }
    `;
  }
}
