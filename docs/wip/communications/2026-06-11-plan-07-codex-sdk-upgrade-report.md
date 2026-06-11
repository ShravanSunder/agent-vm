# Plan 07 Codex SDK Upgrade Report

Status: implemented
Branch: improve/plan-07-codex-sdk-upgrade
Worktree: /Users/shravansunder/Documents/dev/project-dev/agent-vm.improve-plan-07-codex-sdk-upgrade

## Coverage

- Plan loaded: docs/superpowers/plans/2026-06-10-repo-improvements/07-codex-sdk-upgrade.md, 132 lines, read 1-132.
- Execution skill loaded earlier in this goal: implementation-execute-plan/SKILL.md, 115 lines.
- Validation checklist loaded earlier in this goal: implementation-execute-plan/references/validation-checklist.md, 54 lines.
- OpenAI docs skill loaded: openai-docs/SKILL.md, 167 lines.
- TDD skill and testing anti-patterns loaded earlier in this goal. This slice is a dependency-only bump; no production behavior was added before tests.

## Research And Decisions

- `pnpm view @openai/codex-sdk version dist-tags repository homepage time --json`
  - Exit code: 0.
  - Latest stable: `0.139.0`.
  - Alpha: `0.140.0-alpha.9`.
  - Repository: `openai/codex`, directory `sdk/typescript`.
- `pnpm search codex-sdk --json`
  - Exit code: 0.
  - Found `@openai/codex-sdk@0.139.0` as the official OpenAI package and no official successor package replacing it.
- DeepWiki `ask_question` against `openai/codex` confirmed the current SDK public surface still includes the worker call sites:
  `Codex`, `startThread`, `resumeThread`, `Thread.run`, `Thread.runStreamed`, `Thread.id`, `finalResponse`, `usage.output_tokens`, `modelReasoningEffort`, `sandboxMode`, and `networkAccessEnabled`.
- Installed d.ts inspection confirmed both `0.130.0` and `0.139.0` expose `runStreamed`.
  - Decision: defer streaming adoption. It is not new in this upgrade, and wiring progress into the event log would overlap Plan 09's event-stream work. This slice keeps the bump conservative.
- OpenAI deprecations page checked on 2026-06-11:
  https://developers.openai.com/api/docs/deprecations
  - `gpt-5.4` and `gpt-5.4-mini` appear as recommended replacements, not deprecation targets.
  - Decision: no `MODEL_ALIASES.codex` changes.

## Changes

- `packages/agent-vm-worker/package.json`
  - Bumped `@openai/codex-sdk` from `^0.130.0` to `^0.139.0`.
- `pnpm-lock.yaml`
  - Updated `@openai/codex-sdk` and platform `@openai/codex` packages from `0.130.0` to `0.139.0`.

## Proof

- `pnpm install`
  - Exit code: 0.
  - Updated lockfile. Workspace bin warnings were expected before build outputs exist.
- Installed d.ts inspection:
  - `node_modules/.pnpm/@openai+codex-sdk@0.139.0/node_modules/@openai/codex-sdk/dist/index.d.ts`
  - Confirmed worker-used APIs and option names remain present.
- `pnpm build`
  - Exit code: 0.
- `pnpm typecheck`
  - Exit code: 0.
- `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm-worker/src`
  - Exit code: 0.
  - 23 files passed, 179 tests passed.
- `pnpm vitest run --config vitest.config.ts --project integration packages/agent-vm-worker/src`
  - Exit code: 0.
  - 3 files passed, 12 tests passed.
- `pnpm check`
  - Exit code: 0.
  - 6 passed, 0 failed.
  - Type-aware lint emitted existing warnings but 0 errors and the gate passed.
- `pnpm test:unit`
  - Exit code: 0.
  - Taxonomy passed; 197 files passed, 1802 tests passed.
- `pnpm test:integration`
  - Exit code: 0.
  - 23 files passed, 327 tests passed.
- `mise run lint`
  - Exit code: 0.
  - 0 warnings, 0 errors.
- `git diff --check`
  - Exit code: 0.

## E2E

Worker e2e was not run. Prerequisite check:

```json
{
  "AGENT_VM_WORKER_E2E": false,
  "AGENT_VM_TEST_OPENAI_API_KEY": false,
  "OPENAI_API_KEY": false
}
```

`codex` binary is present at `/opt/homebrew/bin/codex`, but the required API-key gate is absent.

## Branch State

Pending commit at report time:

- `packages/agent-vm-worker/package.json`
- `pnpm-lock.yaml`
- `docs/wip/communications/2026-06-11-plan-07-codex-sdk-upgrade-report.md`
