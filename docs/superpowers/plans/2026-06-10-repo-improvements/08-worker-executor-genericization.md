# Worker Executor Genericization (Codex Today, Claude Code Next)

Planned at: 4f419b0
Repo: /Users/shravansunder/Documents/dev/project-dev/agent-vm.improve-v1
Status: proposed
Priority: 8 (capability — unblocks non-Codex agent runtimes; larger slice)

## Problem

The phase pipeline (plan/work/wrapup via `PersistentThread`) is already
cleanly abstracted behind `WorkExecutor` — no SDK types cross the boundary.
But making `provider: 'claude'` real (today: `throw new Error('Claude
executor is not implemented yet.')`) is blocked by Codex-specific seams that
sit *outside* the interface:

1. **Capability setup is Codex-CLI-specific.** MCP servers are registered by
   shelling to `codex mcp add` against a Codex config home. Claude Code
   configures MCP via an `--mcp-config` JSON file / settings — a different
   mechanism entirely, and there is no abstraction for "prepare the agent
   runtime's capabilities before first turn".
2. **Interface semantics are thread-shaped.** `resumeOrRebuild(threadId)`,
   `getThreadId()`, and the `fix()` (continue-same-thread) vs `execute()`
   (new thread) split encode Codex's server-side thread model. They are
   implementable for Claude Code (local session resume / context replay) but
   the contract should say what it means provider-neutrally.
3. **Auth and hygiene are OpenAI-only.** `OPENAI_API_KEY` is read directly;
   error scrubbing covers `sk-*`/`OPENAI_API_KEY=` but not
   `ANTHROPIC_API_KEY`; the E2E gate hardcodes `AGENT_VM_TEST_OPENAI_API_KEY`
   + the `codex` binary; the only auth CLI flow is `codex-harness`. Mount
   policy already anticipates `/home/agent/.claude` but nothing populates it.
4. **Defaults/config**: `defaults.provider` schema-defaults to `'codex'`;
   `ReasoningEffort` includes OpenAI-only `xhigh`; `MODEL_ALIASES.claude`
   exists but is dead config.

## Current Evidence

- `packages/agent-vm-worker/src/work-executor/executor-factory.ts:20-21` —
  `case 'claude': throw new Error('Claude executor is not implemented yet.')`.
- `packages/agent-vm-worker/src/work-executor/codex-executor.ts:68-119` —
  `ensureCapabilitiesConfigured`: temp HOME, `.codex` dir, `execa('codex',
  ['mcp','add',...])` loop, local tool MCP server registration, `new
  Codex({ apiKey: process.env.OPENAI_API_KEY ... })`.
- `packages/agent-vm-worker/src/work-executor/executor-interface.ts` —
  `execute/fix/resumeOrRebuild/getThreadId`; `StructuredInput`,
  `ExecutorResult`, `ExecutorCapabilities` are provider-neutral.
- `packages/agent-vm-worker/src/coordinator/coordinator-helpers.ts:10-18` —
  scrub patterns lack `ANTHROPIC_API_KEY` / generic `*_API_KEY=`.
- `packages/agent-vm-worker/src/worker-e2e-gates.ts:9-15` — gate hardcodes
  `AGENT_VM_TEST_OPENAI_API_KEY` + `codex` binary.
- `packages/agent-vm-worker/src/config/worker-config.ts:128-133,173,182-195`
  — provider default, `ReasoningEffort` (`xhigh`), `MODEL_ALIASES` with an
  unused `claude` table.
- `packages/agent-vm/src/cli/codex-harness-auth-command.ts` — only harness
  auth flow; `packages/gondolin-adapter/src/mount-policy.ts:6-11` already
  lists `.claude` and `.codex` auth guest paths.
- Phase neutrality verified: `plan-cycle.ts`, `work-cycle.ts`,
  `wrapup-runner.ts` import only `PersistentThread`.

## Non-Goals

- Shipping a *complete* Claude Code executor with full E2E parity in this
  plan — the plan lands the seams plus a functional first executor behind
  them; image/tooling baking for Claude (managed Dockerfile package list)
  is called out as an explicit follow-up if it exceeds the slice.
- No backward-compat shims: per repo policy, interface renames are hard
  cutovers across all callers in one pass.
- No changes to phase logic, prompts, or validation-runner.

## Scope

Write surfaces (sequenced; each step leaves the repo green):
- `packages/agent-vm-worker/src/work-executor/executor-interface.ts`:
  document provider-neutral semantics — `execute` = fresh conversation,
  `fix` = continue current conversation, `resumeOrRebuild(sessionRef)` =
  best-effort resume of a provider session else rebuild from context,
  `getThreadId` → keep name or rename to `getSessionRef` (hard cutover
  through task events if renamed; weigh churn vs. clarity and decide at
  execution with the reviewer).
- New `capability-setup` seam: extract `ensureCapabilitiesConfigured` into a
  provider-owned setup module (`codex-capability-setup.ts`), typed as
  `(capabilities, workingDirectory) → ProviderRuntimeHandle`.
- New `claude-code-executor.ts` implementing `WorkExecutor` over the Claude
  Code CLI/SDK: MCP via generated `--mcp-config` JSON; auth via
  `ANTHROPIC_API_KEY`; `fix` continues the session (`--resume`/`--continue`
  semantics), `resumeOrRebuild` rebuilds from context when resume is
  unavailable. Research the current Claude Agent SDK / CLI flags at
  execution time (deepwiki/docs) before writing this file.
- `executor-factory.ts`: real `'claude'` case.
- `coordinator-helpers.ts`: add `ANTHROPIC_API_KEY` + generic
  `[A-Z_]*_API_KEY=` scrub patterns (independent, do first).
- `worker-e2e-gates.ts`: provider-parameterized gates
  (`AGENT_VM_TEST_ANTHROPIC_API_KEY` + `claude` binary for the claude lane).
- `worker-config.ts`: keep `'codex'` default; make `reasoningEffort`
  provider-interpreted (claude executor maps/ignores `xhigh`).
- `packages/agent-vm/src/cli/` follow-up note: a `claude-harness` auth flow
  mirroring `codex-harness` is required for ChatGPT-style device auth
  parity; if it exceeds the slice, land API-key auth first and file the
  harness flow as the explicit next plan.

Read-only context:
- `packages/agent-vm/src/build/managed-image-dockerfile.ts` — where the
  codex CLI package is baked into managed images; a claude executor needs
  the equivalent package available in the worker image (assess, don't edit,
  unless trivially additive).
- `packages/agent-vm-worker/src/work-executor/local-tool-mcp-server.ts` —
  already provider-neutral; both setups register it.

## Task Sequence

1. Land the independent hygiene fixes: scrub patterns, provider-parameterized
   E2E gates (unit-tested, no behavior change for codex).
2. Extract `codex-capability-setup.ts`; `codex-executor.ts` consumes it;
   all existing unit tests stay green (pure refactor).
3. Write the interface-semantics doc comments (+ optional rename decision).
4. Research current Claude Code CLI/SDK invocation surface (MCP config
   flag, resume semantics, auth env) with citations in the PR description;
   then implement `claude-code-executor.ts` + factory case with unit tests
   (execa mocked) mirroring `codex-executor.unit.test.ts` coverage.
5. Wire a gated claude worker E2E lane analogous to the codex one; run it if
   credentials + binary exist, else report the explicit gate reason.
6. Assess managed-image availability of the claude CLI; if missing, document
   the image-bake follow-up in the plan-completion report (do not silently
   expand into the build pipeline).

## Proof Gates

- Red/green proof: factory `'claude'` case has unit coverage replacing the
  current throw; capability-setup extraction proven by unchanged
  codex-executor unit suite.
- Focused validation:
  `pnpm vitest run --root . --config vitest.config.ts --project unit packages/agent-vm-worker/src`
- Full validation: `pnpm check && pnpm test:unit && pnpm test:integration`
- E2E: codex worker lane must stay green (gated); claude lane runs or
  reports its gate.

## Stop Conditions

- Stop after step 3 and reconverge if the Claude CLI/SDK research shows the
  session-resume model cannot satisfy `fix()` semantics (phases assume
  same-conversation continuation for review feedback — that would be a
  design conversation, not an implementation detail).
- Stop if the rename (`getThreadId` → `getSessionRef`) forces task-event
  schema changes that external consumers read; surface before cutting over.

## Risks

- Claude Code CLI flags drift across versions; pin the researched version in
  the executor and assert it in the E2E gate.
- `danger-full-access`-equivalent permissions for Claude Code inside the VM
  (skip-permissions mode) must be explicit and sandbox-justified in code
  comments — the VM is the sandbox, same rationale as the codex executor.

## Handoff Prompt

```text
Use implementation-execute-plan on this plan.

Repo: /Users/shravansunder/Documents/dev/project-dev/agent-vm.improve-v1
Plan: docs/superpowers/plans/2026-06-10-repo-improvements/08-worker-executor-genericization.md
Start by validating the plan against current git state before editing files.
Steps 1-3 are safe refactors; step 4 requires fresh research on the Claude
Code CLI/SDK surface before writing code. Use bounded subagents only for
independent slices. Parent owns integration and final proof.
```
