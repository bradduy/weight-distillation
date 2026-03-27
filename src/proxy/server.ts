import * as http from "node:http";
import * as net from "node:net";
import * as tls from "node:tls";
import { createSecureContext } from "node:tls";
import { randomUUID } from "node:crypto";
import type { CapturedTransaction, ProxyOptions } from "./types.js";
import { getLeafCert } from "./mitm.js";

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

interface ParsedRequest {
  method: string;
  url: string;
  httpVersion: string;
  headers: Record<string, string>;
  body: Buffer;
}

interface ParsedResponse {
  statusCode: number;
  statusMessage: string;
  httpVersion: string;
  headers: Record<string, string>;
  body: Buffer;
}

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

function parseRequestLine(line: string): {
  method: string;
  url: string;
  httpVersion: string;
} {
  const parts = line.split(" ");
  return {
    method: parts[0] ?? "",
    url: parts[1] ?? "",
    httpVersion: parts[2] ?? "1.1",
  };
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

async function readHttpBody(
  socket: net.Socket | tls.TLSSocket,
  headers: Record<string, string>,
  maxBytes: number,
): Promise<Buffer> {
  const contentLength = headers["content-length"];
  const chunked = headers["transfer-encoding"]?.toLowerCase() === "chunked";

  if (chunked) {
    const chunks: Buffer[] = [];
    let remaining = maxBytes;
    let done = false;

    while (!done) {
      const lenBuf = await readLineBuffer(socket);
      if (!lenBuf) break;
      const len = parseInt(lenBuf.toString("utf-8").trim(), 16);
      if (len === 0) {
        // final chunk
        await readLineBuffer(socket);
        done = true;
        break;
      }
      const toRead = Math.min(len, remaining);
      const chunk = await readExactBytes(socket, toRead);
      if (!chunk) break;
      chunks.push(chunk);
      remaining -= chunk.length;
      const trail = await readExactBytes(socket, len - chunk.length);
      if (trail) {
        const term = await readLineBuffer(socket);
        void term;
      }
      if (remaining <= 0) {
        // drain rest of this chunk and consume 0\r\n\r\n
        if (len > toRead) {
          const drain = await readExactBytes(socket, len - toRead);
          void drain;
        }
        const term = await readLineBuffer(socket);
        void term;
        break;
      }
    }
    return Buffer.concat(chunks);
  }

  if (contentLength !== undefined) {
    const len = parseInt(contentLength, 10);
    if (isNaN(len) || len <= 0) return Buffer.alloc(0);
    const toRead = Math.min(len, maxBytes);
    const body = await readExactBytes(socket, toRead);
    // drain remaining if truncated
    if (len > toRead) {
      const drain = await readExactBytes(socket, len - toRead);
      void drain;
    }
    return body ?? Buffer.alloc(0);
  }

  // no body expected
  return Buffer.alloc(0);
}

async function readLineBuffer(s: net.Socket | tls.TLSSocket): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    s.on("data", function handler(chunk: Buffer) {
      chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        s.removeListener("data", handler);
        const line = buf.subarray(0, nl + 1);
        // put rest back
        const rest = buf.subarray(nl + 1);
        if (rest.length > 0) s.unshift(rest);
        resolve(line);
      }
    });
    s.once("error", () => resolve(null));
    s.once("close", () => resolve(null));
  });
}

async function readExactBytes(
  s: net.Socket | tls.TLSSocket,
  n: number,
): Promise<Buffer | null> {
  if (n <= 0) return Buffer.alloc(0);
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    function handler(chunk: Buffer) {
      chunks.push(chunk);
      total += chunk.length;
      if (total >= n) {
        s.removeListener("data", handler);
        const result = Buffer.concat(chunks);
        const needed = result.subarray(0, n);
        const extra = result.subarray(n);
        if (extra.length > 0) s.unshift(extra);
        resolve(needed);
      }
    }
    s.on("data", handler);
    s.once("error", () => resolve(null));
    s.once("close", () => resolve(null));
  });
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

async function collectResponse(
  socket: tls.TLSSocket,
  maxBytes: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const headerChunks: Buffer[] = [];
    const bodyChunks: Buffer[] = [];
    let headerIdx = -1;
    let headers: Record<string, string> = {};
    let bodyStart = 0;
    let collected = 0;
    let done = false;

    function cleanup() {
      socket.removeListener("data", onData);
      socket.removeListener("error", onErr);
      socket.removeListener("close", onClose);
    }

    function finish(buf: Buffer) {
      if (done) return;
      done = true;
      cleanup();
      resolve(buf);
    }

    function onErr() {
      finish(Buffer.concat([...headerChunks, ...bodyChunks]));
    }

    function onClose() {
      finish(Buffer.concat([...headerChunks, ...bodyChunks]));
    }

    function onData(chunk: Buffer) {
      if (done) return;

      // Accumulate into headerChunks until we find headers
      if (headerIdx === -1) {
        headerChunks.push(chunk);
        const buf = Buffer.concat(headerChunks);
        headerIdx = buf.indexOf("\r\n\r\n");
        if (headerIdx !== -1) {
          // split: headers part and body start
          const headerSection = buf.subarray(0, headerIdx).toString("utf-8");
          const rawBody = buf.subarray(headerIdx + 4);
          const lines = headerSection.split("\r\n");
          for (let i = 1; i < lines.length; i++) {
            const ci = lines[i].indexOf(":");
            if (ci === -1) continue;
            const key = lines[i].slice(0, ci).trim();
            const val = lines[i].slice(ci + 1).trim();
            headers[key.toLowerCase()] = val;
          }
          bodyStart = 0;
          // Process body
          processBody(rawBody);
        }
      } else {
        processBody(chunk);
      }
    }

    function processBody(chunk: Buffer) {
      const contentLength = headers["content-length"];
      const chunked = headers["transfer-encoding"]?.toLowerCase() === "chunked";
      const isChunked = chunked;

      if (isChunked) {
        bodyChunks.push(chunk);
        collected += chunk.length;
        // Walk through chunked data
        const buf = Buffer.concat(bodyChunks);
        // Simple scan: look for \r\n0\r\n\r\n terminator
        if (buf.includes("\r\n0\r\n\r\n")) {
          finish(buf);
        } else if (collected > maxBytes * 2) {
          // safety valve
          finish(buf.subarray(0, maxBytes));
        }
      } else if (contentLength !== undefined) {
        // Already processed all headerChunks, need accumulated body
        const headerBuf = Buffer.concat(headerChunks);
        const totalHeaderLen =
          headerBuf.indexOf("\r\n\r\n") + 4;
        const existingBody = Buffer.concat(headerChunks).subarray(
          totalHeaderLen,
        );
        // Rebuild body from existing + new chunks
        bodyChunks.push(chunk);
        collected = existingBody.length + chunk.length;
        const totalBody = Buffer.concat([
          existingBody,
          ...bodyChunks.slice(0, -1).map((c) => c),
          chunk,
        ]);
        // Actually: reconstruct
        const allData = Buffer.concat([...headerChunks, ...bodyChunks]);
        const headerEnd = allData.indexOf("\r\n\r\n") + 4;
        const bodyBuf = allData.subarray(headerEnd);
        if (bodyBuf.length >= parseInt(contentLength, 10)) {
          finish(bodyBuf.subarray(0, parseInt(contentLength, 10)));
        }
      } else {
        // No Content-Length, collect everything up to maxBytes
        bodyChunks.push(chunk);
        collected += chunk.length;
        if (collected > maxBytes * 2) {
          finish(Buffer.concat(bodyChunks).subarray(0, maxBytes));
        }
      }
    }

    socket.on("data", onData);
    socket.once("error", onErr);
    socket.once("close", onClose);
  });
}

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

  private async handleHttpRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const txId = randomUUID();
    const timestamp = new Date().toISOString();
    const startMs = Date.now();
    const url = req.url ?? "";
    const method = req.method ?? "GET";

    // Collect request headers
    const reqHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") reqHeaders[k] = v;
      else if (Array.isArray(v)) reqHeaders[k] = v.join(", ");
    }

    // Read request body
    let reqBodyBuf = Buffer.alloc(0);
    for await (const chunk of req) {
      reqBodyBuf = Buffer.concat([reqBodyBuf, chunk]);
    }

    const { body: reqBody, encoding: reqBodyEncoding, truncated: reqBodyTruncated } =
      encodeBody(reqBodyBuf, reqHeaders["content-type"], this.opts.maxBodyBytes);

    // Determine target: for a forward proxy, the URL is absolute (http://host:port/path)
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

    const isHttps = targetPort === 443;
    const durationMs = () => Date.now() - startMs;

    const upstream = net.connect(targetPort, targetHost);

    const tx = new Promise<CapturedTransaction>((resolveTx) => {
      upstream.once("connect", () => {
        // Build request line + headers
        const reqLines = [`${method} ${targetPath} HTTP/1.1\r\n`];
        const hdrLines = Object.entries(reqHeaders);
        let hdrString = "";
        for (const [k, v] of hdrLines) {
          if (k === "host") {
            hdrString += `host: ${targetHost}\r\n`;
          } else {
            hdrString += `${k}: ${v}\r\n`;
          }
        }
        hdrString = hdrString || "";
        // Remove duplicate host
        const hdrObj: Record<string, string> = {};
        let sawHost = false;
        for (const [k, v] of hdrLines) {
          if (k === "host") {
            if (!sawHost) {
              hdrObj[k] = v;
              sawHost = true;
            }
          } else {
            hdrObj[k] = v;
          }
        }
        hdrObj["host"] = targetHost;

        let upstreamReq = `${method} ${targetPath} HTTP/1.1\r\n`;
        for (const [k, v] of Object.entries(hdrObj)) {
          upstreamReq += `${k}: ${v}\r\n`;
        }
        upstreamReq += `\r\n`;

        upstream.write(upstreamReq);
        if (reqBodyBuf.length > 0) {
          upstream.write(reqBodyBuf);
        }

        // Collect response
        const resChunks: Buffer[] = [];
        upstream.on("data", (chunk: Buffer) => {
          resChunks.push(chunk);
        });
        upstream.on("end", () => {
          const full = Buffer.concat(resChunks);
          const parsed = parseHttpMessage(full);
          const { statusCode, statusMessage } = parseResponseLine(parsed.startLine || "HTTP/1.1 200 OK");
          const resHeaders = parsed.headers;

          const contentEncoding = resHeaders["content-encoding"] ?? null;
          const contentType = resHeaders["content-type"];
          const rawBody = parsed.body;

          const { body: resBody, encoding: resBodyEncoding, truncated: resBodyTruncated } =
            encodeBody(rawBody, contentType, this.opts.maxBodyBytes);
          const { preview: resBodyPreview, previewEncoding: resBodyPreviewEncoding } =
            bestEffortDecode(rawBody, contentEncoding);

          const tx: CapturedTransaction = {
            id: txId,
            timestamp,
            method,
            url,
            reqHeaders,
            resHeaders,
            reqBody,
            reqBodyEncoding,
            reqBodyTruncated,
            resBody,
            resBodyEncoding,
            resBodyTruncated,
            statusCode,
            durationMs: durationMs(),
            error: null,
            contentEncoding,
            resBodyPreview,
            resBodyPreviewEncoding,
          };
          resolveTx(tx);

          // Forward response to original client
          let resLine = `HTTP/1.1 ${statusCode} ${statusMessage}\r\n`;
          for (const [k, v] of Object.entries(resHeaders)) {
            resLine += `${k}: ${v}\r\n`;
          }
          resLine += `\r\n`;
          res.writeHead(200, "OK");
          res.write(resLine);
          if (parsed.body.length > 0) {
            res.write(parsed.body);
          }
          res.end();
        });
        upstream.on("error", (err) => {
          const tx: CapturedTransaction = {
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
            durationMs: durationMs(),
            error: `Upstream error: ${err.message}`,
            contentEncoding: null,
            resBodyPreview: null,
            resBodyPreviewEncoding: null,
          };
          resolveTx(tx);
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

    // Parse host:port from CONNECT request line
    const reqLine = `${req.method} ${req.url}`;
    const parts = (req.url ?? "").split(":");
    const host = parts[0];
    const port = parseInt(parts[1] ?? "443", 10);

    if (!host) {
      clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      clientSocket.end();
      return;
    }

    // Connect upstream TCP
    const upstream = net.connect(port, host);

    // Respond 200 to client immediately
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");

    // Generate leaf cert BEFORE TLS handshake
    const { certPem, keyPem } = getLeafCert(host, this.opts.caCertPath, this.opts.caKeyPath);

    // Create TLS secure contexts
    let clientSecureCtx: tls.SecureContext;
    try {
      clientSecureCtx = createSecureContext({ cert: certPem, key: keyPem });
    } catch (certErr) {
      clientSocket.end();
      upstream.end();
      return;
    }

    // Wrap client socket in TLS (server-facing)
    const clientTls = new tls.TLSSocket(clientSocket, {
      secureContext: clientSecureCtx,
      isServer: true,
    });

    // Wrap upstream socket in TLS
    const upstreamTls = new tls.TLSSocket(upstream, {
      rejectUnauthorized: false,
    });

    // Wait for client TLS handshake to complete
    await new Promise<void>((resolveClientTls, rejectClientTls) => {
      clientTls.on("secureConnect", () => resolveClientTls());
      clientTls.on("error", (e) => rejectClientTls(e));
      upstreamTls.on("error", () => {
        // upstream errors resolved when upstream connects
      });
    });

    // Read parsed HTTP request from client TLS socket
    const { headers: reqHeaders, body: reqBodyBuf } = await readRequestHeaders(clientTls);

    const parsedStartLine = reqHeaders["_startLine"] ?? "";
    delete (reqHeaders as Record<string, string>)["_startLine"];
    const { method, url } = parseRequestLine(parsedStartLine || "GET / HTTP/1.1");
    const effectiveUrl = url.startsWith("http") ? url : `https://${host}:${port}${url}`;
    const contentType = reqHeaders["content-type"];

    const { body: reqBody, encoding: reqBodyEncoding, truncated: reqBodyTruncated } =
      encodeBody(reqBodyBuf, contentType, this.opts.maxBodyBytes);

    // Forward request to upstream TLS
    // Rebuild HTTP request
    let upstreamReq = `${method} ${url} HTTP/1.1\r\n`;
    for (const [k, v] of Object.entries(reqHeaders)) {
      if (k) upstreamReq += `${k}: ${v}\r\n`;
    }
    upstreamReq += `\r\n`;

    upstreamTls.write(upstreamReq);
    if (reqBodyBuf.length > 0) {
      upstreamTls.write(reqBodyBuf);
    }

    // Collect upstream response
    const resChunks: Buffer[] = [];
    let upstreamDone = false;

    const txPromise = new Promise<CapturedTransaction>((resolveTx) => {
      upstreamTls.on("data", (chunk: Buffer) => {
        resChunks.push(chunk);
      });

      upstreamTls.on("end", () => {
        upstreamDone = true;
        const fullResponse = Buffer.concat(resChunks);
        const parsed = parseHttpMessage(fullResponse);
        const { statusCode, statusMessage } = parseResponseLine(
          parsed.startLine || "HTTP/1.1 200 OK",
        );
        const resHeaders = parsed.headers;
        const rawBody = parsed.body;
        const contentEncoding = resHeaders["content-encoding"] ?? null;
        const resContentType = resHeaders["content-type"];

        const { body: resBody, encoding: resBodyEncoding, truncated: resBodyTruncated } =
          encodeBody(rawBody, resContentType, this.opts.maxBodyBytes);
        const { preview: resBodyPreview, previewEncoding: resBodyPreviewEncoding } =
          bestEffortDecode(rawBody, contentEncoding);

        const durationMs = Date.now() - startMs;

        const tx: CapturedTransaction = {
          id: txId,
          timestamp,
          method,
          url: effectiveUrl,
          reqHeaders,
          resHeaders,
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
          resBodyPreview,
          resBodyPreviewEncoding,
        };
        resolveTx(tx);
      });

      upstreamTls.on("error", (err) => {
        if (!upstreamDone) {
          upstreamDone = true;
          const durationMs = Date.now() - startMs;
          const tx: CapturedTransaction = {
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
            durationMs,
            error: `Upstream TLS error: ${err.message}`,
            contentEncoding: null,
            resBodyPreview: null,
            resBodyPreviewEncoding: null,
          };
          resolveTx(tx);
        }
        clientTls.destroy();
        upstreamTls.destroy();
      });
    });

    const transaction = await txPromise;
    this.opts.onTransaction(transaction);

    // Pipe remaining data (CONNECT tunnel: raw bytes after headers)
    const pipeTunnel = () => {
      clientTls.pipe(upstreamTls);
      upstreamTls.pipe(clientTls);
    };

    clientTls.on("error", () => {
      upstreamTls.destroy();
    });
    upstreamTls.on("error", () => {
      clientTls.destroy();
    });

    pipeTunnel();
  }
}
