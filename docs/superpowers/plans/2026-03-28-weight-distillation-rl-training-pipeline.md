# Weight-Distillation RL Training Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an SDPO-inspired, non-blocking RL distillation pipeline that converts captured AI traffic into reward-enriched code-generation records and exports SDPO-ready datasets.

**Architecture:** Keep proxy request flow fast by asynchronously processing enriched `CapturedTransaction` events in a dedicated `DistillationPipeline`. The pipeline performs code sample extraction, external sandbox scoring, robust record writing, and export to SDPO-compatible rows. Existing proxy/analyzer flow stays the source of truth for capture; distillation layer is additive and decoupled.

**Tech Stack:** TypeScript, Bun runtime, existing proxy/TUI stack, JSONL append writer, external sandbox HTTP API

---

## File Structure Map

### New files (create)

- `src/distillation/types.ts`
  - Distillation contracts (`CodeSample`, `RewardResult`, `DistillationRecord`, `SdpoExportRow`)
- `src/distillation/extractors/code.ts`
  - Code sample classifier/extractor from `CapturedTransaction`
- `src/distillation/reward/sandbox-client.ts`
  - HTTP client for external code-scoring sandbox
- `src/distillation/storage/jsonl-record-writer.ts`
  - Append-only writer for distillation records
- `src/distillation/export/sdpo-exporter.ts`
  - Mapper/exporter from records to SDPO rows
- `src/distillation/pipeline.ts`
  - Async orchestration (queue + scoring + write + export)
- `src/distillation/index.ts`
  - Public entrypoint exports
- `src/distillation/__tests__/extractor.code.test.ts`
- `src/distillation/__tests__/sandbox-client.test.ts`
- `src/distillation/__tests__/sdpo-exporter.test.ts`
- `src/distillation/__tests__/pipeline.integration.test.ts`

### Existing files (modify)

- `src/cli.ts`
  - Add distillation CLI flags and initialization wiring
- `src/proxy/types.ts`
  - Reuse existing AI fields (already present); no schema change expected in this plan
- `src/analyzer/index.ts`
  - Optional: emit distillation metrics hook if needed (minimal)
- `README.md`
  - Add distillation/RL pipeline setup + sandbox config + export usage

---

## Task 1: Distillation Type Contracts

**Files:**
- Create: `src/distillation/types.ts`
- Test: `src/distillation/__tests__/types.compile.test.ts` (compile-level sanity)

- [ ] **Step 1: Write failing compile test scaffold**

```ts
// src/distillation/__tests__/types.compile.test.ts
import { describe, test, expect } from "bun:test";
import type { CodeSample, RewardResult, DistillationRecord, SdpoExportRow } from "../types.js";

describe("distillation types", () => {
  test("types are importable", () => {
    const ok = true as boolean;
    expect(ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/distillation/__tests__/types.compile.test.ts`
Expected: FAIL (`Cannot find module '../types.js'`)

- [ ] **Step 3: Implement `src/distillation/types.ts`**

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
  score: number;
  passRate: number;
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
  metadata: string;
}
```

- [ ] **Step 4: Run test + typecheck**

Run: `bun test src/distillation/__tests__/types.compile.test.ts && bunx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/distillation/types.ts src/distillation/__tests__/types.compile.test.ts
git commit -m "feat: add distillation type contracts

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Code Sample Extractor

**Files:**
- Create: `src/distillation/extractors/code.ts`
- Test: `src/distillation/__tests__/extractor.code.test.ts`

- [ ] **Step 1: Write failing tests for extraction behavior**

```ts
import { describe, test, expect } from "bun:test";
import { extractCodeSampleFromTransaction } from "../extractors/code.js";
import type { CapturedTransaction } from "../../proxy/types.js";

function tx(overrides: Partial<CapturedTransaction>): CapturedTransaction {
  return {
    id: "1",
    timestamp: new Date().toISOString(),
    method: "POST",
    url: "https://api.openai.com/v1/chat/completions",
    reqHeaders: {},
    resHeaders: {},
    reqBody: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "Write Python function" }] }),
    reqBodyEncoding: "utf8",
    reqBodyTruncated: false,
    resBody: JSON.stringify({ choices: [{ message: { content: "```python\ndef add(a,b): return a+b\n```" }, finish_reason: "stop" }] }),
    resBodyEncoding: "utf8",
    resBodyTruncated: false,
    statusCode: 200,
    durationMs: 100,
    error: null,
    contentEncoding: null,
    resBodyPreview: null,
    resBodyPreviewEncoding: null,
    aiProvider: "openai",
    aiModel: "gpt-4o",
    aiPromptTokens: 10,
    aiCompletionTokens: 20,
    aiTotalTokens: 30,
    aiEstimatedCostUsd: 0.001,
    aiConversationId: "c1",
    aiParentRequestId: null,
    aiParsedResponse: {
      assistantMessage: "```python\ndef add(a,b): return a+b\n```",
      mathAnswer: null,
      codeBlocks: [{ language: "python", code: "def add(a,b): return a+b" }],
      toolCalls: [],
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      finishReason: "stop",
    },
    ...overrides,
  };
}

describe("extractCodeSampleFromTransaction", () => {
  test("extracts code sample when AI provider + code blocks exist", () => {
    const sample = extractCodeSampleFromTransaction(tx({}));
    expect(sample).not.toBeNull();
    expect(sample?.provider).toBe("openai");
    expect(sample?.model).toBe("gpt-4o");
    expect(sample?.codeBlocks.length).toBe(1);
  });

  test("returns null for non-AI transaction", () => {
    const sample = extractCodeSampleFromTransaction(tx({ aiProvider: null }));
    expect(sample).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `bun test src/distillation/__tests__/extractor.code.test.ts`
Expected: FAIL (missing extractor implementation)

- [ ] **Step 3: Implement extractor**

Create `src/distillation/extractors/code.ts`:
- `extractCodeSampleFromTransaction(tx: CapturedTransaction): CodeSample | null`
- parse prompt from `reqBody.messages` → fallback `reqBody.prompt` → fallback raw body
- completion from `tx.aiParsedResponse.assistantMessage`
- tests from parsed request keys (`tests`, `unit_tests`, `test_cases`) or fenced test blocks
- return null when not code sample

- [ ] **Step 4: Run tests + typecheck**

Run: `bun test src/distillation/__tests__/extractor.code.test.ts && bunx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/distillation/extractors/code.ts src/distillation/__tests__/extractor.code.test.ts
git commit -m "feat: add code sample extractor for distillation

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Sandbox Reward Client

**Files:**
- Create: `src/distillation/reward/sandbox-client.ts`
- Test: `src/distillation/__tests__/sandbox-client.test.ts`

- [ ] **Step 1: Write failing tests**

Test cases:
1. maps successful API response to `RewardResult`
2. maps timeout to `{ status: "timeout" }`
3. retries transient failures up to maxRetries
4. maps non-200 responses to `scoring_failed`

- [ ] **Step 2: Verify failing tests**

Run: `bun test src/distillation/__tests__/sandbox-client.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement client**

`src/distillation/reward/sandbox-client.ts`:

```ts
import type { CodeSample, RewardResult } from "../types.js";

export interface SandboxClientConfig {
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
  maxRetries: number;
}

export class SandboxRewardClient {
  constructor(private cfg: SandboxClientConfig) {}

  async scoreCode(sample: CodeSample): Promise<RewardResult> {
    // fetch with AbortController timeout
    // retry exponential backoff on network errors
    // normalize response shape
    // never throw, return scoring_failed on unexpected failures
  }
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `bun test src/distillation/__tests__/sandbox-client.test.ts && bunx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/distillation/reward/sandbox-client.ts src/distillation/__tests__/sandbox-client.test.ts
git commit -m "feat: add sandbox reward client with retries and timeout handling

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Distillation Record Writer + SDPO Exporter

**Files:**
- Create: `src/distillation/storage/jsonl-record-writer.ts`
- Create: `src/distillation/export/sdpo-exporter.ts`
- Test: `src/distillation/__tests__/sdpo-exporter.test.ts`

- [ ] **Step 1: Write failing tests for row mapping and null reward handling**
- [ ] **Step 2: Verify failing tests**

Run: `bun test src/distillation/__tests__/sdpo-exporter.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement writer + exporter**

`jsonl-record-writer.ts`:
- append-only JSONL write
- create parent directory if missing
- `write(record)`, `flush()`, `close()`

`sdpo-exporter.ts`:
- `toSdpoExportRow(record: DistillationRecord): SdpoExportRow`
- `exportRows(records: DistillationRecord[]): string` (JSONL string)

- [ ] **Step 4: Run tests + typecheck**

Run: `bun test src/distillation/__tests__/sdpo-exporter.test.ts && bunx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/distillation/storage/jsonl-record-writer.ts src/distillation/export/sdpo-exporter.ts src/distillation/__tests__/sdpo-exporter.test.ts
git commit -m "feat: add distillation record writer and SDPO exporter

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Distillation Pipeline Orchestrator

**Files:**
- Create: `src/distillation/pipeline.ts`
- Create: `src/distillation/index.ts`
- Test: `src/distillation/__tests__/pipeline.integration.test.ts`

- [ ] **Step 1: Write failing integration tests**

Coverage:
1. valid code tx -> scoring -> record write
2. non-code tx skipped
3. queue backpressure behavior
4. shutdown flush persists pending records

- [ ] **Step 2: Verify failing tests**

Run: `bun test src/distillation/__tests__/pipeline.integration.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement pipeline**

`DistillationPipeline`:
- bounded queue (`maxConcurrentScorers`)
- `onTransaction(tx)` non-blocking push
- extraction -> scoring -> write -> export row pipeline
- metrics counters internal
- `flush()` and `shutdown()`

- [ ] **Step 4: Run integration tests + full distillation tests + typecheck**

Run:
```bash
bun test src/distillation/__tests__
bunx tsc --noEmit
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/distillation/pipeline.ts src/distillation/index.ts src/distillation/__tests__/pipeline.integration.test.ts
git commit -m "feat: add async distillation pipeline orchestrator

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: CLI Integration

**Files:**
- Modify: `src/cli.ts`
- Test: `src/distillation/__tests__/cli.distill-config.test.ts` (new)

- [ ] **Step 1: Write failing config parse tests**

Cases:
- flags parse correctly
- defaults applied
- disabled mode does not initialize pipeline
- enabled mode initializes pipeline with required sandbox URL

- [ ] **Step 2: Verify failing tests**

Run: `bun test src/distillation/__tests__/cli.distill-config.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement CLI changes**

Add options:
- `--distill-enabled`
- `--distill-domain`
- `--distill-output`
- `--sandbox-url`
- `--sandbox-api-key`
- `--distill-max-concurrency`

Initialize pipeline in main startup and route transactions through it.
Ensure graceful shutdown flushes pipeline before exit.

- [ ] **Step 4: Run tests + typecheck**

Run:
```bash
bun test src/distillation/__tests__/cli.distill-config.test.ts
bunx tsc --noEmit
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts src/distillation/__tests__/cli.distill-config.test.ts
git commit -m "feat: integrate distillation pipeline into CLI

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Documentation Updates

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add new “RL Distillation Pipeline” section**

Include:
- required flags
- sandbox service contract example
- output file examples (`distillation.jsonl`, `sdpo-export.jsonl`)
- minimal SDPO handoff instructions

- [ ] **Step 2: Add security section for sandbox API key handling**

- [ ] **Step 3: Validate README commands**

Run basic command examples to ensure flags are real:
```bash
bun run src/cli.ts --help
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: add RL distillation pipeline usage and SDPO export workflow

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: End-to-End Verification

**Files:**
- Verify existing + new distillation files

- [ ] **Step 1: Run full test suite**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 2: Run typecheck**

Run: `bunx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Distillation smoke test with mock sandbox**

- Start local mock sandbox endpoint
- Run proxy with distillation flags:

```bash
bun run src/cli.ts \
  --distill-enabled \
  --distill-domain code \
  --distill-output /tmp/distillation.jsonl \
  --sandbox-url http://127.0.0.1:9999 \
  --no-tui
```

- Send sample code-gen request via proxy
- Verify output records and exported rows exist and include reward fields

- [ ] **Step 4: Commit verification status**

```bash
git add -A
git commit -m "chore: verify RL distillation pipeline end-to-end

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Verification Checklist

- [ ] Distillation extraction works for code-generation traffic
- [ ] Sandbox scoring runs asynchronously
- [ ] Proxy request path remains non-blocking
- [ ] Distillation JSONL records written correctly
- [ ] SDPO export rows generated correctly
- [ ] CLI flags fully wired
- [ ] Full tests pass
- [ ] Typecheck clean
- [ ] README updated and accurate

---

## Recommended Execution Mode

Use `@superpowers:subagent-driven-development` for this plan because tasks are modular and benefit from per-task implementation + review loops.
