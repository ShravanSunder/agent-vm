# Socket.IO Control Protocol Semantics

Status: revised draft after fresh review
Date: 2026-07-01
Scope: shared controller-to-VM live control sessions for agent-vm gateway and
worker domains

## Product Intent

agent-vm needs one reusable live-control protocol for private controller-owned
communication with managed gateway VMs. The protocol must replace ad hoc raw
TCP controller callbacks while preserving clear authority boundaries, runtime
validation, failure classification, and backpressure behavior.

This spec defines the shared transport and message semantics. Domain specs such
as `gateway_control_rpc` and `worker_control_rpc` define their operation
vocabularies on top of this contract.

Success means future gateway and worker plans can answer these questions without
redesigning transport:

```text
which endpoint upgrades to a control session
which package owns schemas and TypeScript event maps
which fields identify and fence a session
which messages are replayable, coalesced, or forbidden
what happens under reconnect, stale generation, queue pressure, and timeout
```

## Boundary Map

```text
agent-vm controller
  owns:
    VM lifecycle, generation identity, operator/public HTTP API
    session readiness observation through Gondolin ingress
    private control-session initiation
    authority, state mutation, recovery, lease/task/fingerprint decisions
  uses:
    Socket.IO client for private control sessions
  exposes:
    public/operator Hono HTTP routes
  forbids:
    trusting gateway/worker control payloads as authority
    using raw controller.vm.host tcpHosts as the control path

      │ host -> guest HTTP/1.1 Upgrade through Gondolin ingress
      ▼

managed VM control service
  owns:
    private readiness endpoint
    Socket.IO server endpoint for one domain
    local runtime observations and command execution hooks
  exposes:
    domain readiness route
    transport-neutral control path for the domain control session
  forbids:
    public/browser/model access to the control endpoint
    controller authority mutation outside validated control messages

      │ strict Zod v4 messages over Socket.IO
      ▼

domain control contracts
  one control domain per managed VM kind or runtime domain
  gateway_control:
    Tool VM lease/use/runtime-status/cancel/recovery semantics
    Tool Portal controller_host_action transport for managed OpenClaw
  worker_control:
    Agent Worker git-tool/cancel/runtime observations for this cutover
  shared envelope:
    identity, fencing, message class, ack/result, replay, close reasons
```

## Transport Contract

The live control protocol uses Socket.IO over WebSocket-only transport through
Gondolin ingress.

Decision record:

```text
chosen
  Socket.IO over WebSocket-only transport, with transports: ["websocket"] and
  no polling fallback.

rejected for this cutover
  Raw JSON-over-WebSocket. It exposes lower-level buffer signals, but it would
  force agent-vm to reimplement reconnect, ack timeout, liveness, and retry
  semantics that Socket.IO already provides across TypeScript and Python.

conditions
  JSON Schema remains the cross-language wire contract, reconnect buffering is
  bounded or disabled for application messages, Engine.IO liveness is ordered
  against agent-vm liveness, and every inbound payload is validated by the
  domain schema before dispatch.
```

```text
controller
  -> vm.enableIngress() host endpoint
  -> HTTP/1.1 GET with Upgrade: websocket
  -> Gondolin route from /etc/gondolin/listeners
  -> VM-private control service
  -> 101 Switching Protocols
  -> opaque Socket.IO / Engine.IO frames
```

Gondolin is responsible for the HTTP upgrade tunnel. After the guest returns
`101 Switching Protocols`, Socket.IO frames are opaque bytes to Gondolin.
Gondolin does not need to understand Socket.IO framing.

The transport requirements are normative:

```text
Socket.IO only
  Both ends use Socket.IO. A native WebSocket client is not compatible with the
  Socket.IO server, and a Socket.IO client is not compatible with a raw
  WebSocket server.

WebSocket-only
  Socket.IO client and server are configured with transports: ["websocket"].
  Polling fallback is disabled. If runtime inspection reports "polling", the
  session is invalid.

VM-hosted control endpoint
  The VM-side gateway or worker control service hosts the Socket.IO server.
  The controller connects as a Socket.IO client after readiness succeeds.

Gondolin ingress path
  The controller reaches the endpoint through vm.enableIngress(). It must not
  use a guest-to-host raw tcpHosts mapping such as controller.vm.host:18800.

HTTP coexistence
  Hono or another runtime HTTP server may serve readiness and non-upgrade HTTP
  routes in the same VM process. Socket.IO attaches to the same server or its
  plugin upgrade hook for the private control endpoint. The route name is
  transport-neutral even though Engine.IO query parameters are still present.

No bulk tunneling
  The control Socket.IO session is not an SSH, file, log, artifact, provider, or
  observability stream.
```

The cutover private-control paths are normative across control domains. This
shared protocol spec does not choose each domain's VM-side placement; the
domain spec may narrow placement. For managed OpenClaw, the hard-cutover spec
narrows placement to the in-process OpenClaw plugin-hosted private route:

```text
gateway control readiness     GET /__agent-vm/ready
gateway control path          /__agent-vm/gateway-control

worker control readiness      GET /__agent-vm/worker-ready
worker control path           /__agent-vm/worker-control
```

Existing service probes remain separate:

```text
OpenClaw service readiness     GET /readyz
OpenClaw service liveness      GET /health
Worker service liveness        GET /health
Worker task HTTP routes        POST /tasks, GET /tasks/:taskId,
                               POST /tasks/:taskId/close
```

The `__agent-vm/*` paths are private control bootstrap and upgrade surfaces.
They do not replace existing service liveness/readiness probes and do not make
Worker task HTTP routes public outside their current controller-owned ingress
usage. Socket.IO's `path` option is set to the transport-neutral path. The
upgrade URL will still include Engine.IO query parameters such as
`EIO=4&transport=websocket`; credentials must never be placed in the query
string.

## Shared Package Contract

The wire protocol is defined by normative JSON Schema exported from the control
contract packages. Zod v4 schemas are the TypeScript runtime authority and are
the source used to derive those JSON Schemas in TypeScript packages. TypeScript
event maps are developer ergonomics, not runtime or cross-language truth.

```text
@agent-vm/control-protocol-contracts
  owns:
    shared envelope schemas
    identity and fencing schemas
    message class schemas
    result/error schemas (ControlRpcResultBaseSchema, ControlRpcErrorSchema)
    shared session-state schema (ControlSessionStateSchema)
    shared correlation/trace schema (ControlCorrelationSchema)
    hello/close schemas (ControlHelloSchema, ControlHelloResponseSchema,
      ControlCloseSchema)
    delivery policy enum
    close/disconnect reason schemas
    handshake credential/proof/upgrade-binding schemas, parameterized by a
      domain audience so gateway and worker share one handshake shape and
      cannot drift
    normative JSON Schema export
    fixture builders for contract tests only

@agent-vm/gateway-control-contracts
  depends on:
    @agent-vm/control-protocol-contracts
  owns:
    gateway_control_rpc operation schemas
    gateway Socket.IO event maps

@agent-vm/worker-control-contracts
  depends on:
    @agent-vm/control-protocol-contracts
  owns:
    worker_control_rpc operation schemas
    worker Socket.IO event maps
```

Runtime packages own Socket.IO construction, token delivery, reconnection,
queues, stores, reducers, logging, metrics, and command execution. Contract
packages must not import controller runtime, Gondolin adapter, OpenClaw runtime,
worker executor, filesystem execution helpers, or Socket.IO server/client
constructors unless the import is type-only for event-map typing.

`@agent-vm/gateway-interface` is not a control-protocol contract owner. It may
keep lifecycle, health, lease-adjacent, and VM-spec contracts that already
belong there, but shared Socket.IO control envelopes, domain operation unions,
and event-map types must live in the dedicated control contract packages above.

Non-TypeScript gateways must implement the same JSON Schema wire contract,
Socket.IO-over-WebSocket-only transport, handshake, sequencing, and delivery
rules. They may use their native Socket.IO implementation, but they do not get a
separate envelope or looser payload contract. Cross-runtime interop is pinned:
Socket.IO protocol v5 / Engine.IO v4 and the default JSON parser on both ends —
no unilateral switch to msgpack, which silently breaks a mismatched peer.
`protocolVersion` fences the major version; the parser choice is an
out-of-band deployment invariant.

The gateway control domain is generic: `gateway_control` owns the Tool-VM
lease/use, health, runtime-status, and recovery vocabulary shared by ANY managed
gateway. Runtime-specific detail (which plugin hosts the private route, which
model tools bind to which backends, how the runtime reports status) lives in the
runtime's own placement/adapter package — for OpenClaw, that is
`@agent-vm/openclaw-agent-vm-plugin` — NOT in the domain contract. A future
non-OpenClaw gateway that leases Tool VMs the same way reuses `gateway_control`
and supplies its own runtime binding; a gateway with a fundamentally different
operation set adds its own `KnownControlDomainSchema` domain + operation union in
a dedicated `*-control-contracts` package. Either way the shared envelope,
handshake shape, delivery, and backpressure rules are reused, never forked.

## Shared Envelope

Every control message is strict, versioned, discriminated, and parsed by Zod v4
on receive. Unknown fields fail closed.

Socket.IO event names are not the semantic API surface. They are a small
transport shim carrying Zod-discriminated messages:

```text
control:hello
  Used only for session establishment and resync negotiation. Validated by
  `ControlHelloSchema` / `ControlHelloResponseSchema`.

control:message
  Carries one `ControlEnvelopeSchema` plus a domain-specific payload. This is
  the normal command/command_result/event/snapshot path.

control:close
  Carries a typed close reason before intentional disconnect when possible.
  Validated by `ControlCloseSchema`.
```

There is exactly one transport acknowledgement surface: the Socket.IO callback
ack for the `control:message` emit. That callback is receipt/dispatch plumbing,
not a domain message, and it must not carry controller authority fields or
replace command lifecycle state. Semantic completion travels as
`kind: "command_result"` on the domain message. A separate `control:ack` socket
event and a `command_ack` control message kind do not exist.

Domain-specific operation names live inside the parsed envelope/payload, not in
unbounded Socket.IO event-name sprawl.

```ts
import { z } from "zod/v4";

export const ControlDomainSchema = z.string().regex(/^[a-z][a-z0-9_]*$/u);

export const KnownControlDomainSchema = z.enum([
  // generic managed-gateway control (Tool-VM lease/use, health, recovery);
  // OpenClaw is one runtime binding of this domain, hosted in its plugin.
  "gateway_control",
  "worker_control",
]);

export const ControlMessageKindSchema = z.enum([
  "command",
  "command_result",
  "event",
  "heartbeat",
  "observation",
]);

export const ControlDeliveryPolicySchema = z.enum([
  "latest_wins",
  "droppable",
  "acked_idempotent",
  "critical_idempotent",
  "append_only_observation",
  "single_use_critical",
  "forbidden_bulk",
]);

export const ControlEnvelopeSchema = z.object({
  bootId: z.string().min(1),
  commandId: z.string().uuid().optional(),
  connectionId: z.string().uuid(),
  controllerEpoch: z.string().min(1),
  createdAtMs: z.number().int().positive(),
  deliveryPolicy: ControlDeliveryPolicySchema,
  domain: ControlDomainSchema,
  expiresAtMs: z.number().int().positive().optional(),
  idempotencyKey: z.string().min(1).optional(),
  kind: ControlMessageKindSchema,
  messageId: z.string().uuid(),
  operation: z.string().min(1).optional(),
  peerId: z.string().min(1),
  protocolVersion: z.literal(1),
  sequence: z.number().int().nonnegative(),
  sessionId: z.string().uuid(),
  zoneId: z.string().min(1),
}).strict();
```

Every `ControlMessageKindSchema` value has exactly one home; no kind is
declared without an owning payload/handler. Resync is negotiated through
`control:hello`, so there is no `resync_request`/`resync_response` message
kind. Kind disposition:

```text
command / command_result
  RPC lifecycle (all domains). Carried on control:message.

event
  Domain events (state transitions, lifecycle notices). This includes
  latest_wins state snapshots such as health, runtime-status, capacity, and
  control-session liveness summary. `snapshot` is a delivery disposition, not a
  shared transport kind.

heartbeat
  Unsolicited app-liveness beat. First-class priority-lane message
  (Backpressure And Queue Policy), never routed through command lifecycle.
  Each domain defines its minimal heartbeat payload (or an empty payload).

observation
  append_only_observation records: discrete health events, control RPC
  operation rows, failed-attempt evidence. Must not coalesce.
```

The S1 enum-exactness proof asserts every kind above resolves to an owning
payload/handler branch in the shared or domain schemas; a declared-but-unmapped
kind fails the test.

Domain payload schemas do not re-declare identity, fencing, sequencing,
session, or delivery fields. Those fields live only in `ControlEnvelopeSchema`.
Domain payloads carry operation-specific strict payloads plus optional domain
correlation such as `requestId`, `toolCallId`, `runId`, or `sessionKeyDigest`.
Payloads must not carry controller-owned authority fields unless the domain
spec explicitly marks the field as a controller-to-VM command input.

The wire layering is:

```text
Socket.IO event name
  control:hello | control:message | control:close

ControlEnvelopeSchema
  shared identity, fencing, delivery policy, message kind, sequencing

domain payload
  gateway_control_rpc or worker_control_rpc operation schema
```

Domain specs must not replace `ControlEnvelopeSchema` with an unrelated wire
envelope or renamed identity twins. Fields such as `sessionId`,
`protocolVersion`, `createdAtMs`, `controllerEpoch`, `bootId`, `sequence`, and
`zoneId` appear once, in the shared envelope. If prose repeats them for
readability, runtime schemas must derive them from the shared envelope rather
than accepting duplicated wire fields.

`kind` and `operation` are the only fields that legally appear at both layers,
because domain discriminated unions need them locally. One vocabulary is
normative for both layers:

```text
kind vocabulary
  Domain message unions use the same `ControlMessageKindSchema` strings as the
  envelope. Commands are kind "command", results are kind "command_result",
  events are kind "event". Socket.IO callback acknowledgements are transport
  receipts and are not domain messages. Domain schemas must not introduce a
  second vocabulary such as request/response.

cross-layer equality
  The runtime rejects any message where envelope.kind !== domainMessage.kind or
  envelope.operation !== domainMessage.operation. Because both layers use the
  same enum strings, this is strict string equality, not a mapping.

union shape
  Every domain message union is a discriminated union on "kind" whose command
  branch is itself a discriminated union on "operation". Plain unvalidated
  z.union over message shapes is non-conforming.
```

The following shared schemas are owned by `@agent-vm/control-protocol-contracts`
and reused by every domain. Domains extend them; they do not redeclare them:

```ts
import { z } from "zod/v4";

export const ControlSessionStateSchema = z.enum([
  "unknown",
  "connecting",
  "ready",
  "reconnecting",
  "stale",
  "rejected",
  "generation_mismatch",
  "failed",
  "closed",
]);

export const ControlRpcResultBaseSchema = z.enum([
  "ok",
  "failed",
  "timeout",
  "rejected",
  "cancelled",
  "stale_generation",
]);
// Domains extend the base by value, e.g.
// z.enum([...ControlRpcResultBaseSchema.options, "approval_required"]).

export const ControlRpcErrorSchema = z.object({
  errorClass: z.string().min(1),
  retryable: z.boolean().optional(),
  safeMessage: z.string().min(1).optional(),
}).strict();

export const ControlCorrelationSchema = z.object({
  causationId: z.string().uuid().optional(),
  correlationId: z.string().min(1).optional(),
  requestId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  sessionKeyDigest: z.string().min(32).optional(),
  toolCallId: z.string().min(1).optional(),
  traceId: z.string().regex(/^[0-9a-f]{32}$/u).optional(),
}).strict();

export const ControlHelloSchema = z.object({
  bootId: z.string().min(1),
  controllerEpoch: z.string().min(1).optional(),
  domain: ControlDomainSchema,
  lastSeenControllerSequence: z.number().int().nonnegative().optional(),
  lastSeenPeerSequence: z.number().int().nonnegative().optional(),
  peerId: z.string().min(1),
  previousSessionId: z.string().uuid().optional(),
  protocolVersion: z.literal(1),
}).strict();

export const ControlHelloResponseSchema = z.object({
  connectionId: z.string().uuid(),
  controllerEpoch: z.string().min(1),
  fences: z.record(z.string(), z.string()).optional(),
  outcome: z.enum(["accepted", "rejected", "resync_required", "generation_mismatch"]),
  sessionId: z.string().uuid(),
}).strict();

export const ControlCloseSchema = z.object({
  reason: ControlSessionCloseReasonSchema,
  safeMessage: z.string().min(1).optional(),
  sessionId: z.string().uuid(),
}).strict();
```

Hello-response outcomes map to session states as follows: `accepted` enters
`ready`, `resync_required` stays `connecting` until resync completes,
`rejected` enters `rejected`, and `generation_mismatch` enters
`generation_mismatch`.

## Identity And Fencing

Identity vocabulary is shared:

```text
peerId
  Stable logical actor: gateway for a zone, worker runtime for a task, or a
  named replacement peer. Does not change on reconnect.

bootId
  VM process/runtime boot identity. Changes after VM restart or service restart
  that invalidates in-memory control state.

connectionId
  One Socket.IO connection identity. Changes on every reconnect.

sessionId
  Controller-accepted control session id. Binds connection, peer, boot,
  generation, and controller epoch.

controllerEpoch
  Controller runtime/fencing epoch. Messages from another epoch are stale unless
  the domain explicitly supports migration.

sequence
  Monotonic per sender, session, and domain. Used for gap/stale detection, not
  as a global total order across every entity. Receivers track last-seen
  sequence per sender and keep a bounded dedupe window.

commandId
  Controller-issued or accepted command lifecycle id.

idempotencyKey
  Stable dedupe key for retried side-effecting operations.
```

Domain specs add entity generation fields:

```text
gateway_control:
  gatewayRuntimeRecordId, gatewayVmId, generationId, leaseId, leaseGeneration,
  useId, activeOperationId

worker_control:
  workerRuntimeRecordId, workerVmId, taskId, taskGeneration, repoUrl,
  branchName, activeOperationId
```

Only fields present in `ControlEnvelopeSchema`, `ControlHelloSchema`, and the
shared handshake proof schema are common wire fields. Domain-specific runtime
record ids, VM ids, route ids, lease generations, task generations, repository
identity, and branch identity are issuance inputs, domain payload fields, or
controller-private reconciliation keys unless a domain contract explicitly adds
them to a strict payload schema.

Stale boot ids, stale generations, wrong controller epochs, duplicate
connection ids, or reused one-use credentials fail closed. A stale message may
be stored as diagnostic evidence only if it cannot mutate readiness, liveness,
lease/task state, approval state, credential custody, or recovery state.

## Correlation And Trace Propagation

Correlation identity originates at the call surface and flows upward through
every layer, so an operator can join an app-visible failure to the exact
control RPC row without reading code:

```text
call surface origin
  OpenClaw: runId, sessionKey (as sessionKeyDigest), toolCallId, requestId
  Worker:   taskId, runId
  Tracing:  traceId (W3C trace-id, 32 lowercase hex chars) when a trace exists

propagation rule
  Domain payload correlation (`ControlCorrelationSchema`) -> control RPC
  operation rows -> health events -> operator-visible evidence. A layer must
  not strip correlation fields that a lower layer supplied.

operator evidence
  traceId, runId, and sessionKeyDigest are allowlisted operator evidence
  alongside sessionId, requestId, messageId, toolCallId, leaseId, useId,
  generationId, elapsedMs, operation, result, and errorClass. Raw sessionKey
  is never propagated; only its digest is.
```

## Delivery Semantics

Socket.IO ordering and acknowledgement features are transport tools. agent-vm
delivery semantics are defined by this table and by domain schemas.

```text
class                    policy
───────────────────────  ───────────────────────────────────────────────────
latest_wins              Coalesce by domain key. Older values are discarded or
                         retained only as diagnostics. Use Socket.IO volatile
                         emission when the sender is not the authority.

droppable                May be lost under disconnect or pressure. Must not be
                         required for correctness or state mutation.

acked_idempotent         Requires acknowledgement with timeout. Retry is
                         allowed only with commandId/idempotencyKey and receiver
                         dedupe. Duplicate delivery returns the same terminal
                         result or a conflict without repeating side effects.

critical_idempotent      Same as acked_idempotent, plus durable or bounded
                         replay/resync rules defined by the domain. Used for
                         authority-changing operations that must survive a
                         transient connection failure.

append_only_observation  Preserves each observation record within bounded
                         storage and rate limits. Used when consecutive
                         failures, attempts, or elapsed timings are diagnostic
                         evidence and must not be coalesced away.

single_use_critical      Requires acknowledgement with timeout, but automatic
                         replay is forbidden unless the domain provides a
                         stable precondition and dedupe store. Stale delivery
                         must not extend liveness or perform a second mutation.

forbidden_bulk           Must not be sent on the control socket.
```

The shared default classification is:

```text
latest_wins
  health snapshot
  runtime status snapshot
  capacity snapshot
  control-session liveness summary

droppable
  progress tick
  transient debug counter

acked_idempotent
  command acceptance
  cancel operation by activeOperationId
  lease/use finish when keyed by generation + leaseId + useId
  task close if the worker domain returns the same terminal ack for duplicates

critical_idempotent
  lease/use start keyed by generation + leaseId + useId
  controller-issued recovery command with commandId and preconditions

append_only_observation
  discrete health event
  control RPC operation row
  failed attempt evidence used by recovery or incident analysis

single_use_critical
  lease create unless a stable idempotency key is present
  lease renew
  lease use heartbeat
  worker git push
  worker pull-default
  task submit unless requestTaskId + commandId dedupe is normative

forbidden_bulk
  Tool VM SSH stdout/stderr
  file bridge payloads
  bulk logs
  artifacts
  provider/channel passthrough traffic
  observability collector raw streams
  arbitrary shell/fs/provider execution bytes
```

The delivery class is a function of `(operation, payload)` per the
classification above, not a sender choice. On receive, the runtime derives the
expected class from the operation — including payload predicates such as the
`lease_create` idempotency-key rule that selects `critical_idempotent` vs
`single_use_critical` — and rejects, fail closed, any message whose envelope
`deliveryPolicy` does not equal the derived class. Envelope `deliveryPolicy` is
a declared expectation the receiver verifies, never trusted authority: a peer
cannot relabel a `single_use_critical` mutation as `latest_wins` to obtain
coalescing, nor a heartbeat as `critical_idempotent` to force replay. This
parallels the cross-layer `kind`/`operation` equality rule and is proven the
same way (S1 contract binds operation→class; S3 enforces at dispatch).

## Ack, Result, And Timeout Semantics

The protocol separates:

```text
transport send
  Local Socket.IO accepted the event for transmission.

ack
  Receiver parsed the envelope and payload, accepted ownership of the command
  lifecycle, or rejected it with a typed error.

result
  The operation finished, failed, timed out, was cancelled, or was rejected by a
  domain precondition.

state observed
  The controller reconciled the resulting lease/task/runtime/health state.
```

Every command defines:

```text
ack timeout
execution timeout
stale-generation behavior
disconnect behavior
retry/replay rule
dedupe key
terminal-result cache rule
```

Priority control messages are high-priority but not hair-trigger recovery
authority. A single missed priority ack is operator evidence and a failed send,
not a terminal stale transition by itself. The controller only marks the
session stale after the configured consecutive priority-ack failure threshold.
Successful priority acks reset that counter. Manual reconnect after an
accepted session uses bounded exponential backoff with jitter; it does not run a
fixed-delay unbounded reconnect loop across zones.

Runtime status evidence that gates Tool VM lease creation is bound to the
accepted control session that delivered it. A zone-wide runtime-status snapshot
may support operator display, but lease authority requires the snapshot's
bootId, controllerEpoch, peerId, sessionId, and connectionId to match the
caller context's accepted session. A status row from a previous boot/session is
stale even if it is younger than the wall-clock freshness window.

Timeout names must be specific:

```text
control-session-connect-timeout
control-ack-timeout
control-command-execution-timeout
control-resync-timeout
active-use-start-timeout-before-ssh
lease-use-heartbeat-timeout
worker-git-push-timeout
worker-pull-default-timeout
```

A generic `timeout` is not sufficient operator evidence.

Timing values are chosen during planning, but their ordering is normative:

```text
lease-use-heartbeat cadence
  strictly less than active-use TTL, with at least one missed heartbeat margin.

control-session-connect + control-ack budget
  strictly less than the active-use-start policy budget, so pre-SSH timeout
  classification is deterministic.

application ack and heartbeat timeouts
  ordered against Engine.IO pingInterval/pingTimeout, or Engine.IO ping is
  explicitly treated only as transport death while agent-vm owns liveness.

Socket.IO reconnect send buffer
  bounded or disabled for application messages. Stale buffered emits must not
  flush after resync as if they were fresh liveness or mutation messages.

maxHttpBufferSize and message byte caps
  derived from the largest legitimate control message, including a lease
  snapshot that carries Tool VM SSH `identityPem`, plus envelope overhead.

overflow
  detected and classified before memory pressure can make the process unsafe.
```

## Reconnect And Resync

Socket.IO connection recovery must not be the source of truth. Whether or not
Socket.IO recovery is enabled, every reconnect starts with an explicit
agent-vm hello/resync exchange.

The hello exchange is validated by `ControlHelloSchema` and
`ControlHelloResponseSchema` (defined in Shared Envelope above); the field
lists below are a readable restatement, not a second contract:

```text
hello includes:
  protocolVersion
  domain
  peerId
  bootId
  previousSessionId, when present
  lastSeenControllerSequence, when present
  lastSeenPeerSequence, when present
  controllerEpoch, when known

controller response includes:
  outcome: accepted | rejected | resync_required | generation_mismatch
  sessionId
  connectionId
  controllerEpoch
  current generation/task/lease fences for the domain
```

If `socket.recovered` is false, or if any required sequence/generation evidence
is missing, the domain must perform full resync before accepting liveness
mutations or controller-authorized operations.

## Backpressure And Queue Policy

Socket.IO does not remove the need for application-level flow control.

Normative rules:

```text
bounded queues
  Each session has message-count and byte-count caps. The plan must choose
  concrete values and prove overload behavior.

priority lanes
  Cancellation, close, stale-generation, resync, and liveness heartbeat
  control messages have priority over progress and latest snapshots. A
  latest_wins/droppable flood must starve snapshots, not heartbeats; if
  pressure still forces heartbeat loss, the session goes stale (fail-safe)
  rather than silently extending liveness.

coalescing
  latest_wins messages coalesce by explicit key. The queue stores the newest
  value only.

dropping
  droppable messages are discarded under pressure. They are never replayed.

critical commands
  critical_idempotent and single_use_critical messages use explicit ack timeout
  and command lifecycle tracking. Queue overflow closes or stales the session
  instead of silently extending lease/task liveness.

bulk ban
  forbidden_bulk messages are schema-invalid. If a peer attempts bulk transfer
  over the control socket, the receiver rejects the message and may close the
  session with a typed protocol violation.
```

`maxHttpBufferSize` and per-message limits are required guardrails, but they are
not sufficient backpressure proof.

`volatile.emit()` may be used only for `droppable` and `latest_wins` messages.
It must not carry append-only observations, liveness mutation, command request,
command result, or identity/handshake messages.

## Controller Resource Ceiling

The controller is a resilient, lightweight control and stream BROKER, never a
data plane. This is a hard invariant, not a tuning preference:

```text
bounded controller memory
  The controller's per-session and total memory stays bounded regardless of
  stream, event, or reconnect volume. Overflow closes or stales a session; it
  never grows unbounded. A days-long, high-volume session must not accumulate.

broker, do not buffer
  Heavy data never transits the controller heap or the control socket. The
  control plane authorizes and sets up streams; the bytes flow on separate
  host-terminated paths — Tool VM SSH raw TCP, the host-backed work mount, or a
  brokered direct duplex — and the controller steps out of the data path. Any
  future data-streaming capability MUST broker, not proxy-through-memory.

forbidden_bulk is the boundary
  Every `forbidden_bulk` class (SSH stdout/stderr, file bridge, bulk logs,
  artifacts, provider/channel passthrough, observability collector raw streams,
  arbitrary execution bytes) is schema-invalid on the control socket. This is
  what keeps the controller light.
```

Gateway-internal event durability (for example inbound Discord/queue events that
could be lost if a gateway's own queue fails) is a gateway-internal concern, not
a control-protocol guarantee. The control session guarantees resilient
control/observation continuity (grace, reconnect, resync, recreate-fencing); it
does not make a gateway's external-event intake durable.

## Close, Stale, And Reconnect Reasons

Every disconnect is classified. The receiver may store transport-level Socket.IO
details, but operator-visible state uses agent-vm reason codes.

```ts
import { z } from "zod/v4";

export const ControlSessionCloseReasonSchema = z.enum([
  "normal_shutdown",
  "controller_restart",
  "peer_restart",
  "auth_failed",
  "protocol_version_mismatch",
  "domain_mismatch",
  "generation_mismatch",
  "controller_epoch_mismatch",
  "duplicate_session",
  "stale_session",
  "sequence_gap",
  "ack_timeout",
  "command_timeout",
  "resync_timeout",
  "queue_overflow",
  "message_too_large",
  "schema_validation_failed",
  "forbidden_bulk_message",
  "transport_error",
]);
```

Normative handling:

```text
auth_failed, protocol_version_mismatch, domain_mismatch
  Reject the session. Do not resync.

generation_mismatch, controller_epoch_mismatch
  Mark the mismatched session stale. It cannot extend liveness or mutate
  lease/task state.

duplicate_session
  Reject the second presentation of a consumed credential. The incumbent
  authenticated session is not evicted by a replay or concurrent duplicate.
  Controller-initiated replacement uses a fresh nonce, credential, and session
  id and makes the old session stale only after the new session is accepted.

sequence_gap
  If the gap affects command, liveness, mutation, or controller-authorized
  control classes, mark the session stale before accepting later messages. If
  the gap affects only latest_wins/droppable observations, coalesce or drop.

ack_timeout, command_timeout
  Classify the active command. Do not use the timeout alone to infer transport
  death unless session liveness also fails.

resync_timeout
  Close the connection. The next connection must perform full hello/resync.

queue_overflow, message_too_large
  Preserve close/error/cancel where possible, then close or mark stale. Never
  keep a liveness mutation buffered past uncertainty.

schema_validation_failed, forbidden_bulk_message
  Reject the message. Close on repeated or security-sensitive violations.
```

Reconnect starts in `resync_required` unless the controller can prove the same
peer, boot, domain, generation, controller epoch, and sequence continuity. Even
when Socket.IO reports a recovered connection, agent-vm still performs the
hello/resync check before processing liveness or mutation messages.

## Security Contract

Assets:

```text
controller lease/task authority
VM generation identity
control-session credentials
Tool VM SSH access material
approval state
credential custody
operator diagnostics
model-visible tool inputs and outputs
```

Required behavior:

```text
strict Zod v4 parse at every receive boundary
unknown-field rejection
private route authentication
generation and controller-epoch fencing
no query-string bearer secrets
one-use VM-issued nonce plus controller signature where the domain uses
  boot-time controller public-key verification
VM-issued nonce plus controller signature for session authentication
VM-side atomic credential consumption
no public/browser/model access to control routes
no raw controller tcpHosts control path
no hidden controller fields in model-visible payloads
safe diagnostics only
```

Handshake trust root:

```text
controller public key in VM
  The VM control service has a controller public key or equivalent verifier
  provisioned at boot. It does not receive a reusable controller bearer secret.

VM-issued connect nonce
  The private readiness endpoint returns or exposes a short-lived connect nonce
  bound to domain, zone, peerId, bootId, controllerEpoch, protocol version, and
  generation. Route, runtime-record, and VM ids are controller-side issuance
  inputs that select the peer/generation being authorized; they are not separate
  shared handshake proof fields.

controller signature
  The controller signs domain, zoneId, peerId, bootId, controllerEpoch,
  generation, credentialId, nonce, issuedAtMs, expiresAtMs, and protocolVersion.

upgrade headers
  x-agent-vm-control-protocol: agent-vm.control.v1
  x-agent-vm-control-domain: <domain>
  x-agent-vm-control-credential-id: <uuid>
  x-agent-vm-control-signature: <signature>
  x-agent-vm-control-issued-at-ms: <integer>
  x-agent-vm-control-expires-at-ms: <integer>

invalid
  credentials in query strings, public gateway auth, browser cookies, model
  credentials, static boot bearer secrets, and duplicate nonce presentations.
```

The VM validates and atomically consumes the nonce/signature pair before the
Socket.IO handshake returns `101`. Failed attempts are rate-limited and do not
reveal which identity component failed.

## Non-Goals

This spec does not:

```text
define gateway_control_rpc operation payloads
define worker_control_rpc operation payloads
replace Tool VM SSH
tunnel logs, files, artifacts, SSH, provider traffic, or observability streams
make Hono RPC the bidirectional frame contract
make Socket.IO delivery semantics sufficient without agent-vm dedupe/resync
define implementation order or worker assignments
```

## Proof Expectations

Future plans must operationalize proof for:

```text
Gondolin ingress upgrade
  host/controller reaches VM-private Socket.IO server through vm.enableIngress(),
  receives 101 Switching Protocols, and observes Socket.IO transport
  "websocket".

transport configuration
  no polling transport, matching path, bounded message size, and runtime
  detection that rejects "polling".

schema proof
  every inbound and outbound payload has strict Zod v4 validation in
  TypeScript, exported JSON Schema as the cross-language wire contract, and
  malformed, unknown-field, wrong-domain, and forbidden_bulk messages fail
  closed. control:hello and control:close payloads validate against their
  shared schemas. envelope.kind/operation must strictly equal the domain
  message kind/operation; a mismatched pair fails closed.

correlation proof
  a correlation id set at the call surface (traceId, runId, sessionKeyDigest,
  toolCallId) survives into the control RPC operation row, the health event,
  and the operator-visible evidence for a failing operation.

delivery proof
  latest_wins coalesces, droppable drops, acked commands timeout, duplicate
  idempotent commands return terminal results, and single-use critical messages
  do not replay after stale reconnect.

fencing proof
  stale bootId, controllerEpoch, generation, session, and sequence fail closed.

backpressure proof
  bounded queues, coalescing, append-only observation preservation, priority
  cancellation/resync, overload close, timing-order invariants, and no
  unbounded Socket.IO reconnect buffering.

handshake proof
  VM-issued nonce, controller signature, header-only credential transport,
  duplicate nonce rejection without incumbent eviction, and rate-limited failed
  attempts.

domain separation proof
  gateway_control and worker_control use separate operation unions and
  cannot accidentally accept each other's payloads.
```
