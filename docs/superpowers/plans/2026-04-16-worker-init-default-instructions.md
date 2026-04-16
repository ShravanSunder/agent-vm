# Worker Init Default Instructions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `agent-vm init --gateway-type worker` scaffold `config/<zone>/worker.json` with the built-in default instruction text written out explicitly at the top level and for every worker phase.

**Architecture:** Move the worker’s built-in instruction strings into one shared module inside `@shravansunder/agent-vm-worker`, then have both the runtime prompt assembler and the CLI scaffold consume that same source of truth. This keeps the scaffolded JSON visible and editable without creating a second copy of the defaults that can drift.

**Tech Stack:** TypeScript, Zod, vitest, pnpm monorepo

---

## File Structure

### Worker defaults source of truth

```
packages/agent-vm-worker/src/prompt/
├── prompt-defaults.ts         ← new shared default base + phase instruction constants
├── prompt-defaults.test.ts    ← new tests for exported default values
└── prompt-assembler.ts        ← import shared defaults instead of owning hidden literals
```

### CLI scaffold + docs

```
packages/agent-vm/src/cli/
└── init-command.ts            ← scaffold worker.json with explicit instructions and phase.instructions

packages/agent-vm/src/cli/
└── init-command.test.ts       ← assert scaffolded worker.json contains instruction keys and values

packages/agent-vm-worker/src/
└── index.ts                   ← export shared prompt-default constants for CLI consumption

docs/
├── getting-started/worker-guide.md
└── reference/configuration-reference.md
                             ← document that scaffolded worker.json now includes explicit defaults
```

### Boundary decisions

- `worker-config.ts` remains the schema/validation layer only. Do not add prompt text literals there.
- There is still no `phases.coordinator` config key. The supported configurable phases remain `plan`, `planReview`, `work`, `workReview`, and `wrapup`.
- The scaffold should emit explicit `instructions` values, not placeholder comments and not `undefined`-omitted fields.
- Keep the runtime-to-config phase mapping explicit in one place: runtime prompt phases use `plan-review` / `work-review`, while config keys use `planReview` / `workReview`.

---

## Task 1: Centralize the Worker’s Built-In Instruction Defaults

**Files:**
- Create: `packages/agent-vm-worker/src/prompt/prompt-defaults.ts`
- Create: `packages/agent-vm-worker/src/prompt/prompt-defaults.test.ts`
- Modify: `packages/agent-vm-worker/src/prompt/prompt-assembler.ts`
- Modify: `packages/agent-vm-worker/src/index.ts`

**Steps:**

- [ ] **Step 1: Add a dedicated prompt defaults module**

Create `packages/agent-vm-worker/src/prompt/prompt-defaults.ts` with the currently hardcoded runtime strings moved out of `prompt-assembler.ts`:

```ts
export const DEFAULT_BASE_INSTRUCTIONS = `## Git Rules
- You may commit at any time using git add and git commit.
- Always commit to a branch prefixed with "agent/" - never commit to main or master.
- Do NOT run git push. Push is handled by the system after wrapup.
- Do NOT modify or delete the .git directory.
- Use conventional commit messages: "feat:", "fix:", "refactor:", "test:", "docs:".

## Workspace Rules
- Work only inside the workspace directories provided in the task repos.
- Do not create files outside the workspace.
- Do not modify system files or configuration outside the workspace.

## Verification
- Run verification commands before requesting wrapup.
- If verification fails, fix the issue and re-verify.

## Wrapup
- When work is complete and verified, call the git-pr tool to stage, commit, and request controller-side push and PR creation.
- The git-pr tool handles the controller handoff - you only need to provide the title and description.`;

export const DEFAULT_PHASE_INSTRUCTIONS = {
	plan: 'Create an implementation plan for the task. Do not write code yet.',
	'plan-review': 'Review the plan for completeness, correctness, risks, and missing edge cases.',
	work: 'Implement the approved plan.',
	'work-review': 'Review the code changes for correctness, bugs, style, and test coverage.',
	wrapup:
		'Complete the task by running the configured wrapup actions. You have access to: ' +
		'git (commit, push, PR), Slack (webhook post). Decide which actions to take based on the task results.',
} as const;
```

- [ ] **Step 2: Add unit coverage for the new exported defaults**

Create `packages/agent-vm-worker/src/prompt/prompt-defaults.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { DEFAULT_BASE_INSTRUCTIONS, DEFAULT_PHASE_INSTRUCTIONS } from './prompt-defaults.js';

describe('prompt-defaults', () => {
	it('exports the default base instructions used by the worker runtime', () => {
		expect(DEFAULT_BASE_INSTRUCTIONS).toContain('Do NOT run git push');
		expect(DEFAULT_BASE_INSTRUCTIONS).toContain('request controller-side push and PR creation');
	});

	it('exports default instructions for every supported configurable phase', () => {
		expect(DEFAULT_PHASE_INSTRUCTIONS.plan).toContain('Do not write code yet');
		expect(DEFAULT_PHASE_INSTRUCTIONS['plan-review']).toContain('Review the plan');
		expect(DEFAULT_PHASE_INSTRUCTIONS.work).toContain('Implement the approved plan');
		expect(DEFAULT_PHASE_INSTRUCTIONS['work-review']).toContain('Review the code changes');
		expect(DEFAULT_PHASE_INSTRUCTIONS.wrapup).toContain('configured wrapup actions');
	});
});
```

- [ ] **Step 3: Switch the prompt assembler to import the shared defaults**

Modify `packages/agent-vm-worker/src/prompt/prompt-assembler.ts`:

```ts
import { DEFAULT_BASE_INSTRUCTIONS, DEFAULT_PHASE_INSTRUCTIONS } from './prompt-defaults.js';
```

Delete the duplicated `DEFAULT_BASE_INSTRUCTIONS` and `DEFAULT_PHASE_INSTRUCTIONS` literals from this file, but keep `BASE_WORKER_PROMPT` and `BASE_REVIEW_PROMPT` local because the scaffolded config only needs the instruction overrides, not the system framing text.

- [ ] **Step 4: Export the shared defaults from the worker package**

Modify `packages/agent-vm-worker/src/index.ts`:

```ts
export {
	DEFAULT_BASE_INSTRUCTIONS,
	DEFAULT_PHASE_INSTRUCTIONS,
} from './prompt/prompt-defaults.js';
```

- [ ] **Step 5: Run targeted unit tests for the worker package**

Run from repo root:

```bash
pnpm test:unit -- packages/agent-vm-worker/src/prompt/prompt-defaults.test.ts packages/agent-vm-worker/src/prompt/prompt-assembler.test.ts
```

Expected: both test files pass, exit code `0`.

- [ ] **Step 6: Commit the worker-default extraction**

```bash
git add packages/agent-vm-worker/src/prompt/prompt-defaults.ts packages/agent-vm-worker/src/prompt/prompt-defaults.test.ts packages/agent-vm-worker/src/prompt/prompt-assembler.ts packages/agent-vm-worker/src/index.ts
git commit -m "refactor: share worker prompt defaults for scaffold"
```

Expected: commit succeeds with only the worker-default extraction changes staged.

---

## Task 2: Scaffold Explicit Instruction Keys in `worker.json`

**Files:**
- Modify: `packages/agent-vm/src/cli/init-command.ts`
- Modify: `packages/agent-vm/src/cli/init-command.test.ts`

**Steps:**

- [ ] **Step 1: Write the failing scaffold test first**

Add a new test to `packages/agent-vm/src/cli/init-command.test.ts` that asserts `worker.json` contains explicit instruction values after scaffolding:

```ts
it('scaffolds worker.json with explicit default instructions for every phase', async () => {
	const targetDir = createTestDirectory();

	await scaffoldAgentVmProject(
		{ gatewayType: 'worker', targetDir, zoneId: 'test-worker' },
		noGeneratedAgeIdentityDependencies,
	);

	const workerConfig = JSON.parse(
		fs.readFileSync(path.join(targetDir, 'config', 'test-worker', 'worker.json'), 'utf8'),
	);

	expect(workerConfig.instructions).toContain('Do NOT run git push');
	expect(workerConfig.phases.plan.instructions).toContain('Do not write code yet');
	expect(workerConfig.phases.planReview.instructions).toContain('Review the plan');
	expect(workerConfig.phases.work.instructions).toContain('Implement the approved plan');
	expect(workerConfig.phases.workReview.instructions).toContain('Review the code changes');
	expect(workerConfig.phases.wrapup.instructions).toContain('configured wrapup actions');
});
```

- [ ] **Step 2: Run the CLI scaffold test to watch it fail**

Run from repo root:

```bash
pnpm test:unit -- packages/agent-vm/src/cli/init-command.test.ts
```

Expected: FAIL because scaffolded `worker.json` currently omits `instructions` and all `phases.*.instructions` keys.

- [ ] **Step 3: Replace the minimal worker scaffold object with an explicit defaults object**

Modify `packages/agent-vm/src/cli/init-command.ts` so `defaultWorkerGatewayConfig()` returns a concrete object with explicit instruction values instead of `workerConfigSchema.parse({})`:

```ts
import {
	DEFAULT_BASE_INSTRUCTIONS,
	DEFAULT_PHASE_INSTRUCTIONS,
	workerConfigSchema,
} from '@shravansunder/agent-vm-worker';
```

Then update the helper:

```ts
const DEFAULT_PHASE_INSTRUCTIONS_BY_CONFIG_KEY = {
	plan: DEFAULT_PHASE_INSTRUCTIONS.plan,
	planReview: DEFAULT_PHASE_INSTRUCTIONS['plan-review'],
	work: DEFAULT_PHASE_INSTRUCTIONS.work,
	workReview: DEFAULT_PHASE_INSTRUCTIONS['work-review'],
	wrapup: DEFAULT_PHASE_INSTRUCTIONS.wrapup,
} as const;

const defaultWorkerGatewayConfig = (): object =>
	workerConfigSchema.parse({
		instructions: DEFAULT_BASE_INSTRUCTIONS,
		phases: {
			plan: {
				instructions: DEFAULT_PHASE_INSTRUCTIONS_BY_CONFIG_KEY.plan,
			},
			planReview: {
				instructions: DEFAULT_PHASE_INSTRUCTIONS_BY_CONFIG_KEY.planReview,
			},
			work: {
				instructions: DEFAULT_PHASE_INSTRUCTIONS_BY_CONFIG_KEY.work,
			},
			workReview: {
				instructions: DEFAULT_PHASE_INSTRUCTIONS_BY_CONFIG_KEY.workReview,
			},
			wrapup: {
				instructions: DEFAULT_PHASE_INSTRUCTIONS_BY_CONFIG_KEY.wrapup,
			},
		},
	});
```

Important: keep `workerConfigSchema.parse(...)` so the scaffold still receives all existing defaults (`defaults.provider`, `defaults.model`, `branchPrefix`, retry counts, verification commands, wrapup actions) in addition to the explicit instruction keys. The separate `DEFAULT_PHASE_INSTRUCTIONS_BY_CONFIG_KEY` object makes the kebab-case runtime phase ids to camelCase config keys translation deliberate instead of hidden inside inline property lookups.

- [ ] **Step 4: Add a regression assertion that the scaffold still carries the non-instruction defaults**

Extend the same test or add a second focused assertion in `init-command.test.ts`:

```ts
expect(workerConfig.defaults.provider).toBe('codex');
expect(workerConfig.defaults.model).toBe('latest-medium');
expect(workerConfig.phases.plan.maxReviewLoops).toBe(2);
expect(workerConfig.phases.work.maxVerificationRetries).toBe(3);
expect(workerConfig.wrapupActions).toEqual([{ type: 'git-pr', required: true }]);
```

This prevents a partial scaffold rewrite that only emits instructions and accidentally drops the operational defaults.

- [ ] **Step 5: Run the scaffold test again and confirm it passes**

Run from repo root:

```bash
pnpm test:unit -- packages/agent-vm/src/cli/init-command.test.ts
```

Expected: PASS, exit code `0`.

- [ ] **Step 6: Commit the scaffold behavior change**

```bash
git add packages/agent-vm/src/cli/init-command.ts packages/agent-vm/src/cli/init-command.test.ts
git commit -m "feat: scaffold worker instruction defaults"
```

Expected: commit succeeds with only the CLI scaffold changes staged.

---

## Task 3: Update Docs to Match the New Scaffolded Output

**Files:**
- Modify: `docs/getting-started/worker-guide.md`
- Modify: `docs/reference/configuration-reference.md`

**Steps:**

- [ ] **Step 1: Update the worker guide example to show visible instruction keys**

Modify the `worker.json` example in `docs/getting-started/worker-guide.md` so it includes:

```json
{
  "instructions": "## Git Rules\n...",
  "defaults": { "provider": "codex", "model": "latest-medium" },
  "phases": {
    "plan": {
      "instructions": "Create an implementation plan for the task. Do not write code yet.",
      "maxReviewLoops": 2
    },
    "planReview": {
      "instructions": "Review the plan for completeness, correctness, risks, and missing edge cases."
    },
    "work": {
      "instructions": "Implement the approved plan.",
      "maxReviewLoops": 3,
      "maxVerificationRetries": 3
    },
    "workReview": {
      "instructions": "Review the code changes for correctness, bugs, style, and test coverage."
    },
    "wrapup": {
      "instructions": "Complete the task by running the configured wrapup actions. ..."
    }
  }
}
```

Keep the example trimmed with `...` only inside long string literals, not in place of missing keys.

- [ ] **Step 2: Clarify the reference docs**

Update `docs/reference/configuration-reference.md` in two places:

1. In the `worker.json` section, note that `agent-vm init --gateway-type worker` now writes the built-in instruction defaults explicitly into the scaffolded file.
2. In the defaults table, keep the field defaults as the source of truth even when the scaffold writes them explicitly.

Suggested sentence:

```md
The worker scaffold generated by `agent-vm init --gateway-type worker` writes the current built-in `instructions` and `phases.*.instructions` values explicitly so teams can edit them in-place without reading runtime source.
```

- [ ] **Step 3: Run targeted docs-adjacent verification**

Run from repo root:

```bash
pnpm fmt:check docs/getting-started/worker-guide.md docs/reference/configuration-reference.md packages/agent-vm/src/cli/init-command.ts packages/agent-vm-worker/src/prompt/prompt-defaults.ts
```

Expected: exit code `0`.

- [ ] **Step 4: Run the full relevant verification sweep**

Run from repo root:

```bash
pnpm test:unit -- packages/agent-vm/src/cli/init-command.test.ts packages/agent-vm-worker/src/prompt/prompt-defaults.test.ts packages/agent-vm-worker/src/prompt/prompt-assembler.test.ts
pnpm check
pnpm lint
```

Expected:
- targeted unit tests pass
- `pnpm check` exits `0` and covers type-aware lint, format check, and typecheck
- `pnpm lint` exits `0`

- [ ] **Step 5: Commit the docs alignment**

```bash
git add docs/getting-started/worker-guide.md docs/reference/configuration-reference.md
git commit -m "docs: document scaffolded worker instructions"
```

Expected: commit succeeds with only the docs changes staged.

---

## Self-Review

### Spec coverage

- Requirement: scaffolded `worker.json` must show the default instructions explicitly.
  Covered by Task 2.
- Requirement: runtime and scaffold must not drift.
  Covered by Task 1 through shared constants.
- Requirement: docs should match the new generated file shape.
  Covered by Task 3.

### Placeholder scan

- No `TODO`, `TBD`, or “appropriate handling” placeholders remain.
- Every task includes exact file paths and concrete commands.

### Type consistency

- Phase keys remain `plan`, `planReview`, `work`, `workReview`, `wrapup` in config objects.
- Prompt-default map keys remain `plan`, `plan-review`, `work`, `work-review`, `wrapup` where they match the runtime phase-name lookup in `prompt-assembler.ts`.
- The scaffold adds an explicit `DEFAULT_PHASE_INSTRUCTIONS_BY_CONFIG_KEY` translation layer so the camelCase config keys are not inferred from inline string literals.
- No `coordinator` phase key is introduced anywhere.
