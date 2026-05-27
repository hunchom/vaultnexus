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

// Health probe cadence → keep loopback chatter minimal but feel live.
const HEALTH_PROBE_MS = 8000;

export class VaultNexusSearchView extends ItemView {
  private inputEl!: HTMLInputElement;
  private resultsEl!: HTMLDivElement;
  private statusEl!: HTMLDivElement;
  private connDotEl!: HTMLSpanElement;
  private connTextEl!: HTMLSpanElement;
  private probeTimer?: number;

  constructor(leaf: WorkspaceLeaf, private readonly getSettings: () => VaultNexusSettings) {
    super(leaf);
  }

  getViewType(): string { return VIEW_TYPE_VAULTNEXUS_SEARCH; }
  getDisplayText(): string { return 'VaultNexus Search'; }
  getIcon(): string { return 'search'; }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass('vaultnexus-search-view');
    this.injectStyles(root);

    const header = root.createDiv({ cls: 'vn-header' });
    const title = header.createEl('h4', { text: 'VaultNexus' });
    title.style.margin = '0 0 0 0';
    const conn = header.createDiv({ cls: 'vn-conn' });
    this.connDotEl = conn.createEl('span', { cls: 'vn-conn-dot vn-conn-unknown' });
    this.connTextEl = conn.createEl('span', { text: 'checking…', cls: 'vn-conn-text' });

    const inputWrap = root.createDiv({ cls: 'vn-input-wrap' });
    const iconEl = inputWrap.createEl('span', { cls: 'vn-input-icon' });
    setIcon(iconEl, 'search');
    this.inputEl = inputWrap.createEl('input', {
      type: 'text',
      placeholder: 'Search vault…',
      cls: 'vn-input',
    });

    this.statusEl = root.createDiv({ cls: 'vn-status' });

    this.resultsEl = root.createDiv({ cls: 'vn-results' });

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
      this.setConn('ok', `daemon v${j.version} @ ${s.host}:${s.port}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.setConn('down', `unreachable @ ${s.host}:${s.port} (${msg})`);
    }
  }

  private setConn(state: 'ok' | 'down' | 'unknown', text: string): void {
    this.connDotEl.removeClasses(['vn-conn-ok', 'vn-conn-down', 'vn-conn-unknown']);
    this.connDotEl.addClass(`vn-conn-${state}`);
    this.connTextEl.setText(text);
  }

  private async runSearch(): Promise<void> {
    const q = this.inputEl.value.trim();
    if (!q) return;
    const s = this.getSettings();
    this.resultsEl.empty();
    this.statusEl.setText(`Searching for “${q}”…`);

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
      this.statusEl.setText(`${hits.length} hit${hits.length === 1 ? '' : 's'} in ${dt} ms`);
      if (hits.length === 0) {
        this.renderEmpty(q);
        return;
      }
      for (const h of hits) this.renderHit(h, s);
    } catch (err) {
      this.statusEl.setText('');
      const msg = err instanceof Error ? err.message : String(err);
      this.renderError(`Fetch failed: ${msg}`);
      new Notice(`VaultNexus daemon unreachable @ ${s.host}:${s.port}.`);
    }
  }

  private renderEmpty(q: string): void {
    const e = this.resultsEl.createDiv({ cls: 'vn-empty' });
    e.createEl('div', { text: `No matches for “${q}”.` });
    e.createEl('div', {
      text: 'Try a broader paraphrase, or check the daemon indexed your vault.',
      cls: 'vn-empty-sub',
    });
  }

  private renderError(message: string): void {
    const e = this.resultsEl.createDiv({ cls: 'vn-error' });
    e.createEl('div', { text: message });
    e.createEl('div', {
      text: 'Open Settings → VaultNexus → Test connection for diagnostics.',
      cls: 'vn-error-sub',
    });
  }

  private renderHit(h: SearchHit, s: VaultNexusSettings): void {
    const item = this.resultsEl.createDiv({ cls: 'vn-hit' });

    const link = item.createEl('a', { text: h.notePath, href: '#', cls: 'vn-hit-link' });
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const linktext = h.headingPath.length
        ? `${h.notePath}#${h.headingPath.join('#')}`
        : h.notePath;
      this.app.workspace.openLinkText(linktext, '', false);
    });

    if (s.showHeading && h.headingPath.length > 0) {
      item.createEl('div', { text: '› ' + h.headingPath.join(' / '), cls: 'vn-hit-heading' });
    }

    if (s.showPreview && h.text) {
      const txt = h.text.length > s.previewLen ? h.text.slice(0, s.previewLen) + '…' : h.text;
      item.createEl('div', { text: txt, cls: 'vn-hit-preview' });
    }

    if (s.showScore && typeof h.score === 'number') {
      item.createEl('div', { text: `${h.score.toFixed(3)}`, cls: 'vn-hit-score' });
    }
  }

  private injectStyles(root: HTMLElement): void {
    const style = root.createEl('style');
    style.textContent = `
      .vaultnexus-search-view .vn-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin: 0 0 12px 0;
      }
      .vaultnexus-search-view .vn-conn {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 0.75em;
        color: var(--text-muted);
      }
      .vaultnexus-search-view .vn-conn-dot {
        display: inline-block;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--text-faint);
      }
      .vaultnexus-search-view .vn-conn-ok       { background: var(--color-green, #2ea043); }
      .vaultnexus-search-view .vn-conn-down     { background: var(--color-red,   #d05656); }
      .vaultnexus-search-view .vn-conn-unknown  { background: var(--text-faint); }
      .vaultnexus-search-view .vn-input-wrap {
        position: relative;
        margin-bottom: 8px;
      }
      .vaultnexus-search-view .vn-input-icon {
        position: absolute;
        left: 8px;
        top: 50%;
        transform: translateY(-50%);
        color: var(--text-muted);
        display: inline-flex;
        pointer-events: none;
      }
      .vaultnexus-search-view .vn-input {
        width: 100%;
        padding-left: 30px;
      }
      .vaultnexus-search-view .vn-status {
        font-size: 0.75em;
        color: var(--text-muted);
        min-height: 1.2em;
        margin-bottom: 8px;
      }
      .vaultnexus-search-view .vn-hit {
        padding: 8px 0;
        border-bottom: 1px solid var(--background-modifier-border);
      }
      .vaultnexus-search-view .vn-hit-link {
        font-weight: 600;
        cursor: pointer;
      }
      .vaultnexus-search-view .vn-hit-heading {
        margin-top: 2px;
        font-size: 0.82em;
        color: var(--text-muted);
      }
      .vaultnexus-search-view .vn-hit-preview {
        margin-top: 4px;
        font-size: 0.85em;
        color: var(--text-normal);
        line-height: 1.4;
      }
      .vaultnexus-search-view .vn-hit-score {
        margin-top: 3px;
        font-size: 0.72em;
        font-family: var(--font-monospace);
        color: var(--text-faint);
      }
      .vaultnexus-search-view .vn-empty,
      .vaultnexus-search-view .vn-error {
        padding: 16px 8px;
        text-align: center;
        border: 1px dashed var(--background-modifier-border);
        border-radius: 6px;
        color: var(--text-muted);
      }
      .vaultnexus-search-view .vn-error { border-color: var(--color-red, #d05656); }
      .vaultnexus-search-view .vn-empty-sub,
      .vaultnexus-search-view .vn-error-sub {
        margin-top: 4px;
        font-size: 0.8em;
        color: var(--text-faint);
      }
    `;
  }
}
