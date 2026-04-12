# Agent Loop System Design Spec

## What This Is

The agent loop is the **process that runs inside a gateway VM**. It receives tasks, drives agents through a state machine, verifies results, and produces artifacts (PRs, fixes, reports). This is separate from the gateway abstraction (which is about how the controller starts and manages the VM).

The current implementation lives in the `coding-agents` branch as `packages/agent-vm-coding/` (to be renamed `agent-vm-worker`). This spec proposes restructuring it into a generic outer loop with pluggable agent types.

## The Problem

The current `agent-vm-coding` is a monolithic coding-specific package:

```
agent-vm-coding/  (current name — becomes agent-vm-worker)
├── outer-loop.ts         ← task → prompt → run Codex → verify → PR
├── agents/
│   ├── coding-agent/     ← Codex CLI wrapper with thread resumption
│   └── review-agent/     ← structured code review agent
├── verification.ts       ← lint + test
├── git/                  ← git operations
├── state/
│   ├── task-state.ts     ← persists codexThreadId, plan, status
│   └── event-log.ts      ← JSONL event log for hydration/crash recovery
└── server.ts             ← HTTP API
```

The outer loop (receive task → plan → execute → verify → complete/retry) is not specific to coding. An oncall agent follows the same state machine. A data migration agent does too. What varies between agent types is not the loop — it's what "plan", "execute", "verify", and "complete" mean, and what **state** the agent needs to persist between phases.

## What We Want

A generic outer loop that orchestrates any agent type through a state machine. Agent types plug in by implementing what each phase does. The loop handles state management, retry, timeout, error recovery, and task lifecycle. Agents handle domain logic and own their internal state.

Making a new agent type should require: **6 methods + a state type + a config + a Dockerfile.** Everything else — the loop, the state machine, the HTTP API, crash recovery, retry logic, plan verification, timeout handling — comes for free.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│  PACKAGE DEPENDENCY GRAPH                                           │
│                                                                     │
│  agent-loop                  ← generic, no domain knowledge         │
│       │                                                             │
│       │  implements AgentRunner<T>                                   │
│       │                                                             │
│  coding-agent-runner         ← coding domain: plan, verify, complete│
│       │                                                             │
│       │  uses for execute()                                         │
│       │                                                             │
│  coding-agent-codex          ← Codex CLI wrapper, thread management │
│                                                                     │
│  agent-vm-worker             ← HTTP server, composes all three      │
│       │                                                             │
│       ├── agent-loop                                                │
│       ├── coding-agent-runner                                       │
│       └── coding-agent-codex                                        │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Design Principles

### 1. The loop is a state machine with two verification loops

Tasks go through states with transitions. There are **two** verification loops — one for plan quality, one for execution quality:

```
┌─────────┐
│ pending  │
└────┬─────┘
     │ runner.initialize(task, workspace)
     ▼
┌──────────┐
│ planning  │ runner.plan(task, workspace, runnerState, retryContext?)
└────┬─────┘
     ▼
┌──────────────────┐
│ verifying-plan    │ runner.verifyPlan(task, workspace, runnerState)
└────┬─────────────┘
     │
     ├── approved ──────────────────────────┐
     │                                      │
     └── rejected + retries left            │
         │                                  │
         │  retryContext = planReview        │
         └──► back to planning              │
              (same thread — knows           │
               why plan was rejected)        │
                                            ▼
                                      ┌────────────┐
                                      │ executing   │
                                      └────┬───────┘
                                           ▼
                                      ┌────────────┐
                                      │ verifying   │
                                      └────┬───────┘
                                           │
                                           ├── passed → completing
                                           │
                                           └── failed + retries left
                                               └──► back to executing

                                      ┌─────────────┐
                                      │ completing    │
                                      └────┬────────┘
                                           ▼
                                      ┌─────────┐
                                      │  done    │ (terminal)
                                      └─────────┘

Any state can → failed (timeout, max retries, unrecoverable error)
```

**Two verification loops, different failure modes:**

```
Loop 1: PLAN QUALITY                    Loop 2: EXECUTION QUALITY
┌────────────────────────┐              ┌────────────────────────┐
│ planning ──► verifying-plan           │ executing ──► verifying │
│     ▲              │                  │     ▲              │    │
│     └── rejected ──┘                  │     └── failed ────┘    │
│                                       │                         │
│ "Is this a good plan?"                │ "Does the code work?"   │
│ Catches: wrong approach,              │ Catches: lint errors,   │
│ missing edge cases,                   │ test failures,          │
│ scope creep, bad decomposition        │ type errors             │
└────────────────────────┘              └─────────────────────────┘
```

**Why plan verification matters:** Without it, the agent can pick the wrong approach (offset pagination when the codebase uses cursor-based), execute perfectly, pass all tests, and produce a PR that gets rejected in human review. Plan verification catches approach-level mistakes BEFORE expensive execution.

### 2. Agents own their internal state — the loop persists it opaquely

**This is the biggest design insight, grounded in how the current Codex integration actually works.**

The current coding agent persists a `codexThreadId` and rehydrates the Codex conversation thread across retries and crash recovery. The thread IS the agent's memory — it knows what was already tried, what failed, what the codebase looks like. Killing the thread means starting from scratch.

The loop can't treat agents as stateless functions. Instead:

- Each agent runner has an **opaque state type** (`TRunnerState`)
- Every phase call returns updated runner state alongside its result
- The loop persists runner state as part of `TaskState`
- On retry or crash recovery, the loop passes the last saved runner state back to the agent
- The loop never inspects runner state — it's a black box

```
RUNNER STATE FLOWS THROUGH EVERY TRANSITION:

initialize()
  → { codexThreadId: "thd_abc", plan: undefined }
       │
plan() │ Codex thread learns the repo + produces plan
  → { codexThreadId: "thd_abc", plan: { summary, steps } }
       │
verifyPlan() │ review checks plan quality
  → { ..., planApproved: true }
       │
execute() │ Same thread writes code (knows the plan already)
  → { codexThreadId: "thd_abc", ..., changedFiles: ["src/..."] }
       │
verify() │ Runner runs lint/test + ReviewSubAgent
  → { ..., lastReview: { passed: false } }
       │
RETRY  │ verification.context: "test X failed: expected Y got Z"
       │ runnerState: same thread, same context, same memory
       │
execute() │ Codex thread knows what it tried + why it failed
  → { codexThreadId: "thd_abc", ..., changedFiles: ["src/...fixed"] }
       │
verify() │ passes this time
  → { ..., lastReview: { passed: true } }
       │
complete() │ creates PR using plan.summary as body
  → { artifact: "https://github.com/org/repo/pull/42" }

If the process crashes after execute(), hydrate() restores
{ codexThreadId: "thd_abc" } and the loop resumes at verify()
with the same Codex thread context.
```

### 3. Runners can own sub-agents internally

The current `coding-agents` branch has **two** agent roles: a coding agent (Codex) and a review agent (structured code review). This is an internal concern of the coding runner, not a generic loop concept.

**The runner internally composes its sub-agents.** The loop calls `verify()` and the runner decides whether that includes a code review step. An oncall agent wouldn't have a code reviewer.

### 4. Verification is domain-specific but has a common shape

Every agent type verifies differently, but the interface is the same:

```typescript
interface VerificationResult {
  readonly passed: boolean;
  readonly failures: readonly { readonly check: string; readonly output: string }[];
  readonly context: string;  // fed back to agent on retry
}
```

The loop uses `passed` to decide next state. The agent uses `context` to improve on retry.

### 5. Completion receives accumulated context

`complete()` needs the plan, execution results, and runner state. The runner receives its own state (which includes everything accumulated during plan/execute/verify) so it has full context for completion.

---

## The Interface

### Task

```typescript
interface AgentTask {
  readonly id: string;
  readonly type: string;              // 'coding' | 'oncall' | 'migration' | ...
  readonly prompt: string;
  readonly context: Record<string, unknown>;  // type-specific context
  readonly config: Record<string, unknown>;   // type-specific config
}
```

### Agent Runner (with opaque state)

```typescript
interface AgentRunner<TRunnerState = unknown> {
  /** Initialize runner state for a new task */
  initialize(task: AgentTask, workspace: string): Promise<{
    readonly runnerState: TRunnerState;
  }>;

  /** Plan the task — analyze context, produce a plan.
   *  retryContext comes from verifyPlan rejection. */
  plan(task: AgentTask, workspace: string, runnerState: TRunnerState, retryContext?: string): Promise<{
    readonly plan: PlanResult;
    readonly runnerState: TRunnerState;
  }>;

  /** Verify the plan before execution begins.
   *  Catches approach-level mistakes before expensive execution. */
  verifyPlan(task: AgentTask, workspace: string, runnerState: TRunnerState): Promise<{
    readonly verification: PlanVerificationResult;
    readonly runnerState: TRunnerState;
  }>;

  /** Execute the plan (or re-execute on retry with failure context) */
  execute(task: AgentTask, workspace: string, runnerState: TRunnerState, retryContext?: string): Promise<{
    readonly result: ExecutionResult;
    readonly runnerState: TRunnerState;
  }>;

  /** Verify the execution output. Runner decides what checks to run. */
  verify(task: AgentTask, workspace: string, runnerState: TRunnerState): Promise<{
    readonly verification: VerificationResult;
    readonly runnerState: TRunnerState;
  }>;

  /** Complete the task — produce the final artifact. */
  complete(task: AgentTask, workspace: string, runnerState: TRunnerState): Promise<{
    readonly completion: CompletionResult;
    readonly runnerState: TRunnerState;
  }>;

  /** Hydrate runner state from persisted storage (crash recovery). */
  hydrate?(persistedState: unknown): TRunnerState;
}
```

### Result Types

```typescript
interface PlanResult {
  readonly summary: string;
  readonly steps: readonly string[];
}

interface PlanVerificationResult {
  readonly approved: boolean;
  readonly findings: readonly { readonly severity: string; readonly description: string }[];
  readonly context: string;  // fed to plan() retryContext on rejection
}

interface ExecutionResult {
  readonly diffs: string;
  readonly filesChanged: readonly string[];
}

interface VerificationResult {
  readonly passed: boolean;
  readonly failures: readonly { readonly check: string; readonly output: string }[];
  readonly context: string;  // fed to execute() retryContext on failure
}

interface CompletionResult {
  readonly artifact: string;    // PR URL, incident update link, etc.
  readonly summary: string;
}
```

### Task State

```typescript
interface TaskState<TRunnerState = unknown> {
  readonly id: string;
  readonly status: 'pending' | 'planning' | 'verifying-plan' | 'executing' | 'verifying' | 'completing' | 'done' | 'failed';
  readonly retryCount: number;
  readonly planRetryCount: number;
  readonly maxRetries: number;
  readonly maxPlanRetries: number;
  readonly plan?: PlanResult;
  readonly lastPlanVerification?: PlanVerificationResult;
  readonly lastVerification?: VerificationResult;
  readonly completion?: CompletionResult;
  readonly runnerState?: TRunnerState;
  readonly error?: string;
  readonly startedAt: string;
  readonly updatedAt: string;
}
```

### The Outer Loop

```typescript
interface OuterLoopConfig {
  readonly maxRetries: number;
  readonly maxPlanRetries: number;
  readonly executionTimeoutMs: number;
  readonly verificationTimeoutMs: number;
}

interface OuterLoop {
  submitTask(task: AgentTask): Promise<string>;
  getTaskState(taskId: string): TaskState | undefined;
}
```

**Concurrency model for v1:** one active task per worker process/workspace. This preserves the current
`coding-agents` behavior, where a single Codex thread and one mutable workspace are active at a time.
Queuing and parallel task execution are future features, not part of the refactor.

Note: `listTasks()` and `cancelTask()` are **new features, not preserved behavior**. Added post-refactor.

---

## Inside CodingAgentRunner

```
CodingAgentRunner implements AgentRunner<CodingRunnerState>
│
│  internal components (not visible to the loop):
│
├── CodexExecutor (from coding-agent-codex)
│   ├── createThread()          → new Codex conversation
│   ├── resumeThread(threadId)  → continue existing conversation
│   ├── sendPrompt(thread, prompt) → get response
│   └── thread lifecycle management
│
├── ReviewSubAgent (internal)
│   ├── reviewPlan(plan, repoContext) → plan quality review
│   ├── reviewDiffs(diffs, plan)     → code quality review
│   └── returns findings + approval
│
├── GitOperations (internal)
│   ├── commitChanges(files, message)
│   ├── pushBranch(branch, remote)
│   └── createPullRequest(title, body, base)
│
└── Verification (internal)
    ├── runLint(workspace, command)
    ├── runTests(workspace, command)
    └── runTypecheck(workspace, command)


How CodingAgentRunner uses them:

initialize(task, workspace)
  └── CodexExecutor.createThread()
      → { codexThreadId: "thd_new" }

plan(task, workspace, state, retryContext?)
  └── CodexExecutor.sendPrompt(state.codexThreadId, planPrompt)
      → parse response into PlanResult
      → { plan, runnerState: { ...state, plan } }

verifyPlan(task, workspace, state)
  └── ReviewSubAgent.reviewPlan(state.plan, repoContext)
      → { approved: true/false, findings, context }

execute(task, workspace, state, retryContext?)
  └── CodexExecutor.sendPrompt(state.codexThreadId,
        retryContext ? retryPrompt(retryContext) : executePrompt(plan))
      → { result: { diffs, filesChanged }, runnerState: updated }

verify(task, workspace, state)
  ├── Verification.runLint(workspace, config.lintCommand)
  ├── Verification.runTests(workspace, config.testCommand)
  ├── if lint+test pass:
  │   └── ReviewSubAgent.reviewDiffs(diffs, plan)
  └── combine results → VerificationResult

complete(task, workspace, state)
  ├── GitOperations.commitChanges(state.changedFiles, commitMessage)
  ├── GitOperations.pushBranch(branchName, remote)
  └── GitOperations.createPullRequest(title, state.plan.summary, base)
      → { artifact: prUrl, summary }
```

### CodingRunnerState

```typescript
interface CodingRunnerState {
  readonly codexThreadId: string | undefined;
  readonly plan: PlanResult | undefined;
  readonly lastReview: ReviewResult | undefined;
  readonly changedFiles: readonly string[];
  readonly reviewIterations: number;
}
```

---

## Full Flow Example

```
submitTask({ prompt: "Add cursor pagination to GET /users" })
     │
     ▼
initialize()
  → creates Codex thread thd_abc
     │
     ▼
plan(task, ws, { codexThreadId: "thd_abc" })
  → Codex analyzes repo, proposes plan
  → plan: "1. Add page/limit params  2. Offset query  3. Tests"
     │
     ▼
verifyPlan(task, ws, state)
  → ReviewSubAgent: "Plan uses offset but codebase uses cursor.
                     Step 2 should use cursor-based query."
  → { approved: false, context: "Use cursor pagination pattern..." }
     │
     ▼ rejected — retry plan

plan(task, ws, state, retryContext: "Use cursor pagination pattern...")
  → Same Codex thread: "You're right, here's the revised plan..."
  → plan: "1. Add cursor param  2. Cursor query  3. Tests"
     │
     ▼
verifyPlan(task, ws, state)
  → ReviewSubAgent: "Plan now matches codebase patterns."
  → { approved: true }
     │
     ▼ approved — proceed to execution

execute(task, ws, state)
  → Same Codex thread writes cursor-based pagination code
     │
     ▼
verify(task, ws, state)
  → lint: pass  tests: 1 failure  "cursor decode error"
  → { passed: false, context: "Test cursor_test.ts:42 fails..." }
     │
     ▼ failed — retry execution

execute(task, ws, state, retryContext: "cursor_test.ts:42 fails...")
  → Same thread fixes the cursor decode bug
     │
     ▼
verify(task, ws, state)
  → lint: pass  tests: pass  review: pass
  → { passed: true }
     │
     ▼ passed

complete(task, ws, state)
  → git commit + push + PR
  → PR body uses state.plan.summary
  → { artifact: "github.com/org/repo/pull/42" }
     │
     ▼
done
```

---

## Making Agents Easy — From Spec to Running Agent

```
WHAT YOU NEED TO BUILD A NEW AGENT TYPE:

1. Define your runner state type
2. Implement 7 methods (initialize, plan, verifyPlan, execute, verify, complete, hydrate)
3. Write a gateway config
4. Write a Dockerfile

That's it. The loop, state machine, crash recovery, HTTP API,
retry logic, timeout handling — all free.
```

### The Composition Pattern

Every agent gateway process follows the same shape:

```typescript
// main.ts for ANY agent type

import { createAgentServer } from 'agent-loop/server';
import { createMyRunner } from 'my-agent-runner';

const config = loadConfig('/state/config.json');
const runner = createMyRunner(config);

createAgentServer({
  runner,
  port: 18789,
  ...config,
});
```

One function call. The runner is the only thing that varies.

### Example: Three Agent Types, Same Pattern

```
CODING AGENT
─────────────
Runner state: { codexThreadId, plan, changedFiles, lastReview }
initialize:   create Codex thread
plan:         Codex analyzes repo → plan
verifyPlan:   ReviewSubAgent checks plan quality
execute:      Codex writes code (same thread)
verify:       lint + test + code review
complete:     git commit + push + PR
Artifact:     Pull request URL

ONCALL AGENT
─────────────
Runner state: { alertContext, diagnosis, triedRemediations, llmSessionId }
initialize:   fetch alert + logs + metrics
plan:         LLM diagnoses root cause
verifyPlan:   check against runbook patterns, safety review
execute:      LLM generates fix (config change, code patch)
verify:       apply to staging, check service health + error rates
complete:     apply to prod + post to incident channel
Artifact:     Incident resolution link

DATA MIGRATION AGENT
─────────────────────
Runner state: { sourceSchema, targetSchema, generatedSql, rowCounts }
initialize:   connect to source + target DBs, introspect schemas
plan:         LLM generates migration strategy
verifyPlan:   check: all source tables covered? types compatible?
execute:      LLM generates SQL migration scripts
verify:       dry-run against staging DB, compare row counts
complete:     apply to production, generate report
Artifact:     Migration report with row counts + timing

ALL THREE USE THE SAME:
✓ OuterLoop state machine (with plan verification loop)
✓ Execution verification loop
✓ Retry with context
✓ Crash recovery
✓ HTTP API
✓ Task state persistence
```

### End-to-End: From Spec to Running Agent

```
1. Define runner state type (what does this agent remember?)
   → TypeScript interface + Zod schema for hydration

2. Implement AgentRunner<YourState> (7 methods)
   → Each method is independently testable
   → Mock the LLM/executor for unit tests

3. Create gateway config template
   → model, timeouts, domain-specific settings
   → agent-vm init --type yourtype scaffolds it

4. Create Dockerfile
   → base image + domain tools
   → agent-vm init --type yourtype scaffolds it

5. Create gateway lifecycle (from gateway abstraction spec)
   → implements GatewayLifecycle
   → buildVmSpec + buildProcessSpec

6. Register in the static lifecycle map
   → lifecycleByType.yourtype = yourLifecycle

7. Add --type yourtype to init

Then:
  agent-vm init myproject --type yourtype
  agent-vm build
  agent-vm controller start
  curl -X POST localhost:18791/tasks -d '{"prompt": "..."}'

Your agent is running in a sandboxed VM with secrets,
networking, crash recovery, and a full task lifecycle.
```

---

## Package Structure

```
packages/
├── agent-loop/                        ← generic outer loop
│   └── src/
│       ├── outer-loop.ts              ← state machine + task orchestration
│       ├── outer-loop.test.ts
│       ├── task-state.ts              ← TaskState management + persistence
│       ├── task-state.test.ts
│       ├── server.ts                  ← createAgentServer() helper
│       ├── types.ts                   ← AgentTask, AgentRunner, results
│       └── index.ts
│
├── coding-agent-runner/               ← coding-specific runner
│   └── src/
│       ├── coding-runner.ts           ← implements AgentRunner<CodingRunnerState>
│       ├── coding-runner.test.ts
│       ├── coding-runner-state.ts     ← CodingRunnerState type + hydration
│       ├── review-sub-agent.ts        ← structured review (internal to runner)
│       ├── git-operations.ts          ← git commit, push, PR creation
│       ├── verification.ts            ← lint + test + typecheck
│       ├── prompt-builder.ts          ← builds coding prompts from task context
│       └── index.ts
│
├── coding-agent-codex/                ← Codex CLI adapter
│   └── src/
│       ├── codex-executor.ts          ← wraps Codex CLI, manages thread lifecycle
│       ├── codex-executor.test.ts
│       ├── codex-thread.ts            ← thread create/resume/rebuild
│       └── index.ts
│
├── agent-vm-worker/                   ← the gateway process (HTTP server)
│   └── src/
│       ├── server.ts                  ← HTTP API: POST /tasks, GET /tasks/:id
│       ├── main.ts                    ← composes: outer-loop + coding-runner + codex
│       └── config.ts                  ← reads gateway config
│
└── (future)
    ├── coding-agent-claude/           ← Claude Code SDK adapter
    └── oncall-agent-runner/           ← oncall domain runner
    (no agent-vm-oncall needed — agent-vm-worker serves any runner type via config)
```

---

## What Changes vs Current agent-vm-coding (renamed to agent-vm-worker)

| Current (monolithic) | After (separated) | Notes |
|---------------------|-------------------|-------|
| `outer-loop.ts` has coding logic inline | `agent-loop/outer-loop.ts` is generic state machine | Loop doesn't know about git, Codex, or coding |
| Plan review logic is inline in `outer-loop.ts` | `verifyPlan()` is part of the generic runner interface | Existing behavior becomes an explicit reusable boundary |
| `codexThreadId` managed in outer loop | `CodingRunnerState.codexThreadId` in runner state | Loop persists it opaquely |
| Review agent called from outer loop | `CodingAgentRunner` internally owns `ReviewSubAgent` | Loop calls `verify()`, runner decides what that means |
| `state/task-state.ts` has coding-specific fields | `agent-loop/task-state.ts` generic + `runnerState` opaque | Loop state generic, runner state typed |
| `state/event-log.ts` JSONL for hydration | Same pattern, used by `hydrate()` | Crash recovery preserved |
| `server.ts` knows about coding | `agent-vm-worker/server.ts` thin HTTP → OuterLoop | Server just submits tasks and queries state |

## What Stays The Same (preserved behavior)

- HTTP API: `POST /tasks`, `GET /tasks/:id` (existing endpoints)
- Codex thread create/resume/rebuild lifecycle
- JSONL event log for crash recovery
- lint → test → review → PR workflow
- single active task per worker process/workspace
- Retry with failure context from verification
- `completed` is terminal (no awaiting-followup yet)

## What's New (explicitly new features)

| Feature | Status |
|---------|--------|
| `GET /tasks` (list all tasks) | **New** — add after refactor |
| `DELETE /tasks/:id` (cancel) | **New** — add after refactor |
| `awaiting-followup` state | **Deferred** — add post-refactor |
| `POST /tasks/:id/followup` | **Deferred** — depends on awaiting-followup |
| `createAgentServer()` helper | **New** — one-call composition |

---

## Relationship to Gateway Abstraction

The gateway abstraction (scope 1) handles: "how does the controller start `agent-vm-worker` in a VM?"

The agent loop (this doc) handles: "what does `agent-vm-worker` do once it's running?"

They connect at one point: `coding-gateway/lifecycle.ts` returns `startCommand: "agent-vm-worker serve --port 18789"`. That's it.

```
Gateway Abstraction (scope 1)           Agent Loop System (this doc)
─────────────────────────────           ────────────────────────────
"How to start the VM"                   "What runs inside the VM"

gateway-interface                       agent-loop
openclaw-gateway                        coding-agent-runner
coding-gateway                          coding-agent-codex

VM lifecycle, env vars, mounts,         Task state machine, prompt building,
mediated secrets, TCP routing,          agent execution, verification, git, PR
health checks, ingress, shell setup     Plan verification, crash recovery
```

The agent loop can be refactored before or after the gateway abstraction. They're independent. But the gateway abstraction should ship first because it unblocks the coding-gateway from plugging into the controller.

---

## Migration Path

```
Step 1: Create agent-loop package (generic loop + task state with opaque runner state)
Step 2: Create coding-agent-runner (extract runner with CodingRunnerState + review sub-agent)
Step 3: Create coding-agent-codex (extract Codex CLI wrapper + thread management)
Step 4: Rewrite agent-vm-worker/main.ts to compose the pieces
Step 5: Verify — existing coding task flow works identically
─────── refactor complete, no new features ──────
Step 6: Add Claude Code executor (coding-agent-claude)
Step 7: Add oncall runner (same agent-vm-worker, different runner via config)
Step 8: Add awaiting-followup state + followup API
Step 9: Add multi-task queueing / parallelism if needed
```

Steps 1-5 are a refactor of the existing `coding-agents` branch, including the current plan-review behavior, but moved behind generic runner boundaries. Steps 6-9 are the payoff.

---

## Open Questions

1. **Should `plan()` and `verifyPlan()` be optional?** Some simple agents (quick fixes, one-shot scripts) don't need planning. The loop could skip both if the runner doesn't implement them.

2. **Should `execute()` be streaming?** For long-running Codex/Claude sessions, the user might want progress. An alternative: `execute()` accepts an optional progress callback.

3. **How does workspace isolation work across retries?** The coding runner does `git reset` before retry. The oncall runner might build on previous attempts. This is runner-owned behavior.

4. **Where does the LLM model config live?** In the gateway config (`coding.json`). For v1, one configured model is used across the coding flow for that worker. If we later want different models for planning/execution/review, add explicit config fields like `planModel`, `executionModel`, and `reviewModel` to the gateway config rather than making model choice task-owned.

5. **Should the event log be part of the generic loop or runner-specific?** The loop already persists `TaskState` (including `runnerState`). That might be sufficient without a separate event log. The JSONL log could become a runner-internal concern for detailed audit trails.
