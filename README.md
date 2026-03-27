# ai-reverse-engineering

**Inspect, debug, and reverse-engineer HTTP/HTTPS traffic from any app on your machine.**

This tool runs a local proxy server that sits between your apps and the internet. It intercepts every HTTP and HTTPS request your apps make, shows them to you in real-time, and logs them to a file for later analysis.

Think of it as a black box recorder for your computer's network traffic — useful for developers debugging APIs, security researchers analyzing app behavior, or anyone curious about what an app is communicating with.

---

## What It Does

- **Intercepts all HTTP and HTTPS traffic** — including encrypted HTTPS requests, not just plain HTTP
- **Real-time terminal display** — watch requests scroll by as they happen, see status codes, response times, and bodies
- **Persistent logging** — every request and response is saved to a JSONL file for replay or analysis
- **No app changes required** — just point your app's proxy settings to `localhost:8080`

---

## Target Users

| Who | Why |
|---|---|
| **API developers** | Debug what your app is sending to an API, inspect headers and bodies |
| **Security researchers** | Analyze what apps are communicating with, detect suspicious traffic |
| **QA engineers** | Record and replay traffic for integration testing |
| **Curious users** | See exactly what an app is doing over the network |

---

## Prerequisites

- **Bun** — [Install Bun](https://bun.sh) (required to run the tool)
- **macOS, Linux, or WSL** — not yet tested on Windows natively

---

## Quick Start

```bash
# 1. Install dependencies
bun install

# 2. Run the proxy
bun run src/cli.ts
```

That's it. You'll see a live dashboard of all HTTP/HTTPS requests.

---

## Configuring Your App to Use the Proxy

Once the proxy is running, tell your app to route traffic through it:

**macOS / System-wide:**
```bash
# Option 1: Set proxy environment variables (terminal sessions only)
export http_proxy=http://127.0.0.1:8080
export https_proxy=http://127.0.0.1:8080

# Option 2: Change proxy settings in System Preferences
#   → Network → Advanced → Proxies → Manual
#   Set HTTP and HTTPS proxy to 127.0.0.1:8080
```

**Browser-specific:**
- **Chrome/Edge:** Use a proxy switcher extension (e.g., SwitchyOmega)
- **Firefox:** Settings → Network Settings → Manual proxy → `127.0.0.1:8080`

**CLI tools (curl, wget, etc.):**
```bash
curl -x http://127.0.0.1:8080 https://example.com
```

---

## Trusting the CA Certificate (Required for HTTPS Inspection)

On first run, the tool generates its own Certificate Authority (CA) — essentially a signing key that lets it forge SSL certificates on the fly. For your browser or app to trust these forged certificates, you need to tell your system to trust the generated CA.

**macOS:**
```bash
sudo security add-trusted-cert -d -r trustRoot \
  -k /Library/Keychains/System.keychain \
  ~/.config/mitm-proxy/ca.pem
```

**Linux (Ubuntu / Debian):**
```bash
sudo cp ~/.config/mitm-proxy/ca.pem \
  /usr/local/share/ca-certificates/ai-reverse-engineering.crt
sudo update-ca-certificates
```

**Firefox:**
1. Open Firefox → Settings → Privacy & Security → Certificates → View Certificates
2. Click **Authorities** → **Import**
3. Select `~/.config/mitm-proxy/ca.pem`
4. Trust it for websites, then restart Firefox

> **Note:** Chrome and Edge on macOS use the system Keychain, so the macOS command above covers them. Firefox manages its own certificate store — use the Firefox steps above.

---

## Command-Line Options

```bash
bun run src/cli.ts [options]
```

| Flag | Default | Description |
|---|---|---|
| `--port` | `8080` | Port the proxy listens on |
| `--host` | `127.0.0.1` | Host the proxy binds to |
| `--log-file <path>` | `~/.config/mitm-proxy/traffic.jsonl` | Where to save the traffic log |
| `--max-body-bytes <n>` | `1048576` | Max body size to capture (default: 1 MB) |
| `--capture-all` | — | Capture bodies for media/image/font types (default: skipped) |
| `--no-tui` | — | Run without the dashboard (logging only) |

---

## The Live Dashboard (TUI)

When you run without `--no-tui`, a terminal dashboard appears:

```
┌─ ai-reverse-engineering ─────── 127.0.0.1:8080 ─ 200 reqs ──┐
│ ▶ Requests                  Errors (0)   Latency p50: 45ms     │
├──────────────────────────────────────────────────────────────────┤
│ GET  /api/users          200   12ms                              │
│ POST /api/login          401   89ms                              │
│ GET  /favicon.ico        404    3ms                              │
├──────────────────────────────────────────────────────────────────┤
│ #2  GET  https://api.example.com/api/users                        │
│ Request Headers: [expand]                                          │
│ Response Headers: [expand]                                         │
│ Response Body: [press Enter to show]                              │
└──────────────────────────────────────────────────────────────────┘
```

### Keyboard Controls

| Key | Action |
|---|---|
| `↑` / `↓` | Navigate through requests |
| `Enter` | Show or hide the response body |
| `c` | Clear the visible request list |
| `q` | Quit |

---

## Traffic Log File

Every request and response is appended to the log file (`~/.config/mitm-proxy/traffic.jsonl` by default). Each line is a single JSON object — one record per HTTP transaction.

The log survives app restarts and is useful for:
- Post-mortem debugging
- Generating test fixtures
- Feeding into other analysis tools

Example log entry:

```json
{
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "timestamp": "2026-03-27T10:00:00.000Z",
  "method": "POST",
  "url": "https://api.example.com/auth/login",
  "reqHeaders": { "Content-Type": "application/json", "Authorization": "Bearer ***" },
  "resHeaders": { "Content-Type": "application/json" },
  "reqBody": "{\"email\":\"user@example.com\",\"password\":\"***\"}",
  "resBody": "{\"token\":\"eyJhbGci...\",\"expiresIn\":3600}",
  "statusCode": 200,
  "durationMs": 142,
  "error": null
}
```

---

## Security Note

This tool is for **local use on your own machine only**.

The CA private key stored at `~/.config/mitm-proxy/ca-key.pem` is a sensitive secret. Anyone who has access to it can perform MITM attacks on your HTTPS traffic. Treat it accordingly:

- Keep the file permissions restricted (`0600`) — the tool sets this automatically
- Do not share the key or commit it to version control
- Delete the CA files (`~/.config/mitm-proxy/`) if you no longer need the tool

---

## Project Structure

```
src/
├── cli.ts              # Entry point, CLI argument parsing
├── proxy/
│   ├── types.ts        # Shared data types
│   ├── mitm.ts         # Certificate generation and signing
│   └── server.ts       # HTTP/HTTPS proxy server
├── logger/
│   └── jsonl.ts        # Traffic log file writer
├── analyzer/
│   └── index.ts        # In-memory traffic buffer and stats
└── tui/
    ├── index.ts        # Terminal dashboard
    ├── request-list.ts # Request list widget
    └── detail-panel.ts # Request detail widget
```

---

## Contributors

- **Brad Duy** — Senior AI Engineer

---

## License

MIT
