# Portable Capability Interfaces Implementation Plan

Status: reviewed implementation plan ready for execution.

Source spec:
`docs/superpowers/specs/2026-06-20-portable-capability-interfaces-design.md`

## Goal

Implement the first shippable slice of the portable capability interface design:

- portal-neutral Zod v4 contracts;
- controller-owned execution RPC contracts;
- Tool Portal config contracts;
- MCP Portal backend composition seam;
- MCP-backed Tool Portal in-process core;
- architecture and naming audit in the fast check gate;
- performant TDD proof across unit, integration, and only the e2e surfaces this
  slice actually touches.

This first slice is intentionally MCP-backed and contract-first. It creates the
platform for CLI/SDK, OpenClaw Tool Portal, host actions, and credentialed
runner work without mixing those runtime concerns into the initial PR.

## Source Coverage

Parent source coverage:

- spec line count: 2625 lines;
- chunks read: 1-525, 526-1050, 1051-1575, 1576-2100, 2101-2625;
- current package and test layout inspected:
  `packages/mcp-portal`, `packages/openclaw-mcp-portal-plugin`,
  `packages/openclaw-agent-vm-plugin`, `packages/agent-vm`,
  `packages/config-contracts`, root `package.json`, `vitest.config.ts`,
  `tsconfig.base.json`, `scripts/run-check-gate.ts`,
  `scripts/audit-test-taxonomy.ts`.

Plan-creation lane inputs:

- boundary lane: contract-first package order, keep controller contracts narrow;
- validation lane: proof rows R1-R13 and e2e discipline;
- execution-order lane: serial spine with parallel contract/config lanes;
- security lane: no-leak, auth, progress/diagnostic, lease, and artifact risks.

## First Slice

In scope for the first PR:

- `@agent-vm/agent-portal-sdk`;
- `@agent-vm/controller-execution-contracts`;
- `@agent-vm/tool-portal` with MCP provider backend only;
- `@agent-vm/mcp-portal/mcp-provider-backend`;
- Tool Portal config and effective MCP projection schema contracts in
  `config-contracts`;
- root test/build/path alias/package wiring;
- architecture audit wired into `pnpm check`;
- durable docs updates that describe the MCP Portal / Tool Portal boundary.

Out of scope for the first PR:

- Python SDK;
- HTTP API adapter;
- stdio or Streamable HTTP Tool Portal MCP server;
- write-capable local/code-mode wrappers;
- OpenClaw Tool Portal plugin registration or runtime switchover;
- controller-owned host actions beyond shared contracts;
- ephemeral credentialed runner runtime;
- live deployment loading or `agent-vm validate` support for
  `tool-portal.config.jsonc`;
- broad VM filesystem artifact publication.

Do not claim semantic read-only for arbitrary upstream MCP tools in this slice.
Approval-free means configured policy allowed it. It is not proof that the
upstream provider operation has no external effect.

## Execution DAG

```text
gate 0: validate source and repo state
  |
  +-- lane A: architecture audit scaffold
  |     scripts/package.json/check gate/check-gate unit tests
  |     proof: fast unit-style audit
  |
  +-- lane B0: serial package bootstrap
  |     package manifests, tsdown configs, root aliases, version sync
  |     proof: version sync + focused package build discovery
  |
  +-- lane B: agent-portal-sdk contracts
  |     packages/agent-portal-sdk/**
  |     proof: focused unit tests, JSON Schema exporter tests
  |
  +-- lane C: controller-execution-contracts
  |     packages/controller-execution-contracts/**
  |     proof: focused unit tests for forbidden fields and strict exec/fs
  |
  +-- lane D: config contracts
  |     packages/config-contracts/src/tool-portal-config.ts
  |     packages/config-contracts/src/schema-artifacts.ts
  |     proof: focused unit tests for single authority, no hidden inheritance,
  |            generated schema artifacts, and effective MCP projection
  |
  +-- lane H: shared fake harnesses
  |     tests/harness/agent-portal/**
  |     proof: architecture/taxonomy audit covers harness safety
  |
  integration gate 1: workspace package wiring, typecheck, focused units
  |
  +-- lane E: MCP Portal backend seam
  |     packages/mcp-portal/src/mcp-provider-backend/**
  |     proof: unit and integration tests with fake upstream MCP server
  |
  +-- lane F: Tool Portal MCP-only core
  |     packages/tool-portal/**
  |     proof: unit tests plus fake-backend and MCP-equivalence integration
  |
  integration gate 2: Tool Portal -> MCP Portal projection and result contracts
  |
  final validation: targeted proof, pnpm test:unit, pnpm test:integration,
                    pnpm build, pnpm check
  |
  implementation-review-swarm
  |
  PR readiness proof
```

The first implementation is mostly serial after contract packages land. Contract
model files can be built independently, but package manifests, tsdown entries,
root aliases, lockfile updates, package version sync, and final gates need one
integrator.

## Task Sequence

### Task 0: Repo Baseline And Source Lock

Write scope:

- no product code changes;
- plan/spec state only if needed.

Steps:

1. Confirm the spec and plan are present and line-counted.
2. Confirm branch/worktree status.
3. Record that broad runner/code-mode/OpenClaw switchover is out of first slice.

Proof:

- `wc -l docs/superpowers/specs/2026-06-20-portable-capability-interfaces-design.md`
- `git status --short`

### Task 1: Fast Architecture Audit

Write scope:

- `scripts/audit-portal-architecture.ts`
- `scripts/audit-portal-architecture.unit.test.ts`
- `scripts/run-check-gate.ts`
- `scripts/run-check-gate.unit.test.ts`
- root `package.json`

TDD:

1. Add failing unit tests for forbidden portal buckets, single-word portal files,
   forbidden dependency directions, package API export expectations, and check
   gate insertion.
2. Implement the audit.
3. Wire `pnpm test:portal-architecture` into `pnpm check`.

Audit rules for this slice:

- reject new `packages/*/src/schemas`, `validation`, `mapping`, `test-support`;
- reject new package-wide `src/models`;
- reject new single-word portal files except `index.ts`;
- reject imports from MCP Portal, Tool Portal, controller execution contracts,
  Agent VM runtime, OpenClaw adapters, or runner code inside
  `packages/agent-portal-sdk`;
- reject imports from MCP Portal, Tool Portal, Agent VM runtime, OpenClaw
  adapters, or runner code inside `packages/controller-execution-contracts`;
- allow Tool Portal to import only the public
  `@agent-vm/mcp-portal/mcp-provider-backend` subpath from MCP Portal;
- reject Tool Portal imports from MCP Portal core, current `mcp_portal_*`
  handlers, OpenClaw MCP Portal plugin glue, or MCP Portal internal source paths;
- reject controller execution contract imports from MCP Portal;
- reject Tool Portal core imports from OpenClaw SDK glue;
- reject root `tests/harness/agent-portal` helpers that import real
  process/network boundary APIs or wall-clock wait helpers.

Proof:

- focused: `pnpm vitest run --config vitest.config.ts --project unit scripts/audit-portal-architecture.unit.test.ts scripts/run-check-gate.unit.test.ts`
- gate: `pnpm run test:portal-architecture`
- final: `pnpm check`

### Task 1.5: Serial Package Bootstrap

Write scope:

- new package `package.json` files;
- new package `tsdown.config.ts` files;
- new package `tsconfig.json` and `tsconfig.build.json` files;
- root `tsconfig.base.json`;
- root `vitest.config.ts`;
- root `package.json`;
- `pnpm-lock.yaml` if package metadata changes require it.

Steps:

1. Create new publishable package skeletons at the current publishable
   `@agent-vm/*` package version, currently `0.0.102`.
2. Add root aliases and Vitest aliases once, in this serial bootstrap task.
3. Add package dependencies and public export maps before implementation tests
   import the packages.
4. Add tsdown entries for every public subpath created in this PR.

Proof:

- `pnpm run check:package-versions`
- `pnpm vitest run --config vitest.config.ts --project unit --passWithNoTests packages/agent-portal-sdk packages/controller-execution-contracts packages/tool-portal`

### Task 2: Agent Portal SDK Contracts

Write scope:

- `packages/agent-portal-sdk/package.json`
- `packages/agent-portal-sdk/tsconfig.json`
- `packages/agent-portal-sdk/tsconfig.build.json`
- `packages/agent-portal-sdk/tsdown.config.ts`
- `packages/agent-portal-sdk/src/**`

TDD:

1. Create unit tests first for request/result parsing and rejection behavior.
2. Implement Zod v4 models and exports.
3. Add JSON Schema exporter tests using `z.toJSONSchema()`.

Required contract surfaces:

- common primitives:
  `json-value-schema.ts`, `request-id-schema.ts`,
  `capability-reference-schema.ts`;
- batch operation requests:
  list/search/describe/call request and item schemas;
- model-visible results:
  list/search/describe/call result and item result schemas;
- descriptors:
  capability summary, descriptor, result expectation, safe calling hint;
- errors and diagnostics:
  portal error, safe diagnostic, truncation metadata;
- adapter boundary:
  trusted scope and adapter envelope;
- approval:
  approval-required result and approval decision reference;
- artifacts:
  reference, record, read request, read result, redactor;
- events:
  progress, partial output, diagnostic, cancellation request/result.

Proof requirements:

- schemas reject extra hidden backend/control fields through `.strict()`;
- call arguments are JSON objects, matching current MCP Portal capability calls;
- all four operations preserve batch item ids;
- result schemas include diagnostics, truncation where relevant, artifacts where
  relevant, and audit correlation;
- duplicate and reserved item ids are rejected across list/search/describe/call;
- approval tokens, execution fingerprints, backend names, and dispatch/control
  fields are rejected from model-facing requests, results, and events;
- generated JSON Schema comes from Zod.

Focused proof:

- `pnpm vitest run --config vitest.config.ts --project unit packages/agent-portal-sdk`
- `pnpm --filter @agent-vm/agent-portal-sdk build`
- `pnpm --filter @agent-vm/agent-portal-sdk typecheck`

### Task 3: Controller Execution Contracts

Write scope:

- `packages/controller-execution-contracts/package.json`
- `packages/controller-execution-contracts/tsconfig.json`
- `packages/controller-execution-contracts/tsconfig.build.json`
- `packages/controller-execution-contracts/tsdown.config.ts`
- `packages/controller-execution-contracts/src/**`

TDD:

1. Add failing tests for forbidden dispatch fields and strict ManagedVm exec/fs
   shape.
2. Implement the schemas.
3. Export controller-dispatch, credentialed-runner, and host-action boundaries.

Required behavior:

- dispatch intent carries trusted scope once; no duplicate top-level profile id;
- dispatch intent rejects executable, argv, cwd, env, credential material,
  host paths, VM profile overrides, egress overrides, shell strings, PTY;
- execution fingerprint binds identity, capability, canonical args, policy,
  catalog, backend, template, custody, egress, artifact intent, and output
  policy;
- ManagedVm exec request requires absolute executable, array argv, explicit cwd,
  explicit env, `pty: false`, `shellMode: "none"`, bounded timeout, stream mode;
- host action request is typed and cannot become a generic subprocess request;
- these are contract-only exports in the first slice; no controller route,
  ManagedVm runtime, host action registry, or credentialed runner execution is
  added in this PR.

Proof:

- `pnpm vitest run --config vitest.config.ts --project unit packages/controller-execution-contracts`
- `pnpm --filter @agent-vm/controller-execution-contracts build`
- `pnpm --filter @agent-vm/controller-execution-contracts typecheck`

### Task 4: Tool Portal Config Contracts

Write scope:

- `packages/config-contracts/src/tool-portal-config.ts`
- `packages/config-contracts/src/tool-portal-config.unit.test.ts`
- `packages/config-contracts/src/schema-artifacts.ts`
- `packages/config-contracts/src/schema-artifacts.unit.test.ts`
- `packages/config-contracts/src/index.ts`

TDD:

1. Add failing tests for dual policy authority, hidden profile inheritance,
   invalid backend bindings, missing profile definitions, generated JSON Schema
   artifacts, and effective MCP projection mismatch.
2. Implement config schemas and helpers.
3. Export the config contract from `config-contracts`.

First-slice config scope:

- agents/profiles;
- complete profile policies;
- MCP-backed capability references;
- `ToolPortalMcpProjectionSchema` and helper output consumed by MCP provider
  backend;
- output/artifact policy references;
- no credentialed runner runtime config yet;
- no live deployment loader or `agent-vm validate` integration for
  `tool-portal.config.jsonc` yet.

Required behavior:

- generated Tool Portal config JSON Schema artifacts come from Zod;
- effective MCP projection contains only Tool Portal-authorized MCP-backed
  capabilities;
- Tool Portal mode rejects dual user-authored policy authority for the same
  agent/profile/model-visible capability;
- MCP Portal backend parses the neutral projection schema from
  `config-contracts`, not a Tool Portal-owned ad hoc object.

Proof:

- `pnpm vitest run --config vitest.config.ts --project unit packages/config-contracts/src/tool-portal-config.unit.test.ts`
- `pnpm vitest run --config vitest.config.ts --project unit packages/config-contracts/src/schema-artifacts.unit.test.ts`
- `pnpm --filter @agent-vm/config-contracts typecheck`

### Task 4.5: Shared Fake Harnesses For Integration

Write scope:

- `tests/harness/agent-portal/**`
- package-local tests that consume the harness

Required harnesses:

- fake Tool Portal controller;
- fake MCP provider backend;
- fake ManagedVm runner only as a contract fake, not a live VM;
- shared portal contract assertions.

Rules:

- no real network provider;
- no real VM boot;
- no shell commands;
- no wall-clock sleeps;
- no test-only weakening of contracts.

Proof:

- harness consumed by Tasks 5 and 6 before those implementations pass;
- architecture or taxonomy audit covers `tests/harness/agent-portal/**/*.ts`;
- `pnpm test:taxonomy` still passes.

### Task 5: MCP Portal Backend Seam

Write scope:

- `packages/mcp-portal/src/mcp-provider-backend/**`
- `packages/mcp-portal/src/index.ts`
- `packages/mcp-portal/package.json`
- `packages/mcp-portal/tsdown.config.ts`
- `packages/mcp-portal/tsconfig.build.json`

TDD:

1. Add failing tests that Tool Portal-style batch list/search/describe/call
   requests can be handled through an MCP provider backend without exposing
   `mcp_portal_*` tool names to Tool Portal.
2. Implement `createMcpProviderCapabilityBackend`.
3. Add the public `./mcp-provider-backend` export.

Required behavior:

- accept agent-portal-sdk batch contracts;
- consume a Tool Portal effective MCP projection;
- call existing MCP Portal runtime/core internally;
- normalize results into agent-portal-sdk result contracts;
- preserve existing `@agent-vm/mcp-portal/core` behavior and exports;
- do not make MCP Portal depend on Tool Portal or runner code;
- parse the neutral effective MCP projection schema from `config-contracts`;
- never accept model-supplied approval tokens at the Tool Portal backend seam;
- use trusted runtime/controller approval context only;
- propagate cancellation to MCP core and suppress late events after cancellation;
- normalize upstream progress, partial output, notifications, diagnostics, and
  errors through safe event/result schemas;
- redact or drop current MCP leak-shaped fields, including `upstream`,
  `transport`, provider URLs, stdio command/cwd, env names, executable-looking
  strings, and host/path-looking strings.

Proof:

- `pnpm vitest run --config vitest.config.ts --project unit packages/mcp-portal/src/mcp-provider-backend`
- `pnpm vitest run --config vitest.config.ts --project integration packages/mcp-portal/src`
- `pnpm --filter @agent-vm/mcp-portal build`
- `pnpm --filter @agent-vm/mcp-portal typecheck`

### Task 6: Tool Portal MCP-Only Core

Write scope:

- `packages/tool-portal/package.json`
- `packages/tool-portal/tsconfig.json`
- `packages/tool-portal/tsconfig.build.json`
- `packages/tool-portal/tsdown.config.ts`
- `packages/tool-portal/src/**`

TDD:

1. Add failing unit tests for catalog scoping, policy evaluation, approval
   result behavior, result normalization, and safe diagnostics.
2. Add failing unit tests for CLI allowance schemas, argv normalization, deny
   rules, shell-like token rejection, cwd/env/egress/output/artifact/cancel
   policy, and no runtime execution.
3. Add failing integration tests with the shared fake MCP backend.
4. Implement MCP-backed list/search/describe/call.

First-slice capability behavior:

- uses the same four batch operations;
- supports MCP-backed capabilities only;
- builds catalog-static dispatch from trusted config;
- projects effective MCP policy into MCP backend;
- returns agent-portal-sdk result contracts;
- returns structured approval-required item errors where policy requires
  approval;
- normalizes progress/diagnostic text through safe diagnostics;
- does not expose backend names, provider credentials, or direct MCP Portal
  `mcp_portal_*` names as Tool Portal capabilities;
- includes CLI allowance contracts and validators as contract-only code; no CLI
  wrapper, subprocess execution, credentialed runner runtime, or host action
  dispatcher is exposed in this slice;
- does not emit artifact references in the MCP-only runtime unless a scoped
  artifact readback authorizer and tests are added in this same PR;
- preserves duplicate/reserved id errors through Tool Portal integration;
- proves black-box equivalence against current MCP Portal core for list/search/
  describe/call success, denied tool, duplicate id, approval-required, mixed
  batch, diagnostics, redaction, and cancellation scenarios.

Proof:

- `pnpm vitest run --config vitest.config.ts --project unit packages/tool-portal`
- `pnpm vitest run --config vitest.config.ts --project integration packages/tool-portal`
- `pnpm --filter @agent-vm/tool-portal build`
- `pnpm --filter @agent-vm/tool-portal typecheck`

### Task 7: Root Package Wiring And Full Local Gates

Write scope:

- root `package.json`;
- root `tsconfig.base.json`;
- root `vitest.config.ts`;
- `pnpm-lock.yaml` if package metadata changes require it.

Steps:

1. Add package aliases for new packages and public subpaths.
2. Ensure package version sync includes new packages at the current
   publishable `@agent-vm/*` package version, currently `0.0.102`.
3. Run focused tests first, then broad gates.

Created first-slice public exports:

```text
@agent-vm/agent-portal-sdk
  .
  ./portal-call-surface
  ./capability-description-surface
  ./adapter-boundary
  ./approval-surface
  ./artifact-surface
  ./portal-event-surface
  ./testing

@agent-vm/controller-execution-contracts
  .
  ./controller-dispatch-boundary
  ./credentialed-runner-boundary
  ./controller-host-action-boundary
  ./testing

@agent-vm/mcp-portal
  existing exports
  ./mcp-provider-backend

@agent-vm/tool-portal
  .
  ./in-process-entrypoint
  ./testing
```

Deferred Tool Portal public exports:

```text
@agent-vm/tool-portal/cli
@agent-vm/tool-portal/mcp-proxy
@agent-vm/tool-portal/http-api
@agent-vm/openclaw-tool-portal-plugin
```

Architecture/export tests must assert created exports are importable after
`pnpm build` and deferred adapter exports are absent.

### Task 8: Durable Architecture Docs

Write scope:

- `docs/subsystems/mcp-portal.md`
- `docs/README.md` or `docs/reference/configuration/README.md` only if needed
  for discoverability.

Required docs:

- distinguish MCP Portal from Tool Portal;
- distinguish upstream MCP JSON Schema validation from portal-neutral Zod v4
  contracts;
- state that first-slice Tool Portal config contracts are package contracts, not
  a live deployment-loaded `agent-vm validate` surface yet;
- state that CLI, MCP proxy, HTTP API, OpenClaw Tool Portal adapter,
  credentialed runner runtime, host actions, and broad VM artifacts are deferred.

Proof:

- `pnpm fmt:check`
- `git diff --check`

Final proof gates for the first PR:

- `pnpm vitest run --config vitest.config.ts --project unit packages/agent-portal-sdk packages/controller-execution-contracts packages/config-contracts/src/tool-portal-config.unit.test.ts packages/mcp-portal/src/mcp-provider-backend packages/tool-portal scripts/audit-portal-architecture.unit.test.ts`
- `pnpm vitest run --config vitest.config.ts --project unit scripts/run-check-gate.unit.test.ts packages/config-contracts/src/schema-artifacts.unit.test.ts`
- `pnpm vitest run --config vitest.config.ts --project integration packages/mcp-portal/src packages/tool-portal`
- `pnpm test:taxonomy`
- `pnpm test:portal-architecture`
- `pnpm test:unit`
- `pnpm test:integration`
- `pnpm build`
- `pnpm check`

No e2e is required for the first slice unless the implementation touches a real
runtime adapter, CLI wrapper, controller HTTP route, OpenClaw registration, or
ManagedVm runtime behavior. `pnpm test:e2e:inventory` may be run as inventory,
but it is not feature proof.

## Requirements And Proof Matrix

| Requirement | Source | Owning task | Proof layer | Red/green required | Stale-proof guard |
| --- | --- | --- | --- | --- | --- |
| Every public contract is Zod v4 and strict | Spec lines 267-297, 2557-2567 | Tasks 2, 3, 6 | Unit | Yes | Run focused unit tests plus `pnpm test:unit` after current code is written |
| Batch list/search/describe/call contracts are preserved | Spec lines 214-265, 2530-2542 | Tasks 2, 5, 6 | Unit/integration | Yes | Tests must use batch item ids and mixed item results |
| JSON Schema is generated from Zod only | Spec lines 1046-1059, 2565-2566 | Tasks 2, 4 | Unit/check | Yes | Exporter/schema-artifact unit tests prove generation; `check:zod` only guards against Zod 3 and `zod-to-json-schema` |
| Model cannot supply hidden backend/control fields | Spec lines 1132-1177, 1497-1533 | Tasks 2, 3, 5, 6 | Unit | Yes | Negative tests for backend kind, identity, approval tokens, execution fingerprints, argv, cwd, env, egress, VM, SSH |
| Controller RPC contracts are not owned by Tool Portal | Spec lines 1669-1770, 2508-2511 | Task 3 | Unit/architecture audit | Yes | Architecture audit fails forbidden dependency direction |
| Tool Portal composes MCP Portal through backend export | Spec lines 1211-1297, 2504-2506 | Tasks 5, 6 | Unit/integration | Yes | Integration uses MCP backend export, not direct `mcp_portal_*` names |
| Effective MCP projection has one neutral contract owner | Spec lines 1211-1297, 2173-2238 | Tasks 4, 5, 6 | Unit/integration | Yes | `ToolPortalMcpProjectionSchema` lives in `config-contracts`, projection contains only Tool Portal-authorized MCP capabilities, and MCP backend parses it before use |
| Tool Portal has one policy authority | Spec lines 1211-1237, 2173-2238 | Tasks 4, 6 | Unit/integration | Yes | Config tests reject dual authority for same agent/profile capability and first slice does not wire live deployment loading |
| Adapter auth classes stay separated | Spec lines 1622-1656 | Tasks 4, 6 | Unit/integration | Yes | No agent-facing wrapper is added in first slice |
| CLI allowance contracts encode execution policy | Spec lines 868-976, 1061-1130 | Task 6 | Unit | Yes | Schemas include cwd/env/egress/output/artifact/cancel policy |
| Diagnostics, errors, and events are safe | Spec lines 1132-1177, 2295-2313, 2392-2409 | Tasks 2, 5, 6 | Unit/integration | Yes | Redaction corpus covers `upstream`, `transport`, provider URLs, stdio command/cwd, env names, progress, partial output, notifications, diagnostics, and raw errors |
| Cancellation propagates through MCP-backed calls | Spec lines 2295-2339 | Tasks 2, 5, 6 | Integration | Yes | Fake backend observes abort, late events are suppressed, and result is structured as cancelled |
| Artifact references are path-free and scoped | Spec lines 489-540, 2295-2352 | Tasks 2, 6 | Unit/integration | Yes | First slice runtime emits no artifact references unless scoped readback authorization and tests are added |
| Public exports are emitted by build entries | Spec lines 1771-1809, 2553-2555 | Tasks 1.5, 5, 7 | Unit/build | Yes | tsdown entries match package exports, built exports import after `pnpm build`, and deferred adapter exports are absent |
| Shared harness helpers stay safe | Spec lines 1908-1912, 2108-2115 | Tasks 1, 4.5 | Unit-style script/check | Yes | Architecture or taxonomy audit covers `tests/harness/agent-portal/**/*.ts` |
| Architecture rules are enforced by fast gate | Spec lines 1901-1916, 2571-2578 | Task 1 | Unit-style script/check | Yes | `pnpm check` includes the audit and `scripts/run-check-gate.unit.test.ts` covers command insertion |
| First slice keeps tests performant | Spec lines 2127-2161, 2579-2590 | All tasks | Unit/integration | Yes | No unit/integration wall-clock sleeps; e2e only if real runtime touched |

## Validation Strategy

Fast loop while developing:

```sh
pnpm vitest run --config vitest.config.ts --project unit <changed-paths>
pnpm vitest run --config vitest.config.ts --project integration <changed-paths>
pnpm run test:portal-architecture
pnpm run test:taxonomy
```

Pre-review local proof:

```sh
pnpm test:unit
pnpm test:integration
pnpm build
pnpm check
```

E2E proof is not part of the first slice unless implementation changes a real
runtime adapter or controller/VM path. If that happens, add the specific e2e
gate before claiming readiness:

```sh
pnpm run test:e2e:host -- <host e2e file>
mise exec -- pnpm run test:e2e:openclaw -- <openclaw e2e file>
mise exec -- pnpm run test:e2e:vm -- <vm e2e file>
```

## Split And Replan Triggers

Replan before continuing if any of these happen:

- package bootstrapping plus real runtime behavior no longer fits in one
  provable PR;
- MCP Portal backend adapter requires changing existing public `./core`
  semantics;
- Tool Portal needs write-capable local agent auth before MCP-only core works;
- approval must bind policy/profile revision before current MCP approval code can
  safely support the slice;
- MCP-only runtime needs to emit artifact references but scoped artifact readback
  authorization is not included in the same PR;
- any required proof row can only be tested through e2e because lower-layer seams
  are missing;
- an implementation needs to reuse `/zones/:zoneId/execute-command` or `/lease`
  as a model-facing primitive.

## Risks And Recovery

Risk: new packages can break package-version sync.

Recovery: create new packages at the current publishable `@agent-vm/*` package
version, currently `0.0.102`, and run `pnpm run check:package-versions` early.

Risk: the architecture audit over-blocks existing legacy files.

Recovery: scope the audit to new portal package paths and newly introduced
files; do not retroactively fail unrelated existing code unless the plan is
expanded.

Risk: MCP backend extraction leaks existing `mcp_portal_*` model tool names into
Tool Portal.

Recovery: keep translation in `packages/mcp-portal/src/mcp-provider-backend` and
make Tool Portal tests assert it imports the backend export, not MCP tool
handler names.

Risk: broad Tool Portal config becomes a second MCP Portal policy source.

Recovery: first-slice config represents an effective projection and rejects dual
authority for the same agent/profile/capability.

Risk: tests become slow or e2e-heavy.

Recovery: split fake-boundary integration from live runtime proof. Add no live
VM/OpenClaw tests until a real VM/OpenClaw surface changes.

## Deferred Work

Defer to later plans:

- OpenClaw Tool Portal plugin registration and native tool switchover;
- code-mode CLI wrappers and local lease/token bootstrap;
- TypeScript SDK client helpers beyond contract exports;
- Python SDK;
- HTTP API and MCP server adapters for Tool Portal;
- narrow controller host actions implementation;
- ephemeral credentialed runner runtime over ManagedVm exec/fs;
- VM filesystem artifact publication with no-follow path proof.

## Recommended Next Workflow

Run `shravan-dev-workflow:implementation-execute-plan` on this reviewed plan.
Implementation should follow the TDD task order above, keep runtime adapters and
credentialed execution out of scope, and stop to replan if any split trigger
fires.
