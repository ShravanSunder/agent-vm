# LogTape structured logging implementation plan

Planning result: `draft`

## Authority and snapshot

This plan is produced by `plan-implementation` from the current, separately
identified design set:

- Requirements: `docs/specs/2026-08-08-logtape-structured-logging/requirements.md`
- Specification: `docs/specs/2026-08-08-logtape-structured-logging/specification.md`
- Program Design: `docs/specs/2026-08-08-logtape-structured-logging/program-design.md`
- Three-artifact review: `ready`, receipt/result
  `logtape-final-affected-3ad-ready-2026-08-09T20:47:02Z`, invocation
  `logtape-final-affected-3ad-2026-08-09T20:47:02Z`

Planned source snapshot:

- worktree: `agent-vm.logtape-structured-logging`
- branch: `logtape-structured-logging`
- HEAD: `e0d141648fd0afea15b7302fa4926aaced323b2c`
- current source is clean relative to HEAD; the three design artifacts are
  untracked planning inputs and are preserved.

## Goal, scope, and non-goals

Cut over active general operational diagnostics to `@logtape/logtape` 2.3.0,
with package-local process-root configuration and categorized library loggers:

```text
four process roots -> JSONL stderr + optional @logtape/otel
reusable libraries -> getLogger(category) only
typed telemetry / stdout protocols / raw streams -> existing owners
```

The four configured roots are `agent-vm`, `agent-vm-worker`,
`agent-vm-gateway-runtime`, and standalone `mcp-portal`. The active
`openclaw-agent-vm-plugin` is logger-only: it may use `getLogger()` but never
configures, resets, disposes, or owns a sink. The deprecated
`packages/openclaw-mcp-portal-plugin` is excluded. The `tool-portal` executable
in `packages/agent-portal-sdk` remains protected direct CLI/protocol output and
does not gain LogTape.

Do not add a shared logging package, collector, queue, persistence, retry
coordinator, parser migration, feature flag, typed telemetry replacement, or
new deployment setting. Preserve existing health/lifecycle/metrics/traces and
Tool Portal telemetry, stdout JSON/protocol bytes, CLI UX, prompts/progress,
raw child streams, generated scripts, fixtures, and secret boundaries.

## Current source owners and write surfaces

The implementation must reclassify every direct diagnostic site before editing.
The following are the source-grounded owners; direct writes in build/init,
Tool Portal, protocol, and raw-stream paths remain only when their R6 owner is
explicit:

- Agent VM root/lifecycle: `packages/agent-vm/src/cli/agent-vm-entrypoint.ts`,
  `packages/agent-vm/src/cli/agent-vm-cli-support.ts`, and
  `packages/agent-vm/src/cli/commands/controller-definition.ts`.
- Agent VM diagnostics: `packages/agent-vm/src/controller/controller-runtime.ts`,
  `controller/worker-task-runner.ts`, `controller/git-push-operations.ts`,
  `controller/git-pull-default-operations.ts`,
  `controller/request-heartbeat-registry.ts`, `controller/heartbeat-sender.ts`,
  `controller/health/gateway-service-health-monitor.ts`,
  `controller/http/controller-zone-operation-routes.ts`,
  `controller/leases/{lease-manager,tool-vm-lease-liveness,tool-vm-recovery}.ts`,
  `controller/zone-runtimes/{zone-runtime-registry,worker-zone-runtime,managed-gateway-zone-runtime}.ts`,
  `gateway/gateway-recovery.ts`, `gateway/gateway-zone-orchestrator.ts`,
  `controller/task-state-reader.ts`, and `resources/repo-resource-contract-loader.ts`.
  The orchestrator retains its injected `writeLog` seam and is proved to route
  through the controller-owned logger; it does not configure LogTape itself.
- Worker root/lifecycle: `packages/agent-vm-worker/src/main.ts` and
  `packages/agent-vm-worker/src/worker-cli-operations.ts`. Worker diagnostic
  owners are `coordinator/{coordinator,coordinator-helpers,task-runner}.ts`,
  `server.ts`, `git/git-operations.ts`, `state/{event-log,task-state}.ts`,
  `prompt/prompt-assembler.ts`, `validation-runner/verification-runner.ts`,
  `work-executor/codex-executor.ts`, `work-phase/work-cycle.ts`, and
  `shared/stderr.ts`.
- Gateway root: `packages/gateway-runtime/src/bin/gateway-runtime.ts`.
  Preserve readiness/retirement stdout and the private typed telemetry owned
  by `production/gateway-runtime-tool-portal-telemetry.ts`.
- MCP root and typed seam: `packages/mcp-portal/src/bin/mcp-portal.ts` and
  `packages/mcp-portal/src/cli/serve-command.ts`. Preserve
  `PortalServerLogger`, listening stdout, usage/results/credential warnings,
  CLI errors, and protocol events.
- Active plugin logger-only seam:
  `packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.ts` and
  its registration tests. Do not touch the deprecated plugin or
  `packages/agent-portal-sdk/src/cli/tool-portal.ts`.
- Existing typed telemetry remains owned by
  `packages/agent-vm/src/observability/controller-telemetry.ts`,
  `observability/otel-controller-telemetry-driver.ts`, and
  `packages/gateway-runtime/src/production/gateway-runtime-tool-portal-telemetry.ts`.

## Ordered slices and edges

Edges below are execution edges only. Slices 2a–2d may be advisory-parallel
after slice 1; each package owns its own adapter and tests. The lockfile is
written once in slice 1 so package slices do not collide there.

### Slice 1 — dependency substrate and LogTape API characterization

**Requires:** none. **Serial:** first, because all package manifests and the
lockfile share one dependency update. **Writes:**
`packages/{agent-vm,agent-vm-worker,gateway-runtime,mcp-portal}/package.json`,
`packages/openclaw-agent-vm-plugin/package.json`, and `pnpm-lock.yaml`.

Pin `@logtape/logtape` and `@logtape/otel` to `2.3.0` in the four configured
roots; pin only `@logtape/logtape` in the active plugin. Do not add either
dependency to `openclaw-mcp-portal-plugin` or `agent-portal-sdk`.

Characterize the exact upstream behavior in the first root adapter test before
copying the package-local shape: production `configure({ reset: false })`
does not replace an active configuration and a duplicate configure is a thrown
setup error; `getStreamSink(Writable.toWeb(stderr), ...)` is async-disposable
and disposal closes its writer; `@logtape/otel` with no endpoint is a no-op;
and the public async `dispose()` is called once, after product shutdown. Also
lock the `logtape.meta.otel` stderr-only routing needed to avoid exporter
recursion. A test harness may reset/dispose global state only in an isolated
test process.

**Proof:** `pnpm install --lockfile-only` (or the repository's equivalent
lockfile update), then the focused adapter characterization test in slice 2a;
dependency inspection must show no forbidden package additions. Stop if the
installed 2.3.0 API does not have these semantics; return to Program Design
instead of inventing a compatibility wrapper.

### Slice 2a — Agent VM process adapter and root lifecycle

**Requires:** slice 1. **Advisory-parallel with:** slices 2b–2d. **Writes:** new
`packages/agent-vm/src/observability/process-logging.ts` and
`process-logging.unit.test.ts`; root/lifecycle updates in
`cli/agent-vm-entrypoint.ts`, `cli/commands/controller-definition.ts`, and
`cli/agent-vm-entrypoint.unit.test.ts` / `commands/controller-definition.unit.test.ts`.

Implement the package-local `configureProcessLogging` and idempotent shutdown
handle. It accepts the existing stderr stream and existing observability
authority, appending `/v1/logs` exactly once when the controller collector is
configured. An explicit disabled observability config cannot fall through to
ambient OTEL endpoint discovery; an absent repository config follows the
specified environment/no-endpoint behavior. It uses a
separate LogTape-managed OTLP provider, never the typed controller provider.
Configure before `startControllerRuntime`; retain the handle in a root-only
`runControllerStartLifecycle`; await runtime close and existing typed telemetry
shutdown before one LogTape `dispose()`. A repeated signal shares the close
promise, and logging-disposal failure is secondary to the product result.

Unit proof covers JSONL sink construction, safe bounded properties, duplicate
configure failure, async writer closure, endpoint/no-endpoint selection,
`logtape.meta.otel` routing, idempotent shutdown, and typed-provider
non-ownership. Existing controller stdout readiness/status stays direct.

### Slice 2b — Worker process adapter and serve lifecycle

**Requires:** slice 1. **Advisory-parallel with:** slices 2a, 2c, and 2d.
**Writes:** new `packages/agent-vm-worker/src/shared/process-logging.ts` and
unit test; `src/main.ts`, `src/worker-cli-operations.ts`,
`src/main.unit.test.ts`, and focused worker lifecycle tests.

Configure before worker construction. Expose the root-only
`runWorkerServeLifecycle` so `runServeCommand` retains the HTTP server and
optional Worker Control Service, waits for the existing shutdown signal, closes
product owners in their existing order, and disposes LogTape last. Listening
stdout and health/protocol response bodies remain direct. Worker categories and
safe-property conversion must not route captured command stdout/stderr into
LogTape.

Unit/integration proof covers no-endpoint no-op, duplicate setup, disposal
ordering/failure, library import neutrality, and serve close idempotence.

### Slice 2c — Gateway Runtime process adapter

**Requires:** slice 1. **Advisory-parallel with:** slices 2a, 2b, and 2d.
**Writes:** new `packages/gateway-runtime/src/production/process-logging.ts` and
unit test; `src/bin/gateway-runtime.ts`, existing gateway root tests, and a
focused host transcript test.

Configure after the gateway service config is loaded and before production
service start. For `otlp-http`, append `/v1/logs` once to the existing endpoint;
for disabled observability, use the explicit no-op provider so ambient OTEL
environment variables cannot override the discriminated config. Keep the independent
typed Tool Portal provider and its shutdown unchanged. Dispose LogTape only
after retirement and typed telemetry shutdown. Startup failure before setup
uses the existing bounded fixed failure line; it never emits a raw error or
changes readiness/retirement stdout.

### Slice 2d — MCP Portal process adapter and typed event mapping

**Requires:** slice 1. **Advisory-parallel with:** slices 2a–2c.
**Writes:** new `packages/mcp-portal/src/cli/process-logging.ts` and unit test;
`src/bin/mcp-portal.ts`, `src/cli/serve-command.ts`,
`src/bin/mcp-portal.unit.test.ts`, and `src/cli/serve-command.integration.test.ts`.

Configure only for server mode, before `startPortalServer`; CLI-only usage,
credential/result commands configure no root sink. Keep `PortalServerLogger`
 as the injected typed observation seam while the default adapter maps each
 event to `agent-vm.mcp-portal.server` with bounded decision/reason/scope/
 duration/failure fields. Close the portal server first, then dispose LogTape.
Listening stdout, usage, credential warnings, result JSON, CLI errors, and
partial-content/protocol output remain direct.

### Review gate A — isolated pre-cutover PR review

After slices 1 and 2a–2d, stop for an isolated implementation/PR review of
only the package manifests, four root adapters, lifecycle seams, and focused
proof. The reviewer receives the three design artifacts, this plan, the diff
from `e0d1416`, and fresh focused results, but not executor assumptions. It
must verify exact 2.3.0 semantics, no shared package, separate typed-provider
ownership, no-endpoint behavior, four-root coverage, and root shutdown order.
Do not begin broad call-site migration until this gate returns no blocking
finding; unresolved design or upstream-API findings route back to Program
Design.

### Slice 3 — Agent VM categorized diagnostic cutover

**Requires:** slice 2a and review gate A. **Serial within package:** classify
then migrate; no dual general-diagnostic path. **Writes:** the Agent VM
diagnostic owners listed above, plus package-local bounded conversion helpers
adjacent to their domains and tests in the corresponding existing unit files.

Replace only admitted general diagnostics with stable categories such as
`agent-vm.controller.runtime`, `.heartbeat`, `.git`, `.lease`, `.gateway`,
`.resource`. Convert unknown errors/context to bounded classes, finite numbers,
safe identifiers/hashes, and sanitized summaries before the logger call; never
pass raw Error/stack/URL/payload/command/content. Keep build progress, init
prompts, resource-helper stdout/JSON, raw child streams, and CLI writers
direct when R6 owns them.

**Proof:** focused Agent VM unit tests for representative runtime, heartbeat,
lease, route, git, gateway, resource, and privacy cases; source scan confirms
all retained direct writes have an explicit protected owner. Run
`pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/controller packages/agent-vm/src/cli packages/agent-vm/src/observability`.

### Slice 4 — Worker categorized diagnostic cutover

**Requires:** slice 2b and review gate A. **Serial within package.** **Writes:**
the worker coordinator, executor, state, server, git, prompt, validation, and
work-phase files listed above; existing unit tests and `shared/stderr.ts` as
needed to remove its general-diagnostic callers while retaining protected
output.

Use stable `agent-vm.worker.{coordinator,executor,state,server}` categories.
Do not log task payloads, commands, repo contents, raw validation streams, or
HTTP response bodies. Preserve task-state/event-log semantics and worker
protocol output.

**Proof:** `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm-worker/src`; focused logger-capture tests assert category, bounded fields, and forbidden-content omission.

### Slice 5 — Gateway Runtime and active OpenClaw plugin cutover

**Requires:** slices 2c and 2d, and review gate A. **Advisory-parallel:** the
two package-local migrations may proceed independently. **Writes:** gateway
runtime general failure/operation sites and tests; and only
`packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.ts` plus
its registration tests.

Gateway general diagnostics use `agent-vm.gateway-runtime.process` while
readiness/retirement stdout and typed Tool Portal telemetry remain unchanged.
The active plugin's two default warning-adapter registration branches use
`agent-vm.openclaw-plugin`; injected warning implementations remain host-owned
and testable. The plugin must contain no configuration, sink construction,
reset, disposal, or shutdown call. The deprecated MCP plugin remains untouched.

**Proof:** gateway unit/host tests parse stdout protocol separately from JSONL
stderr; plugin tests capture a host-configured logger and separately prove the
injected warning seam. Static scan proves no LogTape dependency/source change
in `openclaw-mcp-portal-plugin` and no LogTape import/configuration in
`agent-portal-sdk`.

### Integration gate — package wiring and protected-boundary proof

At the first point where all independently migrated packages meet, run an
integration gate before broad/full validation. It must prove that each root
configures once, libraries are neutral when imported before/after host setup,
and typed telemetry providers remain disconnected. It must also prove Tool
Portal, deprecated plugin, parser, stdout, raw-stream, generated-script, and
fixture boundaries by source/dependency inspection plus focused transcripts.

Required commands include:

```text
pnpm test:taxonomy
pnpm vitest run --config vitest.config.ts --project integration packages/mcp-portal/src/cli/serve-command.integration.test.ts
pnpm test:portal-architecture
pnpm test:portal-exports
```

The gate fails on a second direct general-diagnostic path, a new shared
authority, a typed-provider lifecycle edge, protected stdout/stderr mixing, or
any prohibited plugin/Tool Portal/parser change.

### Slice 6 — real process, OTLP, and shutdown proof

**Requires:** slices 3–5 and the integration gate. **Writes:** a permanent host
proof at `packages/agent-vm/src/integration-tests/structured-logging.host.e2e.test.ts`
and any narrowly scoped root test fixtures required by it.

Build the four active roots and launch production-shaped child processes with
deployment, runtime, state, and zone-file roots created under a harness-owned
OS-temporary project directory. `AGENT_VM_E2E_CACHE_DIR` is reserved for the
shared rebuildable image cache and is not deployment state. Parse every stderr
line as one JSON object and assert
category/level/message/properties, while asserting stdout protocol bytes are
unchanged and free of logging records. Exercise configured OTLP with a
production-shaped HTTP receiver and verify matching safe records, absent
endpoint and unavailable receiver degradation, and product success despite
export failure. Observe duplicate-configuration failure and root shutdown
ordering through child-process lifecycle markers; assert that async sink
disposal closes the supplied writer exactly once.

Run the no-skip host proof through the repository harness:

```text
pnpm build
pnpm test:e2e:host
```

Do not relabel unit/integration sink mocks as process or collector proof. The
manual/runtime observation is the same isolated child-process transcript and
receiver transcript, inspected for four roots, stdout/stderr separation,
no-endpoint no-op, and bounded shutdown.

### Review gate B — final isolated PR-ready review and quality

**Requires:** slice 6. Run the full scoped pyramid and quality gates, then this
second isolated implementation/PR review against the final diff and exact
proof identities. The reviewer must independently inspect Requirements /
Specification / Program Design traceability, all four roots, active plugin,
deprecated exclusion, Tool Portal protection, typed telemetry separation,
LogTape 2.3.0 semantics, privacy scans, and false-green risks. This gate is
separate from gate A and does not merge, publish, or alter the branch.

```text
pnpm fmt:check
pnpm lint
pnpm lint:types
pnpm typecheck
pnpm test:unit
pnpm test:integration
pnpm test:e2e:host
pnpm check
```

Any skipped/todo evidence, stale built artifacts, missing root transcript,
failed privacy scan, unresolved review finding, or unverified collector/no-op
branch prevents a done/PR-ready claim.

## Obligation-to-slice-to-proof map

| Obligation | Slice | Required proof |
| --- | --- | --- |
| R1 / V1 categories and bounded safe fields | 3–5 | logger-capture unit tests and post-cutover source scan |
| R2 / V2 JSONL stderr and no stdout interleave | 2a–2d, 6 | root unit tests plus real four-root host transcript |
| R3 / V3 OTLP path, absent endpoint, exporter failure | 2a–2d, 6 | endpoint receiver, no-endpoint, and unavailable-receiver child proofs |
| R4 / V4 library neutrality | 2a–2d, 5, integration gate | import-order/config-global isolation tests and dependency scan |
| R5 / V5 typed telemetry separation | 2a, 2c, integration gate, review gate B | provider ownership tests, source diff audit, existing telemetry suites |
| R6 / V6 protected channels | 3–6 | classification scan and stdout/protocol/raw-stream host transcript |
| R7 / V7 privacy | 2a–2d, 3–5, review gate B | forbidden-field misuse cases, boundedness assertions, final scan |
| R8 / V8 deprecated/parser/Tool Portal boundaries | 1, 5, integration gate, review gate B | manifest/source scans and portal architecture/exports tests |
| R9 / V9 shutdown/disposal and non-authority | 2a–2d, 6 | idempotent close tests and child shutdown-order/failure transcript |
| R10 / V10 MCP injection seam | 2d, 5 | existing injected logger integration tests plus default adapter capture |
| R11 / V10 no shared logging authority | 1–7 | package graph, dependency, and final diff inspection |

## False-green risks and controls

- A mocked in-memory sink can pass while a shipped root never configures it;
  require built child-process host proof for all four roots.
- A test can see stderr text while the old direct helper still emits it;
  parse JSONL and run an allowlisted direct-writer scan.
- A configured OTLP receiver can pass while local stderr is broken, or an
  absent endpoint can silently skip the branch; assert both sinks and make the
  no-endpoint child run explicit.
- Global LogTape state can leak between tests; use isolated process harnesses
  and reset/dispose only in test-owned setup, never in libraries or production.
- A sink mock can hide writer ownership; assert async-disposal closes the
  supplied writer exactly once and root disposal occurs after product close.
- Existing typed telemetry tests can remain green despite accidental provider
  sharing; inspect imports, constructor arguments, and disposal edges in the
  final diff.
- Plugin or Tool Portal tests can preserve old stderr behavior while violating
  the new boundary; test logger-only plugin behavior separately from protected
  `tool-portal` stdout/result and deprecated-package negative scans.

## Stop and replan conditions

Stop implementation and return to the owning design phase if any of the
following occurs: a newly discovered diagnostic owner cannot be classified as
R1 or protected R6; a new shared lifecycle/interface/package is required; the
existing OTLP authority would need a new setting or the typed provider; a root
cannot retain a shutdown handle through product close; LogTape 2.3.0 does not
throw on duplicate configure, close the stream writer on async disposal, or
provide a no-endpoint no-op; safe fields require raw content, credentials,
stacks, or unbounded values; protected Tool Portal/parser/protocol behavior
must change; or either isolated review gate finds a design-level boundary
break. Do not solve these by adding compatibility paths, weakening proof, or
silently widening scope.
