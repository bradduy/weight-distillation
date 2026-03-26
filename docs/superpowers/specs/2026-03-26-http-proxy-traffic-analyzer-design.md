# HTTP Proxy Traffic Analyzer — Design Specification

## Overview

A local HTTP(S) proxy server built with **Bun/TypeScript** that intercepts traffic via MITM (man-in-the-middle) with on-the-fly certificate generation, logs all requests/responses as **JSONL**, and presents a real-time **terminal UI (TUI)** for live traffic inspection. Supports both explicit proxy mode and transparent proxy mode.

---

## Architecture

```
Client App  ──▶  Proxy Server  ──▶  Remote Server
                  │
                  ├── JSONL Logger (writes to file)
                  └── Traffic Analyzer (in-memory state)
                          │
                          └── TUI (real-time display)
```

**Components:**

| Component | Responsibility |
|---|---|
| `ProxyServer` | HTTP(S) proxy with MITM. Handles CONNECT for HTTPS, forward for HTTP. |
| `JsonlLogger` | Appends request/response records to a `.jsonl` file. Fire-and-forget, non-blocking. |
| `TrafficAnalyzer` | Maintains in-memory ring buffer of live requests. Emits events to TUI. |
| `TUI` | Terminal UI showing live request list + detail panel. |
| `CLI` | Entry point: parses args, starts proxy + TUI, handles signals. |

---

## Proxy Server

- **Runtime**: Bun with TypeScript.
- **HTTP/1.1 only** — HTTP/2 over TLS is out of scope for MVP (will be logged at connection level without body inspection). WebSocket `Upgrade` headers are logged as metadata only (pass-through).
- **Default listen**: `localhost:8080`, configurable via `--port` / `--host`.

### MITM Certificate Lifecycle

Uses `node-forge` for all PKI operations:

1. On first run: generate a CA keypair (RSA 2048), store at `~/.config/mitm-proxy/ca.pem` / `ca-key.pem` with `0600` permissions.
2. Per-connection (HTTPS MITM): generate a leaf cert signed by the CA for the target hostname, with SANs covering the host. Cache signed leaf certs in-memory (key: `hostname`) to avoid re-signing for repeated connections.
3. Leaf cert validity: 24 hours. Cache uses **lazy TTL checking**: on each access, if entry age > 24h, the entry is invalidated and a new cert is generated. A background timer runs every hour to purge expired entries to bound memory.
4. Max cache size: 500 entries. LRU eviction if limit exceeded. (This is a future enhancement; MVP uses unbounded cache with lazy TTL.)

### HTTPS MITM Pipeline (explicit proxy)

```
Client                     Proxy                          Target Server
  │                           │                                  │
  │──── CONNECT host:443 ────▶│                                  │
  │◀─── 200 Connection Est. ──│                                  │
  │                           │                                  │
  │══ TLS (forged leaf) ═════▶│                                  │══ TLS (real) ══════▶│
  │  HTTP/1.1 request        │  Decrypt → parse → log           │  HTTP/1.1 request   │
  │                           │─────────────────────────────────▶│                      │
  │                           │◀─────────────────────────────────│  HTTP/1.1 response  │
  │  HTTP/1.1 response       │  parse → log → encrypt          │                      │
  │◀─── TLS response ═════════│                                  │
```

**Hostname source for leaf cert:** The hostname is extracted from the `CONNECT host:port` request line (before TLS is established). For clients that send SNI in a subsequent TLS ClientHello, that value is used as a fallback/validation.

Steps:
1. Client sends `CONNECT host:port`. Proxy records `host` and `port`.
2. Proxy opens TCP connection to `host:port` on the real upstream server.
3. Proxy generates a forged leaf cert for `host` (signed by the CA), performs TLS handshake with the client using it.
4. Proxy parses HTTP request/response over both decrypted streams.
5. Logs captured transaction.
6. Pipes remaining bytes bidirectionally (streaming passthrough) — the connection is now transparent.

**Non-standard CONNECT ports:** If the client sends `CONNECT example.com:8443`, the proxy uses port `8443` (not 443) for the upstream TCP connection.

**WebSocket over CONNECT:** `Upgrade: websocket` headers are logged as metadata on the transaction. The TCP stream is pass-through without body inspection.

### Transparent Proxy Mode

Transparent mode requires OS-level routing configuration (outside this tool's scope):

- **Linux**: `iptables -t nat -A PREROUTING -p tcp --dport 80 -j REDIRECT --to-port 8080` (HTTP only). HTTPS transparent MITM requires `SO_ORIGINAL_DST` socket option + root privileges + iptables TPROXY target.
- **macOS**: `pf` rules with `rdr-to`.

> **Status for MVP**: Transparent mode is documented here for future work. Initial release implements explicit proxy only (`--mode explicit`).

---

## JSONL Log Format

Each line is a JSON object (no trailing comma, no wrapping array). One record per completed (or failed) transaction.

```json
{"id":"uuid","timestamp":"2026-03-26T10:00:00.000Z","method":"GET","url":"https://example.com/api","reqHeaders":{"Host":"example.com","Accept":"*/*"},"resHeaders":{"content-type":"application/json"},"reqBody":null,"reqBodyEncoding":null,"reqBodyTruncated":false,"resBody":"{\"ok\":true}","resBodyEncoding":"utf8","resBodyTruncated":false,"statusCode":200,"durationMs":142,"contentEncoding":null,"resBodyPreview":"{\"ok\":true}","resBodyPreviewEncoding":null,"error":null}
```

**Fields:**

| Field | Type | Description |
|---|---|---|
| `id` | `string` | UUID v4, unique per request. |
| `timestamp` | `string` | ISO 8601 UTC, time request started. |
| `method` | `string` | HTTP method. |
| `url` | `string` | Full URL. |
| `reqHeaders` | `Record<string,string>` | Request headers. |
| `resHeaders` | `Record<string,string>` | Response headers. |
| `reqBody` | `string \| null` | Request body; `null` if absent. |
| `reqBodyEncoding` | `"utf8" \| "base64" \| null` | `null` when `reqBody` is `null`. |
| `reqBodyTruncated` | `boolean` | `true` if body exceeded `maxBodyBytes`. |
| `resBody` | `string \| null` | Response body; `null` if absent. |
| `resBodyEncoding` | `"utf8" \| "base64" \| null` | `null` when `resBody` is `null`. |
| `resBodyTruncated` | `boolean` | `true` if body exceeded `maxBodyBytes`. |
| `statusCode` | `number` | HTTP status; `0` if failed before response. |
| `durationMs` | `number` | Time from request start to response complete. |
| `error` | `string \| null` | `null` if success, error message if failed. |
| `contentEncoding` | `string \| null` | Raw `Content-Encoding` header value (e.g. `"gzip"`), `null` if absent. Stored so consumers can re-decode. |
| `resBodyPreview` | `string \| null` | Best-effort decoded UTF-8 preview of `resBody`. `null` if decoding fails, is skipped, or body is absent. |
| `resBodyPreviewEncoding` | `string \| null` | The encoding applied to produce `resBodyPreview` (e.g. `"gzip"`), or `null`. |

**Body encoding logic:**
- Attempt UTF-8 decode via `TextDecoder`.
- If successful AND the `Content-Type` is text-like (`text/*`, `application/json`, `application/xml`, `application/javascript`), store as `"utf8"`.
- Otherwise, store raw bytes as `"base64"`.
- If body is empty or absent: body and encoding fields are `null`.
- For compressed bodies (`Content-Encoding: gzip`/`br`/`deflate`): store the raw encoded bytes in `resBody`; set `resBodyPreview` to the best-effort decoded UTF-8 preview (or `null` if decode fails).

**Resource limits:**
- `maxBodyBytes`: default `1 MB` (1_048_576). Configurable via `--max-body-bytes`.
- Bodies exceeding `maxBodyBytes` are truncated; `*Truncated` flag is set to `true`.
- Content types skipped from body capture by default: `video/*`, `audio/*`, `image/*`, `font/*`. (Forced capture with `--capture-all`.)
- Content-encoding (`gzip`, `br`, `deflate`): stored raw with `contentEncoding` field. UI attempts best-effort decode for preview; raw body always available.

Log file default: `~/.config/mitm-proxy/traffic.jsonl`. Configurable via `--log-file`.

---

## TUI Layout

```
┌─ mitm-proxy ─────────────────────── 127.0.0.1:8080 ─ 200 reqs ──┐
│ ▶ Requests                  Errors (0)   Latency p50: 45ms     │
├──────────────────────────────────────────────────────────────────┤
│ GET  /api/users          200   12ms                              │
│ POST /api/login          401   89ms                              │
│ GET  /favicon.ico        404    3ms                              │
│ ...                                                           ▼  │
├──────────────────────────────────────────────────────────────────┤
│ #2  GET  https://example.com/api/users                           │
│ Req Headers: [expand]                                            │
│ Res Headers: [expand]                                            │
│ Request Body: [empty]                                            │
│ Response Body: [toggle raw/preview]                              │
└──────────────────────────────────────────────────────────────────┘
```

- **Top bar**: Proxy status, bind address, total request count, error count, latency p50.
- **Request list**: Scrollable table with Method | Path | Status | Duration. Newest at bottom. Failed rows highlighted red.
- **Detail panel**: Selected request's full headers + body. JSON auto-formatted if valid.
- **Controls**:
  - `↑` / `↓` — navigate request list.
  - `Enter` — toggle body view.
  - `c` — clear visible list (does not delete log file).
  - `f` — open filter bar.
  - `q` — quit.
  - `r` — reconnect (if proxy was restarted).

---

## CLI / Entry Point

**File**: `src/cli.ts`

**Flags**:

| Flag | Default | Description |
|---|---|---|
| `--port` | `8080` | Proxy listen port |
| `--host` | `127.0.0.1` | Proxy listen host |
| `--log-file` | `~/.config/mitm-proxy/traffic.jsonl` | JSONL output path |
| `--ca-cert` | auto-generated | Path to CA cert PEM |
| `--ca-key` | auto-generated | Path to CA key PEM |
| `--mode` | `explicit` | `explicit` or `transparent` (transparent is future work) |
| `--tui` | auto (on TTY) | Force TUI on/off |
| `--no-tui` | — | Run headless, log only |
| `--max-body-bytes` | `1048576` | Max body size to capture (bytes) |

**Startup**:
1. Resolve `--log-file` path, ensure directory exists.
2. Load or generate CA cert/key.
3. Start `ProxyServer` (non-blocking).
4. If TTY: start `TUI` (blocks main thread). If headless (`--no-tui`): print "Proxy running on localhost:8080" then stay foreground until SIGINT.
5. Handle `SIGINT` / `SIGTERM`: graceful shutdown of proxy + flush logs + exit.

---

## Error Handling

- **Proxy errors**: Logged to JSONL with `error` field. TUI shows red indicator on failed rows.
- **Startup errors**: Missing CA cert permissions → clear error message pointing to `~/.config/mitm-proxy/`.
- **Body encoding**: UTF-8 text bodies stored as plain strings. Binary / non-decodable bodies stored as base64 strings with `reqBodyEncoding: "base64"` / `resBodyEncoding: "base64"`.
- **Single-process model**: TUI and proxy run in the same process. Closing TUI (via `q`) shuts down the proxy cleanly. SIGINT/SIGTERM from terminal also triggers clean shutdown.
- **Corrupt JSONL line**: Log writer never writes partial lines — buffered writes, flush on newline.

---

## Project Structure

```
/
├── src/
│   ├── cli.ts           # Entry point, arg parsing, startup
│   ├── proxy/
│   │   ├── server.ts     # HTTP/HTTPS MITM proxy server
│   │   ├── mitm.ts       # Cert generation, TLS negotiation
│   │   └── types.ts      # Proxy-specific types
│   ├── logger/
│   │   └── jsonl.ts      # Non-blocking JSONL file writer
│   ├── analyzer/
│   │   └── index.ts      # In-memory ring buffer, event emitter
│   └── tui/
│       ├── index.ts      # Blessed/Bubbleteam app bootstrap
│       ├── request-list.ts
│       └── detail-panel.ts
├── package.json
├── tsconfig.json
└── README.md
```

---

## Component Interfaces

### Shared Types (`src/proxy/types.ts`)

```ts
export interface CapturedTransaction {
  id: string;           // UUID v4
  timestamp: string;    // ISO 8601
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
}

export type AnalyzerEvent =
  | { type: "transactionAdded"; transaction: CapturedTransaction }
  | { type: "statsUpdated"; stats: StatsSnapshot };

// Note: `statsUpdated` is emitted at most once per second to avoid render thrashing
// in the TUI when the proxy handles high request rates.

export interface StatsSnapshot {
  total: number;
  errors: number;
  latencyP50ms: number;
  latencyP95ms: number;
}

export interface ProxyOptions {
  host: string;
  port: number;
  mode: "explicit" | "transparent"; // transparent is stubbed for future work
  caCertPath: string;
  caKeyPath: string;
  maxBodyBytes: number;
  onTransaction: (tx: CapturedTransaction) => void;
}
```

### `ProxyServer` (`src/proxy/server.ts`)

```ts
class ProxyServer {
  constructor(opts: ProxyOptions);
  start(): Promise<void>;   // binds port, starts listening
  stop(): Promise<void>;    // closes listening socket, waits up to 5s for in-flight
                            // transactions to complete (logs them), then force-closes
                            // any remaining connections
}
```

### `JsonlLogger` (`src/logger/jsonl.ts`)

```ts
class JsonlLogger {
  constructor(logPath: string);
  write(record: CapturedTransaction): void;  // async, fire-and-forget
  flush(): Promise<void>;    // drains internal buffer to OS (no guarantee of fsync)
  close(): Promise<void>;    // flush() then close file descriptor; called on shutdown
}
```

### `TrafficAnalyzer` (`src/analyzer/index.ts`)

```ts
class TrafficAnalyzer extends EventEmitter<AnalyzerEvent> {
  constructor(maxRecords?: number);  // default: 10,000; older records evicted FIFO
  add(transaction: CapturedTransaction): void;
  getAll(): CapturedTransaction[];
  getStats(): StatsSnapshot;
}
```

### `TUI` (`src/tui/index.ts`)

```ts
async function runTUI(analyzer: TrafficAnalyzer, server: ProxyServer): Promise<void>;
```

**Bun concurrency model:** Bun uses a single-threaded event loop for JavaScript. The TUI uses `blessed.screen` with `screen.key()` callbacks that fire as events — it does **not** use a blocking `while` loop. Bun's event loop handles both TUI keypress events and async proxy socket I/O concurrently. The TUI calls `screen.render()` after each batch of state changes.

---

## Dependencies

- `bun` — runtime
- `typescript` — type checking
- `node-forge` — CA cert generation, leaf cert signing, RSA key operations
- `blessed` — terminal UI
- `@types/bun` — Bun type definitions

> **Note**: `mitm-proxy` is not a dependency. MITM is implemented from scratch using Bun's built-in `node:http`, `node:net`, and `node:crypto` APIs plus `node-forge` for cert operations.

---

## File Checklist

- [x] `package.json` — project metadata, scripts, dependencies
- [x] `tsconfig.json` — TypeScript configuration
- [ ] `src/cli.ts` — CLI entry point
- [ ] `src/proxy/types.ts` — shared types
- [ ] `src/proxy/mitm.ts` — certificate generation, TLS handshake helpers
- [ ] `src/proxy/server.ts` — HTTP/HTTPS MITM proxy server
- [ ] `src/logger/jsonl.ts` — non-blocking JSONL writer
- [ ] `src/analyzer/index.ts` — ring buffer + event bus
- [ ] `src/tui/index.ts` — TUI app root
- [ ] `src/tui/request-list.ts` — request table widget
- [ ] `src/tui/detail-panel.ts` — detail view widget
- [ ] `README.md` — usage, install, config
