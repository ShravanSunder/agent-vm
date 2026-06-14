# Plan 08 Worker Executor Genericization Report

Status: Claude executor implemented and review-fixed; live worker E2E gated by missing credentials
Branch: improve/plan-08-worker-executor-genericization
Base: stacked on improve/plan-07-codex-sdk-upgrade at 115f9fc

## Summary

Implemented and verified the safe pre-gate parts of Plan 08:

- Generic `*_API_KEY=` error-message redaction, covering Anthropic and
  internal API key env assignments without weakening existing OpenAI redaction.
- Provider-parameterized worker runtime E2E gates:
  - Codex requires `codex` plus `AGENT_VM_TEST_OPENAI_API_KEY`.
  - Claude requires `AGENT_VM_TEST_ANTHROPIC_API_KEY` and uses the
    SDK-bundled Claude Code binary path.
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
executor compatibility alias was kept.

The final resumed slice implemented the Claude Agent SDK executor, wired the
factory/export path, and updated worker runtime E2E provider gates so Claude uses
the SDK-bundled binary path rather than requiring a global `claude` CLI. The
review follow-up added an actionable runtime availability guard, isolated Claude
SDK filesystem state under worker-controlled runtime state, disabled inherited
Claude settings/hooks, and cancels the active SDK query on worker turn timeout.

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

## 2026-06-12 Claude Executor Update

Implemented the Claude executor slice:

- Added `@anthropic-ai/claude-agent-sdk@0.3.174` and
  `@anthropic-ai/sdk@0.100.1` to `@agent-vm/agent-vm-worker`.
- Added `claude-code-executor.ts` using the Claude Agent SDK `query()` API with
  `execute`, `fix`, `resumeOrRebuild`, and `getSessionRef`.
- Added `claude-capability-setup.ts` to resolve the SDK optional platform binary
  and fail actionably if optional dependencies were omitted.
- Mapped worker reasoning effort to Claude SDK effort values:
  `minimal -> low`; `low`, `medium`, `high`, and `xhigh` pass through.
- Mapped worker MCP server capabilities to Claude HTTP MCP server configs.
- Preserved local tool support by registering `agent-vm-local-tools` through the
  existing local tool MCP server.
- Wired `executor-factory.ts` and `index.ts` so `provider: "claude"` creates and
  exports the Claude executor.
- Updated worker runtime E2E smoke coverage to loop Codex and Claude provider
  cases independently.
- Updated worker E2E gates so Codex still requires the global `codex` command,
  while Claude requires `AGENT_VM_TEST_ANTHROPIC_API_KEY` plus an available SDK
  bundled Claude Code binary instead of a global `claude` command.

Packaging decision:

- No worker Dockerfile/global CLI bake change was made in this slice. The
  selected runtime path is the Claude Agent SDK package plus its optional
  platform dependency, which is installed with the worker package dependency
  graph. The executor resolves that binary at creation and gives a concrete
  reinstall-with-optional-dependencies error if it is missing. Codex remains the
  only provider that requires a global command gate.

Security and boundary note:

- For configured worker MCP servers with `bearerTokenEnvVar`, the Claude SDK
  executor resolves the token from runtime environment and passes an
  `Authorization: Bearer ...` header in the in-memory SDK MCP config. The SDK
  type does not expose an environment-variable header placeholder. This does not
  write the token to repo config, images, lockfiles, or generated deployment
  files.
- Claude SDK state is isolated with worker-created `HOME` and
  `CLAUDE_CONFIG_DIR` paths rooted under `STATE_DIR` when available, and
  `settingSources: []` prevents inherited user/project/local Claude settings or
  hooks from affecting worker execution.

## 2026-06-12 Implementation Review Fixes

Ran the implementation review swarm with six read-only reviewer lanes covering
spec compliance, proof gates, contracts/tests, security/trust boundaries,
reliability, and adversarial code quality.

Accepted and fixed findings:

- Claude runtime availability now fails before executor use if the SDK optional
  platform binary is missing.
- Worker E2E gate construction no longer creates skipped tests for disabled
  providers; unavailable provider cases are not registered as skipped proof.
- Claude SDK filesystem state is isolated under worker-controlled runtime state.
- Inherited Claude settings and hooks are disabled with `settingSources: []`.
- Persistent thread timeouts call optional executor cancellation, and the Claude
  executor closes the active SDK query.
- `fix()` no longer attempts unsafe rebuild after a recoverable Claude resume
  failure, because rebuilding without the prior assistant transcript can silently
  change conversation state.
- Claude unit coverage now includes runtime availability, state isolation,
  fail-safe resume errors, factory wiring, MCP mapping, and timeout cancellation.

Rejected as unsafe:

- Auto-rebuilding a failed Claude `fix()` session from only the worker-provided
  context. The safe behavior is to fail actionably until the SDK can resume the
  referenced session.

Claude executor proof:

- Red:
  `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm-worker/src/work-executor/claude-code-executor.unit.test.ts packages/agent-vm-worker/src/work-executor/codex-executor.unit.test.ts`
  - exit 1 before implementation
  - 10 expected failures from missing Claude executor/factory support
- Focused green:
  `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm-worker/src/work-executor/claude-code-executor.unit.test.ts packages/agent-vm-worker/src/work-executor/codex-executor.unit.test.ts packages/agent-vm-worker/src/worker-e2e-gates.unit.test.ts`
  - exit 0
  - 3 files passed
  - 35 tests passed
- Review-fix red:
  `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm-worker/src/work-executor/claude-code-executor.unit.test.ts packages/agent-vm-worker/src/worker-e2e-gates.unit.test.ts`
  - exit 1 before review fixes
  - 5 expected failures covering Claude runtime availability, SDK state
    isolation/settings, fail-safe resume errors, and timeout cancellation
- Review-fix focused green:
  `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm-worker/src/work-executor/claude-code-executor.unit.test.ts packages/agent-vm-worker/src/work-executor/codex-executor.unit.test.ts packages/agent-vm-worker/src/worker-e2e-gates.unit.test.ts packages/agent-vm-worker/src/work-executor/persistent-thread.unit.test.ts`
  - exit 0
  - 4 files passed
  - 43 tests passed
- Worker package focused green:
  `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm-worker/src`
  - exit 0
  - 24 files passed
  - 195 tests passed
- `pnpm fmt:check`
  - exit 0
  - all matched files use the correct format
- `mise run lint`
  - exit 0
  - 0 warnings
  - 0 errors
- `pnpm typecheck`
  - exit 0
  - root typecheck plus 11 workspace package typechecks passed
- `pnpm check`
  - exit 0
  - check gate: 6 passed, 0 failed in 28.34s
- `pnpm test:unit`
  - exit 0
  - 198 files passed
  - 1818 tests passed
- `pnpm test:integration`
  - exit 0
  - 23 files passed
  - 327 tests passed
- Worker E2E prerequisite check:
  `bash -lc 'for n in AGENT_VM_WORKER_E2E AGENT_VM_TEST_OPENAI_API_KEY AGENT_VM_TEST_ANTHROPIC_API_KEY; do if [ -n "${!n:-}" ]; then echo "$n=set"; else echo "$n=unset"; fi; done'`
  - exit 0
  - `AGENT_VM_WORKER_E2E=unset`
  - `AGENT_VM_TEST_OPENAI_API_KEY=unset`
  - `AGENT_VM_TEST_ANTHROPIC_API_KEY=unset`
- Validation note:
  - A concurrent full `pnpm test:unit` plus `pnpm test:integration` run caused
    the unit lane to abort with exit 134.
  - `pnpm test:integration` passed in that run.
  - Rerunning `pnpm test:unit` alone immediately afterward passed. After the
    review fixes, the current final standalone unit proof is the 198-file /
    1818-test run listed above.

Worker E2E proof split:

- `AGENT_VM_WORKER_E2E`, `AGENT_VM_TEST_OPENAI_API_KEY`, and
  `AGENT_VM_TEST_ANTHROPIC_API_KEY` were unset in this shell.
- Worker runtime E2E was not run here; this branch has unit/integration/static
  proof for the Claude executor wiring but no live provider roundtrip proof in
  this environment.

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
- `packages/agent-vm-worker/package.json`
- `packages/agent-vm-worker/src/work-executor/codex-capability-setup.ts`
- `packages/agent-vm-worker/src/work-executor/codex-executor.ts`
- `packages/agent-vm-worker/src/worker-e2e-gates.ts`
- `packages/agent-vm-worker/src/worker-e2e-gates.unit.test.ts`
- `packages/agent-vm-worker/src/worker-runtime.worker.e2e.test.ts`
- `packages/agent-vm-worker/src/work-executor/claude-capability-setup.ts`
- `packages/agent-vm-worker/src/work-executor/claude-code-executor.ts`
- `packages/agent-vm-worker/src/work-executor/claude-code-executor.unit.test.ts`
- `packages/agent-vm-worker/src/work-executor/codex-executor.unit.test.ts`
- `packages/agent-vm-worker/src/work-executor/executor-factory.ts`
- `packages/agent-vm-worker/src/work-executor/executor-interface.ts`
- `packages/agent-vm-worker/src/work-executor/persistent-thread.ts`
- `packages/agent-vm-worker/src/index.ts`
- `pnpm-lock.yaml`

All touched files are within the plan's declared write surfaces.

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

Broad resumed gates now run for the task 3 cutover and Claude executor
implementation:

- `pnpm check`
  - exit 0
  - 6 passed / 0 failed in 28.34s
- `pnpm test:unit`
  - exit 0
  - 198 files passed
  - 1818 tests passed
- `pnpm test:integration`
  - exit 0
  - 23 files passed
  - 327 tests passed

The current branch proof covers the pre-gate work, task 3 provider-neutral
cutover, and Claude executor implementation. Live worker E2E remains blocked by
missing provider credentials in this shell.

Worker E2E gate status:

- Codex worker E2E was not rerun in this environment.
- Claude worker E2E is implemented and gate-wired, but was not run because
  `AGENT_VM_WORKER_E2E` and `AGENT_VM_TEST_ANTHROPIC_API_KEY` were unset.

## Resolved Gate

Plan 08 task 3 user decision was resolved:

- Hard-cutover to `getSessionRef()`, updating call sites, event consumers,
  persisted task state names, and tests in the same pass with no compatibility
  alias.

Remaining Plan 08 work:

- Live Claude worker E2E provider proof in an environment with
  `AGENT_VM_WORKER_E2E=1` and `AGENT_VM_TEST_ANTHROPIC_API_KEY`.

Branch pushed to `origin/improve/plan-08-worker-executor-genericization`.
