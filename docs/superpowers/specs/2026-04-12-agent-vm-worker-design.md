# agent-vm-worker Design Spec

## What This Is

agent-vm-worker is the process that runs inside a Gondolin VM. It receives tasks via HTTP, drives them through a plan loop and work loop, verifies results, and runs a wrapup phase where an agent handles completion actions (PRs, notifications, tickets). It is spec-driven — skills, instructions, verification commands, MCP servers, and wrapup actions are all configured, not hardcoded. "Coding" is one configuration of the loop system, not a special case.

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

The loop mechanics (plan loop, work loop with sanity retries, code review loop, error sanitization, close-while-running) are sound and ~80% reusable. The hardcoded agent wiring and config are what change.

## Connection to Gateway Abstraction

The gateway abstraction (merged to master as PR #4) defines how the controller starts a worker in a VM. The connection point is `workerLifecycle.buildProcessSpec()` in `packages/worker-gateway/` — currently throws `"agent-vm-worker is not present yet"`. Building agent-vm-worker unblocks this.

```
Controller                              VM
─────────                               ──
workerLifecycle.buildProcessSpec()
  → startCommand: "agent-vm-worker serve --port 18789"
  → healthCheck: { type: "http", port: 18789, path: "/health" }
  → guestListenPort: 18789

Controller creates VM per task (clone repos → boot VM → submit task → VM dies)
Worker boots, serves HTTP on 18789, runs one task, shuts down
```

The worker does not know about Gondolin, the controller, or Docker. It receives a merged config and serves HTTP. Services (postgres, redis) appear as TCP hostnames routed by Gondolin.

### Controller Architecture Change: Per-Task VMs

**This is a new controller code path, not a refit of the existing gateway model.** The current controller boots one long-lived gateway zone at startup (`startControllerRuntime` → `startGatewayZone`) and keeps it alive until restart/shutdown. That model fits OpenClaw — one gateway serves many conversations.

The worker model is different: **one VM per task.** This requires a new task-submission pipeline in the controller — separate from the existing zone lifecycle routes. The gateway abstraction itself (`GatewayLifecycle`, `buildVmSpec`, `buildProcessSpec`) is unchanged. The change is in the controller's orchestration layer: adding a per-task flow with controller-side lifecycle hooks.

### Controller-Side Lifecycle Hooks

Per-task setup and teardown are **controller-side hooks**, not `GatewayLifecycle` methods. The lifecycle stays static. The hooks are where per-task logic goes.

```
Controller receives task from external API
    │
    ▼
preStartGateway(taskInput, zoneConfig, secretResolver)     ← NEW (v1)
    → clone repo to workspaceDir (if repo provided)
    → read .agent-vm/config.json from cloned repo
    → merge: project config > gateway base config > Zod defaults
    → write effective config to stateDir/effective-worker.json
    → start Docker services, build extra TCP host map (future)
    │
    ▼
startGatewayZone()                                          ← EXISTING (unchanged)
    → lifecycle.prepareHostState(zone, secretResolver)       (static, no task input)
    → lifecycle.buildVmSpec(zone, secrets, ...)              (mounts workspace/state)
    → boot VM, run bootstrapCommand, startCommand
    → wait for health
    │
    ▼
POST /tasks { prompt, repo location, context }              ← to running worker
    │
    ▼
... worker runs plan → work → verify → review → wrapup ...
    │
    ▼
vm.close()                                                  ← EXISTING
    │
    ▼
postStopGateway(zoneConfig)                                 ← FUTURE (not v1)
    → stop Docker services
    → clean up temp files
    → tear down per-task host state
```

**Why controller-side hooks, not lifecycle methods:**
- `GatewayLifecycle.prepareHostState(zone, secretResolver)` only gets static zone config — no task input. By design: the lifecycle defines the VM/process contract for a gateway *type*, not per-task orchestration.
- OpenClaw proves this separation: its `prepareHostState` writes auth-profiles from 1Password (static, zone-level). Per-task clone/merge is a different concern.
- Per-task VMs are already a controller behavior change. Controller-side hooks are the natural home for per-task prep.

**For v1:** Only `preStartGateway`. Teardown is `vm.close()` which already exists. `postStopGateway` is future — for Docker service cleanup, temp file removal, etc.

### Required Changes to worker-gateway

1. **Config mounting:** The effective config lives at `stateDir/effective-worker.json`, written by `preStartGateway`. Since `buildVmSpec` already mounts `stateDir` → `/state`, the config is automatically available at `/state/effective-worker.json` inside the VM. The bootstrap command sets `WORKER_CONFIG_PATH=/state/effective-worker.json` — same pattern as OpenClaw uses `OPENCLAW_CONFIG_PATH`. The base checked-in gateway config stays untouched. No new mount convention needed.

2. **`prepareHostState()`** stays static. Does NOT clone repos or merge config. For v1, the worker gateway's `prepareHostState` may be empty — all per-task prep happens in `preStartGateway`.

---

## System Diagrams

### Per-Task VM Lifecycle

```
External API / Queue
    │
    │  { prompt, repo?, context? }
    ▼
┌─────────────────────────────────────────────────────────┐
│ CONTROLLER (host)                                        │
│                                                          │
│  1. Clone repo → workspaceDir (if repo provided)         │
│  2. Read .agent-vm/config.json from cloned repo          │
│  3. Merge: project config > gateway config > defaults    │
│  4. Write merged config → zone state                     │
│  5. Start Docker services if docker-compose.yml exists   │
│  6. Boot Gondolin VM with VFS mounts + TCP host map      │
│  7. POST /tasks { prompt, repo location, context }       │
│  8. Wait for task completion                             │
│  9. Shut down VM                                         │
└──────────┬──────────────────────────────────────────────┘
           │
           │ VFS mounts (3 required for worker gateway):
           │   workspaceDir       → /workspace           (cloned repo or empty)
           │   stateDir           → /state               (JSONL events, task logs)
           │   stateDir/worker.json → /config/worker.json  (merged config)
           │
           │ TCP host map:
           │   controller.vm.host:18800 → 127.0.0.1:18800
           │   postgres.local:5432      → 172.30.0.10:5432  (if Docker)
           │
           ▼
┌─────────────────────────────────────────────────────────┐
│ WORKER (inside Gondolin QEMU VM)                         │
│                                                          │
│  Reads /config/worker.json at startup                    │
│  Serves HTTP on :18789                                   │
│                                                          │
│  POST /tasks → runs one task through the loop            │
│  GET /tasks/:id → task state                             │
│  POST /tasks/:id/close → graceful stop                   │
│  GET /health → worker status                             │
│                                                          │
│  /workspace  = cloned repo (read-write VFS)              │
│  /state      = JSONL events (persisted across crashes)   │
│  /skills/*   = baked into VM image (read-only)           │
└─────────────────────────────────────────────────────────┘
```

### Config Assembly

```
┌───────────────────────────┐
│ Zod Defaults (in code)    │  provider: "codex", model: "latest-medium"
│ Lowest priority           │  verification: [{ test: "npm test" }]
└─────────────┬─────────────┘  wrapupActions: [{ git-pr, required }]
              │
              ▼ overridden by
┌───────────────────────────┐
│ Gateway Config (org-level)│  provider/model, skills, mcpServers
│ Mounted JSON in VM        │  wrapupActions, instructions, loop counts
└─────────────┬─────────────┘
              │
              ▼ overridden by
┌───────────────────────────┐
│ Project Config            │  verification commands, branchPrefix
│ .agent-vm/config.json     │  instructions overrides
│ Read from cloned repo     │
└───────────────────────────┘

Result: single merged WorkerConfig at /config/worker.json
```

### Task Data Flow

```
POST /tasks
  {
    prompt: "fix the login bug",
    repo: { repoUrl, baseBranch, workspacePath },  ← metadata, already cloned
    context: { ... }                                ← arbitrary passthrough
  }
      │
      ▼
┌──────────────────────────────────────────────────────────────┐
│ plan ◄── review feedback ──┐                                  │
│   │                         │                                  │
│   └─── reviewing-plan ──────┘  (planner keeps thread)         │
│              │                                                 │
│              ▼                                                 │
│ work ◄── fix with context ──┐                                  │
│   │                          │                                  │
│   └─── verify ──────────────┘  (work executor keeps thread)   │
│              │                                                 │
│              ▼                                                 │
│ reviewing-work ◄── fix ─────┐                                  │
│              │               │                                  │
│              └───────────────┘                                  │
│              │                                                 │
│              ▼                                                 │
│ wrapup (agent-driven)                                          │
│   agent calls tools: git-pr, slack-post                        │
│   coordinator checks required actions                          │
│              │                                                 │
│              ▼                                                 │
│ completed / failed                                             │
└──────────────────────────────────────────────────────────────┘
```

### Executor & Tools

```
                    ┌─────────────────────────┐
                    │ ExecutorCapabilities     │
                    │                         │
                    │ mcpServers: [deepwiki]   │  ← available to all phases
                    │ tools: []               │  ← work phase: no extra tools
                    └────────┬────────────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
         ┌────────┐    ┌────────┐    ┌────────────┐
         │Planner │    │ Work   │    │ Wrapup     │
         │Executor│    │Executor│    │ Executor   │
         │        │    │        │    │            │
         │ MCP: ✓ │    │ MCP: ✓ │    │ MCP: ✓     │
         │ Tools:─│    │ Tools:─│    │ Tools:     │
         │        │    │        │    │  git-pr ✓  │
         │        │    │        │    │  slack  ✓  │
         └────────┘    └────────┘    └────────────┘

Each executor is a WorkExecutor instance.
SDK manages tool calls internally.
Our code registers tools + MCP at creation time.
```

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
    │   ├── coordinator.ts               ← orchestrates plan + work + wrapup loops
    │   ├── coordinator.test.ts
    │   ├── coordinator-types.ts         ← Coordinator interface, CreateTaskInput
    │   └── coordinator-helpers.ts       ← sanitizeErrorMessage, buildTaskConfig
    ├── planner/
    │   ├── planner.ts                   ← plan phase: run executor with plan skills
    │   ├── planner.test.ts
    │   ├── plan-reviewer.ts             ← review plan: run executor, parse ReviewResult
    │   └── plan-reviewer.test.ts
    ├── work-executor/
    │   ├── executor-interface.ts         ← WorkExecutor interface (generic)
    │   ├── codex-executor.ts            ← Codex SDK adapter (first implementation)
    │   ├── codex-executor.test.ts
    │   └── executor-factory.ts          ← creates executor by provider name
    ├── work-reviewer/
    │   ├── work-reviewer.ts             ← orchestrates: verification → review agent
    │   ├── work-reviewer.test.ts
    │   ├── verification-runner.ts       ← runs configured commands (test, lint, typecheck)
    │   └── verification-runner.test.ts
    ├── wrapup/
    │   ├── wrapup-types.ts              ← WrapupAction interface
    │   ├── git-pr-action.ts             ← commit + push + PR (tool for wrapup agent)
    │   ├── git-pr-action.test.ts
    │   ├── slack-action.ts              ← post to Slack webhook (tool for wrapup agent)
    │   └── wrapup-action-registry.ts    ← maps action types to implementations
    ├── prompt/
    │   ├── prompt-assembler.ts          ← base + instructions + task + skills
    │   └── prompt-assembler.test.ts
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

### Two Layers

Config is assembled by the controller before the worker boots. The worker receives a single merged config.

**How repos get into the VM:** The controller clones repos to `workspaceDir` on the host. That directory is VFS-mounted into the VM at `/workspace` via Gondolin's realfs mount. One clone per repo, zero duplication. The controller can read `.agent-vm/config.json` from the host path before the VM boots, merge with gateway config, and pass the merged result to the worker. When the worker opens `/workspace`, the repos are already there.

**Per-task VM lifecycle:** Controller clones repos → reads project config → merges config → boots VM → submits task via `POST /tasks` → worker runs task → wrapup completes → VM shuts down. One VM per task, clean slate.

**Gateway config** (org-level, mounted as JSON file into VM):
- Provider/model defaults and per-phase overrides
- Phase skills (paths to SKILL.md files baked into VM image)
- Phase instructions (overrides for default prompt text)
- MCP servers (information sources available to agents)
- Loop counts, timeouts
- Wrapup actions (git-pr, slack-post, etc.)
- Idle timeout, state directory

**Project config** (`.agent-vm/config.json` in the cloned repo):
- Verification commands (test, lint, typecheck — repo-specific)
- Verification timeout
- Branch prefix
- Project-specific phase instruction overrides

**Merge precedence:** project > gateway > Zod defaults

The worker does not read `.agent-vm/config.json` itself. The controller reads it from the host-side workspace directory (after cloning) and passes the merged values to the worker via mounted config.

**What each layer can override:**

| Field | Gateway | Project |
|-------|---------|---------|
| provider/model | yes | no |
| skills | yes | no |
| mcpServers | yes | no |
| instructions | yes | yes |
| loop counts | yes | yes |
| verification commands | defaults | yes |
| verificationTimeoutMs | yes | yes |
| branchPrefix | yes | yes |
| wrapup actions | yes | no |

### Gateway Config Schema

```typescript
const skillReferenceSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
});

const mcpServerSchema = z.object({
  name: z.string().min(1),
  url: z.string().min(1),
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

const wrapupPhaseSchema = z.object({
  ...phaseExecutorSchema.shape,
  skills: z.array(skillReferenceSchema).default([]),
  instructions: z.string().optional(),
});

const verificationCommandSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
});

const wrapupActionSchema = z.discriminatedUnion("type", [
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
    wrapup: wrapupPhaseSchema.default({}),
  }).default({}),
  mcpServers: z.array(mcpServerSchema).default([]),
  verification: z.array(verificationCommandSchema).default([
    { name: "test", command: "npm test" },
    { name: "lint", command: "npm run lint" },
  ]),
  verificationTimeoutMs: z.number().positive().default(300_000),
  wrapupActions: z.array(wrapupActionSchema).default([{ type: "git-pr" }]),
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
    │ clone repos to /workspace (controller-side, before VM boot)
    ▼
 planning ◄─────────────────────┐
    │ planner.run(skills)        │ (thread continues across revisions)
    ▼                            │
 reviewing-plan                  │
    │ planReviewer.run(skills)   │
    │                            │
    ├── approved ──────┐         │
    │                  │         │
    └── feedback       │         │
        retries left? ─┤         │
        yes ───────────┘─────────┘ (feedback accumulates in planner thread)
        no → failed
                       │
                       ▼
 working ◄──────────────────────┐
    │ workExecutor.execute()     │ (thread continues across retries)
    ▼                            │
 verifying                       │
    │ run verification commands  │
    │                            │
    ├── all pass ──────┐         │
    │                  │         │
    └── fail           │         │
        retries left? ─┤         │
        yes ───────────┘─────────┘ (feed failure context back via fix())
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
 wrapping-up
    │ wrapup agent runs configured actions (git-pr, slack, etc.)
    │ agent-driven, non-deterministic
    ▼
 completed (terminal)

 failed (terminal) ← any state on max retries or unrecoverable error
```

### Skipping Review Phases (`maxReviewLoops: 0`)

Review is the subjective gate. Verification is the objective gate. They are independent.

- **`phases.plan.maxReviewLoops: 0`** — plan review is skipped entirely. The plan goes straight to the work phase.
- **`phases.work.maxReviewLoops: 0`** — work review is skipped entirely. After verification passes, work goes straight to wrapup. Verification always runs regardless — it's the objective quality gate (tests, lint, typecheck). Review is the optional subjective gate.
- Both can be 0 simultaneously — the worker runs: plan → work → verify → wrapup. No LLM review at any stage.

### No Followup in v1

After wrapup completes, the task is done. The VM shuts down. Followup (e.g., addressing PR review comments) is a future feature — it would re-enter the plan loop with a new prompt. For v1, each task is one-shot.

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
- Wrapup is an agent-driven phase (replaces imperative completion sequence)
- Prompt assembly is generic (base + instructions + task + skills)
- MCP servers configured at gateway level, available to all phases

---

## Work Executor Interface

The generic plug point for AI providers. The interface does not bake in provider-specific assumptions. Codex is the first implementation; Claude throws "not implemented yet" (same pattern as `workerLifecycle.buildProcessSpec()`).

The executor handles tool calls and MCP sessions internally — our interface doesn't dispatch individual tool invocations. We tell the executor what tools and MCP servers are available at creation time. The SDK (Codex, Claude) manages the tool call loop.

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
  | { readonly type: "skill"; readonly name: string; readonly content: string };

/** Passed to the executor factory — tells the SDK what tools/MCP are available */
interface ExecutorCapabilities {
  /** MCP servers the executor can connect to (from gateway config) */
  readonly mcpServers: readonly { readonly name: string; readonly url: string }[];
  /** Tools the executor can call (for wrapup: git-pr, slack-post, etc.) */
  readonly tools: readonly ToolDefinition[];
}

interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly execute: (params: Record<string, unknown>) => Promise<unknown>;
}
```

Note: `StructuredInput` uses `content` (the text of the skill), not `path`. The worker reads skill files from the VM filesystem and passes the content. The executor never sees file paths. Each provider adapter translates `StructuredInput` into its native format — Codex passes skills as file references, Claude would pass them as text blocks.

### How Tools and MCP Flow Through

```
Gateway config → mcpServers: [{ name: "deepwiki", url: "..." }]
               → wrapupActions: [{ type: "git-pr", required: true }]

Coordinator creates executor:
  createWorkExecutor("codex", "latest-medium", {
    mcpServers: config.mcpServers,          // available for all phases
    tools: [],                               // work phase: no extra tools
  })

Coordinator creates wrapup executor:
  createWorkExecutor("codex", "latest-medium", {
    mcpServers: config.mcpServers,
    tools: wrapupActionsAsTools(config),     // git-pr, slack-post as callable tools
  })
```

The work executor has MCP servers but no wrapup tools. The wrapup executor has both. The SDK manages the tool call loop — if the wrapup agent decides to create a PR, it calls the `git-pr` tool, the SDK dispatches to our `ToolDefinition.execute`, and the result flows back to the agent.

### Executor Factory

```typescript
function createWorkExecutor(
  provider: string,
  model: string,
  capabilities: ExecutorCapabilities,
): WorkExecutor {
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

### Thread Continuity Rules

- **Planner:** has thread continuity across plan-review loops. When review gives feedback and loops back, the planner continues the same thread — feedback accumulates instead of starting from scratch. Fresh thread per task, not per revision. The planner uses `execute()` on first call and `fix()` on subsequent revisions.
- **Work executor:** has thread continuity across verification retries. Same pattern — `execute()` on first call, `fix()` with failure context on retries. `resumeOrRebuild()` for crash recovery using the persisted `workThreadId`.
- **Plan-reviewer, work-reviewer, and wrapup agent:** single-shot executors. Fresh thread per invocation — they evaluate a snapshot, they don't accumulate context.

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
| wrapup | "Complete the task by running the configured wrapup actions. You have access to: git (commit, push, PR), Slack (webhook post). Decide which actions to take based on the task results." |

If `phases.plan.instructions` is set in config, it replaces the default. The base prompt is always prepended regardless.

### 3. Task Input (from POST body)

- Task prompt (what to do)
- Repo location (if provided — repoUrl, baseBranch, workspacePath)
- Context (arbitrary key-value data — alertId, service name, links, etc.)
- Skills (appended as structured inputs — the worker reads the file from the VM filesystem and passes the content as text to the executor)
- Plan (for work/review phases — the approved plan from the plan loop)
- Failure context (for retries — verification output, review comments)

The `context` field from the task input is serialized as text and included in the prompt. This is how non-repo metadata (alert IDs, service names, Grafana links) reaches the model. Without this, triage tasks would have no input data.

The agent also gathers its own context using MCP servers, the repo itself, and skills. We pre-load `context` into the prompt; the agent discovers the rest.

Final assembled input: `[base + instructions + task prompt + context + repo info (text), ...skills (structured)]`

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

Same `parseCommand` safety from current `verification.ts` — tokenizes the command string into an argv array without using a shell. `"pnpm vitest run"` becomes `execa('pnpm', ['vitest', 'run'])` (direct exec). Shell operators (`|`, `&`, `;`, `>`, `<`, `` ` ``, `$(`) are rejected. This is defense-in-depth — verification commands come from `.agent-vm/config.json` in the repo, so anyone who can push can set them. Even though the VM is already sandboxed by Gondolin, preventing shell injection inside the sandbox is good practice. If a project needs complex commands (e.g., `cd packages/frontend && npm test`), wrap it in a script file and configure `command: "bash scripts/test-frontend.sh"`.

---

## Wrapup (Agent-Driven)

Wrapup replaces the imperative completion sequence from `agent-vm-coding`. Instead of the coordinator running `git commit → push → PR → slack` in order, the wrapup phase is an LLM call where the agent decides how to execute the configured actions.

### How It Works

1. Coordinator enters `wrapping-up` state
2. Creates a wrapup executor (single-shot, fresh thread)
3. Assembles prompt: base + wrapup instructions + task results (plan, work output, verification results) + available actions
4. The wrapup agent has access to tools: git operations (commit, push, PR), Slack webhook, etc.
5. Agent decides what to do based on the task results and the configured actions
6. Agent is non-deterministic — it writes PR descriptions, chooses Slack message content, etc.

### Configured Actions

Each action is either **required** or **optional**. Required actions must succeed for the task to complete. Optional actions are best-effort.

```typescript
const wrapupActionSchema = z.discriminatedUnion("type", [
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
```

The config tells the agent what actions are available and which are required. The agent decides how to execute them (PR title, Slack message content, etc.).

### Wrapup Action Interface

Actions are tools the wrapup agent can call, registered via `ExecutorCapabilities.tools`:

```typescript
interface WrapupActionResult {
  readonly type: string;
  readonly artifact: string;
  readonly success: boolean;
}
```

The wrapup actions (git-pr, slack-post) are registered as `ToolDefinition` instances in the executor's capabilities. The SDK manages the tool call loop — the agent calls tools, the SDK dispatches to our implementations, results flow back to the agent.

### Failure Handling

All configured actions are available to the agent. If the agent calls git-pr and it fails, the agent can still call slack-post to report the failure. The agent sees errors from each action and adapts. Results are recorded in the `wrapup-result` event.

**After wrapup completes, the coordinator checks required actions.** If any action marked `required: true` was not successfully executed, the task is marked `failed` with a reason listing the missing required actions. This prevents a coding task from reaching `completed` without a PR.

---

## HTTP API

Hono + `@hono/zod-validator`. Same patterns as the rest of the repo.

### Routes

```
POST /tasks                    → submit new task
GET  /tasks/:id                → get task state
POST /tasks/:id/close          → close task (controller calls this)
GET  /health                   → worker health + active task info
```

No followup route in v1.

### Request Schemas

The controller owns all preboot decisions (cloning, config merge). The worker receives a normalized payload. Repos are already cloned to `/workspace` — the worker gets the metadata (URL, branch, path) so it can create PRs, set git config, etc.

```typescript
const repoLocationSchema = z.object({
  repoUrl: z.string().min(1),          // origin URL (for PR creation, commit metadata)
  baseBranch: z.string().min(1),       // branch that was cloned
  workspacePath: z.string().min(1),    // path inside VM, e.g. "/workspace"
});

const createTaskRequestSchema = z.object({
  prompt: z.string().min(1),
  repo: repoLocationSchema.nullable().default(null),  // v1: single repo, nullable
  context: z.record(z.string(), z.unknown()).default({}),  // arbitrary key-value passthrough
});
```

Examples:

```json
// Coding task
{
  "prompt": "fix the login bug in src/auth/login.ts",
  "repo": {
    "repoUrl": "https://github.com/org/repo.git",
    "baseBranch": "main",
    "workspacePath": "/workspace"
  },
  "context": {}
}

// Oncall triage (has a repo for code context)
{
  "prompt": "triage this alert — postgres connection pool exhausted",
  "repo": {
    "repoUrl": "https://github.com/org/payments-api.git",
    "baseBranch": "main",
    "workspacePath": "/workspace"
  },
  "context": {
    "alertId": "INC-4521",
    "service": "payments-api",
    "grafanaUrl": "https://grafana.internal/d/abc123"
  }
}

// Task without a repo
{
  "prompt": "summarize this week's incidents and post to #eng-updates",
  "repo": null,
  "context": {
    "slackChannel": "#eng-updates",
    "dateRange": "2026-04-06/2026-04-12"
  }
}
```

`repo` is the cloned repo location. `context` is passthrough — the controller forwards whatever the external caller sent. The agent uses it as part of its prompt. No schema enforcement on `context` values — it's `Record<string, unknown>`.

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
  "verification", "work-review", "wrapup",
] as const satisfies readonly string[];

const phaseNameSchema = z.enum(phaseNames);

const taskEventSchema = z.discriminatedUnion("event", [
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
    threadId: z.string(),  // planner thread ID — persisted for plan revision continuity
  }),
  z.object({
    event: z.literal("work-started"),
    threadId: z.string(),  // work executor thread ID — persisted for crash recovery
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
    event: z.literal("wrapup-result"),
    actions: z.array(z.object({
      type: z.string(),
      artifact: z.string().optional(),
      success: z.boolean(),
    })),
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

Derived from replaying events through an `applyEvent` reducer. Thread IDs tracked per-executor and persisted via events.

```typescript
const taskStatusValues = [
  "pending", "planning", "reviewing-plan",
  "working", "verifying", "reviewing-work",
  "wrapping-up", "completed", "failed",
] as const satisfies readonly string[];

const TERMINAL_STATUSES = ["completed", "failed"] as const;

interface TaskState {
  readonly taskId: string;
  readonly status: z.infer<typeof z.enum(taskStatusValues)>;
  readonly config: TaskConfig;
  readonly plan: string | null;
  readonly plannerThreadId: string | null;   // persisted for plan revision continuity
  readonly workThreadId: string | null;      // persisted for crash recovery via resumeOrRebuild
  readonly planReviewLoop: number;
  readonly workReviewLoop: number;
  readonly verificationAttempt: number;
  readonly lastReviewSummary: string | null;
  readonly lastVerificationResults: readonly VerificationCommandResult[] | null;
  readonly wrapupResults: readonly WrapupActionResult[] | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
```

Hydration: on worker startup, scan `stateDir/tasks/*.jsonl`, replay events, rebuild in-memory `Map<string, TaskState>`. Same as current.

---

## Repo Preparation (Controller-Side Orchestration)

**v1: single repo, nullable.** The controller receives a task with an optional repo. If present, it clones the repo to `workspaceDir` on the host. If absent (e.g., oncall triage), `/workspace` is empty. Multi-repo is a future extension.

**Why the controller owns the clone, not `prepareHostState`:** The `GatewayLifecycle.prepareHostState(zone, secretResolver)` hook only receives static zone config and the secret resolver — it has no access to per-task input (repo URL, branch, prompt). Since the per-task VM model means "one VM per task," the clone happens in the controller's task submission flow before calling `startGatewayZone`:

```
Controller receives task → clone repo → read project config → merge config
→ write merged config to zone state → startGatewayZone() → VM boots
→ POST /tasks to worker
```

The `worker-gateway.prepareHostState()` is reserved for gateway-specific prep that doesn't depend on task input (if any). For v1, the worker gateway's `prepareHostState` may be empty — all prep happens in the controller's task orchestration layer.

**Step by step:**

1. Controller receives task input (prompt, optional repo URL + branch, context) via API or queue
2. If repo is provided: controller clones it into `zone.gateway.workspaceDir` on the host
3. Controller reads `.agent-vm/config.json` from the cloned repo (if it exists)
4. Controller merges project config with gateway config → writes merged config to a known path in zone state (e.g., `stateDir/worker.json`)
5. Controller calls `startGatewayZone()` — `buildVmSpec()` mounts `workspaceDir` → `/workspace`, `stateDir` → `/state`, and the config file → `/config/worker.json`
6. VM boots, worker reads `/config/worker.json` at startup
7. Controller sends `POST /tasks { prompt, repo location, context }` to the running worker

**Per-task VM lifecycle:** One VM per task. Controller clones → merges config → boots VM → submits task → worker runs → wrapup completes → controller shuts down VM. Clean slate for each task.

---

## Docker Services (Controller-Side Gap)

The worker doesn't know about Docker. Services (postgres, redis) run as Docker containers on the HOST, not inside the VM. They appear inside the VM as TCP hostnames routed by Gondolin's synthetic DNS + TCP host mapping. The connection is network (TCP), not filesystem (VFS).

```
Host:  docker compose up → postgres at 172.30.0.10:5432
       ↓ (Gondolin TCP host mapping)
VM:    postgres.local:5432 → routes through Gondolin → 172.30.0.10:5432
       Worker code: psql postgres.local:5432  ← works transparently
```

The controller owns this setup:

1. Controller clones repo to `workspaceDir`, reads `.agent-vm/docker-compose.yml`
2. Controller starts Docker Compose stack on the host (`docker compose up -d --wait`)
3. Controller reads service IPs (static IPs from compose file or `docker inspect`)
4. Controller builds TCP host map: `postgres.local:5432 → 172.30.0.10:5432`
5. Controller calls `workerLifecycle.buildVmSpec()` → gets base `vmSpec.tcpHosts`
6. **Controller merges service TCP hosts into `vmSpec.tcpHosts`** before calling `createManagedVm()`
7. Worker boots, verification commands connect to `postgres.local:5432` transparently

This is controller-side work, not part of agent-vm-worker. The first version of the worker can ship without Docker service support — tasks that don't need postgres/redis work immediately. Docker service routing is additive.

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
| `coordinator/task-ship.ts` | `wrapup/git-pr-action.ts` — tool for wrapup agent, not imperative step |
| `config.ts` | `config/worker-config.ts` — generic phases, MCP servers, wrapup actions |
| `verification.ts` | `work-reviewer/verification-runner.ts` — `parseCommand` stays |
| `state/*` | `state/*` — same pattern, generic events, thread IDs persisted |
| `server.ts` | `server.ts` — same API shape, no followup route in v1 |
| `git/*` | `git/*` — unchanged |

---

## Migration Path

```
1. Create packages/agent-vm-worker with folder structure
2. Port state/ (event log, task state, hydration) — generic events + thread ID persistence
3. Port config/ — new Zod schemas with phase config, MCP servers, wrapup actions
4. Port work-executor/ — extract generic executor interface, port Codex adapter
5. Port prompt/ — generic assembler replacing per-phase templates
6. Port planner/ — planner + plan-reviewer using executor + config (planner keeps thread)
7. Port work-reviewer/ — verification runner + review agent
8. Build wrapup/ — agent-driven wrapup replacing imperative completion
9. Port coordinator/ — wire everything through phase config
10. Port server.ts + main.ts (cmd-ts CLI)
11. Wire worker-gateway — unblock buildProcessSpec()
12. Verify — existing coding task flow works with coding config
```

Steps 1-10 are the refactor. Step 11 connects to the gateway abstraction. Step 12 proves it works end-to-end.
