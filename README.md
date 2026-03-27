# weight-distillation

**Capture, distill, and analyze every HTTP/HTTPS call your AI models and apps make.**

This tool runs a local proxy server that sits between your apps and the internet. It intercepts every HTTP and HTTPS request your apps make — including AI API calls — captures the full request and response, shows them to you in real-time, and logs them for later analysis.

Think of it as a black box recorder for your AI model's network traffic — useful for debugging prompts, inspecting responses, auditing API usage, and understanding what your AI stack is actually communicating with.

## What’s New

- **Renamed project** to `weight-distillation`
- **AI distillation layer added** across the pipeline
- **Provider detection** for major AI APIs (OpenAI, Anthropic, Google, Cohere, Mistral, Groq, Together, etc.)
- **Model extraction + token estimation** from requests/responses
- **Estimated cost tracking** (USD) per request and in aggregate
- **Structured response parsing**:
  - assistant message extraction
  - `finish_reason` parsing
  - math `\\boxed{}` answer extraction
  - markdown code block extraction
  - tool call extraction
- **Conversation/session tracking** fields (`conversationId`, `parentMessageId` when available)
- **TUI upgrades**:
  - AI-aware stats bar (AI calls, total tokens, estimated cost)
  - AI request rows highlighted and tagged with provider/model
  - detailed AI distillation section in request details
- **Updated usage/docs** for AI workflow and `~/.config/weight-distillation` paths

---

## How It Works

```
 Your App / AI Model                    weight-distillation                        Internet
───────────────────────                  ─────────────────────────────         ─────────

                                           ┌──────────────────────────────────┐
                                           │      Proxy Server (localhost:8080) │
                                           │                                     │
                                           │  ┌──── HTTP ────┐ ┌─── HTTPS ───┐ │
                                           │  │              │ │              │ │
 HTTP Request ─────────────────────────────▶│ Passthrough │ │ MITM + TLS  │ │
                                           │  │              │ │ Termination │ │
                                           │  └──────┬───────┘ └───┬──────────┘ │
                                           │         │               │            │
                                           │         └───────┬───────┘            │
                                           │                 │                    │
                                           │         ┌───────▼────────┐           │
                                           │         │ Distillate Engine │           │
                                           │         │   (ring buffer)   │           │
                                           │         └───────┬────────┘           │
                                           │                 │                    │
                                           │    ┌────────────┼────────────┐       │
                                           │    │            │            │       │
                                           │    ▼            ▼            ▼       │
                                           │ JSONL Log   Live Dashboard  Future...   │
                                           │    │                             │       │
                                           │    ▼                             ▼       │
 Log File ◀────────────────────────────────┘    Log File              Terminal UI     │
                                                                                  │
 HTTPS Response ◀─────────────────────────────────────────────────────────────────
```

**The pipeline — step by step:**

1. Your app or AI model sends a request through the proxy at `localhost:8080`
2. The proxy intercepts it:
   - **HTTP** — forwarded directly to the destination
   - **HTTPS** — performs MITM: terminates the TLS connection, reads the decrypted request, then re-encrypts and forwards it to the real server
3. The response passes through the proxy again in both directions
4. The **Distillate Engine** buffers the request/response in memory and emits events
5. Two consumers react simultaneously:
   - **JSONL Logger** — appends the transaction to the log file
   - **TUI** — updates the live dashboard with the new request

---

## What It Does

- **Captures all HTTP and HTTPS traffic** — including encrypted HTTPS requests from AI API calls
- **Real-time terminal display** — watch requests scroll by as they happen, see status codes, latency, and bodies
- **Persistent logging** — every request and response is saved to a JSONL file for replay or analysis
- **No app changes required** — just point your app's proxy settings to `localhost:8080`

---

## Target Users

| Who | Why |
|---|---|
| **AI/ML engineers** | Inspect prompts and responses sent to AI APIs, debug token usage |
| **API developers** | Debug what your app is sending to an API, inspect headers and bodies |
| **Security researchers** | Analyze what AI apps are communicating with, detect data exfiltration |
| **QA engineers** | Record and replay API calls for integration testing |
| **Curious users** | See exactly what an AI model is doing over the network |

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
curl -x http://127.0.0.1:8080 https://api.openai.com/v1/chat/completions
```

**Python (OpenAI, Anthropic, etc.):**
```python
import os
os.environ["http_proxy"] = "http://127.0.0.1:8080"
os.environ["https_proxy"] = "http://127.0.0.1:8080"

from openai import OpenAI
client = OpenAI()
# All requests will now be captured by weight-distillation
```

---

## Trusting the CA Certificate (Required for HTTPS Inspection)

On first run, the tool generates its own Certificate Authority (CA) — essentially a signing key that lets it forge SSL certificates on the fly. For your browser or app to trust these forged certificates, you need to tell your system to trust the generated CA.

**macOS:**
```bash
sudo security add-trusted-cert -d -r trustRoot \
  -k /Library/Keychains/System.keychain \
  ~/.config/weight-distillation/ca.pem
```

**Linux (Ubuntu / Debian):**
```bash
sudo cp ~/.config/weight-distillation/ca.pem \
  /usr/local/share/ca-certificates/weight-distillation.crt
sudo update-ca-certificates
```

**Firefox:**
1. Open Firefox → Settings → Privacy & Security → Certificates → View Certificates
2. Click **Authorities** → **Import**
3. Select `~/.config/weight-distillation/ca.pem`
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
| `--log-file <path>` | `~/.config/weight-distillation/traffic.jsonl` | Where to save the distillate log |
| `--max-body-bytes <n>` | `1048576` | Max body size to capture (default: 1 MB) |
| `--capture-all` | — | Capture bodies for media/image/font types (default: skipped) |
| `--no-tui` | — | Run without the dashboard (logging only) |

---

## The Live Dashboard (TUI)

When you run without `--no-tui`, a terminal dashboard appears:

```
┌─ weight-distillation ─────────────── 127.0.0.1:8080 ─ 200 calls ──┐
│ ▶ Requests                  Errors (0)   Latency p50: 45ms       │
├──────────────────────────────────────────────────────────────────┤
│ POST /v1/chat/completions   200   320ms                           │
│ GET  /v1/models             200    45ms                           │
│ GET  /v1/embeddings         200   210ms                           │
├──────────────────────────────────────────────────────────────────┤
│ #1  POST  https://api.openai.com/v1/chat/completions              │
│ Request Headers: [expand]                                           │
│ Request Body: [press Enter to show]                               │
│ Response Body: [press Enter to show]                               │
└──────────────────────────────────────────────────────────────────┘
```

### Keyboard Controls

| Key | Action |
|---|---|
| `↑` / `↓` | Navigate through requests |
| `Enter` | Show or hide the request/response body |
| `c` | Clear the visible request list |
| `q` | Quit |

---

## Distillate Log File

Every request and response is appended to the log file (`~/.config/weight-distillation/traffic.jsonl` by default). Each line is a single JSON object — one record per HTTP transaction.

The log survives app restarts and is useful for:
- **Prompt engineering** — replay real API calls to refine prompts
- **Cost auditing** — count API calls and estimate token usage from body size
- **Integration testing** — generate test fixtures from recorded calls
- **Debugging** — post-mortem analysis of AI model behavior

Example log entry:

```json
{
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "timestamp": "2026-03-27T10:00:00.000Z",
  "method": "POST",
  "url": "https://api.openai.com/v1/chat/completions",
  "reqHeaders": {
    "Authorization": "Bearer sk-***",
    "Content-Type": "application/json"
  },
  "resHeaders": { "Content-Type": "application/json" },
  "reqBody": "{\"model\":\"gpt-4o\",\"messages\":[{\"role\":\"user\",\"content\":\"Hello\"}]}",
  "resBody": "{\"id\":\"chatcmpl-...\",\"choices\":[{\"message\":{\"role\":\"assistant\",\"content\":\"Hello! How can I help?\"}}]}",
  "statusCode": 200,
  "durationMs": 142,
  "error": null
}
```

---

## Security Note

This tool is for **local use on your own machine only**.

The CA private key stored at `~/.config/weight-distillation/ca-key.pem` is a sensitive secret. Anyone who has access to it can perform MITM attacks on your HTTPS traffic. Treat it accordingly:

- Keep the file permissions restricted (`0600`) — the tool sets this automatically
- Do not share the key or commit it to version control
- Delete the CA files (`~/.config/weight-distillation/`) if you no longer need the tool

---

## Project Structure

```
src/
├── cli.ts              # Entry point, CLI argument parsing
├── proxy/
│   ├── types.ts        # Shared data types
│   ├── mitm.ts         # Certificate generation and signing
│   └── server.ts      # HTTP/HTTPS proxy server
├── logger/
│   └── jsonl.ts        # Distillate log file writer
├── analyzer/
│   └── index.ts        # In-memory buffer and stats
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
