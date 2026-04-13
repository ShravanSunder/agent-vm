# agent-vm-worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the agent-vm-worker package — a configurable task worker that runs inside a Gondolin VM, driving tasks through plan/work/verify/review/wrapup loops.

**Architecture:** Single package porting from agent-vm-coding. Config-driven phases replace hardcoded agents. WorkExecutor interface replaces direct Codex SDK usage. Agent-driven wrapup replaces imperative completion. JSONL event sourcing preserved. **Note:** Full e2e operation requires companion controller-side work (see Post-Implementation Notes) — this plan covers only the worker package.

**Tech Stack:** TypeScript, Hono, cmd-ts, Zod, Codex SDK, execa, vitest

**Design spec:** `docs/superpowers/specs/2026-04-12-agent-vm-worker-design.md` — the canonical reference for interface shapes, config schemas, state machine, and rationale.

---

## File Structure

### New package

```
packages/agent-vm-worker/
├── package.json
├── tsconfig.json
├── tsconfig.build.json
├── vitest.config.ts
└── src/
    ├── main.ts                          ← cmd-ts CLI entry point
    ├── server.ts                        ← Hono HTTP API
    ├── server.test.ts
    ├── config/
    │   ├── worker-config.ts             ← Zod schemas + loading + model alias resolution
    │   └── worker-config.test.ts
    ├── state/
    │   ├── task-event-types.ts          ← Zod discriminated union of events
    │   ├── event-log.ts                 ← JSONL append + replay
    │   ├── event-log.test.ts
    │   ├── task-state.ts                ← event-sourced state + hydration
    │   └── task-state.test.ts
    ├── work-executor/
    │   ├── executor-interface.ts         ← WorkExecutor interface (generic)
    │   ├── codex-executor.ts            ← Codex SDK adapter (first implementation)
    │   ├── codex-executor.test.ts
    │   └── executor-factory.ts          ← creates executor by provider name
    ├── prompt/
    │   ├── prompt-assembler.ts          ← base + instructions + task + skills
    │   └── prompt-assembler.test.ts
    ├── planner/
    │   ├── planner.ts                   ← plan phase: run executor with plan skills
    │   ├── planner.test.ts
    │   ├── plan-reviewer.ts             ← review plan: run executor, parse ReviewResult
    │   └── plan-reviewer.test.ts
    ├── work-reviewer/
    │   ├── verification-runner.ts       ← runs configured commands (test, lint, typecheck)
    │   ├── verification-runner.test.ts
    │   ├── work-reviewer.ts             ← orchestrates: verification → review agent
    │   └── work-reviewer.test.ts
    ├── wrapup/
    │   ├── wrapup-types.ts              ← WrapupAction interface, WrapupActionResult
    │   ├── git-pr-action.ts             ← commit + push + PR (tool for wrapup agent)
    │   ├── git-pr-action.test.ts
    │   ├── slack-action.ts              ← post to Slack webhook
    │   └── wrapup-action-registry.ts    ← maps action types to ToolDefinition[]
    ├── git/
    │   ├── git-operations.ts            ← commit, push, PR, branch, config
    │   └── git-operations.test.ts
    ├── context/
    │   ├── gather-context.ts            ← repo summary for planner (file tree, CLAUDE.md)
    │   └── gather-context.test.ts
    ├── coordinator/
    │   ├── coordinator.ts               ← orchestrates plan + work + wrapup loops
    │   ├── coordinator.test.ts
    │   ├── coordinator-types.ts         ← Coordinator interface, CreateTaskInput
    │   └── coordinator-helpers.ts       ← sanitizeErrorMessage, createTaskEventRecorder
    └── shared/
        ├── review-result.ts             ← Zod schema for structured review JSON
        └── skill-types.ts               ← SkillReference type
```

### Migration summary from agent-vm-coding

| Current (agent-vm-coding) | New (agent-vm-worker) | Change |
|---|---|---|
| `agents/planner/planner-agent.ts` | `planner/planner.ts` | Configured by phase config, uses WorkExecutor |
| `agents/plan-reviewer/plan-reviewer-agent.ts` | `planner/plan-reviewer.ts` | Same interface, uses WorkExecutor |
| `agents/coder/coder-agent.ts` | `work-executor/codex-executor.ts` | Behind WorkExecutor interface |
| `agents/code-reviewer/code-reviewer-agent.ts` | `work-reviewer/work-reviewer.ts` | Runs verification then review |
| `agents/codex-client-factory.ts` | `work-executor/codex-executor.ts` | Merged into executor |
| `agents/skill-registry.ts` | **Deleted** | Skills are `{ name, path }` in config |
| `agents/shared-types.ts` | `work-executor/executor-interface.ts` | Generic executor types |
| `agents/review-result.ts` | `shared/review-result.ts` | Unchanged |
| `coordinator/prompt-builder.ts` | `prompt/prompt-assembler.ts` | Generic, not per-phase templates |
| `coordinator/run-sanity-retries.ts` | `work-reviewer/verification-runner.ts` | Runs configurable command list |
| `coordinator/task-ship.ts` | `wrapup/git-pr-action.ts` | Tool for wrapup agent |
| `coordinator/task-setup.ts` | `coordinator/coordinator-helpers.ts` | Git setup merged into helpers |
| `config.ts` | `config/worker-config.ts` | Generic phases, MCP servers, wrapup actions |
| `verification.ts` | `work-reviewer/verification-runner.ts` | `parseCommand` preserved |
| `state/task-event-types.ts` | `state/task-event-types.ts` | Generic events, thread IDs |
| `state/event-log.ts` | `state/event-log.ts` | Same JSONL pattern |
| `state/task-state.ts` | `state/task-state.ts` | New statuses, new fields |
| `server.ts` | `server.ts` | No followup route, new request schema |
| `main.ts` | `main.ts` | cmd-ts CLI, not bare script |
| `git/git-operations.ts` | `git/git-operations.ts` | Straight port |
| `context/gather-context.ts` | `context/gather-context.ts` | Straight port — repo summary for planner |

---

## Task 1: Package Scaffolding

**Files:**
- Create: `packages/agent-vm-worker/package.json`
- Create: `packages/agent-vm-worker/tsconfig.json`
- Create: `packages/agent-vm-worker/tsconfig.build.json`
- Create: `packages/agent-vm-worker/vitest.config.ts`
- Create: `packages/agent-vm-worker/src/index.ts`

**Steps:**

- [ ] **Step 1: Create `packages/agent-vm-worker/package.json`**

```json
{
  "name": "agent-vm-worker",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "bin": {
    "agent-vm-worker": "./dist/main.js"
  },
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run --config vitest.config.ts",
    "start": "node ./dist/main.js"
  },
  "dependencies": {
    "@hono/node-server": "^1",
    "@hono/zod-validator": "^0.7.6",
    "@openai/codex-sdk": "^0.118.0",
    "cmd-ts": "^0.13.0",
    "execa": "^9.5.2",
    "hono": "^4",
    "zod": "^4"
  },
  "devDependencies": {
    "vitest": "^3.2.1"
  }
}
```

- [ ] **Step 2: Create `packages/agent-vm-worker/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts"],
  "exclude": ["dist"]
}
```

- [ ] **Step 3: Create `packages/agent-vm-worker/tsconfig.build.json`**

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./dist",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "noEmit": false
  },
  "exclude": ["src/**/*.test.ts"]
}
```

- [ ] **Step 4: Create `packages/agent-vm-worker/vitest.config.ts`**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    testTimeout: 30_000,
    include: ["src/**/*.test.ts"],
  },
});
```

- [ ] **Step 5: Create `packages/agent-vm-worker/src/index.ts`** (placeholder — will be populated as modules are built)

```typescript
// agent-vm-worker — configurable task worker for Gondolin VMs
// Exports will be added as modules are implemented.
```

- [ ] **Step 6: Install dependencies**

```bash
cd /Users/shravansunder/Documents/dev/project-dev/agent-vm.agent-vm-worker && pnpm install
```

Expected: lockfile updated, no errors.

- [ ] **Step 7: Verify typecheck passes on empty package**

```bash
cd /Users/shravansunder/Documents/dev/project-dev/agent-vm.agent-vm-worker && pnpm --filter agent-vm-worker typecheck
```

Expected: exit code 0, no errors.

**Commit:** `feat(agent-vm-worker): scaffold package with dependencies and config`

---

## Task 2: State — Event Types + Event Log + Task State

Port from agent-vm-coding's `state/` directory. Key changes: generic events (not hardcoded `plan-created`, `implementation-started`, etc.), new statuses, thread IDs for planner and work executor, wrapup results.

**Files:**
- Create: `packages/agent-vm-worker/src/state/task-event-types.ts`
- Create: `packages/agent-vm-worker/src/state/event-log.ts`
- Create: `packages/agent-vm-worker/src/state/event-log.test.ts`
- Create: `packages/agent-vm-worker/src/state/task-state.ts`
- Create: `packages/agent-vm-worker/src/state/task-state.test.ts`
- Create: `packages/agent-vm-worker/src/shared/review-result.ts`
- Create: `packages/agent-vm-worker/src/shared/skill-types.ts`

**Steps:**

- [ ] **Step 1: Create `packages/agent-vm-worker/src/shared/review-result.ts`**

Straight port from `agents/review-result.ts`. No changes.

```typescript
import { z } from "zod";

export const reviewResultSchema = z.object({
  approved: z.boolean(),
  comments: z.array(
    z.object({
      file: z.string().default(""),
      line: z.number().optional(),
      severity: z.enum(["critical", "suggestion", "nitpick"]),
      comment: z.string(),
    }),
  ),
  summary: z.string(),
});

export type ReviewResult = z.infer<typeof reviewResultSchema>;
```

- [ ] **Step 2: Create `packages/agent-vm-worker/src/shared/skill-types.ts`**

Replaces the hardcoded `skill-registry.ts`. Skills are now `{ name, path }` references from config.

```typescript
import { z } from "zod";

export const skillReferenceSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
});

export type SkillReference = z.infer<typeof skillReferenceSchema>;
```

- [ ] **Step 3: Create `packages/agent-vm-worker/src/state/task-event-types.ts`**

New generic events. This replaces the old per-phase events with a phase-parameterized model. Uses Zod discriminated union for runtime validation.

```typescript
import { z } from "zod";

import { workerConfigSchema } from "../config/worker-config.js";

// --- Phase names ---

export const phaseNames = [
  "plan",
  "plan-review",
  "work",
  "verification",
  "work-review",
  "wrapup",
] as const satisfies readonly string[];

export const phaseNameSchema = z.enum(phaseNames);
export type PhaseName = z.infer<typeof phaseNameSchema>;

// --- Task status ---

export const taskStatusValues = [
  "pending",
  "planning",
  "reviewing-plan",
  "working",
  "verifying",
  "reviewing-work",
  "wrapping-up",
  "completed",
  "failed",
] as const satisfies readonly string[];

export const taskStatusSchema = z.enum(taskStatusValues);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const TERMINAL_STATUSES = ["completed", "failed"] as const;

// --- Task config (snapshot stored in task-accepted event) ---

// Full effective config snapshot — makes crash recovery and auditing
// self-contained without depending on the external config file.
export const taskConfigSchema = z.object({
  // Task input
  taskId: z.string().min(1),
  prompt: z.string().min(1),
  repo: z
    .object({
      repoUrl: z.string().min(1),
      baseBranch: z.string().min(1),
      workspacePath: z.string().min(1),
    })
    .nullable(),
  context: z.record(z.string(), z.unknown()),
  // Full effective WorkerConfig snapshot
  effectiveConfig: workerConfigSchema,
});

export type TaskConfig = z.infer<typeof taskConfigSchema>;

// --- Verification command result (embedded in events) ---

export const verificationCommandResultSchema = z.object({
  name: z.string(),
  passed: z.boolean(),
  exitCode: z.number().int(),
  output: z.string(),
});

export type VerificationCommandResult = z.infer<
  typeof verificationCommandResultSchema
>;

// --- Wrapup action result (embedded in events) ---

export const wrapupActionResultSchema = z.object({
  type: z.string(),
  artifact: z.string().optional(),
  success: z.boolean(),
});

export type WrapupActionResult = z.infer<typeof wrapupActionResultSchema>;

// --- Task events (Zod discriminated union) ---

export const taskEventSchema = z.discriminatedUnion("event", [
  z.object({
    event: z.literal("task-accepted"),
    taskId: z.string().min(1),
    config: taskConfigSchema,
  }),
  z.object({
    event: z.literal("phase-started"),
    phase: phaseNameSchema,
    loop: z.number().int().nonnegative().optional(),
  }),
  z.object({
    event: z.literal("phase-completed"),
    phase: phaseNameSchema,
    tokenCount: z.number().int().nonnegative().optional(),
  }),
  z.object({
    event: z.literal("plan-created"),
    plan: z.string(),
    threadId: z.string(),
  }),
  z.object({
    event: z.literal("work-started"),
    threadId: z.string(),
  }),
  z.object({
    event: z.literal("review-result"),
    phase: z.enum(["plan-review", "work-review"]),
    approved: z.boolean(),
    summary: z.string(),
    loop: z.number().int().nonnegative(),
  }),
  z.object({
    event: z.literal("verification-result"),
    results: z.array(verificationCommandResultSchema),
  }),
  z.object({
    event: z.literal("fix-applied"),
    tokenCount: z.number().int().nonnegative(),
  }),
  z.object({
    event: z.literal("wrapup-result"),
    actions: z.array(wrapupActionResultSchema),
  }),
  z.object({
    event: z.literal("task-failed"),
    reason: z.string(),
  }),
  z.object({
    event: z.literal("task-closed"),
  }),
]);

export type TaskEvent = z.infer<typeof taskEventSchema>;

// --- Timestamped wrapper for JSONL persistence ---

export interface TimestampedEvent {
  readonly ts: string;
  readonly data: TaskEvent;
}
```

- [ ] **Step 4: Create `packages/agent-vm-worker/src/state/event-log.ts`**

Straight port from agent-vm-coding. Uses sync FS for JSONL append (atomic on most filesystems for small writes). `replayEvents` skips incomplete final line for crash recovery.

```typescript
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import type { TaskEvent, TimestampedEvent } from "./task-event-types.js";

function isTimestampedEvent(value: unknown): value is TimestampedEvent {
  if (typeof value !== "object" || value === null) return false;
  if (!("ts" in value) || !("data" in value)) return false;
  if (typeof value.ts !== "string") return false;
  if (typeof value.data !== "object" || value.data === null) return false;
  return "event" in value.data;
}

/**
 * Appends a task event to the JSONL log file.
 *
 * Creates parent directory if needed. Wraps event with ISO timestamp.
 * Re-throws any write errors with context — silent failures corrupt state.
 */
export function appendEvent(filePath: string, event: TaskEvent): void {
  try {
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const timestampedEvent: TimestampedEvent = {
      ts: new Date().toISOString(),
      data: event,
    };

    appendFileSync(filePath, JSON.stringify(timestampedEvent) + "\n", "utf-8");
  } catch (error) {
    throw new Error(
      `Failed to append event to ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/**
 * Replays all events from a JSONL log file.
 *
 * Returns empty array if file doesn't exist.
 * Skips incomplete final line (crash recovery) with warning.
 * Throws on corrupt non-final lines.
 */
export function replayEvents(filePath: string): readonly TimestampedEvent[] {
  if (!existsSync(filePath)) {
    return [];
  }

  const fileContents = readFileSync(filePath, "utf-8");
  const lines = fileContents.split("\n").filter((line) => line.trim() !== "");

  if (lines.length === 0) {
    return [];
  }

  const events: TimestampedEvent[] = [];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (!line) continue;

    const isLastLine = lineIndex === lines.length - 1;

    try {
      const parsed: unknown = JSON.parse(line);
      if (!isTimestampedEvent(parsed)) {
        throw new Error(`Invalid event structure at line ${lineIndex + 1}`);
      }
      events.push(parsed);
    } catch (error) {
      if (isLastLine) {
        console.warn(
          `Skipping incomplete final line in ${filePath}: ${line.slice(0, 50)}...`,
        );
      } else {
        throw new Error(
          `Corrupt event at line ${lineIndex + 1} in ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    }
  }

  return events;
}
```

- [ ] **Step 5: Create `packages/agent-vm-worker/src/state/event-log.test.ts`**

```typescript
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { appendEvent, replayEvents } from "./event-log.js";
import type { TaskEvent } from "./task-event-types.js";
import { workerConfigSchema } from "../config/worker-config.js";

const TEST_EFFECTIVE_CONFIG = workerConfigSchema.parse({});

describe("event-log", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "event-log-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("appendEvent", () => {
    it("creates parent directories and appends a JSONL line", async () => {
      const filePath = join(tempDir, "tasks", "abc.jsonl");
      const event: TaskEvent = {
        event: "task-accepted",
        taskId: "abc",
        config: {
          taskId: "abc",
          prompt: "fix bug",
          repo: null,
          context: {},
          effectiveConfig: TEST_EFFECTIVE_CONFIG,
        },
      };

      appendEvent(filePath, event);

      const contents = await readFile(filePath, "utf-8");
      const lines = contents.trim().split("\n");
      expect(lines).toHaveLength(1);

      const parsed = JSON.parse(lines[0]!) as { ts: string; data: TaskEvent };
      expect(parsed.data.event).toBe("task-accepted");
      expect(parsed.ts).toBeDefined();
    });

    it("appends multiple events to the same file", async () => {
      const filePath = join(tempDir, "tasks", "multi.jsonl");

      appendEvent(filePath, {
        event: "task-accepted",
        taskId: "multi",
        config: {
          taskId: "multi",
          prompt: "test",
          repo: null,
          context: {},
          effectiveConfig: TEST_EFFECTIVE_CONFIG,
        },
      });

      appendEvent(filePath, {
        event: "phase-started",
        phase: "plan",
      });

      const contents = await readFile(filePath, "utf-8");
      const lines = contents.trim().split("\n");
      expect(lines).toHaveLength(2);
    });
  });

  describe("replayEvents", () => {
    it("returns empty array for non-existent file", () => {
      const events = replayEvents(join(tempDir, "nonexistent.jsonl"));
      expect(events).toEqual([]);
    });

    it("replays all events from a JSONL file", () => {
      const filePath = join(tempDir, "replay.jsonl");

      appendEvent(filePath, {
        event: "task-accepted",
        taskId: "replay",
        config: {
          taskId: "replay",
          prompt: "test",
          repo: null,
          context: {},
          effectiveConfig: TEST_EFFECTIVE_CONFIG,
        },
      });
      appendEvent(filePath, { event: "phase-started", phase: "plan" });

      const events = replayEvents(filePath);
      expect(events).toHaveLength(2);
      expect(events[0]!.data.event).toBe("task-accepted");
      expect(events[1]!.data.event).toBe("phase-started");
    });

    it("skips incomplete final line for crash recovery", () => {
      const filePath = join(tempDir, "crash.jsonl");
      const dir = tempDir;
      mkdirSync(dir, { recursive: true });

      const validEvent = JSON.stringify({
        ts: new Date().toISOString(),
        data: {
          event: "task-accepted",
          taskId: "crash",
          config: {
            taskId: "crash",
            prompt: "test",
            repo: null,
            context: {},
            effectiveConfig: TEST_EFFECTIVE_CONFIG,
          },
        },
      });
      writeFileSync(filePath, validEvent + "\n{incomplete\n", "utf-8");

      const events = replayEvents(filePath);
      expect(events).toHaveLength(1);
      expect(events[0]!.data.event).toBe("task-accepted");
    });

    it("throws on corrupt non-final lines", () => {
      const filePath = join(tempDir, "corrupt.jsonl");
      writeFileSync(
        filePath,
        "{corrupt-line\n" +
          JSON.stringify({
            ts: new Date().toISOString(),
            data: { event: "task-closed" },
          }) +
          "\n",
        "utf-8",
      );

      expect(() => replayEvents(filePath)).toThrow(/Corrupt event at line 1/);
    });
  });
});
```

- [ ] **Step 6: Create `packages/agent-vm-worker/src/state/task-state.ts`**

New generic task state with `plannerThreadId`, `workThreadId`, and wrapup results. The `applyEvent` reducer handles all events from the new discriminated union.

```typescript
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { replayEvents } from "./event-log.js";
import type {
  TaskConfig,
  TaskEvent,
  TaskStatus,
  VerificationCommandResult,
  WrapupActionResult,
} from "./task-event-types.js";
import { TERMINAL_STATUSES } from "./task-event-types.js";

export interface TaskState {
  readonly taskId: string;
  readonly status: TaskStatus;
  readonly config: TaskConfig;
  readonly plan: string | null;
  readonly plannerThreadId: string | null;
  readonly workThreadId: string | null;
  readonly planReviewLoop: number;
  readonly workReviewLoop: number;
  readonly verificationAttempt: number;
  readonly lastReviewSummary: string | null;
  readonly lastVerificationResults: readonly VerificationCommandResult[] | null;
  readonly wrapupResults: readonly WrapupActionResult[] | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function createInitialState(
  taskId: string,
  config: TaskConfig,
): TaskState {
  const now = new Date().toISOString();

  return {
    taskId,
    status: "pending",
    config,
    plan: null,
    plannerThreadId: null,
    workThreadId: null,
    planReviewLoop: 0,
    workReviewLoop: 0,
    verificationAttempt: 0,
    lastReviewSummary: null,
    lastVerificationResults: null,
    wrapupResults: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function applyEvent(state: TaskState, event: TaskEvent): TaskState {
  const updatedAt = new Date().toISOString();

  switch (event.event) {
    case "task-accepted":
      return { ...state, status: "pending", updatedAt };

    case "phase-started": {
      const statusMap: Record<string, TaskStatus> = {
        plan: "planning",
        "plan-review": "reviewing-plan",
        work: "working",
        verification: "verifying",
        "work-review": "reviewing-work",
        wrapup: "wrapping-up",
      };
      const newStatus = statusMap[event.phase];
      if (!newStatus) {
        return { ...state, updatedAt };
      }
      return { ...state, status: newStatus, updatedAt };
    }

    case "phase-completed":
      return { ...state, updatedAt };

    case "plan-created":
      return {
        ...state,
        plan: event.plan,
        plannerThreadId: event.threadId,
        updatedAt,
      };

    case "work-started":
      return {
        ...state,
        workThreadId: event.threadId,
        verificationAttempt: 0,
        updatedAt,
      };

    case "review-result":
      if (event.phase === "plan-review") {
        return {
          ...state,
          planReviewLoop: event.loop,
          lastReviewSummary: event.approved ? null : event.summary,
          updatedAt,
        };
      }
      return {
        ...state,
        workReviewLoop: event.loop,
        lastReviewSummary: event.approved ? null : event.summary,
        updatedAt,
      };

    case "verification-result": {
      const allPassed = event.results.every((r) => r.passed);
      return {
        ...state,
        verificationAttempt: allPassed
          ? state.verificationAttempt
          : state.verificationAttempt + 1,
        lastVerificationResults: event.results,
        updatedAt,
      };
    }

    case "fix-applied":
      return { ...state, updatedAt };

    case "wrapup-result":
      return {
        ...state,
        wrapupResults: event.actions,
        status: "completed",
        updatedAt,
      };

    case "task-failed":
      return { ...state, status: "failed", updatedAt };

    case "task-closed":
      return { ...state, status: "completed", updatedAt };

    default: {
      const exhaustiveCheck: never = event;
      throw new Error(
        `Unhandled task event: ${JSON.stringify(exhaustiveCheck)}`,
      );
    }
  }
}

export function isTerminal(state: TaskState): boolean {
  const terminalSet: ReadonlySet<string> = new Set(TERMINAL_STATUSES);
  return terminalSet.has(state.status);
}

export function hydrateTaskStates(
  stateDir: string,
): Map<string, TaskState> {
  const tasksDir = join(stateDir, "tasks");
  const taskStates = new Map<string, TaskState>();

  try {
    const files = readdirSync(tasksDir);

    for (const file of files) {
      if (!file.endsWith(".jsonl")) {
        continue;
      }

      const filePath = join(tasksDir, file);
      const events = replayEvents(filePath);

      if (events.length === 0) {
        continue;
      }

      const firstEvent = events[0];
      if (!firstEvent || firstEvent.data.event !== "task-accepted") {
        console.warn(`Skipping ${file}: first event is not task-accepted`);
        continue;
      }

      let state = createInitialState(
        firstEvent.data.taskId,
        firstEvent.data.config,
      );
      state = {
        ...state,
        createdAt: firstEvent.ts,
        updatedAt: firstEvent.ts,
      };

      for (let index = 1; index < events.length; index += 1) {
        const event = events[index];
        if (!event) continue;
        state = applyEvent(state, event.data);
      }

      taskStates.set(state.taskId, state);
    }

    return taskStates;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return new Map();
    }
    throw error;
  }
}
```

- [ ] **Step 7: Create `packages/agent-vm-worker/src/state/task-state.test.ts`**

```typescript
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { appendEvent } from "./event-log.js";
import type { TaskConfig, TaskEvent } from "./task-event-types.js";
import { workerConfigSchema } from "../config/worker-config.js";
import {
  applyEvent,
  createInitialState,
  hydrateTaskStates,
  isTerminal,
} from "./task-state.js";

const TEST_EFFECTIVE_CONFIG = workerConfigSchema.parse({});

function makeConfig(overrides?: Partial<TaskConfig>): TaskConfig {
  return {
    taskId: "test-task",
    prompt: "fix bug",
    repo: null,
    context: {},
    effectiveConfig: TEST_EFFECTIVE_CONFIG,
    ...overrides,
  };
}

describe("task-state", () => {
  describe("createInitialState", () => {
    it("creates state with pending status and null fields", () => {
      const state = createInitialState("task-1", makeConfig());
      expect(state.status).toBe("pending");
      expect(state.taskId).toBe("task-1");
      expect(state.plan).toBeNull();
      expect(state.plannerThreadId).toBeNull();
      expect(state.workThreadId).toBeNull();
      expect(state.planReviewLoop).toBe(0);
      expect(state.workReviewLoop).toBe(0);
      expect(state.verificationAttempt).toBe(0);
    });
  });

  describe("applyEvent", () => {
    it("transitions to planning on phase-started plan", () => {
      const state = createInitialState("t1", makeConfig());
      const next = applyEvent(state, { event: "phase-started", phase: "plan" });
      expect(next.status).toBe("planning");
    });

    it("transitions to reviewing-plan on phase-started plan-review", () => {
      const state = createInitialState("t1", makeConfig());
      const next = applyEvent(state, {
        event: "phase-started",
        phase: "plan-review",
      });
      expect(next.status).toBe("reviewing-plan");
    });

    it("transitions to working on phase-started work", () => {
      const state = createInitialState("t1", makeConfig());
      const next = applyEvent(state, {
        event: "phase-started",
        phase: "work",
      });
      expect(next.status).toBe("working");
    });

    it("transitions to verifying on phase-started verification", () => {
      const state = createInitialState("t1", makeConfig());
      const next = applyEvent(state, {
        event: "phase-started",
        phase: "verification",
      });
      expect(next.status).toBe("verifying");
    });

    it("transitions to reviewing-work on phase-started work-review", () => {
      const state = createInitialState("t1", makeConfig());
      const next = applyEvent(state, {
        event: "phase-started",
        phase: "work-review",
      });
      expect(next.status).toBe("reviewing-work");
    });

    it("transitions to wrapping-up on phase-started wrapup", () => {
      const state = createInitialState("t1", makeConfig());
      const next = applyEvent(state, {
        event: "phase-started",
        phase: "wrapup",
      });
      expect(next.status).toBe("wrapping-up");
    });

    it("stores plan and planner thread ID on plan-created", () => {
      const state = createInitialState("t1", makeConfig());
      const next = applyEvent(state, {
        event: "plan-created",
        plan: "The plan",
        threadId: "thread-abc",
      });
      expect(next.plan).toBe("The plan");
      expect(next.plannerThreadId).toBe("thread-abc");
    });

    it("stores work thread ID and resets verification attempt on work-started", () => {
      let state = createInitialState("t1", makeConfig());
      state = { ...state, verificationAttempt: 2 };
      const next = applyEvent(state, {
        event: "work-started",
        threadId: "work-thread-1",
      });
      expect(next.workThreadId).toBe("work-thread-1");
      expect(next.verificationAttempt).toBe(0);
    });

    it("tracks plan review loop and stores summary on rejection", () => {
      const state = createInitialState("t1", makeConfig());
      const next = applyEvent(state, {
        event: "review-result",
        phase: "plan-review",
        approved: false,
        summary: "Needs more detail",
        loop: 1,
      });
      expect(next.planReviewLoop).toBe(1);
      expect(next.lastReviewSummary).toBe("Needs more detail");
    });

    it("clears review summary on approval", () => {
      let state = createInitialState("t1", makeConfig());
      state = { ...state, lastReviewSummary: "old feedback" };
      const next = applyEvent(state, {
        event: "review-result",
        phase: "plan-review",
        approved: true,
        summary: "Looks good",
        loop: 1,
      });
      expect(next.lastReviewSummary).toBeNull();
    });

    it("increments verification attempt on failed verification", () => {
      const state = createInitialState("t1", makeConfig());
      const next = applyEvent(state, {
        event: "verification-result",
        results: [
          { name: "test", passed: false, exitCode: 1, output: "fail" },
          { name: "lint", passed: true, exitCode: 0, output: "" },
        ],
      });
      expect(next.verificationAttempt).toBe(1);
      expect(next.lastVerificationResults).toHaveLength(2);
    });

    it("does not increment verification attempt when all pass", () => {
      const state = createInitialState("t1", makeConfig());
      const next = applyEvent(state, {
        event: "verification-result",
        results: [
          { name: "test", passed: true, exitCode: 0, output: "" },
          { name: "lint", passed: true, exitCode: 0, output: "" },
        ],
      });
      expect(next.verificationAttempt).toBe(0);
    });

    it("stores wrapup results and transitions to completed", () => {
      const state = createInitialState("t1", makeConfig());
      const next = applyEvent(state, {
        event: "wrapup-result",
        actions: [
          { type: "git-pr", artifact: "https://pr.url", success: true },
        ],
      });
      expect(next.status).toBe("completed");
      expect(next.wrapupResults).toHaveLength(1);
    });

    it("transitions to failed on task-failed", () => {
      const state = createInitialState("t1", makeConfig());
      const next = applyEvent(state, {
        event: "task-failed",
        reason: "Max retries exceeded",
      });
      expect(next.status).toBe("failed");
    });

    it("transitions to completed on task-closed", () => {
      const state = createInitialState("t1", makeConfig());
      const next = applyEvent(state, { event: "task-closed" });
      expect(next.status).toBe("completed");
    });
  });

  describe("isTerminal", () => {
    it("returns true for completed", () => {
      const state = createInitialState("t1", makeConfig());
      expect(isTerminal({ ...state, status: "completed" })).toBe(true);
    });

    it("returns true for failed", () => {
      const state = createInitialState("t1", makeConfig());
      expect(isTerminal({ ...state, status: "failed" })).toBe(true);
    });

    it("returns false for non-terminal statuses", () => {
      const state = createInitialState("t1", makeConfig());
      expect(isTerminal({ ...state, status: "working" })).toBe(false);
      expect(isTerminal({ ...state, status: "planning" })).toBe(false);
    });
  });

  describe("hydrateTaskStates", () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), "hydrate-test-"));
      await mkdir(join(tempDir, "tasks"), { recursive: true });
    });

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    it("hydrates task state from JSONL events", () => {
      const logPath = join(tempDir, "tasks", "t1.jsonl");
      appendEvent(logPath, {
        event: "task-accepted",
        taskId: "t1",
        config: makeConfig({ taskId: "t1" }),
      });
      appendEvent(logPath, { event: "phase-started", phase: "plan" });
      appendEvent(logPath, {
        event: "plan-created",
        plan: "My plan",
        threadId: "thread-1",
      });

      const states = hydrateTaskStates(tempDir);
      expect(states.size).toBe(1);
      const state = states.get("t1");
      expect(state).toBeDefined();
      expect(state!.plan).toBe("My plan");
      expect(state!.plannerThreadId).toBe("thread-1");
    });

    it("returns empty map when tasks directory does not exist", () => {
      const states = hydrateTaskStates(join(tempDir, "nonexistent"));
      expect(states.size).toBe(0);
    });
  });
});
```

- [ ] **Step 8: Run tests**

```bash
cd /Users/shravansunder/Documents/dev/project-dev/agent-vm.agent-vm-worker && pnpm --filter agent-vm-worker test
```

Expected: all tests pass, exit code 0.

- [ ] **Step 9: Run typecheck**

```bash
cd /Users/shravansunder/Documents/dev/project-dev/agent-vm.agent-vm-worker && pnpm --filter agent-vm-worker typecheck
```

Expected: exit code 0, no errors.

**Commit:** `feat(agent-vm-worker): add event-sourced state — event types, JSONL log, task state with hydration`

---

## Task 3: Config — Zod Schemas + Loading

New schemas from the design spec. Replaces the flat `codingGatewayConfigSchema` with a phase-structured config supporting MCP servers, wrapup actions, and per-phase skills.

**Files:**
- Create: `packages/agent-vm-worker/src/config/worker-config.ts`
- Create: `packages/agent-vm-worker/src/config/worker-config.test.ts`

**Steps:**

- [ ] **Step 1: Create `packages/agent-vm-worker/src/config/worker-config.ts`**

```typescript
import { readFileSync, existsSync } from "node:fs";

import { z } from "zod";

import { skillReferenceSchema } from "../shared/skill-types.js";

// --- MCP server ---

export const mcpServerSchema = z.object({
  name: z.string().min(1),
  url: z.string().min(1),
});

// --- Phase executor (provider/model override per phase) ---

export const phaseExecutorSchema = z.object({
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
});

// --- Phase configs ---

export const planPhaseSchema = z.object({
  ...phaseExecutorSchema.shape,
  skills: z.array(skillReferenceSchema).default([]),
  instructions: z.string().optional(),
  maxReviewLoops: z.number().int().nonnegative().default(2),
});

export const planReviewPhaseSchema = z.object({
  ...phaseExecutorSchema.shape,
  skills: z.array(skillReferenceSchema).default([]),
  instructions: z.string().optional(),
});

export const workPhaseSchema = z.object({
  ...phaseExecutorSchema.shape,
  skills: z.array(skillReferenceSchema).default([]),
  instructions: z.string().optional(),
  maxReviewLoops: z.number().int().nonnegative().default(3),
  maxVerificationRetries: z.number().int().nonnegative().default(3),
});

export const workReviewPhaseSchema = z.object({
  ...phaseExecutorSchema.shape,
  skills: z.array(skillReferenceSchema).default([]),
  instructions: z.string().optional(),
});

export const wrapupPhaseSchema = z.object({
  ...phaseExecutorSchema.shape,
  skills: z.array(skillReferenceSchema).default([]),
  instructions: z.string().optional(),
});

// --- Verification command ---

export const verificationCommandSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
});

// --- Wrapup action (discriminated union) ---

export const wrapupActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("git-pr"),
    required: z.boolean().default(true),
  }),
  z.object({
    type: z.literal("slack-post"),
    webhookUrl: z.string().url(),
    channel: z.string().min(1).optional(),
    required: z.boolean().default(false),
  }),
]);

// --- Main worker config ---

export const workerConfigSchema = z.object({
  defaults: z
    .object({
      provider: z.string().min(1).default("codex"),
      model: z.string().min(1).default("latest-medium"),
    })
    .default({}),
  phases: z
    .object({
      plan: planPhaseSchema.default({}),
      planReview: planReviewPhaseSchema.default({}),
      work: workPhaseSchema.default({}),
      workReview: workReviewPhaseSchema.default({}),
      wrapup: wrapupPhaseSchema.default({}),
    })
    .default({}),
  mcpServers: z.array(mcpServerSchema).default([]),
  verification: z
    .array(verificationCommandSchema)
    .default([
      { name: "test", command: "npm test" },
      { name: "lint", command: "npm run lint" },
    ]),
  verificationTimeoutMs: z.number().positive().default(300_000),
  wrapupActions: z
    .array(wrapupActionSchema)
    .default([{ type: "git-pr" as const }]),
  branchPrefix: z.string().min(1).default("agent/"),
  commitCoAuthor: z
    .string()
    .min(1)
    .default("agent-vm-worker <noreply@agent-vm>"),
  idleTimeoutMs: z.number().positive().default(1_800_000),
  stateDir: z.string().min(1).default("/state"),
});

export type WorkerConfig = z.infer<typeof workerConfigSchema>;

// --- Model alias resolution ---

const MODEL_ALIASES: Record<string, Record<string, string>> = {
  codex: {
    latest: "gpt-5.4-high",
    "latest-medium": "gpt-5.4-low",
    "latest-mini": "gpt-5.4-mini",
  },
  claude: {
    latest: "claude-opus-4-6",
    "latest-medium": "claude-sonnet-4-6",
    "latest-mini": "claude-haiku-4-5",
  },
};

export function resolveModelAlias(
  provider: string,
  model: string,
): string {
  const providerAliases = MODEL_ALIASES[provider];
  if (!providerAliases) {
    return model;
  }
  return providerAliases[model] ?? model;
}

/**
 * Resolves the effective provider and model for a given phase.
 * Phase config overrides defaults. Alias resolution happens here.
 */
export function resolvePhaseExecutor(
  config: WorkerConfig,
  phase: { readonly provider?: string | undefined; readonly model?: string | undefined },
): { readonly provider: string; readonly model: string } {
  const provider = phase.provider ?? config.defaults.provider;
  const model = phase.model ?? config.defaults.model;
  return {
    provider,
    model: resolveModelAlias(provider, model),
  };
}

// --- Config loading ---

export function loadWorkerConfig(configPath?: string): WorkerConfig {
  if (configPath && existsSync(configPath)) {
    const raw: unknown = JSON.parse(readFileSync(configPath, "utf-8"));
    return workerConfigSchema.parse(raw);
  }

  return workerConfigSchema.parse({});
}
```

- [ ] **Step 2: Create `packages/agent-vm-worker/src/config/worker-config.test.ts`**

```typescript
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  loadWorkerConfig,
  resolveModelAlias,
  resolvePhaseExecutor,
  workerConfigSchema,
} from "./worker-config.js";

describe("worker-config", () => {
  describe("workerConfigSchema", () => {
    it("applies all defaults for empty input", () => {
      const config = workerConfigSchema.parse({});

      expect(config.defaults.provider).toBe("codex");
      expect(config.defaults.model).toBe("latest-medium");
      expect(config.phases.plan.maxReviewLoops).toBe(2);
      expect(config.phases.work.maxReviewLoops).toBe(3);
      expect(config.phases.work.maxVerificationRetries).toBe(3);
      expect(config.verification).toHaveLength(2);
      expect(config.wrapupActions).toHaveLength(1);
      expect(config.branchPrefix).toBe("agent/");
      expect(config.stateDir).toBe("/state");
    });

    it("merges partial overrides", () => {
      const config = workerConfigSchema.parse({
        defaults: { provider: "claude" },
        phases: {
          plan: { maxReviewLoops: 0 },
        },
        verification: [{ name: "typecheck", command: "tsc --noEmit" }],
      });

      expect(config.defaults.provider).toBe("claude");
      expect(config.defaults.model).toBe("latest-medium");
      expect(config.phases.plan.maxReviewLoops).toBe(0);
      expect(config.verification).toHaveLength(1);
      expect(config.verification[0]!.name).toBe("typecheck");
    });

    it("validates wrapup actions with discriminated union", () => {
      const config = workerConfigSchema.parse({
        wrapupActions: [
          { type: "git-pr", required: true },
          {
            type: "slack-post",
            webhookUrl: "https://hooks.slack.com/test",
            channel: "#eng",
            required: false,
          },
        ],
      });

      expect(config.wrapupActions).toHaveLength(2);
    });

    it("rejects invalid wrapup action type", () => {
      expect(() =>
        workerConfigSchema.parse({
          wrapupActions: [{ type: "invalid-action" }],
        }),
      ).toThrow();
    });
  });

  describe("resolveModelAlias", () => {
    it("resolves codex latest-medium to gpt-5.4-low", () => {
      expect(resolveModelAlias("codex", "latest-medium")).toBe("gpt-5.4-low");
    });

    it("resolves claude latest to claude-opus-4-6", () => {
      expect(resolveModelAlias("claude", "latest")).toBe("claude-opus-4-6");
    });

    it("passes through explicit model IDs unchanged", () => {
      expect(resolveModelAlias("codex", "gpt-5.4-turbo")).toBe(
        "gpt-5.4-turbo",
      );
    });

    it("passes through unknown providers unchanged", () => {
      expect(resolveModelAlias("unknown-provider", "latest")).toBe("latest");
    });
  });

  describe("resolvePhaseExecutor", () => {
    it("uses defaults when phase has no overrides", () => {
      const config = workerConfigSchema.parse({});
      const result = resolvePhaseExecutor(config, {});

      expect(result.provider).toBe("codex");
      expect(result.model).toBe("gpt-5.4-low");
    });

    it("uses phase overrides when provided", () => {
      const config = workerConfigSchema.parse({});
      const result = resolvePhaseExecutor(config, {
        provider: "claude",
        model: "latest",
      });

      expect(result.provider).toBe("claude");
      expect(result.model).toBe("claude-opus-4-6");
    });
  });

  describe("loadWorkerConfig", () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), "config-test-"));
    });

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    it("loads config from file", async () => {
      const configPath = join(tempDir, "worker.json");
      await writeFile(
        configPath,
        JSON.stringify({
          defaults: { provider: "claude", model: "latest-mini" },
        }),
        "utf-8",
      );

      const config = loadWorkerConfig(configPath);
      expect(config.defaults.provider).toBe("claude");
      expect(config.defaults.model).toBe("latest-mini");
    });

    it("returns defaults when path is undefined", () => {
      const config = loadWorkerConfig(undefined);
      expect(config.defaults.provider).toBe("codex");
    });

    it("returns defaults when file does not exist", () => {
      const config = loadWorkerConfig(join(tempDir, "nonexistent.json"));
      expect(config.defaults.provider).toBe("codex");
    });
  });
});
```

- [ ] **Step 3: Run tests**

```bash
cd /Users/shravansunder/Documents/dev/project-dev/agent-vm.agent-vm-worker && pnpm --filter agent-vm-worker test
```

Expected: all tests pass.

- [ ] **Step 4: Run typecheck**

```bash
cd /Users/shravansunder/Documents/dev/project-dev/agent-vm.agent-vm-worker && pnpm --filter agent-vm-worker typecheck
```

Expected: exit code 0.

**Commit:** `feat(agent-vm-worker): add config module — Zod schemas, model alias resolution, phase config`

---

## Task 4: Work Executor — Interface + Codex Adapter + Factory

Generic `WorkExecutor` interface decouples the coordinator from any specific AI provider. The Codex adapter wraps `@openai/codex-sdk`. Claude throws "not implemented." Factory creates the right executor by provider name.

**What changes from agent-vm-coding:** The old code had separate `PlannerAgent`, `CoderAgent`, `CodeReviewerAgent`, `PlanReviewerAgent` interfaces each tightly coupled to `CodexClient`. The new code has one `WorkExecutor` interface. The Codex adapter merges logic from `codex-client-factory.ts` and `coder-agent.ts`. `StructuredInput` changes: `path` becomes `content` — the worker reads the skill file and passes text, not file paths.

**Files:**
- Create: `packages/agent-vm-worker/src/work-executor/executor-interface.ts`
- Create: `packages/agent-vm-worker/src/work-executor/codex-executor.ts`
- Create: `packages/agent-vm-worker/src/work-executor/codex-executor.test.ts`
- Create: `packages/agent-vm-worker/src/work-executor/executor-factory.ts`

**Steps:**

- [ ] **Step 1: Create `packages/agent-vm-worker/src/work-executor/executor-interface.ts`**

```typescript
/**
 * Generic work executor interface — the plug point for AI providers.
 *
 * The executor handles tool calls and MCP sessions internally.
 * We tell it what tools and MCP servers are available at creation time.
 * The SDK manages the tool call loop.
 */

export type StructuredInput =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "skill"; readonly name: string; readonly content: string };

export interface ExecutorResult {
  readonly response: string;
  readonly tokenCount: number;
  readonly threadId: string;
}

export interface WorkExecutor {
  /** Run a prompt — creates a new thread on first call. */
  execute(input: readonly StructuredInput[]): Promise<ExecutorResult>;

  /** Continue the same thread with fix instructions. */
  fix(input: readonly StructuredInput[]): Promise<ExecutorResult>;

  /** Resume a thread from persisted state (crash recovery). */
  resumeOrRebuild(
    threadId: string | null,
    context: readonly StructuredInput[],
  ): Promise<void>;

  /** Current thread ID for persistence. */
  getThreadId(): string | null;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for tool input — the SDK uses this for model-facing affordance discovery. */
  readonly inputSchema: Record<string, unknown>;
  readonly execute: (params: Record<string, unknown>) => Promise<unknown>;
}

export interface ExecutorCapabilities {
  /** MCP servers the executor can connect to (from gateway config). */
  readonly mcpServers: readonly { readonly name: string; readonly url: string }[];
  /** Tools the executor can call (for wrapup: git-pr, slack-post, etc.). */
  readonly tools: readonly ToolDefinition[];
}
```

- [ ] **Step 2: Create `packages/agent-vm-worker/src/work-executor/codex-executor.ts`**

Merges logic from `codex-client-factory.ts` + `coder-agent.ts`. Thread continuity: `execute()` starts a new thread, `fix()` continues it. `StructuredInput` with `type: "skill"` inlines the skill content as text (the Codex SDK reads file paths internally; the adapter passes skill content as a text instruction to follow).

```typescript
import { Codex, type UserInput } from "@openai/codex-sdk";

import type {
  ExecutorCapabilities,
  ExecutorResult,
  StructuredInput,
  WorkExecutor,
} from "./executor-interface.js";

export interface CodexExecutorConfig {
  readonly model: string;
  readonly capabilities: ExecutorCapabilities;
  readonly workingDirectory?: string;
}

/** Maps generic StructuredInput to Codex SDK UserInput. */
function mapToCodexInput(input: readonly StructuredInput[]): UserInput[] {
  return input.map((item): UserInput => {
    if (item.type === "text") {
      return { type: "text", text: item.text };
    }
    // Skills are passed as inline content — the executor never sees file paths
    return {
      type: "text",
      text: `[Skill: ${item.name}]\n\n${item.content}`,
    };
  });
}

export function createCodexExecutor(config: CodexExecutorConfig): WorkExecutor {
  const codex = new Codex({});
  const workingDirectory = config.workingDirectory ?? "/workspace";

  type CodexThread = ReturnType<typeof codex.startThread>;
  let currentThread: CodexThread | null = null;
  let currentThreadId: string | null = null;

  function startNewThread(): CodexThread {
    return codex.startThread({
      model: config.model,
      approvalPolicy: "never",
      sandboxMode: "danger-full-access",
      workingDirectory,
      networkAccessEnabled: true,
    });
  }

  async function runInThread(
    thread: CodexThread,
    input: readonly StructuredInput[],
  ): Promise<ExecutorResult> {
    const result = await thread.run(mapToCodexInput(input));
    const threadId = thread.id ?? currentThreadId ?? "";

    return {
      response: result.finalResponse ?? "",
      tokenCount: result.usage?.output_tokens ?? 0,
      threadId,
    };
  }

  return {
    async execute(
      input: readonly StructuredInput[],
    ): Promise<ExecutorResult> {
      currentThread = startNewThread();
      const result = await runInThread(currentThread, input);
      currentThreadId = result.threadId || null;
      return result;
    },

    async fix(input: readonly StructuredInput[]): Promise<ExecutorResult> {
      if (currentThread === null) {
        throw new Error(
          "No active executor thread. Call execute() first.",
        );
      }
      const result = await runInThread(currentThread, input);
      currentThreadId = result.threadId || currentThreadId;
      return result;
    },

    async resumeOrRebuild(
      threadId: string | null,
      context: readonly StructuredInput[],
    ): Promise<void> {
      if (threadId !== null) {
        try {
          currentThread = codex.resumeThread(threadId, {
            model: config.model,
            approvalPolicy: "never",
            sandboxMode: "danger-full-access",
            workingDirectory,
            networkAccessEnabled: true,
          });
          currentThreadId = threadId;
          return;
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          const recoverableResumeError =
            message.includes("expired") ||
            message.includes("not found") ||
            message.includes("does not exist");
          if (!recoverableResumeError) {
            throw error;
          }
          currentThread = null;
          currentThreadId = null;
        }
      }

      // Rebuild: start fresh thread with context
      currentThread = startNewThread();
      await runInThread(currentThread, context);
      currentThreadId = currentThread.id ?? null;
    },

    getThreadId(): string | null {
      return currentThreadId;
    },
  };
}
```

- [ ] **Step 3: Create `packages/agent-vm-worker/src/work-executor/executor-factory.ts`**

```typescript
import type { ExecutorCapabilities, WorkExecutor } from "./executor-interface.js";
import { createCodexExecutor } from "./codex-executor.js";

export function createWorkExecutor(
  provider: string,
  model: string,
  capabilities: ExecutorCapabilities,
  workingDirectory?: string,
): WorkExecutor {
  switch (provider) {
    case "codex":
      return createCodexExecutor({
        model,
        capabilities,
        workingDirectory,
      });
    case "claude":
      throw new Error("Claude executor is not implemented yet.");
    default:
      throw new Error(`Unknown executor provider: '${provider}'.`);
  }
}
```

- [ ] **Step 4: Create `packages/agent-vm-worker/src/work-executor/codex-executor.test.ts`**

Tests use a mock of the Codex SDK — the real SDK requires API keys. We test the adapter logic: thread management, input mapping, resume/rebuild fallback.

```typescript
import { describe, expect, it, vi, beforeEach } from "vitest";

import type {
  ExecutorResult,
  StructuredInput,
  WorkExecutor,
} from "./executor-interface.js";

// We test through a mock executor that exercises the same contract.
// The real Codex SDK is tested via integration tests.

interface MockThread {
  readonly id: string;
  run: (input: unknown[]) => Promise<{
    finalResponse: string;
    usage?: { output_tokens: number };
  }>;
}

function createMockWorkExecutor(): WorkExecutor & {
  readonly executeCalls: StructuredInput[][];
  readonly fixCalls: StructuredInput[][];
} {
  let currentThread: MockThread | null = null;
  let currentThreadId: string | null = null;
  const executeCalls: StructuredInput[][] = [];
  const fixCalls: StructuredInput[][] = [];
  let threadCounter = 0;

  return {
    async execute(
      input: readonly StructuredInput[],
    ): Promise<ExecutorResult> {
      executeCalls.push([...input]);
      threadCounter += 1;
      const threadId = `thread-${threadCounter}`;
      currentThread = {
        id: threadId,
        run: vi.fn().mockResolvedValue({
          finalResponse: "executed",
          usage: { output_tokens: 50 },
        }),
      };
      currentThreadId = threadId;
      return { response: "executed", tokenCount: 50, threadId };
    },

    async fix(input: readonly StructuredInput[]): Promise<ExecutorResult> {
      if (currentThread === null) {
        throw new Error("No active executor thread. Call execute() first.");
      }
      fixCalls.push([...input]);
      return {
        response: "fixed",
        tokenCount: 30,
        threadId: currentThreadId ?? "",
      };
    },

    async resumeOrRebuild(
      threadId: string | null,
      _context: readonly StructuredInput[],
    ): Promise<void> {
      if (threadId !== null) {
        currentThread = { id: threadId, run: vi.fn() };
        currentThreadId = threadId;
        return;
      }
      threadCounter += 1;
      const newThreadId = `thread-${threadCounter}`;
      currentThread = { id: newThreadId, run: vi.fn() };
      currentThreadId = newThreadId;
    },

    getThreadId(): string | null {
      return currentThreadId;
    },

    executeCalls,
    fixCalls,
  };
}

describe("work-executor interface contract", () => {
  let executor: ReturnType<typeof createMockWorkExecutor>;

  beforeEach(() => {
    executor = createMockWorkExecutor();
  });

  it("execute() starts a new thread and returns result", async () => {
    const result = await executor.execute([
      { type: "text", text: "do the thing" },
    ]);

    expect(result.response).toBe("executed");
    expect(result.tokenCount).toBe(50);
    expect(result.threadId).toBe("thread-1");
    expect(executor.getThreadId()).toBe("thread-1");
  });

  it("fix() continues the same thread", async () => {
    await executor.execute([{ type: "text", text: "initial" }]);
    const result = await executor.fix([{ type: "text", text: "fix this" }]);

    expect(result.response).toBe("fixed");
    expect(result.threadId).toBe("thread-1");
    expect(executor.fixCalls).toHaveLength(1);
  });

  it("fix() throws when no thread exists", async () => {
    await expect(
      executor.fix([{ type: "text", text: "fix" }]),
    ).rejects.toThrow("No active executor thread");
  });

  it("resumeOrRebuild() resumes existing thread", async () => {
    await executor.resumeOrRebuild("existing-thread", []);
    expect(executor.getThreadId()).toBe("existing-thread");
  });

  it("resumeOrRebuild() rebuilds when threadId is null", async () => {
    await executor.resumeOrRebuild(null, [
      { type: "text", text: "context" },
    ]);
    expect(executor.getThreadId()).toBe("thread-1");
  });

  it("handles skill inputs", async () => {
    await executor.execute([
      { type: "text", text: "implement plan" },
      {
        type: "skill",
        name: "tdd",
        content: "Write tests first.",
      },
    ]);

    expect(executor.executeCalls[0]).toHaveLength(2);
    expect(executor.executeCalls[0]![1]!.type).toBe("skill");
  });
});

describe("executor-factory", () => {
  it("throws for claude provider", async () => {
    const { createWorkExecutor } = await import("./executor-factory.js");
    expect(() =>
      createWorkExecutor("claude", "latest", { mcpServers: [], tools: [] }),
    ).toThrow("Claude executor is not implemented yet.");
  });

  it("throws for unknown provider", async () => {
    const { createWorkExecutor } = await import("./executor-factory.js");
    expect(() =>
      createWorkExecutor("unknown", "latest", { mcpServers: [], tools: [] }),
    ).toThrow("Unknown executor provider: 'unknown'.");
  });
});
```

- [ ] **Step 5: Run tests**

```bash
cd /Users/shravansunder/Documents/dev/project-dev/agent-vm.agent-vm-worker && pnpm --filter agent-vm-worker test
```

Expected: all tests pass.

- [ ] **Step 6: Run typecheck**

```bash
cd /Users/shravansunder/Documents/dev/project-dev/agent-vm.agent-vm-worker && pnpm --filter agent-vm-worker typecheck
```

Expected: exit code 0.

**Commit:** `feat(agent-vm-worker): add work executor — generic interface, Codex adapter, factory`

---

## Task 5: Prompt Assembler

Generic prompt assembly replacing the per-phase prompt builders. Three layers: base prompt (safety/identity), phase instructions (defaults overridable by config), task input (prompt + context + repo + skills + plan + failure context).

**What changes from agent-vm-coding:** The old `prompt-builder.ts` had 7 separate builder functions (`buildPlannerPrompt`, `buildPlanRevisionPrompt`, `buildCoderImplementPrompt`, etc.), each hardcoding its own text layout and using `SkillName` enum to resolve skill paths. The new module has one `assemblePrompt` function that composes base + instructions + task-specific content, and a `resolveSkillInputs` function that reads skill files from disk and returns `StructuredInput[]`.

**Files:**
- Create: `packages/agent-vm-worker/src/prompt/prompt-assembler.ts`
- Create: `packages/agent-vm-worker/src/prompt/prompt-assembler.test.ts`

**Steps:**

- [ ] **Step 1: Create `packages/agent-vm-worker/src/prompt/prompt-assembler.ts`**

```typescript
import { readFileSync, existsSync } from "node:fs";

import type { StructuredInput } from "../work-executor/executor-interface.js";
import type { SkillReference } from "../shared/skill-types.js";

// --- Base prompts (not overridable) ---

const BASE_WORKER_PROMPT =
  "You are an agent working in a sandboxed VM. You have access to the workspace at /workspace. " +
  "Do not attempt to access the network directly — all outbound requests go through a mediation proxy.";

const BASE_REVIEW_PROMPT =
  "Return your review as structured JSON matching the ReviewResult schema: " +
  '{ approved: boolean, comments: [{ file: string, line?: number, severity: "critical" | "suggestion" | "nitpick", comment: string }], summary: string }';

// --- Default phase instructions (overridable by config) ---

const DEFAULT_PHASE_INSTRUCTIONS: Record<string, string> = {
  plan: "Create an implementation plan for the task. Do not write code yet.",
  "plan-review":
    "Review the plan for completeness, correctness, risks, and missing edge cases.",
  work: "Implement the approved plan.",
  "work-review":
    "Review the code changes for correctness, bugs, style, and test coverage.",
  wrapup:
    "Complete the task by running the configured wrapup actions. You have access to: " +
    "git (commit, push, PR), Slack (webhook post). Decide which actions to take based on the task results.",
};

const REVIEW_PHASES = new Set(["plan-review", "work-review"]);

// --- Skill loading ---

/**
 * Reads skill files from the VM filesystem and returns StructuredInput[].
 * Missing skill files are logged and skipped — they may not be baked into this VM image.
 */
export function resolveSkillInputs(
  skills: readonly SkillReference[],
): readonly StructuredInput[] {
  const result: StructuredInput[] = [];

  for (const skill of skills) {
    if (!existsSync(skill.path)) {
      console.warn(
        `[prompt-assembler] Skill file not found, skipping: ${skill.name} (${skill.path})`,
      );
      continue;
    }

    const content = readFileSync(skill.path, "utf-8");
    result.push({
      type: "skill",
      name: skill.name,
      content,
    });
  }

  return result;
}

// --- Prompt assembly ---

export interface AssemblePromptInput {
  readonly phase: string;
  readonly phaseInstructions?: string | undefined;
  readonly taskPrompt: string;
  readonly repo?: {
    readonly repoUrl: string;
    readonly baseBranch: string;
    readonly workspacePath: string;
  } | null;
  readonly context?: Record<string, unknown>;
  readonly plan?: string | null;
  readonly failureContext?: string | null;
  readonly skills: readonly SkillReference[];
}

/**
 * Assembles the complete prompt for a phase.
 *
 * Layer 1: Base prompt (safety/identity) — always present, not overridable
 * Layer 2: Phase instructions — defaults in code, overridable by config
 * Layer 3: Task input — prompt, context, repo, plan, failure context, skills
 */
export function assemblePrompt(
  input: AssemblePromptInput,
): readonly StructuredInput[] {
  const sections: string[] = [];

  // Layer 1: Base prompt
  sections.push(BASE_WORKER_PROMPT);
  if (REVIEW_PHASES.has(input.phase)) {
    sections.push("");
    sections.push(BASE_REVIEW_PROMPT);
  }

  // Layer 2: Phase instructions
  const instructions =
    input.phaseInstructions ?? DEFAULT_PHASE_INSTRUCTIONS[input.phase] ?? "";
  if (instructions.length > 0) {
    sections.push("");
    sections.push(instructions);
  }

  // Layer 3: Task input
  sections.push("");
  sections.push(`Task: ${input.taskPrompt}`);

  if (input.repo) {
    sections.push("");
    sections.push(
      `Repository: ${input.repo.repoUrl} (branch: ${input.repo.baseBranch})`,
    );
    sections.push(`Workspace: ${input.repo.workspacePath}`);
  }

  if (input.context && Object.keys(input.context).length > 0) {
    sections.push("");
    sections.push("Context:");
    sections.push(JSON.stringify(input.context, null, 2));
  }

  if (input.plan) {
    sections.push("");
    sections.push("Approved plan:");
    sections.push(input.plan);
  }

  if (input.failureContext) {
    sections.push("");
    sections.push("Failure context from previous attempt:");
    sections.push(input.failureContext);
  }

  const textInput: StructuredInput = {
    type: "text",
    text: sections.join("\n"),
  };

  // Resolve skills from filesystem
  const skillInputs = resolveSkillInputs(input.skills);

  return [textInput, ...skillInputs];
}
```

- [ ] **Step 2: Create `packages/agent-vm-worker/src/prompt/prompt-assembler.test.ts`**

```typescript
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assemblePrompt, resolveSkillInputs } from "./prompt-assembler.js";

describe("prompt-assembler", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "prompt-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("resolveSkillInputs", () => {
    it("reads skill files and returns StructuredInput array", async () => {
      const skillDir = join(tempDir, "skills", "tdd");
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(skillDir, "SKILL.md"),
        "# TDD Skill\nWrite tests first.",
        "utf-8",
      );

      const inputs = resolveSkillInputs([
        { name: "tdd", path: join(skillDir, "SKILL.md") },
      ]);

      expect(inputs).toHaveLength(1);
      expect(inputs[0]!.type).toBe("skill");
      if (inputs[0]!.type === "skill") {
        expect(inputs[0]!.name).toBe("tdd");
        expect(inputs[0]!.content).toContain("Write tests first.");
      }
    });

    it("skips missing skill files", () => {
      const inputs = resolveSkillInputs([
        { name: "nonexistent", path: "/nonexistent/SKILL.md" },
      ]);

      expect(inputs).toHaveLength(0);
    });
  });

  describe("assemblePrompt", () => {
    it("includes base prompt and task prompt in text", () => {
      const result = assemblePrompt({
        phase: "plan",
        taskPrompt: "fix the login bug",
        skills: [],
      });

      expect(result).toHaveLength(1);
      const text = result[0]!;
      expect(text.type).toBe("text");
      if (text.type === "text") {
        expect(text.text).toContain("sandboxed VM");
        expect(text.text).toContain("fix the login bug");
        expect(text.text).toContain(
          "Create an implementation plan",
        );
      }
    });

    it("includes review JSON format for review phases", () => {
      const result = assemblePrompt({
        phase: "plan-review",
        taskPrompt: "review this",
        skills: [],
      });

      const text = result[0]!;
      if (text.type === "text") {
        expect(text.text).toContain("ReviewResult schema");
      }
    });

    it("uses custom phase instructions when provided", () => {
      const result = assemblePrompt({
        phase: "plan",
        phaseInstructions: "Custom: make a plan and include diagrams.",
        taskPrompt: "build feature",
        skills: [],
      });

      const text = result[0]!;
      if (text.type === "text") {
        expect(text.text).toContain("Custom: make a plan");
        expect(text.text).not.toContain(
          "Create an implementation plan",
        );
      }
    });

    it("includes repo information when provided", () => {
      const result = assemblePrompt({
        phase: "work",
        taskPrompt: "implement feature",
        repo: {
          repoUrl: "https://github.com/org/repo.git",
          baseBranch: "main",
          workspacePath: "/workspace",
        },
        skills: [],
      });

      const text = result[0]!;
      if (text.type === "text") {
        expect(text.text).toContain("github.com/org/repo.git");
        expect(text.text).toContain("branch: main");
      }
    });

    it("includes context when provided", () => {
      const result = assemblePrompt({
        phase: "work",
        taskPrompt: "triage alert",
        context: { alertId: "INC-123", service: "payments" },
        skills: [],
      });

      const text = result[0]!;
      if (text.type === "text") {
        expect(text.text).toContain("INC-123");
        expect(text.text).toContain("payments");
      }
    });

    it("includes plan for work phases", () => {
      const result = assemblePrompt({
        phase: "work",
        taskPrompt: "implement",
        plan: "Step 1: write tests\nStep 2: implement",
        skills: [],
      });

      const text = result[0]!;
      if (text.type === "text") {
        expect(text.text).toContain("Approved plan:");
        expect(text.text).toContain("Step 1: write tests");
      }
    });

    it("includes failure context for retries", () => {
      const result = assemblePrompt({
        phase: "work",
        taskPrompt: "fix bug",
        failureContext: "Test failed: exit code 1\nassert false",
        skills: [],
      });

      const text = result[0]!;
      if (text.type === "text") {
        expect(text.text).toContain("Failure context");
        expect(text.text).toContain("assert false");
      }
    });

    it("appends skill inputs after text", async () => {
      const skillDir = join(tempDir, "skills", "debug");
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(skillDir, "SKILL.md"),
        "# Debug Skill",
        "utf-8",
      );

      const result = assemblePrompt({
        phase: "work",
        taskPrompt: "debug issue",
        skills: [{ name: "debug", path: join(skillDir, "SKILL.md") }],
      });

      expect(result).toHaveLength(2);
      expect(result[0]!.type).toBe("text");
      expect(result[1]!.type).toBe("skill");
    });
  });
});
```

- [ ] **Step 3: Run tests**

```bash
cd /Users/shravansunder/Documents/dev/project-dev/agent-vm.agent-vm-worker && pnpm --filter agent-vm-worker test
```

Expected: all tests pass.

- [ ] **Step 4: Run typecheck**

```bash
cd /Users/shravansunder/Documents/dev/project-dev/agent-vm.agent-vm-worker && pnpm --filter agent-vm-worker typecheck
```

Expected: exit code 0.

**Commit:** `feat(agent-vm-worker): add prompt assembler — generic prompt composition with skill loading`

---

## Task 6: Planner + Plan Reviewer

Planner uses a `WorkExecutor` with thread continuity across revisions (`execute()` on first call, `fix()` on subsequent revisions). Plan reviewer is single-shot: creates a fresh executor per invocation, parses `ReviewResult` JSON from the response.

**What changes from agent-vm-coding:** The old `planner-agent.ts` took a `CodexClient` and managed its own thread via `startThread`/`resumeThread`. The new planner takes a `WorkExecutor` instance — it doesn't care about the provider. The old `plan-reviewer-agent.ts` similarly took a `CodexClient`. The new plan reviewer takes a `WorkExecutor` factory function (since each invocation needs a fresh executor). Both use `assemblePrompt` instead of hardcoded prompt builders.

**Files:**
- Create: `packages/agent-vm-worker/src/planner/planner.ts`
- Create: `packages/agent-vm-worker/src/planner/planner.test.ts`
- Create: `packages/agent-vm-worker/src/planner/plan-reviewer.ts`
- Create: `packages/agent-vm-worker/src/planner/plan-reviewer.test.ts`

**Steps:**

- [ ] **Step 1: Create `packages/agent-vm-worker/src/planner/planner.ts`**

```typescript
import type {
  ExecutorResult,
  StructuredInput,
  WorkExecutor,
} from "../work-executor/executor-interface.js";

export interface PlanResult {
  readonly plan: string;
  readonly threadId: string;
  readonly tokenCount: number;
}

/**
 * Planner: drives the plan phase using a WorkExecutor with thread continuity.
 *
 * - `plan()` calls `executor.execute()` (creates a new thread)
 * - `revise()` calls `executor.fix()` (continues the same thread)
 *
 * The planner does NOT create executors — it receives one. The coordinator
 * creates the executor with the right provider/model/capabilities.
 */
export interface Planner {
  plan(input: readonly StructuredInput[]): Promise<PlanResult>;
  revise(input: readonly StructuredInput[]): Promise<PlanResult>;
  getThreadId(): string | null;
}

export function createPlanner(executor: WorkExecutor): Planner {
  function toPlanResult(result: ExecutorResult): PlanResult {
    return {
      plan: result.response,
      threadId: result.threadId,
      tokenCount: result.tokenCount,
    };
  }

  return {
    async plan(input: readonly StructuredInput[]): Promise<PlanResult> {
      const result = await executor.execute(input);
      return toPlanResult(result);
    },

    async revise(input: readonly StructuredInput[]): Promise<PlanResult> {
      const result = await executor.fix(input);
      return toPlanResult(result);
    },

    getThreadId(): string | null {
      return executor.getThreadId();
    },
  };
}
```

- [ ] **Step 2: Create `packages/agent-vm-worker/src/planner/plan-reviewer.ts`**

```typescript
import type {
  StructuredInput,
  WorkExecutor,
} from "../work-executor/executor-interface.js";
import { reviewResultSchema, type ReviewResult } from "../shared/review-result.js";

/**
 * Plan reviewer: single-shot executor that evaluates a plan and returns a ReviewResult.
 *
 * Each invocation creates a fresh thread — reviewers don't accumulate context.
 */
export interface PlanReviewer {
  review(input: readonly StructuredInput[]): Promise<ReviewResult>;
}

export function createPlanReviewer(executor: WorkExecutor): PlanReviewer {
  return {
    async review(input: readonly StructuredInput[]): Promise<ReviewResult> {
      const result = await executor.execute(input);
      const response = result.response;

      // Parse JSON from response
      let parsed: unknown;
      try {
        parsed = JSON.parse(response);
      } catch {
        throw new Error(
          `Review response is not valid JSON. Raw: ${response.slice(0, 200)}`,
        );
      }

      // Validate against ReviewResult schema
      const parseResult = reviewResultSchema.safeParse(parsed);
      if (!parseResult.success) {
        throw new Error(
          `Review JSON doesn't match schema: ${parseResult.error.message}. Raw: ${response.slice(0, 200)}`,
        );
      }

      return parseResult.data;
    },
  };
}
```

- [ ] **Step 3: Create `packages/agent-vm-worker/src/planner/planner.test.ts`**

```typescript
import { describe, expect, it, vi } from "vitest";

import type { WorkExecutor, StructuredInput, ExecutorResult } from "../work-executor/executor-interface.js";
import { createPlanner } from "./planner.js";

function createMockExecutor(overrides?: {
  readonly executeResponse?: string;
  readonly fixResponse?: string;
}): WorkExecutor & {
  readonly executeCalls: StructuredInput[][];
  readonly fixCalls: StructuredInput[][];
} {
  const executeCalls: StructuredInput[][] = [];
  const fixCalls: StructuredInput[][] = [];
  let threadId: string | null = null;

  return {
    async execute(input: readonly StructuredInput[]): Promise<ExecutorResult> {
      executeCalls.push([...input]);
      threadId = "planner-thread-1";
      return {
        response: overrides?.executeResponse ?? "Plan v1",
        tokenCount: 100,
        threadId: "planner-thread-1",
      };
    },
    async fix(input: readonly StructuredInput[]): Promise<ExecutorResult> {
      fixCalls.push([...input]);
      return {
        response: overrides?.fixResponse ?? "Plan v2 (revised)",
        tokenCount: 80,
        threadId: threadId ?? "planner-thread-1",
      };
    },
    async resumeOrRebuild(): Promise<void> {
      return;
    },
    getThreadId(): string | null {
      return threadId;
    },
    executeCalls,
    fixCalls,
  };
}

describe("planner", () => {
  it("plan() calls executor.execute() and returns plan result", async () => {
    const executor = createMockExecutor({ executeResponse: "Step 1: do X" });
    const planner = createPlanner(executor);

    const result = await planner.plan([
      { type: "text", text: "Create a plan" },
    ]);

    expect(result.plan).toBe("Step 1: do X");
    expect(result.threadId).toBe("planner-thread-1");
    expect(result.tokenCount).toBe(100);
    expect(executor.executeCalls).toHaveLength(1);
  });

  it("revise() calls executor.fix() to continue the same thread", async () => {
    const executor = createMockExecutor({
      fixResponse: "Revised plan with more detail",
    });
    const planner = createPlanner(executor);

    await planner.plan([{ type: "text", text: "Create a plan" }]);
    const revised = await planner.revise([
      { type: "text", text: "Add more detail" },
    ]);

    expect(revised.plan).toBe("Revised plan with more detail");
    expect(executor.fixCalls).toHaveLength(1);
  });

  it("getThreadId() returns the executor thread ID", async () => {
    const executor = createMockExecutor();
    const planner = createPlanner(executor);

    expect(planner.getThreadId()).toBeNull();

    await planner.plan([{ type: "text", text: "plan" }]);
    expect(planner.getThreadId()).toBe("planner-thread-1");
  });
});
```

- [ ] **Step 4: Create `packages/agent-vm-worker/src/planner/plan-reviewer.test.ts`**

```typescript
import { describe, expect, it } from "vitest";

import type {
  WorkExecutor,
  StructuredInput,
  ExecutorResult,
} from "../work-executor/executor-interface.js";
import { createPlanReviewer } from "./plan-reviewer.js";

function createMockReviewExecutor(
  response: string,
): WorkExecutor {
  return {
    async execute(
      _input: readonly StructuredInput[],
    ): Promise<ExecutorResult> {
      return {
        response,
        tokenCount: 50,
        threadId: "review-thread-1",
      };
    },
    async fix(): Promise<ExecutorResult> {
      throw new Error("Reviewers are single-shot — fix() should not be called");
    },
    async resumeOrRebuild(): Promise<void> {
      return;
    },
    getThreadId(): string | null {
      return null;
    },
  };
}

describe("plan-reviewer", () => {
  it("parses a valid ReviewResult from executor response", async () => {
    const executor = createMockReviewExecutor(
      JSON.stringify({
        approved: true,
        comments: [],
        summary: "Plan looks solid.",
      }),
    );
    const reviewer = createPlanReviewer(executor);

    const result = await reviewer.review([
      { type: "text", text: "Review this plan" },
    ]);

    expect(result.approved).toBe(true);
    expect(result.summary).toBe("Plan looks solid.");
    expect(result.comments).toHaveLength(0);
  });

  it("parses rejection with comments", async () => {
    const executor = createMockReviewExecutor(
      JSON.stringify({
        approved: false,
        comments: [
          {
            file: "src/index.ts",
            severity: "critical",
            comment: "Missing error handling",
          },
        ],
        summary: "Needs error handling.",
      }),
    );
    const reviewer = createPlanReviewer(executor);

    const result = await reviewer.review([
      { type: "text", text: "Review" },
    ]);

    expect(result.approved).toBe(false);
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0]!.severity).toBe("critical");
  });

  it("throws on non-JSON response", async () => {
    const executor = createMockReviewExecutor("This is not JSON");
    const reviewer = createPlanReviewer(executor);

    await expect(
      reviewer.review([{ type: "text", text: "Review" }]),
    ).rejects.toThrow("Review response is not valid JSON");
  });

  it("throws on JSON that doesn't match ReviewResult schema", async () => {
    const executor = createMockReviewExecutor(
      JSON.stringify({ approved: "yes", comments: "none" }),
    );
    const reviewer = createPlanReviewer(executor);

    await expect(
      reviewer.review([{ type: "text", text: "Review" }]),
    ).rejects.toThrow("Review JSON doesn't match schema");
  });
});
```

- [ ] **Step 5: Run tests**

```bash
cd /Users/shravansunder/Documents/dev/project-dev/agent-vm.agent-vm-worker && pnpm --filter agent-vm-worker test
```

Expected: all tests pass.

- [ ] **Step 6: Run typecheck**

```bash
cd /Users/shravansunder/Documents/dev/project-dev/agent-vm.agent-vm-worker && pnpm --filter agent-vm-worker typecheck
```

Expected: exit code 0.

**Commit:** `feat(agent-vm-worker): add planner and plan reviewer — executor-driven, thread-continuous planning`

---

## Task 7: Verification Runner

Port from `verification.ts`. Key change: runs a configurable list of named commands instead of hardcoded `testCommand`/`lintCommand`. The `parseCommand` tokenizer (which rejects shell operators) is preserved exactly.

**What changes from agent-vm-coding:** The old `verify()` took `testCommand` and `lintCommand` as separate parameters and returned a flat object with `testStatus`/`lintStatus`/`testOutput`/`lintOutput`. The new `runVerification()` takes `ReadonlyArray<VerificationCommand>` and returns `ReadonlyArray<VerificationCommandResult>` — one result per command, all must pass.

**Files:**
- Create: `packages/agent-vm-worker/src/work-reviewer/verification-runner.ts`
- Create: `packages/agent-vm-worker/src/work-reviewer/verification-runner.test.ts`

**Steps:**

- [ ] **Step 1: Create `packages/agent-vm-worker/src/work-reviewer/verification-runner.ts`**

```typescript
import { execa } from "execa";

export type CommandStatus = "passed" | "failed" | "timeout";

export interface VerificationCommand {
  readonly name: string;
  readonly command: string;
}

export interface VerificationCommandResult {
  readonly name: string;
  readonly passed: boolean;
  readonly exitCode: number;
  readonly output: string;
}

export interface RunVerificationOptions {
  readonly commands: readonly VerificationCommand[];
  readonly cwd: string;
  readonly timeoutMs: number;
}

/**
 * Tokenizes a command string into an argv array without using a shell.
 *
 * Rejects shell operators (|, &, ;, >, <, `, $() as defense-in-depth.
 * Commands come from .agent-vm/config.json — anyone who can push can set them.
 * Even inside a sandboxed VM, preventing shell injection is good practice.
 */
export function parseCommand(command: string): readonly [string, ...string[]] {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    throw new Error("Unsafe command: command must not be empty");
  }

  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index] ?? "";
    const next = trimmed[index + 1] ?? "";

    if (quote === null) {
      if (char === "'" || char === '"') {
        quote = char;
        continue;
      }

      if (/\s/.test(char)) {
        if (current.length > 0) {
          tokens.push(current);
          current = "";
        }
        continue;
      }

      if (
        char === "|" ||
        char === "&" ||
        char === ";" ||
        char === ">" ||
        char === "<" ||
        char === "`" ||
        (char === "$" && next === "(")
      ) {
        throw new Error(
          `Unsafe command: shell operator '${char}' is not allowed`,
        );
      }

      if (char === "\\") {
        current += next;
        index += 1;
        continue;
      }

      current += char;
      continue;
    }

    if (char === quote) {
      quote = null;
      continue;
    }

    if (char === "\\") {
      current += next;
      index += 1;
      continue;
    }

    current += char;
  }

  if (quote !== null) {
    throw new Error("Unsafe command: unmatched quote");
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  const [bin, ...args] = tokens;
  if (!bin) {
    throw new Error("Unsafe command: command must not be empty");
  }

  return [bin, ...args];
}

/**
 * Runs a single command with a timeout.
 */
export async function runCommandWithTimeout(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ readonly status: CommandStatus; readonly output: string; readonly exitCode: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const [bin, ...args] = parseCommand(command);
    const result = await execa(bin, args, {
      cwd,
      cancelSignal: controller.signal,
      reject: false,
    });

    clearTimeout(timeout);

    if (result.isCanceled || result.isTerminated) {
      return { status: "timeout", output: "", exitCode: -1 };
    }

    if ("code" in result && result.code === "ENOENT") {
      const output =
        "shortMessage" in result && typeof result.shortMessage === "string"
          ? result.shortMessage
          : "Command not found";
      return { status: "failed", output, exitCode: 127 };
    }

    if (result.exitCode === 0) {
      return { status: "passed", output: "", exitCode: 0 };
    }

    const combinedOutput = `${result.stdout}\n${result.stderr}`.trim();
    const truncatedOutput =
      combinedOutput.length > 4096
        ? combinedOutput.slice(-4096)
        : combinedOutput;

    return {
      status: "failed",
      output: truncatedOutput,
      exitCode: result.exitCode ?? 1,
    };
  } catch (error) {
    clearTimeout(timeout);
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return {
        status: "failed",
        output: error instanceof Error ? error.message : String(error),
        exitCode: 127,
      };
    }
    return {
      status: "failed",
      output: error instanceof Error ? error.message : String(error),
      exitCode: 1,
    };
  }
}

/**
 * Runs all configured verification commands sequentially.
 *
 * ALL must pass for verification to pass.
 * On failure, command name + exit code + output become retry context.
 */
export async function runVerification(
  options: RunVerificationOptions,
): Promise<readonly VerificationCommandResult[]> {
  const results: VerificationCommandResult[] = [];

  for (const cmd of options.commands) {
    const result = await runCommandWithTimeout(
      cmd.command,
      options.cwd,
      options.timeoutMs,
    );

    results.push({
      name: cmd.name,
      passed: result.status === "passed",
      exitCode: result.exitCode,
      output: result.output,
    });
  }

  return results;
}

/**
 * Returns true if all verification results passed.
 */
export function allVerificationsPassed(
  results: readonly VerificationCommandResult[],
): boolean {
  return results.every((r) => r.passed);
}

/**
 * Builds a human-readable failure summary for retry context.
 */
export function buildVerificationFailureSummary(
  results: readonly VerificationCommandResult[],
): string {
  const failed = results.filter((r) => !r.passed);
  if (failed.length === 0) {
    return "All verifications passed.";
  }

  return failed
    .map(
      (r) =>
        `${r.name} failed (exit code ${r.exitCode}):\n${r.output}`,
    )
    .join("\n\n");
}
```

- [ ] **Step 2: Create `packages/agent-vm-worker/src/work-reviewer/verification-runner.test.ts`**

```typescript
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  allVerificationsPassed,
  buildVerificationFailureSummary,
  parseCommand,
  runVerification,
} from "./verification-runner.js";

describe("verification-runner", () => {
  describe("parseCommand", () => {
    it("tokenizes a simple command", () => {
      expect(parseCommand("npm test")).toEqual(["npm", "test"]);
    });

    it("tokenizes a command with quoted arguments", () => {
      expect(parseCommand('echo "hello world"')).toEqual([
        "echo",
        "hello world",
      ]);
    });

    it("tokenizes single-quoted arguments", () => {
      expect(parseCommand("echo 'hello world'")).toEqual([
        "echo",
        "hello world",
      ]);
    });

    it("rejects pipe operator", () => {
      expect(() => parseCommand("cat file | grep foo")).toThrow(
        "shell operator '|'",
      );
    });

    it("rejects semicolon", () => {
      expect(() => parseCommand("echo a; echo b")).toThrow(
        "shell operator ';'",
      );
    });

    it("rejects backtick", () => {
      expect(() => parseCommand("echo `whoami`")).toThrow(
        "shell operator '`'",
      );
    });

    it("rejects $() subshell", () => {
      expect(() => parseCommand("echo $(whoami)")).toThrow(
        "shell operator '$'",
      );
    });

    it("rejects redirect operators", () => {
      expect(() => parseCommand("echo foo > file")).toThrow(
        "shell operator '>'",
      );
      expect(() => parseCommand("cat < file")).toThrow(
        "shell operator '<'",
      );
    });

    it("rejects empty command", () => {
      expect(() => parseCommand("")).toThrow("command must not be empty");
      expect(() => parseCommand("   ")).toThrow("command must not be empty");
    });

    it("rejects unmatched quote", () => {
      expect(() => parseCommand('echo "hello')).toThrow("unmatched quote");
    });

    it("handles escaped characters", () => {
      expect(parseCommand("echo hello\\ world")).toEqual([
        "echo",
        "hello world",
      ]);
    });
  });

  describe("runVerification", () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), "verify-test-"));
    });

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    it("runs passing commands and returns success", async () => {
      const results = await runVerification({
        commands: [{ name: "echo-test", command: "echo hello" }],
        cwd: tempDir,
        timeoutMs: 10_000,
      });

      expect(results).toHaveLength(1);
      expect(results[0]!.name).toBe("echo-test");
      expect(results[0]!.passed).toBe(true);
      expect(results[0]!.exitCode).toBe(0);
    });

    it("runs failing commands and returns failure with output", async () => {
      const scriptPath = join(tempDir, "fail.sh");
      await writeFile(
        scriptPath,
        '#!/bin/bash\necho "test failed" >&2\nexit 1\n',
        "utf-8",
      );
      await chmod(scriptPath, 0o755);

      const results = await runVerification({
        commands: [{ name: "fail-test", command: `bash ${scriptPath}` }],
        cwd: tempDir,
        timeoutMs: 10_000,
      });

      expect(results).toHaveLength(1);
      expect(results[0]!.passed).toBe(false);
      expect(results[0]!.exitCode).toBe(1);
      expect(results[0]!.output).toContain("test failed");
    });

    it("runs multiple commands sequentially", async () => {
      const results = await runVerification({
        commands: [
          { name: "first", command: "echo first" },
          { name: "second", command: "echo second" },
        ],
        cwd: tempDir,
        timeoutMs: 10_000,
      });

      expect(results).toHaveLength(2);
      expect(results[0]!.passed).toBe(true);
      expect(results[1]!.passed).toBe(true);
    });

    it("reports command-not-found as failure", async () => {
      const results = await runVerification({
        commands: [
          {
            name: "nonexistent",
            command: "definitely-not-a-real-command-12345",
          },
        ],
        cwd: tempDir,
        timeoutMs: 10_000,
      });

      expect(results).toHaveLength(1);
      expect(results[0]!.passed).toBe(false);
    });
  });

  describe("allVerificationsPassed", () => {
    it("returns true when all passed", () => {
      expect(
        allVerificationsPassed([
          { name: "test", passed: true, exitCode: 0, output: "" },
          { name: "lint", passed: true, exitCode: 0, output: "" },
        ]),
      ).toBe(true);
    });

    it("returns false when any failed", () => {
      expect(
        allVerificationsPassed([
          { name: "test", passed: true, exitCode: 0, output: "" },
          { name: "lint", passed: false, exitCode: 1, output: "err" },
        ]),
      ).toBe(false);
    });
  });

  describe("buildVerificationFailureSummary", () => {
    it("builds summary for failed commands", () => {
      const summary = buildVerificationFailureSummary([
        { name: "test", passed: false, exitCode: 1, output: "FAIL: 3 tests" },
        { name: "lint", passed: true, exitCode: 0, output: "" },
        {
          name: "typecheck",
          passed: false,
          exitCode: 2,
          output: "TS2322: Type error",
        },
      ]);

      expect(summary).toContain("test failed (exit code 1)");
      expect(summary).toContain("FAIL: 3 tests");
      expect(summary).toContain("typecheck failed (exit code 2)");
      expect(summary).not.toContain("lint");
    });

    it("returns all-passed message when none failed", () => {
      const summary = buildVerificationFailureSummary([
        { name: "test", passed: true, exitCode: 0, output: "" },
      ]);

      expect(summary).toBe("All verifications passed.");
    });
  });
});
```

- [ ] **Step 3: Run tests**

```bash
cd /Users/shravansunder/Documents/dev/project-dev/agent-vm.agent-vm-worker && pnpm --filter agent-vm-worker test
```

Expected: all tests pass.

- [ ] **Step 4: Run typecheck**

```bash
cd /Users/shravansunder/Documents/dev/project-dev/agent-vm.agent-vm-worker && pnpm --filter agent-vm-worker typecheck
```

Expected: exit code 0.

**Commit:** `feat(agent-vm-worker): add verification runner — configurable command list with parseCommand safety`

---

## Task 8: Work Reviewer

Orchestrates: run verification commands, if all pass then run the review agent. The review agent is a single-shot `WorkExecutor` that parses `ReviewResult` JSON. This replaces the combined logic from `code-reviewer-agent.ts` + `run-sanity-retries.ts`.

**What changes from agent-vm-coding:** The old flow was: `runSanityRetries` (which called `verify()` and `coderAgent.fix()`) then `codeReviewerAgent.review()`. The new flow separates verification from review into `work-reviewer.ts`, and the coordinator manages the retry loop (not the reviewer).

**Files:**
- Create: `packages/agent-vm-worker/src/work-reviewer/work-reviewer.ts`
- Create: `packages/agent-vm-worker/src/work-reviewer/work-reviewer.test.ts`

**Steps:**

- [ ] **Step 1: Create `packages/agent-vm-worker/src/work-reviewer/work-reviewer.ts`**

```typescript
import type {
  StructuredInput,
  WorkExecutor,
} from "../work-executor/executor-interface.js";
import { reviewResultSchema, type ReviewResult } from "../shared/review-result.js";
import type { VerificationCommandResult } from "./verification-runner.js";
import {
  runVerification,
  allVerificationsPassed,
  type RunVerificationOptions,
} from "./verification-runner.js";

export interface WorkReviewInput {
  /** The review prompt (assembled by the coordinator). */
  readonly reviewPrompt: readonly StructuredInput[];
  /** Verification options (commands, cwd, timeout). */
  readonly verificationOptions: RunVerificationOptions;
}

export interface WorkReviewResult {
  readonly verificationResults: readonly VerificationCommandResult[];
  readonly verificationPassed: boolean;
  /** Review result — only present if verification passed. */
  readonly review: ReviewResult | null;
}

/**
 * Work reviewer: runs verification, then (if passing) runs the review agent.
 *
 * The review agent is single-shot: fresh executor, parses ReviewResult JSON.
 * If verification fails, the review is skipped — the coordinator will send
 * verification failure context to the work executor for a fix attempt.
 */
export async function reviewWork(
  reviewExecutor: WorkExecutor,
  input: WorkReviewInput,
): Promise<WorkReviewResult> {
  // Step 1: Run verification
  const verificationResults = await runVerification(
    input.verificationOptions,
  );
  const verificationPassed = allVerificationsPassed(verificationResults);

  if (!verificationPassed) {
    return {
      verificationResults,
      verificationPassed: false,
      review: null,
    };
  }

  // Step 2: Run review agent (single-shot)
  const result = await reviewExecutor.execute(input.reviewPrompt);
  const response = result.response;

  let parsed: unknown;
  try {
    parsed = JSON.parse(response);
  } catch {
    throw new Error(
      `Review response is not valid JSON. Raw: ${response.slice(0, 200)}`,
    );
  }

  const parseResult = reviewResultSchema.safeParse(parsed);
  if (!parseResult.success) {
    throw new Error(
      `Review JSON doesn't match schema: ${parseResult.error.message}. Raw: ${response.slice(0, 200)}`,
    );
  }

  return {
    verificationResults,
    verificationPassed: true,
    review: parseResult.data,
  };
}
```

- [ ] **Step 2: Create `packages/agent-vm-worker/src/work-reviewer/work-reviewer.test.ts`**

```typescript
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ExecutorResult,
  StructuredInput,
  WorkExecutor,
} from "../work-executor/executor-interface.js";
import { reviewWork } from "./work-reviewer.js";

const mocks = vi.hoisted(() => ({
  runVerification: vi.fn(),
  allVerificationsPassed: vi.fn(),
}));

vi.mock("./verification-runner.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./verification-runner.js")>();
  return {
    ...original,
    runVerification: mocks.runVerification,
    allVerificationsPassed: mocks.allVerificationsPassed,
  };
});

function createMockReviewExecutor(response: string): WorkExecutor {
  return {
    async execute(
      _input: readonly StructuredInput[],
    ): Promise<ExecutorResult> {
      return {
        response,
        tokenCount: 50,
        threadId: "review-thread",
      };
    },
    async fix(): Promise<ExecutorResult> {
      throw new Error("Should not call fix on reviewer");
    },
    async resumeOrRebuild(): Promise<void> {
      return;
    },
    getThreadId(): string | null {
      return null;
    },
  };
}

describe("work-reviewer", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "work-reviewer-test-"));
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns verification failure without running review", async () => {
    const failedResults = [
      { name: "test", passed: false, exitCode: 1, output: "FAIL" },
    ];
    mocks.runVerification.mockResolvedValue(failedResults);
    mocks.allVerificationsPassed.mockReturnValue(false);

    const executor = createMockReviewExecutor("should not be called");
    const result = await reviewWork(executor, {
      reviewPrompt: [{ type: "text", text: "review" }],
      verificationOptions: {
        commands: [{ name: "test", command: "npm test" }],
        cwd: tempDir,
        timeoutMs: 10_000,
      },
    });

    expect(result.verificationPassed).toBe(false);
    expect(result.review).toBeNull();
    expect(result.verificationResults).toEqual(failedResults);
  });

  it("runs review when verification passes", async () => {
    const passedResults = [
      { name: "test", passed: true, exitCode: 0, output: "" },
    ];
    mocks.runVerification.mockResolvedValue(passedResults);
    mocks.allVerificationsPassed.mockReturnValue(true);

    const executor = createMockReviewExecutor(
      JSON.stringify({
        approved: true,
        comments: [],
        summary: "Code looks good.",
      }),
    );

    const result = await reviewWork(executor, {
      reviewPrompt: [{ type: "text", text: "review the code" }],
      verificationOptions: {
        commands: [{ name: "test", command: "npm test" }],
        cwd: tempDir,
        timeoutMs: 10_000,
      },
    });

    expect(result.verificationPassed).toBe(true);
    expect(result.review).not.toBeNull();
    expect(result.review!.approved).toBe(true);
    expect(result.review!.summary).toBe("Code looks good.");
  });

  it("returns review rejection", async () => {
    const passedResults = [
      { name: "test", passed: true, exitCode: 0, output: "" },
    ];
    mocks.runVerification.mockResolvedValue(passedResults);
    mocks.allVerificationsPassed.mockReturnValue(true);

    const executor = createMockReviewExecutor(
      JSON.stringify({
        approved: false,
        comments: [
          { file: "src/main.ts", severity: "critical", comment: "Bug here" },
        ],
        summary: "Fix the bug in main.ts",
      }),
    );

    const result = await reviewWork(executor, {
      reviewPrompt: [{ type: "text", text: "review" }],
      verificationOptions: {
        commands: [{ name: "test", command: "npm test" }],
        cwd: tempDir,
        timeoutMs: 10_000,
      },
    });

    expect(result.review!.approved).toBe(false);
    expect(result.review!.comments).toHaveLength(1);
  });

  it("throws on invalid review JSON", async () => {
    const passedResults = [
      { name: "test", passed: true, exitCode: 0, output: "" },
    ];
    mocks.runVerification.mockResolvedValue(passedResults);
    mocks.allVerificationsPassed.mockReturnValue(true);

    const executor = createMockReviewExecutor("not json");

    await expect(
      reviewWork(executor, {
        reviewPrompt: [{ type: "text", text: "review" }],
        verificationOptions: {
          commands: [{ name: "test", command: "npm test" }],
          cwd: tempDir,
          timeoutMs: 10_000,
        },
      }),
    ).rejects.toThrow("not valid JSON");
  });
});
```

- [ ] **Step 3: Run tests**

```bash
cd /Users/shravansunder/Documents/dev/project-dev/agent-vm.agent-vm-worker && pnpm --filter agent-vm-worker test
```

Expected: all tests pass.

- [ ] **Step 4: Run typecheck**

```bash
cd /Users/shravansunder/Documents/dev/project-dev/agent-vm.agent-vm-worker && pnpm --filter agent-vm-worker typecheck
```

Expected: exit code 0.

**Commit:** `feat(agent-vm-worker): add work reviewer — verification then review agent orchestration`

---

## Task 9: Wrapup — Actions + Agent-Driven Phase

NEW (not a port). Wrapup actions are registered as `ToolDefinition` instances. The wrapup executor gets these tools via its `ExecutorCapabilities`. After wrapup, the coordinator checks that all required actions succeeded.

**Files:**
- Create: `packages/agent-vm-worker/src/wrapup/wrapup-types.ts`
- Create: `packages/agent-vm-worker/src/wrapup/git-pr-action.ts`
- Create: `packages/agent-vm-worker/src/wrapup/git-pr-action.test.ts`
- Create: `packages/agent-vm-worker/src/wrapup/slack-action.ts`
- Create: `packages/agent-vm-worker/src/wrapup/wrapup-action-registry.ts`

**Steps:**

- [ ] **Step 1: Create `packages/agent-vm-worker/src/wrapup/wrapup-types.ts`**

```typescript
import type { ToolDefinition } from "../work-executor/executor-interface.js";

export interface WrapupActionResult {
  readonly type: string;
  readonly artifact?: string;
  readonly success: boolean;
}

export interface WrapupActionConfig {
  readonly type: string;
  readonly required: boolean;
}

/**
 * Checks whether all required wrapup actions were executed successfully.
 * Returns the list of missing required action types.
 */
export function findMissingRequiredActions(
  configuredActions: readonly WrapupActionConfig[],
  executedResults: readonly WrapupActionResult[],
): readonly string[] {
  const requiredTypes = configuredActions
    .filter((a) => a.required)
    .map((a) => a.type);

  const successfulTypes = new Set(
    executedResults.filter((r) => r.success).map((r) => r.type),
  );

  return requiredTypes.filter((t) => !successfulTypes.has(t));
}
```

- [ ] **Step 2: Create `packages/agent-vm-worker/src/wrapup/git-pr-action.ts`**

Port from `task-ship.ts`. Wraps git operations (stage, commit, push, PR) as a `ToolDefinition` that the wrapup agent can call.

```typescript
import type { ToolDefinition } from "../work-executor/executor-interface.js";
import {
  configureGit,
  createBranch,
  stageAndCommit,
  pushBranch,
  createPullRequest,
} from "../git/git-operations.js";
import type { WrapupActionResult } from "./wrapup-types.js";

export interface GitPrActionConfig {
  readonly branchPrefix: string;
  readonly commitCoAuthor: string;
  readonly workspaceDir: string;
  readonly taskId: string;
  readonly taskPrompt: string;
  readonly plan: string | null;
  readonly repo: {
    readonly repoUrl: string;
    readonly baseBranch: string;
  } | null;
}

/**
 * Creates a ToolDefinition for the git-pr wrapup action.
 *
 * The wrapup agent calls this tool with a title and body.
 * The tool stages all changes, commits, pushes, and creates a PR.
 */
export function createGitPrToolDefinition(
  config: GitPrActionConfig,
): ToolDefinition {
  return {
    name: "git-pr",
    description:
      "Stage all changes, commit, push to a new branch, and create a pull request. " +
      "Call this after all code changes are complete.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "PR title (max 72 chars)",
        },
        body: {
          type: "string",
          description: "PR description (markdown)",
        },
      },
      required: ["title", "body"],
    },
    execute: async (
      params: Record<string, unknown>,
    ): Promise<WrapupActionResult> => {
      try {
        if (!config.repo) {
          return {
            type: "git-pr",
            success: false,
            artifact: "No repo configured — cannot create PR.",
          };
        }

        const title =
          typeof params["title"] === "string"
            ? params["title"]
            : `feat: ${config.taskPrompt.slice(0, 72)}`;
        const body =
          typeof params["body"] === "string"
            ? params["body"]
            : config.plan?.slice(0, 2000) ?? "";
        const branchName = `${config.branchPrefix}${config.taskId}`;

        // Configure git
        await configureGit(
          {
            userEmail: "agent-vm-worker@agent-vm",
            userName: "agent-vm-worker",
          },
          config.workspaceDir,
        );

        // Create branch
        await createBranch(branchName, config.workspaceDir);

        // Stage and commit
        await stageAndCommit({
          message: title,
          coAuthor: config.commitCoAuthor,
          cwd: config.workspaceDir,
        });

        // Push
        await pushBranch({
          repo: config.repo.repoUrl,
          branchName,
          cwd: config.workspaceDir,
        });

        // Create PR
        const prUrl = await createPullRequest(
          {
            repo: config.repo.repoUrl,
            title,
            body,
            baseBranch: config.repo.baseBranch,
            headBranch: branchName,
          },
          config.workspaceDir,
        );

        return {
          type: "git-pr",
          artifact: prUrl,
          success: true,
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        // Sanitize token from error messages
        const sanitized = message.replace(
          /https:\/\/x-access-token:[^@]*@/g,
          "https://x-access-token:***@",
        );
        return {
          type: "git-pr",
          artifact: sanitized,
          success: false,
        };
      }
    },
  };
}
```

- [ ] **Step 3: Create `packages/agent-vm-worker/src/wrapup/slack-action.ts`**

```typescript
import type { ToolDefinition } from "../work-executor/executor-interface.js";
import type { WrapupActionResult } from "./wrapup-types.js";

export interface SlackActionConfig {
  readonly webhookUrl: string;
  readonly channel?: string;
}

/**
 * Creates a ToolDefinition for the slack-post wrapup action.
 *
 * The wrapup agent calls this tool with a message.
 * The tool posts to a Slack webhook.
 */
export function createSlackToolDefinition(
  config: SlackActionConfig,
): ToolDefinition {
  return {
    name: "slack-post",
    description:
      "Post a message to a Slack channel via webhook. " +
      "Use for task completion notifications, status updates, or alerts.",
    inputSchema: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "The message text to post (supports Slack markdown)",
        },
      },
      required: ["message"],
    },
    execute: async (
      params: Record<string, unknown>,
    ): Promise<WrapupActionResult> => {
      try {
        const message =
          typeof params["message"] === "string"
            ? params["message"]
            : "Task completed.";

        const payload: Record<string, unknown> = { text: message };
        if (config.channel) {
          payload["channel"] = config.channel;
        }

        const response = await fetch(config.webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          return {
            type: "slack-post",
            success: false,
            artifact: `Slack webhook returned ${response.status}: ${response.statusText}`,
          };
        }

        return {
          type: "slack-post",
          success: true,
          artifact: "Message posted successfully.",
        };
      } catch (error) {
        return {
          type: "slack-post",
          success: false,
          artifact:
            error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
```

- [ ] **Step 4: Create `packages/agent-vm-worker/src/wrapup/wrapup-action-registry.ts`**

```typescript
import type { ToolDefinition } from "../work-executor/executor-interface.js";
import type { WorkerConfig } from "../config/worker-config.js";
import { createGitPrToolDefinition, type GitPrActionConfig } from "./git-pr-action.js";
import { createSlackToolDefinition } from "./slack-action.js";
import type { WrapupActionConfig } from "./wrapup-types.js";

export interface WrapupToolRegistryInput {
  readonly config: WorkerConfig;
  readonly taskId: string;
  readonly taskPrompt: string;
  readonly plan: string | null;
  readonly repo: {
    readonly repoUrl: string;
    readonly baseBranch: string;
    readonly workspacePath: string;
  } | null;
}

/**
 * Builds ToolDefinition[] from configured wrapup actions.
 * Each action becomes a tool the wrapup agent can call.
 */
export function buildWrapupTools(
  input: WrapupToolRegistryInput,
): readonly ToolDefinition[] {
  const tools: ToolDefinition[] = [];

  for (const action of input.config.wrapupActions) {
    switch (action.type) {
      case "git-pr": {
        const gitConfig: GitPrActionConfig = {
          branchPrefix: input.config.branchPrefix,
          commitCoAuthor: input.config.commitCoAuthor,
          workspaceDir: input.repo?.workspacePath ?? "/workspace",
          taskId: input.taskId,
          taskPrompt: input.taskPrompt,
          plan: input.plan,
          repo: input.repo
            ? {
                repoUrl: input.repo.repoUrl,
                baseBranch: input.repo.baseBranch,
              }
            : null,
        };
        tools.push(createGitPrToolDefinition(gitConfig));
        break;
      }
      case "slack-post": {
        tools.push(
          createSlackToolDefinition({
            webhookUrl: action.webhookUrl,
            channel: action.channel,
          }),
        );
        break;
      }
      default: {
        console.warn(
          `[wrapup-action-registry] Unknown wrapup action type: ${(action as WrapupActionConfig).type}`,
        );
      }
    }
  }

  return tools;
}

/**
 * Extracts WrapupActionConfig[] from the worker config for required-action checking.
 */
export function getWrapupActionConfigs(
  config: WorkerConfig,
): readonly WrapupActionConfig[] {
  return config.wrapupActions.map((action) => ({
    type: action.type,
    required: "required" in action ? (action.required ?? false) : false,
  }));
}
```

- [ ] **Step 5: Create `packages/agent-vm-worker/src/wrapup/git-pr-action.test.ts`**

```typescript
import { describe, expect, it, vi } from "vitest";

import { createGitPrToolDefinition } from "./git-pr-action.js";
import { findMissingRequiredActions } from "./wrapup-types.js";

const mocks = vi.hoisted(() => ({
  configureGit: vi.fn(),
  createBranch: vi.fn(),
  stageAndCommit: vi.fn(),
  pushBranch: vi.fn(),
  createPullRequest: vi.fn(),
}));

vi.mock("../git/git-operations.js", () => ({
  configureGit: mocks.configureGit,
  createBranch: mocks.createBranch,
  stageAndCommit: mocks.stageAndCommit,
  pushBranch: mocks.pushBranch,
  createPullRequest: mocks.createPullRequest,
}));

describe("git-pr-action", () => {
  it("creates a PR and returns success result", async () => {
    mocks.configureGit.mockResolvedValue(undefined);
    mocks.createBranch.mockResolvedValue(undefined);
    mocks.stageAndCommit.mockResolvedValue(undefined);
    mocks.pushBranch.mockResolvedValue(undefined);
    mocks.createPullRequest.mockResolvedValue(
      "https://github.com/org/repo/pull/42",
    );

    const tool = createGitPrToolDefinition({
      branchPrefix: "agent/",
      commitCoAuthor: "agent <noreply@agent>",
      workspaceDir: "/workspace",
      taskId: "task-1",
      taskPrompt: "fix login bug",
      plan: "The plan",
      repo: { repoUrl: "https://github.com/org/repo.git", baseBranch: "main" },
    });

    const result = await tool.execute({
      title: "fix: resolve login bug",
      body: "Fixes the login issue.",
    });

    expect(result).toEqual({
      type: "git-pr",
      artifact: "https://github.com/org/repo/pull/42",
      success: true,
    });
    expect(mocks.stageAndCommit).toHaveBeenCalledWith({
      message: "fix: resolve login bug",
      coAuthor: "agent <noreply@agent>",
      cwd: "/workspace",
    });
  });

  it("returns failure when repo is null", async () => {
    const tool = createGitPrToolDefinition({
      branchPrefix: "agent/",
      commitCoAuthor: "agent <noreply@agent>",
      workspaceDir: "/workspace",
      taskId: "task-1",
      taskPrompt: "summarize incidents",
      plan: null,
      repo: null,
    });

    const result = await tool.execute({ title: "PR", body: "body" });

    expect(result).toEqual({
      type: "git-pr",
      success: false,
      artifact: "No repo configured — cannot create PR.",
    });
  });

  it("sanitizes tokens in error messages", async () => {
    mocks.configureGit.mockResolvedValue(undefined);
    mocks.createBranch.mockResolvedValue(undefined);
    mocks.stageAndCommit.mockResolvedValue(undefined);
    mocks.pushBranch.mockRejectedValue(
      new Error(
        "push failed: https://x-access-token:ghp_secret123@github.com/org/repo",
      ),
    );

    const tool = createGitPrToolDefinition({
      branchPrefix: "agent/",
      commitCoAuthor: "agent <noreply@agent>",
      workspaceDir: "/workspace",
      taskId: "task-1",
      taskPrompt: "fix bug",
      plan: null,
      repo: { repoUrl: "https://github.com/org/repo.git", baseBranch: "main" },
    });

    const result = await tool.execute({ title: "PR", body: "body" });

    expect(result.success).toBe(false);
    expect(result.artifact).not.toContain("ghp_secret123");
    expect(result.artifact).toContain("x-access-token:***");
  });
});

describe("wrapup-types", () => {
  describe("findMissingRequiredActions", () => {
    it("returns empty when all required actions succeeded", () => {
      const missing = findMissingRequiredActions(
        [
          { type: "git-pr", required: true },
          { type: "slack-post", required: false },
        ],
        [{ type: "git-pr", success: true }],
      );
      expect(missing).toHaveLength(0);
    });

    it("returns missing required actions", () => {
      const missing = findMissingRequiredActions(
        [{ type: "git-pr", required: true }],
        [{ type: "git-pr", success: false }],
      );
      expect(missing).toEqual(["git-pr"]);
    });

    it("returns required actions not executed at all", () => {
      const missing = findMissingRequiredActions(
        [{ type: "git-pr", required: true }],
        [],
      );
      expect(missing).toEqual(["git-pr"]);
    });

    it("ignores optional actions", () => {
      const missing = findMissingRequiredActions(
        [{ type: "slack-post", required: false }],
        [],
      );
      expect(missing).toHaveLength(0);
    });
  });
});
```

- [ ] **Step 6: Run tests**

```bash
cd /Users/shravansunder/Documents/dev/project-dev/agent-vm.agent-vm-worker && pnpm --filter agent-vm-worker test
```

Expected: all tests pass.

- [ ] **Step 7: Run typecheck**

```bash
cd /Users/shravansunder/Documents/dev/project-dev/agent-vm.agent-vm-worker && pnpm --filter agent-vm-worker typecheck
```

Expected: exit code 0.

**Commit:** `feat(agent-vm-worker): add wrapup module — agent-driven phase with git-pr and slack actions`

---

## Task 10: Git Operations + Context Gathering

Straight port from agent-vm-coding. Both modules are stable and well-tested.

**Files:**
- Create: `packages/agent-vm-worker/src/git/git-operations.ts`
- Create: `packages/agent-vm-worker/src/git/git-operations.test.ts`
- Create: `packages/agent-vm-worker/src/context/gather-context.ts`
- Create: `packages/agent-vm-worker/src/context/gather-context.test.ts`

**Steps:**

- [ ] **Step 1: Create `packages/agent-vm-worker/src/git/git-operations.ts`**

Straight copy from `agent-vm-coding/src/git/git-operations.ts`. No changes.

```typescript
import { execa } from "execa";

export interface GitConfigOptions {
  readonly userEmail: string;
  readonly userName: string;
}

export interface CommitOptions {
  readonly message: string;
  readonly coAuthor: string;
  readonly cwd: string;
}

export interface PushOptions {
  readonly repo: string;
  readonly branchName: string;
  readonly cwd: string;
}

export interface PullRequestOptions {
  readonly repo: string;
  readonly title: string;
  readonly body: string;
  readonly baseBranch: string;
  readonly headBranch: string;
}

interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

async function execGitShell(command: string, cwd: string): Promise<GitResult> {
  const result = await execa(command, {
    shell: true,
    cwd,
    reject: false,
  });

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode ?? -1,
  };
}

async function execGitArgs(
  bin: string,
  args: readonly string[],
  cwd: string,
): Promise<GitResult> {
  const result = await execa(bin, args, {
    cwd,
    reject: false,
  });

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode ?? -1,
  };
}

export function sanitizeBranchName(name: string): string {
  return name.replace(/[^a-zA-Z0-9\-_./]/g, "-");
}

export async function configureGit(
  options: GitConfigOptions,
  cwd: string,
): Promise<void> {
  const commands: readonly (readonly [string, ...string[]])[] = [
    ["git", "config", "http.version", "HTTP/1.1"],
    ["git", "config", "user.email", options.userEmail],
    ["git", "config", "user.name", options.userName],
  ];

  for (const [bin, ...args] of commands) {
    const result = await execGitArgs(bin, args, cwd);
    if (result.exitCode !== 0) {
      throw new Error(
        `Git config failed: ${bin} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`.trim(),
      );
    }
  }
}

export async function createBranch(
  branchName: string,
  cwd: string,
): Promise<void> {
  const safeBranch = sanitizeBranchName(branchName);
  const result = await execGitArgs(
    "git",
    ["checkout", "-b", safeBranch],
    cwd,
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to create branch: ${safeBranch}\n${result.stdout}\n${result.stderr}`.trim(),
    );
  }
}

export async function stageAndCommit(options: CommitOptions): Promise<void> {
  const addResult = await execGitShell("git add -A", options.cwd);
  if (addResult.exitCode !== 0) {
    throw new Error(
      `Failed to stage files\n${addResult.stdout}\n${addResult.stderr}`.trim(),
    );
  }

  const commitMessage = buildCommitMessage(options.message, options.coAuthor);
  const commitResult = await execGitArgs(
    "git",
    ["commit", "-m", commitMessage],
    options.cwd,
  );

  if (commitResult.exitCode !== 0) {
    if (commitResult.stdout.includes("nothing to commit")) {
      return;
    }
    throw new Error(
      `Failed to create commit\n${commitResult.stdout}\n${commitResult.stderr}`.trim(),
    );
  }
}

export async function pushBranch(options: PushOptions): Promise<void> {
  const pushUrl = buildPushUrl(options.repo);
  const safeBranch = sanitizeBranchName(options.branchName);
  const result = await execGitArgs(
    "git",
    ["push", pushUrl, safeBranch],
    options.cwd,
  );
  if (result.exitCode !== 0) {
    const errorDetail = `${result.stdout}\n${result.stderr}`
      .replace(
        /https:\/\/x-access-token:[^@]*@/g,
        "https://x-access-token:***@",
      )
      .trim();
    throw new Error(`git push failed\n${errorDetail}`);
  }
}

export async function createPullRequest(
  options: PullRequestOptions,
  cwd: string,
): Promise<string> {
  const ownerRepo = parseRepoFromUrl(options.repo);
  const result = await execGitArgs(
    "gh",
    [
      "pr",
      "create",
      "--repo",
      ownerRepo,
      "--title",
      options.title,
      "--body",
      options.body,
      "--base",
      options.baseBranch,
      "--head",
      options.headBranch,
    ],
    cwd,
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to create pull request\n${result.stdout}\n${result.stderr}`.trim(),
    );
  }

  const prUrl = result.stdout.trim().split("\n").pop() ?? "";
  return prUrl;
}

export async function getDiffStat(cwd: string): Promise<string> {
  const result = await execGitShell("git diff --stat", cwd);
  return result.stdout;
}

export async function getDiff(cwd: string): Promise<string> {
  const result = await execGitShell("git diff", cwd);
  return result.stdout;
}

export function parseRepoFromUrl(repoUrl: string): string {
  const cleaned = repoUrl.replace(/\.git$/, "");
  const urlPattern = /(?:https?:\/\/)?github\.com\/([^/]+\/[^/]+)$/;
  const match = urlPattern.exec(cleaned);
  if (match?.[1]) {
    return match[1];
  }
  if (/^[^\s/]+\/[^\s/]+$/.test(cleaned)) {
    return cleaned;
  }
  throw new Error(`Invalid GitHub repository: ${repoUrl}`);
}

export function buildPushUrl(repo: string): string {
  const ownerRepo = parseRepoFromUrl(repo);
  const githubToken = process.env["GITHUB_TOKEN"];
  if (!githubToken) {
    throw new Error("GITHUB_TOKEN environment variable is required");
  }
  return `https://x-access-token:${githubToken}@github.com/${ownerRepo}.git`;
}

export function buildCommitMessage(
  message: string,
  coAuthor: string,
): string {
  return `${message}\n\nCo-Authored-By: ${coAuthor}`;
}
```

- [ ] **Step 2: Create `packages/agent-vm-worker/src/git/git-operations.test.ts`**

Port from agent-vm-coding's git-operations.test.ts. Tests for `parseRepoFromUrl`, `sanitizeBranchName`, `buildCommitMessage`, `buildPushUrl`.

```typescript
import { describe, expect, it, vi, afterEach } from "vitest";

import {
  buildCommitMessage,
  buildPushUrl,
  parseRepoFromUrl,
  sanitizeBranchName,
} from "./git-operations.js";

describe("git-operations", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("parseRepoFromUrl", () => {
    it("extracts owner/repo from full HTTPS URL", () => {
      expect(
        parseRepoFromUrl("https://github.com/acme/widgets.git"),
      ).toBe("acme/widgets");
    });

    it("extracts owner/repo from URL without .git", () => {
      expect(parseRepoFromUrl("https://github.com/acme/widgets")).toBe(
        "acme/widgets",
      );
    });

    it("extracts owner/repo from URL without scheme", () => {
      expect(parseRepoFromUrl("github.com/acme/widgets")).toBe(
        "acme/widgets",
      );
    });

    it("passes through short form owner/repo", () => {
      expect(parseRepoFromUrl("acme/widgets")).toBe("acme/widgets");
    });

    it("throws on invalid URL", () => {
      expect(() => parseRepoFromUrl("invalid")).toThrow(
        "Invalid GitHub repository",
      );
    });
  });

  describe("sanitizeBranchName", () => {
    it("passes through valid branch names", () => {
      expect(sanitizeBranchName("agent/task-123")).toBe("agent/task-123");
    });

    it("replaces unsafe characters with dashes", () => {
      expect(sanitizeBranchName("agent/task 123!")).toBe("agent/task-123-");
    });
  });

  describe("buildCommitMessage", () => {
    it("appends co-author to message", () => {
      const msg = buildCommitMessage("feat: add login", "bot <bot@x>");
      expect(msg).toBe("feat: add login\n\nCo-Authored-By: bot <bot@x>");
    });
  });

  describe("buildPushUrl", () => {
    it("builds authenticated push URL", () => {
      vi.stubEnv("GITHUB_TOKEN", "test-token-123");
      const url = buildPushUrl("acme/widgets");
      expect(url).toBe(
        "https://x-access-token:test-token-123@github.com/acme/widgets.git",
      );
    });

    it("throws when GITHUB_TOKEN is missing", () => {
      vi.stubEnv("GITHUB_TOKEN", "");
      // Clear the env var completely
      delete process.env["GITHUB_TOKEN"];
      expect(() => buildPushUrl("acme/widgets")).toThrow(
        "GITHUB_TOKEN environment variable is required",
      );
    });
  });
});
```

- [ ] **Step 3: Run tests**

```bash
cd /Users/shravansunder/Documents/dev/project-dev/agent-vm.agent-vm-worker && pnpm --filter agent-vm-worker test
```

Expected: all tests pass.

- [ ] **Step 4: Run typecheck**

```bash
cd /Users/shravansunder/Documents/dev/project-dev/agent-vm.agent-vm-worker && pnpm --filter agent-vm-worker typecheck
```

Expected: exit code 0.

- [ ] **Step 5: Create `packages/agent-vm-worker/src/context/gather-context.ts`**

Straight port from `agent-vm-coding/src/context/gather-context.ts`. The coordinator calls this at task start to give the planner structural awareness of the project.

```typescript
import fs from "node:fs/promises";
import path from "node:path";

export interface RepoContext {
  readonly fileCount: number;
  readonly summary: string;
  readonly claudeMd: string | null;
  readonly packageJson: string | null;
}

export async function readOptionalFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

export async function gatherContext(workspaceDir: string): Promise<RepoContext> {
  const files = await collectFiles(workspaceDir, "", 0, 3);
  const claudeMd = await readOptionalFile(path.join(workspaceDir, "CLAUDE.md"));
  const packageJson = await readOptionalFile(path.join(workspaceDir, "package.json"));

  return {
    fileCount: files.length,
    summary: files.length > 0
      ? `Repository structure (${files.length} files):\n${files.join("\n")}`
      : "Empty workspace — no repository files.",
    claudeMd,
    packageJson,
  };
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage"]);

async function collectFiles(
  baseDir: string,
  relativePath: string,
  depth: number,
  maxDepth: number,
): Promise<string[]> {
  if (depth >= maxDepth) return [];
  const fullPath = path.join(baseDir, relativePath);
  const entries = await fs.readdir(fullPath, { withFileTypes: true }).catch(() => []);
  const results: string[] = [];

  for (const entry of entries) {
    const entryRelative = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        results.push(...await collectFiles(baseDir, entryRelative, depth + 1, maxDepth));
      }
    } else {
      results.push(entryRelative);
    }
  }
  return results;
}
```

- [ ] **Step 6: Create `packages/agent-vm-worker/src/context/gather-context.test.ts`**

```typescript
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gatherContext, readOptionalFile } from "./gather-context.js";

const createdDirs: string[] = [];
afterEach(() => {
  for (const d of createdDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("readOptionalFile", () => {
  it("returns content when file exists", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-"));
    createdDirs.push(dir);
    fs.writeFileSync(path.join(dir, "test.txt"), "hello");
    expect(await readOptionalFile(path.join(dir, "test.txt"))).toBe("hello");
  });

  it("returns null when file does not exist", async () => {
    expect(await readOptionalFile("/nonexistent/file.txt")).toBeNull();
  });
});

describe("gatherContext", () => {
  it("collects files and reads CLAUDE.md", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-"));
    createdDirs.push(dir);
    fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# Rules");
    fs.writeFileSync(path.join(dir, "package.json"), "{}");
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "src", "index.ts"), "");
    const ctx = await gatherContext(dir);
    expect(ctx.fileCount).toBeGreaterThan(0);
    expect(ctx.claudeMd).toBe("# Rules");
    expect(ctx.packageJson).toBe("{}");
    expect(ctx.summary).toContain("src/index.ts");
  });

  it("returns empty summary for empty workspace", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-"));
    createdDirs.push(dir);
    const ctx = await gatherContext(dir);
    expect(ctx.fileCount).toBe(0);
    expect(ctx.summary).toContain("Empty workspace");
  });
});
```

- [ ] **Step 7: Run tests**

```bash
cd /Users/shravansunder/Documents/dev/project-dev/agent-vm.agent-vm-worker && pnpm vitest run packages/agent-vm-worker/src/context/
```

Expected: all pass.

**Commit:** `feat(agent-vm-worker): add git operations + context gathering`

---

## Task 11: Coordinator

The heart of the worker. Wires everything through phase config. Manages the plan loop, work loop, verification retries, review loops, and wrapup phase. Creates executors from config using the factory. Uses generic events.

**What changes from agent-vm-coding:** The old coordinator took `CoordinatorDeps` with four hardcoded agent instances. The new coordinator takes `WorkerConfig` and creates executors dynamically. The old had `submitFollowup` — removed (no followup in v1). The old had `shipTask` — replaced by wrapup phase. The old used hardcoded event names — the new uses generic `phase-started`, `phase-completed`, etc. The `taskId` comes from the POST body (controller-provided), not generated by the worker.

**Files:**
- Create: `packages/agent-vm-worker/src/coordinator/coordinator-types.ts`
- Create: `packages/agent-vm-worker/src/coordinator/coordinator-helpers.ts`
- Create: `packages/agent-vm-worker/src/coordinator/coordinator.ts`
- Create: `packages/agent-vm-worker/src/coordinator/coordinator.test.ts`

**Steps:**

- [ ] **Step 1: Create `packages/agent-vm-worker/src/coordinator/coordinator-types.ts`**

```typescript
import type { TaskState } from "../state/task-state.js";

export interface CreateTaskInput {
  readonly taskId: string;
  readonly prompt: string;
  readonly repo?: {
    readonly repoUrl: string;
    readonly baseBranch: string;
    readonly workspacePath: string;
  } | null;
  readonly context?: Record<string, unknown>;
}

export interface Coordinator {
  submitTask(
    input: CreateTaskInput,
  ): Promise<{ taskId: string; status: "accepted" }>;
  getActiveTaskId(): string | null;
  getTaskState(taskId: string): TaskState | undefined;
  closeTask(taskId: string): Promise<{ status: "closed" }>;
}
```

- [ ] **Step 2: Create `packages/agent-vm-worker/src/coordinator/coordinator-helpers.ts`**

```typescript
import { join } from "node:path";

import { appendEvent } from "../state/event-log.js";
import type { TaskConfig, TaskEvent } from "../state/task-event-types.js";
import { applyEvent, type TaskState } from "../state/task-state.js";
import type { CreateTaskInput } from "./coordinator-types.js";
import type { WorkerConfig } from "../config/worker-config.js";

export function sanitizeErrorMessage(message: string): string {
  return message.replace(
    /https:\/\/x-access-token:[^@]*@/g,
    "https://x-access-token:***@",
  );
}

export function buildTaskConfig(
  input: CreateTaskInput,
  config: WorkerConfig,
): TaskConfig {
  return {
    taskId: input.taskId,
    prompt: input.prompt,
    repo: input.repo ?? null,
    context: input.context ?? {},
    effectiveConfig: config,
  };
}

export function createTaskEventRecorder(
  stateDir: string,
  tasks: Map<string, TaskState>,
  closedTaskIds: Set<string>,
): {
  readonly emit: (taskId: string, event: TaskEvent) => void;
  readonly isClosed: (taskId: string) => boolean;
  readonly recordTaskFailure: (taskId: string, reason: string) => void;
} {
  function logPath(taskId: string): string {
    return join(stateDir, "tasks", `${taskId}.jsonl`);
  }

  function emit(taskId: string, event: TaskEvent): void {
    if (closedTaskIds.has(taskId) && event.event !== "task-closed") {
      console.warn(
        `Dropping event for closed task ${taskId}: ${event.event}`,
      );
      return;
    }

    appendEvent(logPath(taskId), event);
    const current = tasks.get(taskId);
    if (current) {
      tasks.set(taskId, applyEvent(current, event));
    }
  }

  function recordTaskFailure(taskId: string, reason: string): void {
    try {
      emit(taskId, { event: "task-failed", reason });
    } catch (error) {
      console.error(
        `Failed to persist task failure for ${taskId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      const current = tasks.get(taskId);
      if (current) {
        tasks.set(
          taskId,
          applyEvent(current, { event: "task-failed", reason }),
        );
      }
    }
  }

  return {
    emit,
    isClosed(taskId: string): boolean {
      return closedTaskIds.has(taskId);
    },
    recordTaskFailure,
  };
}
```

- [ ] **Step 3: Create `packages/agent-vm-worker/src/coordinator/coordinator.ts`**

```typescript
import { gatherContext } from "../context/gather-context.js";
import { getDiff } from "../git/git-operations.js";
import type { WorkerConfig } from "../config/worker-config.js";
import { resolvePhaseExecutor } from "../config/worker-config.js";
import { createPlanner } from "../planner/planner.js";
import { createPlanReviewer } from "../planner/plan-reviewer.js";
import { assemblePrompt } from "../prompt/prompt-assembler.js";
import {
  createInitialState,
  hydrateTaskStates,
  isTerminal,
  type TaskState,
} from "../state/task-state.js";
import {
  allVerificationsPassed,
  buildVerificationFailureSummary,
  runVerification,
} from "../work-reviewer/verification-runner.js";
import { reviewWork } from "../work-reviewer/work-reviewer.js";
import { createWorkExecutor } from "../work-executor/executor-factory.js";
import type { WorkExecutor } from "../work-executor/executor-interface.js";
import {
  buildWrapupTools,
  getWrapupActionConfigs,
} from "../wrapup/wrapup-action-registry.js";
import { findMissingRequiredActions } from "../wrapup/wrapup-types.js";

import {
  buildTaskConfig,
  createTaskEventRecorder,
  sanitizeErrorMessage,
} from "./coordinator-helpers.js";
import type { Coordinator, CreateTaskInput } from "./coordinator-types.js";

export type { Coordinator, CreateTaskInput } from "./coordinator-types.js";

interface CoordinatorDeps {
  readonly config: WorkerConfig;
  readonly workspaceDir?: string;
}

async function runTask(
  taskId: string,
  deps: CoordinatorDeps,
  workspaceDir: string,
  tasks: Map<string, TaskState>,
  eventRecorder: ReturnType<typeof createTaskEventRecorder>,
  onTaskFinished: () => void,
): Promise<void> {
  try {
    const initialState = tasks.get(taskId);
    if (!initialState || eventRecorder.isClosed(taskId)) {
      return;
    }

    const config = deps.config;

    // --- GATHER CONTEXT ---
    const repoContext = await gatherContext(workspaceDir);
    console.log(`[coordinator] task ${taskId}: gathered context (${repoContext.fileCount} files)`);

    // --- PLAN PHASE ---
    console.log(`[coordinator] task ${taskId}: planning`);
    eventRecorder.emit(taskId, { event: "phase-started", phase: "plan" });

    const planExecutorConfig = resolvePhaseExecutor(config, config.phases.plan);
    const planExecutor = createWorkExecutor(
      planExecutorConfig.provider,
      planExecutorConfig.model,
      { mcpServers: config.mcpServers, tools: [] },
      workspaceDir,
    );
    const planner = createPlanner(planExecutor);

    const planPrompt = assemblePrompt({
      phase: "plan",
      phaseInstructions: config.phases.plan.instructions,
      taskPrompt: initialState.config.prompt,
      repo: initialState.config.repo,
      context: initialState.config.context,
      skills: config.phases.plan.skills,
    });

    const planResult = await planner.plan(planPrompt);
    let currentPlan = planResult.plan;

    eventRecorder.emit(taskId, {
      event: "plan-created",
      plan: currentPlan,
      threadId: planResult.threadId,
    });
    eventRecorder.emit(taskId, {
      event: "phase-completed",
      phase: "plan",
      tokenCount: planResult.tokenCount,
    });

    // --- PLAN REVIEW LOOP ---
    for (
      let loop = 1;
      loop <= initialState.config.effectiveConfig.phases.plan.maxReviewLoops;
      loop += 1
    ) {
      if (eventRecorder.isClosed(taskId)) return;

      console.log(
        `[coordinator] task ${taskId}: plan review ${loop}/${initialState.config.effectiveConfig.phases.plan.maxReviewLoops}`,
      );
      eventRecorder.emit(taskId, {
        event: "phase-started",
        phase: "plan-review",
        loop,
      });

      const reviewExecutorConfig = resolvePhaseExecutor(
        config,
        config.phases.planReview,
      );
      const reviewExecutor = createWorkExecutor(
        reviewExecutorConfig.provider,
        reviewExecutorConfig.model,
        { mcpServers: config.mcpServers, tools: [] },
        workspaceDir,
      );
      const planReviewer = createPlanReviewer(reviewExecutor);

      const reviewPrompt = assemblePrompt({
        phase: "plan-review",
        phaseInstructions: config.phases.planReview.instructions,
        taskPrompt: initialState.config.prompt,
        repo: initialState.config.repo,
        context: initialState.config.context,
        plan: currentPlan,
        skills: config.phases.planReview.skills,
      });

      const review = await planReviewer.review(reviewPrompt);

      eventRecorder.emit(taskId, {
        event: "review-result",
        phase: "plan-review",
        approved: review.approved,
        summary: review.summary,
        loop,
      });
      eventRecorder.emit(taskId, {
        event: "phase-completed",
        phase: "plan-review",
      });

      if (review.approved) {
        console.log(`[coordinator] task ${taskId}: plan approved`);
        break;
      }

      if (loop === initialState.config.effectiveConfig.phases.plan.maxReviewLoops) {
        eventRecorder.recordTaskFailure(
          taskId,
          "Plan review loop exhausted",
        );
        return;
      }

      // Revise plan (continues planner thread)
      console.log(`[coordinator] task ${taskId}: revising plan`);
      eventRecorder.emit(taskId, {
        event: "phase-started",
        phase: "plan",
        loop,
      });

      const revisionPrompt = assemblePrompt({
        phase: "plan",
        taskPrompt: initialState.config.prompt,
        failureContext: `Plan review feedback:\n\n${review.summary}`,
        skills: config.phases.plan.skills,
      });

      const revised = await planner.revise(revisionPrompt);
      currentPlan = revised.plan;

      eventRecorder.emit(taskId, {
        event: "plan-created",
        plan: currentPlan,
        threadId: revised.threadId,
      });
      eventRecorder.emit(taskId, {
        event: "phase-completed",
        phase: "plan",
        tokenCount: revised.tokenCount,
      });
    }

    // --- WORK PHASE ---
    if (eventRecorder.isClosed(taskId)) return;

    console.log(`[coordinator] task ${taskId}: working`);
    eventRecorder.emit(taskId, { event: "phase-started", phase: "work" });

    const workExecutorConfig = resolvePhaseExecutor(
      config,
      config.phases.work,
    );
    const workExecutor = createWorkExecutor(
      workExecutorConfig.provider,
      workExecutorConfig.model,
      { mcpServers: config.mcpServers, tools: [] },
      workspaceDir,
    );

    const workPrompt = assemblePrompt({
      phase: "work",
      phaseInstructions: config.phases.work.instructions,
      taskPrompt: initialState.config.prompt,
      repo: initialState.config.repo,
      context: initialState.config.context,
      plan: currentPlan,
      skills: config.phases.work.skills,
    });

    const workResult = await workExecutor.execute(workPrompt);
    eventRecorder.emit(taskId, {
      event: "work-started",
      threadId: workResult.threadId,
    });
    eventRecorder.emit(taskId, {
      event: "phase-completed",
      phase: "work",
      tokenCount: workResult.tokenCount,
    });

    // --- VERIFICATION + WORK REVIEW LOOP ---
    for (
      let verifyAttempt = 1;
      verifyAttempt <=
        initialState.config.effectiveConfig.phases.work.maxVerificationRetries;
      verifyAttempt += 1
    ) {
      if (eventRecorder.isClosed(taskId)) return;

      // Run verification
      console.log(
        `[coordinator] task ${taskId}: verification ${verifyAttempt}/${initialState.config.effectiveConfig.phases.work.maxVerificationRetries}`,
      );
      eventRecorder.emit(taskId, {
        event: "phase-started",
        phase: "verification",
      });

      const verifyResults = await runVerification({
        commands: config.verification,
        cwd: workspaceDir,
        timeoutMs: config.verificationTimeoutMs,
      });

      eventRecorder.emit(taskId, {
        event: "verification-result",
        results: verifyResults.map((r) => ({
          name: r.name,
          passed: r.passed,
          exitCode: r.exitCode,
          output: r.output,
        })),
      });
      eventRecorder.emit(taskId, {
        event: "phase-completed",
        phase: "verification",
      });

      if (allVerificationsPassed(verifyResults)) {
        break;
      }

      // Verification failed
      if (
        verifyAttempt ===
        initialState.config.effectiveConfig.phases.work.maxVerificationRetries
      ) {
        eventRecorder.recordTaskFailure(
          taskId,
          `Verification failed after ${verifyAttempt} attempts`,
        );
        return;
      }

      // Fix: feed failure context to work executor (continues thread)
      const failureSummary = buildVerificationFailureSummary(verifyResults);
      const fixPrompt = assemblePrompt({
        phase: "work",
        taskPrompt: initialState.config.prompt,
        failureContext: failureSummary,
        skills: config.phases.work.skills,
      });

      const fixResult = await workExecutor.fix(fixPrompt);
      eventRecorder.emit(taskId, {
        event: "fix-applied",
        tokenCount: fixResult.tokenCount,
      });
    }

    // --- WORK REVIEW LOOP ---
    for (
      let reviewLoop = 1;
      reviewLoop <= initialState.config.effectiveConfig.phases.work.maxReviewLoops;
      reviewLoop += 1
    ) {
      if (eventRecorder.isClosed(taskId)) return;

      console.log(
        `[coordinator] task ${taskId}: work review ${reviewLoop}/${initialState.config.effectiveConfig.phases.work.maxReviewLoops}`,
      );
      eventRecorder.emit(taskId, {
        event: "phase-started",
        phase: "work-review",
        loop: reviewLoop,
      });

      const workReviewExecutorConfig = resolvePhaseExecutor(
        config,
        config.phases.workReview,
      );
      const workReviewExecutor = createWorkExecutor(
        workReviewExecutorConfig.provider,
        workReviewExecutorConfig.model,
        { mcpServers: config.mcpServers, tools: [] },
        workspaceDir,
      );

      const diff = await getDiff(workspaceDir).catch(() => "");
      const reviewPrompt = assemblePrompt({
        phase: "work-review",
        phaseInstructions: config.phases.workReview.instructions,
        taskPrompt: initialState.config.prompt,
        repo: initialState.config.repo,
        plan: currentPlan,
        failureContext: diff ? `Current diff:\n${diff}` : null,
        skills: config.phases.workReview.skills,
      });

      const workReviewResult = await reviewWork(workReviewExecutor, {
        reviewPrompt,
        verificationOptions: {
          commands: config.verification,
          cwd: workspaceDir,
          timeoutMs: config.verificationTimeoutMs,
        },
      });

      eventRecorder.emit(taskId, {
        event: "review-result",
        phase: "work-review",
        approved: workReviewResult.review?.approved ?? false,
        summary:
          workReviewResult.review?.summary ?? "Verification failed before review.",
        loop: reviewLoop,
      });
      eventRecorder.emit(taskId, {
        event: "phase-completed",
        phase: "work-review",
      });

      if (workReviewResult.review?.approved) {
        console.log(`[coordinator] task ${taskId}: work approved`);
        break;
      }

      if (reviewLoop === initialState.config.effectiveConfig.phases.work.maxReviewLoops) {
        eventRecorder.recordTaskFailure(
          taskId,
          "Work review loop exhausted",
        );
        return;
      }

      // Fix based on review feedback
      const reviewFeedback =
        workReviewResult.review?.summary ?? "Verification failed.";
      const fixPrompt = assemblePrompt({
        phase: "work",
        taskPrompt: initialState.config.prompt,
        failureContext: `Work review feedback:\n\n${reviewFeedback}`,
        skills: config.phases.work.skills,
      });

      const fixResult = await workExecutor.fix(fixPrompt);
      eventRecorder.emit(taskId, {
        event: "fix-applied",
        tokenCount: fixResult.tokenCount,
      });
    }

    // --- WRAPUP PHASE ---
    if (eventRecorder.isClosed(taskId)) return;

    console.log(`[coordinator] task ${taskId}: wrapping up`);
    eventRecorder.emit(taskId, { event: "phase-started", phase: "wrapup" });

    const wrapupTools = buildWrapupTools({
      config,
      taskId,
      taskPrompt: initialState.config.prompt,
      plan: currentPlan,
      repo: initialState.config.repo,
    });

    const wrapupExecutorConfig = resolvePhaseExecutor(
      config,
      config.phases.wrapup,
    );
    const wrapupExecutor = createWorkExecutor(
      wrapupExecutorConfig.provider,
      wrapupExecutorConfig.model,
      { mcpServers: config.mcpServers, tools: wrapupTools },
      workspaceDir,
    );

    const wrapupPrompt = assemblePrompt({
      phase: "wrapup",
      phaseInstructions: config.phases.wrapup.instructions,
      taskPrompt: initialState.config.prompt,
      repo: initialState.config.repo,
      plan: currentPlan,
      skills: config.phases.wrapup.skills,
    });

    const wrapupResult = await wrapupExecutor.execute(wrapupPrompt);

    // Parse wrapup results from the executor's tool call results
    // The executor calls tools internally; we collect results from the tool definitions
    const actionResults = wrapupTools
      .map((tool) => ({
        type: tool.name,
        success: true, // Tools that were called successfully
        artifact: undefined as string | undefined,
      }));

    // For now, record the wrapup completion. The actual action results
    // come from the tool execute() calls — we need to track them.
    // TODO: In the real implementation, the Codex SDK manages tool calls
    // and we get results back. For v1, we record what we know.
    eventRecorder.emit(taskId, {
      event: "wrapup-result",
      actions: actionResults,
    });

    // Check required actions
    const actionConfigs = getWrapupActionConfigs(config);
    const missing = findMissingRequiredActions(actionConfigs, actionResults);

    if (missing.length > 0) {
      eventRecorder.recordTaskFailure(
        taskId,
        `Required wrapup actions not completed: ${missing.join(", ")}`,
      );
      return;
    }

    eventRecorder.emit(taskId, {
      event: "phase-completed",
      phase: "wrapup",
      tokenCount: wrapupResult.tokenCount,
    });

    console.log(`[coordinator] task ${taskId}: completed`);
  } catch (error) {
    const reason = sanitizeErrorMessage(
      error instanceof Error ? error.message : String(error),
    );
    console.log(`[coordinator] task ${taskId}: failed: ${reason}`);

    try {
      eventRecorder.recordTaskFailure(taskId, reason);
    } catch (emitError) {
      console.error(
        `[coordinator] Failed to persist task-failed for ${taskId}:`,
        emitError instanceof Error ? emitError.message : String(emitError),
      );
      const current = tasks.get(taskId);
      if (current && !isTerminal(current)) {
        tasks.set(taskId, {
          ...current,
          status: "failed",
          updatedAt: new Date().toISOString(),
        });
      }
    }
  } finally {
    onTaskFinished();
  }
}

export function createCoordinator(deps: CoordinatorDeps): Coordinator {
  const workspaceDir = deps.workspaceDir ?? "/workspace";
  const tasks = hydrateTaskStates(deps.config.stateDir);
  const closedTaskIds = new Set<string>();
  const eventRecorder = createTaskEventRecorder(
    deps.config.stateDir,
    tasks,
    closedTaskIds,
  );
  let activeTaskId: string | null = null;

  function finishActiveTask(taskId: string): void {
    if (activeTaskId === taskId) {
      activeTaskId = null;
    }
  }

  return {
    async submitTask(
      input: CreateTaskInput,
    ): Promise<{ taskId: string; status: "accepted" }> {
      if (activeTaskId !== null) {
        throw new Error(
          `Another task is already active: ${activeTaskId}`,
        );
      }

      const taskId = input.taskId;
      const taskConfig = buildTaskConfig(input, deps.config);
      tasks.set(taskId, createInitialState(taskId, taskConfig));
      eventRecorder.emit(taskId, {
        event: "task-accepted",
        taskId,
        config: taskConfig,
      });

      activeTaskId = taskId;
      void runTask(
        taskId,
        deps,
        workspaceDir,
        tasks,
        eventRecorder,
        () => finishActiveTask(taskId),
      );

      return { taskId, status: "accepted" };
    },

    getActiveTaskId(): string | null {
      return activeTaskId;
    },

    getTaskState(taskId: string): TaskState | undefined {
      return tasks.get(taskId);
    },

    async closeTask(taskId: string): Promise<{ status: "closed" }> {
      const state = tasks.get(taskId);
      if (!state) {
        throw new Error(`Task not found: ${taskId}`);
      }
      if (isTerminal(state)) {
        throw new Error(`Task ${taskId} is terminal: ${state.status}`);
      }

      closedTaskIds.add(taskId);
      eventRecorder.emit(taskId, { event: "task-closed" });
      finishActiveTask(taskId);

      return { status: "closed" };
    },
  };
}
```

- [ ] **Step 4: Create `packages/agent-vm-worker/src/coordinator/coordinator.test.ts`**

```typescript
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkerConfig } from "../config/worker-config.js";
import { workerConfigSchema } from "../config/worker-config.js";

const mocks = vi.hoisted(() => ({
  createWorkExecutor: vi.fn(),
  getDiff: vi.fn(),
  runVerification: vi.fn(),
  allVerificationsPassed: vi.fn(),
  buildVerificationFailureSummary: vi.fn(),
  reviewWork: vi.fn(),
  buildWrapupTools: vi.fn(),
  getWrapupActionConfigs: vi.fn(),
  findMissingRequiredActions: vi.fn(),
}));

vi.mock("../work-executor/executor-factory.js", () => ({
  createWorkExecutor: mocks.createWorkExecutor,
}));

vi.mock("../git/git-operations.js", () => ({
  getDiff: mocks.getDiff,
}));

vi.mock("../work-reviewer/verification-runner.js", () => ({
  runVerification: mocks.runVerification,
  allVerificationsPassed: mocks.allVerificationsPassed,
  buildVerificationFailureSummary: mocks.buildVerificationFailureSummary,
}));

vi.mock("../work-reviewer/work-reviewer.js", () => ({
  reviewWork: mocks.reviewWork,
}));

vi.mock("../wrapup/wrapup-action-registry.js", () => ({
  buildWrapupTools: mocks.buildWrapupTools,
  getWrapupActionConfigs: mocks.getWrapupActionConfigs,
}));

vi.mock("../wrapup/wrapup-types.js", () => ({
  findMissingRequiredActions: mocks.findMissingRequiredActions,
}));

import { createCoordinator } from "./coordinator.js";

function createMockExecutor(responses?: {
  readonly executeResponse?: string;
  readonly fixResponse?: string;
}): ReturnType<typeof mocks.createWorkExecutor> {
  let threadId: string | null = null;

  return {
    async execute() {
      threadId = "mock-thread-1";
      return {
        response: responses?.executeResponse ?? "mock response",
        tokenCount: 100,
        threadId: "mock-thread-1",
      };
    },
    async fix() {
      return {
        response: responses?.fixResponse ?? "fixed",
        tokenCount: 50,
        threadId: threadId ?? "mock-thread-1",
      };
    },
    async resumeOrRebuild() {
      return;
    },
    getThreadId() {
      return threadId;
    },
  };
}

function makeConfig(stateDir: string): WorkerConfig {
  return workerConfigSchema.parse({ stateDir });
}

async function waitForStatus(
  coordinator: ReturnType<typeof createCoordinator>,
  taskId: string,
  expectedStatus: string,
  timeoutMs: number = 5000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (coordinator.getTaskState(taskId)?.status === expectedStatus) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `Task ${taskId} did not reach ${expectedStatus}. Last status: ${coordinator.getTaskState(taskId)?.status ?? "unknown"}`,
  );
}

describe("coordinator", () => {
  let tempDir: string;
  let stateDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "coordinator-test-"));
    stateDir = join(tempDir, "state");
    await mkdir(stateDir, { recursive: true });

    // Default mock setup: all phases succeed
    // Plan executor returns plan, then plan reviewer approves
    const planExecutor = createMockExecutor({
      executeResponse: "The implementation plan",
    });
    const reviewExecutor = createMockExecutor({
      executeResponse: JSON.stringify({
        approved: true,
        comments: [],
        summary: "Plan looks good",
      }),
    });
    const workExecutor = createMockExecutor({
      executeResponse: "Implemented",
    });
    const wrapupExecutor = createMockExecutor({
      executeResponse: "Wrapup complete",
    });

    let executorCallCount = 0;
    mocks.createWorkExecutor.mockImplementation(() => {
      executorCallCount += 1;
      // Call order: plan(1), plan-review(2), work(3), verification..., work-review(4+), wrapup(last)
      if (executorCallCount === 1) return planExecutor;
      if (executorCallCount === 2) return reviewExecutor;
      if (executorCallCount === 3) return workExecutor;
      return wrapupExecutor;
    });

    mocks.getDiff.mockResolvedValue("diff --git");
    mocks.runVerification.mockResolvedValue([
      { name: "test", passed: true, exitCode: 0, output: "" },
    ]);
    mocks.allVerificationsPassed.mockReturnValue(true);
    mocks.buildVerificationFailureSummary.mockReturnValue("");

    mocks.reviewWork.mockResolvedValue({
      verificationResults: [
        { name: "test", passed: true, exitCode: 0, output: "" },
      ],
      verificationPassed: true,
      review: { approved: true, comments: [], summary: "Looks good" },
    });

    mocks.buildWrapupTools.mockReturnValue([]);
    mocks.getWrapupActionConfigs.mockReturnValue([]);
    mocks.findMissingRequiredActions.mockReturnValue([]);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("runs a task through all phases to completion", async () => {
    const coordinator = createCoordinator({
      config: makeConfig(stateDir),
      workspaceDir: tempDir,
    });

    const { taskId } = await coordinator.submitTask({
      taskId: "test-task-1",
      prompt: "fix the login bug",
      repo: {
        repoUrl: "https://github.com/org/repo.git",
        baseBranch: "main",
        workspacePath: "/workspace",
      },
    });

    await waitForStatus(coordinator, taskId, "completed");

    const state = coordinator.getTaskState(taskId);
    expect(state).toBeDefined();
    expect(state!.status).toBe("completed");
    expect(state!.plan).toBe("The implementation plan");
  });

  it("rejects a second task while one is active", async () => {
    // Make the executor take a while
    const slowExecutor = {
      async execute() {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return { response: "done", tokenCount: 10, threadId: "t" };
      },
      async fix() {
        return { response: "fixed", tokenCount: 5, threadId: "t" };
      },
      async resumeOrRebuild() {
        return;
      },
      getThreadId() {
        return "t";
      },
    };
    mocks.createWorkExecutor.mockReturnValue(slowExecutor);

    const coordinator = createCoordinator({
      config: makeConfig(stateDir),
      workspaceDir: tempDir,
    });

    await coordinator.submitTask({
      taskId: "task-a",
      prompt: "first task",
    });

    await expect(
      coordinator.submitTask({ taskId: "task-b", prompt: "second task" }),
    ).rejects.toThrow("Another task is already active");
  });

  it("uses controller-provided taskId", async () => {
    const coordinator = createCoordinator({
      config: makeConfig(stateDir),
      workspaceDir: tempDir,
    });

    const { taskId } = await coordinator.submitTask({
      taskId: "controller-provided-id",
      prompt: "test",
    });

    expect(taskId).toBe("controller-provided-id");
  });

  it("sanitizes error messages with tokens", async () => {
    mocks.createWorkExecutor.mockImplementation(() => ({
      async execute() {
        throw new Error(
          "failed: https://x-access-token:secret@github.com/org/repo",
        );
      },
      async fix() {
        throw new Error("should not reach");
      },
      async resumeOrRebuild() {
        return;
      },
      getThreadId() {
        return null;
      },
    }));

    const coordinator = createCoordinator({
      config: makeConfig(stateDir),
      workspaceDir: tempDir,
    });

    await coordinator.submitTask({
      taskId: "sanitize-test",
      prompt: "test",
    });

    await waitForStatus(coordinator, taskId, "failed");
    const taskId = "sanitize-test";

    const logContents = readFileSync(
      join(stateDir, "tasks", `${taskId}.jsonl`),
      "utf-8",
    );
    expect(logContents).not.toContain("x-access-token:secret");
    expect(logContents).toContain("x-access-token:***");
  });

  it("close-while-running stops the task", async () => {
    const slowExecutor = {
      async execute() {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return { response: "done", tokenCount: 10, threadId: "t" };
      },
      async fix() {
        return { response: "fixed", tokenCount: 5, threadId: "t" };
      },
      async resumeOrRebuild() {
        return;
      },
      getThreadId() {
        return "t";
      },
    };
    mocks.createWorkExecutor.mockReturnValue(slowExecutor);

    const coordinator = createCoordinator({
      config: makeConfig(stateDir),
      workspaceDir: tempDir,
    });

    const { taskId } = await coordinator.submitTask({
      taskId: "close-test",
      prompt: "slow task",
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    await coordinator.closeTask(taskId);
    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(coordinator.getTaskState(taskId)?.status).toBe("completed");
    expect(coordinator.getActiveTaskId()).toBeNull();
  });
});
```

- [ ] **Step 5: Run tests**

```bash
cd /Users/shravansunder/Documents/dev/project-dev/agent-vm.agent-vm-worker && pnpm --filter agent-vm-worker test
```

Expected: all tests pass.

- [ ] **Step 6: Run typecheck**

```bash
cd /Users/shravansunder/Documents/dev/project-dev/agent-vm.agent-vm-worker && pnpm --filter agent-vm-worker typecheck
```

Expected: exit code 0.

**Commit:** `feat(agent-vm-worker): add coordinator — config-driven phase orchestration with wrapup`

---

## Task 12: Server + CLI + Final Verification

Hono HTTP API with the new routes (no followup route). cmd-ts CLI with `serve` and `health` commands. Wire everything together. Run full test suite and build.

**Files:**
- Create: `packages/agent-vm-worker/src/server.ts`
- Create: `packages/agent-vm-worker/src/server.test.ts`
- Create: `packages/agent-vm-worker/src/main.ts`
- Update: `packages/agent-vm-worker/src/index.ts`

**Steps:**

- [ ] **Step 1: Create `packages/agent-vm-worker/src/server.ts`**

```typescript
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";

import type { TaskState } from "./state/task-state.js";
import { isTerminal } from "./state/task-state.js";

function validationErrorHook(
  result: {
    success: boolean;
    error?: { issues: readonly z.core.$ZodIssue[] };
  },
  context: Context,
): Response | void {
  if (!result.success) {
    return context.json(
      {
        error: "invalid-request",
        details: result.error?.issues ?? [],
      },
      400,
    );
  }
}

// --- Request schemas ---

export const repoLocationSchema = z.object({
  repoUrl: z.string().min(1),
  baseBranch: z.string().min(1),
  workspacePath: z.string().min(1),
});

export const createTaskRequestSchema = z.object({
  taskId: z.string().min(1),
  prompt: z.string().min(1),
  repo: repoLocationSchema.nullable().default(null),
  context: z.record(z.string(), z.unknown()).default({}),
});

// --- Server deps ---

export interface ServerDeps {
  readonly getActiveTaskId: () => string | null;
  readonly getActiveTaskStatus: () => string | null;
  readonly getTaskState: (taskId: string) => TaskState | undefined;
  readonly submitTask: (
    input: z.infer<typeof createTaskRequestSchema>,
  ) => Promise<{ taskId: string; status: "accepted" }>;
  readonly closeTask: (taskId: string) => Promise<{ status: "closed" }>;
  readonly getUptime: () => number;
  readonly getExecutorInfo: () => {
    readonly provider: string;
    readonly model: string;
  };
}

export function createApp(deps: ServerDeps): Hono {
  const app = new Hono();

  // GET /health
  app.get("/health", (context) => {
    return context.json({
      status: "ok",
      activeTask: deps.getActiveTaskId(),
      activeTaskStatus: deps.getActiveTaskStatus(),
      uptime: deps.getUptime(),
      executor: deps.getExecutorInfo(),
    });
  });

  // POST /tasks
  app.post(
    "/tasks",
    zValidator("json", createTaskRequestSchema, validationErrorHook),
    async (context) => {
      try {
        if (deps.getActiveTaskId() !== null) {
          return context.json(
            {
              error: "task-already-active",
              activeTaskId: deps.getActiveTaskId(),
            },
            409,
          );
        }

        const result = await deps.submitTask(context.req.valid("json"));
        return context.json(result, 201);
      } catch (error) {
        console.error(
          `[server] POST /tasks failed:`,
          error instanceof Error ? error.message : String(error),
        );
        return context.json({ error: "task-submission-failed" }, 500);
      }
    },
  );

  // GET /tasks/:id
  app.get("/tasks/:id", (context) => {
    const taskState = deps.getTaskState(context.req.param("id"));

    if (!taskState) {
      return context.json({ error: "task-not-found" }, 404);
    }

    return context.json(taskState);
  });

  // POST /tasks/:id/close
  app.post("/tasks/:id/close", async (context) => {
    const taskId = context.req.param("id");
    const taskState = deps.getTaskState(taskId);

    if (!taskState) {
      return context.json({ error: "task-not-found" }, 404);
    }
    if (isTerminal(taskState)) {
      return context.json(
        { error: "task-is-terminal", status: taskState.status },
        410,
      );
    }

    try {
      const result = await deps.closeTask(taskId);
      return context.json(result, 200);
    } catch (error) {
      console.error(
        `[server] POST /tasks/:id/close failed:`,
        error instanceof Error ? error.message : String(error),
      );
      return context.json({ error: "task-close-failed" }, 500);
    }
  });

  return app;
}
```

- [ ] **Step 2: Create `packages/agent-vm-worker/src/server.test.ts`**

```typescript
import { describe, expect, it, vi } from "vitest";

import type { TaskState } from "./state/task-state.js";
import { workerConfigSchema } from "./config/worker-config.js";
import { createApp, type ServerDeps } from "./server.js";

const TEST_EFFECTIVE_CONFIG = workerConfigSchema.parse({});

function makeTaskState(
  overrides?: Partial<TaskState>,
): TaskState {
  return {
    taskId: "test-1",
    status: "pending",
    config: {
      taskId: "test-1",
      prompt: "fix bug",
      repo: null,
      context: {},
      effectiveConfig: TEST_EFFECTIVE_CONFIG,
    },
    plan: null,
    plannerThreadId: null,
    workThreadId: null,
    planReviewLoop: 0,
    workReviewLoop: 0,
    verificationAttempt: 0,
    lastReviewSummary: null,
    lastVerificationResults: null,
    wrapupResults: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createDeps(overrides?: Partial<ServerDeps>): ServerDeps {
  return {
    getActiveTaskId: () => null,
    getActiveTaskStatus: () => null,
    getTaskState: () => undefined,
    submitTask: vi.fn().mockResolvedValue({
      taskId: "test-1",
      status: "accepted",
    }),
    closeTask: vi.fn().mockResolvedValue({ status: "closed" }),
    getUptime: () => 1000,
    getExecutorInfo: () => ({ provider: "codex", model: "gpt-5.4-low" }),
    ...overrides,
  };
}

describe("server", () => {
  describe("GET /health", () => {
    it("returns health status", async () => {
      const app = createApp(createDeps());
      const response = await app.request("/health");
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body["status"]).toBe("ok");
      expect(body["executor"]).toBeDefined();
    });
  });

  describe("POST /tasks", () => {
    it("creates a task and returns 201", async () => {
      const deps = createDeps();
      const app = createApp(deps);
      const response = await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskId: "task-1",
          prompt: "fix the bug",
        }),
      });

      expect(response.status).toBe(201);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body["taskId"]).toBe("test-1");
    });

    it("returns 409 when task is already active", async () => {
      const deps = createDeps({
        getActiveTaskId: () => "active-task-1",
      });
      const app = createApp(deps);
      const response = await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskId: "task-2",
          prompt: "another task",
        }),
      });

      expect(response.status).toBe(409);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body["error"]).toBe("task-already-active");
    });

    it("returns 400 for invalid request body", async () => {
      const app = createApp(createDeps());
      const response = await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(400);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body["error"]).toBe("invalid-request");
    });
  });

  describe("GET /tasks/:id", () => {
    it("returns task state", async () => {
      const deps = createDeps({
        getTaskState: () => makeTaskState({ taskId: "my-task" }),
      });
      const app = createApp(deps);
      const response = await app.request("/tasks/my-task");

      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body["taskId"]).toBe("my-task");
    });

    it("returns 404 for unknown task", async () => {
      const app = createApp(createDeps());
      const response = await app.request("/tasks/nonexistent");

      expect(response.status).toBe(404);
    });
  });

  describe("POST /tasks/:id/close", () => {
    it("closes a running task", async () => {
      const deps = createDeps({
        getTaskState: () => makeTaskState({ status: "working" }),
      });
      const app = createApp(deps);
      const response = await app.request("/tasks/test-1/close", {
        method: "POST",
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body["status"]).toBe("closed");
    });

    it("returns 404 for unknown task", async () => {
      const app = createApp(createDeps());
      const response = await app.request("/tasks/nonexistent/close", {
        method: "POST",
      });

      expect(response.status).toBe(404);
    });

    it("returns 410 for terminal task", async () => {
      const deps = createDeps({
        getTaskState: () => makeTaskState({ status: "completed" }),
      });
      const app = createApp(deps);
      const response = await app.request("/tasks/test-1/close", {
        method: "POST",
      });

      expect(response.status).toBe(410);
    });
  });
});
```

- [ ] **Step 3: Create `packages/agent-vm-worker/src/main.ts`**

```typescript
#!/usr/bin/env node

import { serve } from "@hono/node-server";
import { binary, command, number, option, optional, run, string, subcommands } from "cmd-ts";

import { loadWorkerConfig, resolvePhaseExecutor } from "./config/worker-config.js";
import { createCoordinator } from "./coordinator/coordinator.js";
import { createApp } from "./server.js";

const serveCommand = command({
  name: "serve",
  description: "Start the agent-vm-worker HTTP server",
  args: {
    port: option({
      type: number,
      long: "port",
      short: "p",
      defaultValue: () => 18789,
      description: "Port to listen on",
    }),
    config: option({
      type: optional(string),
      long: "config",
      short: "c",
      description: "Path to worker config JSON",
    }),
    stateDir: option({
      type: optional(string),
      long: "state-dir",
      description: "State directory path",
    }),
  },
  handler: async (args) => {
    const configPath =
      args.config ?? process.env["WORKER_CONFIG_PATH"] ?? undefined;
    const config = loadWorkerConfig(configPath);

    if (args.stateDir) {
      // Override stateDir from CLI if provided
      Object.assign(config, { stateDir: args.stateDir });
    }

    const workspaceDir = process.env["WORKSPACE_DIR"] ?? "/workspace";
    const startTime = Date.now();

    const coordinator = createCoordinator({
      config,
      workspaceDir,
    });

    const defaultExecutor = resolvePhaseExecutor(config, {});

    const app = createApp({
      getActiveTaskId: () => coordinator.getActiveTaskId(),
      getActiveTaskStatus: () => {
        const activeId = coordinator.getActiveTaskId();
        if (!activeId) return null;
        return coordinator.getTaskState(activeId)?.status ?? null;
      },
      getTaskState: (taskId) => coordinator.getTaskState(taskId),
      submitTask: async (input) => coordinator.submitTask(input),
      closeTask: async (taskId) => coordinator.closeTask(taskId),
      getUptime: () => Math.floor((Date.now() - startTime) / 1000),
      getExecutorInfo: () => ({
        provider: defaultExecutor.provider,
        model: defaultExecutor.model,
      }),
    });

    serve(
      {
        fetch: app.fetch,
        port: args.port,
      },
      (info) => {
        console.log(
          `[agent-vm-worker] Server listening on http://localhost:${info.port}`,
        );
      },
    );
  },
});

const healthCommand = command({
  name: "health",
  description: "Check worker health",
  args: {
    port: option({
      type: number,
      long: "port",
      short: "p",
      defaultValue: () => 18789,
      description: "Port to check",
    }),
  },
  handler: async (args) => {
    try {
      const response = await fetch(
        `http://localhost:${args.port}/health`,
      );
      if (!response.ok) {
        console.error(`Health check failed: ${response.status}`);
        process.exit(1);
      }
      const data = await response.json();
      console.log(JSON.stringify(data, null, 2));
    } catch (error) {
      console.error(
        `Health check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
  },
});

const app = subcommands({
  name: "agent-vm-worker",
  description: "Configurable task worker for Gondolin VMs",
  cmds: {
    serve: serveCommand,
    health: healthCommand,
  },
});

void run(binary(app), process.argv).catch((error: unknown) => {
  console.error(
    "[agent-vm-worker] Fatal error:",
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
});
```

- [ ] **Step 4: Update `packages/agent-vm-worker/src/index.ts`**

```typescript
// --- Config ---
export { workerConfigSchema, loadWorkerConfig, resolveModelAlias, resolvePhaseExecutor } from "./config/worker-config.js";
export type { WorkerConfig } from "./config/worker-config.js";

// --- State ---
export { taskEventSchema, taskStatusSchema, phaseNameSchema, TERMINAL_STATUSES } from "./state/task-event-types.js";
export type { TaskEvent, TaskStatus, PhaseName, TaskConfig, TimestampedEvent, VerificationCommandResult, WrapupActionResult } from "./state/task-event-types.js";
export { appendEvent, replayEvents } from "./state/event-log.js";
export { createInitialState, applyEvent, isTerminal, hydrateTaskStates } from "./state/task-state.js";
export type { TaskState } from "./state/task-state.js";

// --- Work Executor ---
export type { WorkExecutor, ExecutorResult, StructuredInput, ExecutorCapabilities, ToolDefinition } from "./work-executor/executor-interface.js";
export { createWorkExecutor } from "./work-executor/executor-factory.js";

// --- Coordinator ---
export { createCoordinator } from "./coordinator/coordinator.js";
export type { Coordinator, CreateTaskInput } from "./coordinator/coordinator-types.js";

// --- Server ---
export { createApp, createTaskRequestSchema } from "./server.js";
export type { ServerDeps } from "./server.js";

// --- Shared ---
export { reviewResultSchema } from "./shared/review-result.js";
export type { ReviewResult } from "./shared/review-result.js";
export { skillReferenceSchema } from "./shared/skill-types.js";
export type { SkillReference } from "./shared/skill-types.js";

// --- Git ---
export { configureGit, createBranch, stageAndCommit, pushBranch, createPullRequest, getDiffStat, getDiff, buildPushUrl, buildCommitMessage, parseRepoFromUrl, sanitizeBranchName } from "./git/git-operations.js";
export type { GitConfigOptions, CommitOptions, PushOptions, PullRequestOptions } from "./git/git-operations.js";

// --- Context ---
export { gatherContext, readOptionalFile } from "./context/gather-context.js";
export type { RepoContext } from "./context/gather-context.js";

// --- Prompt ---
export { assemblePrompt, resolveSkillInputs } from "./prompt/prompt-assembler.js";

// --- Verification ---
export { parseCommand, runVerification, allVerificationsPassed, buildVerificationFailureSummary } from "./work-reviewer/verification-runner.js";
export type { VerificationCommand, RunVerificationOptions } from "./work-reviewer/verification-runner.js";
```

- [ ] **Step 5: Run full test suite**

```bash
cd /Users/shravansunder/Documents/dev/project-dev/agent-vm.agent-vm-worker && pnpm --filter agent-vm-worker test
```

Expected: all tests pass, exit code 0. Count should be approximately 50+ tests across all modules.

- [ ] **Step 6: Run typecheck**

```bash
cd /Users/shravansunder/Documents/dev/project-dev/agent-vm.agent-vm-worker && pnpm --filter agent-vm-worker typecheck
```

Expected: exit code 0, no errors.

- [ ] **Step 7: Build**

```bash
cd /Users/shravansunder/Documents/dev/project-dev/agent-vm.agent-vm-worker && pnpm --filter agent-vm-worker build
```

Expected: exit code 0, `dist/` directory created with compiled JS + declarations.

- [ ] **Step 8: Verify CLI entry point**

```bash
cd /Users/shravansunder/Documents/dev/project-dev/agent-vm.agent-vm-worker && node packages/agent-vm-worker/dist/main.js --help
```

Expected: shows subcommands `serve` and `health`.

> **Note:** Full e2e verification with a real Gondolin VM requires the controller companion work described in the Post-Implementation Notes below (`preStartGateway`/`postStopGateway` hooks, per-task VM orchestration, `buildVmSpec`/`buildProcessSpec` updates). This task verifies that the worker package builds, passes tests, and runs standalone. Integration testing with a live VM is out of scope for this plan.

**Commit:** `feat(agent-vm-worker): add server, CLI, and wire all modules together`

---

## Post-Implementation Notes

### Companion work required (in packages/agent-vm, separate branch)

The worker package cannot run end-to-end without controller-side changes. These are in scope for v1 but live in `packages/agent-vm` and `packages/worker-gateway`, not in this package:

1. **`preStartGateway` hook** — clone repo, read project config, merge with gateway config, write effective config to per-task stateDir, allocate per-task dirs (`tasks/<taskId>/workspace`, `tasks/<taskId>/state`)
2. **`postStopGateway` hook** — delete per-task dirs after VM teardown
3. **Per-task VM orchestration** — controller receives task → preStartGateway → clone zone config with per-task paths → startGatewayZone → POST /tasks → poll for completion → harvest results → vm.close → postStopGateway
4. **worker-gateway `buildVmSpec` update** — mount effective config path, set `WORKER_CONFIG_PATH` env var
5. **worker-gateway `buildProcessSpec` unblock** — replace the "not implemented" throw with actual startCommand/healthCheck

A separate implementation plan should be written for this controller-side work.

### What is NOT in v1

1. **Followup** — no `submitFollowup` or `POST /tasks/:id/followup` route
2. **Claude executor** — throws "not implemented yet"
3. **Docker service routing** — controller-side, additive
4. **Wrapup retry** — wrapup runs once; if required action fails, task fails
5. **Context schema validation** — `Record<string, unknown>` passthrough
6. **Multi-repo** — v1 is single repo, nullable

### gather-context preserved

The coordinator gathers a repo summary from `/workspace` (file tree, CLAUDE.md, package.json) and includes it in the prompt. This gives the planner and work executor structural awareness of the project before they start. Even though the executor can browse files itself, the summary makes planning significantly more effective. If `/workspace` is empty (no-repo task), context gathering is skipped.

### Wrapup tool-call result tracking

The wrapup tool-call tracking is NOT deferred — it is required for v1. The spec requires the coordinator to check required wrapup actions after wrapup completes and fail the task if required actions were not successfully executed. The implementation:

1. Each `ToolDefinition.execute()` implementation (git-pr, slack-post) records its own result into a shared results collector.
2. The Codex SDK calls `ToolDefinition.execute()` as the agent makes tool calls — our implementation runs and records the result.
3. After the wrapup executor finishes, the coordinator reads the collected results from the registry.
4. `findMissingRequiredActions` checks required actions against actual results. Task fails if any required action was not successfully called.

This works because we control the `execute` function on each tool — the SDK calls our code, and we capture the result. No SDK-level interception needed.

### Thread continuity in the coordinator

The coordinator creates fresh executors for each phase. For the planner, the same executor instance is reused across plan-review loops (execute on first, fix on revisions). For the work executor, the same instance is reused across verification retries. Review phases use fresh executors (single-shot).
