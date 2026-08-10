# LogTape structured logging Program Design

Requirements: [requirements.md](requirements.md)

Specification: [specification.md](specification.md)

## Structural crux

The repository has two different logging ownership problems that must not be
collapsed:

1. General operational diagnostics currently have many local direct-stderr
   helpers but no common category/routing contract.
2. Controller and gateway-runtime already own typed OpenTelemetry providers for
   health, lifecycle, metrics, traces, and Tool Portal/framework events.

The selected design gives each executable root one process-local LogTape
configuration and gives each reusable package categorized logger declarations.
The LogTape OTLP sink uses its own provider lifecycle; it never receives the
private typed telemetry providers. Existing typed telemetry remains on its
current path.

```text
process root
  ├─ configure LogTape once
  │    ├─ JSONL stream sink -> process.stderr
  │    └─ @logtape/otel sink -> existing OTLP logs path or no-op
  ├─ run product runtime
  │    ├─ categorized general diagnostics -> LogTape
  │    ├─ typed health/domain telemetry -> existing provider
  │    └─ protected stdout/protocol/raw streams -> existing direct owner
  └─ flush/dispose LogTape sinks after product shutdown

reusable library
  └─ getLogger([package, domain]) only
```

This is a package-local composition pattern, not a new workspace package or
cross-process authority. The root setup code may be small and repeated in the
four process-owning packages because package dependency direction and lifecycle
ownership are more important here than deduplicating a few imports.

## Why this direction was selected

### Selected — package-local root configuration and categorized library loggers

Each process-owning package adds a root-only setup module or equivalent root
function. It creates a JSONL `getStreamSink(Writable.toWeb(stderr), ...)`, an
`@logtape/otel` sink, and category routing through one `configure()` call. Each
library module imports `getLogger()` and keeps its category declaration local
to its reason to change. The root owns disposal.

This preserves U1–U6 and U9 with the smallest ownership change. It does repeat
root setup code across package boundaries, but that repetition is visible,
bounded, and cannot silently create a shared lifecycle authority.

### Rejected — a new shared logging package

A shared package would reduce import duplication but would introduce a new
dependency and lifecycle abstraction across `agent-vm`, worker, gateway
runtime, MCP Portal, and plugin packages. It would need to encode endpoint
selection, provider ownership, test reset behavior, and package compatibility
that the Requirements explicitly leave with existing owners. U9 rejects this
unless source evidence proves it unavoidable; current source does not.

### Rejected — reuse the existing typed `LoggerProvider`

`@logtape/otel` disposes an explicitly supplied provider when its sink is
disposed. Passing the private controller or gateway-runtime provider to the
LogTape sink would make general-log shutdown own typed telemetry shutdown and
would violate R5/R9. A separate LogTape-managed provider keeps the two
lifecycle trees independent, even though they may export through the same
collector.

### Rejected — configure from reusable libraries

Configuring on first `getLogger()` call or from a controller/gateway/MCP
library would mutate process-global policy behind the host's back, race with
other roots, and make import order observable. It violates R4 and is not
needed: LogTape logger calls are no-ops until a host configures the process.

### Rejected — retain direct helpers beside LogTape

Keeping a direct general-diagnostic path would preserve two routing and privacy
contracts. Protected direct writers remain, but every diagnostic site admitted
by R1 is cut over in one pass.

## Components and singular ownership

The components below are semantic owners rather than new directory/package
requirements.

```text
┌─ Agent VM process root ─────────────────────────────────────────────┐
│ owns argv/process lifecycle, stderr/stdout handles, LogTape config   │
│ consumes categorized diagnostics from controller and CLI operations  │
└───────────────┬─────────────────────────────────────────────────────┘
                │ configures once; disposes once
┌───────────────▼─────────────────────────────────────────────────────┐
│ LogTape process adapter (package-local per root)                     │
│ owns sink construction, category routing, OTLP sink/provider handle  │
└───────────────┬──────────────────────┬──────────────────────────────┘
                │                      │
     JSONL stderr sink        @logtape/otel sink/provider
                │                      │
┌───────────────▼────────┐   ┌─────────▼──────────────────────────────┐
│ Deployment supervisor  │   │ Existing OTLP collector/logs path       │
└────────────────────────┘   └────────────────────────────────────────┘

library logger declarations
  ├─ agent-vm controller / gateway / resources
  ├─ agent-vm-worker coordinator / executor / state
  ├─ gateway-runtime operational paths
  ├─ MCP Portal server adapter
  └─ OpenClaw plugin warning adapter (logger-only; no root setup)

typed telemetry owners (unchanged)
  ├─ controller health/lifecycle/metrics/traces
  └─ gateway-runtime Tool Portal/framework telemetry

protected direct owners (unchanged)
  ├─ CLI/protocol/result writers
  ├─ gateway-runtime readiness/retirement stdout
  ├─ MCP usage/results/listening line
  └─ raw child streams, generated scripts, and fixtures
```

### Root owners

The configured process roots are the executable roots that own in-scope
general diagnostics, not every shipped binary:

- `packages/agent-vm/src/cli/agent-vm-entrypoint.ts` for the Agent VM CLI and
  controller process;
- `packages/agent-vm-worker/src/main.ts` for the Worker process;
- `packages/gateway-runtime/src/bin/gateway-runtime.ts` for the gateway-runtime
  process;
- `packages/mcp-portal/src/bin/mcp-portal.ts` for the standalone MCP Portal
  process.

The shipped `@agent-vm/agent-portal-sdk` `tool-portal` executable is explicitly
not a configured root. Its stdout result, credential-bearing stdout contract,
CLI usage, and sanitized failure text remain protected direct output under R6;
adding LogTape there would make the protected protocol ambiguous. Gondolin
image/build helpers and relayed child streams are likewise protected raw or
progress output and have no LogTape setup.

Each root calls only its package-local setup function. The setup function
accepts the root's existing stderr handle and, where the root already resolves
an OTLP endpoint, the endpoint/resource identity from that existing boundary.
Otherwise the `@logtape/otel` automatic exporter path reads standard OTEL
environment configuration. No new deployment setting is introduced.

The OpenClaw plugin has no root owner and therefore has no setup function,
sink construction, or shutdown ownership. Its optional injected warning
interface remains available to direct embedders, while the default warning
adapter uses the stable `agent-vm.openclaw-plugin` logger category. Both
registration branches that install the default adapter are therefore covered
by the library logger boundary. The deprecated
`openclaw-mcp-portal-plugin` remains outside the source and dependency
inventory.

The active executable inventory is therefore:

| Shipped surface | Classification | Logging owner |
| --- | --- | --- |
| `agent-vm` | configured root; general diagnostics plus protected CLI output | Agent VM entrypoint and package-local adapter |
| `agent-vm-worker` | configured root; general diagnostics plus protected listening/protocol output | Worker main and package-local adapter |
| `agent-vm-gateway-runtime` | configured root; general diagnostics plus protected readiness/retirement protocol | Gateway Runtime executable and package-local adapter |
| `mcp-portal` | configured root for server mode; CLI-only credential/result output stays protected | MCP Portal executable and package-local adapter |
| `tool-portal` | protected CLI/protocol surface; no LogTape root | `agent-portal-sdk` direct writers |
| Gondolin/image/build helpers | protected raw/progress/child streams; no LogTape root | existing build/stream owners |

### Categorized logger ownership

The initial stable category map is:

| Package/domain | Category root | Diagnostic responsibility |
| --- | --- | --- |
| Agent VM controller runtime | `agent-vm.controller.runtime` | root startup, shutdown, attachment, observability diagnostics |
| Controller heartbeat | `agent-vm.controller.heartbeat` | heartbeat and request-heartbeat warnings |
| Controller git | `agent-vm.controller.git` | non-authoritative event-recording/push/pull diagnostics |
| Controller lease | `agent-vm.controller.lease` | lease cleanup, liveness, recovery warnings |
| Controller gateway | `agent-vm.controller.gateway` | gateway health/recovery/runtime diagnostics |
| Controller resource | `agent-vm.controller.resource` | repo-resource loader diagnostics only; child stdout remains protocol |
| Worker coordinator | `agent-vm.worker.coordinator` | task coordination and event-publication diagnostics |
| Worker executor | `agent-vm.worker.executor` | bounded executor recovery diagnostics |
| Worker state | `agent-vm.worker.state` | event/state replay and persistence diagnostics |
| Worker server | `agent-vm.worker.server` | server operation diagnostics separate from HTTP response bodies |
| Gateway runtime process | `agent-vm.gateway-runtime.process` | startup/retirement failure diagnostics; readiness stdout unchanged |
| MCP Portal server | `agent-vm.mcp-portal.server` | default adapter for typed server events |
| OpenClaw plugin | `agent-vm.openclaw-plugin` | default warning adapter; injected warning seam remains available |

The map is stable at the package/domain level. A newly discovered site must
join an existing domain or return to design if it would introduce a new owner;
it must not create a per-call category or encode secrets/IDs into category
segments.

## Behavioral interfaces

### Process logging setup handle

Each root-local implementation realizes the same conceptual interface without
exporting a shared cross-package type:

```text
configureProcessLogging({
  stderr: process.stderr,
  serviceName,
  otlpEndpoint?,
  resourceAttributes?
}) -> Promise<ProcessLoggingHandle>

ProcessLoggingHandle.shutdown() -> Promise<void>
```

Semantics:

- `configureProcessLogging` is called once by the process root before the
  owned runtime can emit general diagnostics.
- It creates one JSONL stderr sink using the root's stderr stream and one
  `@logtape/otel` sink. The stderr sink is always active; the OTLP sink is
  allowed to be a no-op when no endpoint is configured.
- The LogTape configuration routes all in-scope package categories to both
  sinks. The `logtape.meta.otel` category is routed to stderr so exporter
  diagnostics cannot recursively route through the OTLP sink.
- The returned handle is the only owner permitted to flush/dispose those
  sinks. It does not own typed controller/gateway telemetry providers. Since
  LogTape's `configure()` returns `Promise<void>` and owns process-global
  sinks, the adapter keeps an idempotent local shutdown guard and calls the
  public async `dispose()` exactly once after product shutdown.
- Production configuration uses `configure({ reset: false })` (the default).
  A duplicate configure is a bounded setup error; it must not silently replace
  an active root. `reset()` is reserved for isolated test harnesses and is not
  a library or product shutdown mechanism.
- A root does not call setup again to change categories or endpoints. Endpoint
  selection is complete before configuration; a changed deployment requires a
  new process.

The concrete implementation may use `configure()` rather than
`configureSync()` because the stream and OTLP sinks are async-disposable. The
current upstream exports `dispose(): Promise<void>` from
`packages/logtape/src/mod.ts`; its implementation awaits all async disposables
in `packages/logtape/src/config.ts`. Root shutdown uses this public `dispose()`
operation, not `reset()`. A test-only process may use `reset()`/`dispose()` via
its root harness; production libraries must never call either operation.

### Library logger declaration

Library modules declare a logger at module scope or in a bounded factory:

```text
const logger = getLogger(["agent-vm", "controller", "heartbeat"])
logger.warn("Heartbeat request failed", {
  operation: "heartbeat",
  failureClass: "transport",
  attempt: boundedAttempt,
})
```

The call site must first convert errors and context into the safe property
allowlist. It must not pass the raw `Error`, stack, URL, payload, command,
prompt, response, or stream. Logger calls are fire-and-forget diagnostics and
do not alter the operation's return/error contract.

### Safe diagnostic property boundary

Each package-local adapter owns the small conversion functions it needs. The
policy is shared by Specification, but no shared implementation package is
introduced.

```text
unknown error/context
        │
        ├─ classify error -> bounded errorClass/errorCode
        ├─ sanitize message -> bounded errorSummary or omit
        ├─ retain bounded numeric/enumerated context
        ├─ hash or omit opaque identity where raw value is unnecessary
        └─ reject content/credentials/URLs/raw streams
        │
        ▼
safe properties -> LogTape logger -> both sinks
```

Safe conversion is best-effort and omission-biased. It must never recursively
serialize arbitrary objects. Error fields use bounded summaries rather than
`Error` objects so the OTLP sink cannot generate unbounded semantic-convention
stack attributes.

### MCP Portal typed event adapter

`PortalServerLogger` remains the injected interface and remains the observation
seam for existing tests/embedders. The default implementation maps each typed
event to one category and level and copies only its bounded decision, reason,
agent scope, client-address classification, duration, namespace, or failure
class as allowed by R7. It does not expose the raw event object as properties.

The adapter does not change `startPortalServer` control flow. Auth audit sinks,
approval audit sinks, upstream close warnings, and server errors still occur at
their existing boundaries; only the default diagnostic destination changes.

## Current-to-proposed call-path deltas

The following paths are the minimum source-grounded runtime model. `unchanged`
means the edge is intentionally preserved because it is protocol-, telemetry-,
or ownership-critical.

### Agent VM controller diagnostics

```text
CURRENT
agent-vm entrypoint
  -> runAgentVmCli / controller runtime
  -> local writeController*Log(message)
  -> process.stderr.write("[prefix] " + message)
  <- operation continues or returns its existing error

PROPOSED
agent-vm entrypoint
  -> configureProcessLogging()                         [added]
  -> runAgentVmCli / controller runtime                [unchanged]
  -> categorized logger declaration                    [changed owner]
  -> safe diagnostic property conversion               [added]
  -> LogTape routing -> stderr + optional OTLP         [added]
  <- operation continues or returns its existing error [unchanged]
```

`controller-runtime.ts`, heartbeat, git, lease, health, route, zone-runtime,
gateway-recovery, and resource-loader helpers lose only their direct general
diagnostic writer. The repo-resource loader's generated child stdout and its
JSON parse protocol remain unchanged.

### Worker diagnostics

```text
CURRENT
agent-vm-worker main
  -> worker server/coordinator/executor/state
  -> shared writeStderr(message)
  -> process.stderr.write(message + "\\n")
  <- HTTP/task-state/protocol result                         [unchanged]

PROPOSED
agent-vm-worker main
  -> configureProcessLogging()                              [added]
  -> worker server/coordinator/executor/state               [unchanged]
  -> categorized logger + safe property conversion          [changed]
  -> LogTape routing -> stderr + optional OTLP               [added]
  <- HTTP/task-state/protocol result                         [unchanged]
```

The shared `writeStderr` helper is either removed from general diagnostic
callers or reduced to protected output only; raw command stdout/stderr
captured for validation and returned task protocol content is not routed to
LogTape.

### Gateway-runtime process

```text
CURRENT
gateway-runtime executable
  -> load config
  -> startGatewayRuntimeProductionService
  -> process.stdout readiness JSON                         [unchanged]
  -> wait for signal -> retire
  -> process.stdout retirement JSON                         [unchanged]
  -> catch -> process.stderr fixed failure line              [protected root error]

PROPOSED
gateway-runtime executable
  -> load config
  -> configureProcessLogging()                              [added]
  -> startGatewayRuntimeProductionService                   [unchanged]
  -> typed Tool Portal telemetry provider                    [unchanged/private]
  -> process.stdout readiness JSON                           [unchanged]
  -> wait for signal -> retire
  -> process.stdout retirement JSON                           [unchanged]
  -> LogTape diagnostics for general failures                [changed]
```

Readiness and retirement JSON remain the first-class supervisor protocol. The
root failure path may retain its protected fixed diagnostic behavior if startup
fails before a LogTape configuration can exist; it must not become an
unbounded stack or protocol mutation. This startup-before-configuration edge
is an explicit proof seam and not a general-library direct writer.

### MCP Portal process and server adapter

```text
CURRENT
mcp-portal executable
  -> parse/load/serve
  -> typed PortalServerLogger event
  -> default JSON event write to stderr                    [changed]
  -> listening port line to stdout                         [unchanged]
  -> result/usage/credential/CLI output direct              [unchanged]

PROPOSED
mcp-portal executable
  -> configureProcessLogging()                             [added]
  -> parse/load/serve
  -> PortalServerLogger injection seam                      [unchanged]
  -> default event-to-LogTape adapter                       [changed]
  -> categorized stderr + optional OTLP                     [added]
  -> listening port line to stdout                          [unchanged]
  -> result/usage/credential/CLI output direct               [unchanged]
```

The server logger remains an event-level interface rather than exposing a raw
LogTape logger as public API. This preserves library embedders and existing
test observation.

### OpenClaw plugin library (logger-only, no process root)

```text
CURRENT
OpenClaw host
  -> registerAgentVmPlugin
  -> registerToolPortalNativeTools only when registerTool exists
  -> inline default warning adapter -> process.stderr.write
  -> optional injected logger seam for direct embedders

PROPOSED
OpenClaw host
  -> registerAgentVmPlugin
  -> registerToolPortalNativeTools only when registerTool exists
  -> default warning adapter -> categorized LogTape logger
  -> optional injected logger seam for direct embedders
```

The plugin remains a reusable library: it does not configure LogTape, construct
sinks, reset or dispose process-global state, or own shutdown. The default
warning adapter replaces its direct stderr write with the
`agent-vm.openclaw-plugin` logger; an injected warning implementation remains
host-owned and preserves the existing registration/test seam. The deprecated
`openclaw-mcp-portal-plugin` has no proposed path.

### Preserved typed telemetry path

```text
controller runtime -> startControllerTelemetry
  -> private controller LoggerProvider/MeterProvider/TracerProvider
  -> existing collector endpoint and admission/shutdown lifecycle [unchanged]

gateway runtime -> createGatewayRuntimeToolPortalTelemetryRuntime
  -> private typed LoggerProvider/MeterProvider/TracerProvider
  -> existing Tool Portal telemetry contract                   [unchanged]
```

No LogTape edge is inserted into these paths. The only relationship is that
both general logs and typed logs may reach the same existing collector; their
providers, record schemas, lifecycle, and authority remain separate.

## Logging lifecycle and state

Only process roots own this state. A library logger has no lifecycle state and
is a no-op until a host has configured LogTape.

| State | Owner | Entry guard | Invariant | Exit |
| --- | --- | --- | --- | --- |
| Unconfigured | process root | process has started | no sink/global policy is owned by libraries | `configureProcessLogging` |
| Configuring | process root | no prior root configuration | stderr sink and OTLP sink are created together or startup reports bounded setup failure | configured or root startup failure |
| Configured | process root | setup completed once | all in-scope categories route to stderr; OTLP is optional/no-op; typed providers remain independent | root product shutdown |
| Shutting down | process root | product shutdown has begun | no new product work starts; sinks are flushed/disposed at most once | disposed or bounded disposal failure |
| Disposed | process root | shutdown handle completed | root owns no active LogTape sinks; library imports remain safe | process exit |

Illegal transitions are duplicate process configuration, library-initiated
configuration/disposal, and root shutdown before product runtime has completed
its required owner ordering. A duplicate root setup is a programming error,
not a reason to reset global configuration or install a second sink.

### Root shutdown ordering

The root's product shutdown owner remains authoritative. The adapter is retained
by that owner for the entire live process; it is not disposed in a CLI
dispatcher `finally` immediately after startup:

```text
configure LogTape
  -> product remains live and emits diagnostics
  -> existing stop/retire signal starts product shutdown
  -> product runtime/server closes
  -> existing typed telemetry flush/shutdown
  -> LogTape `dispose()` exactly once                         [new, last]
  -> process exit/status ownership remains with product root   [unchanged]
```

The concrete root edges are explicit:

- Agent VM `controller.start` retains the returned `ControllerRuntime` inside
  one root-only `runControllerStartLifecycle` operation. Its explicit call
  path is: `startControllerRuntime` -> print the existing readiness JSON ->
  await `waitForProcessShutdownSignal` -> await `runtime.close()` -> await
  `logging.shutdown()`. The command dispatcher does not return from the start
  branch until that sequence settles. A repeated signal shares the same close
  promise; a runtime-close error remains the product result, while a logging
  disposal error is recorded and never replaces it.
- Worker `serve` retains the Hono/HTTP server and optional Worker Control
  Service close handle inside one root-only `runWorkerServeLifecycle`
  operation. Its explicit call path is: construct coordinator/server -> print
  the existing listening line -> await `waitForProcessShutdownSignal` ->
  await server close and Worker Control Service close in their existing owner
  order -> await `logging.shutdown()`. `runServeCommand` must not return after
  `serve()` starts; the current early return is the named implementation seam
  to expose. A server/control close error remains the product result and a
  logging disposal error is secondary.
- Gateway Runtime already waits for retirement, calls `service.retire()`, and
  shuts down typed Tool Portal telemetry as part of that lifecycle; the LogTape
  handle is disposed after the retirement result is produced.
- MCP Portal already exposes `waitUntilPortalServerShutdown`; the root closes
  the portal server before disposing LogTape. CLI-only commands that do not
  start a server configure no root sink and preserve their protected output.

If disposal fails, the root emits a bounded fixed diagnostic only when the
stderr path is still available and preserves the product's startup/retirement
or CLI status. Repeated shutdown signals share one promise; no second global
dispose or replacement configuration is attempted.

Tests that configure process-global LogTape must dispose/reset it in their
process harness. Tests that exercise library code without root configuration
must remain valid and must not depend on stderr side effects.

The two new lifecycle operations are root-local orchestration functions, not a
shared package or public library contract. They own signal listener removal,
idempotent product close, and LogTape shutdown ordering; the existing runtime,
server, and control-service handles remain the authoritative product owners.

## OTLP endpoint, provider, and degradation model

Endpoint selection is an input to the process-root adapter, not a new config
authority. The existing repository telemetry drivers treat their configured
collector value as a base URL and append `/v1/logs`; LogTape's explicit
`otlpExporterConfig.url` is passed to its exporter as-is. The adapter therefore
performs the same single append before calling LogTape and never passes a typed
provider.

| Executable/root | Existing authority | Exact LogTape exporter URL | Resource identity | Setup/no-endpoint behavior |
| --- | --- | --- | --- | --- |
| Agent VM controller (`agent-vm-entrypoint.ts`) | enabled repository observability config, resolved by controller telemetry (`controller-telemetry.ts`) | `${formatCollectorHttpEndpoint(config)}/v1/logs`, with trailing slashes removed once | existing controller service identity and bounded development attributes | configure after CLI/config resolution and before `startControllerRuntime`; disabled config omits explicit URL and allows env discovery, otherwise no-op |
| Worker (`agent-vm-worker/src/main.ts`) | no worker-specific repository endpoint authority | no explicit URL; `@logtape/otel` reads `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` then `OTEL_EXPORTER_OTLP_ENDPOINT` | `agent-vm-worker` plus fixed worker runtime identity only | configure before worker construction; absent env endpoint selects LogTape no-op |
| Gateway Runtime (`gateway-runtime.ts`) | loaded `observability` discriminated config; `gateway-runtime-tool-portal-telemetry.ts` currently appends `/v1/logs` to its base endpoint | `${config.observability.endpoint}/v1/logs` for `otlp-http`; no explicit URL for `disabled` | existing `agent-vm-tool-portal` identity and attachment epoch/zone attributes | configure after service config load and before production service start; disabled/no endpoint is no-op |
| Standalone MCP Portal (`mcp-portal.ts`) | no repository OTLP endpoint authority | no explicit URL; standard LogTape OTEL environment discovery | `agent-vm-mcp-portal` fixed process identity plus bounded mode metadata | configure before server start only; absent env endpoint is no-op; CLI-only credential/result commands retain protected output |
| Tool Portal CLI (`agent-portal-sdk` `tool-portal`) | protected CLI/protocol output only | not applicable; no LogTape root | not applicable | no configuration or dependency; stdout/stderr contracts remain direct |

Direct upstream API evidence: `configure()` is async and returns
`Promise<void>`; `getStreamSink(Writable.toWeb(stderr), ...)` and
`getOpenTelemetrySink({ otlpExporterConfig: { url }, ... })` are async-disposable
sinks; explicit URL wins over `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`, then
`OTEL_EXPORTER_OTLP_ENDPOINT`; no endpoint yields a no-op provider; and public
`dispose()` awaits sink/provider shutdown. The `logtape.meta.otel` diagnostic
category is routed only to stderr and is excluded from the OTLP sink to prevent
recursion. These facts are from the current `dahlia/logtape` API research and
are implementation constraints, not new configuration behavior.

The LogTape OTLP provider is distinct from the existing typed providers. It is
created and disposed by the root adapter only. No new queue, retry policy,
collector service, persistence, or cross-process forwarding is introduced.

```text
LogTape record
  -> stderr sink (local, always configured)
  -> OTLP sink
       ├─ configured endpoint -> separate LogTape provider/exporter
       ├─ no endpoint         -> no-op provider
       └─ export failure       -> contained diagnostic; product continues
```

The root must not make operation success conditional on OTLP acceptance. The
existing typed telemetry provider must not be passed to LogTape because sink
disposal would call its shutdown method and violate the ownership boundary.

## Privacy and trust realization

The untrusted inputs to general logging are error objects, operation context,
request metadata, provider diagnostics, and failure strings. The trust boundary
is the package-local safe-property conversion immediately before a logger call.
The LogTape sinks and collector are downstream consumers, not policy owners.

```text
untrusted error/context
  -> classify and bound (package-local helper)
  -> allowlisted properties
  -> LogTape logger
  -> stderr / OTLP
```

The conversion layer enforces:

- bounded enumerated event/failure classes instead of arbitrary object dumps;
- category segments are fixed source literals and each segment is at most 64
  characters;
- bounded identifiers or stable hashes are at most 128 characters, never
  secret-bearing references;
- bounded sanitized error summaries are at most 256 characters, with raw
  `Error` and stack omitted;
- numeric counters/durations/attempts are finite, non-negative, and no larger
  than `Number.MAX_SAFE_INTEGER`;
- omission of prompts, responses, reasoning, tool payloads, command/file
  content, raw streams, cookies, authorization headers, tokens, private keys,
  and credential-bearing URLs.

Each package owns the conversion helpers adjacent to its diagnostic domain;
there is no cross-package safe-property utility. A source site that cannot
meet these bounds emits only a fixed event and failure class. Tests assert the
upper bounds and forbidden-field omission at the logger-call seam.

The existing collector scrubber remains defense in depth. It cannot widen the
application allowlist or authorize prohibited data. Any source site that cannot
produce safe bounded context must emit only a fixed event/failure class.

## Failure, concurrency, and recovery

### Sink failure

Sink/export failure is contained at the logging boundary. It does not retry
product operations, change a health decision, alter a task event, roll back a
lease, rewrite an HTTP response, or change CLI/protocol status. A local stderr
record may exist without OTLP delivery. If stderr itself is unavailable, the
record may be lost; no durable logging guarantee is introduced.

### Startup failure

Root configuration happens before the owned runtime emits general diagnostics.
If sink construction cannot complete, the root does not proceed while falsely
claiming structured logging is configured. It returns through that root's
existing startup-error owner using a bounded fixed message. This edge is
observable in root host proof and does not authorize libraries to configure a
fallback sink. The fixed startup owner is `agent-vm`'s existing CLI error
writer, the worker's `handleCliMainError`, Gateway Runtime's existing
`Gateway runtime service failed.` line, and MCP Portal's existing command
error writer. None includes an error object, stack, endpoint, or raw config.

### Concurrency

There is one process-global LogTape configuration and one root shutdown owner.
Concurrent library calls only enqueue/write through the configured sinks; they
do not mutate configuration. The design adds no locks, cross-process queues, or
ordering contract beyond each sink's own record handling. Typed telemetry
admission and concurrency remain unchanged.

### Abrupt termination

SIGKILL, crash, or process abort may lose buffered OTLP records. Stderr remains
the local best-effort path. No restart/recovery mechanism is added for logs.

## Protected boundaries and forbidden edges

The following edges are explicitly forbidden:

- library -> `configure`, `reset`, `dispose`, sink construction, or provider
  shutdown;
- general LogTape diagnostics -> stdout, CLI result writers, protocol writers,
  raw stream relays, generated scripts, or fixtures;
- LogTape OTLP sink -> existing typed controller/gateway provider;
- general LogTape records -> health event store, task state, lease authority,
  readiness, recovery decisions, or typed telemetry schema;
- diagnostic property conversion -> raw payloads, content capture, credentials,
  private keys, or credential-bearing URLs;
- deprecated `openclaw-mcp-portal-plugin` -> new dependency or source path;
- logging change -> Optique parser migration or parser-only dependency in a
  library package;
- package-local setup helper -> another package's process lifecycle.

## Requirement realization and proof architecture

| Specification | Structural realization | Proof seam |
| --- | --- | --- |
| R1 | package/domain logger declarations and stable category map | unit records captured by an in-memory sink |
| R2 | root-local `configureProcessLogging` with JSONL stderr sink | real root process transcript; stdout/stderr separation |
| R3 | separate `@logtape/otel` provider with current endpoint/env/no-op behavior | collector observation plus no-endpoint and unavailable-endpoint process proof |
| R4 | no setup imports in library modules; root-only lifecycle calls | import/configuration isolation test and dependency/source inspection |
| R5 | existing typed telemetry files/providers untouched and unconnected | typed telemetry unit/integration evidence plus source ownership audit |
| R6 | protected direct writers remain; migration inventory classifies each site | host transcript of CLI/protocol/raw stream bytes |
| R7 | package-local bounded safe-property conversion | security misuse cases for secrets/content/stack/URL and safe-field cases |
| R8 | deprecated `openclaw-mcp-portal-plugin` and Optique parser boundaries unchanged; active OpenClaw plugin remains logger-only | manifest/source scan and existing CLI proof |
| R9 | root handle flush/disposes after product shutdown | shutdown-order integration seam and injected sink failure observation |
| R10 | MCP `PortalServerLogger` remains typed/injectable; default adapter logs | existing injected logger integration tests plus default sink capture |
| R11 | no shared package or broker; setup remains package-local | package graph/static architecture inspection |

Real boundaries required for confidence are the built process root, actual
stdout/stderr streams, the LogTape configuration lifecycle, and (when testing
R3) a real or production-shaped OTLP receiver. Library unit tests may replace a
sink through LogTape's existing test configuration; they cannot claim process
root or collector proof from that replacement alone.

## Cutover boundary

The source migration is one hard cutover:

1. Add package-local root setup and categorized logger declarations.
2. Classify every direct diagnostic site against R1 or protected R6.
3. Replace only general diagnostic writers with LogTape calls and safe fields.
4. Preserve typed telemetry, protocols, CLI UX, raw relays, generated scripts,
   fixtures, and the deprecated `openclaw-mcp-portal-plugin` unchanged.
5. Add dependencies only to active packages that import LogTape; no shared
   logging package or parser dependency is added.

There is no runtime dual path or feature flag. A direct writer retained after
classification must have an explicit R6 owner, not be a compatibility alias.
Rollback is the changeset as a whole; no logging state or data migration is
introduced.

## Implementation-boundary checklist

The structural decisions that previously blocked planning are settled here:

- root shutdown is signal/close-owned by the existing controller, worker,
  gateway, and MCP server owners, with LogTape disposal last;
- each configured root's OTLP authority, `/v1/logs` construction, resource
  identity, and no-endpoint behavior are fixed by the table above;
- Tool Portal and raw/build helpers remain protected/no-root cases; the
  OpenClaw plugin is a logger-only/no-root library case, while the deprecated
  `openclaw-mcp-portal-plugin` remains excluded; no shared logging package is
  permitted;
- startup failures use the named bounded fixed writers, and safe-property
  bounds and helper ownership are explicit.

Implementation planning must still inventory every admitted general diagnostic
site, place the package-local adapters and logger declarations, add the exact
unit/integration/host/collector proof named in the realization table, and
re-scan after classification. A newly found owner or boundary returns to this
design rather than being bulk-rewritten.
