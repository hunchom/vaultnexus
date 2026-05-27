import { ItemView, WorkspaceLeaf, Notice } from 'obsidian';
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

export class VaultNexusSearchView extends ItemView {
  private inputEl!: HTMLInputElement;
  private resultsEl!: HTMLDivElement;
  private statusEl!: HTMLDivElement;

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

    const title = root.createEl('h4', { text: 'VaultNexus Search' });
    title.style.marginTop = '0';
    title.style.marginBottom = '6px';

    this.inputEl = root.createEl('input', {
      type: 'text',
      placeholder: 'Search vault…',
      cls: 'vaultnexus-input',
    });
    this.inputEl.style.width = '100%';
    this.inputEl.style.marginBottom = '6px';

    this.statusEl = root.createDiv({ cls: 'vaultnexus-search-status' });
    this.statusEl.style.fontSize = '0.75em';
    this.statusEl.style.color = 'var(--text-muted)';
    this.statusEl.style.marginBottom = '8px';

    this.resultsEl = root.createDiv({ cls: 'vaultnexus-results' });

    this.inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') void this.runSearch();
    });

    this.inputEl.focus();
  }

  async onClose(): Promise<void> { /* nothing to release */ }

  private async runSearch(): Promise<void> {
    const q = this.inputEl.value.trim();
    if (!q) return;
    const s = this.getSettings();
    this.resultsEl.empty();
    this.statusEl.setText(`Searching @ ${s.host}:${s.port}…`);

    try {
      const res = await fetch(`http://${s.host}:${s.port}/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: q, k: s.defaultK }),
      });

      if (!res.ok) {
        this.statusEl.setText('');
        this.resultsEl.createEl('p', {
          text: `Daemon error: HTTP ${res.status}. Is the VaultNexus daemon running on ${s.host}:${s.port}?`,
        });
        return;
      }
      const hits = (await res.json()) as SearchHit[];
      this.statusEl.setText(`${hits.length} hit${hits.length === 1 ? '' : 's'} for "${q}"`);
      if (hits.length === 0) {
        this.resultsEl.createEl('p', { text: 'No matches.' });
        return;
      }
      for (const h of hits) this.renderHit(h, s);
    } catch (err) {
      this.statusEl.setText('');
      const msg = err instanceof Error ? err.message : String(err);
      this.resultsEl.createEl('p', { text: `Fetch failed: ${msg}` });
      new Notice(`VaultNexus daemon unreachable @ ${s.host}:${s.port}.`);
    }
  }

  private renderHit(h: SearchHit, s: VaultNexusSettings): void {
    const item = this.resultsEl.createDiv({ cls: 'vaultnexus-hit' });
    item.style.padding = '8px 0';
    item.style.borderBottom = '1px solid var(--background-modifier-border)';

    const link = item.createEl('a', { text: h.notePath, href: '#' });
    link.style.fontWeight = '600';
    link.style.cursor = 'pointer';
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const linktext = h.headingPath.length
        ? `${h.notePath}#${h.headingPath.join('#')}`
        : h.notePath;
      this.app.workspace.openLinkText(linktext, '', false);
    });

    if (s.showHeading && h.headingPath.length > 0) {
      const hd = item.createEl('div', { text: '> ' + h.headingPath.join(' / '), cls: 'vaultnexus-heading' });
      hd.style.fontSize = '0.85em';
      hd.style.color = 'var(--text-muted)';
    }

    if (s.showPreview && h.text) {
      const preview = item.createEl('div', {
        text: h.text.slice(0, s.previewLen) + (h.text.length > s.previewLen ? '…' : ''),
        cls: 'vaultnexus-preview',
      });
      preview.style.fontSize = '0.85em';
      preview.style.color = 'var(--text-muted)';
      preview.style.marginTop = '4px';
    }

    if (s.showScore) {
      const score = item.createEl('div', { text: `score=${h.score.toFixed(3)}`, cls: 'vaultnexus-score' });
      score.style.fontSize = '0.75em';
      score.style.color = 'var(--text-faint)';
      score.style.marginTop = '2px';
    }
  }
}
