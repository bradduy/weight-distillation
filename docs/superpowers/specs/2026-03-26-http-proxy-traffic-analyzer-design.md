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
- **MITM**: On-the-fly CA cert generation using `selfsigned` package. CA cert stored at `~/.config/mitm-proxy/ca.pem` (created on first run).
- **HTTP**: Standard `node:http` forward proxy — forwards `http://` URLs directly.
- **HTTPS (explicit)**: Intercept `CONNECT host:port`, establish TLS to client, TLS to server, pipe both directions, log after.
- **HTTPS (transparent)**: OS-level `iptables` rules route traffic to the proxy. The proxy accepts plaintext and relays. (Transparent mode requires OS config outside the tool.)
- **Default listen**: `localhost:8080`, configurable via `--port` / `--host`.

---

## JSONL Log Format

Each line is a JSON object (no trailing comma, no wrapping array):

```json
{"id":"uuid","timestamp":"2026-03-26T10:00:00.000Z","method":"GET","url":"https://example.com/api","reqHeaders":{"Host":"example.com","Accept":"*/*"},"resHeaders":{"content-type":"application/json"},"reqBody":null,"resBody":"{\"ok\":true}","statusCode":200,"durationMs":142,"error":null}
```

Fields:
- `id`: UUID v4, unique per request.
- `timestamp`: ISO 8601 UTC.
- `method`: HTTP method string.
- `url`: Full URL string.
- `reqHeaders` / `resHeaders`: Object of header key-value pairs.
- `reqBody` / `resBody`: String if UTF-8 text, base64-encoded string if binary. `null` if empty.
- `statusCode`: Numeric HTTP status (0 if errored before response).
- `durationMs`: Time from request start to response complete.
- `error`: `null` if success, error message string if failed.

Log file default: `~/.mitm-proxy/traffic.jsonl`. Configurable via `--log-file`.

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
| `--log-file` | `~/.mitm-proxy/traffic.jsonl` | JSONL output path |
| `--ca-cert` | auto-generated | Path to CA cert PEM |
| `--ca-key` | auto-generated | Path to CA key PEM |
| `--mode` | `explicit` | `explicit` or `transparent` |
| `--tui` | auto (on TTY) | Force TUI on/off |
| `--no-tui` | — | Run headless, log only |

**Startup**:
1. Resolve `--log-file` path, ensure directory exists.
2. Load or generate CA cert/key.
3. Start `ProxyServer` (non-blocking).
4. If TTY: start `TUI` (blocks). If headless: log to stdout on startup then background.
5. Handle `SIGINT` / `SIGTERM`: graceful shutdown of proxy + flush logs.

---

## Error Handling

- **Proxy errors**: Logged to JSONL with `error` field. TUI shows red indicator on failed rows.
- **Startup errors**: Missing CA cert permissions → clear error message pointing to `~/.config/mitm-proxy/`.
- **Body encoding**: Non-UTF-8 response bodies stored as base64 + `="_b64"` suffix in JSONL.
- **TUI killed**: Proxy continues running; TUI restart reconnects to live stream.
- **Corrupt JSONL line**: Log writer never writes partial lines — use buffered writes, flush on newline.

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

## Dependencies

- `bun` — runtime
- `typescript` — type checking
- `selfsigned` — CA cert generation
- `mitm-proxy` or custom `node:http` + `node:tls` — proxy core
- `bubbleteam/blessed` — terminal UI
- `@types/bun` — Bun type definitions

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
