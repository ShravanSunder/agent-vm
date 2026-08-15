# LogTape structured logging Specification

Requirements: [requirements.md](requirements.md)

## Observable change

Active Agent VM runtime packages currently mix categorized direct stderr
helpers, a typed MCP Portal diagnostic adapter, and private OpenTelemetry
domain telemetry. General operational diagnostics will have one observable
contract at each process boundary:

```text
active library code
    -> categorized LogTape record
    -> process-owned JSONL stderr sink
    -> optional LogTape OpenTelemetry sink

typed health / lifecycle / Tool Portal telemetry
    -> existing typed OpenTelemetry owners (unchanged)

stdout protocols, CLI UX, prompts, progress, and raw streams
    -> existing direct writers (unchanged)
```

The change is a hard cutover for in-scope general diagnostics. It does not
make logging a source of lifecycle truth, durable state, readiness, audit
authority, or a replacement for typed telemetry.

## Consumers and current observable reality

The primary consumer is the deployment operator diagnosing a controller,
worker, gateway-runtime, or MCP server process. A secondary consumer is an
observability operator searching the existing OTLP log path. Library integrators
consume the package APIs without consenting to process-global logging policy.
CLI, protocol, and stream consumers are protected consumers: they rely on
existing channels and bytes rather than on diagnostic formatting.

Current source evidence establishes the following boundaries:

- `packages/agent-vm/src/cli/agent-vm-entrypoint.ts` and
  `packages/agent-vm-worker/src/main.ts` own the shipped CLI processes and
  direct final error/status handling.
- `packages/gateway-runtime/src/bin/gateway-runtime.ts` writes readiness and
  retirement JSON lines to stdout. Those lines are a process protocol.
- `packages/mcp-portal/src/bin/mcp-portal.ts` owns usage, credential warnings,
  result output, and CLI errors. `packages/mcp-portal/src/cli/serve-command.ts`
  owns a typed `PortalServerLogger` seam for server diagnostics and writes the
  listening line to stdout.
- Controller general diagnostics are emitted by direct stderr helpers in
  `controller-runtime.ts`, worker-task, git, heartbeat, lease, health,
  route, zone-runtime, gateway-recovery, and repo-resource-loader paths.
  `gateway/gateway-zone-orchestrator.ts` emits operational diagnostics through
  the controller-owned `writeLog` callback and therefore follows the same
  controller logger without owning another sink or logger lifecycle.
- Worker general diagnostics converge on
  `agent-vm-worker/src/shared/stderr.ts`; worker protocol responses and child
  process streams have different owners.
- Existing typed controller telemetry is owned by
  `observability/controller-telemetry.ts` and
  `observability/otel-controller-telemetry-driver.ts`. Gateway-runtime typed
  Tool Portal telemetry is owned by
  `production/gateway-runtime-tool-portal-telemetry.ts`.
- `packages/openclaw-agent-vm-plugin` is reusable OpenClaw library code. Its
  warning callback is a library diagnostic seam; it does not own a process
  root. `packages/openclaw-mcp-portal-plugin` is deprecated and excluded.

The repository's configuration docs establish that host and gateway OTLP
collectors already exist, that collector scrubbing is defense-in-depth, and
that application code must avoid credentials, prompts, responses, tool
payloads, authorization material, raw URLs with query strings, and other
sensitive content. This Specification adopts those boundaries; it does not
create a second collector or a new logging configuration setting.

## Outcomes

### O1 — Categorized operational diagnostics

Every general operational diagnostic emitted by an in-scope active package is a
LogTape record with a stable hierarchical category, a level, a bounded message,
and bounded safe properties. A record is searchable by package and domain
without relying on a human-readable prefix such as `[agent-vm]`.

### O2 — Process-boundary structured output and OTLP eligibility

Each process root that owns in-scope diagnostics exposes those records as
newline-delimited JSON on stderr. When the existing OTLP path is configured,
the same records are eligible for the existing collector through
`@logtape/otel`. If no OTLP endpoint is configured, the process continues with
structured stderr and no OTLP transport error becomes product output.

### O3 — Embeddable libraries

Reusable package code may obtain a categorized logger and emit records, but it
does not configure LogTape, select sinks, mutate global policy, flush global
sinks, or shut down a process-owned logging provider.

### O4 — Separate typed telemetry ownership

Existing typed health, lifecycle, metric, trace, and Tool Portal/framework
telemetry retains its current record shapes, admission limits, correlation,
provider ownership, and shutdown behavior. General diagnostics may add context
around an operation but cannot replace, duplicate, or reclassify typed domain
records as general logs.

### O5 — Protected channels remain compatible

Stdout JSON/protocol lines, CLI result/help/error text, interactive prompts and
progress, raw child-process stream forwarding, generated scripts, and fixtures
retain their current direct writers and channel assignments. A logging sink
cannot interleave diagnostics into stdout or alter protocol bytes.

### O6 — Privacy-preserving records

No record contains credential material, authorization material, prompts, model
responses, conversation history, reasoning, tool arguments/results, command
text, file bodies, cookies, private keys, raw streams, or credential-bearing
URLs. Errors and identifiers may be represented only through bounded,
sanitized fields required to diagnose the operation.

## Normative obligations

The following obligations are the observable contract derived from the
authorized U rows in `requirements.md`. Their identifiers are Specification
identities, not replacements for the Requirements identities.

### R1 — General diagnostics use stable LogTape categories

For every in-scope general operational diagnostic, the runtime MUST emit a
LogTape record with a stable hierarchical category rooted in the owning
package and domain. The record MUST carry a level and a bounded message; safe
context MUST be properties rather than an ad hoc prefix in the message.

Success is a record such as category `agent-vm.controller.heartbeat` or
`agent-vm.worker.coordinator` that can be routed by category and level. A
direct general-purpose `process.stderr.write`, `console.*`, or equivalent
diagnostic path is not a success condition.

Traces to U1 and U6. The protected direct-output cases in U5 remain outside
R1.

### R2 — Process roots configure structured stderr

When a process root starts, it MUST configure a process-local JSONL stderr sink
for the in-scope categories it owns. Each emitted record MUST be one complete
JSON object followed by one newline on stderr. The sink MUST not write to
stdout.

If process-root logging setup itself fails before a sink exists, the root MAY
write one fixed, bounded setup-failure line directly to stderr. This is the
only pre-configuration exception; it MUST NOT include the raw cause, stack,
configuration, endpoint, path, or credential material, and it MUST preserve
the existing failure status.

The process root owns configuration and shutdown. Importing an in-scope
library, running a library function in a host process, or importing a test
fixture MUST not configure the sink.

Traces to U1, U2, U3, U5, and U9.

### R3 — Optional OTLP uses the existing collector path

When the existing OTLP logs path is configured for a process, the process root
MUST route the same category, level, and safe properties to an
`@logtape/otel` sink. The logging sink MUST not replace the typed telemetry
provider already used by controller or gateway-runtime domain telemetry.

When no OTLP endpoint is configured, the sink MUST degrade to a no-op transport
without changing stderr records, stdout/protocol output, operation results, or
process status. OTLP export failure MUST remain diagnostic and MUST NOT become a
new retry, persistence, queue, or lifecycle authority.

Traces to U2, U4, U5, U6, and U9.

### R4 — Library lifecycle neutrality

Library code MUST obtain a categorized logger only. It MUST NOT call LogTape
configuration, reset, disposal, sink construction, provider shutdown, or
process exit. The host process remains free to configure logging before or after
the library is imported.

Traces to U3, U7, U8, and U9.

### R5 — Typed telemetry remains authoritative

The implementation MUST preserve existing typed health/lifecycle log records,
metrics, traces, Tool Portal records, correlation attributes, admission
limits, collector endpoint semantics, and provider flush/shutdown ownership.
General LogTape records MUST NOT be fed into existing typed event stores or
used to infer readiness, lease authority, durable state, audit decisions, or
recovery transitions.

Traces to U4.

### R6 — Protected direct channels remain unchanged

The following outputs MUST remain direct and retain their current channel and
bytes:

- CLI parser results, help, version, returned errors, prompts, and progress;
- stdout JSON/protocol records from resource helpers, gateway-runtime
  readiness/retirement, MCP usage/results, and other machine consumers;
- raw child/process stream forwarding and generated script/template output;
- fixtures and test protocols whose output is part of the harness contract;
- MCP usage, credential warnings, portal progress/partial-content events,
  JSON results, CLI errors, and the MCP server listening line.

General diagnostics adjacent to those surfaces may use LogTape only when they
are not part of the protected output contract.

Traces to U5 and U8.

### R7 — Safe property allowlist

The implementation MUST limit structured properties to bounded, sanitized
diagnostic context. Allowed classes are:

- stable event or operation kind;
- bounded result or failure classification;
- bounded package/domain identifiers;
- bounded opaque correlation identifiers when their source contract marks
  them safe, or a stable hash when raw identity is unnecessary;
- bounded error class/code and a sanitized, truncated error summary;
- bounded numeric counters, durations, attempt numbers, and port values when
  they do not encode credentials or private content.

The implementation MUST omit or redact credentials, authorization headers and
tokens, secret references, prompts, model/provider responses, tool input and
output, command/file content, raw stream data, cookies, private keys, and URLs
with credential/query material. It MUST not pass raw `Error` objects or raw
stack traces to a structured sink. A collector scrubber remains defense in
depth and is not permission to emit prohibited values.

Traces to U6 and the repository's existing observability privacy contract.

### R8 — Deprecated and parser boundaries stay out of scope

The cutover MUST not add LogTape dependencies or source changes to
`packages/openclaw-mcp-portal-plugin`. It MUST not add Optique dependencies,
change parser behavior, or reopen the completed CLI migration. Library-only
packages MUST not gain parser dependencies because they emit diagnostics.

Traces to U7 and U8.

### R9 — Root shutdown is bounded and non-authoritative

A process root MUST flush/dispose its process-owned logging sinks during its
normal shutdown path, after the product runtime has completed the relevant
operation shutdown ordering. Logging shutdown failure MUST be observable as a
bounded diagnostic and MUST NOT rewrite a successful protocol/result outcome
or introduce a second lifecycle state. Abrupt process termination may leave
buffered OTLP records unexported; stderr remains the local diagnostic contract.

Traces to U2, U3, U4, and U5.

### R10 — Existing injection seams remain valid

Existing typed diagnostic injection seams, especially MCP Portal's
`PortalServerLogger`, MUST remain usable by tests and embedders. The default
adapter may translate the typed event into a LogTape record, but tests and
library callers MUST not need to configure global LogTape to observe or replace
the adapter.

Traces to U3, U4, and U9.

### R11 — No shared logging authority

The design MUST remain within existing package/process owners. It MUST not add a
shared logging package, cross-process log broker, durable log store, retry
coordinator, or logging lifecycle service. A package-local logger declaration
or root setup helper is permitted only for that package's existing owner.

Traces to U3, U4, and U9.

## Observable surface contracts

### C1 — General stderr diagnostics

Authority: the executable process root. Consumer: deployment operator and
stderr supervisor.

Input is a general operational event emitted by an active package. The
postcondition is one bounded JSON object per record on stderr, containing a
timestamp, level, category/logger identity, rendered message, and safe
properties. Empty/no-op logging is valid when no sink is configured in an
in-process library context; a process root must configure stderr before its
owned operations emit records.

Malformed or unbounded fields are rejected or bounded before sink emission.
Sink failure is not a product-operation failure. Partial success is possible:
stderr may contain a record while OTLP is unavailable. Cancellation or process
crash may lose buffered OTLP records; no durability promise exists.

Compatibility covers category/level/properties semantics and stderr channel,
not the old text prefix or exact JSON key ordering. The contract does not
promise stable human-readable message prose beyond bounded diagnostic meaning.

Example: a heartbeat timeout produces a warning category and bounded zone or
attempt context on stderr without writing the controller HTTP response to
stderr or stdout.

### C2 — Existing OTLP logs path

Authority: the existing host/gateway observability configuration and collector
contract. Consumer: observability operator.

The process root supplies the existing collector endpoint/path to the LogTape
OTLP sink using the established configuration boundary. Log records retain
their category, level, and safe properties. No new collector, endpoint setting,
storage, or provider ownership is introduced.

With no endpoint, the OTLP branch is a no-op. With a collector/export failure,
the process keeps local stderr and product behavior. Exact exporter protocol
selection and endpoint derivation are structural decisions in Program Design;
they must remain compatible with the current configured OTLP path.

### C3 — Library embedding

Authority: each reusable package's public API boundary. Consumer: controller,
worker, gateway, MCP, plugin, test, or host application.

Importing a library or invoking a library operation has no process-global
configuration or shutdown side effect. The host may configure LogTape before or
after import. The library's logger category remains stable; an unconfigured
host may observe no output. Existing injected logger/test seams remain valid.

### C4 — Protected protocol and CLI channels

Authority: the owning CLI, gateway-runtime, MCP, worker, or child-process
protocol. Consumer: machine client, supervisor, interactive operator, or test
harness.

The existing direct writer remains the sole owner of the protected bytes.
Logging setup cannot write to stdout, wrap raw stream forwarding, change JSON
result shapes, or replace usage/credential warnings with structured records.
Diagnostics that describe a protected operation are separate from the protected
payload and may be sent to stderr only when not part of the payload contract.

### C5 — Privacy and boundedness

Authority: U6 plus the existing observability scrubbing contract. Consumer:
security/privacy owner and downstream log/OTLP operators.

Every field is allowlisted, bounded, and sanitized. A redaction or omission is
preferred over emitting uncertain content. The contract deliberately does not
promise content capture, full stack traces, raw URLs, raw process output, or
reconstructable prompts/responses.

## Failure and partial-success expectations

The logging path is intentionally non-authoritative:

```text
record accepted by logger
       ├── stderr write succeeds  -> local diagnostic visible
       ├── OTLP endpoint absent    -> local diagnostic only
       ├── OTLP export fails       -> local diagnostic remains; no product retry
       └── root shutdown is abrupt -> buffered OTLP may be lost
```

The application operation's result, HTTP response, CLI status, protocol
record, task state, lease state, and typed telemetry lifecycle do not depend on
OTLP acceptance. A sink write error must not be allowed to turn a successful
operation into a second application failure. Logging shutdown is best effort
within the existing root shutdown owner and cannot supersede a product
shutdown error or protocol result.

No retry/backoff, persistence, queue coordinator, or recovery policy is
specified for logs. If implementation evidence shows that a sink can throw
synchronously at an emission site, the process-local adapter must contain that
failure without exposing unbounded error data; the exact containment mechanism
is Program Design.

## Cross-cutting constraints

### Privacy and security

Secrets remain in existing secret-management and HTTP-mediation boundaries.
LogTape is not an authorization, audit, or secret-resolution path. The safe
property allowlist in R7 applies before both stderr and OTLP routing. Endpoint
credentials, bearer material, raw `op://` references, and credential-bearing
URLs are never fields.

### Reliability and operability

Structured stderr is the local supervisor contract even when the collector is
down. OTLP transport is optional and bounded by the existing collector/runtime
configuration. Logging must not own readiness, health, retry, or recovery.

### Compatibility

The existing package dependency direction remains authoritative. The active
CLI parser standard remains Optique only in the already migrated CLI packages.
The deprecated plugin, protected writers, generated scripts, fixtures, and
typed telemetry remain outside the cutover.

### Performance and capacity

No new unbounded queue or content capture is permitted. Sink buffering and
provider admission must respect existing LogTape/OpenTelemetry bounded
configuration. An overloaded or unavailable collector degrades to local
stderr and does not block product progress beyond the existing sink write
contract.

## Proof obligations

The proof class is normative here; exact test files, commands, and sequencing
belong in Program Design and the implementation plan.

| ID | Contract to prove | Evidence class | Required observation |
| --- | --- | --- | --- |
| V1 | R1 categories and safe properties | automated behavior + state/data inspection | Representative diagnostics have stable categories, levels, bounded fields, and no raw error/stack/property leakage. |
| V2 | R2 structured stderr | API/process transcript | A real process root emits parseable JSONL stderr and does not interleave records into stdout; a forced pre-configuration setup failure emits only the one fixed bounded stderr line. |
| V3 | R3 OTLP routing/degradation | log observation + runtime evidence | Configured collector receives matching category/level/safe fields; absent/unavailable collector leaves local behavior intact. |
| V4 | R4 library neutrality | automated behavior + dependency inspection | Importing libraries/configuring injected seams does not change global LogTape configuration or dispose a host-owned sink. |
| V5 | R5 typed telemetry separation | automated behavior + telemetry observation | Existing typed telemetry records/providers/lifecycle remain unchanged while general diagnostics are emitted separately. |
| V6 | R6 protected channels | host process transcript | Stdout/protocol/help/result/raw relay bytes remain unchanged; configured logging emits only to stderr/OTLP, and the bounded pre-configuration setup-failure line never enters stdout. |
| V7 | R7 privacy | security analysis + misuse cases | Credential, content, raw stream, stack, and credentialed-URL cases are omitted/redacted; bounded safe context remains. |
| V8 | R8 boundaries | dependency/source inspection | Deprecated plugin and parser-only boundaries have no unauthorized LogTape/parser changes. |
| V9 | R9 disposal/failure | integration/runtime evidence | Root shutdown disposes owned sinks after product shutdown, and sink failure does not alter product outcome. |
| V10 | R10/R11 seams and ownership | integration behavior + architecture/static inspection | MCP logger injection remains usable and no shared logging authority/package is introduced. |

## Explicit non-goals and undefined behavior

- Exact old diagnostic text, prefix spelling, JSON key ordering, and stack
  rendering are not compatibility contracts.
- Logs are not durable state, health readiness, task event truth, audit truth,
  authorization, recovery input, or a replacement for typed records.
- The implementation does not add a collector, exporter service, database,
  broker, persistence layer, cross-process transport, or retry coordinator.
- No guarantee is made that buffered OTLP records survive a crash, SIGKILL,
  network partition, or process-abort path.
- No content capture, raw stream capture, prompt/response capture, or full stack
  capture is permitted merely because a sink can serialize it.
- The Specification does not prescribe exact category suffix names, root helper
  file placement, exporter protocol, provider construction details, test
  command names, or implementation task order. Those are structural or
  planning concerns.

## Structural handoff and remaining gaps

The normative observable contract is complete enough for Program Design. The
following are intentionally structural gaps to resolve there, not new user
requirements:

1. The existing controller and gateway typed telemetry providers are private
   and must not be passed to a disposable LogTape OTLP sink. Program Design
   must select a separate LogTape-managed provider or another lifecycle-safe
   adapter while preserving the existing provider owners.
2. Program Design must map the existing system/gateway collector endpoint and
   standard OTEL environment behavior to each process root without adding a new
   deployment setting or changing endpoint/path semantics.
3. Program Design must decide the minimal package-local root setup helpers and
   category map, including how test processes reset/dispose global LogTape
   configuration without library side effects.
4. Program Design must define the bounded redaction/truncation helper shape and
   the exact conversion of the typed MCP Portal event adapter while preserving
   `PortalServerLogger` injection.
5. Source review may discover additional general diagnostic sites. Each must be
   classified against R1 versus the protected R6 boundary before migration;
   search-based rewriting is not authorized.

These gaps do not authorize a shared package, typed telemetry replacement,
protocol migration, or logging lifecycle service.
