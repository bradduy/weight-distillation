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
}

export type AnalyzerEvent =
  | { type: "transactionAdded"; transaction: CapturedTransaction }
  | { type: "statsUpdated"; stats: StatsSnapshot };

export interface StatsSnapshot {
  total: number;
  errors: number;
  latencyP50ms: number;
  latencyP95ms: number;
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
