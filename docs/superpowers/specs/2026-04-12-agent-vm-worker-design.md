# agent-vm-worker Design Spec

## What This Is

agent-vm-worker is the process that runs inside a Gondolin VM. It receives tasks via HTTP, drives them through a plan loop and work loop, verifies results, and produces artifacts (PRs, notifications). It is spec-driven — skills, instructions, verification commands, and completion actions are all configured, not hardcoded. "Coding" is one configuration of the loop system, not a special case.

## What Already Exists

`packages/agent-vm-coding` (on the `kubernetes-attempts` branches) implements the coding-specific version:
- 4 hardcoded agents: planner, plan-reviewer, coder, code-reviewer
- Codex SDK as the only executor
- Hardcoded skill names as a TypeScript enum
- Hardcoded prompt templates per phase
- Hardcoded verification: `testCommand` + `lintCommand`
- Hardcoded completion: git commit + push + PR
- JSONL event-sourced state with hydration
- Hono HTTP API
- 109 unit tests, 5 integration tests

The loop mechanics (plan loop, work loop with sanity retries, code review loop, followup handling, error sanitization, close-while-running) are sound and ~80% reusable. The hardcoded agent wiring and config are what change.

## Connection to Gateway Abstraction

The gateway abstraction (merged to master as PR #4) defines how the controller starts a worker in a VM. The connection point is `workerLifecycle.buildProcessSpec()` in `packages/worker-gateway/` — currently throws `"agent-vm-worker is not present yet"`. Building agent-vm-worker unblocks this.

```
Controller                              VM
─────────                               ──
workerLifecycle.buildProcessSpec()
  → startCommand: "agent-vm-worker serve --port 18789"
  → healthCheck: { type: "http", port: 18789, path: "/health" }
  → guestListenPort: 18789

Controller creates VM, runs startCommand
Worker boots, serves HTTP on 18789
Controller forwards tasks via ingress
```

The worker does not know about Gondolin, the controller, or Docker. It receives a merged config and serves HTTP. Services (postgres, redis) appear as TCP hostnames routed by Gondolin.

---

## Package Structure

One package: `packages/agent-vm-worker`. No multi-package split.

```
packages/agent-vm-worker/
├── package.json
├── tsconfig.json
├── tsconfig.build.json
└── src/
    ├── main.ts                          ← cmd-ts CLI entry point
    ├── server.ts                        ← Hono HTTP API
    ├── config/
    │   ├── worker-config.ts             ← Zod schemas + loading + model alias resolution
    │   └── worker-config.test.ts
    ├── coordinator/
    │   ├── coordinator.ts               ← orchestrates plan + work loops
    │   ├── coordinator.test.ts
    │   ├── coordinator-types.ts         ← Coordinator interface, CreateTaskInput
    │   └── coordinator-helpers.ts       ← sanitizeErrorMessage, buildTaskConfig
    ├── planner/
    │   ├── planner.ts                   ← plan phase: run executor with plan skills
    │   ├── planner.test.ts
    │   ├── plan-reviewer.ts             ← review plan: run executor, parse ReviewResult
    │   └── plan-reviewer.test.ts
    ├── work-executor/
    │   ├── executor-interface.ts         ← WorkExecutor interface
    │   ├── codex-executor.ts            ← Codex SDK adapter
    │   ├── codex-executor.test.ts
    │   └── executor-factory.ts          ← creates executor by provider name
    ├── work-reviewer/
    │   ├── work-reviewer.ts             ← orchestrates: verification → review agent
    │   ├── work-reviewer.test.ts
    │   ├── verification-runner.ts       ← runs configured commands (test, lint, typecheck)
    │   └── verification-runner.test.ts
    ├── completion/
    │   ├── completion-types.ts          ← CompletionAction interface
    │   ├── git-pr-completion.ts         ← commit + push + PR
    │   ├── git-pr-completion.test.ts
    │   └── completion-factory.ts        ← creates completion actions by type
    ├── prompt/
    │   ├── prompt-assembler.ts          ← base + instructions + task + context + skills
    │   └── prompt-assembler.test.ts
    ├── context/
    │   ├── gather-context.ts            ← repo context (file count, summary, CLAUDE.md)
    │   └── gather-context.test.ts
    ├── git/
    │   ├── git-operations.ts            ← commit, push, PR, branch, config
    │   └── git-operations.test.ts
    ├── state/
    │   ├── task-state.ts                ← event-sourced state + hydration
    │   ├── task-state.test.ts
    │   ├── task-event-types.ts          ← Zod discriminated union of events
    │   └── event-log.ts                 ← JSONL append + replay
    └── shared/
        ├── review-result.ts             ← Zod schema for structured review JSON
        └── skill-types.ts               ← SkillReference type
```

---

## Config

### Three Layers

Config is assembled by the controller before the worker boots. The worker receives a single merged config.

**Gateway config** (org-level, mounted as JSON file into VM):
- Provider/model defaults and per-phase overrides
- Phase skills (paths to SKILL.md files baked into VM image)
- Phase instructions (overrides for default prompt text)
- Loop counts, timeouts
- Completion action list
- Idle timeout, state directory

**Project config** (`.agent-vm/config.json` in the cloned repo):
- Verification commands (test, lint, typecheck — repo-specific)
- Verification timeout
- Branch prefix
- Project-specific phase instruction overrides

**Task input** (`POST /tasks` body):
- Prompt
- Repo URL
- Base branch
- Per-task overrides (optional)

**Merge precedence:** task > project > gateway > Zod defaults

**What each layer can override:**

| Field | Gateway | Project | Task |
|-------|---------|---------|------|
| provider/model | yes | no | no |
| skills | yes | no | no |
| instructions | yes | yes | no |
| loop counts | yes | yes | no |
| verification commands | defaults | yes | yes |
| verificationTimeoutMs | yes | yes | no |
| branchPrefix | yes | yes | no |
| completion actions | yes | no | no |
| prompt | no | no | yes |
| repoUrl, baseBranch | no | no | yes |

The worker does not read `.agent-vm/config.json` itself. The controller reads it after cloning the repo and passes the merged values to the worker via the task submission body or mounted config.

### Gateway Config Schema

```typescript
const skillReferenceSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
});

const phaseExecutorSchema = z.object({
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
});

const planPhaseSchema = z.object({
  ...phaseExecutorSchema.shape,
  skills: z.array(skillReferenceSchema).default([]),
  instructions: z.string().optional(),
  maxReviewLoops: z.number().int().nonnegative().default(2),
});

const planReviewPhaseSchema = z.object({
  ...phaseExecutorSchema.shape,
  skills: z.array(skillReferenceSchema).default([]),
  instructions: z.string().optional(),
});

const workPhaseSchema = z.object({
  ...phaseExecutorSchema.shape,
  skills: z.array(skillReferenceSchema).default([]),
  instructions: z.string().optional(),
  maxReviewLoops: z.number().int().nonnegative().default(3),
  maxVerificationRetries: z.number().int().nonnegative().default(3),
});

const workReviewPhaseSchema = z.object({
  ...phaseExecutorSchema.shape,
  skills: z.array(skillReferenceSchema).default([]),
  instructions: z.string().optional(),
});

const followupPhaseSchema = z.object({
  maxPlanReviewLoops: z.number().int().nonnegative().default(1),
  maxWorkReviewLoops: z.number().int().nonnegative().default(2),
});

const verificationCommandSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
});

const completionActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("git-pr") }),
  z.object({
    type: z.literal("slack-post"),
    webhookUrl: z.string().url(),
    channel: z.string().min(1).optional(),
  }),
]);

const workerConfigSchema = z.object({
  defaults: z.object({
    provider: z.string().min(1).default("codex"),
    model: z.string().min(1).default("latest-medium"),
  }),
  phases: z.object({
    plan: planPhaseSchema.default({}),
    planReview: planReviewPhaseSchema.default({}),
    work: workPhaseSchema.default({}),
    workReview: workReviewPhaseSchema.default({}),
    followup: followupPhaseSchema.default({}),
  }).default({}),
  verification: z.array(verificationCommandSchema).default([
    { name: "test", command: "npm test" },
    { name: "lint", command: "npm run lint" },
  ]),
  verificationTimeoutMs: z.number().positive().default(300_000),
  completion: z.array(completionActionSchema).default([{ type: "git-pr" }]),
  branchPrefix: z.string().min(1).default("agent/"),
  commitCoAuthor: z.string().min(1).default("agent-vm-worker <noreply@agent-vm>"),
  idleTimeoutMs: z.number().positive().default(1_800_000),
  stateDir: z.string().min(1).default("/state"),
});

type WorkerConfig = z.infer<typeof workerConfigSchema>;
```

### Model Alias Resolution

Aliases resolve per provider at executor creation time:

```typescript
const MODEL_ALIASES = {
  codex: {
    "latest": "gpt-5.4-high",
    "latest-medium": "gpt-5.4-low",
    "latest-mini": "gpt-5.4-mini",
  },
  claude: {
    "latest": "claude-opus-4-6",
    "latest-medium": "claude-sonnet-4-6",
    "latest-mini": "claude-haiku-4-5",
  },
} as const satisfies Record<string, Record<string, string>>;
```

If the model value is not an alias key, it is used as-is (explicit model ID).

---

## Coordinator & State Machine

### State Machine

```
POST /tasks
    │
    ▼
 pending
    │ gather context
    ▼
 planning ◄─────────────────────┐
    │ planner.run(skills)        │
    ▼                            │
 reviewing-plan                  │
    │ planReviewer.run(skills)   │
    │                            │
    ├── approved ──────┐         │
    │                  │         │
    └── rejected       │         │
        retries left? ─┤         │
        yes ───────────┘─────────┘
        no → failed
                       │
                       ▼
 working ◄──────────────────────┐
    │ workExecutor.execute()     │
    ▼                            │
 verifying                       │
    │ run verification commands  │
    │                            │
    ├── all pass ──────┐         │
    │                  │         │
    └── fail           │         │
        retries left? ─┤         │
        yes ───────────┘─────────┘ (feed failure context back)
        no → failed
                       │
                       ▼
 reviewing-work ◄───────────────┐
    │ workReviewer.run(skills)   │
    ▼                            │
    ├── approved ──────┐         │
    │                  │         │
    └── rejected       │         │
        retries left? ─┤         │
        yes ───────────┘─────────┘ (fix → re-verify → re-review)
        no → failed
                       │
                       ▼
 completing
    │ run completion actions
    ▼
 awaiting-followup
    │
    ├── POST /tasks/:id/followup
    │     → re-enters plan loop with lighter config
    │
    └── controller kills VM (merge, timeout, close)
         ▼
       completed (terminal)

 failed (terminal) ← any state on max retries or unrecoverable error
```

### Setting `maxReviewLoops: 0`

If `phases.plan.maxReviewLoops` is 0, the plan-review phase is skipped entirely. The plan goes straight to the work phase. This enables plan-only workflows or cases where review isn't needed.

### Coordinator Behaviors Preserved

- Single active task per worker (reject with 409 if one is running)
- Fire-and-forget execution (`submitTask` returns immediately, loop runs async)
- `closedTaskIds` set — close-while-running stops the task at the next check point
- Error sanitization (strip `x-access-token:*` from error messages)
- Nested try/catch in failure recording (in-memory fallback if disk write fails)
- JSONL event sourcing — every transition persisted, hydration on crash recovery

### What Changes

- Agents created from phase config (provider, model, skills) not hardcoded `deps.plannerAgent`
- Verification is a list of named commands from config, not hardcoded test+lint
- Completion is a list of actions, not hardcoded git-pr
- Prompt assembly is generic (base + instructions + task + context + skills)
- Followups re-enter plan loop with `followup` phase config (lighter review counts)

---

## Work Executor Interface

The plug point for AI providers.

```typescript
interface WorkExecutor {
  /** Run a prompt — creates a new thread on first call */
  execute(input: readonly StructuredInput[]): Promise<ExecutorResult>;

  /** Continue the same thread with fix instructions */
  fix(input: readonly StructuredInput[]): Promise<ExecutorResult>;

  /** Resume a thread from persisted state (crash recovery) */
  resumeOrRebuild(
    threadId: string | null,
    context: readonly StructuredInput[],
  ): Promise<void>;

  /** Current thread ID for persistence */
  getThreadId(): string | null;
}

interface ExecutorResult {
  readonly response: string;
  readonly tokenCount: number;
  readonly threadId: string;
}

type StructuredInput =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "skill"; readonly name: string; readonly path: string };
```

### Executor Factory

```typescript
function createWorkExecutor(provider: string, model: string): WorkExecutor {
  const resolvedModel = resolveModelAlias(provider, model);
  switch (provider) {
    case "codex":
      return createCodexExecutor({ model: resolvedModel });
    case "claude":
      throw new Error("Claude executor is not implemented yet.");
    default:
      throw new Error(`Unknown executor provider: '${provider}'.`);
  }
}
```

The planner, plan-reviewer, and work-reviewer also use executors for their LLM calls. They create single-shot executors (fresh thread per invocation, no `fix()` or `resumeOrRebuild()`). The work-executor is the one with thread continuity across retries.

---

## Prompt Assembly

Three layers per phase, assembled in order:

### 1. Base Prompt (in code, NOT overridable)

System identity, safety rules, output format requirements. Always present.

```
"You are an agent working in a sandboxed VM. You have access to the workspace at /workspace.
 Do not attempt to access the network directly — all outbound requests go through a mediation proxy."
```

For review phases, the base includes the output format requirement:

```
"Return your review as structured JSON matching the ReviewResult schema:
 { approved: boolean, comments: [...], summary: string }"
```

### 2. Phase Instructions (defaults in code, overridable by config)

Each phase has a default instruction string. Config can replace it.

| Phase | Default instruction |
|-------|-------------------|
| plan | "Create an implementation plan for the task. Do not write code yet." |
| planReview | "Review the plan for completeness, correctness, risks, and missing edge cases." |
| work | "Implement the approved plan." |
| workReview | "Review the code changes for correctness, bugs, style, and test coverage." |

If `phases.plan.instructions` is set in config, it replaces the default. The base prompt is always prepended regardless.

### 3. Task Context (assembled at runtime)

- Task prompt (from POST body)
- Repo context (file count, summary, CLAUDE.md content if present)
- Plan (for work/review phases — the approved plan from the plan loop)
- Failure context (for retries — verification output, review comments)
- Skills (appended as structured skill inputs, read from paths)

Final assembled input: `[base + instructions + task context (text), ...skills (structured)]`

---

## Verification

The work-reviewer runs verification before the LLM review. Verification is a list of configured commands.

```typescript
const verificationCommandSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
});

interface VerificationCommandResult {
  readonly name: string;
  readonly passed: boolean;
  readonly exitCode: number;
  readonly output: string;
}
```

The verification runner:
1. Iterates over configured commands
2. Runs each via `execa` (no shell — `parseCommand` tokenizer rejects shell operators)
3. Collects results
4. ALL must pass for verification to pass
5. On failure, command name + exit code + output become retry context for the work-executor

Same `parseCommand` safety from current `verification.ts` — rejects `|`, `&`, `;`, `>`, `<`, `` ` ``, `$(`.

---

## Completion

Completion actions run after the work loop passes all reviews. Multiple actions execute sequentially.

```typescript
const completionActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("git-pr") }),
  z.object({
    type: z.literal("slack-post"),
    webhookUrl: z.string().url(),
    channel: z.string().min(1).optional(),
  }),
]);
```

### git-pr completion

Same as current `task-ship.ts`:
1. Configure git (user name/email)
2. Create branch (`branchPrefix` + taskId)
3. Stage all changes, commit with co-author
4. Push branch
5. Create PR via `gh pr create`

### slack-post completion

Posts a summary to a Slack webhook. Includes: task prompt, plan summary, PR URL (if git-pr also ran), status.

Completion actions share a common interface:

```typescript
interface CompletionAction {
  execute(context: CompletionContext): Promise<CompletionResult>;
}

interface CompletionContext {
  readonly taskId: string;
  readonly prompt: string;
  readonly plan: string;
  readonly branchName: string;
  readonly workspaceDir: string;
  readonly config: WorkerConfig;
  readonly previousResults: readonly CompletionResult[];
}

interface CompletionResult {
  readonly type: string;
  readonly artifact: string;
  readonly success: boolean;
}
```

`previousResults` lets later actions reference earlier ones (e.g., slack-post includes the PR URL from git-pr).

---

## HTTP API

Hono + `@hono/zod-validator`. Same patterns as the rest of the repo.

### Routes

```
POST /tasks                    → submit new task
GET  /tasks/:id                → get task state
POST /tasks/:id/followup       → submit followup prompt
POST /tasks/:id/close          → close task (controller calls this)
GET  /health                   → worker health + active task info
```

### Request Schemas

```typescript
const createTaskRequestSchema = z.object({
  prompt: z.string().min(1),
  repoUrl: z.string().min(1),
  baseBranch: z.string().default("main"),
  verification: z.array(verificationCommandSchema).optional(),
  branchPrefix: z.string().optional(),
});

const followupRequestSchema = z.object({
  prompt: z.string().min(1),
});
```

### Health Response

```typescript
const healthResponseSchema = z.object({
  status: z.literal("ok"),
  activeTask: z.string().nullable(),
  activeTaskStatus: z.string().nullable(),
  uptime: z.number(),
  executor: z.object({
    provider: z.string(),
    model: z.string(),
  }),
});
```

### Error Responses

- 409: task-already-active (single active task)
- 404: task-not-found
- 410: task-is-terminal
- 400: invalid-request (Zod validation failure)
- 500: generic error code (no raw error messages)

---

## CLI

cmd-ts entry point, same patterns as `packages/agent-vm/src/cli/`.

```
agent-vm-worker serve
  --port <number>           (default: 18789)
  --config <path>           (gateway config JSON, optional)
  --state-dir <path>        (default: /state)

agent-vm-worker health
  --port <number>           (default: 18789)
  Checks GET /health, exits 0 if ok, 1 if not.
```

`serve` starts the Hono HTTP server. This is the command that `workerLifecycle.buildProcessSpec()` returns as `startCommand`.

---

## State & Events

JSONL event sourcing. Same pattern as current `agent-vm-coding`. Events are a Zod discriminated union.

```typescript
const phaseNames = [
  "plan", "plan-review", "work",
  "verification", "work-review", "completion",
] as const satisfies readonly string[];

const phaseNameSchema = z.enum(phaseNames);

const taskEventSchema = z.discriminatedUnion("event", [
  z.object({
    event: z.literal("task-accepted"),
    taskId: z.string().min(1),
    config: taskConfigSchema,
  }),
  z.object({
    event: z.literal("context-gathered"),
    fileCount: z.number().int().nonnegative(),
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
    event: z.literal("review-result"),
    phase: z.enum(["plan-review", "work-review"]),
    approved: z.boolean(),
    summary: z.string(),
    loop: z.number().int().nonnegative(),
  }),
  z.object({
    event: z.literal("verification-result"),
    results: z.array(z.object({
      name: z.string(),
      passed: z.boolean(),
      exitCode: z.number().int(),
      output: z.string(),
    })),
  }),
  z.object({
    event: z.literal("fix-applied"),
    tokenCount: z.number().int().nonnegative(),
  }),
  z.object({
    event: z.literal("completion-result"),
    actions: z.array(z.object({
      type: z.string(),
      artifact: z.string().optional(),
      success: z.boolean(),
    })),
  }),
  z.object({
    event: z.literal("followup-accepted"),
    prompt: z.string(),
  }),
  z.object({
    event: z.literal("task-failed"),
    reason: z.string(),
  }),
  z.object({
    event: z.literal("task-closed"),
  }),
]);

type TaskEvent = z.infer<typeof taskEventSchema>;
```

### TaskState

Derived from replaying events through an `applyEvent` reducer. Generic — no phase-specific fields baked in. Thread IDs tracked per-executor and persisted via events.

```typescript
const taskStatusValues = [
  "pending", "planning", "reviewing-plan",
  "working", "verifying", "reviewing-work",
  "completing", "awaiting-followup",
  "completed", "failed",
] as const satisfies readonly string[];

const TERMINAL_STATUSES = ["completed", "failed"] as const;

interface TaskState {
  readonly taskId: string;
  readonly status: z.infer<typeof z.enum(taskStatusValues)>;
  readonly config: TaskConfig;
  readonly plan: string | null;
  readonly planReviewLoop: number;
  readonly workReviewLoop: number;
  readonly verificationAttempt: number;
  readonly lastReviewSummary: string | null;
  readonly lastVerificationResults: readonly VerificationCommandResult[] | null;
  readonly followupPrompt: string | null;
  readonly completionResults: readonly CompletionResult[] | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
```

Hydration: on worker startup, scan `stateDir/tasks/*.jsonl`, replay events, rebuild in-memory `Map<string, TaskState>`. Same as current.

---

## Docker Services (Controller-Side Gap)

The worker doesn't know about Docker. Services (postgres, redis) appear as TCP hostnames routed by Gondolin. The controller owns this:

1. Controller clones repo, reads `.agent-vm/docker-compose.yml`
2. Controller starts Docker Compose stack (`docker compose up -d --wait`)
3. Controller reads service IPs (static IPs from compose file or `docker inspect`)
4. Controller builds TCP host map: `postgres.local:5432 → 172.30.0.10:5432`
5. Controller calls `workerLifecycle.buildVmSpec()` → gets base `vmSpec.tcpHosts`
6. **Controller merges service TCP hosts into `vmSpec.tcpHosts`** before calling `createManagedVm()`
7. Worker boots, verification commands connect to `postgres.local:5432` transparently

This merge happens in the gateway zone orchestrator — it adds the service TCP hosts after `buildVmSpec()` returns but before passing to `createManagedVm()`. This is controller-side work, not part of agent-vm-worker.

---

## What Gets Deleted / Renamed

| Current (agent-vm-coding) | After (agent-vm-worker) |
|---|---|
| `agents/planner/planner-agent.ts` | `planner/planner.ts` — configured by phase config, not hardcoded |
| `agents/plan-reviewer/plan-reviewer-agent.ts` | `planner/plan-reviewer.ts` — same interface, configured |
| `agents/coder/coder-agent.ts` | `work-executor/codex-executor.ts` — behind WorkExecutor interface |
| `agents/code-reviewer/code-reviewer-agent.ts` | `work-reviewer/work-reviewer.ts` — runs verification + review |
| `agents/codex-client-factory.ts` | `work-executor/codex-executor.ts` — merged into executor |
| `agents/skill-registry.ts` | **Deleted** — skills are paths in config, no hardcoded enum |
| `agents/shared-types.ts` | `work-executor/executor-interface.ts` + `shared/skill-types.ts` |
| `coordinator/prompt-builder.ts` | `prompt/prompt-assembler.ts` — generic, not per-phase templates |
| `coordinator/run-sanity-retries.ts` | `work-reviewer/verification-runner.ts` — runs command list |
| `coordinator/task-ship.ts` | `completion/git-pr-completion.ts` — behind CompletionAction interface |
| `config.ts` | `config/worker-config.ts` — generic phases, not hardcoded skill enums |
| `verification.ts` | `work-reviewer/verification-runner.ts` — `parseCommand` stays |
| `state/*` | `state/*` — same pattern, generic events |
| `server.ts` | `server.ts` — same API shape |
| `git/*` | `git/*` — unchanged |
| `context/*` | `context/*` — unchanged |

---

## Migration Path

```
1. Create packages/agent-vm-worker with folder structure
2. Port state/ (event log, task state, hydration) — generic events
3. Port config/ — new Zod schemas with phase config
4. Port work-executor/ — extract executor interface, port Codex adapter
5. Port prompt/ — generic assembler replacing per-phase templates
6. Port planner/ — planner + plan-reviewer using executor + config
7. Port work-reviewer/ — verification runner + review agent
8. Port completion/ — extract git-pr, add completion factory
9. Port coordinator/ — wire everything through phase config
10. Port server.ts + main.ts (cmd-ts CLI)
11. Wire worker-gateway — unblock buildProcessSpec()
12. Verify — existing coding task flow works with coding config
```

Steps 1-10 are the refactor. Step 11 connects to the gateway abstraction. Step 12 proves it works end-to-end.
