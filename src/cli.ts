#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { homedir } from "node:os";
import type { ProxyOptions } from "./proxy/types.js";
import { TrafficAnalyzer } from "./analyzer/index.js";
import { JsonlLogger } from "./logger/jsonl.js";
import { ProxyServer } from "./proxy/server.js";
import { runTUI } from "./tui/index.js";

const CONFIG_DIR = expandPath("~/.config/ai-distillation");
const DEFAULT_LOG = `${CONFIG_DIR}/traffic.jsonl`;
const DEFAULT_CA_CERT = `${CONFIG_DIR}/ca.pem`;
const DEFAULT_CA_KEY = `${CONFIG_DIR}/ca-key.pem`;

function expandPath(p: string): string {
  if (p.startsWith("~/") || p === "~") return p.replace("~", homedir());
  return p;
}

function parseMaxBodyBytes(raw?: string): number {
  if (!raw) return 1_048_576;
  const n = parseInt(raw, 10);
  return isNaN(n) || n <= 0 ? 1_048_576 : n;
}

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

  const logger = new JsonlLogger(logFile);
  const analyzer = new TrafficAnalyzer();

  (analyzer as any).on("transactionAdded", ({ transaction }: any) => {
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
    await runTUI(analyzer, `${host}:${port}`);
  } else {
    console.log("[cli] Running headless. Press Ctrl+C to stop.");
  }

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
