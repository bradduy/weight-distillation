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

  // ── AI Distillation ──────────────────────────────────────
  /** Detected AI API provider (e.g. "openai", "anthropic", "google") */
  aiProvider: string | null;
  /** Model used in the request (e.g. "gpt-4o", "claude-3-5-sonnet-20250620") */
  aiModel: string | null;
  /** Estimated number of prompt tokens (request body) */
  aiPromptTokens: number | null;
  /** Estimated number of completion tokens (response body) */
  aiCompletionTokens: number | null;
  /** Total estimated tokens */
  aiTotalTokens: number | null;
  /** Estimated cost in USD */
  aiEstimatedCostUsd: number | null;
  /** Conversation/session ID (derived from headers or body) */
  aiConversationId: string | null;
  /** Parent request ID for multi-turn reply chains */
  aiParentRequestId: string | null;
  /** Structured parsed response from AI API */
  aiParsedResponse: AiParsedResponse | null;
}

export interface AiParsedResponse {
  /** Raw assistant message content (decoded from response body) */
  assistantMessage: string | null;
  /** Extracted answer for math tasks (\boxed{...} style) */
  mathAnswer: string | null;
  /** Extracted code blocks from response */
  codeBlocks: CodeBlock[];
  /** Detected tool calls in response */
  toolCalls: ToolCall[];
  /** Token usage reported by the API (if available, prefer over estimate) */
  usage: AiUsage | null;
  /**finish reason from API (stop, length, tool_calls) */
  finishReason: string | null;
}

export interface AiUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
}

export interface CodeBlock {
  language: string;
  code: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string; // JSON string of tool input args
}

export type AnalyzerEvent =
  | { type: "transactionAdded"; transaction: CapturedTransaction }
  | { type: "statsUpdated"; stats: StatsSnapshot };

export interface StatsSnapshot {
  total: number;
  errors: number;
  latencyP50ms: number;
  latencyP95ms: number;
  // AI distillation stats
  aiCalls: number;
  aiTotalTokens: number;
  aiEstimatedCostUsd: number;
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
