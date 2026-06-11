# Plan 08 Worker Executor Genericization Report

Status: stopped-at-gate
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

The plan remains stopped at task 3's explicit user decision:

- Keep provider-neutral contract method name `getThreadId()`, or
- hard-cutover the worker executor contract to `getSessionRef()` across
  executor interface, Codex executor, persistent-thread, task event consumers,
  and tests.

No Claude executor file, factory case, image bake decision, or interface doc
cutover was written because those steps are after the user-gated task 3
decision.

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

Broad gates not yet run for this stopped-at-gate branch:

- `pnpm check`
- `pnpm test:unit`
- `pnpm test:integration`
- worker E2E lane

Reason: Plan 08 is intentionally stopped before task 3's user decision and
before the Claude executor implementation. The focused proof covers the safe
pre-gate changes; broad gates should run after the interface decision and the
actual Claude executor slice lands.

Worker E2E gate status:

- Codex worker E2E was not rerun in this stopped-at-gate packet.
- Claude worker E2E is only gate-wired; it is not expected to run until the
  Claude executor exists and credentials/binary prerequisites are intentionally
  selected.

## Open Gate

Plan 08 task 3 remains a user decision:

1. Keep `getThreadId()`, accepting the Codex-shaped historical method name as
   the provider-neutral session reference accessor for now.
2. Hard-cutover to `getSessionRef()`, updating all call sites and event/task
   consumers in the same pass with no compatibility alias.

No branch push has been performed yet at the time this report was written.
