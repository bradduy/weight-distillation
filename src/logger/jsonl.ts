import { appendFileSync, mkdirSync, openSync, closeSync } from "node:fs";
import { dirname } from "node:path";
import type { CapturedTransaction } from "../proxy/types.ts";

export class JsonlLogger {
  private fd: number;
  private queue: string[] = [];
  private closed = false;

  constructor(private logPath: string) {
    mkdirSync(dirname(logPath), { recursive: true });
    this.fd = openSync(logPath, "a");
  }

  write(record: CapturedTransaction): void {
    if (this.closed) return;
    this.queue.push(JSON.stringify(record));
    this._flushSync();
  }

  private _flushSync(): void {
    if (this.queue.length === 0) return;
    const batch = this.queue.join("\n") + "\n";
    this.queue = [];
    appendFileSync(this.fd, batch);
  }

  async flush(): Promise<void> {
    this._flushSync();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this._flushSync();
    closeSync(this.fd);
  }
}
