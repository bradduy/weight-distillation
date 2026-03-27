import * as http from "node:http";
import * as net from "node:net";
import * as tls from "node:tls";
import { createSecureContext } from "node:tls";
import { randomUUID } from "node:crypto";
import type {
  CapturedTransaction,
  ProxyOptions,
  AiParsedResponse,
  AiUsage,
} from "./types.js";
import { getLeafCert } from "./mitm.js";

// ─────────────────────────────────────────────────────────────────────────────
// AI Provider Detection
// ─────────────────────────────────────────────────────────────────────────────

const KNOWN_PROVIDERS: [RegExp, string][] = [
  [/^(api\.)?openai\.com$/, "openai"],
  [/^(api\.)?anthropic\.com$/, "anthropic"],
  [/^(api\.)?googleapis\.com$/, "google"],
  [/^(api\.)?cohere\.ai$/, "cohere"],
  [/^(api\.)?mistral\.ai$/, "mistral"],
  [/^(api\.)?together\.ai$/, "together"],
  [/^(api\.)?groq\.com$/, "groq"],
  [/^(api\.)?perplexity\.ai$/, "perplexity"],
  [/^(api\.)?anyscale\.com$/, "anyscale"],
  [/^(api\.)?Claude\.ai$/, "Claude"],
  [/^(api\.)?ollama\.com$/, "ollama"],
  [/^(api\.)?lmstudio\.ai$/, "lmstudio"],
  [/^(api\.)?localai$/, "localai"],
];

function detectAiProvider(hostname: string): string | null {
  for (const [re, name] of KNOWN_PROVIDERS) {
    if (re.test(hostname)) return name;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Token Estimation (simple word/char-based heuristic)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rough token estimate: ~4 chars per token for English text.
 * More accurate for code (~3 chars/token) and math (~4.5 chars/token).
 */
function estimateTokens(text: string): number {
  if (!text) return 0;
  // Heuristic: split on whitespace and punctuation, avg 4 chars/token
  return Math.ceil(text.length / 4);
}

function estimateCost(provider: string, model: string, promptTokens: number, completionTokens: number): number {
  // Rough pricing (USD per 1M tokens) — commonly used models
  const PRICING: Record<string, { prompt: number; completion: number }> = {
    "gpt-4o": { prompt: 5.0, completion: 15.0 },
    "gpt-4o-mini": { prompt: 0.15, completion: 0.60 },
    "gpt-4-turbo": { prompt: 10.0, completion: 30.0 },
    "gpt-3.5-turbo": { prompt: 0.50, completion: 1.50 },
    "claude-3-5-sonnet": { prompt: 3.0, completion: 15.0 },
    "claude-3-5-haiku": { prompt: 0.80, completion: 4.0 },
    "claude-3-opus": { prompt: 15.0, completion: 75.0 },
    "gemini-1.5-pro": { prompt: 1.25, completion: 5.0 },
    "gemini-1.5-flash": { prompt: 0.075, completion: 0.30 },
    "gemini-2.0-flash": { prompt: 0.10, completion: 0.40 },
    "mistral-large": { prompt: 2.0, completion: 6.0 },
    "mixtral-8x7b": { prompt: 0.24, completion: 0.24 },
    "llama-3.1-70b": { prompt: 0.65, completion: 2.75 },
    "llama-3.1-8b": { prompt: 0.07, completion: 0.24 },
  };

  const modelKey = Object.keys(PRICING).find((k) => model.toLowerCase().includes(k)) ?? "";
  const price = PRICING[modelKey] ?? { prompt: 0, completion: 0 };
  const pCost = (promptTokens / 1_000_000) * price.prompt;
  const cCost = (completionTokens / 1_000_000) * price.completion;
  return Math.round((pCost + cCost) * 1_000_000) / 1_000_000; // round to 6 decimal places
}

// ─────────────────────────────────────────────────────────────────────────────
// AI Request Body Parsing
// ─────────────────────────────────────────────────────────────────────────────

interface AiRequestBody {
  model?: string;
  messages?: Array<{ role?: string; content?: string | object }>;
  prompt?: string;
  system?: string;
  conversationId?: string;
  sessionId?: string;
  parentMessageId?: string;
}

function parseAiRequestBody(bodyStr: string | null): AiRequestBody {
  if (!bodyStr) return {};
  try {
    return JSON.parse(bodyStr);
  } catch {
    return {};
  }
}

function extractAiPromptTokens(body: AiRequestBody): number {
  if (!body) return 0;
  // OpenAI / Anthropic / Google / Cohere / Together format
  if (body.messages) {
    const text = body.messages
      .map((m) => {
        if (typeof m.content === "string") return m.content;
        if (Array.isArray(m.content)) {
          return m.content
            .filter((p: any) => p.type === "text")
            .map((p: any) => p.text ?? "")
            .join(" ");
        }
        return "";
      })
      .join("\n");
    return estimateTokens(text);
  }
  // LLaMA / Ollama / raw prompt format
  if (body.prompt) return estimateTokens(String(body.prompt));
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// AI Response Body Parsing
// ─────────────────────────────────────────────────────────────────────────────

interface AiResponseBody {
  // OpenAI / compatible
  choices?: Array<{
    message?: { content?: string | null };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  model?: string;

  // Anthropic
  content?: Array<{ text?: string; type?: string; id?: string; name?: string; input?: string }>;
  stop_reason?: string;

  // Google / Gemini
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
}

function parseAiResponseBody(bodyStr: string | null): AiResponseBody {
  if (!bodyStr) return {};
  try {
    return JSON.parse(bodyStr);
  } catch {
    return {};
  }
}

function extractAiCompletionTokens(response: AiResponseBody): number {
  if (!response) return 0;
  // OpenAI
  if (response.usage?.completion_tokens) return response.usage.completion_tokens;
  // Anthropic (uses usageMetadata)
  // Google
  if (response.usageMetadata?.candidatesTokenCount) {
    return response.usageMetadata.candidatesTokenCount;
  }
  // Fallback: decode content estimate
  const content = extractAssistantMessage(response);
  return estimateTokens(content ?? "");
}

function extractAssistantMessage(response: AiResponseBody): string | null {
  if (!response) return null;
  // OpenAI / compatible
  if (response.choices?.[0]?.message?.content != null) {
    return response.choices[0].message!.content ?? null;
  }
  // Anthropic
  const textPart = response.content?.find((c) => c.type === "text");
  if (textPart?.text) return textPart.text;
  // Google
  const part = response.candidates?.[0]?.content?.parts?.[0];
  if (part?.text) return part.text;
  return null;
}

function extractAiUsage(response: AiResponseBody): AiUsage | null {
  if (!response) return null;
  if (response.usage) {
    return {
      promptTokens: response.usage.prompt_tokens ?? null,
      completionTokens: response.usage.completion_tokens ?? null,
      totalTokens: response.usage.total_tokens ?? null,
    };
  }
  if (response.usageMetadata) {
    return {
      promptTokens: response.usageMetadata.promptTokenCount ?? null,
      completionTokens: response.usageMetadata.candidatesTokenCount ?? null,
      totalTokens: response.usageMetadata.totalTokenCount ?? null,
    };
  }
  return null;
}

function extractFinishReason(response: AiResponseBody): string | null {
  if (!response) return null;
  // OpenAI
  if (response.choices?.[0]?.finish_reason) return response.choices![0].finish_reason!;
  // Anthropic
  if (response.stop_reason) return response.stop_reason;
  // Google
  if (response.candidates?.[0]) return "stop";
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Response Parsing Plugins (inspired by SDPO verl patterns)
// ─────────────────────────────────────────────────────────────────────────────

/** Extract \boxed{...} from math responses */
function extractMathAnswer(message: string | null): string | null {
  if (!message) return null;
  // Pattern: \boxed{answer} or \boxed answer
  const patterns = [
    /\\boxed\s*\{([^}]+)\}/,
    /\\boxed\s+(\S+)/,
    /\\boxed\{([^}]+)\}/,
  ];
  for (const pat of patterns) {
    const m = message.match(pat);
    if (m) return m[1].trim();
  }
  return null;
}

/** Extract code blocks from markdown (```lang\ncode```) */
function extractCodeBlocks(message: string | null): Array<{ language: string; code: string }> {
  if (!message) return [];
  const blocks: Array<{ language: string; code: string }> = [];
  const re = /```(\w*)\n?([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(message)) !== null) {
    blocks.push({ language: m[1] || "text", code: m[2].trimEnd() });
  }
  return blocks;
}

/** Extract tool calls from OpenAI/Anthropic/Gemini format */
function extractToolCalls(response: AiResponseBody): Array<{ id: string; name: string; arguments: string }> {
  if (!response) return [];
  const calls: Array<{ id: string; name: string; arguments: string }> = [];

  // OpenAI function_calling / tool_calls
  for (const choice of response.choices ?? []) {
    const msg = choice.message as any;
    if (msg?.tool_calls) {
      for (const tc of msg.tool_calls) {
        calls.push({
          id: tc.id ?? "",
          name: tc.function?.name ?? "",
          arguments: typeof tc.function?.arguments === "string"
            ? tc.function.arguments
            : JSON.stringify(tc.function?.arguments ?? {}),
        });
      }
    }
  }

  // Anthropic tool_use blocks
  for (const block of response.content ?? []) {
    if (block.type === "tool_use") {
      calls.push({
        id: block.id ?? "",
        name: block.name ?? "",
        arguments: typeof block.input === "object"
          ? JSON.stringify(block.input)
          : String(block.input ?? "{}"),
      });
    }
  }

  return calls;
}

// ─────────────────────────────────────────────────────────────────────────────
// AI Conversation / Session Tracking
// ─────────────────────────────────────────────────────────────────────────────

function extractConversationId(
  reqHeaders: Record<string, string>,
  reqBody: AiRequestBody,
): string | null {
  return (
    reqHeaders["x-conversation-id"] ??
    reqHeaders["x-session-id"] ??
    reqBody.conversationId ??
    reqBody.sessionId ??
    null
  );
}

function extractParentRequestId(
  reqHeaders: Record<string, string>,
  reqBody: AiRequestBody,
): string | null {
  return (
    reqHeaders["x-parent-message-id"] ??
    reqHeaders["anthropic-parent-message-id"] ??
    reqHeaders["x-request-id"] ??
    reqBody.parentMessageId ??
    null
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// AI Distillation Enrichment
// ─────────────────────────────────────────────────────────────────────────────

function enrichWithAiDistillation(
  tx: Omit<CapturedTransaction, keyof ReturnType<typeof buildAiFields>>,
): CapturedTransaction {
  const fields = buildAiFields(tx);
  return { ...tx, ...fields };
}

function buildAiFields(tx: {
  url: string;
  reqHeaders: Record<string, string>;
  resHeaders: Record<string, string>;
  reqBody: string | null;
  resBody: string | null;
  statusCode: number;
}): Pick<
  CapturedTransaction,
  | "aiProvider"
  | "aiModel"
  | "aiPromptTokens"
  | "aiCompletionTokens"
  | "aiTotalTokens"
  | "aiEstimatedCostUsd"
  | "aiConversationId"
  | "aiParentRequestId"
  | "aiParsedResponse"
> {
  let hostname = "";
  try {
    hostname = new URL(tx.url).hostname;
  } catch {
    // ignore
  }

  const provider = detectAiProvider(hostname);
  if (!provider) {
    return {
      aiProvider: null,
      aiModel: null,
      aiPromptTokens: null,
      aiCompletionTokens: null,
      aiTotalTokens: null,
      aiEstimatedCostUsd: null,
      aiConversationId: null,
      aiParentRequestId: null,
      aiParsedResponse: null,
    };
  }

  const reqBody = parseAiRequestBody(tx.reqBody);
  const resBody = parseAiResponseBody(tx.resBody);

  const model = resBody.model ?? reqBody.model ?? null;

  // Token counts
  const usage = extractAiUsage(resBody);
  const promptTokens = usage?.promptTokens ?? extractAiPromptTokens(reqBody);
  const completionTokens = usage?.completionTokens ?? extractAiCompletionTokens(resBody);
  const totalTokens = (usage?.totalTokens ?? (promptTokens + completionTokens)) || null;

  // Cost estimate
  const costUsd =
    model && promptTokens > 0 && completionTokens > 0
      ? estimateCost(provider, model, promptTokens, completionTokens)
      : null;

  // Conversation tracking
  const conversationId = extractConversationId(tx.reqHeaders, reqBody);
  const parentRequestId = extractParentRequestId(tx.reqHeaders, reqBody);

  // Parse response
  const assistantMessage = extractAssistantMessage(resBody);
  const parsedResponse: AiParsedResponse = {
    assistantMessage,
    mathAnswer: extractMathAnswer(assistantMessage),
    codeBlocks: extractCodeBlocks(assistantMessage),
    toolCalls: extractToolCalls(resBody),
    usage,
    finishReason: extractFinishReason(resBody),
  };

  return {
    aiProvider: provider,
    aiModel: model,
    aiPromptTokens: promptTokens > 0 ? promptTokens : null,
    aiCompletionTokens: completionTokens > 0 ? completionTokens : null,
    aiTotalTokens: totalTokens,
    aiEstimatedCostUsd: costUsd,
    aiConversationId: conversationId,
    aiParentRequestId: parentRequestId,
    aiParsedResponse: parsedResponse,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Content-Type Helpers
// ─────────────────────────────────────────────────────────────────────────────

const TEXT_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
]);

function isTextContentType(ct: string | undefined): boolean {
  if (!ct) return false;
  const lower = ct.toLowerCase();
  return (
    lower.startsWith("text/") ||
    lower === "application/json" ||
    lower === "application/xml" ||
    lower === "application/javascript"
  );
}

function encodeBody(
  body: Buffer,
  contentType: string | undefined,
  maxBytes: number,
): { body: string | null; encoding: "utf8" | "base64" | null; truncated: boolean } {
  if (body.length === 0) return { body: null, encoding: null, truncated: false };
  const truncated = body.length > maxBytes;
  const truncatedBody = truncated ? body.subarray(0, maxBytes) : body;
  if (isTextContentType(contentType)) {
    return {
      body: new TextDecoder("utf-8", { fatal: false }).decode(truncatedBody),
      encoding: "utf8",
      truncated,
    };
  }
  return {
    body: Buffer.from(truncatedBody).toString("base64"),
    encoding: "base64",
    truncated,
  };
}

function bestEffortDecode(
  rawBody: Buffer | null,
  contentEncoding: string | null,
): { preview: string | null; previewEncoding: string | null } {
  if (!rawBody || rawBody.length === 0)
    return { preview: null, previewEncoding: null };
  const preview = new TextDecoder("utf-8", { fatal: false }).decode(
    rawBody.subarray(0, 65536),
  );
  return {
    preview: preview.length > 0 ? preview : null,
    previewEncoding: contentEncoding,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP Parsing Helpers
// ─────────────────────────────────────────────────────────────────────────────

function parseHttpMessage(data: Buffer): {
  startLine: string;
  headers: Record<string, string>;
  body: Buffer;
} {
  const idx = data.indexOf("\r\n\r\n");
  if (idx === -1) {
    return { startLine: "", headers: {}, body: Buffer.alloc(0) };
  }
  const headerSection = data.subarray(0, idx).toString("utf-8");
  const body = data.subarray(idx + 4);
  const lines = headerSection.split("\r\n");
  const startLine = lines[0] ?? "";
  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const colonIdx = lines[i].indexOf(":");
    if (colonIdx === -1) continue;
    const key = lines[i].slice(0, colonIdx).trim();
    const value = lines[i].slice(colonIdx + 1).trim();
    headers[key.toLowerCase()] = value;
  }
  return { startLine, headers, body };
}

function parseResponseLine(line: string): {
  httpVersion: string;
  statusCode: number;
  statusMessage: string;
} {
  const parts = line.split(" ", 3);
  return {
    httpVersion: parts[0] ?? "1.1",
    statusCode: parseInt(parts[1] ?? "0", 10),
    statusMessage: parts[2] ?? "",
  };
}

async function readRequestHeaders(
  socket: net.Socket | tls.TLSSocket,
): Promise<{ headers: Record<string, string>; body: Buffer }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let idx = -1;

    function onData(chunk: Buffer) {
      chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      idx = buf.indexOf("\r\n\r\n");
      if (idx !== -1) {
        socket.removeListener("data", onData);
        const headerSection = buf.subarray(0, idx).toString("utf-8");
        const rawBody = buf.subarray(idx + 4);
        const headers: Record<string, string> = {};
        const lines = headerSection.split("\r\n");
        for (let i = 1; i < lines.length; i++) {
          const ci = lines[i].indexOf(":");
          if (ci === -1) continue;
          const key = lines[i].slice(0, ci).trim();
          const val = lines[i].slice(ci + 1).trim();
          headers[key.toLowerCase()] = val;
        }
        resolve({ headers, body: rawBody });
      }
    }

    socket.on("data", onData);
    socket.once("error", () => {
      socket.removeListener("data", onData);
      resolve({ headers: {}, body: Buffer.alloc(0) });
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Base Transaction Builder
// ─────────────────────────────────────────────────────────────────────────────

function buildBaseTransaction(opts: {
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
}): CapturedTransaction {
  return {
    ...opts,
    aiProvider: null,
    aiModel: null,
    aiPromptTokens: null,
    aiCompletionTokens: null,
    aiTotalTokens: null,
    aiEstimatedCostUsd: null,
    aiConversationId: null,
    aiParentRequestId: null,
    aiParsedResponse: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Proxy Server
// ─────────────────────────────────────────────────────────────────────────────

export class ProxyServer {
  private server: http.Server;
  private opts: ProxyOptions;
  private running = false;

  constructor(opts: ProxyOptions) {
    this.opts = opts;
    this.server = http.createServer();
    this.server.on("request", (req, res) => {
      void this.handleHttpRequest(req, res);
    });
    this.server.on("connect", (req, clientSocket, head) => {
      void this.handleConnect(req, clientSocket as net.Socket, head);
    });
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.opts.port, this.opts.host, () => {
        this.running = true;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }

  private buildTx(opts: Parameters<typeof buildBaseTransaction>[0]): CapturedTransaction {
    return enrichWithAiDistillation(buildBaseTransaction(opts) as any);
  }

  private async handleHttpRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const txId = randomUUID();
    const timestamp = new Date().toISOString();
    const startMs = Date.now();
    const url = req.url ?? "";
    const method = req.method ?? "GET";

    const reqHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") reqHeaders[k] = v;
      else if (Array.isArray(v)) reqHeaders[k] = v.join(", ");
    }

    let reqBodyBuf = Buffer.alloc(0);
    for await (const chunk of req) {
      reqBodyBuf = Buffer.concat([reqBodyBuf, chunk]);
    }

    const { body: reqBody, encoding: reqBodyEncoding, truncated: reqBodyTruncated } =
      encodeBody(reqBodyBuf, reqHeaders["content-type"], this.opts.maxBodyBytes);

    let targetHost: string;
    let targetPort: number;
    let targetPath: string;
    try {
      const parsedUrl = new URL(url);
      targetHost = parsedUrl.hostname;
      targetPort = parseInt(parsedUrl.port, 10) || (parsedUrl.protocol === "https:" ? 443 : 80);
      targetPath = `${parsedUrl.pathname}${parsedUrl.search}`;
    } catch {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("Bad Request");
      return;
    }

    const upstream = net.connect(targetPort, targetHost);

    const tx = new Promise<CapturedTransaction>((resolveTx, rejectTx) => {
      upstream.once("connect", () => {
        const hdrObj: Record<string, string> = { host: targetHost };
        for (const [k, v] of Object.entries(reqHeaders)) {
          if (k !== "host") hdrObj[k] = v;
        }
        let upstreamReq = `${method} ${targetPath} HTTP/1.1\r\n`;
        for (const [k, v] of Object.entries(hdrObj)) {
          upstreamReq += `${k}: ${v}\r\n`;
        }
        upstreamReq += `\r\n`;
        upstream.write(upstreamReq);
        if (reqBodyBuf.length > 0) upstream.write(reqBodyBuf);

        const resChunks: Buffer[] = [];
        upstream.on("data", (chunk: Buffer) => resChunks.push(chunk));
        upstream.on("end", () => {
          const full = Buffer.concat(resChunks);
          const parsed = parseHttpMessage(full);
          const { statusCode, statusMessage } = parseResponseLine(
            parsed.startLine || "HTTP/1.1 200 OK",
          );
          const rawBody = parsed.body;
          const contentEncoding = parsed.headers["content-encoding"] ?? null;
          const contentType = parsed.headers["content-type"];
          const { body: resBody, encoding: resBodyEncoding, truncated: resBodyTruncated } =
            encodeBody(rawBody, contentType, this.opts.maxBodyBytes);
          const { preview, previewEncoding } = bestEffortDecode(rawBody, contentEncoding);
          const durationMs = Date.now() - startMs;

          resolveTx(
            this.buildTx({
              id: txId,
              timestamp,
              method,
              url,
              reqHeaders,
              resHeaders: parsed.headers,
              reqBody,
              reqBodyEncoding,
              reqBodyTruncated,
              resBody,
              resBodyEncoding,
              resBodyTruncated,
              statusCode,
              durationMs,
              error: null,
              contentEncoding,
              resBodyPreview: preview,
              resBodyPreviewEncoding: previewEncoding,
            }),
          );

          let resLine = `HTTP/1.1 ${statusCode} ${statusMessage}\r\n`;
          for (const [k, v] of Object.entries(parsed.headers)) {
            resLine += `${k}: ${v}\r\n`;
          }
          resLine += `\r\n`;
          res.writeHead(200, "OK");
          res.write(resLine);
          if (parsed.body.length > 0) res.write(parsed.body);
          res.end();
        });
        upstream.on("error", (err: Error) => {
          resolveTx(
            this.buildTx({
              id: txId,
              timestamp,
              method,
              url,
              reqHeaders,
              resHeaders: {},
              reqBody,
              reqBodyEncoding,
              reqBodyTruncated,
              resBody: null,
              resBodyEncoding: null,
              resBodyTruncated: false,
              statusCode: 0,
              durationMs: Date.now() - startMs,
              error: `Upstream error: ${err.message}`,
              contentEncoding: null,
              resBodyPreview: null,
              resBodyPreviewEncoding: null,
            }),
          );
          res.writeHead(502, { "Content-Type": "text/plain" });
          res.end("Proxy error");
        });
      });
    });

    const transaction = await tx;
    this.opts.onTransaction(transaction);
    upstream.end();
  }

  private async handleConnect(
    req: http.IncomingMessage,
    clientSocket: net.Socket,
    _head: Buffer,
  ): Promise<void> {
    const txId = randomUUID();
    const timestamp = new Date().toISOString();
    const startMs = Date.now();

    const parts = (req.url ?? "").split(":");
    const host = parts[0];
    const port = parseInt(parts[1] ?? "443", 10);

    if (!host) {
      clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      clientSocket.end();
      return;
    }

    const upstream = net.connect(port, host);
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");

    const { certPem, keyPem } = getLeafCert(host, this.opts.caCertPath, this.opts.caKeyPath);

    let clientSecureCtx: tls.SecureContext;
    try {
      clientSecureCtx = createSecureContext({ cert: certPem, key: keyPem });
    } catch {
      clientSocket.end();
      upstream.end();
      return;
    }

    const clientTls = new tls.TLSSocket(clientSocket, {
      secureContext: clientSecureCtx,
      isServer: true,
    });
    const upstreamTls = new tls.TLSSocket(upstream, { rejectUnauthorized: false });

    await new Promise<void>((resolve, reject) => {
      clientTls.on("secureConnect", () => resolve());
      clientTls.on("error", reject);
      upstreamTls.on("error", () => { /* resolved on upstream connect */ });
    });

    const { headers: reqHeaders, body: reqBodyBuf } = await readRequestHeaders(clientTls);

    // Parse request line from the first bytes of the TLS stream
    // We already have the full buffer from readRequestHeaders
    const rawReq = reqBodyBuf; // readRequestHeaders returns body after headers
    void rawReq;

    // Re-read full request from TLS socket to get method + path
    const fullReqBuf = await new Promise<Buffer>((resolve) => {
      const chunks: Buffer[] = [];
      function handler(chunk: Buffer) {
        chunks.push(chunk);
        const buf = Buffer.concat(chunks);
        const idx = buf.indexOf("\r\n\r\n");
        if (idx !== -1) {
          clientTls.removeListener("data", handler);
          resolve(buf);
        }
      }
      clientTls.on("data", handler);
      clientTls.once("error", () => resolve(Buffer.alloc(0)));
    });

    const parsedReq = parseHttpMessage(fullReqBuf);
    const reqLineParts = parsedReq.startLine.split(" ");
    const method = reqLineParts[0] ?? "GET";
    const reqPath = reqLineParts[1] ?? "/";
    const effectiveUrl = `https://${host}:${port}${reqPath}`;
    const contentType = reqHeaders["content-type"];

    const { body: reqBody, encoding: reqBodyEncoding, truncated: reqBodyTruncated } =
      encodeBody(reqBodyBuf, contentType, this.opts.maxBodyBytes);

    // Forward to upstream
    let upstreamReq = `${method} ${reqPath} HTTP/1.1\r\n`;
    for (const [k, v] of Object.entries(reqHeaders)) {
      if (k) upstreamReq += `${k}: ${v}\r\n`;
    }
    upstreamReq += `\r\n`;
    upstreamTls.write(upstreamReq);
    if (reqBodyBuf.length > 0) upstreamTls.write(reqBodyBuf);

    const resChunks: Buffer[] = [];
    let upstreamDone = false;

    const txPromise = new Promise<CapturedTransaction>((resolveTx) => {
      upstreamTls.on("data", (chunk: Buffer) => resChunks.push(chunk));

      upstreamTls.on("end", () => {
        upstreamDone = true;
        const full = Buffer.concat(resChunks);
        const parsed = parseHttpMessage(full);
        const { statusCode, statusMessage } = parseResponseLine(
          parsed.startLine || "HTTP/1.1 200 OK",
        );
        const rawBody = parsed.body;
        const contentEncoding = parsed.headers["content-encoding"] ?? null;
        const resContentType = parsed.headers["content-type"];
        const { body: resBody, encoding: resBodyEncoding, truncated: resBodyTruncated } =
          encodeBody(rawBody, resContentType, this.opts.maxBodyBytes);
        const { preview, previewEncoding } = bestEffortDecode(rawBody, contentEncoding);
        const durationMs = Date.now() - startMs;

        resolveTx(
          this.buildTx({
            id: txId,
            timestamp,
            method,
            url: effectiveUrl,
            reqHeaders,
            resHeaders: parsed.headers,
            reqBody,
            reqBodyEncoding,
            reqBodyTruncated,
            resBody,
            resBodyEncoding,
            resBodyTruncated,
            statusCode,
            durationMs,
            error: null,
            contentEncoding,
            resBodyPreview: preview,
            resBodyPreviewEncoding: previewEncoding,
          }),
        );

        // Write response back to client
        let resLine = `HTTP/1.1 ${statusCode} ${statusMessage}\r\n`;
        for (const [k, v] of Object.entries(parsed.headers)) {
          resLine += `${k}: ${v}\r\n`;
        }
        resLine += `\r\n`;
        clientTls.write(resLine);
        if (rawBody.length > 0) clientTls.write(rawBody);
        clientTls.end();
        upstreamTls.end();
      });

      upstreamTls.on("error", (err: Error) => {
        if (!upstreamDone) {
          upstreamDone = true;
          resolveTx(
            this.buildTx({
              id: txId,
              timestamp,
              method,
              url: effectiveUrl,
              reqHeaders,
              resHeaders: {},
              reqBody,
              reqBodyEncoding,
              reqBodyTruncated,
              resBody: null,
              resBodyEncoding: null,
              resBodyTruncated: false,
              statusCode: 0,
              durationMs: Date.now() - startMs,
              error: `Upstream TLS error: ${err.message}`,
              contentEncoding: null,
              resBodyPreview: null,
              resBodyPreviewEncoding: null,
            }),
          );
          clientTls.destroy();
          upstreamTls.destroy();
        }
      });
    });

    const transaction = await txPromise;
    this.opts.onTransaction(transaction);

    // Tunnel remaining bytes after logging
    clientTls.pipe(upstreamTls);
    upstreamTls.pipe(clientTls);
    clientTls.on("error", () => upstreamTls.destroy());
    upstreamTls.on("error", () => clientTls.destroy());
  }
}
