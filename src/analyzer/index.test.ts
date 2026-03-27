import { describe, test, expect } from "bun:test";
import { TrafficAnalyzer } from "./index.js";
import type { CapturedTransaction } from "../proxy/types.js";

function makeTx(overrides: Partial<CapturedTransaction> = {}): CapturedTransaction {
  return {
    id: Math.random().toString(36),
    timestamp: new Date().toISOString(),
    method: "GET",
    url: "https://example.com",
    reqHeaders: {},
    resHeaders: {},
    reqBody: null,
    reqBodyEncoding: null,
    reqBodyTruncated: false,
    resBody: null,
    resBodyEncoding: null,
    resBodyTruncated: false,
    statusCode: 200,
    durationMs: 50,
    error: null,
    contentEncoding: null,
    resBodyPreview: null,
    resBodyPreviewEncoding: null,
    ...overrides,
  };
}

describe("TrafficAnalyzer", () => {
  test("add() stores transaction", () => {
    const a = new TrafficAnalyzer();
    const tx = makeTx({ id: "test-1" });
    a.add(tx);
    expect(a.getAll()).toHaveLength(1);
    expect(a.getAll()[0].id).toBe("test-1");
  });

  test("add() emits transactionAdded event", () => {
    const a = new TrafficAnalyzer();
    let emitted = false;
    a.on("transactionAdded" as any, ({ transaction }: any) => {
      emitted = true;
      expect(transaction.id).toBe("test-emit");
    });
    a.add(makeTx({ id: "test-emit" }));
    expect(emitted).toBe(true);
  });

  test("add() emits statsUpdated event (throttled to once per second)", () => {
    const a = new TrafficAnalyzer();
    let statsCount = 0;
    a.on("statsUpdated" as any, () => { statsCount++; });
    a.add(makeTx());
    a.add(makeTx());
    expect(statsCount).toBe(1);
  });

  test("ring buffer evicts oldest when over limit", () => {
    const a = new TrafficAnalyzer(3);
    for (let i = 0; i < 5; i++) a.add(makeTx({ id: String(i) }));
    const all = a.getAll();
    expect(all).toHaveLength(3);
    expect(all.map((t) => t.id)).toEqual(["2", "3", "4"]);
  });

  test("getStats() returns correct totals and errors", () => {
    const a = new TrafficAnalyzer();
    a.add(makeTx({ statusCode: 200, durationMs: 10 }));
    a.add(makeTx({ statusCode: 404, durationMs: 5 }));
    a.add(makeTx({ statusCode: 500, durationMs: 20, error: "oops" }));
    const stats = a.getStats();
    expect(stats.total).toBe(3);
    expect(stats.errors).toBe(1);
  });

  test("getStats() computes p50 and p95 latency", () => {
    const a = new TrafficAnalyzer();
    for (let i = 1; i <= 10; i++) {
      a.add(makeTx({ durationMs: i * 10 }));
    }
    const stats = a.getStats();
    expect(stats.latencyP50ms).toBe(50);  // nearest-rank: ceil(0.50*10)=5, sorted[4]=50
    expect(stats.latencyP95ms).toBe(100);  // nearest-rank: ceil(0.95*10)=10, sorted[9]=100
  });
});
