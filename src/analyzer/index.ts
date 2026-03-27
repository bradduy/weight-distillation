import { EventEmitter } from "node:events";
import type { CapturedTransaction, StatsSnapshot } from "../proxy/types.js";

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  // Nearest-rank method: rank = ceil(p/100 * n)
  const rank = Math.ceil((p / 100) * n);
  const idx = Math.min(rank - 1, n - 1); // clamp to array bounds
  return sorted[idx];
}

const STATS_THROTTLE_MS = 1000;

// Note: we avoid EventEmitter<AnalyzerEvent> because AnalyzerEvent is a discriminated
// union (TS-native event pattern), not a Node.js EventMap record.
// This class is compatible with the event shapes defined in AnalyzerEvent.
export class TrafficAnalyzer extends EventEmitter {
  private records: CapturedTransaction[] = [];
  private readonly maxRecords: number;
  private lastStatsEmit = 0;

  constructor(maxRecords = 10_000) {
    super();
    this.maxRecords = maxRecords;
  }

  add(transaction: CapturedTransaction): void {
    this.records.push(transaction);
    if (this.records.length > this.maxRecords) {
      this.records.shift();
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.emit("transactionAdded", { transaction } as any);

    const now = Date.now();
    if (now - this.lastStatsEmit >= STATS_THROTTLE_MS) {
      this.lastStatsEmit = now;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.emit("statsUpdated", { stats: this.getStats() } as any);
    }
  }

  getAll(): CapturedTransaction[] {
    return [...this.records];
  }

  getStats(): StatsSnapshot {
    const durations = this.records.map((r) => r.durationMs);
    const total = this.records.length;
    const errors = this.records.filter((r) => r.error !== null).length;
    return {
      total,
      errors,
      latencyP50ms: percentile(durations, 50),
      latencyP95ms: percentile(durations, 95),
    };
  }
}
