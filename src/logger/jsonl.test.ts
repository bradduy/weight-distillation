import { describe, test, expect } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { JsonlLogger } from "./jsonl.js";

describe("JsonlLogger", () => {
  test("write() appends a valid JSON line", async () => {
    const tmpDir = await mkdtemp(tmpdir() + "/jsonl-test-");
    const logPath = tmpDir + "/traffic.jsonl";
    const logger = new JsonlLogger(logPath);
    const record = {
      id: "abc", timestamp: "2026-03-26T00:00:00Z", method: "GET",
      url: "https://example.com", reqHeaders: {}, resHeaders: {},
      reqBody: null, reqBodyEncoding: null, reqBodyTruncated: false,
      resBody: null, resBodyEncoding: null, resBodyTruncated: false,
      statusCode: 200, durationMs: 10, error: null, contentEncoding: null,
      resBodyPreview: null, resBodyPreviewEncoding: null,
      aiProvider: null, aiModel: null, aiPromptTokens: null, aiCompletionTokens: null,
      aiTotalTokens: null, aiEstimatedCostUsd: null, aiConversationId: null,
      aiParentRequestId: null, aiParsedResponse: null,
    };
    logger.write(record);
    await logger.close();
    const content = await Bun.file(logPath).text();
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.id).toBe("abc");
    expect(parsed.statusCode).toBe(200);
  });

  test("write() does not produce partial lines on multiple writes", async () => {
    const tmpDir = await mkdtemp(tmpdir() + "/jsonl-test-");
    const logPath = tmpDir + "/multi.jsonl";
    const logger = new JsonlLogger(logPath);
    for (let i = 0; i < 5; i++) {
      logger.write({
        id: String(i), timestamp: "", method: "GET", url: "",
        reqHeaders: {}, resHeaders: {},
        reqBody: null, reqBodyEncoding: null, reqBodyTruncated: false,
        resBody: null, resBodyEncoding: null, resBodyTruncated: false,
        statusCode: 200, durationMs: 0, error: null, contentEncoding: null,
        resBodyPreview: null, resBodyPreviewEncoding: null,
        aiProvider: null, aiModel: null, aiPromptTokens: null, aiCompletionTokens: null,
        aiTotalTokens: null, aiEstimatedCostUsd: null, aiConversationId: null,
        aiParentRequestId: null, aiParsedResponse: null,
      });
    }
    await logger.close();
    const content = await Bun.file(logPath).text();
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(5);
    lines.forEach((line: string) => {
      expect(() => JSON.parse(line)).not.toThrow();
    });
  });

  test("close() is idempotent", async () => {
    const tmpDir = await mkdtemp(tmpdir() + "/jsonl-test-");
    const logPath = tmpDir + "/close.jsonl";
    const logger = new JsonlLogger(logPath);
    await logger.close();
    await expect(logger.close()).resolves.toBeUndefined();
  });
});
