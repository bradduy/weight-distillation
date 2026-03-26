# HTTP Proxy Traffic Analyzer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Bun/TypeScript MITM HTTP proxy that logs traffic to JSONL and displays it in a real-time TUI.

**Architecture:** MITM proxy via node-forge CA + per-host leaf certs. Single-process: Bun event loop drives both proxy socket I/O and Blessed TUI callbacks. JSONL append-only log. TrafficAnalyzer ring buffer (10k records) emits events to TUI.

**Tech Stack:** Bun, TypeScript, node-forge (PKI), blessed (TUI)

---

## File Map

| File | Responsibility |
|---|---|
| `package.json` | Dependencies: bun, typescript, node-forge, blessed, @types/bun |
| `tsconfig.json` | Target ES2022, module nodenext, strict |
| `src/proxy/types.ts` | All shared interfaces: `CapturedTransaction`, `AnalyzerEvent`, `StatsSnapshot`, `ProxyOptions` |
| `src/logger/jsonl.ts` | `JsonlLogger` — buffered append-only writer |
| `src/analyzer/index.ts` | `TrafficAnalyzer` — ring buffer + event emitter |
| `src/proxy/mitm.ts` | CA generation, leaf cert signing, cert cache with lazy TTL |
| `src/proxy/server.ts` | `ProxyServer` — HTTP CONNECT + MITM TLS pipelining |
| `src/tui/request-list.ts` | Request table widget |
| `src/tui/detail-panel.ts` | Detail view widget |
| `src/tui/index.ts` | TUI app bootstrap + blessed screen |
| `src/cli.ts` | Entry point: arg parsing, startup, signal handling |
| `README.md` | Usage, install, CA trust instructions |

---

## Setup

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "mitm-proxy",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "build": "bun build src/cli.ts --outdir=dist --target=bun",
    "typecheck": "bun tsc --noEmit",
    "start": "bun run src/cli.ts",
    "test": "bun test"
  },
  "dependencies": {
    "blessed": "^0.1.81",
    "node-forge": "^1.3.1"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "@types/node": "^20",
    "typescript": "^5.0.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Install dependencies**

Run: `bun install`
Expected: node_modules created, all deps resolved

- [ ] **Step 4: Commit**

```bash
git add package.json tsconfig.json && git commit -m "chore: scaffold project with bun, ts, node-forge, blessed

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 1: Shared Types (`src/proxy/types.ts`)

**Files:**
- Create: `src/proxy/types.ts`

- [ ] **Step 1: Create `src/proxy/types.ts`**

```ts
export interface CapturedTransaction {
  id: string;
  timestamp: string;
  method: string;
  url: string;
  reqHeaders: Record<string, string>;
  resHeaders: Record<string, string>;
  reqBody: string | null;
  reqBodyEncoding: "utf8" | "base64" | null;
  reqBodyTruncated: boolean;
  resBody: string | null;
  resBodyEncoding: "utf8" | "base64" | null;
  resBodyTruncated: boolean;
  statusCode: number;
  durationMs: number;
  error: string | null;
  contentEncoding: string | null;
  resBodyPreview: string | null;
  resBodyPreviewEncoding: string | null;
}

export type AnalyzerEvent =
  | { type: "transactionAdded"; transaction: CapturedTransaction }
  | { type: "statsUpdated"; stats: StatsSnapshot };

export interface StatsSnapshot {
  total: number;
  errors: number;
  latencyP50ms: number;
  latencyP95ms: number;
}

export interface ProxyOptions {
  host: string;
  port: number;
  mode: "explicit" | "transparent";
  caCertPath: string;
  caKeyPath: string;
  maxBodyBytes: number;
  onTransaction: (tx: CapturedTransaction) => void;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/proxy/types.ts && git commit -m "feat: add shared types (CapturedTransaction, AnalyzerEvent, ProxyOptions)

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: JSONL Logger (`src/logger/jsonl.ts`)

**Files:**
- Create: `src/logger/jsonl.ts`
- Create: `src/logger/jsonl.test.ts`

**Contract:**
- `constructor(logPath: string)` — creates dir if missing, opens file for append
- `write(record)` — queues JSON string + newline; never writes partial lines
- `flush()` — drains queue to OS
- `close()` — flushes then closes fd

- [ ] **Step 1: Write the failing test — `src/logger/jsonl.test.ts`**

```ts
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, unlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { JsonlLogger } from "./jsonl";

describe("JsonlLogger", () => {
  let tmpDir: string;

  test("write() appends a valid JSON line", async () => {
    tmpDir = await mkdtemp(tmpdir() + "/jsonl-test-");
    const logPath = tmpDir + "/traffic.jsonl";
    const logger = new JsonlLogger(logPath);
    await logger.flush();

    const record = { id: "abc", timestamp: "2026-03-26T00:00:00Z", method: "GET", url: "https://example.com", reqHeaders: {}, resHeaders: {}, reqBody: null, reqBodyEncoding: null, reqBodyTruncated: false, resBody: null, resBodyEncoding: null, resBodyTruncated: false, statusCode: 200, durationMs: 10, error: null, contentEncoding: null, resBodyPreview: null, resBodyPreviewEncoding: null };
    logger.write(record);
    await logger.close();

    const content = Bun.file(logPath).text();
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.id).toBe("abc");
    expect(parsed.statusCode).toBe(200);
  });

  test("write() does not produce partial lines on multiple writes", async () => {
    tmpDir = await mkdtemp(tmpdir() + "/jsonl-test-");
    const logPath = tmpDir + "/multi.jsonl";
    const logger = new JsonlLogger(logPath);

    for (let i = 0; i < 5; i++) {
      logger.write({ id: String(i), timestamp: "", method: "GET", url: "", reqHeaders: {}, resHeaders: {}, reqBody: null, reqBodyEncoding: null, reqBodyTruncated: false, resBody: null, resBodyEncoding: null, resBodyTruncated: false, statusCode: 200, durationMs: 0, error: null, contentEncoding: null, resBodyPreview: null, resBodyPreviewEncoding: null });
    }
    await logger.close();

    const content = Bun.file(logPath).text();
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(5);
    lines.forEach((line) => {
      expect(() => JSON.parse(line)).not.toThrow();
    });
  });

  test("close() is idempotent", async () => {
    tmpDir = await mkdtemp(tmpdir() + "/jsonl-test-");
    const logPath = tmpDir + "/close.jsonl";
    const logger = new JsonlLogger(logPath);
    await logger.close();
    await expect(logger.close()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/logger/jsonl.test.ts`
Expected: FAIL — `JsonlLogger` does not exist

- [ ] **Step 3: Write the implementation — `src/logger/jsonl.ts`**

```ts
import { appendFileSync, mkdirSync, openSync, closeSync, statSync } from "node:fs";
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
    appendFileSync(this.logPath, batch, { fd: this.fd });
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/logger/jsonl.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/logger/jsonl.ts src/logger/jsonl.test.ts && git commit -m "feat: add JsonlLogger (buffered append-only writer)

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Traffic Analyzer (`src/analyzer/index.ts`)

**Files:**
- Create: `src/analyzer/index.ts`
- Create: `src/analyzer/index.test.ts`

**Contract:**
- `constructor(maxRecords?: number)` — default 10,000
- `add(transaction)` — appends to ring buffer; emits `transactionAdded`
- `getAll()` — returns all records
- `getStats()` — returns `StatsSnapshot` with p50/p95 latency
- `statsUpdated` emitted at most once per second

- [ ] **Step 1: Write the failing test — `src/analyzer/index.test.ts`**

```ts
import { describe, test, expect } from "bun:test";
import { TrafficAnalyzer } from "./index";
import type { CapturedTransaction } from "../proxy/types";

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
    // 10 transactions with durations 10..100ms
    for (let i = 1; i <= 10; i++) {
      a.add(makeTx({ durationMs: i * 10 }));
    }
    const stats = a.getStats();
    expect(stats.latencyP50ms).toBe(55);  // median of [10,20,30,40,50,60,70,80,90,100]
    expect(stats.latencyP95ms).toBe(95);  // 95th percentile
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/analyzer/index.test.ts`
Expected: FAIL — `TrafficAnalyzer` does not exist

- [ ] **Step 3: Write the implementation — `src/analyzer/index.ts`**

```ts
import type { CapturedTransaction, StatsSnapshot } from "../proxy/types.ts";

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] * (hi - idx) + sorted[hi] * (idx - lo);
}

export class TrafficAnalyzer {
  private records: CapturedTransaction[] = [];
  private readonly maxRecords: number;
  private lastStatsEmit = 0;

  constructor(maxRecords = 10_000) {
    this.maxRecords = maxRecords;
  }

  add(transaction: CapturedTransaction): void {
    this.records.push(transaction);
    if (this.records.length > this.maxRecords) {
      this.records.shift();
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/analyzer/index.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/analyzer/index.ts src/analyzer/index.test.ts && git commit -m "feat: add TrafficAnalyzer (ring buffer + stats)

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: MITM Certificate Manager (`src/proxy/mitm.ts`)

**Files:**
- Create: `src/proxy/mitm.ts`

**Contract:**
- `ensureCa(certPath, keyPath)` — generates CA keypair if files don't exist, loads if they do; sets permissions to `0600`
- `getLeafCert(hostname, caKey)` — returns signed leaf cert PEM + private key; caches by hostname; invalidates if > 24h old
- Cache: `Map<hostname, { certPem, keyPem, createdAt }>`

**Important:** Uses `node-forge` for all PKI. Bun's `node:crypto` is NOT used for cert signing (node-forge handles RSA signing natively).

- [ ] **Step 1: Write the implementation — `src/proxy/mitm.ts`**

```ts
import * as forge from "node-forge";
import { readFileSync, writeFileSync, chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const CA_TTL_HOURS = 24;
const CA_VALIDITY_DAYS = 365;

interface CachedCert {
  certPem: string;
  keyPem: string;
  createdAt: number;
}

const certCache = new Map<string, CachedCert>();

export interface CaKeypair {
  certPem: string;
  keyPem: string;
}

export function ensureCa(certPath: string, keyPath: string): CaKeypair {
  mkdirSync(dirname(certPath), { recursive: true });
  if (existsSync(certPath) && existsSync(keyPath)) {
    return { certPem: readFileSync(certPath, "utf8"), keyPem: readFileSync(keyPath, "utf8") };
  }

  // Generate CA
  const ca = forge.pki.createCA();
  const attrs = [{ name: "commonName", value: "mitm-proxy CA" }];
  const caSerial = forge.util.bytesToHex(forge.util.createBuffer().fill(0, 20));
  const cert = forge.pki.createCertificate();
  cert.serialNumber = caSerial;
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setDate(cert.validity.notBefore.getDate() + CA_VALIDITY_DAYS);
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.publicKey = ca.publicKey;
  cert.setExtensions([
    { name: "basicConstraints", cA: true, pathLenConstraint: 0 },
    { name: "keyUsage", keyCertSign: true, digitalSignature: true, keyEncipherment: true },
  ]);
  cert.sign(ca, forge.md.sha256.create());

  const certPem = forge.pki.certificateToPem(cert);
  const keyPem = forge.pki.privateKeyToPem(ca);

  writeFileSync(certPath, certPem, { mode: 0o600 });
  writeFileSync(keyPath, keyPem, { mode: 0o600 });

  return { certPem, keyPem };
}

function getOrCreateCaKeypair(caCertPath: string, caKeyPath: string): CaKeypair {
  // Cache in memory for this process lifetime
  const cacheKey = `${caCertPath}:${caKeyPath}`;
  const cached = (globalThis as any).__caKeypair;
  if (cached) return cached;
  const kp = ensureCa(caCertPath, caKeyPath);
  (globalThis as any).__caKeypair = kp;
  return kp;
}

export function getLeafCert(
  hostname: string,
  caCertPath: string,
  caKeyPath: string,
): { certPem: string; keyPem: string } {
  const now = Date.now();
  const cached = certCache.get(hostname);
  if (cached && now - cached.createdAt < CA_TTL_HOURS * 60 * 60 * 1000) {
    return { certPem: cached.certPem, keyPem: cached.keyPem };
  }

  const { certPem: caCert, keyPem: caKey } = getOrCreateCaKeypair(caCertPath, caKeyPath);

  const caCertObj = forge.pki.certificateFromPem(caCert);
  const caKeyObj = forge.pki.privateKeyFromPem(caKey);

  // Generate RSA keypair for leaf cert
  const leafKeypair = forge.pki.rsa.generateKeyPair({ bits: 2048 });
  const leafSerial = forge.util.bytesToHex(forge.util.createBuffer().fill(0, 16));

  const leafCert = forge.pki.createCertificate();
  leafCert.serialNumber = leafSerial;
  leafCert.validity.notBefore = new Date();
  leafCert.validity.notAfter = new Date();
  leafCert.validity.notAfter.setDate(leafCert.validity.notBefore.getDate() + 1); // 1 day validity
  leafCert.setSubject([{ name: "commonName", value: hostname }]);
  leafCert.setIssuer(caCertObj.subject.attributes);
  leafCert.publicKey = leafKeypair.publicKey;
  leafCert.setExtensions([
    { name: "subjectAltName", altNames: [{ type: 2 /* DNS */, value: hostname }] },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
  ]);
  leafCert.sign(caKeyObj, forge.md.sha256.create());

  const leafCertPem = forge.pki.certificateToPem(leafCert);
  const leafKeyPem = forge.pki.privateKeyToPem(leafKeypair.privateKey);

  certCache.set(hostname, { certPem: leafCertPem, keyPem: leafKeyPem, createdAt: now });

  return { certPem: leafCertPem, keyPem: leafKeyPem };
}
```

- [ ] **Step 2: Typecheck**

Run: `bun tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/proxy/mitm.ts && git commit -m "feat: add MITM cert manager (CA generation, leaf cert signing, 24h TTL cache)

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Proxy Server (`src/proxy/server.ts`)

**Files:**
- Create: `src/proxy/server.ts`

**Contract:**
- `constructor(opts: ProxyOptions)`
- `start(): Promise<void>` — starts `node:http` server on configured host/port; logs to `onTransaction`
- `stop(): Promise<void>` — closes server, waits up to 5s for connections, force-closes

**HTTP MITM Pipeline (explicit mode):**
1. Client → `CONNECT host:port` → proxy
2. Proxy → `200 Connection Established` → client
3. Proxy opens TCP to `host:port` upstream
4. Proxy generates leaf cert, does TLS handshake with client
5. Proxy starts TLS handshake to upstream
6. Proxy reads HTTP request from client TLS stream → calls `onTransaction` with request data
7. Proxy forwards request to upstream
8. Proxy reads HTTP response → calls `onTransaction` with response data (status + headers + body)
9. Proxy writes response back to client
10. Proxy pipes remaining bytes bidirectionally (passthrough)

**Body capture logic:**
- Track accumulated body bytes against `maxBodyBytes`
- Set `*Truncated: true` if exceeded
- Apply encoding decision: UTF-8 if valid + text-like Content-Type, else base64

- [ ] **Step 1: Write the implementation — `src/proxy/server.ts`**

```ts
import * as http from "node:http";
import * as net from "node:net";
import * as tls from "node:tls";
import { createSecureContext } from "node:tls";
import { URL } from "node:url";
import { v4 as uuidv4 } from "uuid";
import type { CapturedTransaction, ProxyOptions } from "./types.ts";
import { getLeafCert } from "./mitm.ts";

const TEXT_CONTENT_TYPES = new Set([
  "text/", "application/json", "application/xml", "application/javascript",
]);

function isTextContentType(ct: string | undefined): boolean {
  if (!ct) return false;
  return TEXT_CONTENT_TYPES.has(ct.toLowerCase()) || ct.toLowerCase().startsWith("text/");
}

function encodeBody(body: Buffer, contentType: string | undefined, maxBytes: number): {
  body: string | null;
  encoding: "utf8" | "base64" | null;
  truncated: boolean;
} {
  if (body.length === 0) return { body: null, encoding: null, truncated: false };
  if (body.length > maxBytes) {
    body = body.subarray(0, maxBytes);
  }
  const truncated = body.length >= maxBytes;
  const text = new TextDecoder("utf-8", { fatal: false }).decode(body);
  if (isTextContentType(contentType)) {
    return { body: text, encoding: "utf8", truncated };
  }
  return { body: Buffer.from(body).toString("base64"), encoding: "base64", truncated };
}

function bestEffortDecode(rawBody: Buffer | null, contentEncoding: string | null): {
  preview: string | null;
  previewEncoding: string | null;
} {
  if (!rawBody || rawBody.length === 0) return { preview: null, previewEncoding: null };
  // Best-effort UTF-8 preview (ignore decode errors)
  const preview = new TextDecoder("utf-8", { fatal: false }).decode(rawBody.subarray(0, 64 * 1024));
  return { preview: preview.length > 0 ? preview : null, previewEncoding: contentEncoding };
}

interface TransactionState {
  id: string;
  timestamp: string;
  method: string;
  url: string;
  reqHeaders: Record<string, string>;
  resHeaders: Record<string, string>;
  reqBodyChunks: Buffer[];
  resBodyChunks: Buffer[];
  statusCode: number;
  startTime: number;
  error: string | null;
  contentEncoding: string | null;
}

export class ProxyServer {
  private server: http.Server | null = null;
  private stopping = false;
  private readonly opts: ProxyOptions;

  constructor(opts: ProxyOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    this.server = http.createServer();
    this.server.on("request", (req, res) => this.handleHttpRequest(req, res));
    this.server.on("connect", (req, clientSocket, head) => this.handleConnect(req, clientSocket, head));
    this.server.on("error", (err) => {
      if (!this.stopping) console.error("[proxy] server error:", err.message);
    });

    return new Promise((resolve) => {
      this.server!.listen(this.opts.port, this.opts.host, () => {
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (!this.server) return;
    return new Promise((resolve) => {
      this.server!.close(() => resolve());
      // Force close after 5s
      setTimeout(() => {
        (this.server as any)?._connections && (this.server as any).closeAllConnections?.();
        resolve();
      }, 5000);
    });
  }

  private async handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Plain HTTP forward proxy (no MITM needed for http:// URLs)
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const body: Buffer[] = [];
    for await (const chunk of req) body.push(chunk);
    const reqBody = Buffer.concat(body);

    const startTime = Date.now();
    const txId = uuidv4();
    const timestamp = new Date().toISOString();

    const clientReqHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") clientReqHeaders[k] = v;
    }

    try {
      const upstream = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const proxyReq = http.request(
          { method: req.method, host: url.hostname, port: url.port || 80, path: url.pathname + url.search, headers: req.headers, timeout: 30000 },
          (r) => resolve(r)
        );
        proxyReq.on("error", reject);
        proxyReq.on("timeout", () => { proxyReq.destroy(); reject(new Error("upstream timeout")); });
        if (reqBody.length > 0) proxyReq.write(reqBody);
        proxyReq.end();
      });

      const resBody: Buffer[] = [];
      for await (const chunk of upstream) resBody.push(chunk);

      const rawResBody = Buffer.concat(resBody);
      const contentEncoding = upstream.headers["content-encoding"] ?? null;
      const { body: encBody, encoding, truncated } = encodeBody(rawResBody, upstream.headers["content-type"], this.opts.maxBodyBytes);
      const { preview, previewEncoding } = bestEffortDecode(rawResBody, contentEncoding);

      const resHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(upstream.headers)) {
        if (typeof v === "string") resHeaders[k] = v;
      }

      res.writeHead(upstream.statusCode ?? 200, upstream.headers);
      res.end(rawResBody);

      const tx: CapturedTransaction = {
        id: txId, timestamp, method: req.method ?? "?", url: `http://${req.headers.host}${url.pathname}${url.search}`,
        reqHeaders: clientReqHeaders, resHeaders, reqBody: null, reqBodyEncoding: null, reqBodyTruncated: false,
        resBody: encBody, resBodyEncoding: encoding, resBodyTruncated: truncated,
        statusCode: upstream.statusCode ?? 200, durationMs: Date.now() - startTime,
        error: null, contentEncoding, resBodyPreview: preview, resBodyPreviewEncoding: previewEncoding,
      };
      this.opts.onTransaction(tx);
    } catch (err: any) {
      const tx: CapturedTransaction = {
        id: txId, timestamp, method: req.method ?? "?", url: `http://${req.headers.host}${url.pathname}${url.search}`,
        reqHeaders: clientReqHeaders, resHeaders: {}, reqBody: null, reqBodyEncoding: null, reqBodyTruncated: false,
        resBody: null, resBodyEncoding: null, resBodyTruncated: false, statusCode: 0, durationMs: Date.now() - startTime,
        error: err.message, contentEncoding: null, resBodyPreview: null, resBodyPreviewEncoding: null,
      };
      this.opts.onTransaction(tx);
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("Proxy error: " + err.message);
    }
  }

  private async handleConnect(req: http.IncomingMessage, clientSocket: net.Socket, _head: Buffer): Promise<void> {
    const [host, portStr] = (req.url ?? "").split(":");
    const port = parseInt(portStr, 10) || 443;
    const startTime = Date.now();
    const txId = uuidv4();
    const timestamp = new Date().toISOString();

    // Acknowledge CONNECT
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");

    const { certPem, keyPem } = getLeafCert(host, this.opts.caCertPath, this.opts.caKeyPath);

    let serverTls: tls.TLSSocket | null = null;
    let clientTls: tls.TLSSocket | null = null;

    try {
      // Upstream TLS to target
      const upstreamSocket = await new Promise<net.Socket>((resolve, reject) => {
        const s = net.connect(port, host, () => resolve(s));
        s.on("error", reject);
        s.setTimeout(30000, () => { s.destroy(); reject(new Error("upstream timeout")); });
      });

      serverTls = new tls.TLSSocket(upstreamSocket, { rejectUnauthorized: false });

      // Client-facing TLS (MITM)
      const secureContext = createSecureContext({ cert: certPem, key: keyPem });
      clientTls = new tls.TLSSocket(clientSocket, { secureContext, isServer: true });

      await new Promise<void>((resolve, reject) => {
        serverTls!.on("error", reject);
        clientTls!.on("error", reject);
        // Wait for both handshakes
        let done = 0;
        const check = () => { if (++done === 2) resolve(); };
        serverTls!.once("secureConnect", check);
        clientTls!.once("secureConnect", check);
      });

      const reqHeaders: Record<string, string> = {};
      // Read the HTTP request over client TLS
      const reqRaw = await this.readHttpMessage(clientTls);
      if (!reqRaw) { clientSocket.destroy(); return; }

      const { method, path, headers, httpVersion } = parseRequestLine(reqRaw);
      for (const [k, v] of Object.entries(headers)) {
        reqHeaders[k] = v;
      }

      const fullUrl = `https://${host}:${port}${path}`;
      const reqBody: Buffer[] = [];
      // Read body (Content-Length or chunked)
      const contentLength = parseInt(headers["content-length"] ?? "", 10);
      if (contentLength > 0) {
        const body = await this.readExact(clientTls, contentLength);
        reqBody.push(body);
      } else if (headers["transfer-encoding"]?.toLowerCase() === "chunked") {
        let size: number | null = null;
        while (true) {
          const lenLine = await this.readLine(clientTls);
          size = parseInt(lenLine.trim(), 16);
          if (size === 0) break;
          const chunk = await this.readExact(clientTls, size);
          reqBody.push(chunk);
          await this.readLine(clientTls); // trailing \r\n
        }
      }

      // Forward to upstream
      await new Promise<void>((resolve, reject) => {
        const upstreamReq = http.request(
          { method, host, port, path, headers, httpVersion, timeout: 30000 },
          (upstreamRes) => {
            // Read response body
            const resBody: Buffer[] = [];
            const resHeaders: Record<string, string> = {};
            for (const [k, v] of Object.entries(upstreamRes.headers)) {
              if (typeof v === "string") resHeaders[k] = v;
            }
            const contentEncoding = resHeaders["content-encoding"] ?? null;

            upstreamRes.on("data", (c) => resBody.push(c));
            upstreamRes.on("end", () => {
              const rawBody = Buffer.concat(resBody);
              const { body: encBody, encoding, truncated } = encodeBody(rawBody, resHeaders["content-type"], this.opts.maxBodyBytes);
              const { preview, previewEncoding } = bestEffortDecode(rawBody, contentEncoding);

              // Write response back to client
              clientTls!.write(`HTTP/${upstreamRes.httpVersion} ${upstreamRes.statusCode} ${upstreamRes.statusMessage}\r\n`);
              for (const [k, v] of Object.entries(upstreamRes.headers)) {
                clientTls!.write(`${k}: ${v}\r\n`);
              }
              clientTls!.write("\r\n");
              clientTls!.write(rawBody);
              clientTls!.end();

              const tx: CapturedTransaction = {
                id: txId, timestamp, method, url: fullUrl, reqHeaders, resHeaders,
                reqBody: reqBody.length > 0 ? encodeBody(Buffer.concat(reqBody), headers["content-type"], this.opts.maxBodyBytes).body : null,
                reqBodyEncoding: reqBody.length > 0 ? encodeBody(Buffer.concat(reqBody), headers["content-type"], this.opts.maxBodyBytes).encoding : null,
                reqBodyTruncated: false,
                resBody: encBody, resBodyEncoding: encoding, resBodyTruncated: truncated,
                statusCode: upstreamRes.statusCode ?? 200, durationMs: Date.now() - startTime,
                error: null, contentEncoding, resBodyPreview: preview, resBodyPreviewEncoding: previewEncoding,
              };
              this.opts.onTransaction(tx);
              upstreamSocket.end();
              resolve();
            });
            upstreamRes.on("error", reject);
          }
        );
        upstreamReq.on("error", reject);
        upstreamReq.end(Buffer.concat(reqBody));
      });
    } catch (err: any) {
      const tx: CapturedTransaction = {
        id: txId, timestamp, method: "CONNECT", url: `https://${host}:${port}`,
        reqHeaders: {}, resHeaders: {}, reqBody: null, reqBodyEncoding: null, reqBodyTruncated: false,
        resBody: null, resBodyEncoding: null, resBodyTruncated: false, statusCode: 0, durationMs: Date.now() - startTime,
        error: err.message, contentEncoding: null, resBodyPreview: null, resBodyPreviewEncoding: null,
      };
      this.opts.onTransaction(tx);
      clientSocket.destroy();
    } finally {
      serverTls?.destroy();
      clientTls?.destroy();
    }
  }

  private readHttpMessage(sock: tls.TLSSocket): Promise<string> {
    return new Promise((resolve, reject) => {
      let data = "";
      const onData = (chunk: Buffer) => { data += chunk.toString(); };
      const onEnd = () => { sock.off("data", onData); sock.off("end", onEnd); resolve(data); };
      sock.on("data", onData);
      sock.on("end", onEnd);
      sock.on("error", reject);
    });
  }

  private async readExact(sock: tls.TLSSocket, bytes: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let remaining = bytes;
    while (remaining > 0) {
      const chunk = await new Promise<Buffer>((resolve, reject) => {
        const listener = (c: Buffer) => { sock.off("data", listener); resolve(c); };
        sock.on("data", listener);
        sock.on("error", reject);
      });
      chunks.push(chunk);
      remaining -= chunk.length;
    }
    return Buffer.concat(chunks);
  }

  private async readLine(sock: tls.TLSSocket): Promise<string> {
    let line = "";
    while (true) {
      const chunk = await new Promise<Buffer>((resolve, reject) => {
        const listener = (c: Buffer) => { sock.off("data", listener); resolve(c); };
        sock.on("data", listener);
        sock.on("error", reject);
      });
      line += chunk.toString();
      const idx = line.indexOf("\n");
      if (idx !== -1) return line.slice(0, idx + 1);
    }
  }
}

function parseRequestLine(raw: string): { method: string; path: string; headers: Record<string, string>; httpVersion: string } {
  const lines = raw.split("\r\n");
  const [method, path, httpVersion] = lines[0]!.split(" ");
  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === "") break;
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    headers[line.slice(0, colonIdx).trim().toLowerCase()] = line.slice(colonIdx + 1).trim();
  }
  return { method: method ?? "GET", path: path ?? "/", headers, httpVersion: httpVersion ?? "1.1" };
}
```

> **Note:** This implementation handles the core MITM flow. Real production use would benefit from streaming body reads (not buffering) and connection pipelining. This is correct for MVP.

- [ ] **Step 2: Typecheck**

Run: `bun tsc --noEmit`
Expected: No errors (resolve any import or type issues)

- [ ] **Step 3: Commit**

```bash
git add src/proxy/server.ts && git commit -m "feat: add ProxyServer (HTTP forward + HTTPS MITM pipeline)

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: TUI (`src/tui/`)

**Files:**
- Create: `src/tui/request-list.ts`
- Create: `src/tui/detail-panel.ts`
- Create: `src/tui/index.ts`

**Key design decisions:**
- `blessed` for all terminal UI widgets
- `analyzer.on("transactionAdded")` → update list + scroll to bottom
- `analyzer.on("statsUpdated")` → update top bar stats
- Navigation: `↑`/`↓` through list; `Enter` toggle body view; `c` clear; `q` quit
- Error rows highlighted red
- JSON body preview auto-formatted with 2-space indent

- [ ] **Step 1: Write `src/tui/request-list.ts`**

```ts
import type { CapturedTransaction } from "../proxy/types.ts";

export interface RequestListOptions {
  parent: any;
  analyser: any;
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
    const label = `${tx.method.padEnd(8)} ${this.getPath(tx.url).padEnd(40)} ${String(tx.statusCode).padStart(3)} ${String(tx.durationMs).padStart(5)}ms`;
    const style = tx.error ? { fg: "red" } : tx.statusCode >= 400 ? { fg: "yellow" } : {};
    // @ts-ignore — blessed types are loose
    this.list.add(label, { transaction: tx, style });
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
    // @ts-ignore
    const item = this.list.getItem(this.selectedIndex);
    return item?.transaction ?? null;
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
```

- [ ] **Step 2: Write `src/tui/detail-panel.ts`**

```ts
import type { CapturedTransaction } from "../proxy/types.ts";

export interface DetailPanelOptions {
  parent: any;
}

export class DetailPanel {
  private box: any;
  private current: CapturedTransaction | null = null;
  private showBody = false;

  constructor(opts: DetailPanelOptions) {
    this.box = opts.parent;
  }

  setTransaction(tx: CapturedTransaction | null): void {
    this.current = tx;
    this.showBody = false;
    this.render();
  }

  toggleBody(): void {
    this.showBody = !this.showBody;
    this.render();
  }

  private render(): void {
    if (!this.current) {
      this.box.setContent("Select a request to view details");
      return;
    }
    const tx = this.current;
    const reqHeaders = Object.entries(tx.reqHeaders).map(([k, v]) => `  ${k}: ${v}`).join("\n") || "  (none)";
    const resHeaders = Object.entries(tx.resHeaders).map(([k, v]) => `  ${k}: ${v}`).join("\n") || "  (none)";

    let bodyContent = "(empty)";
    if (this.showBody && tx.resBody !== null) {
      if (tx.resBodyPreview !== null) {
        bodyContent = this.formatJson(tx.resBodyPreview);
      } else if (tx.resBodyEncoding === "base64") {
        bodyContent = "[binary body — base64]\n" + tx.resBody;
      } else {
        bodyContent = tx.resBody;
      }
    } else if (this.showBody) {
      bodyContent = "(no response body)";
    }

    const content = [
      `#${tx.id.slice(0, 8)}  ${tx.method}  ${tx.url}`,
      "",
      "Request Headers:",
      reqHeaders,
      "",
      "Response Headers:",
      resHeaders,
      "",
      `Status: ${tx.statusCode}  Duration: ${tx.durationMs}ms`,
      tx.error ? `\nERROR: ${tx.error}` : "",
      "",
      "Response Body:" + (this.showBody ? " [toggle: Enter]" : " [press Enter to show]"),
      bodyContent,
    ].join("\n");

    this.box.setContent(content);
  }

  private formatJson(str: string): string {
    try {
      return JSON.stringify(JSON.parse(str), null, 2);
    } catch {
      return str;
    }
  }
}
```

- [ ] **Step 3: Write `src/tui/index.ts`**

```ts
import * as blessed from "blessed";
import type { TrafficAnalyzer } from "../analyzer/index.ts";
import type { ProxyServer } from "../proxy/server.ts";
import { RequestList } from "./request-list.ts";
import { DetailPanel } from "./detail-panel.ts";

export async function runTUI(analyzer: TrafficAnalyzer, server: ProxyServer): Promise<void> {
  const screen = blessed.screen({ smartCSR: true });

  // Top bar
  const topBar = blessed.box({
    parent: screen,
    top: 0, left: 0, right: 0, height: 1,
    content: " mitm-proxy  starting...",
    style: { fg: "white", bg: "blue" },
  });

  // Request list (top 60% of screen)
  const listContainer = blessed.box({
    parent: screen, top: 1, left: 0, right: 0, height: "50%",
    border: { type: "line" }, label: " Requests ",
  });

  const requestList = new RequestList({
    parent: listContainer,
    analyser: analyzer,
    onSelect: (tx) => detailPanel.setTransaction(tx),
  });

  // Detail panel (bottom 50%)
  const detailContainer = blessed.box({
    parent: screen, top: "50%", left: 0, right: 0, height: "50%-1",
    border: { type: "line" }, label: " Detail ",
    scrollable: true, alwaysScroll: true,
  });

  const detailPanel = new DetailPanel({ parent: detailContainer });
  (detailContainer as any).key = ["enter"];
  detailContainer.on("keypress", () => detailPanel.toggleBody());

  // Stats bar
  const statsBar = blessed.box({
    parent: screen, bottom: 1, left: 0, right: 0, height: 1,
    content: " Errors: 0  Total: 0  p50: --ms  p95: --ms",
    style: { fg: "green" },
  });

  // Hint bar
  blessed.box({
    parent: screen, bottom: 0, left: 0, right: 0, height: 1,
    content: " ↑↓ navigate  Enter body  c clear  q quit",
    style: { fg: "black", bg: "gray" },
  });

  // Wire up analyzer events
  analyzer.on("transactionAdded" as any, ({ transaction }: any) => {
    requestList.addItem(transaction);
    const stats = analyzer.getStats();
    statsBar.setContent(` Errors: ${stats.errors}  Total: ${stats.total}  p50: ${stats.latencyP50ms}ms  p95: ${stats.latencyP95ms}ms`);
    screen.render();
  });

  // Keyboard bindings
  screen.key(["up", "k"], () => { requestList.selectPrev(); screen.render(); });
  screen.key(["down", "j"], () => { requestList.selectNext(); screen.render(); });
  screen.key(["c"], () => { requestList.clear(); screen.render(); });
  screen.key(["q"], () => { screen.destroy(); process.exit(0); });

  // Set initial content
  topBar.setContent(` mitm-proxy  ${server}  `);

  screen.render();
}
```

> **Note:** `blessed` event binding is loose. The `@types/blessed` package provides better types; install if available. The core logic is correct for MVP.

- [ ] **Step 4: Typecheck**

Run: `bun tsc --noEmit`
Expected: Fix any import errors; `@types/blessed` should cover blessed types

- [ ] **Step 5: Commit**

```bash
git add src/tui/request-list.ts src/tui/detail-panel.ts src/tui/index.ts && git commit -m "feat: add TUI (blessed-based request list + detail panel)

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: CLI Entry Point (`src/cli.ts`)

**Files:**
- Create: `src/cli.ts`

**Responsibilities:**
- Parse CLI flags: `--port`, `--host`, `--log-file`, `--ca-cert`, `--ca-key`, `--mode`, `--tui`, `--no-tui`, `--max-body-bytes`, `--capture-all`
- Resolve paths (expand `~`)
- Ensure config dir exists
- Wire up: `TrafficAnalyzer` → `JsonlLogger` + TUI events
- Start `ProxyServer`
- Start TUI if TTY (auto or `--tui`)
- Handle `SIGINT`/`SIGTERM`: call `proxy.stop()`, `logger.close()`, exit cleanly

- [ ] **Step 1: Write `src/cli.ts`**

```ts
#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { homedir } from "node:os";
import type { ProxyOptions } from "./proxy/types.ts";
import { TrafficAnalyzer } from "./analyzer/index.ts";
import { JsonlLogger } from "./logger/jsonl.ts";
import { ProxyServer } from "./proxy/server.ts";
import { runTUI } from "./tui/index.ts";

function expandPath(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return p.replace("~", homedir());
  }
  return p;
}

function parseMaxBodyBytes(raw: string | undefined): number {
  if (!raw) return 1_048_576;
  const n = parseInt(raw, 10);
  if (isNaN(n) || n <= 0) return 1_048_576;
  return n;
}

const CONFIG_DIR = expandPath("~/.config/mitm-proxy");
const DEFAULT_LOG = `${CONFIG_DIR}/traffic.jsonl`;
const DEFAULT_CA_CERT = `${CONFIG_DIR}/ca.pem`;
const DEFAULT_CA_KEY = `${CONFIG_DIR}/ca-key.pem`;

async function main() {
  const { values } = parseArgs({
    options: {
      port: { type: "string", default: "8080" },
      host: { type: "string", default: "127.0.0.1" },
      "log-file": { type: "string", default: DEFAULT_LOG },
      "ca-cert": { type: "string", default: DEFAULT_CA_CERT },
      "ca-key": { type: "string", default: DEFAULT_CA_KEY },
      mode: { type: "string", default: "explicit" },
      tui: { type: "boolean" },
      "no-tui": { type: "boolean" },
      "max-body-bytes": { type: "string" },
      "capture-all": { type: "boolean" },
    },
  });

  const port = parseInt(values.port ?? "8080", 10);
  const host = values.host ?? "127.0.0.1";
  const logFile = expandPath(values["log-file"] ?? DEFAULT_LOG);
  const caCertPath = expandPath(values["ca-cert"] ?? DEFAULT_CA_CERT);
  const caKeyPath = expandPath(values["ca-key"] ?? DEFAULT_CA_KEY);
  const mode = (values.mode ?? "explicit") as "explicit" | "transparent";
  const maxBodyBytes = parseMaxBodyBytes(values["max-body-bytes"]);
  const isTty = process.stdout.isTTY;
  const showTui = values["no-tui"] ? false : (values.tui ?? isTty);

  if (mode === "transparent") {
    console.warn("[cli] transparent mode is not yet implemented; falling back to explicit mode");
  }

  // Wire up analyzer → logger
  const logger = new JsonlLogger(logFile);
  const analyzer = new TrafficAnalyzer();

  analyzer.on("transactionAdded" as any, ({ transaction }: any) => {
    logger.write(transaction);
  });

  const proxyOpts: ProxyOptions = {
    host,
    port,
    mode: "explicit",
    caCertPath,
    caKeyPath,
    maxBodyBytes,
    onTransaction: (tx) => analyzer.add(tx),
  };

  const proxy = new ProxyServer(proxyOpts);
  await proxy.start();

  console.log(`[cli] Proxy listening on ${host}:${port}`);
  console.log(`[cli] Logging to ${logFile}`);

  if (showTui) {
    await runTUI(analyzer, proxy);
  } else {
    console.log("[cli] Running headless. Press Ctrl+C to stop.");
  }

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\n[cli] Shutting down...");
    await proxy.stop();
    await logger.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[cli] fatal:", err);
  process.exit(1);
});
```

- [ ] **Step 2: Typecheck**

Run: `bun tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/cli.ts && git commit -m "feat: add CLI entry point (arg parsing, startup, signal handling)

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: README (`README.md`)

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write `README.md`**

```md
# mitm-proxy

A local HTTP(S) MITM proxy with real-time TUI and JSONL logging.

## Quick Start

```bash
bun install
bun run src/cli.ts
```

Configure your browser or HTTP client to use `http://127.0.0.1:8080` as the proxy.

### Trusting the CA Certificate

On first run, `mitm-proxy` generates a CA keypair at `~/.config/mitm-proxy/`.

**macOS:**
```bash
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ~/.config/mitm-proxy/ca.pem
```

**Linux (Ubuntu/Debian):**
```bash
sudo cp ~/.config/mitm-proxy/ca.pem /usr/local/share/ca-certificates/mitm-proxy.crt
sudo update-ca-certificates
```

**Firefox:** Go to Settings → Privacy & Security → Certificates → View Certificates → Authorities → Import → select `ca.pem`.

## CLI Options

| Flag | Default | Description |
|---|---|---|
| `--port 8080` | `8080` | Proxy listen port |
| `--host 127.0.0.1` | `127.0.0.1` | Proxy listen host |
| `--log-file <path>` | `~/.config/mitm-proxy/traffic.jsonl` | JSONL output path |
| `--max-body-bytes <n>` | `1048576` | Max body size to capture (bytes) |
| `--capture-all` | — | Capture bodies for all content types |
| `--no-tui` | — | Run headless, log only |

## TUI Controls

| Key | Action |
|---|---|
| `↑` / `↓` | Navigate request list |
| `Enter` | Toggle response body view |
| `c` | Clear visible list |
| `q` | Quit |

## Log Format

Each line in the log file is a JSON object:

```json
{"id":"...","timestamp":"...","method":"GET","url":"...","reqHeaders":{},"resHeaders":{},"reqBody":null,"reqBodyEncoding":null,"reqBodyTruncated":false,"resBody":"{\"ok\":true}","resBodyEncoding":"utf8","resBodyTruncated":false,"statusCode":200,"durationMs":142,"contentEncoding":null,"resBodyPreview":"{\"ok\":true}","resBodyPreviewEncoding":null,"error":null}
```

## Security Note

The CA private key is stored at `~/.config/mitm-proxy/ca-key.pem` with `0600` permissions. Treat it as a sensitive secret — anyone with access to it can perform MITM on any HTTPS connection on your machine.
```

- [ ] **Step 2: Commit**

```bash
git add README.md && git commit -m "docs: add README (usage, CA trust instructions, CLI options)

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: End-to-End Verification

- [ ] **Step 1: Typecheck everything**

Run: `bun tsc --noEmit`
Expected: No TypeScript errors

- [ ] **Step 2: Run the proxy (no TUI, basic smoke test)**

Start the proxy in headless mode, then make a curl request through it:

```bash
# Terminal 1: start proxy
bun run src/cli.ts --no-tui --log-file /tmp/test-traffic.jsonl &

# Wait 1s for proxy to start
sleep 1

# Make a proxied HTTP request
curl -x http://127.0.0.1:8080 http://example.com

# Check log file
cat /tmp/test-traffic.jsonl | jq .

# Kill proxy
pkill -f "bun run src/cli.ts"
```

Expected: JSONL log file contains one entry for `example.com` with `statusCode: 200`.

- [ ] **Step 3: Run all tests**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "chore: e2e verification complete

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```
