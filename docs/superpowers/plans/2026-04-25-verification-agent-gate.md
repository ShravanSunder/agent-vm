# Verification Agent Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dedicated verification-agent phase that runs exactly once per work cycle, gates the reviewer, and prevents wrapup unless verification passed and review approved.

**Architecture:** Task requests carry a required prose `verification` instruction string. Worker config owns verifier role defaults, prompt text, timeout, and skills. The coordinator runs each work cycle as `worker -> verifier -> reviewer`, skips review when verification fails, sends verifier/reviewer feedback back to the same work thread once per cycle, and fails terminally on verifier infrastructure errors or exhausted cycles.

**Tech Stack:** TypeScript, Zod, Vitest, Hono, Codex executor local MCP tools, existing worker event log/state replay.

**Scope note:** This is the upstream `agent-vm` implementation plan. It intentionally keeps deployment-specific packaging out of scope; downstream platform repos can adapt their deployment files after this generic worker lifecycle change lands.

---

## File Structure

The implementation should keep phase responsibilities separate:

- `packages/agent-vm-worker/src/state/task-event-types.ts`
  - Adds task-level `verification` prose, verifier report schemas, `verifier-turn` event, and `verification-outcome` status.
- `packages/agent-vm-worker/src/config/worker-config.ts`
  - Adds `phases.verification` config for verifier prompt/model/timeout/skills.
  - Removes task-agnostic `verification` command list from `worker.json`.
- `packages/agent-vm-worker/src/prompt/prompt-defaults.ts`
  - Adds `verification-agent` role defaults and removes reviewer-owned `run_validation` language.
- `packages/agent-vm-worker/src/prompt/message-builders.ts`
  - Adds verifier prompts and changes reviewer/revise prompts to consume `VerificationReport`.
- `packages/agent-vm-worker/src/verification-phase/verification-cycle.ts`
  - New phase runner that parses verifier JSON and returns one report per work cycle.
- `packages/agent-vm-worker/src/work-phase/work-cycle.ts`
  - Changes the cycle orchestration from `worker -> reviewer -> worker` to `worker -> verifier -> reviewer -> worker`.
- `packages/agent-vm-worker/src/coordinator/task-runner.ts`
  - Creates the verification thread, emits verifier events, and hard-gates wrapup.
- `packages/agent-vm-worker/src/coordinator/coordinator-types.ts`
  - Adds `verification` to worker task input.
- `packages/agent-vm-worker/src/coordinator/coordinator-helpers.ts`
  - Persists `verification` in `TaskConfig`.
- `packages/agent-vm-worker/src/server.ts`
  - Requires `verification` on direct worker task submission.
- `packages/agent-vm/src/config/resource-contracts/resource-contract-schemas.ts`
  - Requires `verification` on controller worker task requests.
- `packages/agent-vm/src/controller/task-config-builder.ts`
  - Copies task-level `verification` into `TaskConfig`.
- `packages/agent-vm/src/cli/init-command.ts`
  - Adds `phases.verification`, emits `verification-agent.md`, and removes top-level `verification` from scaffolded worker configs.
- `packages/agent-vm/src/cli/init-command.test.ts`
  - Covers the scaffolded verification phase config and editable verifier prompt.
- `docs/reference/configuration/worker-json.md`
  - Documents verifier phase config instead of static command lists.
- `docs/subsystems/worker-task-pipeline.md`
  - Updates lifecycle docs to match code.

## Cycle Contract

One work cycle means:

```text
worker turn
  -> verifier turn exactly once
     -> if passed: reviewer turn exactly once
        -> if reviewer approved: return approved work result
        -> if reviewer rejected: worker revise turn, next cycle
     -> if failed: worker revise turn, next cycle
     -> if infra-error: throw terminal task failure
```

Schema-repair nudges for malformed JSON are allowed once for verifier and once for reviewer. They are parser repair attempts, not semantic verifier/reviewer turns. They do not count as a second reviewer for the cycle because they ask for the same decision in the required JSON shape.

## Task 1: Add Task-Level Verification Contract

**Files:**
- Modify: `packages/agent-vm-worker/src/state/task-event-types.ts`
- Modify: `packages/agent-vm-worker/src/coordinator/coordinator-types.ts`
- Modify: `packages/agent-vm-worker/src/coordinator/coordinator-helpers.ts`
- Modify: `packages/agent-vm-worker/src/server.ts`
- Modify: `packages/agent-vm/src/config/resource-contracts/resource-contract-schemas.ts`
- Modify: `packages/agent-vm/src/controller/task-config-builder.ts`
- Test: `packages/agent-vm-worker/src/server.test.ts`
- Test: `packages/agent-vm-worker/src/coordinator/coordinator.test.ts`
- Test: `packages/agent-vm/src/config/resource-contracts/resource-contract-schemas.test.ts`
- Test: `packages/agent-vm/src/controller/http/controller-http-routes.test.ts`

- [ ] **Step 1: Write failing schema tests for required task verification**

Add worker-server request coverage in `packages/agent-vm-worker/src/server.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createTaskRequestSchema } from './server.js';

describe('createTaskRequestSchema verification', () => {
	it('requires verification instructions on worker task submission', () => {
		const result = createTaskRequestSchema.safeParse({
			taskId: 'task-1',
			prompt: 'Fix the failing test',
			repos: [],
			context: {},
		});

		expect(result.success).toBe(false);
	});

	it('accepts verification instructions on worker task submission', () => {
		const result = createTaskRequestSchema.parse({
			taskId: 'task-1',
			prompt: 'Fix the failing test',
			verification: 'Run the affected test and prove the new behavior works.',
			repos: [],
			context: {},
		});

		expect(result.verification).toBe('Run the affected test and prove the new behavior works.');
	});
});
```

Add controller request coverage in `packages/agent-vm/src/config/resource-contracts/resource-contract-schemas.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { workerTaskRequestSchema } from './resource-contract-schemas.js';

describe('workerTaskRequestSchema verification', () => {
	it('requires task-level verification instructions', () => {
		const result = workerTaskRequestSchema.safeParse({
			prompt: 'Fix the failing test',
			repos: [],
			context: {},
			resources: { externalResources: {} },
		});

		expect(result.success).toBe(false);
	});

	it('accepts task-level verification instructions', () => {
		const result = workerTaskRequestSchema.parse({
			prompt: 'Fix the failing test',
			verification: 'Run the affected test and any adjacent regression checks.',
			repos: [],
			context: {},
			resources: { externalResources: {} },
		});

		expect(result.verification).toBe('Run the affected test and any adjacent regression checks.');
	});
});
```

- [ ] **Step 2: Run failing schema tests**

Run:

```bash
pnpm vitest run packages/agent-vm-worker/src/server.test.ts packages/agent-vm/src/config/resource-contracts/resource-contract-schemas.test.ts
```

Expected: FAIL because `verification` is not yet required or preserved.

- [ ] **Step 3: Add `verification` to task schemas and config builders**

In `packages/agent-vm-worker/src/state/task-event-types.ts`, change `taskConfigSchema`:

```ts
export const taskConfigSchema = z.object({
	taskId: z.string().min(1),
	prompt: z.string().min(1),
	verification: z.string().min(1),
	repos: z.array(repoLocationSchema),
	context: z.record(z.string(), z.unknown()),
	effectiveConfig: workerConfigSchema,
});
```

In `packages/agent-vm-worker/src/coordinator/coordinator-types.ts`, change `CreateTaskInput`:

```ts
export interface CreateTaskInput {
	readonly taskId: string;
	readonly prompt: string;
	readonly verification: string;
	readonly repos?: readonly RepoLocation[];
	readonly context?: Record<string, unknown>;
}
```

In `packages/agent-vm-worker/src/coordinator/coordinator-helpers.ts`, change `buildTaskConfig`:

```ts
export function buildTaskConfig(input: CreateTaskInput, config: WorkerConfig): TaskConfig {
	return {
		taskId: input.taskId,
		prompt: input.prompt,
		verification: input.verification,
		repos: [...(input.repos ?? [])],
		context: input.context ?? {},
		effectiveConfig: config,
	};
}
```

In `packages/agent-vm-worker/src/server.ts`, change `createTaskRequestSchema`:

```ts
export const createTaskRequestSchema = z.object({
	taskId: z.string().min(1),
	prompt: z.string().min(1),
	verification: z.string().min(1),
	repos: z.array(repoLocationSchema).default([]),
	context: z.record(z.string(), z.unknown()).default({}),
});
```

In `packages/agent-vm/src/config/resource-contracts/resource-contract-schemas.ts`, change `workerTaskRequestSchema`:

```ts
export const workerTaskRequestSchema = z
	.object({
		prompt: z.string().min(1).max(10_000),
		verification: z.string().min(1).max(10_000),
		repos: z
			.array(repoTargetSchema)
			.max(20)
			.default(() => []),
		context: z.record(z.string(), z.unknown()).default(() => ({})),
		resources: workerTaskResourcesSchema,
	})
	.strict();
```

In `packages/agent-vm/src/controller/task-config-builder.ts`, change `buildTaskConfigFromPreparedInput`:

```ts
export function buildTaskConfigFromPreparedInput(
	prepared: BuildTaskConfigFromPreparedInput,
): TaskConfig {
	return {
		taskId: prepared.taskId,
		prompt: prepared.input.prompt,
		verification: prepared.input.verification,
		repos: prepared.repos.map((repo) => ({
			repoUrl: repo.repoUrl,
			baseBranch: repo.baseBranch,
			workspacePath: repo.workspacePath,
		})),
		context: prepared.input.context,
		effectiveConfig: prepared.effectiveConfig,
	};
}
```

- [ ] **Step 4: Update test task submissions to include verification**

Search for task submissions missing verification:

```bash
rg -n "prompt: '.*'|prompt: \\\".*\\\"" packages/agent-vm-worker/src packages/agent-vm/src docs -g '*.ts' -g '*.md'
```

For each worker/controller task request fixture, add:

```ts
verification: 'Run the task-specific checks and confirm the requested behavior works.',
```

For JSON request examples, add:

```json
"verification": "Run the task-specific checks and confirm the requested behavior works."
```

- [ ] **Step 5: Run schema tests**

Run:

```bash
pnpm vitest run packages/agent-vm-worker/src/server.test.ts packages/agent-vm/src/config/resource-contracts/resource-contract-schemas.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit task contract**

Run:

```bash
git add packages/agent-vm-worker/src/state/task-event-types.ts packages/agent-vm-worker/src/coordinator/coordinator-types.ts packages/agent-vm-worker/src/coordinator/coordinator-helpers.ts packages/agent-vm-worker/src/server.ts packages/agent-vm/src/config/resource-contracts/resource-contract-schemas.ts packages/agent-vm/src/controller/task-config-builder.ts packages/agent-vm-worker/src/server.test.ts packages/agent-vm/src/config/resource-contracts/resource-contract-schemas.test.ts packages/agent-vm-worker/src/coordinator/coordinator.test.ts packages/agent-vm/src/controller/http/controller-http-routes.test.ts
git commit -m "feat: require worker task verification instructions

Co-authored-by: Codex <noreply@openai.com>"
```

## Task 2: Add Verification Phase Config And Prompt Role

**Files:**
- Modify: `packages/agent-vm-worker/src/config/worker-config.ts`
- Modify: `packages/agent-vm-worker/src/prompt/prompt-defaults.ts`
- Modify: `packages/agent-vm-worker/src/prompt/prompt-defaults.test.ts`
- Modify: `packages/agent-vm-worker/src/prompt/prompt-assembler.test.ts`
- Modify: `packages/agent-vm-worker/src/index.ts`
- Modify: `packages/agent-vm/src/cli/init-command.ts`
- Modify: `packages/agent-vm/src/cli/init-command.test.ts`
- Test: `packages/agent-vm-worker/src/config/worker-config.test.ts`
- Test: `packages/agent-vm/src/cli/init-command.test.ts`

- [ ] **Step 1: Write failing config tests for verification phase**

In `packages/agent-vm-worker/src/config/worker-config.test.ts`, add:

```ts
test('defaults verification phase config', () => {
	const parsed = workerConfigSchema.parse({
		phases: {
			plan: {
				cycle: { kind: 'review', cycleCount: 1 },
				agentInstructions: null,
				reviewerInstructions: null,
			},
			work: {
				cycle: { kind: 'review', cycleCount: 2 },
				agentInstructions: null,
				reviewerInstructions: null,
			},
			wrapup: { instructions: null },
		},
	});

	expect(parsed.phases.verification.instructions).toBe(null);
	expect(parsed.phases.verification.turnTimeoutMs).toBe(900_000);
	expect(parsed.phases.verification.skills).toEqual([]);
});

test('rejects legacy top-level verification command list', () => {
	const result = workerConfigSchema.safeParse({
		phases: {
			plan: {
				cycle: { kind: 'review', cycleCount: 1 },
				agentInstructions: null,
				reviewerInstructions: null,
			},
			work: {
				cycle: { kind: 'review', cycleCount: 2 },
				agentInstructions: null,
				reviewerInstructions: null,
			},
			wrapup: { instructions: null },
		},
		verification: [{ name: 'test', command: 'pnpm test' }],
	});

	expect(result.success).toBe(false);
});
```

- [ ] **Step 2: Run failing config tests**

Run:

```bash
pnpm vitest run packages/agent-vm-worker/src/config/worker-config.test.ts
```

Expected: FAIL because `phases.verification` and role defaults do not exist yet.

- [ ] **Step 3: Add verification phase schema and remove static command config**

In `packages/agent-vm-worker/src/config/worker-config.ts`, add:

```ts
export const verificationPhaseSchema = z.object({
	...phaseExecutorSchema.shape,
	instructions: nullableInstructionTextSchema,
	turnTimeoutMs: z
		.number()
		.int()
		.positive()
		.default(15 * 60_000),
	skills: z.array(skillReferenceSchema).default([]),
});
```

Change `phasesSchema`:

```ts
const phasesSchema = z
	.object({
		plan: planPhaseSchema,
		work: workPhaseSchema,
		verification: verificationPhaseSchema.default(() => ({
			instructions: null,
			skills: [],
		})),
		wrapup: wrapupPhaseSchema,
	})
	.strict();
```

Change exports:

```ts
export type VerificationPhaseConfig = z.infer<typeof verificationPhaseSchema>;
```

Remove these fields from `workerConfigSchema`:

```ts
verification: z.array(verificationCommandSchema).default([]),
verificationTimeoutMs: z.number().positive().default(300_000),
```

Remove `verificationCommandSchema` if no remaining code imports it from `worker-config.ts`.

Update `computeTotalTaskTimeoutMs`:

```ts
export function computeTotalTaskTimeoutMs(config: WorkerConfig): number {
	const planMs = phaseWorstCaseMs(config.phases.plan);
	const workMs = phaseWorstCaseMs(config.phases.work);
	const verificationMs = config.phases.work.cycle.cycleCount * config.phases.verification.turnTimeoutMs;
	const wrapupMs = config.phases.wrapup.turnTimeoutMs;
	const baseMs = planMs + workMs + verificationMs + wrapupMs;
	return baseMs + Math.ceil((baseMs * TOTAL_TIMEOUT_BUFFER_PERCENT) / 100);
}
```

Update `buildDefaultWorkerConfigInput`:

```ts
function buildDefaultWorkerConfigInput(): Record<string, unknown> {
	return {
		phases: {
			plan: {
				cycle: { kind: 'review', cycleCount: 1 },
				agentInstructions: null,
				reviewerInstructions: null,
				skills: [],
			},
			work: {
				cycle: { kind: 'review', cycleCount: 2 },
				agentInstructions: null,
				reviewerInstructions: null,
				skills: [],
			},
			verification: { instructions: null, skills: [] },
			wrapup: { instructions: null, skills: [] },
		},
	};
}
```

Update `resolveWorkerConfigInstructionReferences` to resolve `phases.verification.instructions` the same way `wrapup.instructions` is resolved:

```ts
const verification = cloneRecordIfObject(phases.verification);
if (verification) {
	await resolveInstructionField(
		verification,
		'instructions',
		configDir,
		'phases.verification.instructions',
	);
	phases.verification = verification;
}
```

- [ ] **Step 4: Add verification-agent prompt role**

In `packages/agent-vm-worker/src/prompt/prompt-defaults.ts`, change `Role`:

```ts
export type Role =
	| 'plan-agent'
	| 'plan-reviewer'
	| 'work-agent'
	| 'verification-agent'
	| 'work-reviewer'
	| 'wrapup';
```

Add default instructions:

```ts
export const DEFAULT_VERIFICATION_AGENT_INSTRUCTIONS = `You are the VERIFICATION agent. Validate whether the work satisfies the task verification instructions.

## Inputs
- Spec: the original task.
- Verification instructions: the task-specific proof required before review.
- Approved plan: the plan the work agent implemented.
- Diff: the current repository diff.
- Worker session context: thread ids, cycle number, and log paths when available.

## Tools and permissions
- You may read files and run commands to prove the behavior.
- You must not edit files, commit, push, open PRs, or change repository state intentionally.
- If a command or system dependency fails for infrastructure reasons, return outcome "infra-error" with clear evidence.

## Outcomes
- passed: the requested verification has been run or otherwise proven with concrete evidence.
- failed: the work is wrong, incomplete, or the verification command failed because of the code under test.
- infra-error: verification could not run because the environment, dependency, resource, or tool failed outside the work change.

## Return format
{
  "outcome": "passed",
  "summary": "1-3 sentences",
  "commandsRun": [
    { "name": "targeted test", "command": "pnpm test", "cwd": "/workspace/repo", "passed": true, "exitCode": 0, "output": "", "logPath": "optional path" }
  ],
  "evidence": ["specific evidence from output, files, or logs"],
  "workerLogFindings": [],
  "nextWorkerInstructions": ""
}`;
```

Update `DEFAULTS_BY_ROLE`:

```ts
const DEFAULTS_BY_ROLE = {
	'plan-agent': DEFAULT_PLAN_AGENT_INSTRUCTIONS,
	'plan-reviewer': DEFAULT_PLAN_REVIEWER_INSTRUCTIONS,
	'work-agent': DEFAULT_WORK_AGENT_INSTRUCTIONS,
	'verification-agent': DEFAULT_VERIFICATION_AGENT_INSTRUCTIONS,
	'work-reviewer': DEFAULT_WORK_REVIEWER_INSTRUCTIONS,
	wrapup: DEFAULT_WRAPUP_INSTRUCTIONS,
} satisfies Record<Role, string>;
```

In `packages/agent-vm-worker/src/index.ts`, export the new default:

```ts
export {
	DEFAULT_COMMON_AGENT_INSTRUCTIONS,
	DEFAULT_PLAN_AGENT_INSTRUCTIONS,
	DEFAULT_PLAN_REVIEWER_INSTRUCTIONS,
	DEFAULT_VERIFICATION_AGENT_INSTRUCTIONS,
	DEFAULT_WORK_AGENT_INSTRUCTIONS,
	DEFAULT_WORK_REVIEWER_INSTRUCTIONS,
	DEFAULT_WRAPUP_INSTRUCTIONS,
	resolveRoleInstructions,
	type Role,
} from './prompt/prompt-defaults.js';
```

- [ ] **Step 5: Update scaffolded worker configs and prompts**

In `packages/agent-vm/src/cli/init-command.ts`, add the verification phase between `work` and `wrapup` in `defaultWorkerGatewayConfig()`:

```json
"verification": {
	"instructions": {
		"path": "./prompts/verification-agent.md"
	},
	"turnTimeoutMs": 900000,
	"skills": []
}
```

Remove top-level fields from the scaffolded worker config:

```json
"verification": [],
"verificationTimeoutMs": 300000
```

Add `verification-agent.md` to `defaultWorkerPromptFiles` with `DEFAULT_VERIFICATION_AGENT_INSTRUCTIONS`. Keep the generated prompt editable beside the other phase prompts under `config/gateways/<zone>/prompts/`.

Update `packages/agent-vm/src/cli/init-command.test.ts` so scaffolded worker configs reference `phases.verification.instructions.path === './prompts/verification-agent.md'`, write that prompt file, and load it through `loadWorkerConfig()`.

- [ ] **Step 6: Update prompt tests**

In `packages/agent-vm-worker/src/prompt/prompt-defaults.test.ts`, add:

```ts
test('verification-agent describes verification report schema', () => {
	expect(DEFAULT_VERIFICATION_AGENT_INSTRUCTIONS).toContain('VERIFICATION agent');
	expect(DEFAULT_VERIFICATION_AGENT_INSTRUCTIONS).toContain('"outcome": "passed"');
	expect(DEFAULT_VERIFICATION_AGENT_INSTRUCTIONS).toContain('infra-error');
});
```

Update any role list tests to include:

```ts
['verification-agent', DEFAULT_VERIFICATION_AGENT_INSTRUCTIONS],
```

In `packages/agent-vm-worker/src/prompt/prompt-assembler.test.ts`, add:

```ts
test('assembles verification-agent role instructions', async () => {
	const output = await buildRoleSystemPrompt({
		role: 'verification-agent',
		baseInstructionsOverride: null,
		roleInstructionsOverride: 'custom verifier',
		branchPrefix: 'agent/',
		skills: [],
	});

	expect(output).toContain('custom verifier');
});
```

- [ ] **Step 7: Run config and prompt tests**

Run:

```bash
pnpm vitest run packages/agent-vm-worker/src/config/worker-config.test.ts packages/agent-vm-worker/src/prompt/prompt-defaults.test.ts packages/agent-vm-worker/src/prompt/prompt-assembler.test.ts packages/agent-vm/src/cli/init-command.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit verification phase config**

Run:

```bash
git add packages/agent-vm-worker/src/config/worker-config.ts packages/agent-vm-worker/src/config/worker-config.test.ts packages/agent-vm-worker/src/prompt/prompt-defaults.ts packages/agent-vm-worker/src/prompt/prompt-defaults.test.ts packages/agent-vm-worker/src/prompt/prompt-assembler.test.ts packages/agent-vm-worker/src/index.ts packages/agent-vm/src/cli/init-command.ts packages/agent-vm/src/cli/init-command.test.ts
git commit -m "feat: add verifier phase configuration

Co-authored-by: Codex <noreply@openai.com>"
```

## Task 3: Define Verification Report Schema And Message Builders

**Files:**
- Modify: `packages/agent-vm-worker/src/state/task-event-types.ts`
- Modify: `packages/agent-vm-worker/src/state/task-state.ts`
- Modify: `packages/agent-vm-worker/src/state/task-state.test.ts`
- Modify: `packages/agent-vm-worker/src/prompt/message-builders.ts`
- Modify: `packages/agent-vm-worker/src/prompt/message-builders.test.ts`

- [ ] **Step 1: Write failing state/message tests**

In `packages/agent-vm-worker/src/state/task-state.test.ts`, add:

```ts
it('tracks verifier reports', () => {
	const state = createInitialState('task-1', TASK_CONFIG);

	const next = applyEvent(state, {
		event: 'verifier-turn',
		cycle: 1,
		threadId: 'verifier-thread',
		tokenCount: 12,
		report: {
			outcome: 'failed',
			summary: 'targeted test failed',
			commandsRun: [
				{
					name: 'targeted test',
					command: 'pnpm test -- failing.test.ts',
					cwd: '/workspace/repo',
					passed: false,
					exitCode: 1,
					output: 'Assertion failed',
				},
			],
			evidence: ['Assertion failed'],
			workerLogFindings: [],
			nextWorkerInstructions: 'Fix the failing assertion path.',
		},
	});

	expect(next.status).toBe('verification-agent');
	expect(next.verificationCycle).toBe(1);
	expect(next.lastVerificationReport?.outcome).toBe('failed');
});
```

In `packages/agent-vm-worker/src/prompt/message-builders.test.ts`, add:

```ts
test('buildVerificationMessage includes task verification instructions', () => {
	const message = buildVerificationMessage({
		spec: 'Fix the endpoint',
		verification: 'Run the endpoint integration test.',
		plan: 'Edit endpoint and test.',
		diff: 'diff --git a/file.ts b/file.ts',
		cycle: 1,
		workerThreadId: 'work-thread',
		taskLogsDir: '/state/tasks/task-1/logs',
	});

	expect(message).toContain('Run the endpoint integration test.');
	expect(message).toContain('diff --git');
	expect(message).toContain('/state/tasks/task-1/logs');
});

test('buildWorkReviewMessage includes verifier report and no run_validation instruction', () => {
	const message = buildWorkReviewMessage({
		spec: 'Fix the endpoint',
		plan: 'Edit endpoint and test.',
		diff: 'diff --git a/file.ts b/file.ts',
		cycle: 1,
		verificationReport: {
			outcome: 'passed',
			summary: 'targeted test passed',
			commandsRun: [],
			evidence: ['test passed'],
			workerLogFindings: [],
			nextWorkerInstructions: '',
		},
	});

	expect(message).toContain('targeted test passed');
	expect(message).not.toContain('run_validation');
});
```

- [ ] **Step 2: Run failing state/message tests**

Run:

```bash
pnpm vitest run packages/agent-vm-worker/src/state/task-state.test.ts packages/agent-vm-worker/src/prompt/message-builders.test.ts
```

Expected: FAIL because verifier report schemas and builders do not exist.

- [ ] **Step 3: Add verification report schemas and event types**

In `packages/agent-vm-worker/src/state/task-event-types.ts`, add:

```ts
export const verificationOutcomeSchema = z.enum(['passed', 'failed', 'infra-error']);
export type VerificationOutcome = z.infer<typeof verificationOutcomeSchema>;

export const verifierCommandResultSchema = z
	.object({
		name: z.string().min(1),
		command: z.string().min(1),
		cwd: z.string().min(1),
		passed: z.boolean(),
		exitCode: z.number().int(),
		output: z.string(),
		logPath: z.string().optional(),
	})
	.strict();

export const verificationReportSchema = z
	.object({
		outcome: verificationOutcomeSchema,
		summary: z.string().min(1),
		commandsRun: z.array(verifierCommandResultSchema),
		evidence: z.array(z.string().min(1)),
		workerLogFindings: z.array(z.string()),
		nextWorkerInstructions: z.string(),
	})
	.strict();

export type VerifierCommandResult = z.infer<typeof verifierCommandResultSchema>;
export type VerificationReport = z.infer<typeof verificationReportSchema>;
```

Add status value:

```ts
'verification-agent',
```

Add task event variant:

```ts
z.object({
	event: z.literal('verifier-turn'),
	cycle: z.number().int().positive(),
	threadId: z.string(),
	tokenCount: z.number().int().nonnegative(),
	report: verificationReportSchema,
}),
```

- [ ] **Step 4: Add verifier state fields**

In `packages/agent-vm-worker/src/state/task-state.ts`, add fields to `TaskState`:

```ts
readonly verificationAgentThreadId: string | null;
readonly verificationCycle: number;
readonly lastVerificationReport: VerificationReport | null;
```

Initialize in `createInitialState`:

```ts
verificationAgentThreadId: null,
verificationCycle: 0,
lastVerificationReport: null,
```

Handle `verifier-turn` in `applyEvent`:

```ts
case 'verifier-turn':
	return {
		...state,
		status: 'verification-agent',
		verificationAgentThreadId: event.threadId,
		verificationCycle: event.cycle,
		currentCycle: event.cycle,
		lastVerificationReport: event.report,
		updatedAt,
	};
```

- [ ] **Step 5: Add verifier and review message builders**

In `packages/agent-vm-worker/src/prompt/message-builders.ts`, replace command-list formatting with report formatting:

```ts
import type { VerificationReport } from '../state/task-event-types.js';
```

Add:

```ts
function formatVerificationReport(report: VerificationReport): string {
	const commands =
		report.commandsRun.length === 0
			? '(no commands recorded)'
			: report.commandsRun
					.map(
						(command) =>
							`- ${command.name}: passed=${String(command.passed)} exitCode=${String(command.exitCode)} cwd=${command.cwd}\n  command: ${command.command}\n  output: ${command.output.slice(0, 800)}`,
					)
					.join('\n');
	const evidence = report.evidence.length === 0 ? '(none)' : report.evidence.join('\n');
	const workerLogs =
		report.workerLogFindings.length === 0 ? '(none)' : report.workerLogFindings.join('\n');
	return [
		`Outcome: ${report.outcome}`,
		`Summary: ${report.summary}`,
		`Commands:\n${commands}`,
		`Evidence:\n${evidence}`,
		`Worker log findings:\n${workerLogs}`,
		`Next worker instructions:\n${report.nextWorkerInstructions || '(none)'}`,
	].join('\n\n');
}
```

Add:

```ts
export interface BuildVerificationMessageProps {
	readonly spec: string;
	readonly verification: string;
	readonly plan: string;
	readonly diff: string;
	readonly cycle: number;
	readonly workerThreadId: string | null;
	readonly taskLogsDir: string;
}

export function buildVerificationMessage(props: BuildVerificationMessageProps): string {
	return [
		`Spec:\n${props.spec}`,
		`Verification instructions:\n${props.verification}`,
		`Plan:\n${props.plan}`,
		`Diff v${String(props.cycle)}:\n${props.diff}`,
		`Work agent thread id: ${props.workerThreadId ?? '(unknown)'}`,
		`Task logs directory: ${props.taskLogsDir}`,
		'Verify the work exactly once for this cycle. Return JSON per the VerificationReport schema from your instructions.',
	].join('\n\n');
}
```

Change `BuildWorkReviewMessageProps`:

```ts
export interface BuildWorkReviewMessageProps {
	readonly spec: string;
	readonly plan: string;
	readonly diff: string;
	readonly cycle: number;
	readonly verificationReport: VerificationReport;
}
```

Change `buildWorkReviewMessage`:

```ts
export function buildWorkReviewMessage(props: BuildWorkReviewMessageProps): string {
	return [
		`Spec:\n${props.spec}`,
		`Plan:\n${props.plan}`,
		`Diff v${String(props.cycle)}:\n${props.diff}`,
		`Verification report:\n${formatVerificationReport(props.verificationReport)}`,
		'Review the code exactly once for this cycle. Return JSON per the ReviewResult schema from your instructions.',
	].join('\n\n');
}
```

Change `BuildWorkReviseMessageProps`:

```ts
export interface BuildWorkReviseMessageProps {
	readonly cycle: number;
	readonly review: ReviewResult | null;
	readonly verificationReport: VerificationReport;
}
```

Change `buildWorkReviseMessage`:

```ts
export function buildWorkReviseMessage(props: BuildWorkReviseMessageProps): string {
	const reviewFeedback = props.review
		? [`Summary: ${props.review.summary}`, `Comments:\n${formatComments(props.review.comments)}`].join(
				'\n',
			)
		: 'Reviewer was not invoked because verification did not pass.';
	return [
		`Work cycle ${String(props.cycle)} feedback:`,
		`Verification report:\n${formatVerificationReport(props.verificationReport)}`,
		`Review feedback:\n${reviewFeedback}`,
		'Revise. Return JSON: { "summary": "...", "commitShas": [], "remainingConcerns": "" }',
	].join('\n\n');
}
```

Export `buildVerificationMessage` from `packages/agent-vm-worker/src/index.ts`.

- [ ] **Step 6: Run state/message tests**

Run:

```bash
pnpm vitest run packages/agent-vm-worker/src/state/task-state.test.ts packages/agent-vm-worker/src/prompt/message-builders.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit report schema and prompts**

Run:

```bash
git add packages/agent-vm-worker/src/state/task-event-types.ts packages/agent-vm-worker/src/state/task-state.ts packages/agent-vm-worker/src/state/task-state.test.ts packages/agent-vm-worker/src/prompt/message-builders.ts packages/agent-vm-worker/src/prompt/message-builders.test.ts packages/agent-vm-worker/src/index.ts
git commit -m "feat: add verification report events

Co-authored-by: Codex <noreply@openai.com>"
```

## Task 4: Implement Verification Cycle Runner

**Files:**
- Create: `packages/agent-vm-worker/src/verification-phase/verification-cycle.ts`
- Create: `packages/agent-vm-worker/src/verification-phase/verification-cycle.test.ts`
- Modify: `packages/agent-vm-worker/src/index.ts`

- [ ] **Step 1: Write failing verification-cycle tests**

Create `packages/agent-vm-worker/src/verification-phase/verification-cycle.test.ts`:

```ts
import { describe, expect, test, vi } from 'vitest';

import type { PersistentThread } from '../work-executor/persistent-thread.js';
import { runVerificationCycle } from './verification-cycle.js';

function buildThread(responses: readonly string[]): PersistentThread {
	let responseIndex = 0;
	return {
		send: vi.fn(async () => ({
			response: responses[responseIndex++] ?? '',
			tokenCount: 10,
			threadId: 'verifier-thread',
		})),
		threadId: () => 'verifier-thread',
	};
}

describe('runVerificationCycle', () => {
	test('returns a parsed verifier report', async () => {
		const verificationThread = buildThread([
			JSON.stringify({
				outcome: 'passed',
				summary: 'targeted test passed',
				commandsRun: [],
				evidence: ['test passed'],
				workerLogFindings: [],
				nextWorkerInstructions: '',
			}),
		]);
		const reports: string[] = [];

		const result = await runVerificationCycle({
			spec: 'fix',
			verification: 'run the targeted test',
			plan: 'plan',
			diff: 'diff',
			cycle: 1,
			workerThreadId: 'work-thread',
			taskLogsDir: '/state/tasks/task-1/logs',
			verificationThread,
			systemPromptVerificationAgent: 'VERIFIER SYSTEM',
			onVerifierTurn: async (_cycle, _result, report) => {
				reports.push(report.summary);
			},
		});

		expect(result.report.outcome).toBe('passed');
		expect(reports).toEqual(['targeted test passed']);
		expect(verificationThread.send).toHaveBeenCalledTimes(1);
	});

	test('nudges once for malformed verifier JSON', async () => {
		const verificationThread = buildThread([
			'not json',
			JSON.stringify({
				outcome: 'failed',
				summary: 'test failed',
				commandsRun: [],
				evidence: ['failure'],
				workerLogFindings: [],
				nextWorkerInstructions: 'Fix the failing test.',
			}),
		]);

		const result = await runVerificationCycle({
			spec: 'fix',
			verification: 'run the targeted test',
			plan: 'plan',
			diff: 'diff',
			cycle: 1,
			workerThreadId: 'work-thread',
			taskLogsDir: '/state/tasks/task-1/logs',
			verificationThread,
			systemPromptVerificationAgent: 'VERIFIER SYSTEM',
			onVerifierTurn: async () => {},
		});

		expect(result.report.outcome).toBe('failed');
		expect(verificationThread.send).toHaveBeenCalledTimes(2);
	});
});
```

- [ ] **Step 2: Run failing verification-cycle tests**

Run:

```bash
pnpm vitest run packages/agent-vm-worker/src/verification-phase/verification-cycle.test.ts
```

Expected: FAIL because `verification-cycle.ts` does not exist.

- [ ] **Step 3: Implement `runVerificationCycle`**

Create `packages/agent-vm-worker/src/verification-phase/verification-cycle.ts`:

```ts
import {
	buildVerificationMessage,
	type BuildVerificationMessageProps,
} from '../prompt/message-builders.js';
import {
	verificationReportSchema,
	type VerificationReport,
} from '../state/task-event-types.js';
import { writeStderr } from '../shared/stderr.js';
import type {
	PersistentThread,
	PersistentThreadResponse,
} from '../work-executor/persistent-thread.js';

const MALFORMED_VERIFIER_NUDGE =
	'Your previous verification response did not match the required VerificationReport JSON schema. Return valid JSON with outcome, summary, commandsRun, evidence, workerLogFindings, and nextWorkerInstructions.';

export interface RunVerificationCycleProps extends BuildVerificationMessageProps {
	readonly verificationThread: PersistentThread;
	readonly systemPromptVerificationAgent: string;
	readonly onVerifierTurn: (
		cycle: number,
		result: PersistentThreadResponse,
		report: VerificationReport,
	) => void | Promise<void>;
}

export interface VerificationCycleResult {
	readonly report: VerificationReport;
}

function firstTurn(systemPrompt: string, userMessage: string): string {
	return `# System\n${systemPrompt}\n\n# Task\n${userMessage}`;
}

function parseVerificationReport(response: string): VerificationReport {
	let parsed: unknown;
	try {
		parsed = JSON.parse(response);
	} catch (error) {
		throw new Error(`verification-agent response is not valid JSON. Raw: ${response.slice(0, 200)}`, {
			cause: error,
		});
	}

	const result = verificationReportSchema.safeParse(parsed);
	if (!result.success) {
		throw new Error(
			`verification-agent response does not match VerificationReport schema: ${result.error.message}. Raw: ${response.slice(0, 200)}`,
		);
	}

	return result.data;
}

export async function runVerificationCycle(
	props: RunVerificationCycleProps,
): Promise<VerificationCycleResult> {
	const verificationMessage = buildVerificationMessage(props);
	let verificationResponse = await props.verificationThread.send(
		firstTurn(props.systemPromptVerificationAgent, verificationMessage),
	);

	let report: VerificationReport;
	try {
		report = parseVerificationReport(verificationResponse.response);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		writeStderr(
			`[verification-cycle] verifier cycle ${String(props.cycle)} returned malformed JSON; nudging once: ${message}`,
		);
		verificationResponse = await props.verificationThread.send(MALFORMED_VERIFIER_NUDGE);
		report = parseVerificationReport(verificationResponse.response);
	}

	await props.onVerifierTurn(props.cycle, verificationResponse, report);
	return { report };
}
```

Export it in `packages/agent-vm-worker/src/index.ts`:

```ts
export {
	runVerificationCycle,
	type RunVerificationCycleProps,
	type VerificationCycleResult,
} from './verification-phase/verification-cycle.js';
```

- [ ] **Step 4: Run verification-cycle tests**

Run:

```bash
pnpm vitest run packages/agent-vm-worker/src/verification-phase/verification-cycle.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit verification-cycle runner**

Run:

```bash
git add packages/agent-vm-worker/src/verification-phase/verification-cycle.ts packages/agent-vm-worker/src/verification-phase/verification-cycle.test.ts packages/agent-vm-worker/src/index.ts
git commit -m "feat: add verifier cycle runner

Co-authored-by: Codex <noreply@openai.com>"
```

## Task 5: Rework Work Cycle To Run Verifier Once Before Reviewer

**Files:**
- Modify: `packages/agent-vm-worker/src/work-phase/work-cycle.ts`
- Modify: `packages/agent-vm-worker/src/work-phase/work-cycle.test.ts`

- [ ] **Step 1: Replace work-cycle tests with verifier-first cycle tests**

In `packages/agent-vm-worker/src/work-phase/work-cycle.test.ts`, keep the `buildThread` helper and replace cycle tests with these cases:

```ts
test('cycleCount=1 runs work -> verifier -> reviewer and returns approved result', async () => {
	const workThread = buildThread([
		JSON.stringify({ summary: 'w0', commitShas: [], remainingConcerns: '' }),
	]);
	const verificationThread = buildThread([
		JSON.stringify({
			outcome: 'passed',
			summary: 'verified',
			commandsRun: [],
			evidence: ['passed'],
			workerLogFindings: [],
			nextWorkerInstructions: '',
		}),
	]);
	const reviewThread = buildThread([
		JSON.stringify({ approved: true, summary: 'reviewed', comments: [] }),
	]);

	const result = await runWorkCycle({
		spec: 's',
		verification: 'prove it works',
		plan: 'p',
		planReview: null,
		cycle: { kind: 'review', cycleCount: 1 },
		workThread,
		verificationThread,
		reviewThread,
		systemPromptWorkAgent: 'WORK SYSTEM',
		systemPromptVerificationAgent: 'VERIFIER SYSTEM',
		systemPromptWorkReviewer: 'REVIEW SYSTEM',
		getDiff: async () => 'diff',
		taskLogsDir: '/state/tasks/task-1/logs',
		onWorkAgentTurn: () => {},
		onVerifierTurn: () => {},
		onWorkReviewerTurn: () => {},
	});

	expect(workThread.send).toHaveBeenCalledTimes(1);
	expect(verificationThread.send).toHaveBeenCalledTimes(1);
	expect(reviewThread.send).toHaveBeenCalledTimes(1);
	expect(result.review?.summary).toBe('reviewed');
	expect(result.verificationReport.outcome).toBe('passed');
});

test('failed verifier skips reviewer and sends report back to worker once in the cycle', async () => {
	const workThread = buildThread([
		JSON.stringify({ summary: 'w0', commitShas: [], remainingConcerns: '' }),
		JSON.stringify({ summary: 'w1', commitShas: [], remainingConcerns: '' }),
	]);
	const verificationThread = buildThread([
		JSON.stringify({
			outcome: 'failed',
			summary: 'test failed',
			commandsRun: [],
			evidence: ['failure'],
			workerLogFindings: [],
			nextWorkerInstructions: 'Fix the failing test.',
		}),
	]);
	const reviewThread = buildThread([]);

	const result = await runWorkCycle({
		spec: 's',
		verification: 'prove it works',
		plan: 'p',
		planReview: null,
		cycle: { kind: 'review', cycleCount: 1 },
		workThread,
		verificationThread,
		reviewThread,
		systemPromptWorkAgent: 'WORK SYSTEM',
		systemPromptVerificationAgent: 'VERIFIER SYSTEM',
		systemPromptWorkReviewer: 'REVIEW SYSTEM',
		getDiff: async () => 'diff',
		taskLogsDir: '/state/tasks/task-1/logs',
		onWorkAgentTurn: () => {},
		onVerifierTurn: () => {},
		onWorkReviewerTurn: () => {},
	});

	expect(reviewThread.send).not.toHaveBeenCalled();
	expect(workThread.send).toHaveBeenCalledTimes(2);
	expect(result.review).toBe(null);
	expect(result.verificationReport.outcome).toBe('failed');
});

test('infra-error verifier fails immediately', async () => {
	const workThread = buildThread([
		JSON.stringify({ summary: 'w0', commitShas: [], remainingConcerns: '' }),
	]);
	const verificationThread = buildThread([
		JSON.stringify({
			outcome: 'infra-error',
			summary: 'database unavailable',
			commandsRun: [],
			evidence: ['ECONNREFUSED'],
			workerLogFindings: [],
			nextWorkerInstructions: '',
		}),
	]);
	const reviewThread = buildThread([]);

	await expect(
		runWorkCycle({
			spec: 's',
			verification: 'prove it works',
			plan: 'p',
			planReview: null,
			cycle: { kind: 'review', cycleCount: 1 },
			workThread,
			verificationThread,
			reviewThread,
			systemPromptWorkAgent: 'WORK SYSTEM',
			systemPromptVerificationAgent: 'VERIFIER SYSTEM',
			systemPromptWorkReviewer: 'REVIEW SYSTEM',
			getDiff: async () => 'diff',
			taskLogsDir: '/state/tasks/task-1/logs',
			onWorkAgentTurn: () => {},
			onVerifierTurn: () => {},
			onWorkReviewerTurn: () => {},
		}),
	).rejects.toThrow(/Verification infra error: database unavailable/);

	expect(reviewThread.send).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run failing work-cycle tests**

Run:

```bash
pnpm vitest run packages/agent-vm-worker/src/work-phase/work-cycle.test.ts
```

Expected: FAIL because `runWorkCycle` does not accept verifier inputs yet.

- [ ] **Step 3: Change `runWorkCycle` props and result**

In `packages/agent-vm-worker/src/work-phase/work-cycle.ts`, change imports:

```ts
import { runVerificationCycle } from '../verification-phase/verification-cycle.js';
import type { VerificationReport } from '../state/task-event-types.js';
```

Change `RunWorkCycleProps`:

```ts
export interface RunWorkCycleProps {
	readonly spec: string;
	readonly verification: string;
	readonly plan: string;
	readonly planReview: ReviewResult | null;
	readonly cycle: WorkCycleConfig;
	readonly workThread: PersistentThread;
	readonly verificationThread: PersistentThread;
	readonly reviewThread: PersistentThread;
	readonly systemPromptWorkAgent: string;
	readonly systemPromptVerificationAgent: string;
	readonly systemPromptWorkReviewer: string;
	readonly getDiff: () => Promise<string>;
	readonly taskLogsDir: string;
	readonly onWorkAgentTurn: (
		cycle: number,
		result: PersistentThreadResponse,
	) => void | Promise<void>;
	readonly onVerifierTurn: (
		cycle: number,
		result: PersistentThreadResponse,
		report: VerificationReport,
	) => void | Promise<void>;
	readonly onWorkReviewerTurn: (
		cycle: number,
		result: PersistentThreadResponse,
		review: ReviewResult,
		verificationReport: VerificationReport,
	) => void | Promise<void>;
	readonly isClosed?: () => boolean;
}
```

Change `WorkCycleResult`:

```ts
export interface WorkCycleResult {
	readonly review: ReviewResult | null;
	readonly verificationReport: VerificationReport;
}
```

- [ ] **Step 4: Replace reviewer validation parsing with one-review-per-cycle logic**

Delete `runValidationToolEnvelopeSchema`, `nestedValidationResultsSchema`, `REVIEWER_NUDGE`, and all `validationResults` parsing from `parseWorkReview`. Keep one malformed-review schema nudge.

Use this parse function:

```ts
function parseWorkReview(response: string): ReviewResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(response);
	} catch (error) {
		throw new Error(`work-reviewer response is not valid JSON. Raw: ${response.slice(0, 200)}`, {
			cause: error,
		});
	}

	const reviewResult = reviewResultSchema.safeParse(parsed);
	if (!reviewResult.success) {
		throw new Error(
			`work-reviewer response does not match ReviewResult schema: ${reviewResult.error.message}. Raw: ${response.slice(0, 200)}`,
		);
	}

	return reviewResult.data;
}
```

Change the loop body:

```ts
let lastReview: ReviewResult | null = null;
let lastVerificationReport: VerificationReport | null = null;
const cycleCount = props.cycle.cycleCount;

for (let cycle = 1; cycle <= cycleCount; cycle += 1) {
	if (props.isClosed?.()) break;

	const diff = await props.getDiff();
	const verificationResult = await runVerificationCycle({
		spec: props.spec,
		verification: props.verification,
		plan: props.plan,
		diff,
		cycle,
		workerThreadId: props.workThread.threadId(),
		taskLogsDir: props.taskLogsDir,
		verificationThread: props.verificationThread,
		systemPromptVerificationAgent: props.systemPromptVerificationAgent,
		onVerifierTurn: props.onVerifierTurn,
	});
	lastVerificationReport = verificationResult.report;

	if (lastVerificationReport.outcome === 'infra-error') {
		throw new Error(`Verification infra error: ${lastVerificationReport.summary}`);
	}

	if (props.isClosed?.()) break;

	if (lastVerificationReport.outcome === 'passed') {
		const reviewMessage = buildWorkReviewMessage({
			spec: props.spec,
			plan: props.plan,
			diff,
			cycle,
			verificationReport: lastVerificationReport,
		});
		let reviewResponse = await props.reviewThread.send(
			cycle === 1 ? firstTurn(props.systemPromptWorkReviewer, reviewMessage) : reviewMessage,
		);
		try {
			lastReview = parseWorkReview(reviewResponse.response);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!message.includes('does not match ReviewResult schema')) {
				throw error;
			}
			writeStderr(
				`[work-cycle] reviewer cycle ${String(cycle)} returned malformed review JSON; nudging once: ${message}`,
			);
			reviewResponse = await props.reviewThread.send(MALFORMED_REVIEW_NUDGE);
			lastReview = parseWorkReview(reviewResponse.response);
		}

		await props.onWorkReviewerTurn(cycle, reviewResponse, lastReview, lastVerificationReport);
		if (lastReview.approved) {
			return { review: lastReview, verificationReport: lastVerificationReport };
		}
	}

	if (props.isClosed?.()) break;

	const reviseResponse = await props.workThread.send(
		buildWorkReviseMessage({
			cycle,
			review: lastReview,
			verificationReport: lastVerificationReport,
		}),
	);
	await props.onWorkAgentTurn(cycle, reviseResponse);
}

if (lastVerificationReport === null) {
	throw new Error('runWorkCycle expected at least one verification turn.');
}

return {
	review: lastReview,
	verificationReport: lastVerificationReport,
};
```

- [ ] **Step 5: Run work-cycle tests**

Run:

```bash
pnpm vitest run packages/agent-vm-worker/src/work-phase/work-cycle.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit work-cycle verifier gate**

Run:

```bash
git add packages/agent-vm-worker/src/work-phase/work-cycle.ts packages/agent-vm-worker/src/work-phase/work-cycle.test.ts
git commit -m "feat: gate work review with verifier phase

Co-authored-by: Codex <noreply@openai.com>"
```

## Task 6: Wire Verifier Phase Into Coordinator And Hard-Gate Wrapup

**Files:**
- Modify: `packages/agent-vm-worker/src/coordinator/task-runner.ts`
- Modify: `packages/agent-vm-worker/src/coordinator/coordinator.test.ts`
- Modify: `packages/agent-vm-worker/src/worker-runtime.smoke.test.ts`
- Modify: `packages/agent-vm-worker/src/worker-runtime.integration.test.ts`
- Modify: `packages/agent-vm-worker/src/wrapup-phase/wrapup-runner.ts`
- Modify: `packages/agent-vm-worker/src/wrapup-phase/wrapup-runner.test.ts`

- [ ] **Step 1: Write failing coordinator tests for verifier events and wrapup gate**

In `packages/agent-vm-worker/src/coordinator/coordinator.test.ts`, update `enqueueHappyPathExecutors` to include a verifier executor between work and review:

```ts
.mockReturnValueOnce(
	createMockExecutor([
		JSON.stringify({
			outcome: 'passed',
			summary: 'verified',
			commandsRun: [],
			evidence: ['verified'],
			workerLogFindings: [],
			nextWorkerInstructions: '',
		}),
	]),
)
```

Update expected events in the happy path:

```ts
expect(await readEventNames(stateDir, taskId)).toEqual([
	'task-accepted',
	'phase-started',
	'plan-agent-turn',
	'plan-reviewer-turn',
	'plan-agent-turn',
	'plan-finalized',
	'phase-completed',
	'phase-started',
	'work-agent-turn',
	'verifier-turn',
	'work-reviewer-turn',
	'work-agent-turn',
	'phase-completed',
	'phase-started',
	'wrapup-turn',
	'wrapup-result',
	'phase-completed',
	'task-completed',
]);
```

Add a failure-path test:

```ts
it('fails before wrapup when the final verification report did not pass', async () => {
	mocks.createWorkExecutor
		.mockReturnValueOnce(createMockExecutor([JSON.stringify({ plan: 'plan' })]))
		.mockReturnValueOnce(createMockExecutor([JSON.stringify({ approved: true, summary: 'plan ok', comments: [] })]))
		.mockReturnValueOnce(
			createMockExecutor([
				JSON.stringify({ summary: 'work done', commitShas: [], remainingConcerns: '' }),
				JSON.stringify({ summary: 'work revised', commitShas: [], remainingConcerns: '' }),
			]),
		)
		.mockReturnValueOnce(
			createMockExecutor([
				JSON.stringify({
					outcome: 'failed',
					summary: 'targeted test failed',
					commandsRun: [],
					evidence: ['failure'],
					workerLogFindings: [],
					nextWorkerInstructions: 'Fix the failing test.',
				}),
			]),
		);

	const coordinator = await createCoordinator({
		config: makeConfig(stateDir),
		workspaceDir: tempDir,
	});

	const { taskId } = await coordinator.submitTask({
		taskId: 'verification-fails',
		prompt: 'fix the issue',
		verification: 'Run the targeted test.',
	});

	await waitForStatus(coordinator, taskId, 'failed');
	expect(coordinator.getTaskState(taskId)?.failureReason).toContain('Verification did not pass');
	expect(await readEventNames(stateDir, taskId)).not.toContain('wrapup-result');
});
```

- [ ] **Step 2: Run failing coordinator tests**

Run:

```bash
pnpm vitest run packages/agent-vm-worker/src/coordinator/coordinator.test.ts
```

Expected: FAIL because coordinator does not create verifier thread or gate wrapup yet.

- [ ] **Step 3: Wire verifier thread in task-runner**

In `packages/agent-vm-worker/src/coordinator/task-runner.ts`, remove `buildValidationTool` and `config.verification` usage.

Create verifier system prompt:

```ts
const verificationAgentSystem = await buildRoleSystemPrompt({
	role: 'verification-agent',
	baseInstructionsOverride: config.instructions ?? null,
	roleInstructionsOverride: config.phases.verification.instructions,
	branchPrefix: config.branchPrefix,
	skills: config.phases.verification.skills,
});
```

Create verifier thread:

```ts
const verificationThread = createThreadForPhase({
	config,
	phase: config.phases.verification,
	tools: [],
	cwd: primaryWorkspaceDir,
	turnTimeoutMs: config.phases.verification.turnTimeoutMs,
});
```

Call `runWorkCycle`:

```ts
const workResult = await runWorkCycle({
	spec: taskConfig.prompt,
	verification: taskConfig.verification,
	plan: planResult.plan,
	planReview: planResult.review,
	cycle: config.phases.work.cycle,
	workThread,
	verificationThread,
	reviewThread: workReviewThread,
	systemPromptWorkAgent: workAgentSystem,
	systemPromptVerificationAgent: verificationAgentSystem,
	systemPromptWorkReviewer: workReviewerSystem,
	getDiff: async () => await getDiff(primaryWorkspaceDir),
	taskLogsDir,
	isClosed: () => eventRecorder.isClosed(taskId),
	onWorkAgentTurn: async (cycle, result) => {
		await eventRecorder.emit(taskId, {
			event: 'work-agent-turn',
			cycle,
			threadId: result.threadId,
			tokenCount: result.tokenCount,
		});
		throwIfClosed(taskId, eventRecorder);
	},
	onVerifierTurn: async (cycle, result, report) => {
		await eventRecorder.emit(taskId, {
			event: 'verifier-turn',
			cycle,
			threadId: result.threadId,
			tokenCount: result.tokenCount,
			report,
		});
		throwIfClosed(taskId, eventRecorder);
	},
	onWorkReviewerTurn: async (cycle, result, review, verificationReport) => {
		await eventRecorder.emit(taskId, {
			event: 'work-reviewer-turn',
			cycle,
			threadId: result.threadId,
			tokenCount: result.tokenCount,
			review,
			verificationReport,
		});
		throwIfClosed(taskId, eventRecorder);
	},
});
```

Add the hard gate before work summary and wrapup:

```ts
if (workResult.verificationReport.outcome !== 'passed') {
	throw new Error(`Verification did not pass: ${workResult.verificationReport.summary}`);
}
if (workResult.review?.approved !== true) {
	throw new Error(`Work review did not approve the final cycle: ${workResult.review?.summary ?? 'review was not run'}`);
}
```

Change `buildWorkSummaryRequest` to accept `verificationReport` instead of validation results:

```ts
function buildWorkSummaryRequest(props: {
	readonly spec: string;
	readonly plan: string;
	readonly verificationReport: VerificationReport;
	readonly review: ReviewResult;
}): string {
	return [
		'You are still the WORK agent. Do not edit files, do not commit, and do not call tools in this turn.',
		'Summarize in detail the work you completed for handoff to a separate wrapup agent.',
		'Return JSON only with this shape:',
		'{ "summary": "...", "filesChanged": [], "commits": [], "verification": "...", "reviewNotes": "...", "knownRisks": [], "suggestedPrTitle": "...", "suggestedPrBody": "..." }',
		`Original task:\n${props.spec}`,
		`Final plan:\n${props.plan}`,
		`Verification report:\n${JSON.stringify(props.verificationReport, null, 2)}`,
		`Review:\n${JSON.stringify(props.review, null, 2)}`,
	].join('\n\n');
}
```

- [ ] **Step 4: Update wrapup inputs**

In `packages/agent-vm-worker/src/wrapup-phase/wrapup-runner.ts`, change props from validation results to verification report:

```ts
import type { VerificationReport } from '../state/task-event-types.js';

export interface RunWrapupProps {
	readonly wrapupThread: PersistentThread;
	readonly systemPromptWrapup: string;
	readonly spec: string;
	readonly plan: string;
	readonly workSummary: string;
	readonly gitContext: string;
	readonly verificationReport: VerificationReport;
	readonly onWrapupTurn: (result: PersistentThreadResponse) => void | Promise<void>;
}
```

Include the report in the wrapup message:

```ts
`Verification report:\n${JSON.stringify(props.verificationReport, null, 2)}`,
```

Update `task-runner.ts` wrapup call:

```ts
verificationReport: workResult.verificationReport,
```

- [ ] **Step 5: Update event schemas for work reviewer turn**

In `packages/agent-vm-worker/src/state/task-event-types.ts`, replace `validationResults` and `validationSkipped` on `work-reviewer-turn` with:

```ts
verificationReport: verificationReportSchema,
```

In `packages/agent-vm-worker/src/state/task-state.ts`, rename `lastValidationResults` to:

```ts
readonly lastVerificationReport: VerificationReport | null;
```

When applying `work-reviewer-turn`, set:

```ts
lastVerificationReport: event.verificationReport,
```

- [ ] **Step 6: Update direct worker smoke fixture**

In `packages/agent-vm-worker/src/worker-runtime.smoke.test.ts`, remove `verification` command list from config and add task verification to the POST body:

```ts
verification: 'Confirm READY.txt exists in the repository root and contains exactly READY.',
```

The verifier prompt can inspect the file and return passed. Keep this smoke behind the existing OpenAI API key guard.

- [ ] **Step 7: Run coordinator and wrapup tests**

Run:

```bash
pnpm vitest run packages/agent-vm-worker/src/coordinator/coordinator.test.ts packages/agent-vm-worker/src/wrapup-phase/wrapup-runner.test.ts packages/agent-vm-worker/src/state/task-state.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit coordinator verifier wiring**

Run:

```bash
git add packages/agent-vm-worker/src/coordinator/task-runner.ts packages/agent-vm-worker/src/coordinator/coordinator.test.ts packages/agent-vm-worker/src/worker-runtime.smoke.test.ts packages/agent-vm-worker/src/worker-runtime.integration.test.ts packages/agent-vm-worker/src/wrapup-phase/wrapup-runner.ts packages/agent-vm-worker/src/wrapup-phase/wrapup-runner.test.ts packages/agent-vm-worker/src/state/task-event-types.ts packages/agent-vm-worker/src/state/task-state.ts packages/agent-vm-worker/src/state/task-state.test.ts
git commit -m "feat: wire verifier gate into worker coordinator

Co-authored-by: Codex <noreply@openai.com>"
```

## Task 7: Remove Reviewer-Owned Validation Tooling

**Files:**
- Delete: `packages/agent-vm-worker/src/work-phase/validation-tool.ts`
- Delete: `packages/agent-vm-worker/src/work-phase/validation-tool.test.ts`
- Modify: `packages/agent-vm-worker/src/work-phase/work-cycle.ts`
- Modify: `packages/agent-vm-worker/src/prompt/prompt-defaults.ts`
- Modify: `packages/agent-vm-worker/src/prompt/prompt-defaults.test.ts`
- Modify: `packages/agent-vm/src/cli/init-command.ts`
- Modify: `packages/agent-vm/src/cli/init-command.test.ts`
- Modify: `packages/agent-vm-worker/src/index.ts`

- [ ] **Step 1: Prove old validation tool references remain**

Run:

```bash
rg -n "run_validation|validationResults|validationSkipped|buildValidationTool|verificationTimeoutMs|\"verification\": \\[" packages docs
```

Expected: matches remain before cleanup.

- [ ] **Step 2: Remove validation tool exports and files**

Delete:

```text
packages/agent-vm-worker/src/work-phase/validation-tool.ts
packages/agent-vm-worker/src/work-phase/validation-tool.test.ts
```

In `packages/agent-vm-worker/src/index.ts`, remove:

```ts
export { buildValidationTool } from './work-phase/validation-tool.js';
```

Keep `validation-runner/verification-runner.ts` for command parsing and future deterministic helpers only if still imported by tests. If no production code imports it after this task, leave it exported for compatibility inside the package test suite and do not expose it as a phase tool.

- [ ] **Step 3: Rewrite prompt defaults**

In `packages/agent-vm-worker/src/prompt/prompt-defaults.ts`, change work-agent inputs:

```ts
## Inputs
- Spec: the original task.
- Approved plan: the implementation plan.
- Plan review commentary: advisory feedback.
- Verification instructions: task-specific proof that the verifier will run after your work.
```

Change work-agent tools:

```ts
## Tools
- Run project commands directly when useful while implementing.
- A separate verification agent will validate your final work before review.
```

Change work-reviewer instructions:

```ts
export const DEFAULT_WORK_REVIEWER_INSTRUCTIONS = `You are the WORK REVIEWER. Review the current diff against the spec, plan, and verification report.

## Verification gate
- The verifier has already run exactly once for this work cycle.
- You must treat a passed verification report as required evidence, not as a replacement for code review.
- If the verification report is missing or did not pass, do not approve.
- Do not call validation tools; verification is owned by the verification-agent phase.

## What to find
- Correctness bugs.
- Missing tests or unproven behavior despite a passing verifier report.
- Security or secret-handling issues.
- Scope drift from the plan.
- Maintainability issues that matter now.

## Severity
- critical: broken behavior, failed verification, security issue, or clear plan divergence.
- suggestion: meaningful improvement.
- nitpick: style only.

## Return format
{
  "approved": true,
  "summary": "1-3 sentences",
  "comments": []
}`;
```

Change wrapup instructions so they only mention verifier report:

```ts
- Do not run verification here. The verification-agent phase already handled verification and the coordinator gated this phase.
```

- [ ] **Step 4: Rewrite scaffolded prompt files**

Update the prompt strings emitted by `defaultWorkerPromptFiles` in `packages/agent-vm/src/cli/init-command.ts` so newly scaffolded projects receive the same work-agent, verification-agent, work-reviewer, and wrapup wording as the package defaults. The generated `work-reviewer.md` should not mention `run_validation`; it should review the diff against the spec, plan, and verifier report.

Update `packages/agent-vm/src/cli/init-command.test.ts` to assert generated prompt files do not contain stale validation-tool language.

- [ ] **Step 5: Update tests that assert old prompt language**

In `packages/agent-vm-worker/src/prompt/prompt-defaults.test.ts`, replace old assertions:

```ts
expect(DEFAULT_WORK_REVIEWER_INSTRUCTIONS).toContain('run_validation');
expect(DEFAULT_WRAPUP_INSTRUCTIONS).toContain('Call run_validation here');
```

with:

```ts
expect(DEFAULT_WORK_REVIEWER_INSTRUCTIONS).toContain('verification report');
expect(DEFAULT_WORK_REVIEWER_INSTRUCTIONS).not.toContain('run_validation');
expect(DEFAULT_WRAPUP_INSTRUCTIONS).toContain('verification-agent phase already handled verification');
expect(DEFAULT_WRAPUP_INSTRUCTIONS).not.toContain('run_validation');
```

- [ ] **Step 6: Prove old validation tool references are gone from active paths**

Run:

```bash
rg -n "run_validation|validationResults|validationSkipped|buildValidationTool|verificationTimeoutMs|\"verification\": \\[" packages/agent-vm-worker/src packages/agent-vm/src
```

Expected: no matches in active source files. Matches in this plan or historical docs are acceptable only until Task 8 updates docs.

- [ ] **Step 7: Run prompt and work tests**

Run:

```bash
pnpm vitest run packages/agent-vm-worker/src/prompt/prompt-defaults.test.ts packages/agent-vm-worker/src/work-phase/work-cycle.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit validation tool removal**

Run:

```bash
git add packages/agent-vm-worker/src/work-phase packages/agent-vm-worker/src/prompt/prompt-defaults.ts packages/agent-vm-worker/src/prompt/prompt-defaults.test.ts packages/agent-vm-worker/src/index.ts packages/agent-vm/src/cli/init-command.ts packages/agent-vm/src/cli/init-command.test.ts
git commit -m "refactor: remove reviewer-owned validation tool

Co-authored-by: Codex <noreply@openai.com>"
```

## Task 8: Update Docs And API Examples

**Files:**
- Modify: `docs/reference/configuration/worker-json.md`
- Modify: `docs/subsystems/worker-task-pipeline.md`
- Modify: `docs/architecture/agent-worker-gateway.md`
- Modify: `docs/getting-started/worker-guide.md`
- Modify: `docs/reference/configuration/README.md`
- Modify: `docs/reference/configuration/project-config-json.md`
- Modify: `docs/reference/configuration/prompt-files.md`
- Modify: `docs/reference/validate-and-doctor.md`

- [ ] **Step 1: Find stale docs**

Run:

```bash
rg -n "verificationTimeoutMs|run_validation|validationResults|verification commands|\"verification\": \\[|validates, and wraps up|work-reviewer.*validation" docs
```

Expected: stale docs mention static verification commands and reviewer-run validation.

- [ ] **Step 2: Update `worker-json.md`**

Replace the sections list in `docs/reference/configuration/worker-json.md` so it includes `phases.verification`:

```md
phases
  plan
  work
  verification
  wrapup

mcpServers
skills
branchPrefix
stateDir
```

In the minimal shape, add the verification phase:

```json
"verification": {
  "instructions": { "path": "./prompts/verification-agent.md" }
}
```

Replace "Validation Commands" with a "Verification Agent" section that states:

- `phases.verification` configures the agent that proves task-specific verification instructions after each work turn and before work review.
- Task requests supply the task-specific `verification` string.
- Worker configs supply verifier behavior through `phases.verification.instructions` and `phases.verification.turnTimeoutMs`.
- The verifier returns `outcome: "passed" | "failed" | "infra-error"`.
- The reviewer runs only after `passed`.
- `failed` returns feedback to the worker for the next cycle.
- `infra-error` fails the task without review or wrapup.

Use this task request example:

```json
{
  "prompt": "Fix the webhook event log test",
  "verification": "Run the targeted webhook integration test and prove the event log behavior works."
}
```

Use this worker config example:

```json
{
  "phases": {
    "verification": {
      "instructions": { "path": "./prompts/verification-agent.md" },
      "turnTimeoutMs": 900000
    }
  }
}
```

- [ ] **Step 3: Update lifecycle docs**

In `docs/subsystems/worker-task-pipeline.md`, update the task request shape:

```text
{
  prompt:       string (min 1)
  verification: string (min 1)
  repos:        [{ repoUrl, baseBranch }]   (defaults to [])
  context:      Record<string, unknown>      (defaults to {})
  resources:    task resource bindings       (defaults to empty)
}
```

Replace config field rows for `verification` and `verificationTimeoutMs` with:

```md
| `phases.verification` | verifier prompt/model/timeout | Dedicated verifier phase run once per work cycle |
```

In `docs/architecture/agent-worker-gateway.md`, make the verification phase explicit:

```md
PHASE 4: VERIFICATION

A separate verification agent receives the task verification instructions, current diff, plan, worker thread id, and task log directory. It runs exactly once for the current work cycle.

Outcomes:
- passed: continue to work review
- failed: skip review and send the verifier report back to the worker
- infra-error: fail the task without review or wrapup
```

- [ ] **Step 4: Update API examples**

Every task request JSON example in docs should include:

```json
"verification": "Run the task-specific checks and confirm the requested behavior works."
```

For end-to-end task request examples, use:

```json
"verification": "Run the relevant tests or commands needed to prove the tiny documentation change did not break repository checks."
```

- [ ] **Step 5: Prove stale docs are gone**

Run:

```bash
rg -n "verificationTimeoutMs|run_validation|validationResults|\"verification\": \\[|verification commands" docs
```

Expected: no stale matches outside archived WIP notes. If WIP notes match, leave them untouched and report them as historical.

- [ ] **Step 6: Commit docs**

Run:

```bash
git add docs
git commit -m "docs: describe verifier-agent gate

Co-authored-by: Codex <noreply@openai.com>"
```

## Task 9: Full Verification

**Files:**
- No source changes expected

- [ ] **Step 1: Run focused unit tests**

Run:

```bash
pnpm vitest run packages/agent-vm-worker/src/config/worker-config.test.ts packages/agent-vm-worker/src/prompt/prompt-defaults.test.ts packages/agent-vm-worker/src/prompt/message-builders.test.ts packages/agent-vm-worker/src/verification-phase/verification-cycle.test.ts packages/agent-vm-worker/src/work-phase/work-cycle.test.ts packages/agent-vm-worker/src/coordinator/coordinator.test.ts packages/agent-vm-worker/src/state/task-state.test.ts packages/agent-vm-worker/src/server.test.ts packages/agent-vm/src/config/resource-contracts/resource-contract-schemas.test.ts packages/agent-vm/src/controller/http/controller-http-routes.test.ts
```

Expected: PASS with all listed suites passing.

- [ ] **Step 2: Run full unit suite**

Run:

```bash
pnpm test:unit
```

Expected: PASS with exit code 0.

- [ ] **Step 3: Run integration suite**

Run:

```bash
pnpm test:integration
```

Expected: PASS with exit code 0.

- [ ] **Step 4: Run smoke suite**

Run:

```bash
pnpm test:smoke
```

Expected: PASS with exit code 0. If smoke tests are gated by missing live credentials, report the skipped gate and run the static config checks from the smoke docs.

- [ ] **Step 5: Run quality gate**

Run:

```bash
pnpm check
```

Expected: PASS with exit code 0.

- [ ] **Step 6: Run stale-reference scan**

Run:

```bash
rg -n "run_validation|validationResults|validationSkipped|verificationTimeoutMs|\"verification\": \\[" packages/agent-vm-worker/src packages/agent-vm/src docs/reference docs/subsystems docs/architecture docs/getting-started
```

Expected: no matches in active code or current reference docs.

- [ ] **Step 7: Inspect final diff**

Run:

```bash
git diff --stat HEAD
git diff --check
```

Expected: `git diff --check` exits 0. Diff stat should only include worker, controller schemas, scaffolded worker prompts/config, tests, and docs related to the verifier gate.

- [ ] **Step 8: Commit final verification fixes if any**

If the verification pass required small fixes, commit them:

```bash
git add packages docs
git commit -m "fix: complete verifier gate integration

Co-authored-by: Codex <noreply@openai.com>"
```

If no files changed after Task 8, do not create an empty commit.

## Self-Review Checklist

- Spec coverage: The plan covers task-level prose verification, verifier prompt/config, one verifier per work cycle, one reviewer per passed verifier cycle, failure feedback to worker, infra-error terminal failure, no verifier code-edit enforcement beyond instructions, and hard wrapup gate.
- Placeholder scan: The plan contains no unfinished placeholder markers, copy-forward instructions, or unspecified edge-handling steps.
- Type consistency: The plan consistently uses `verification: string`, `VerificationReport`, `verification-agent`, `verifier-turn`, `phases.verification`, and `verificationReport`.
- Scope check: The plan changes one subsystem: the worker task lifecycle and its request/config/docs surface. It does not add deterministic command selection, read-only executor sandboxing, or repo-resource validation extensions.
