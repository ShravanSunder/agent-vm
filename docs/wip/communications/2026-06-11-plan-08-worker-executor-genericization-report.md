# Plan 08 Worker Executor Genericization Report

Status: resumed task 3 complete; Claude executor tasks not yet implemented
Branch: improve/plan-08-worker-executor-genericization
Base: stacked on improve/plan-07-codex-sdk-upgrade at 115f9fc

## Summary

Implemented and verified the safe pre-gate parts of Plan 08:

- Generic `*_API_KEY=` error-message redaction, covering Anthropic and
  internal API key env assignments without weakening existing OpenAI redaction.
- Provider-parameterized worker runtime E2E gates:
  - Codex requires `codex` plus `AGENT_VM_TEST_OPENAI_API_KEY`.
  - Claude requires `claude` plus `AGENT_VM_TEST_ANTHROPIC_API_KEY`.
- Extracted Codex runtime capability setup into
  `codex-capability-setup.ts`, keeping Codex MCP registration provider-owned
  while preserving existing Codex executor behavior.
- Normalized the extracted Codex runtime env to `Record<string, string>` so it
  matches the Codex SDK contract without casts.

The previous report stopped at task 3's explicit user decision:

- Keep provider-neutral contract method name `getThreadId()`, or
- hard-cutover the worker executor contract to `getSessionRef()` across
  executor interface, Codex executor, persistent-thread, task event consumers,
  and tests.

The resumed decision was to hard-cutover to `getSessionRef()`. No Claude
executor file, factory case, or image bake decision has been written yet; those
remain the next Plan 08 implementation tasks.

## 2026-06-12 Resumed Update

Implemented the task 3 hard cutover:

- Renamed `WorkExecutor.getThreadId()` to `getSessionRef()`.
- Renamed `ExecutorResult.threadId` and persistent-thread responses to
  `sessionRef`.
- Renamed task event and task state persisted fields from thread-specific names
  to session-specific names:
  `planAgentSessionRef`, `planReviewerSessionRef`, `workAgentSessionRef`,
  `workReviewerSessionRef`, and `wrapupSessionRef`.
- Kept Codex SDK internal `Thread` naming only at the Codex boundary while the
  worker-owned contract exposes provider-neutral session references.
- Added concise interface docs for `execute`, `fix`, `resumeOrRebuild`, and
  `getSessionRef`.

Additional files touched by the resumed cutover:

- `packages/agent-vm-worker/src/coordinator/coordinator.integration.test.ts`
- `packages/agent-vm-worker/src/coordinator/task-runner.ts`
- `packages/agent-vm-worker/src/plan-phase/plan-cycle.unit.test.ts`
- `packages/agent-vm-worker/src/server.unit.test.ts`
- `packages/agent-vm-worker/src/state/task-event-types.ts`
- `packages/agent-vm-worker/src/state/task-state.ts`
- `packages/agent-vm-worker/src/state/task-state.unit.test.ts`
- `packages/agent-vm-worker/src/work-executor/codex-executor.ts`
- `packages/agent-vm-worker/src/work-executor/codex-executor.unit.test.ts`
- `packages/agent-vm-worker/src/work-executor/executor-interface.ts`
- `packages/agent-vm-worker/src/work-executor/persistent-thread.ts`
- `packages/agent-vm-worker/src/work-executor/persistent-thread.unit.test.ts`
- `packages/agent-vm-worker/src/work-phase/work-cycle.unit.test.ts`
- `packages/agent-vm-worker/src/worker-runtime.integration.test.ts`
- `packages/agent-vm-worker/src/wrapup-phase/wrapup-runner.unit.test.ts`
- `packages/agent-vm/src/integration-tests/worker-task-runner.host.e2e.test.ts`

Resumed proof:

- `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm-worker/src/work-executor/persistent-thread.unit.test.ts packages/agent-vm-worker/src/work-executor/codex-executor.unit.test.ts packages/agent-vm-worker/src/state/task-state.unit.test.ts packages/agent-vm-worker/src/plan-phase/plan-cycle.unit.test.ts packages/agent-vm-worker/src/work-phase/work-cycle.unit.test.ts packages/agent-vm-worker/src/wrapup-phase/wrapup-runner.unit.test.ts packages/agent-vm-worker/src/server.unit.test.ts`
  - exit 0
  - 7 files passed
  - 64 tests passed
- `pnpm vitest run --config vitest.config.ts --project integration packages/agent-vm-worker/src/worker-runtime.integration.test.ts packages/agent-vm-worker/src/coordinator/coordinator.integration.test.ts`
  - exit 0
  - 2 files passed
  - 9 tests passed
- `rg -n "threadId|getThreadId|ThreadId|planAgentThreadId|planReviewerThreadId|workAgentThreadId|workReviewerThreadId|wrapupThreadId" packages/agent-vm-worker packages/agent-vm/src/integration-tests/worker-task-runner.host.e2e.test.ts`
  - exit 1
  - no old worker executor API or persisted state names found in the checked
    surfaces
- `pnpm typecheck`
  - exit 0
- `pnpm fmt:check`
  - exit 0
- `mise run lint`
  - exit 0
  - 0 warnings
  - 0 errors
- `pnpm check`
  - exit 0
  - check gate: 6 passed, 0 failed in 22.57s

## Research Gate

Resolved Plan 08 task 1 without finding a design stop:

- Conversation/session resume:
  - Official CLI docs describe `--continue` as continuing the most recent
    conversation and `--resume` as resuming a session by ID or name.
  - Official SDK docs expose session metadata and `getSessionMessages()`,
    which reads user and assistant messages from past session transcripts.
  - Conclusion: Claude sessions are conversation/session based, not merely
    workspace snapshots, so the current `fix()` / `resumeOrRebuild()` semantic
    remains viable.
- MCP in headless mode:
  - Official CLI docs list `-p/--print` for non-interactive output and
    `--mcp-config` for loading MCP servers from JSON files or strings.
  - Local probe on Claude Code 2.1.173:
    `env ANTHROPIC_API_KEY= claude -p --mcp-config '{"mcpServers":{}}' --output-format json 'ping'`
    exited 0 and returned a JSON result with `session_id`.
  - Conclusion: `--mcp-config` is accepted in print/headless mode by the
    installed binary.
- SDK vs CLI decision:
  - Official SDK docs expose `query()` options for `resume`, `continue`,
    `cwd`, `mcpServers`, `permissionMode`, `allowedTools`, `canUseTool`, and
    result/system messages with `session_id`, `result`, `usage`,
    `permission_denials`, `cwd`, `tools`, `mcp_servers`, and
    `permissionMode`.
  - Official SDK overview says the TypeScript SDK bundles a native Claude Code
    binary as an optional dependency.
  - `pnpm view @anthropic-ai/claude-agent-sdk` showed latest `0.3.173` and
    platform optional dependencies.
  - Conclusion: the TypeScript Claude Agent SDK is the better fit for the
    future executor because it gives typed programmatic control instead of
    CLI JSON parsing and temporary config-file management.
- Reasoning effort:
  - Official CLI docs support `--effort low|medium|high|xhigh|max`.
  - Official SDK docs expose `effort?: EffortLevel | null`.
  - Conclusion: Claude supports an effort mapping; Plan 08 should map existing
    worker reasoning effort after the interface-name decision.

Official references:

- https://code.claude.com/docs/en/cli-reference
- https://platform.claude.com/docs/en/agent-sdk/typescript
- https://code.claude.com/docs/en/agent-sdk/overview

DeepWiki also reviewed `anthropics/claude-agent-sdk-typescript` and
`anthropics/claude-code`; it agreed that the SDK is a better executor fit for
programmatic sessions, MCP, permission, result, and lifecycle handling.

## Files Touched

- `packages/agent-vm-worker/src/coordinator/coordinator-helpers.ts`
- `packages/agent-vm-worker/src/coordinator/coordinator-helpers.unit.test.ts`
- `packages/agent-vm-worker/src/work-executor/codex-capability-setup.ts`
- `packages/agent-vm-worker/src/work-executor/codex-executor.ts`
- `packages/agent-vm-worker/src/worker-e2e-gates.ts`
- `packages/agent-vm-worker/src/worker-e2e-gates.unit.test.ts`
- `packages/agent-vm-worker/src/worker-runtime.worker.e2e.test.ts`

All touched files are within the plan's declared write surfaces for safe
pre-gate work.

## Red/Green Evidence

Red tests:

- `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm-worker/src/coordinator/coordinator-helpers.unit.test.ts packages/agent-vm-worker/src/worker-e2e-gates.unit.test.ts`
  - exit 1 before implementation.
  - Expected failures:
    - Claude worker runtime smoke gate returned false despite
      `AGENT_VM_TEST_ANTHROPIC_API_KEY` and `claude`.
    - Anthropic/generic API key env assignments were not redacted.

Green focused tests:

- `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm-worker/src/coordinator/coordinator-helpers.unit.test.ts packages/agent-vm-worker/src/worker-e2e-gates.unit.test.ts`
  - exit 0
  - 2 files passed
  - 9 tests passed
- `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm-worker/src/work-executor/codex-executor.unit.test.ts packages/agent-vm-worker/src/coordinator/coordinator-helpers.unit.test.ts packages/agent-vm-worker/src/worker-e2e-gates.unit.test.ts`
  - exit 0
  - 3 files passed
  - 29 tests passed

## Proof Gates Run

- `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm-worker/src/work-executor/codex-executor.unit.test.ts packages/agent-vm-worker/src/coordinator/coordinator-helpers.unit.test.ts packages/agent-vm-worker/src/worker-e2e-gates.unit.test.ts`
  - exit 0
  - 3 files passed
  - 29 tests passed
- `pnpm typecheck`
  - first run: exit 2 due to extracted Codex env type mismatch
    (`ProcessEnv` vs `Record<string, string>`).
  - final run: exit 0; root typecheck plus 11 workspace package typechecks
    passed.
- `pnpm fmt:check`
  - first run: exit 1 on `coordinator-helpers.ts` and `codex-executor.ts`.
  - after `pnpm fmt`: exit 0; all matched files use correct format.

Broad resumed gates now run for the task 3 cutover:

- `pnpm check`
  - exit 0
  - 6 passed / 0 failed

Full `pnpm test:unit`, full `pnpm test:integration`, and worker E2E are still
deferred until the remaining Claude executor implementation lands. The current
branch proof covers the pre-gate work and the task 3 provider-neutral cutover.

Worker E2E gate status:

- Codex worker E2E was not rerun in this stopped-at-gate packet.
- Claude worker E2E is only gate-wired; it is not expected to run until the
  Claude executor exists and credentials/binary prerequisites are intentionally
  selected.

## Resolved Gate

Plan 08 task 3 user decision was resolved:

- Hard-cutover to `getSessionRef()`, updating call sites, event consumers,
  persisted task state names, and tests in the same pass with no compatibility
  alias.

Remaining Plan 08 work:

- Claude executor implementation.
- Worker executor factory/image packaging decision.
- Claude-specific proof gates once the executor exists.

Branch pushed to `origin/improve/plan-08-worker-executor-genericization`.
