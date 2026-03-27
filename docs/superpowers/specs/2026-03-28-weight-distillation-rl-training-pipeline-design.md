# Weight-Distillation RL Training Pipeline — Design Specification

## Overview

Integrate an SDPO-inspired reinforcement learning data pipeline into `weight-distillation` so captured AI API traffic can be transformed into **training-ready distillation records** with reward signals. The first target domain is **code generation**, scored by an **external sandbox service**.

This design intentionally keeps online proxy flow fast and stable while adding asynchronous reward enrichment and export to SDPO-compatible datasets.

---

## Goals

1. Capture code-generation traces from AI API traffic.
2. Extract `{prompt, completion, model, provider, tests}` examples.
3. Compute reward via external sandbox service (`pass_rate`, feedback, runtime status).
4. Persist enriched distillation records.
5. Export training-ready datasets for downstream SDPO training jobs.

---

## Non-Goals (v1)

- Running RL policy updates inside this proxy process.
- Replacing SDPO/verl training loop implementation.
- Multi-domain reward scoring (math/chat) in same first release.
- Building custom code execution sandbox runtime (we call an external API).

---

## Architecture

```
CapturedTransaction
   │
   ▼
DistillationPipeline
   ├── CodeSampleExtractor
   │      └── parse prompt/completion/code blocks/tests
   ├── SandboxRewardClient
   │      └── send sample -> receive score + feedback
   ├── DistillationRecordWriter
   │      └── append JSONL record
   └── SdpoExporter
          └── periodic SDPO-ready dataset export
```

### Existing integration points

- `src/proxy/server.ts` already enriches transactions with:
  - provider, model
  - estimated tokens/cost
  - parsed response (assistant message, code blocks, tool calls)
- `src/analyzer/index.ts` already aggregates AI call stats.

The new pipeline subscribes to these enriched transaction events and adds reward + export layers.

---

## New Components

## 1) `src/distillation/types.ts`

Defines strict data contracts.

```ts
export interface CodeSample {
  id: string;
  timestamp: string;
  provider: string;
  model: string;
  prompt: string;
  completion: string;
  codeBlocks: Array<{ language: string; code: string }>;
  tests: string[];
  conversationId: string | null;
  parentRequestId: string | null;
  metadata: Record<string, unknown>;
}

export interface RewardResult {
  score: number; // [0,1]
  passRate: number; // [0,1]
  status: "ok" | "timeout" | "runtime_error" | "compile_error" | "scoring_failed";
  feedback: string;
  logs?: string;
}

export interface DistillationRecord {
  sample: CodeSample;
  reward: RewardResult | null;
  createdAt: string;
  version: "v1";
}

export interface SdpoExportRow {
  prompt: string;
  completion: string;
  reward: number | null;
  source: string;
  model: string;
  tests: string;
  feedback: string | null;
  timestamp: string;
  conversation_id: string | null;
  metadata: string; // serialized JSON
}
```

---

## 2) `src/distillation/extractors/code.ts`

Responsibility: classify and extract code-generation samples from transactions.

Rules:
- Keep if:
  - `tx.aiProvider != null`
  - `tx.aiParsedResponse?.codeBlocks.length > 0` OR endpoint matches known code-gen paths
- Prompt extraction order:
  1. parse `reqBody.messages` and join user/system text
  2. fallback `reqBody.prompt`
  3. fallback raw `reqBody`
- Completion extraction:
  - `tx.aiParsedResponse.assistantMessage`
- Tests extraction (best-effort):
  - parse from prompt for fenced `tests` blocks
  - parse known schema keys (`tests`, `unit_tests`, `test_cases`)

Output: `CodeSample | null`

---

## 3) `src/distillation/reward/sandbox-client.ts`

Responsibility: call external sandbox API.

Interface:

```ts
export interface SandboxClientConfig {
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
  maxRetries: number;
}

export class SandboxRewardClient {
  constructor(cfg: SandboxClientConfig);
  scoreCode(sample: CodeSample): Promise<RewardResult>;
}
```

Behavior:
- HTTP POST to `/score/code`
- Retries with exponential backoff on network failures
- Timeout handling
- Normalize response into `RewardResult`
- Never throw unhandled errors to pipeline; return `status: "scoring_failed"`

---

## 4) `src/distillation/pipeline.ts`

Responsibility: orchestration and async safety.

```ts
export interface DistillationPipelineConfig {
  enabled: boolean;
  domain: "code";
  outputPath: string;
  sandboxUrl: string;
  sandboxApiKey?: string;
  maxConcurrentScorers: number;
}

export class DistillationPipeline {
  onTransaction(tx: CapturedTransaction): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}
```

Flow per transaction:
1. Extract code sample.
2. If not code sample: skip with reason.
3. Send scoring task to bounded async queue.
4. Receive reward result.
5. Build `DistillationRecord`.
6. Append record to JSONL.
7. Signal exporter checkpoint.

Important constraints:
- **Do not block proxy response path**.
- Queue backpressure: if queue full, drop or defer with warning metric.

---

## 5) `src/distillation/export/sdpo-exporter.ts`

Responsibility: convert records to SDPO-ready rows.

Modes:
- JSONL export (required v1)
- Parquet export (optional v1.1)

Fields:
- `prompt`
- `completion`
- `reward`
- `source`
- `model`
- `tests`
- `feedback`
- `timestamp`
- `conversation_id`
- `metadata`

---

## 6) `src/distillation/storage/jsonl-record-writer.ts`

Responsibility: robust append-only writing for distillation records.

- Similar durability guarantees as existing `JsonlLogger`
- New file path default: `~/.config/weight-distillation/distillation.jsonl`

---

## Configuration & CLI Changes

Update `src/cli.ts` with new options:

- `--distill-enabled`
- `--distill-domain code`
- `--distill-output <path>` (default: `~/.config/weight-distillation/distillation.jsonl`)
- `--sandbox-url <url>`
- `--sandbox-api-key <key>` (or env fallback)
- `--distill-max-concurrency <n>`

Initialize pipeline when enabled and subscribe it to analyzer/transaction flow.

---

## Data Flow Details

1. Proxy captures request/response.
2. `CapturedTransaction` enriched with AI metadata.
3. Distillation pipeline receives transaction.
4. Code extractor derives sample.
5. Sandbox scores sample.
6. Distillation record written.
7. Export row emitted (batch/interval).

---

## Error Handling

- Malformed JSON request/response: skip extraction, record reason.
- Missing completion text: skip extraction.
- Sandbox timeout: reward status `timeout`, score null.
- Sandbox non-200: `scoring_failed`.
- Writer failure: retry, then fail-safe spool + warning.
- Export failure: keep source JSONL intact and retry later.

---

## Observability

Add counters in pipeline:
- `distill.samples_detected`
- `distill.samples_scored`
- `distill.samples_failed`
- `distill.samples_skipped`
- `distill.queue_depth`
- `distill.export_rows_written`

Add periodic summary in logs:
- scored count
- avg pass_rate
- avg reward
- scoring failure ratio

---

## Testing Strategy

### Unit tests

1. `code extractor`
- detects code sample from transaction
- ignores non-code AI calls
- extracts prompt/completion/code blocks/tests

2. `sandbox client`
- success mapping
- timeout mapping
- retry/backoff behavior

3. `sdpo exporter`
- row mapping correctness
- null reward handling

### Integration tests

1. `pipeline end-to-end`
- synthetic transaction -> mock sandbox -> distillation JSONL row

2. `non-blocking behavior`
- pipeline does not delay proxy response path

3. `shutdown flush`
- queued jobs persist before process exit

---

## Security & Safety

- Sandbox API key loaded from env/config, never logged.
- Redact sensitive auth headers in metadata export.
- Optional filter to hash prompt/completion before export if needed.
- Distillation files are local-only unless user exports.

---

## Rollout Plan

### Phase 1 (this implementation)
- Code-domain extraction
- External sandbox scoring
- JSONL distillation output
- SDPO JSONL export rows

### Phase 2
- Add math reward plugin (`\boxed{}` exact-match)
- Add chat-quality plugin
- Add parquet exporter

### Phase 3
- Direct integration helper script to launch SDPO training with exported dataset

---

## Acceptance Criteria

- Running proxy with `--distill-enabled` produces distillation records for code calls.
- Records contain reward from sandbox API.
- Export output is consumable by SDPO-style training preprocessing.
- Proxy latency impact remains minimal (async queue, non-blocking).
- Tests cover extraction, scoring, export, and pipeline flow.

---

## Recommendation

Proceed with this event-driven asynchronous pipeline as v1. It achieves your goal (distillation-to-RL training bridge) without turning the proxy into a trainer runtime.
