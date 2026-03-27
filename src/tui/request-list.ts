import type { CapturedTransaction } from "../proxy/types.js";
import type { TrafficAnalyzer } from "../analyzer/index.js";

export interface RequestListOptions {
  parent: any;  // blessed.Element
  analyser: TrafficAnalyzer;
  onSelect: (tx: CapturedTransaction | null) => void;
}

export class RequestList {
  private list: any;
  private selectedIndex = 0;
  private items: CapturedTransaction[] = [];
  private onSelect: (tx: CapturedTransaction | null) => void;

  constructor(opts: RequestListOptions) {
    this.onSelect = opts.onSelect;
    this.list = opts.parent;
  }

  addItem(tx: CapturedTransaction): void {
    this.items.push(tx);
    const path = this.getPath(tx.url);
    // Show AI model when detected
    const aiTag = tx.aiModel
      ? ` ${tx.aiProvider}/${tx.aiModel}`
      : "";
    const label =
      `${tx.method.padEnd(8)} ${path.slice(0, 36).padEnd(36)} ` +
      `${String(tx.statusCode).padStart(3)} ${String(tx.durationMs).padStart(5)}ms${aiTag}`;
    const style = tx.error ? { fg: "red" } : tx.aiProvider ? { fg: "cyan" } : tx.statusCode >= 400 ? { fg: "yellow" } : {};
    // @ts-ignore — blessed option types
    this.list.add(label, { style });
    this.list.setScrollPerc(100);
  }

  private getPath(url: string): string {
    try {
      const u = new URL(url);
      return u.pathname + u.search;
    } catch {
      return url;
    }
  }

  clear(): void {
    this.items = [];
    // @ts-ignore
    this.list.clearItems();
    this.onSelect(null);
  }

  getSelected(): CapturedTransaction | null {
    return this.items[this.selectedIndex] ?? null;
  }

  selectNext(): void {
    this.selectedIndex = Math.min(this.selectedIndex + 1, this.items.length - 1);
    this.list.select(this.selectedIndex);
    this.onSelect(this.items[this.selectedIndex] ?? null);
  }

  selectPrev(): void {
    this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
    this.list.select(this.selectedIndex);
    this.onSelect(this.items[this.selectedIndex] ?? null);
  }
}
