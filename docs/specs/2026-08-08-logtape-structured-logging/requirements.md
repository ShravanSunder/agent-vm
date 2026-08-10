# LogTape structured logging requirements

Date: 2026-08-08

## Authority and boundary

This Requirements artifact records the approved repository-wide logging scope
for the active Agent VM packages. Its stable user-requirement identities are
the `U` rows below. The approved authority is the 2026-08-08 LogTape scope
decision:

> Active packages that emit general operational diagnostics use
> `@logtape/logtape`. Executable/process roots configure process-local
> structured stderr and `@logtape/otel` sinks. Libraries only get categorized
> loggers. Existing typed domain telemetry, metrics, and traces remain
> separate. Stdout protocols, CLI result/help/errors, interactive
> prompts/progress, raw stream relays, generated scripts, and fixtures remain
> direct. Credentials and unbounded sensitive data never become fields.
> `packages/openclaw-mcp-portal-plugin` is deprecated and excluded. Optique and
> `@optique/zod` are the CLI parser standard only in packages that own CLI
> parsing; the already-migrated CLIs need no logging-driven migration. No
> ceremonial dependencies or new CLI migration belong in this change.

The approved scope permits changes to active package source and the package
manifests/lockfile needed to use LogTape. It does not authorize a new shared
logging package unless the current source proves that a lifecycle-neutral
interface cannot be kept process-local. It does not authorize replacing typed
domain telemetry or changing public stdout/protocol behavior.

The Requirements identity is this file. The distinct Specification identity is
[`specification.md`](./specification.md), and the distinct Program Design
identity is [`program-design.md`](./program-design.md). Neither companion file
replaces this source of needs, priorities, or non-goals.

## Consumers and stakeholders

| Identity | Consumer or stakeholder | Need | Why it matters |
| --- | --- | --- | --- |
| U1 | Deployment operator and maintainer | Searchable, categorized operational diagnostics from active runtime packages | A failed controller, worker, gateway runtime, or MCP server needs a consistent diagnostic vocabulary at the process boundary. |
| U2 | Deployment operator and observability operator | Process-root diagnostics available as structured stderr and through the existing OTLP observability path | Local supervisors need stderr; Victoria/OpenTelemetry operators need the same operational signal without inventing a second telemetry authority. |
| U3 | Library integrator | Libraries may emit useful diagnostics without owning the host application's sink or lifecycle | A library must work inside the controller, worker, gateway, MCP, test, and host processes without configuring global logging behind the integrator's back. |
| U4 | Runtime and telemetry maintainers | Existing typed health, metrics, traces, and domain log records retain their current owners and semantics | Domain telemetry carries lifecycle and correlation contracts that general-purpose logging must not silently duplicate or replace. |
| U5 | CLI/API/stream consumers | Machine-readable stdout, CLI result/help/error text, prompts, progress, and raw relays retain their current channels and bytes | These surfaces are protocols or user-facing contracts, not general diagnostics; changing them can break scripts, clients, and interactive operation. |
| U6 | Security and privacy owners | Credentials and unbounded sensitive content never enter structured log fields | A structured sink makes fields searchable and exportable, so accidental inclusion would widen exposure across stderr, OTLP, and retained telemetry. |
| U7 | Maintainers of the deprecated plugin | No new logging work is introduced for `packages/openclaw-mcp-portal-plugin` | The deprecated package must not acquire a new dependency or path while active packages are cut over. |
| U8 | CLI maintainers | Optique remains the parser standard only where CLI parsing is owned | Logging work must not reopen the completed parser migration or add parser dependencies to library-only packages. |

## Current observable reality

The repository already has separate telemetry and process boundaries:

- `packages/agent-vm/src/cli/agent-vm-entrypoint.ts:119-187` owns the
  `agent-vm` CLI entrypoint, injected stdout/stderr, and direct top-level CLI
  error handling.
- `packages/agent-vm-worker/src/main.ts:44-125` owns the worker CLI entrypoint
  and direct CLI error handling.
- `packages/gateway-runtime/src/bin/gateway-runtime.ts:34-58` owns a gateway
  runtime process whose readiness and retirement JSON lines are written to
  stdout.
- `packages/mcp-portal/src/bin/mcp-portal.ts:74-150` owns usage, credential
  warnings, and command-result output; `packages/mcp-portal/src/cli/serve-command.ts:42-105,302-325`
  owns a typed server-diagnostic event adapter that currently writes JSON lines
  to stderr.
- `packages/agent-vm/src/controller/controller-runtime.ts:154-213,462-575,784-849`
  and `packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts:547-577,2104-2110,2485-2524`
  emit general operational messages through direct stderr/callback paths.
- `packages/agent-vm/src/observability/controller-telemetry.ts` and
  `packages/agent-vm/src/observability/otel-controller-telemetry-driver.ts`
  own typed controller health/lifecycle log, metric, and trace export.
- `packages/gateway-runtime/src/production/gateway-runtime-tool-portal-telemetry.ts`
  owns typed Tool Portal log, metric, and trace records.
- `docs/reference/configuration/system-json.md:1041-1117` makes the existing
  host collector and zone observability boundaries explicit, including fixed
  producer identities, bounded admission limits, and content capture disabled.

This change addresses the general operational-diagnostic gap only. It does not
claim that every thrown `Error` is a log event: validation errors, protocol
responses, returned CLI errors, and stream contents retain their existing
owners.

## Desired outcomes

O1. Active runtime packages have a shared, categorized structured-diagnostic
vocabulary that can be enabled and routed by the process that owns them.

O2. Each executable/process root exposes its general operational diagnostics as
structured stderr and can route the same records through an `@logtape/otel`
sink into the existing OTLP collector path when that path is configured.

O3. Library packages remain embeddable: they declare categorized loggers but do
not configure global sinks, mutate process-wide configuration, or own shutdown.

O4. Typed domain telemetry remains the source of truth for health events,
metrics, traces, and Tool Portal/framework telemetry. General logging adds
diagnostic context without changing those event schemas, cardinality limits,
or lifecycle decisions.

O5. Existing protocol and user-facing output contracts remain byte- and
channel-compatible, while general diagnostics gain structured fields where
they are not part of those contracts.

O6. No credential, prompt, response, tool payload, raw stream, unbounded
sensitive value, or credential-bearing URL is introduced as a structured field.

## Accepted user requirements

The rows are normative source meaning. Each priority is `P0 required` because
the approved authority makes each boundary part of this cutover; the assigner
is the approved logging-scope authority.

| ID | Priority / assigner | Requirement | Observable success condition |
| --- | --- | --- | --- |
| U1 | P0 / approved logging-scope authority | Active packages that emit general operational diagnostics MUST use categorized `@logtape/logtape` loggers for those diagnostics. | A diagnostic record from an in-scope package has a stable package/domain category and is not emitted through an ad hoc general-purpose console/stderr path. |
| U2 | P0 / approved logging-scope authority | Every executable/process root that owns in-scope diagnostics MUST configure a process-local structured stderr sink and an `@logtape/otel` sink. | Starting a root with logging enabled produces structured stderr records and makes the same category/level/fields eligible for the configured OTLP logs path. |
| U3 | P0 / approved logging-scope authority | Library packages MUST obtain categorized loggers only; they MUST NOT configure LogTape sinks, global logging policy, or process shutdown. | A library can be imported into a host process before or after the host configures LogTape without taking over configuration or causing a process-global side effect. |
| U4 | P0 / approved logging-scope authority | General logging MUST remain separate from existing typed domain telemetry, metrics, and traces. | Existing health/lifecycle/Tool Portal/framework telemetry records, providers, correlation, limits, and lifecycle decisions are unchanged by the logging cutover. |
| U5 | P0 / approved logging-scope authority | Stdout protocols, CLI result/help/errors, interactive prompts/progress, raw stream relays, generated scripts, and fixtures MUST remain direct. | Protocol/result bytes and user interaction remain on their existing direct writers; logging configuration cannot interleave structured records into those channels. |
| U6 | P0 / approved logging-scope authority | Credentials and unbounded sensitive data MUST never become structured log fields. | No field contains credential material, authorization material, prompts, responses, tool payloads, raw stream contents, unbounded error/stack data, or credential-bearing URLs; safe bounded diagnostic context remains possible. |
| U7 | P0 / approved logging-scope authority | `packages/openclaw-mcp-portal-plugin` MUST be excluded from this logging cutover. | The deprecated package has no LogTape dependency, source migration, or new process-root configuration from this scope. |
| U8 | P0 / approved logging-scope authority | Optique and `@optique/zod` remain the CLI parser standard only in existing CLI-owning packages; this logging change MUST add no ceremonial parser dependency or new CLI migration. | No library-only package gains Optique because of logging, and no CLI parser behavior changes as part of the logging cutover. |
| U9 | P0 / approved logging-scope authority | A new shared logging package MUST NOT be introduced unless direct source evidence proves a lifecycle-neutral interface is unavoidable. | The design either stays within existing package/process owners or returns the exact source-backed boundary that makes a shared package unavoidable; convenience duplication alone is insufficient. |

## Non-goals and protected boundaries

- No replacement, reclassification, or schema rewrite of typed OTel health,
  metric, trace, framework, or Tool Portal telemetry.
- No new collector, exporter service, storage, persistence, queue, retry
  coordinator, logging lifecycle service, or cross-process logging authority.
- No change to stdout JSON/protocol lines, CLI result/help/error text,
  interactive progress/prompts, raw child-process relays, generated shell
  scripts, or test/fixture protocols.
- No logger configuration from a reusable library, lifecycle package, plugin,
  or helper that does not own the process root.
- No changes to the deprecated `openclaw-mcp-portal-plugin` package.
- No parser migration, parser compatibility layer, or unrelated dependency
  cleanup.
- No content capture: prompts, model responses, conversation history,
  reasoning, tool arguments/results, command text, file bodies, cookies,
  authorization headers, token values, private keys, or credentialed URLs.
- No promise that logs are lifecycle authority, durable state, health
  readiness, audit truth, or a replacement for typed event records.

## Constraints and unresolved hypotheses

These are implementation-facing constraints, not new product requirements:

- The current package graph separates executable roots from reusable gateway,
  contract, and plugin libraries. Dependency direction must stay within that
  graph.
- LogTape 2.3.0 provides `getLogger()` for libraries and one-time
  `configure()`/`configureSync()` plus disposable sinks for process roots. The
  exact placement of root setup and its relation to existing observability
  runtime configuration is a Program Design decision.
- The exact category suffixes, field allowlist, level thresholds, and sink
  formatter options are structural choices constrained by U1, U2, U4, U5, and
  U6; they are not additional user meaning.
- H1: Direct operational-output sites outside the already identified controller,
  gateway-runtime, and MCP server paths may be discovered during implementation.
  They must be classified against U5 before migration, not bulk-rewritten by
  text search.
- H2: A process may have no configured collector endpoint. The process-local
  stderr contract still applies; the OTLP sink must degrade without changing
  product behavior. The design must not invent a new deployment setting.
- H3: Existing tests may assert direct diagnostic text. Such assertions are
  evidence of a test seam, not authority to preserve an unstructured general
  diagnostic format when U1/U2 apply; protocol and user-facing assertions stay
  protected by U5.

## Requirements coverage handoff

| Stable identity | Outcome served | Protected boundary | Specification destination |
| --- | --- | --- | --- |
| U1 | O1 | U5, U6 | R1, R9 |
| U2 | O2 | U5, U6 | R2, R7, R9 |
| U3 | O3 | package ownership | R3, R8 |
| U4 | O4 | telemetry ownership | R4, R10 |
| U5 | O5 | stdout/protocol/user interaction | R5, R9 |
| U6 | O6 | privacy and security | R6, R7 |
| U7 | scope boundary | deprecated package | R8 |
| U8 | scope boundary | CLI parser ownership | R8 |
| U9 | scope boundary | package graph/lifecycle | R8, R11 |
