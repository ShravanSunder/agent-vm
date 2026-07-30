# Hermes Framework OpenTelemetry

Date: 2026-07-29
Status: ready for implementation planning
Validated base: `93ad40964571317bcfb6bba4a5c6c8bbdb4c98b2`
Pinned Hermes: `hermes-agent==0.19.0`,
`3ef6bbd201263d354fd83ec55b3c306ded2eb72a`

## Product intent

Managed Hermes zones already export bounded Tool Portal operation telemetry
through Agent VM's in-process Python OpenTelemetry runtime. Operators cannot
currently observe Hermes-native turns, provider API attempts, retries, failures,
fallback transitions, token usage, or non-Tool-Portal tool calls.

This change extends the existing `agent-vm-hermes-adapter` runtime so a real
Hermes conversation produces safe framework traces, metrics, and logs through
the same mediated OTLP HTTP path used by the rest of Agent VM observability.

Success means an operator can inspect a Hermes turn, its provider attempts, and
its tool calls in Victoria, and can follow an admitted Tool Portal operation
into the common Gateway Runtime producer, without exporting prompts, responses,
tool arguments, tool results, raw errors, credentials, or user identity.

## Current implementation

The merged implementation already owns the producer and transport foundations:

- `agent-vm-hermes-adapter` pins the OpenTelemetry Python SDK and OTLP/HTTP
  exporters.
- The wheel exposes one Hermes plugin entry point named
  `agent-vm-tool-portal`.
- The bootstrap creates one process-owned Python telemetry runtime before the
  stock Hermes Gateway starts and shuts it down during bootstrap cleanup.
- The current producer creates trace, metric, and log providers and emits
  bounded telemetry for the four managed Tool Portal operations.
- The current plugin registers Tool Portal tools, a managed-profile admission
  hook, and a `post_tool_call` observer restricted to those Tool Portal tool
  names.
- `hermes-lifecycle.ts` projects the collector endpoint, fixed
  `agent-vm-hermes` service identity, exporter batching limits, metric interval,
  and trace sampling configuration into the Hermes service environment.
- Gondolin mediates OTLP HTTP requests to the host collector. The synthetic
  collector destination is not a raw `tcpHosts` route and does not expose the
  host collector directly to the VM.
- The common Gateway Runtime Tool Portal producer remains a separate
  `agent-vm-tool-portal` service. Its trace context can already receive the
  framework-side Tool Portal operation context.

The missing behavior is Hermes-native hook observation. For Hermes, the existing
`zones[].observability.services.framework.{traces,metrics,logs}` settings are
currently dead configuration: `hermes-lifecycle.ts` does not project them and
the Python producer creates all three signal providers whenever an endpoint and
service name exist. This change adds the three lifecycle projections and makes
the producer honor them.

## Goals

1. Observe Hermes turns, provider API attempts and failures, and every tool
   execution surfaced by pinned Hermes `post_tool_call` through the existing
   adapter process.
2. Preserve the existing mediated OTLP HTTP route to the host collector and
   Victoria.
3. Preserve trace correlation from a Hermes Tool Portal call into the common
   Gateway Runtime Tool Portal producer.
4. Make the existing framework signal booleans control actual exporter
   creation and network emission.
5. Emit only bounded, allowlisted operational metadata.
6. Keep telemetry failure isolated from Hermes conversations, tools, Gateway
   readiness, and Tool Portal operation.

## Non-goals

- No new process, service, collector, supervisor, coordinator, or runtime
  lifecycle.
- No second Python distribution or external plugin repository.
- No runtime installation through `hermes plugins install`.
- No copy of the external `hermes-otel` implementation.
- No upstream Hermes or Gondolin changes.
- No new durable configuration, state, migration, compatibility path, or
  recovery system.
- No new `HERMES_HOME`, RealFS, profile `.env`, or secret behavior.
- No direct collector `tcpHosts`, raw collector socket, or network bypass.
- No dashboard, alerting, vendor fan-out, ambient discovery, or root-logger
  capture.
- No prompt, response, conversation-history, reasoning, system-prompt,
  request-body, response-body, tool-argument, tool-result, terminal command,
  filesystem target, sender, profile, or raw error capture.
- No configurable content-capture mode in this change.
- No change to the public zone observability schema beyond making its existing
  signal settings effective for Hermes.

## Design decisions

### Keep the existing plugin entry point

The wheel continues to expose only `agent-vm-tool-portal`. The plugin already
owns the process-local binding between stock Hermes and the bootstrap-owned
Agent VM adapter runtime. It will register the additional framework
observability hooks.

This avoids a second `plugins.enabled` requirement, plugin discovery path,
configuration authority, or lifecycle. The narrow historical entry-point name
does not justify a release-wide rename in this change.

Internally, capability translation and observability remain separate
responsibilities:

```text
agent-vm-tool-portal Hermes plugin entry point
  |
  +-- managed profile admission
  |
  +-- managed Tool Portal capability registration
  |
  `-- managed Hermes framework observability registration
```

The entry point composes these responsibilities; the Tool Portal capability
module does not become the owner of turn and provider telemetry logic.

### Reuse one process-owned telemetry runtime

The bootstrap creates one telemetry runtime and supplies it to the installed
plugin before the stock Hermes Gateway starts. The runtime owns enabled OTel
providers, bounded in-flight correlation state, flush, and shutdown.

It must not install a global Python logging handler or broadly
auto-instrument libraries. Hermes events enter the runtime only through the
explicit registered hooks and existing Tool Portal operation boundary.

### Preserve the mediated exporter path

```text
Hermes hooks and Tool Portal adapter
              |
              v
  process-owned Python OTel providers
              |
              | OTLP/HTTP protobuf
              v
http://otel-collector.observability.vm.host:4318
              |
              | Gondolin onRequest short-circuit mediation
              v
       host OTel Collector
              |
              v
 VictoriaLogs / VictoriaMetrics / VictoriaTraces
```

The lifecycle supplies the synthetic endpoint. Agent VM's Gateway request hook
accepts only the fixed OTLP HTTP paths and forwards them to the configured
loopback collector with a fixed method, content type, destination, path set, and
request deadline. The mediator does not enforce a body-size limit; the producer
therefore applies the existing `maxRecordBytes` admission limit before export.

Hermes does not receive the collector's real host address. The design adds
neither raw `tcpHosts` collector mappings nor a direct host-network route.

### Honor each configured signal independently

The lifecycle projects the existing framework signal policy into the service
environment using standard exporter-selection variables:

```text
OTEL_TRACES_EXPORTER=otlp|none
OTEL_METRICS_EXPORTER=otlp|none
OTEL_LOGS_EXPORTER=otlp|none
AGENT_VM_HERMES_OTEL_MAX_RECORD_BYTES=<framework maxRecordBytes>
AGENT_VM_HERMES_OTEL_MAX_INFLIGHT_OBSERVATIONS=<framework maxQueuedRecordsPerSignal>
```

The adapter's explicitly constructed providers must interpret these values:

- `otlp` creates the matching provider and OTLP/HTTP exporter.
- `none` does not create that signal provider or exporter.
- an absent value, a comma-separated value, or any value other than the exact
  strings `otlp` and `none` fails bootstrap preflight with a safe configuration
  error.
- when all three values are `none`, the telemetry runtime is a no-op and emits
  no OTLP traffic.

The existing endpoint, service name, batching, flush, metric interval, and trace
sampling variables remain authoritative. `OTEL_SDK_DISABLED` is rejected
because it would silently override the explicit signal policy.

The two `AGENT_VM_HERMES_OTEL_*` variables are adapter-private transport for
existing `zone.observability.framework.admissionLimits`; they are not new
deployment-authored settings. `hermes-lifecycle.ts` projects them from the same
frozen limits used by the common Gateway telemetry contract. The Python runtime
requires non-negative base-10 integers, enforces `maxRecordBytes` before export,
and uses `maxQueuedRecordsPerSignal` as the cap for each in-flight correlation
map. Invalid or absent values fail bootstrap preflight.

The controller remains the sole author of `OTEL_RESOURCE_ATTRIBUTES`. The
lifecycle preserves that controller-authored value while rejecting
deployment-secret attempts to provide protected OTel settings. The producer
does not ingest ambient resource detectors wholesale; it emits only:

- `service.name`;
- `telemetry.sdk.language`, `telemetry.sdk.name`, and
  `telemetry.sdk.version`;
- `dev.release.channel`, `dev.repo.hash`, `dev.runtime.flavor`, and
  `dev.worktree.hash` from the controller-authored resource value.

Unknown, malformed, or duplicate resource keys are omitted. No other
environment-derived resource attribute is admitted.

### Use pinned Hermes observer hooks

The plugin registers only the hooks needed for this contract:

```text
pre_llm_call       -> open one turn observation
post_llm_call      -> complete a successful turn observation
pre_api_request    -> open one provider-attempt observation
post_api_request   -> complete a successful provider attempt and record usage
api_request_error  -> complete a failed provider attempt
post_tool_call     -> emit one observation for each event Hermes supplies
on_session_end     -> close incomplete observations for the matching turn
```

The pinned Hermes call sites establish:

- `pre_llm_call` and `post_llm_call` occur once around a completed turn.
- `pre_api_request`, `post_api_request`, and `api_request_error` occur per
  provider API attempt.
- `post_tool_call` supplies the authoritative per-tool `duration_ms` and status,
  including blocked calls that never execute.
- stable turn and API-request identifiers are available for in-process
  correlation.

Hook correlation identifiers may be used only as in-memory map keys and OTel
parent-context lookup keys. They are not exported as attributes.

`pre_tool_call` is deliberately not used for telemetry. Pinned Hermes fires the
batch's pre-hooks on the coordinator thread before worker submission, while the
tool body and `post_tool_call` run on worker threads. A span opened there would
not bracket execution and an attached context could contaminate concurrent
workers. Tool observations are therefore constructed from `post_tool_call`
alone, using its supplied duration rather than pre-to-post wall time.
Pinned Hermes does not emit `post_tool_call` for an invocation skipped by
preflight interruption or rejected because its argument payload is malformed.
Those non-executions are outside the framework telemetry contract; Agent VM
does not add a second interception path or upstream hook to synthesize them.

`post_llm_call` is not guaranteed for an interrupted or failed turn.
Pinned `on_session_end` fires at the end of each `run_conversation` call, not
only when a long-lived session expires. It closes only observations whose
`turn_id` matches that hook. A hook without `turn_id` never triggers global or
session-wide closure. Telemetry shutdown closes any remaining observations
without inventing a successful result.

Every telemetry callback returns `None`. In particular, `pre_llm_call` and
other behavior-capable Hermes hooks are used in observe-only mode; telemetry
must never inject model context, approve, block, or transform product behavior.

### Emit a small framework vocabulary

The framework service name remains `agent-vm-hermes`.

Traces:

```text
hermes.turn
  |-- hermes.llm.request
  `-- hermes.tool.call

hermes.tool_portal.operation
  `-- common Gateway Runtime Tool Portal spans
```

Framework child spans use an explicit parent context looked up by `turn_id`;
the adapter does not keep an OTel context attached across hook boundaries.
The existing `hermes.tool_portal.operation` trace remains independent because
the pinned Tool Portal handler receives neither `turn_id` nor `tool_call_id`,
and Agent VM does not depend on private Hermes ContextVars to recover them. The
Tool Portal operation remains the explicit parent of the common Gateway Runtime
Tool Portal spans. This deliberately preserves the current stable correlation
seam instead of inventing a cross-thread bridge. When traces are disabled,
neither framework nor Tool Portal trace providers or propagation contexts are
created; logs and metrics retain their independent settings.

Logs:

```text
hermes.turn.completed
hermes.llm.request.completed
hermes.llm.request.failed
hermes.tool.call.completed
```

Metrics:

```text
hermes.turns_total
hermes.turn.duration
hermes.llm.requests_total
hermes.llm.request.duration
hermes.llm.input_tokens
hermes.llm.output_tokens
hermes.tool.calls_total
hermes.tool.call.duration
```

Metric units follow the adapter's existing local convention: milliseconds for
durations and integer counts for events and tokens. This intentionally retains
the established `hermes.*` vocabulary instead of adopting the OTel GenAI
semantic conventions in this change. It keeps span names fixed and avoids
model-derived span names while preserving query compatibility with the existing
producer.

### Admit only schema-owned attributes

Allowed attributes are built field by field. No hook payload, exception, model
object, response object, request object, arguments mapping, or result mapping is
serialized wholesale.

The emitted attribute schema is closed:

| Record | Attribute | Admitted value |
| --- | --- | --- |
| all | `agent_vm.operation.category` | fixed record-specific value |
| all | `agent_vm.operation.name` | fixed record-specific value |
| all | `agent_vm.result.class` | fixed enum; unknown values become `unknown` |
| turn | `hermes.platform.class` | lowercase token matching `[a-z0-9_]{1,64}`; otherwise `unknown` |
| provider attempt | `hermes.model` | string, at most 256 Unicode code points |
| provider attempt | `hermes.provider` | string, at most 128 Unicode code points |
| provider attempt | `hermes.api.mode` | `chat_completions`, `codex_responses`, `anthropic_messages`, `bedrock_converse`, `codex_app_server`, or `unknown` |
| provider attempt | `hermes.api.call_count` | integer from 0 through 2,147,483,647 |
| provider attempt | `hermes.finish_reason.class` | lowercase token matching `[a-z0-9_]{1,64}`; otherwise `unknown` |
| failed provider attempt | `hermes.failover.reason` | member of pinned Hermes `FailoverReason`; otherwise `unknown` |
| failed provider attempt | `http.response.status_class` | `1xx`, `2xx`, `3xx`, `4xx`, `5xx`, or omitted |
| provider attempt | `hermes.retryable` | boolean |
| provider attempt | `hermes.retry.count` | integer from 0 through 2,147,483,647 |
| provider attempt | `hermes.usage.input_tokens` | integer from 0 through 2,147,483,647 |
| provider attempt | `hermes.usage.output_tokens` | integer from 0 through 2,147,483,647 |
| tool | `hermes.tool.name` | string, at most 128 Unicode code points |
| tool | `hermes.tool.category` | `tool_portal`, `hermes_tool`, or `unknown` |

Result classes are closed per record:

- turn: `success`, `failure`, `interrupted`, `abandoned`, or `unknown`;
- provider attempt: `success`, `failure`, or `unknown`;
- tool: `success`, `failure`, `blocked`, `cancelled`, `timeout`, or `unknown`.

Durations are metric values and span timing, not attributes. They are finite
milliseconds from 0 through 86,400,000. The producer uses the pinned
hook-supplied duration where available; it never recomputes tool duration from
the interval between hooks. A successful `post_api_request` does not contain an
HTTP status code, so `http.response.status_class` is omitted rather than
inventing `2xx`.

Metric labels are limited to `agent_vm.operation.category`,
`agent_vm.operation.name`, `agent_vm.result.class`,
`hermes.platform.class`, `hermes.provider`, `hermes.api.mode`,
`hermes.failover.reason`, and `hermes.tool.category` where applicable. Model
identifiers, tool names, token counts, retry counts, and status classes remain
span/log attributes or metric values and do not become metric labels.

Unknown or malformed values are omitted when the schema says “omitted” and
otherwise map to the fixed `unknown` classification. Telemetry code must not
call `str()` on arbitrary hook objects as a fallback.

The following values are explicitly forbidden in attributes, span events, log
bodies, metric labels, OTel baggage, and resource attributes:

- `user_message`, `assistant_response`, `conversation_history`,
  `request_messages`, request or response objects;
- tool `args`, tool `result`, terminal commands, paths, URLs, headers, or
  targets;
- `sender_id`, profile name, session id, task id, turn id, API request id, or
  tool-call id;
- exception messages, raw error messages, stack traces, provider response
  bodies, or credential-bearing status details;
- environment variables, secret placeholders, resolved secrets, and 1Password
  references.

Log bodies are fixed event names. They never contain hook-provided text.

### Represent retries and fallbacks without a new state machine

Each provider attempt records its provider, model, API call count, result,
bounded failover reason, and retry metadata. Operators can see a fallback as a
later attempt within the same turn using a different provider or model.

The adapter does not add a separate fallback coordinator or duplicate Hermes's
fallback policy. It observes the attempts Hermes actually makes.

### Bound correlation state and fail open

The runtime may retain only active turn and API-request observation records.
Each map is capped at the existing
`maxQueuedRecordsPerSignal` admission limit. When a map is full, the runtime
drops the new observation; it does not evict another active turn, start a timer,
or add a second queue. Entries are removed on their matching completion/error
hook, on the matching turn's `on_session_end`, or at telemetry shutdown.

Duplicate, missing, or out-of-order hooks must not affect Hermes behavior. The
runtime records a fixed internal telemetry classification when safe and drops
the unmatched observation.

Invalid controller-authored exporter selections fail bootstrap preflight.
After valid configuration passes preflight, provider/exporter construction is
per-signal and fail-open: failure to construct one enabled signal disables that
signal, records only a fixed safe diagnostic through the existing bootstrap
logger, and does not disable other successfully constructed signals or fail the
Hermes Gateway. Hook processing, export, flush, and shutdown failures are also
isolated from product behavior. Export pressure must not block a conversation
or Tool Portal call. Existing bounded OTel batch queues remain the only exporter
queue; this change adds no retry queue or durable telemetry spool.

## Spec boundary and separability map

```text
packages/hermes-gateway
  owns:
    - lifecycle projection of existing framework signal policy
    - projection of existing framework telemetry admission limits
    - fixed service identity and mediated collector endpoint
    - reservation of protected OTel settings
    - preservation of controller-authored development resource identity
  exposes:
    - managed framework service environment

                         environment contract
                                  |
                                  v

agent-vm-hermes-adapter bootstrap
  owns:
    - one process-owned telemetry runtime
    - runtime creation before stock Hermes starts
    - flush and shutdown with bootstrap cleanup
  exposes:
    - telemetry runtime to the installed plugin

                         runtime interface
                                  |
                                  v

existing agent-vm-tool-portal plugin entry point
  owns:
    - Hermes hook registration
    - profile admission and capability registration composition
  delegates:
    - Tool Portal behavior to the capability module
    - framework events to the observability module

                         bounded OTel records
                                  |
                                  v

Gondolin request mediation
  owns:
    - fixed OTLP path admission
    - loopback collector forwarding
    - request deadline and fixed method/content-type admission
  exposes:
    - no direct host collector network authority to Hermes
```

No layer changes Hermes durable configuration, profile secret materialization,
Gateway lifecycle ownership, collector ownership, or Victoria storage
ownership.

## Security and privacy threat model

### Sensitive inputs

Hermes observer hooks can carry prompts, responses, conversation history,
provider request/response objects, tool arguments/results, commands, paths,
sender identifiers, raw errors, and correlation identifiers. Any of these may
contain secrets or private user content.

### Trust boundaries

- Hermes and the adapter are trusted code inside the Gateway VM.
- Hook payloads are sensitive inputs even though they originate inside the
  trusted process.
- The OTel source mapper is the primary non-emission boundary.
- Gondolin mediation controls destination and transport; it does not make an
  unsafe telemetry payload safe.
- The host collector and private Victoria stack are trusted operator
  infrastructure, but collector scrubbing remains defense in depth.

### Required defenses

1. Construct every record from an explicit attribute allowlist.
2. Use fixed log bodies and span names.
3. Never serialize complete hook payloads or arbitrary objects.
4. Never attach OTel baggage from Hermes or incoming requests.
5. Bound every admitted string and integer.
6. Enforce `maxRecordBytes` before records enter an exporter queue.
7. Keep raw correlation identifiers in memory only.
8. Admit only the closed resource-attribute schema.
9. Prove forbidden canaries are absent from encoded OTLP and stored Victoria
   data.
10. Preserve HTTP mediation and reject any raw collector `tcpHosts` override.
11. Keep runtime telemetry failure fail-open for product behavior.

## Requirements

R1. A managed Hermes zone with framework observability enabled uses the existing
`agent-vm-hermes-adapter` wheel, process, bootstrap, and plugin entry point.

R2. No new process, plugin distribution, collector, direct network route,
durable config, state directory, or secret path is introduced.

R3. The existing
`zones[].observability.services.framework.{traces,metrics,logs}` settings
independently control Hermes provider/exporter creation and OTLP traffic.

R4. A real Hermes turn emits a bounded turn observation.

R5. Every actual Hermes provider API attempt emits a bounded success or failure
observation with timing, retry metadata when supplied, and token usage when
supplied.

R6. Every pinned Hermes `post_tool_call` event emits one bounded tool
observation without arguments, results, commands, paths, targets, or raw
errors. Preflight-interrupted and malformed invocations that pinned Hermes does
not expose through that hook are not synthesized.

R7. When traces are enabled, each admitted Tool Portal operation remains the
parent of its common Gateway Runtime Tool Portal spans. Framework turn/tool
traces remain independent; no private Hermes correlation seam is introduced.

R8. Provider/model changes across attempts are observable without the adapter
owning or reproducing Hermes fallback policy.

R9. Prompts, responses, conversation history, reasoning, tool content, user and
profile identity, raw correlation identifiers, secrets, environment values,
headers, URLs, raw errors, and stacks never enter emitted telemetry.

R10. Concurrent profiles and turns cannot acquire each other's parent context,
attributes, or in-flight observation state.

R11. Missing, duplicate, failed, interrupted, or out-of-order hooks do not
change Hermes behavior; active turn and provider-attempt maps remain capped and
perform no timer-driven cleanup or eviction.

R12. Invalid signal configuration fails preflight, while per-signal
provider/exporter construction, hook, export, flush, and shutdown failures do
not fail the Hermes Gateway, a conversation, or a Tool Portal call.

R13. OTLP remains HTTP-mediated through the fixed synthetic collector endpoint;
Hermes receives no direct collector address or raw collector socket mapping.

R14. The implementation uses the exact pinned Hermes 0.19.0 hook contracts.
Tests assert every registered name exists in `hermes_cli.plugins.VALID_HOOKS`
and `hermes_cli.middleware.OBSERVER_SCHEMA_VERSION` remains
`hermes.observer.v1`; a future hook rename or schema-version change fails the
package gate.

## Proof expectations

The implementation plan must map every requirement to proof. At minimum:

- Python unit proof covers exact `otlp`/`none` signal combinations; absent,
  comma-separated, unknown, and `OTEL_SDK_DISABLED` rejection; per-signal
  constructor failure; the closed record and resource allowlists;
  `maxRecordBytes`; numeric and string bounds; malformed hook values;
  success/error/interruption closure; capped correlation state; shutdown; and
  fail-open behavior.
- Plugin unit proof exercises the exact registered hook set and passes
  secret-bearing canaries through every content-bearing hook field, proving none
  reach the telemetry runtime's emitted records. It also asserts every callback
  returns `None`.
- TypeScript unit proof covers lifecycle projection of all three standard
  exporter-selection variables, their true and false cases, protected OTel
  settings, both adapter-private admission-limit variables sourced from
  `zone.observability.framework.admissionLimits`, and the controller-authored
  resource attribute path with exhaustive assertions.
- Package proof inspects the built wheel and confirms the single existing
  `hermes_agent.plugins` entry point plus the pinned OTel dependencies.
- Integration proof runs the installed plugin through the pinned Hermes hook
  manager rather than calling only private helper functions. It asserts the
  registered names are members of `VALID_HOOKS`, pins
  `OBSERVER_SCHEMA_VERSION`, and exercises concurrent Tool Portal calls through
  the pinned worker-thread dispatch shape.
- Real Hermes VM proof executes a turn with more than one provider attempt and
  at least one non-Tool-Portal and one Tool Portal tool call, then observes OTLP
  traces, metrics, and logs through Gondolin mediation.
- Signal-negative proof disables each signal independently and verifies the
  corresponding OTLP path receives no request while enabled signals continue.
- Storage proof queries Victoria for fresh `service.name=agent-vm-hermes`
  records and follows an admitted `hermes.tool_portal.operation` into
  `agent-vm-tool-portal`.
- Canary proof verifies forbidden prompt, response, argument, result, command,
  path, raw-error, identity, secret, and unapproved resource values are absent
  from encoded OTLP and Victoria storage while the approved controller
  development identity keys remain present.
- Existing Hermes Gateway, profile-secret, Tool Portal, HTTP-mediation, and
  common observability proof lanes remain green.

Inventory-only or skipped E2E results do not prove this feature.

## Alternatives considered

### Install `briancaffey/hermes-otel`

Rejected. It includes useful prior art, but it also carries independent plugin
packaging, broad configuration, content-capture options, dashboards, vendor
backends, logging integration, and other behavior outside Agent VM's existing
producer and privacy contracts.

### Add a second Hermes plugin entry point

Rejected for this change. It would add a second discovery and
`plugins.enabled` contract while sharing the same process and producer anyway.
Internal module separation provides the ownership benefit without the public
configuration cost.

### Rename the existing plugin

Deferred. A hard rename would change deployment-authored Hermes plugin policy
without improving runtime behavior. The current entry point remains the
composition boundary.

### Export raw commands or tool targets

Rejected for this change. They can contain inline credentials, private paths,
or user content and conflict with the existing `captureContent: false` source
policy. A future explicit content-capture contract may revisit them.

### Direct collector networking

Rejected. It would weaken the existing Gondolin mediation boundary and expose a
host destination that Hermes does not need.

## Planning boundary

The implementation plan may choose internal class, protocol, and file names
consistent with the current Python package. It must not:

- create another plugin entry point or distribution;
- change public deployment configuration beyond the existing signal settings;
- add lifecycle, persistence, migration, recovery, or compatibility systems;
- expand the admitted telemetry fields;
- weaken mediation or proof gates;
- update upstream Hermes or Gondolin.

If exact pinned hook behavior prevents the trace and cleanup contract from
landing inside the existing plugin/runtime boundary, that is a mental-model
break. Planning or implementation must stop and return with the conflicting
source evidence before introducing a new seam.

## Open decisions

None. Raw command, target, and content capture are explicitly outside this
change.
