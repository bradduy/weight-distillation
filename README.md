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
