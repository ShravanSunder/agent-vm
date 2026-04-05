# Agent VM Phases 1-3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `agent-vm` as a `pnpm` monorepo that boots an OpenClaw gateway inside a Gondolin VM, adds the lease/plugin execution path, and finishes the first production MVP slice from the validated specs.

**Architecture:** `gondolin-core` holds reusable VM, policy, secret, build, and mount primitives extracted from the legacy `agent_vm` codebase. `agent-vm` owns controller CLI and runtime orchestration, while `openclaw-gondolin-plugin` adapts the controller lease/runtime contract to the current OpenClaw sandbox backend interface.

**Tech Stack:** TypeScript, pnpm workspaces, Vitest, oxlint, oxfmt, Hono, cmd-ts, execa, Zod, local Gondolin host checkout, OpenClaw plugin SDK.

---

## File Structure

### Root workspace

- `package.json`: pnpm workspace scripts and shared developer tooling
- `pnpm-workspace.yaml`: workspace membership
- `tsconfig.base.json`: shared TypeScript compiler defaults
- `tsconfig.json`: root no-emit typecheck config
- `vitest.config.ts`: shared Vitest configuration with long VM-oriented timeouts
- `docs/superpowers/plans/2026-04-04-agent-vm-phases-1-3.md`: this execution plan

### `packages/gondolin-core`

- `src/policy-compiler.ts`: hostname normalization and allowlist compilation
- `src/mount-policy.ts`: guest/host writable mount validation
- `src/volume-manager.ts`: persistent host volume directory helpers
- `src/secret-resolver.ts`: 1Password resolution layer
- `src/build-pipeline.ts`: image build and cache orchestration
- `src/vm-adapter.ts`: typed Gondolin VM wrapper and VFS mapping
- `src/index.ts`: package exports
- `src/*.test.ts`: unit tests for each module

### `packages/agent-vm`

- `src/bin/agent-vm.ts`: CLI entrypoint
- `src/features/controller/system-config.ts`: `system.json` schema and loader
- `src/features/controller/credential-manager.ts`: secret resolution orchestration
- `src/features/controller/gateway-manager.ts`: gateway VM lifecycle and ingress
- `src/features/controller/doctor.ts`: basic prerequisite checks
- `src/features/controller/status.ts`: status reporting
- `src/index.ts`: package exports
- `src/**/*.test.ts`: focused unit tests

### `packages/openclaw-gondolin-plugin`

- `src/index.ts`: plugin registration
- `src/backend.ts`: OpenClaw sandbox backend factory/manager
- `src/lease-client.ts`: controller HTTP client
- `src/*.test.ts`: plugin/backend contract tests

## Checkpoints

- Checkpoint 1: workspace shape, root tooling, written plan, and passing baseline tests
- Checkpoint 2: `gondolin-core` foundation complete with extracted modules and unit tests
- Checkpoint 3: controller boot path complete for Plan 1
- Checkpoint 4: lease API and plugin integration complete for Plan 2
- Checkpoint 5: production MVP wiring complete for Plan 3

## Phase 1

### Task 1: Stabilize the workspace baseline

**Files:**

- Modify: `package.json`
- Modify: `vitest.config.ts`
- Create: `docs/superpowers/plans/2026-04-04-agent-vm-phases-1-3.md`

- [ ] **Step 1: Keep the root workspace aligned with pnpm-only conventions**

Update the root package so `pnpm-workspace.yaml` is authoritative and the root scripts check both the root and package-level TypeScript surfaces.

- [ ] **Step 2: Verify the current red test state**

Run: `pnpm vitest run packages/gondolin-core/src/policy-compiler.test.ts packages/gondolin-core/src/mount-policy.test.ts packages/gondolin-core/src/volume-manager.test.ts`
Expected: one or more failures from incomplete `gondolin-core` extraction work.

- [ ] **Step 3: Commit the workspace baseline**

Run:

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json tsconfig.json vitest.config.ts vitest.setup.ts docs/superpowers/plans/2026-04-04-agent-vm-phases-1-3.md
git commit -m "chore: align workspace baseline"
```

### Task 2: Finish the current `gondolin-core` red cycle

**Files:**

- Modify: `packages/gondolin-core/src/index.ts`
- Modify: `packages/gondolin-core/src/mount-policy.ts`
- Test: `packages/gondolin-core/src/mount-policy.test.ts`

- [ ] **Step 1: Keep the existing failing mount-policy test as the active red case**

Run: `pnpm vitest run packages/gondolin-core/src/mount-policy.test.ts`
Expected: fail because `validateRuntimeMountPolicy` is missing from the module surface.

- [ ] **Step 2: Implement the missing runtime-level validation**

Add `validateRuntimeMountPolicy` so the module enforces guest-path and host-path checks across the configured writable mounts using the existing helper functions.

- [ ] **Step 3: Verify the focused test passes**

Run: `pnpm vitest run packages/gondolin-core/src/mount-policy.test.ts`
Expected: PASS

- [ ] **Step 4: Re-run the current `gondolin-core` baseline tests**

Run: `pnpm vitest run packages/gondolin-core/src/policy-compiler.test.ts packages/gondolin-core/src/mount-policy.test.ts packages/gondolin-core/src/volume-manager.test.ts`
Expected: PASS

### Task 3: Extract the remaining `gondolin-core` modules

**Files:**

- Create: `packages/gondolin-core/src/secret-resolver.ts`
- Create: `packages/gondolin-core/src/secret-resolver.test.ts`
- Create: `packages/gondolin-core/src/build-pipeline.ts`
- Create: `packages/gondolin-core/src/build-pipeline.test.ts`
- Create: `packages/gondolin-core/src/vm-adapter.ts`
- Create: `packages/gondolin-core/src/vm-adapter.test.ts`
- Modify: `packages/gondolin-core/src/index.ts`
- Modify: `packages/gondolin-core/src/types.ts`

- [ ] **Step 1: Add failing tests for secret resolution, build caching, and VM option translation**
- [ ] **Step 2: Implement minimal code to satisfy those tests**
- [ ] **Step 3: Re-run the full `gondolin-core` test set**
- [ ] **Step 4: Commit Phase 1 core extraction**

Run:

```bash
git add packages/gondolin-core
git commit -m "feat: extract gondolin core primitives"
```

### Task 4: Build the controller skeleton

**Files:**

- Create: `packages/agent-vm/src/bin/agent-vm.ts`
- Create: `packages/agent-vm/src/features/controller/system-config.ts`
- Create: `packages/agent-vm/src/features/controller/system-config.test.ts`
- Create: `packages/agent-vm/src/features/controller/credential-manager.ts`
- Create: `packages/agent-vm/src/features/controller/credential-manager.test.ts`
- Create: `packages/agent-vm/src/features/controller/gateway-manager.ts`
- Create: `packages/agent-vm/src/features/controller/gateway-manager.test.ts`
- Create: `packages/agent-vm/src/features/controller/doctor.ts`
- Create: `packages/agent-vm/src/features/controller/status.ts`
- Modify: `packages/agent-vm/src/index.ts`

- [ ] **Step 1: Write failing tests for `system.json` parsing and basic CLI command routing**
- [ ] **Step 2: Implement the config loader and command skeleton**
- [ ] **Step 3: Write failing tests for gateway image build, secret resolution, VM creation, and ingress setup orchestration**
- [ ] **Step 4: Implement the minimal gateway manager flow to satisfy Plan 1**
- [ ] **Step 5: Commit the Plan 1 controller checkpoint**

Run:

```bash
git add packages/agent-vm
git commit -m "feat: add controller foundation"
```

## Phase 2

### Task 5: Add the controller lease API

**Files:**

- Create: `packages/agent-vm/src/features/controller/controller-service.ts`
- Create: `packages/agent-vm/src/features/controller/controller-service.test.ts`
- Create: `packages/agent-vm/src/features/controller/lease-manager.ts`
- Create: `packages/agent-vm/src/features/controller/lease-manager.test.ts`

- [ ] **Step 1: Write failing tests for lease creation, status, and teardown**
- [ ] **Step 2: Implement the minimal in-memory lease manager and HTTP routes**
- [ ] **Step 3: Re-run the controller tests**

### Task 6: Add the OpenClaw Gondolin plugin surface

**Files:**

- Create: `packages/openclaw-gondolin-plugin/src/backend.ts`
- Create: `packages/openclaw-gondolin-plugin/src/backend.test.ts`
- Create: `packages/openclaw-gondolin-plugin/src/lease-client.ts`
- Create: `packages/openclaw-gondolin-plugin/src/lease-client.test.ts`
- Modify: `packages/openclaw-gondolin-plugin/src/index.ts`

- [ ] **Step 1: Write failing tests that pin the OpenClaw sandbox backend contract**
- [ ] **Step 2: Implement the lease client and backend factory/manager**
- [ ] **Step 3: Verify the plugin tests pass**
- [ ] **Step 4: Commit the Plan 2 checkpoint**

Run:

```bash
git add packages/agent-vm packages/openclaw-gondolin-plugin
git commit -m "feat: add tool vm lease path"
```

## Phase 3

### Task 7: Add production-MVP config and runtime wiring

**Files:**

- Modify: `packages/agent-vm/src/features/controller/system-config.ts`
- Modify: `packages/agent-vm/src/features/controller/gateway-manager.ts`
- Add tests beside each touched file

- [ ] **Step 1: Write failing tests for channel-related allowed hosts, post-build image config, and persistent state/env wiring**
- [ ] **Step 2: Implement the minimal schema and runtime changes**
- [ ] **Step 3: Re-run focused Plan 3 tests**

### Task 8: Final verification checkpoint

**Files:**

- No code changes required unless verification reveals defects

- [ ] **Step 1: Run lint**

Run: `pnpm lint:types`
Expected: exit code 0

- [ ] **Step 2: Run format check**

Run: `pnpm fmt:check`
Expected: exit code 0

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: exit code 0

- [ ] **Step 4: Run tests**

Run: `pnpm test`
Expected: exit code 0 with all tests passing

- [ ] **Step 5: Commit the Plan 3 checkpoint**

Run:

```bash
git add .
git commit -m "feat: complete production mvp wiring"
```

## Self-Review

- Plan 1 coverage: workspace, extracted core primitives, controller CLI/config/gateway boot
- Plan 2 coverage: lease API and sandbox plugin
- Plan 3 coverage: production-facing config/runtime wiring
- No placeholders remain for the immediate next checkpoint; later phase tasks stay explicit at the component level and will be refined further as code lands
