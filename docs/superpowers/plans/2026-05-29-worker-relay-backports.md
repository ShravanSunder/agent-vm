# Worker Relay Backports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port only the Relay worker improvements that still make sense for personal `agent-vm`: explicit wrapup outcomes first, and per-phase reasoning/reviewer executor configuration second.

**Architecture:** Keep this Worker-only. Do not import Relay OpenClaw assumptions, delegator concepts, or the unstable Mac sandbox branch. The personal repo already has the shared Gondolin `/dev/fd` rootfs init-extra hygiene in the gateway image build path, so this plan does not touch VM boot scripts.

**Tech Stack:** TypeScript, Zod, Vitest, pnpm, `@agent-vm/agent-vm-worker`, `@agent-vm/agent-vm`.

---

## Scope Decisions

Port now:

- Explicit worker wrapup outcomes: `pr-created`, `no-pr-needed`, `pr-blocked`.
- Wrapup parse-failure observability so a bad final JSON response becomes an explicit blocked outcome instead of a silently trusted fallback PR URL.
- Optional but useful Worker config knobs: `reasoningEffort` and per-phase `reviewerExecutor`.

Do not port now:

- `@relayfinancial/agent-vm-mac-sandbox` / interactive gateway. The user wants it eventually, but not until that Relay branch stabilizes.
- OpenClaw concepts from Relay. Relay does not have OpenClaw gateways.
- Broad `agent-vm-worker` sync. Compare semantics only.
- `/dev/fd` rootfs init-extra. Personal `agent-vm` already has it in `packages/gondolin-adapter/src/rootfs-init-extra.ts`, and `packages/gondolin-adapter/src/build-pipeline.ts` injects it into gateway image builds.

## Files

Wrapup outcomes:

- Create: `packages/agent-vm-worker/src/shared/wrapup-outcome.ts`
- Modify: `packages/agent-vm-worker/src/wrapup-phase/wrapup-runner.ts`
- Modify: `packages/agent-vm-worker/src/wrapup-phase/wrapup-runner.test.ts`
- Modify: `packages/agent-vm-worker/src/state/task-event-types.ts`
- Create or modify: `packages/agent-vm-worker/src/state/task-event-types.test.ts`
- Modify: `packages/agent-vm-worker/src/state/task-state.ts`
- Modify: `packages/agent-vm-worker/src/state/task-state.test.ts`
- Modify: `packages/agent-vm-worker/src/coordinator/task-runner.ts`
- Modify: `packages/agent-vm-worker/src/coordinator/coordinator.test.ts`
- Modify: `packages/agent-vm-worker/src/worker-runtime.integration.test.ts`
- Modify: `packages/agent-vm-worker/src/prompt/prompt-defaults.ts`
- Modify: `packages/agent-vm-worker/src/prompt/prompt-defaults.test.ts`
- Modify: `docs/reference/configuration/worker-json.md`
- Modify: `docs/architecture/agent-worker-gateway.md`

Reasoning/reviewer executor config:

- Modify: `packages/agent-vm-worker/src/config/worker-config.ts`
- Modify: `packages/agent-vm-worker/src/config/worker-config.test.ts`
- Modify: `packages/agent-vm-worker/src/coordinator/task-runner.ts`
- Modify: `packages/agent-vm-worker/src/coordinator/coordinator.test.ts`
- Modify: `packages/agent-vm/src/cli/init-command.ts`
- Modify: `packages/agent-vm/src/cli/init-command.test.ts`
- Modify: `docs/reference/configuration/worker-json.md`
- Modify: `docs/getting-started/worker-guide.md`

---

### Task 1: Add Explicit Wrapup Outcome Schemas

**Files:**
- Create: `packages/agent-vm-worker/src/shared/wrapup-outcome.ts`
- Modify: `packages/agent-vm-worker/src/shared/zod-json-schema.test.ts`

- [ ] **Step 1: Create the wrapup outcome schema file**

Create `packages/agent-vm-worker/src/shared/wrapup-outcome.ts`:

```ts
import { z } from 'zod';

export const wrapupOutcomeSchema = z.enum(['pr-created', 'no-pr-needed', 'pr-blocked']);
export type WrapupOutcome = z.infer<typeof wrapupOutcomeSchema>;

const wrapupResultBaseSchema = z.object({
	summary: z.string(),
	branchName: z.string().nullable(),
	pushedCommits: z.array(z.string()).default([]),
});

export const wrapupPrCreatedResultSchema = wrapupResultBaseSchema.extend({
	outcome: z.literal('pr-created'),
	reason: z.null(),
	prUrl: z.string().url(),
});

export const wrapupNoPrNeededResultSchema = wrapupResultBaseSchema.extend({
	outcome: z.literal('no-pr-needed'),
	reason: z.string(),
	prUrl: z.null(),
});

export const wrapupPrBlockedResultSchema = wrapupResultBaseSchema.extend({
	outcome: z.literal('pr-blocked'),
	reason: z.string(),
	prUrl: z.null(),
});

export const wrapupFinalAnswerSchema = z.discriminatedUnion('outcome', [
	wrapupPrCreatedResultSchema,
	wrapupNoPrNeededResultSchema,
	wrapupPrBlockedResultSchema,
]);

export type WrapupFinalAnswer = z.infer<typeof wrapupFinalAnswerSchema>;
```

- [ ] **Step 2: Add schema regression coverage**

In `packages/agent-vm-worker/src/shared/zod-json-schema.test.ts`, extend the existing worker schema test or add a small test that serializes `wrapupFinalAnswerSchema` and proves `wrapupActions` is still absent:

```ts
import { wrapupFinalAnswerSchema } from './wrapup-outcome.js';

test('wrapup outcome schema exposes explicit outcomes', () => {
	const jsonSchema = z.toJSONSchema(wrapupFinalAnswerSchema, {
		unrepresentable: 'any',
	});

	expect(JSON.stringify(jsonSchema)).toContain('pr-created');
	expect(JSON.stringify(jsonSchema)).toContain('no-pr-needed');
	expect(JSON.stringify(jsonSchema)).toContain('pr-blocked');
	expect(JSON.stringify(jsonSchema)).not.toContain('wrapupActions');
});
```

If the file already imports `z`, reuse that import. If not, add `import { z } from 'zod';`.

- [ ] **Step 3: Run the schema tests**

Run:

```bash
pnpm vitest run packages/agent-vm-worker/src/shared/zod-json-schema.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/agent-vm-worker/src/shared
git commit -m "feat(worker): add wrapup outcome schema

Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 2: Make Wrapup Parsing Outcome-Aware

**Files:**
- Modify: `packages/agent-vm-worker/src/wrapup-phase/wrapup-runner.ts`
- Modify: `packages/agent-vm-worker/src/wrapup-phase/wrapup-runner.test.ts`

- [ ] **Step 1: Replace local wrapup JSON schema with shared outcome schema**

In `wrapup-runner.ts`, replace the local `z.object({ summary, prUrl, branchName, pushedCommits })` schema with:

```ts
import {
	wrapupFinalAnswerSchema,
	type WrapupFinalAnswer,
} from '../shared/wrapup-outcome.js';
```

Remove the `z` import if nothing else in the file needs it.

Set:

```ts
export type WrapupRunResult = WrapupFinalAnswer;
```

- [ ] **Step 2: Add parse failure callback types**

Add:

```ts
export interface WrapupParseFailure {
	readonly firstError: string;
	readonly firstResponsePreview: string;
	readonly secondError: string;
	readonly secondResponsePreview: string;
}
```

Extend `RunWrapupProps`:

```ts
readonly onWrapupParseFailed?: (failure: WrapupParseFailure) => void | Promise<void>;
```

- [ ] **Step 3: Change required output JSON**

Update `buildWrapupMessage()` required output line to:

```ts
'{ "outcome": "pr-created | no-pr-needed | pr-blocked", "summary": "...", "reason": "why no PR was needed or why PR creation was blocked, otherwise null", "prUrl": "https://github.com/org/repo/pull/123 or null", "branchName": "agent/name or null", "pushedCommits": ["sha"] }',
```

Update `buildWrapupJsonRepairMessage()` to ask for the same exact shape.

- [ ] **Step 4: Parse to the shared discriminated union**

Change `parseWrapupFinalAnswer()` success value to return `result.data` directly:

```ts
return {
	success: true,
	value: result.data,
};
```

- [ ] **Step 5: Make fallback blocked, not trusted PR-created**

Change `buildFallbackWrapupResult()` to:

```ts
function buildFallbackWrapupResult(response: string, error: string): WrapupRunResult {
	const summary = response.trim().slice(0, FALLBACK_SUMMARY_LENGTH);
	const mentionedPrUrl = extractPullRequestUrl(response);
	const fallbackReason = [
		`Wrapup agent did not provide a parseable final response. Last parse error: ${error}`,
		...(mentionedPrUrl
			? [`Mentioned URL, not trusted as structured output: ${mentionedPrUrl}`]
			: []),
	].join('. ');

	return {
		outcome: 'pr-blocked',
		summary:
			summary.length > 0
				? summary
				: `Wrapup agent did not provide a parseable final response. Last parse error: ${error}`,
		reason: fallbackReason,
		prUrl: null,
		branchName: null,
		pushedCommits: [],
	};
}
```

- [ ] **Step 6: Emit parse failure callback after both parse attempts fail**

Before returning fallback:

```ts
await props.onWrapupParseFailed?.({
	firstError: parsed.error,
	firstResponsePreview: turnResult.response.slice(0, WRAPUP_RESPONSE_PREVIEW_LENGTH),
	secondError: retryParsed.error,
	secondResponsePreview: retryResult.response.slice(0, WRAPUP_RESPONSE_PREVIEW_LENGTH),
});
return buildFallbackWrapupResult(retryResult.response, retryParsed.error);
```

- [ ] **Step 7: Update wrapup runner tests**

Update `packages/agent-vm-worker/src/wrapup-phase/wrapup-runner.test.ts` fixtures:

```ts
const defaultResponse =
	'{"outcome":"no-pr-needed","summary":"ok","reason":"No changes were needed.","prUrl":null,"branchName":null,"pushedCommits":[]}';
```

Add tests:

```ts
test('parses pr-created wrapup result', async () => {
	const thread = createThread([
		JSON.stringify({
			outcome: 'pr-created',
			summary: 'Created PR.',
			reason: null,
			prUrl: 'https://github.com/org/repo/pull/1',
			branchName: 'agent/task',
			pushedCommits: ['abc123'],
		}),
	]);

	const result = await runWrapup(baseProps({ wrapupThread: thread }));

	expect(result).toEqual({
		outcome: 'pr-created',
		summary: 'Created PR.',
		reason: null,
		prUrl: 'https://github.com/org/repo/pull/1',
		branchName: 'agent/task',
		pushedCommits: ['abc123'],
	});
});

test('parses no-pr-needed wrapup result', async () => {
	const thread = createThread([
		JSON.stringify({
			outcome: 'no-pr-needed',
			summary: 'Review only.',
			reason: 'The task requested validation only.',
			prUrl: null,
			branchName: null,
			pushedCommits: [],
		}),
	]);

	const result = await runWrapup(baseProps({ wrapupThread: thread }));

	expect(result.outcome).toBe('no-pr-needed');
	expect(result.reason).toBe('The task requested validation only.');
});

test('falls back to pr-blocked and reports parse failure after two invalid responses', async () => {
	const onWrapupParseFailed = vi.fn();
	const thread = createThread(['not-json', 'Created https://github.com/org/repo/pull/3']);

	const result = await runWrapup(baseProps({ wrapupThread: thread, onWrapupParseFailed }));

	expect(result.outcome).toBe('pr-blocked');
	expect(result.prUrl).toBeNull();
	expect(result.reason).toContain('Mentioned URL, not trusted as structured output');
	expect(onWrapupParseFailed).toHaveBeenCalledWith({
		firstError: expect.stringContaining('not valid JSON'),
		firstResponsePreview: 'not-json',
		secondError: expect.stringContaining('not valid JSON'),
		secondResponsePreview: 'Created https://github.com/org/repo/pull/3',
	});
});
```

Adapt helper names to the existing test file.

- [ ] **Step 8: Run wrapup tests**

Run:

```bash
pnpm vitest run packages/agent-vm-worker/src/wrapup-phase/wrapup-runner.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/agent-vm-worker/src/wrapup-phase
git commit -m "feat(worker): parse explicit wrapup outcomes

Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 3: Store Outcome-Aware Wrapup Events In Task State

**Files:**
- Modify: `packages/agent-vm-worker/src/state/task-event-types.ts`
- Create or modify: `packages/agent-vm-worker/src/state/task-event-types.test.ts`
- Modify: `packages/agent-vm-worker/src/state/task-state.ts`
- Modify: `packages/agent-vm-worker/src/state/task-state.test.ts`
- Modify: `packages/agent-vm-worker/src/state/event-log.test.ts`

- [ ] **Step 1: Import wrapup result schemas into event types**

In `task-event-types.ts`, add:

```ts
import {
	wrapupNoPrNeededResultSchema,
	wrapupPrBlockedResultSchema,
	wrapupPrCreatedResultSchema,
} from '../shared/wrapup-outcome.js';
```

- [ ] **Step 2: Replace old wrapup-result event shape**

Add:

```ts
const wrapupResultEventSchemas = [
	wrapupPrCreatedResultSchema.extend({
		event: z.literal('wrapup-result'),
	}),
	wrapupNoPrNeededResultSchema.extend({
		event: z.literal('wrapup-result'),
	}),
	wrapupPrBlockedResultSchema.extend({
		event: z.literal('wrapup-result'),
	}),
] as const;

const wrapupParseFailedEventSchema = z.object({
	event: z.literal('wrapup-parse-failed'),
	firstError: z.string().min(1),
	firstResponsePreview: z.string(),
	secondError: z.string().min(1),
	secondResponsePreview: z.string(),
});
```

Replace the old `z.object({ event: z.literal('wrapup-result'), prUrl, branchName, pushedCommits })` member with:

```ts
wrapupParseFailedEventSchema,
...wrapupResultEventSchemas,
```

If `z.discriminatedUnion('event', ...)` rejects duplicate `wrapup-result` discriminants, switch the event schema to `z.union([...])` like Relay did.

- [ ] **Step 3: Add task event invariant tests**

Create `packages/agent-vm-worker/src/state/task-event-types.test.ts` if missing:

```ts
import { describe, expect, it } from 'vitest';

import { taskEventSchema } from './task-event-types.js';

describe('taskEventSchema wrapup outcomes', () => {
	it('requires pr-created wrapup-result events to include a PR URL', () => {
		expect(
			taskEventSchema.safeParse({
				event: 'wrapup-result',
				outcome: 'pr-created',
				summary: 'done',
				reason: null,
				prUrl: 'https://github.com/org/repo/pull/1',
				branchName: 'agent/task',
				pushedCommits: ['abc123'],
			}).success,
		).toBe(true);
	});

	it('requires no-pr-needed wrapup-result events to include a reason and no PR URL', () => {
		expect(
			taskEventSchema.safeParse({
				event: 'wrapup-result',
				outcome: 'no-pr-needed',
				summary: 'review only',
				reason: 'No changes were required.',
				prUrl: null,
				branchName: null,
				pushedCommits: [],
			}).success,
		).toBe(true);
	});

	it('rejects pr-blocked with a PR URL', () => {
		expect(
			taskEventSchema.safeParse({
				event: 'wrapup-result',
				outcome: 'pr-blocked',
				summary: 'blocked',
				reason: 'Push failed.',
				prUrl: 'https://github.com/org/repo/pull/1',
				branchName: 'agent/task',
				pushedCommits: [],
			}).success,
		).toBe(false);
	});

	it('accepts wrapup parse failure observability events', () => {
		expect(
			taskEventSchema.safeParse({
				event: 'wrapup-parse-failed',
				firstError: 'first parse failed',
				firstResponsePreview: 'not-json',
				secondError: 'second parse failed',
				secondResponsePreview: 'still not json',
			}).success,
		).toBe(true);
	});
});
```

- [ ] **Step 4: Store outcome and reason in task state**

In `task-state.ts`, import:

```ts
import type { WrapupFinalAnswer } from '../shared/wrapup-outcome.js';
```

Change `wrapupResult` in `TaskState` to:

```ts
readonly wrapupResult: WrapupFinalAnswer | null;
```

In the `wrapup-result` event case, store:

```ts
wrapupResult: {
	outcome: event.outcome,
	summary: event.summary,
	reason: event.reason,
	prUrl: event.prUrl,
	branchName: event.branchName,
	pushedCommits: [...event.pushedCommits],
},
```

Add a `wrapup-parse-failed` case that updates only `updatedAt`:

```ts
case 'wrapup-parse-failed':
	return { ...state, updatedAt };
```

- [ ] **Step 5: Update task-state tests**

In `task-state.test.ts`, replace old wrapup-result expectations with:

```ts
expect(nextState.wrapupResult).toEqual({
	outcome: 'pr-created',
	summary: 'Created PR.',
	reason: null,
	prUrl: 'https://example.com/pr/1',
	branchName: 'agent/task',
	pushedCommits: ['abc123'],
});
```

Add table coverage:

```ts
it.each([
	{
		name: 'no-pr-needed',
		event: {
			event: 'wrapup-result' as const,
			outcome: 'no-pr-needed' as const,
			summary: 'No PR needed.',
			reason: 'Validation-only task.',
			prUrl: null,
			branchName: null,
			pushedCommits: [],
		},
	},
	{
		name: 'pr-blocked',
		event: {
			event: 'wrapup-result' as const,
			outcome: 'pr-blocked' as const,
			summary: 'Could not open PR.',
			reason: 'GitHub was unavailable.',
			prUrl: null,
			branchName: 'agent/task',
			pushedCommits: ['abc123'],
		},
	},
])('stores $name wrapup results without marking the task completed', ({ event }) => {
	const nextState = applyEvent(TEST_STATE, event);

	expect(nextState.wrapupResult).toEqual({
		outcome: event.outcome,
		summary: event.summary,
		reason: event.reason,
		prUrl: event.prUrl,
		branchName: event.branchName,
		pushedCommits: event.pushedCommits,
	});
});
```

- [ ] **Step 6: Run state tests**

Run:

```bash
pnpm vitest run \
  packages/agent-vm-worker/src/state/task-event-types.test.ts \
  packages/agent-vm-worker/src/state/task-state.test.ts \
  packages/agent-vm-worker/src/state/event-log.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/agent-vm-worker/src/state packages/agent-vm-worker/src/shared
git commit -m "feat(worker): record explicit wrapup outcomes

Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 4: Emit Outcome-Aware Wrapup Events From The Coordinator

**Files:**
- Modify: `packages/agent-vm-worker/src/coordinator/task-runner.ts`
- Modify: `packages/agent-vm-worker/src/coordinator/coordinator.test.ts`
- Modify: `packages/agent-vm-worker/src/worker-runtime.integration.test.ts`
- Modify: `packages/agent-vm-worker/src/server.test.ts`

- [ ] **Step 1: Add a wrapup result event builder**

In `task-runner.ts`, add near the existing type helpers:

```ts
import type { TaskEvent } from '../state/task-event-types.js';
```

Add:

```ts
function buildWrapupResultEvent(wrapupResult: WrapupRunResult): TaskEvent {
	switch (wrapupResult.outcome) {
		case 'pr-created':
			return {
				event: 'wrapup-result',
				outcome: wrapupResult.outcome,
				summary: wrapupResult.summary,
				reason: wrapupResult.reason,
				prUrl: wrapupResult.prUrl,
				branchName: wrapupResult.branchName,
				pushedCommits: [...wrapupResult.pushedCommits],
			};
		case 'no-pr-needed':
		case 'pr-blocked':
			return {
				event: 'wrapup-result',
				outcome: wrapupResult.outcome,
				summary: wrapupResult.summary,
				reason: wrapupResult.reason,
				prUrl: wrapupResult.prUrl,
				branchName: wrapupResult.branchName,
				pushedCommits: [...wrapupResult.pushedCommits],
			};
		default:
			throw new Error(`Unhandled wrapup outcome: ${JSON.stringify(wrapupResult)}`);
	}
}
```

This switch is intentionally explicit so new outcomes fail loudly.

- [ ] **Step 2: Wire parse failure callback**

When calling `runWrapup`, add:

```ts
onWrapupParseFailed: async (failure) => {
	await eventRecorder.emit(taskId, {
		event: 'wrapup-parse-failed',
		firstError: failure.firstError,
		firstResponsePreview: failure.firstResponsePreview,
		secondError: failure.secondError,
		secondResponsePreview: failure.secondResponsePreview,
	});
},
```

- [ ] **Step 3: Emit the built result event**

Replace:

```ts
await eventRecorder.emit(taskId, {
	event: 'wrapup-result',
	prUrl: wrapupResult.prUrl ?? null,
	branchName: wrapupResult.branchName ?? null,
	pushedCommits: [...wrapupResult.pushedCommits],
});
```

with:

```ts
await eventRecorder.emit(taskId, buildWrapupResultEvent(wrapupResult));
```

- [ ] **Step 4: Update coordinator tests**

Update mock wrapup executor responses to include explicit outcomes:

```ts
JSON.stringify({
	outcome: 'no-pr-needed',
	summary: 'wrapup',
	reason: 'Test completed without creating a PR.',
	prUrl: null,
	branchName: null,
	pushedCommits: [],
})
```

Add an assertion where events are inspected:

```ts
expect(eventNames).toContain('wrapup-result');
expect(coordinator.getTaskState(taskId)?.wrapupResult?.outcome).toBe('no-pr-needed');
```

- [ ] **Step 5: Update worker runtime and server fixtures**

Where fixtures currently use:

```ts
wrapupResult: null
```

leave them as `null` for initial states.

Where fixtures emit a wrapup result, use:

```ts
{
	event: 'wrapup-result',
	outcome: 'no-pr-needed',
	summary: 'No PR was created in this test.',
	reason: 'The test fixture does not exercise PR creation.',
	prUrl: null,
	branchName: null,
	pushedCommits: [],
}
```

- [ ] **Step 6: Run coordinator/runtime tests**

Run:

```bash
pnpm vitest run \
  packages/agent-vm-worker/src/coordinator/coordinator.test.ts \
  packages/agent-vm-worker/src/worker-runtime.integration.test.ts \
  packages/agent-vm-worker/src/server.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/agent-vm-worker/src/coordinator packages/agent-vm-worker/src/worker-runtime.integration.test.ts packages/agent-vm-worker/src/server.test.ts
git commit -m "feat(worker): emit wrapup outcome events

Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 5: Update Worker Prompts And Docs For Wrapup Outcomes

**Files:**
- Modify: `packages/agent-vm-worker/src/prompt/prompt-defaults.ts`
- Modify: `packages/agent-vm-worker/src/prompt/prompt-defaults.test.ts`
- Modify: `docs/reference/configuration/worker-json.md`
- Modify: `docs/architecture/agent-worker-gateway.md`

- [ ] **Step 1: Update wrapup default instructions**

In `DEFAULT_WRAPUP_INSTRUCTIONS`, replace the job sentence with:

```text
Ship the work that was already implemented, or report that no PR was intentionally needed. You are a fresh wrapup thread with explicit handoff context from the work agent. You are not here to redesign the solution or make broad new edits. Use the original task, the work-agent summary, and the git context in your prompt to decide the outcome.
```

Add rules:

```text
7. If the task was validation-only or explicitly required no code changes and there is no PR to open, return outcome "no-pr-needed" with a clear reason.
8. Return JSON with the outcome, summary, reason, PR URL when created, branch name, and pushed commit SHAs if known.
```

Add important rules:

```text
- If there are no committed changes because the task was review-only, validation-only, or already satisfied, do not fabricate a PR. Return outcome "no-pr-needed" and explain why.
- If work exists but push or PR creation is blocked, return outcome "pr-blocked" with the reason and any branch or commit details you have.
```

Set return format:

```text
{ "outcome": "pr-created | no-pr-needed | pr-blocked", "summary": "wrapup result", "reason": "why no PR was needed or why PR creation was blocked, otherwise null", "prUrl": "https://github.com/org/repo/pull/1 or null", "branchName": "agent/name or null", "pushedCommits": ["sha"] }
```

- [ ] **Step 2: Update prompt tests**

In `prompt-defaults.test.ts`, add:

```ts
test('wrapup pins explicit outcome contract', () => {
	expect(DEFAULT_WRAPUP_INSTRUCTIONS).toContain('outcome "no-pr-needed"');
	expect(DEFAULT_WRAPUP_INSTRUCTIONS).toContain('outcome "pr-created"');
	expect(DEFAULT_WRAPUP_INSTRUCTIONS).toContain('outcome "pr-blocked"');
	expect(DEFAULT_WRAPUP_INSTRUCTIONS).toContain('"outcome": "pr-created | no-pr-needed | pr-blocked"');
});
```

- [ ] **Step 3: Document worker config/status behavior**

In `docs/reference/configuration/worker-json.md`, add a `Wrapup outcome` section:

```md
### Wrapup Outcome

The wrapup phase returns an explicit outcome:

- `pr-created`: the worker pushed an agent branch and opened a PR.
- `no-pr-needed`: the task intentionally produced no PR, such as review-only or validation-only work.
- `pr-blocked`: work exists or may exist, but push or PR creation was blocked.

`pr-created` includes a non-null `prUrl`. `no-pr-needed` and `pr-blocked`
include a non-empty `reason` and a null `prUrl`.
```

In `docs/architecture/agent-worker-gateway.md`, update every `wrapup-result` mention that says only `PR URL` to mention `outcome`, `reason`, `prUrl`, `branchName`, and `pushedCommits`.

- [ ] **Step 4: Run prompt tests**

Run:

```bash
pnpm vitest run packages/agent-vm-worker/src/prompt/prompt-defaults.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-vm-worker/src/prompt docs/reference/configuration/worker-json.md docs/architecture/agent-worker-gateway.md
git commit -m "docs(worker): describe wrapup outcomes

Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 6: Add Per-Phase Reasoning Effort And Reviewer Executor Knobs

**Files:**
- Modify: `packages/agent-vm-worker/src/config/worker-config.ts`
- Modify: `packages/agent-vm-worker/src/config/worker-config.test.ts`
- Modify: `packages/agent-vm-worker/src/coordinator/task-runner.ts`
- Modify: `packages/agent-vm-worker/src/coordinator/coordinator.test.ts`
- Modify: `packages/agent-vm/src/cli/init-command.ts`
- Modify: `packages/agent-vm/src/cli/init-command.test.ts`

- [ ] **Step 1: Extend phase executor schema**

In `worker-config.ts`, replace the current `ReasoningEffort` type alias with a Zod schema near the top:

```ts
export const reasoningEffortSchema = z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']);
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;
```

Change `phaseExecutorSchema` to:

```ts
export const phaseExecutorSchema = z
	.object({
		provider: z.string().min(1).optional(),
		model: z.string().min(1).optional(),
		reasoningEffort: reasoningEffortSchema.optional(),
	})
	.strict();
```

- [ ] **Step 2: Add reviewerExecutor to plan/work phases**

Change `planPhaseSchema` to include:

```ts
reviewerExecutor: phaseExecutorSchema.optional(),
```

Change `workPhaseSchema` to include:

```ts
reviewerExecutor: phaseExecutorSchema.optional(),
```

- [ ] **Step 3: Add default reasoning effort**

In `workerConfigSchema.defaults`, add:

```ts
reasoningEffort: reasoningEffortSchema.optional(),
```

- [ ] **Step 4: Resolve explicit reasoning effort**

Add:

```ts
function isModelAlias(provider: string, model: string): boolean {
	return MODEL_ALIASES[provider]?.[model] !== undefined;
}
```

Change `resolvePhaseExecutor()` phase parameter to include `reasoningEffort`.

Inside `resolvePhaseExecutor()`, add:

```ts
const defaultReasoningEffort = isModelAlias(provider, model)
	? undefined
	: config.defaults.reasoningEffort;
```

Return:

```ts
reasoningEffort: phase.reasoningEffort ?? defaultReasoningEffort ?? resolved.reasoningEffort,
```

- [ ] **Step 5: Use reviewerExecutor in task runner**

In `task-runner.ts`, wherever reviewer threads are created, resolve reviewer config from:

```ts
const planReviewerExecutorConfig = resolvePhaseExecutor(
	config,
	config.phases.plan.reviewerExecutor ?? config.phases.plan,
);
```

and:

```ts
const workReviewerExecutorConfig = resolvePhaseExecutor(
	config,
	config.phases.work.reviewerExecutor ?? config.phases.work,
);
```

Pass those reviewer executor configs to reviewer thread creation instead of reusing the agent phase executor config.

- [ ] **Step 6: Update config tests**

In `worker-config.test.ts`, add:

```ts
it('supports explicit reasoning effort defaults and phase overrides', () => {
	const config = workerConfigSchema.parse({
		runtimeInstructions: 'runtime',
		defaults: {
			provider: 'codex',
			model: 'gpt-5.5',
			reasoningEffort: 'high',
		},
		phases: {
			plan: {
				cycle: { kind: 'review', cycleCount: 1 },
				agentInstructions: null,
				reviewerInstructions: null,
				reasoningEffort: 'xhigh',
				reviewerExecutor: { model: 'gpt-5.5', reasoningEffort: 'xhigh' },
			},
			work: {
				cycle: { kind: 'review', cycleCount: 1 },
				agentInstructions: null,
				reviewerInstructions: null,
				reasoningEffort: 'high',
				reviewerExecutor: { model: 'gpt-5.5', reasoningEffort: 'xhigh' },
			},
			wrapup: {
				instructions: null,
				reasoningEffort: 'medium',
			},
		},
	});

	expect(resolvePhaseExecutor(config, config.phases.plan).reasoningEffort).toBe('xhigh');
	expect(
		resolvePhaseExecutor(config, config.phases.plan.reviewerExecutor ?? config.phases.plan)
			.reasoningEffort,
	).toBe('xhigh');
	expect(resolvePhaseExecutor(config, config.phases.wrapup).reasoningEffort).toBe('medium');
});
```

Add a rejection test:

```ts
it('rejects misspelled reasoning effort', () => {
	expect(() =>
		workerConfigSchema.parse({
			runtimeInstructions: 'runtime',
			phases: {
				plan: {
					cycle: { kind: 'review', cycleCount: 1 },
					agentInstructions: null,
					reviewerInstructions: null,
					reasoningEffort: 'reasoningEfffort',
				},
				work: {
					cycle: { kind: 'review', cycleCount: 1 },
					agentInstructions: null,
					reviewerInstructions: null,
				},
				wrapup: { instructions: null },
			},
		}),
	).toThrow(/reasoningEffort/u);
});
```

- [ ] **Step 7: Update coordinator tests for reviewer executor**

Add or update a coordinator test so plan reviewer and work reviewer use configured reviewer executor model/effort:

```ts
expect(createExecutorMock).toHaveBeenCalledWith(
	expect.objectContaining({
		model: 'gpt-5.5',
		reasoningEffort: 'xhigh',
	}),
);
```

Use the existing mock shape in `coordinator.test.ts`; do not introduce a new mocking framework.

- [ ] **Step 8: Update default worker scaffold**

In `packages/agent-vm/src/cli/init-command.ts`, change `defaultWorkerGatewayConfig()` defaults to include:

```ts
defaults: {
	provider: 'codex',
	model: 'gpt-5.5',
	reasoningEffort: 'high',
},
```

Set plan:

```ts
model: 'gpt-5.5',
reasoningEffort: 'xhigh',
reviewerExecutor: { model: 'gpt-5.5', reasoningEffort: 'xhigh' },
```

Set work:

```ts
model: 'gpt-5.5',
reasoningEffort: 'high',
reviewerExecutor: { model: 'gpt-5.5', reasoningEffort: 'xhigh' },
```

Set wrapup:

```ts
model: 'gpt-5.5',
reasoningEffort: 'medium',
```

Keep cycle counts at the current personal values unless the user explicitly asks to adopt Relay’s larger defaults. This plan is about configurability, not changing personal repo’s default cost profile.

- [ ] **Step 9: Update init tests**

In `init-command.test.ts`, update the worker scaffold assertions:

```ts
expect(workerConfig.defaults.reasoningEffort).toBe('high');
expect(workerConfig.phases.plan.reasoningEffort).toBe('xhigh');
expect(workerConfig.phases.plan.reviewerExecutor).toEqual({
	model: 'gpt-5.5',
	reasoningEffort: 'xhigh',
});
expect(workerConfig.phases.work.reasoningEffort).toBe('high');
expect(workerConfig.phases.work.reviewerExecutor).toEqual({
	model: 'gpt-5.5',
	reasoningEffort: 'xhigh',
});
expect(workerConfig.phases.wrapup.reasoningEffort).toBe('medium');
```

- [ ] **Step 10: Run config/coordinator/init tests**

Run:

```bash
pnpm vitest run \
  packages/agent-vm-worker/src/config/worker-config.test.ts \
  packages/agent-vm-worker/src/coordinator/coordinator.test.ts \
  packages/agent-vm/src/cli/init-command.test.ts
```

Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add packages/agent-vm-worker/src/config packages/agent-vm-worker/src/coordinator packages/agent-vm/src/cli/init-command.ts packages/agent-vm/src/cli/init-command.test.ts
git commit -m "feat(worker): configure phase reasoning effort

Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 7: Update Worker Config Documentation

**Files:**
- Modify: `docs/reference/configuration/worker-json.md`
- Modify: `docs/getting-started/worker-guide.md`

- [ ] **Step 1: Document `reasoningEffort`**

In `docs/reference/configuration/worker-json.md`, add `reasoningEffort` to the example:

```json
{
  "defaults": { "provider": "codex", "model": "gpt-5.5", "reasoningEffort": "high" },
  "phases": {
    "plan": {
      "model": "gpt-5.5",
      "reasoningEffort": "xhigh",
      "reviewerExecutor": { "model": "gpt-5.5", "reasoningEffort": "xhigh" }
    },
    "work": {
      "model": "gpt-5.5",
      "reasoningEffort": "high",
      "reviewerExecutor": { "model": "gpt-5.5", "reasoningEffort": "xhigh" }
    },
    "wrapup": {
      "model": "gpt-5.5",
      "reasoningEffort": "medium"
    }
  }
}
```

Add:

```md
`reasoningEffort` accepts `minimal`, `low`, `medium`, `high`, or `xhigh`.
Phase values override defaults. `reviewerExecutor` lets plan/work reviewers use
a different model or reasoning effort than the agent phase they review.
```

- [ ] **Step 2: Update getting-started worker guide**

In `docs/getting-started/worker-guide.md`, update the worker config example to show the same `reasoningEffort` and `reviewerExecutor` fields. Keep explanatory prose short; link back to `docs/reference/configuration/worker-json.md`.

- [ ] **Step 3: Run docs-adjacent tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/cli/init-command.test.ts packages/agent-vm-worker/src/config/worker-config.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add docs/reference/configuration/worker-json.md docs/getting-started/worker-guide.md
git commit -m "docs(worker): document reasoning effort config

Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 8: Full Verification

**Files:**
- No source files.

- [ ] **Step 1: Run targeted worker gate**

Run:

```bash
pnpm vitest run \
  packages/agent-vm-worker/src/shared/zod-json-schema.test.ts \
  packages/agent-vm-worker/src/wrapup-phase/wrapup-runner.test.ts \
  packages/agent-vm-worker/src/state/task-event-types.test.ts \
  packages/agent-vm-worker/src/state/task-state.test.ts \
  packages/agent-vm-worker/src/state/event-log.test.ts \
  packages/agent-vm-worker/src/coordinator/coordinator.test.ts \
  packages/agent-vm-worker/src/worker-runtime.integration.test.ts \
  packages/agent-vm-worker/src/server.test.ts \
  packages/agent-vm-worker/src/config/worker-config.test.ts \
  packages/agent-vm/src/cli/init-command.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run package tests**

Run:

```bash
pnpm --filter @agent-vm/agent-vm-worker test
```

Expected: PASS.

- [ ] **Step 3: Run repo quality gate**

Run:

```bash
pnpm check
```

Expected: PASS.

- [ ] **Step 4: Final status**

Run:

```bash
git status --short --branch
```

Expected: branch `worker-relay-backports` with no uncommitted changes except intentional untracked scratch files, if any.

---

## Self-Review

Spec coverage:

- Explicit wrapup outcomes: Tasks 1-5.
- Useful additional Worker delta from Relay: per-phase `reasoningEffort` and `reviewerExecutor`, Tasks 6-7.
- Mac sandbox intentionally deferred: Scope Decisions.
- `/dev/fd` rootfs init-extra question: Scope Decisions marks it verified already present and out of scope.

Placeholder scan:

- No placeholder markers or unspecified “add tests” steps remain. Every code change step names files, code shape, and test commands.

Type consistency:

- `WrapupFinalAnswer` comes from `shared/wrapup-outcome.ts`.
- `WrapupRunResult` aliases `WrapupFinalAnswer`.
- `TaskState.wrapupResult` stores `WrapupFinalAnswer | null`.
- Event schemas use the same outcome-specific Zod schemas.
