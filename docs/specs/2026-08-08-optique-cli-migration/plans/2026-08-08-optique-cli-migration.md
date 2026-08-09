# Optique CLI Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Optique and `@optique/zod` the only parsing foundation for every active repository-owned CLI while preserving each binary's command contract.

**Architecture:** Pure Optique parser trees return discriminated command values. Non-terminating in-process runners use core-facade `runParser()` callbacks, exhaustive async dispatchers invoke operation logic, and process entrypoints alone set final status. Exact-domain Zod schemas own value validation; no `cmd-ts` compatibility or Zod translation shim remains.

**Tech Stack:** TypeScript, Node 24, Optique 1.2.x, `@optique/zod`, Zod 4, Vitest, pnpm, OXC.

## Global Constraints

- Hard cutover: no active `cmd-ts` manifest, lockfile, source, test-name, or current-doc residue.
- Use mutually compatible current `@optique/core`, `@optique/run`, and `@optique/zod` releases with Zod 4 support; use `runParser()` for the non-terminating runner.
- Every Zod-expressible CLI value uses `@optique/zod` with an output-type-safe placeholder.
- Reuse exact-domain schemas; preserve `init --type` as a CLI-owned `openclaw | worker` subset that rejects `hermes`.
- Preserve all 34 leaf command paths, option names/aliases, positional arguments, defaults, typed values, effects, output streams, and operation failures.
- Parsing is pure; dispatch invokes at most one operation; process entrypoints alone own `process.exitCode`.
- Do not introduce a compatibility facade, dual parser, async parse validation, new runtime state, or unrelated operation refactors.
- Use direct `node:fs/promises` imports for new filesystem code and the repository's test suffix taxonomy.
- Exclude the deprecated `packages/openclaw-mcp-portal-plugin` package.
- Packages without CLI parsing do not gain ceremonial Optique dependencies.

---

### Task 1: Optique runner contract and dependency foundation

**Files:**
- Modify: `packages/agent-vm/package.json`
- Modify: `packages/agent-vm-worker/package.json`
- Modify: `pnpm-lock.yaml`
- Create or modify: focused runner/parser support under each package's existing CLI source boundary
- Test: focused `*.unit.test.ts` beside the new support

**Interfaces:**
- Produces a non-terminating Optique parse result that distinguishes parsed value, shown help/version, and reported parse failure.
- Produces named Zod value-parser helpers only for genuinely repeated metadata; it does not recreate `cmd-ts` APIs.

- [ ] Write focused tests proving help and parse errors use injected streams and never terminate the host process; prove representative Zod coercion/enum rejection and safe placeholders.
- [ ] Run the focused tests and record expected failures caused by absent Optique support.
- [ ] Add compatible Optique dependencies and implement the smallest `runParser()`-based support boundary.
- [ ] Run focused tests, typecheck both packages, and refactor only after green.

### Task 2: Convert the `agent-vm` command tree and dispatcher

**Files:**
- Modify: `packages/agent-vm/src/cli/agent-vm-entrypoint.ts`
- Modify: `packages/agent-vm/src/cli/commands/*.ts`
- Modify or create: operation-owner files only where current effects are inline in parser definitions
- Test: `packages/agent-vm/src/cli/agent-vm-entrypoint.unit.test.ts`
- Test: focused parser/dispatcher unit tests beside converted definitions

**Interfaces:**
- Consumes Task 1's runner result and Zod parser boundary.
- Produces one discriminated union covering all 32 `agent-vm` leaves and one exhaustive async dispatcher.

- [ ] Add failing command-contract tests covering the complete leaf inventory, representative aliases/defaults/optional values, help/version, invalid values, and `init --type hermes` rejection.
- [ ] Run the targeted tests and record failures caused by the `cmd-ts` tree.
- [ ] Convert definitions leaf by leaf to Optique, replacing `Type.from`, `oneOf`, `parseGatewayType`, and equivalent Zod bridges with exact-domain Zod parsers.
- [ ] Extract inline handler bodies only as needed to keep parser construction pure and dispatch/effect ownership separate; preserve dependency injection, `CliIo`, environment reads, effects, and errors.
- [ ] Implement exhaustive dispatch and entrypoint outcome mapping.
- [ ] Run all `agent-vm` CLI unit/integration tests and package typecheck; refactor after green.

### Task 3: Convert the `agent-vm-worker` command tree and dispatcher

**Files:**
- Modify: `packages/agent-vm-worker/src/main.ts`
- Create: focused worker CLI operation/parser modules if needed to keep `main.ts` comprehensible
- Test: `packages/agent-vm-worker/src/main.unit.test.ts`

**Interfaces:**
- Consumes Task 1's runner pattern without introducing a cross-package framework.
- Produces discriminated `serve` and `health` variants plus exhaustive async dispatch.

- [ ] Add failing tests for pure parsing, `serve`/`health` help, port default/coercion/rejection, dispatch once, injected streams, and non-terminating failures.
- [ ] Run the worker CLI tests and record expected failures.
- [ ] Convert both leaves to Optique/Zod and separate parser, dispatch, and existing operation effects.
- [ ] Run worker unit/integration tests and package typecheck; refactor after green.

### Task 4: Convert the remaining active package-owned CLIs

**Files:**
- Modify: `packages/agent-portal-sdk/src/cli/tool-portal.ts`
- Modify: `packages/mcp-portal/src/bin/mcp-portal.ts`
- Modify: `packages/mcp-portal/src/cli/serve-command.ts`
- Modify: `packages/gateway-runtime/src/bin/gateway-runtime.ts`
- Modify: the three owning package manifests
- Test: focused package-local `*.unit.test.ts` files

**Interfaces:**
- Produces package-local readonly discriminated command values and exhaustive dispatchers.
- Preserves canonical stdout and process protocol output byte-for-byte where it is a public contract.

- [ ] In `agent-portal-sdk`, observe failing tests before replacing the Tool Portal custom option map; preserve operations, transports, canonical JSON stdout, and transport-specific constraints.
- [ ] In `mcp-portal`, observe failing tests before replacing top-level manual parsing and `node:util.parseArgs`; preserve every nested command, credential warning, JSON result, server behavior, and status.
- [ ] In `gateway-runtime`, observe failing tests before replacing manual `--config` parsing; preserve the exact absolute-path and NUL rejection contract plus readiness/retirement stdout protocol.
- [ ] Give each parser-owning package only the Optique dependencies it directly imports, then run its complete unit, type, lint, and format gates.

### Task 5: Prove the hard cutover and built binaries

**Files:**
- Modify: active tests whose names/assertions describe `cmd-ts`
- Create or modify: permanent host-E2E CLI test under the repository's host-E2E taxonomy
- Modify: current documentation only where it describes the active CLI implementation

**Interfaces:**
- Consumes both built binaries and the final dependency graph.
- Produces automated host-E2E evidence for argv, stdout, stderr, status, and a safe representative effect.

- [ ] Add failing built-binary host-E2E coverage for both top-level help paths, nested help, `agent-vm` version, invalid input, and safe valid invocations.
- [ ] Run the host-E2E test and record expected pre-cutover failures or stale expectations.
- [ ] Remove remaining active `cmd-ts` references and update assertions to semantic Optique behavior.
- [ ] Run targeted units, integrations, host E2E, build, and package inspection.
- [ ] Run `pnpm check`, `pnpm test:unit`, and `pnpm test:integration`.
- [ ] Manually invoke both built binaries outside Vitest and record representative argv, stdout/stderr, status, and safe effect.
- [ ] Search manifests, lockfile, active source/tests/docs, and packed dependency metadata for forbidden `cmd-ts` residue.

## Self-review

Every S1-S6 obligation maps to Tasks 1-5. The plan keeps parser infrastructure,
the independently shipped command trees, and black-box/residue proof as
separate reviewable units. No task authorizes compatibility shims, command UX
redesign, runtime changes, or VM/gateway E2E.
