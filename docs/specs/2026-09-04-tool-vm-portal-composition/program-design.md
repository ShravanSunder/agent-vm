# Tool VM Portal composition program design

[Requirements](requirements.md) · [Specification](specification.md)

## The connection, end to end

The reusable Python SDK owns a trusted-side execution bridge. Hermes supplies
the originating invocation and approval presenter; it does not own the SDK.
The bridge uses Gateway Runtime's existing managed process/stream APIs to start
a small relay in Tool VM. Guest SDKs connect to that relay's local socket.
Requests travel back over the existing SSH process stdout; responses travel
over its stdin. No reverse TCP forwarding, public listener, provider-specific
wrapper, or new controller routing API is needed. Cancellation of an admitted
configured CLI does require completing the existing control channel's
operation-cancellation contract; that is separate from Portal request routing.

```text
GATEWAY VM                                  TOOL VM: composition origin

Hermes tool_execution middleware             stock execute_code program
  owns exact invocation context               │
  │                                           ├─ Python SDK
  ▼                                           ├─ TypeScript SDK
SDK execution bridge                          └─ tool-portal CLI
  owns request tasks and approval callbacks            │
  │                                                   ▼
  │      existing managed process/stream API     guest-local UDS
  ├────────────────────────────────────────────► relay helper
  │              Gateway Runtime + pinned SSH    │
  │◄──────── request frames on process stdout ────┘
  ├───────── result frames on process stdin ─────► SDK caller
  │
  ▼
existing managed Portal client ──► Tool Portal capability core
                                      ├─ MCP provider
                                      └─ configured CLI destination
                                         host / credentialed VM / Tool VM*

* Tool VM configured-CLI destination depends on PR A's landed target.
  The composition program never moves to any destination above.
```

The two directions share the existing Gateway-to-Tool-VM SSH connection but use
a separate managed process channel from the composition program. Neither
program stdout nor Hermes's `hermes_tools` file RPC carries Portal protocol
frames. This prevents ordinary printed text from becoming a tool request.

## What exists and what changes

Source baseline is Agent VM `b4647ae2`; Hermes is pinned to 0.20.6,
`5fc308a70719a83cccdbba4c0e39c23f5a8239d5`.

| Edge | Current source / behavior | Target delta |
| --- | --- | --- |
| Hermes invokes execute_code | Pinned `agent/tool_executor.py:737–767` supplies invocation metadata to `tool_execution` middleware | Added adapter middleware captures one immutable scope and calls the stock continuation exactly once |
| Stock remote execution reaches Tool VM | Pinned `tools/code_execution_tool.py:1078–1214`; adapter `managed_gateway_runtime_environment.py:467` | Intentionally unchanged execution/whole-script approval; command launch additionally receives scoped guest connection environment |
| Guest code calls Portal SDK | Existing SDKs require manually supplied HTTP/stdio transport; no managed guest endpoint | Added local transport in existing SDKs and CLI, backed by the guest relay |
| Bridge starts relay | No predecessor | Added SDK bridge uses lower-level `sandbox.process`/`sandbox.stream`, not blocking BaseEnvironment command execution |
| Requests cross VM boundary | Strict SSH `openProcessChannel` already exposes stdout/stderr callbacks and repeated stdin writes | Reused process transport with explicit auxiliary relay I/O profile; ordinary process limits unchanged |
| Trusted caller reaches Portal | Existing Python GatewayRuntimeClient supplies protected context; operation identity uses caller item ID | Bridge supplies frozen context and invocation-qualified item IDs; caller-visible result IDs are restored, backend arguments unchanged |
| Portal approval | Existing `gateway_approval_bridge.py:126–220` calls presenter/decision/exact retry | Intentionally unchanged authority and algorithm; callbacks close over originating conversation |
| Cancellation reaches Portal | UDS server has AbortSignal, private projection drops it (`gateway-runtime-private-uds-dispatcher.ts:161–192`) | Carry signal through existing managed Portal invocation/projection into capability core |
| Cancellation reaches an admitted controller CLI | `controller-execution-gateway-control-adapter.ts:690–713` waits for the result without forwarding cancellation; gateway-origin cancel is refused by admission classification | Add operation-scoped cancellation on the existing control channel, with controller-owned admission/lifetime state and existing executor signals |
| Discovery and backend effects | Existing capability core, backends, controller approval and artifact ownership | Intentionally unchanged; relay is a caller adapter, not another Portal service |

The Python UDS write lock is released before waiting for a response
(`gateway_runtime_uds_transport.py:191–222`). Concurrent stream reads, Portal
calls, and approval decisions can share the existing admitted connection.
No second managed-plugin handshake or attachment is introduced.

## Why this transport

| Alternative | Useful foundation | Reason not selected |
| --- | --- | --- |
| Extend Hermes file RPC | Existing return path and context propagation | Hard-coded nested tools, synchronous polling, and Hermes-generated helper cannot be the generic SDK's authority/transport owner |
| Expose Gateway managed UDS | All operations already exist | Exposes multi-agent trustedContext, approval decisions, and sandbox RPC to untrusted guest code |
| Reuse standalone MCP HTTP server unchanged | Existing MCP schemas and transports | Standalone identity/HMAC approval differ from managed controller authority |
| Reverse SSH TCP forwarding | ssh2 supports it | Pinned Gondolin 0.12.0 starts sshd with `AllowTcpForwarding=no`; would require unrelated provider behavior change |
| Intercept outbound HTTP in controller | Existing mediation hook can return a Response | Requires new controller-to-Gateway Portal routing and session translation |
| SDK bridge over ordinary SSH process streams | Existing full-duplex transport, managed authority, and framework-neutral approval helper | Selected; pays for a bounded relay and invocation lifecycle, without a new network/control service |

The cost belongs to SDK/runtime maintainers: one small relay protocol must be
versioned and tested in both languages. A future requirement for detached,
long-lived external clients would reopen this choice. It is not a reason to
introduce a persistent broker now. Codex's current internal Code Mode supplies
prior art for correlated calls returning to an authoritative host; its V8
runtime and agent SDKs are not dependencies or compatibility authorities here.

## Package and component ownership

```text
Existing Python agent-vm-agent-portal-sdk
  ├─ ToolPortalMcpClient + automatic local transport
  │    consumer: guest Python code; changes with caller transport ergonomics
  ├─ guest relay entrypoint
  │    consumer: managed execution bridge; owns bounded local socket multiplexing
  └─ execution bridge + existing approval helper
       consumer: trusted framework adapters; owns request lifecycle/callbacks

Existing @agent-vm/agent-portal-sdk
  ├─ ToolPortalMcpClient + automatic local transport
  │    consumer: guest JS/TS code; same portable contracts
  └─ tool-portal CLI
       consumer: shell; owns JSON/exit-code interface

Hermes adapter
  ├─ middleware: captures exact invocation; owns lexical lifetime
  ├─ environment launch integration: injects scope endpoint per command
  └─ existing presenter: maps conversation to native human approval route

Gateway Runtime
  ├─ existing sandbox process/stream runtime: transport and lease liveness
  └─ existing Portal core/artifact store: capability policy, dispatch, data

Controller
  ├─ control-session admission: owns cancellable command lifetime
  └─ unchanged lease, credential, approval-decision, and destination owners
```

No new top-level npm/PyPI package duplicates the existing SDKs. The Python
package's trusted-side bridge accepts typed callbacks and a process transport
port; importing its guest client never imports Hermes. The TS package need not
implement a second trusted-side host. Its guest client speaks the same portable
protocol, so any trusted embedding can use the existing Python host or implement
that documented port.

## Guest interface

Names below are proposed public additions; existing client methods and payloads
are reused.

```python
from agent_vm_agent_portal_sdk import connect_tool_portal

async with connect_tool_portal() as portal:
    discovered = await portal.search(search_request)
    described = await portal.describe(describe_request)
    result = await portal.call(call_request)
    # Inspect canonical items before constructing the next request.
```

```typescript
import { connectToolPortal } from '@agent-vm/agent-portal-sdk';

const portal = await connectToolPortal();
try {
  const results = await Promise.all([
    portal.call(firstRequest),
    portal.call(secondRequest),
  ]);
} finally {
  await portal.close();
}
```

```sh
tool-portal search --input-json '<canonical Portal search request>'
```

The examples illustrate API shape, not literal valid sample request bodies.
Published examples must use the real portable fixtures. The automatic factory
reads `AGENT_VM_TOOL_PORTAL_SOCKET`, a guest-absolute socket path injected for
the active invocation. It negotiates the relay protocol version and limits.
It never accepts identity or falls back to another transport if this context
fails. Explicit HTTP/stdio clients remain separately selected external use.

Local transport implements the existing `ToolPortalMcpTransport` interface:
`call_tool` accepts only the four Portal tool names; `read_resource` maps only
the canonical Portal artifact URI. It converts canonical results to the
existing `structuredContent` representation. It does not pretend the local
socket is a general MCP server: discovery/calling are Portal operations, not
arbitrary MCP wire methods. Unknown methods or metadata are rejected.

The managed guest path rejects standalone approval-token options. Managed
approval is completed by the trusted bridge, not by a token supplied by code.
CLI stdout/exit codes remain C6; transport diagnostics never contaminate JSON.

## Getting packages into ordinary code execution

The managed Tool VM image overlay explicitly installs the matching Python SDK,
Node SDK/CLI, and guest helper. It does not rely on transitive CLI installation
through `mcp-portal`. Python's managed `python3` environment must include the
SDK. Node's normal package resolution from `/work`, `/workspace`, and temporary
script directories must find it; a global CLI installation alone is insufficient.

Use an image-owned Python venv selected by the managed execution PATH, and an
image-installed Node dependency tree exposed through the root `/node_modules`
ancestor lookup. This avoids custom ESM loaders or provider wrapper commands.
The rootfs remains ordinary writable Tool VM state; package installation is not
an integrity boundary against the agent. A user-created nearer dependency may
shadow a package by ordinary language resolution; diagnostics show resolution
and version rather than silently claiming the managed package was used.

SDKs and helper are release-version locked with the existing package train.
The local protocol handshake rejects mismatch. Image fingerprints already
include package inputs; no new image-version scheme or runtime installer is
introduced. A missing helper makes the scoped Portal interface unavailable;
the adapter does not install from the network during a user turn.

## Capturing the conversation without changing Tool VM identity

Pinned Hermes exposes `PluginContext.register_middleware('tool_execution', …)`
(`hermes_cli/plugins.py:3433–3458`). Its middleware receives `session_id`,
`tool_call_id`, `turn_id`, `api_request_id`, and task ID from the trusted outer
dispatcher. The adapter validates these into a frozen invocation identity:
admitted projection, exact conversation, invocation ID, and deadline. A separate
`PortalInvocationScope` owns that immutable identity and mutable lifecycle on
the adapter's existing asyncio loop. This is process-local correlation, not
durable identity or guest authority.

For `execute_code` and foreground `terminal`, middleware sets an adapter-owned
ContextVar, invokes `next_call` exactly once, and closes/reset the scope in
`finally`. It wraps rather than replaces stock execution, preserving the
whole-script approval guard and existing tool behavior. Nested launch work
inherits the scope; it does not create an unrelated conversation scope.

`_run_bash` captures the immutable scope before scheduling on the adapter
event loop and passes it explicitly to its coroutine. It lazily opens one
bridge per invocation/environment generation, with single-flight ownership in
the scope, then adds only that endpoint to the launched command's environment.
The bridge itself starts through raw sandbox process APIs, not `_run_bash`,
so opening it cannot recursively open another bridge.

The stock remote RPC polling thread already uses `copy_context()` through
`tools/thread_context.py:64–120`. Do not depend on implicit context propagation
across additional threads: capture and pass the scope explicitly at each owned
async/thread boundary.

Never change `HermesGatewayRuntimeEnvironment._trusted_context` per conversation.
It is shared per profile/generation (`managed_gateway_bootstrap.py:686–764`),
and its sandbox correlation is the environment cache identity. Portal calls
instead derive their trusted context from the scope's admitted projection and
real conversation. A missing conversation disables Portal bridge admission;
ordinary direct execution retains its existing behavior.

Detached background work does not retain an invocation's Portal authority after
the foreground call ends. The package host API can be used by another framework
with its own explicitly owned scope; no Hermes import is required. This change
does not create a detached-job lifetime or persistent session service.

## Trusted bridge interface and call flow

The Python bridge's host-facing factory accepts:

- immutable admitted context and deadline supplied by the trusted adapter;
- an existing managed process/stream transport port, bound to the active sandbox
  environment and generation;
- typed async Portal list/search/describe/call and artifact-read callbacks;
- the existing approval presenter and decision callbacks; and
- an explicit cancellation/lifecycle owner.

Guest messages never carry these callbacks or trusted context. The bridge
invokes the normal Portal client and the existing approval helper. No Gateway
Runtime-to-Hermes callback protocol is necessary because presentation remains
beside Hermes. Source `BaseEnvironment._run_bash` closes stdin and waits before
reading; it cannot host this relay. The bridge starts and pumps lower-level
process streams concurrently and independently of process wait.

```text
1. Trusted middleware captures conversation + admitted projection
2. Stock execute_code begins ordinary remote work
3. Launch integration opens scoped relay using sandbox.process.start
4. SDK bridge concurrently reads relay stdout and writes responses to stdin
5. Helper reports ready; launch integration injects guest socket into program
6. Guest SDK sends request ID + operation + canonical public payload
7. Bridge validates; supplies fixed context to managed Portal client
8. Gateway validates authority; Portal chooses backend and executes
9. Canonical result returns through bridge and guest socket to awaiting code
10. Middleware completion cancels unfinished requests and closes helper/scope

Failure at 3–5: no Portal call dispatched; report unavailable interface.
Failure after 7: preserve known outcome, otherwise report uncertain effect.
```

Top-level native Portal calls still use their existing handler; both routes
reuse the same SDK approval algorithm and managed Portal service. No independent
configuration, authority registry, or capability catalog is added.

## Wire contract and bounds

The local relay protocol is version 1, with canonical JSON bodies using the
existing bounded Content-Length framing primitives. The guest-local socket
supports multiple clients; the helper assigns connection-local IDs to a unique
channel-wide request ID before forwarding. Guest IDs are correlation only.

| Frame | Fields and interpretation |
| --- | --- |
| hello / ready | protocol version and negotiated finite limits; ready only after socket publication and active trusted scope |
| request | unique request ID, one of list/search/describe/call/artifact-read, canonical public request |
| result | matching request ID and canonical result; no invented successful outcome |
| artifact-chunk / artifact-end | matching request ID, reference, absolute offset and bounded base64 bytes; end supplies the canonical range metadata and exact received length |
| error | matching ID, bounded transport error code, dispatch certainty; no raw traceback |
| cancel | matching request ID only; idempotent for completed known IDs, no other scope targeting |
| credit | trusted bridge advertises remaining request/result-byte capacity; helper pauses local reads until credit exists |
| close | stops admission; cancels outstanding work; no successor auto-attach |

Strict schemas reject trustedContext, agent/profile overrides, approval decisions,
arbitrary RPC methods, and unknown envelope fields. Schema/authority validation
occurs trusted-side even when the SDK validated locally. A malformed channel
closes only its invocation bridge, not the shared agent environment.

Use 1 MiB maximum encoded message, 8 KiB header, 64 KiB process-stream chunks,
and at most 16 pending Portal requests and 16 guest connections per bridge.
Share a 64 MiB buffered-byte budget across local connections and pending frames;
pause producers at high-water and reject new requests before dispatch when no
credit exists.
Control/cancellation frames have reserved capacity. The host checks actual
encoded bytes before sending a result; oversized results become explicit
transport failures with retained dispatch certainty, never truncation of JSON.

The auxiliary relay process needs an explicit streaming I/O profile on the
existing managed process interface. Its finite total transfer budget is 64 MiB
per direction per invocation; deadline is the originating invocation deadline.
This profile is available only on the trusted managed process surface and does
not grant Portal authority. Normal shell/process defaults remain unchanged.

This is required because current strict SSH closes after 1 MiB cumulative output
and the process stdin runtime retains only 64 writes / 16 MiB. Merely enlarging
a client buffer would not fix those lower-layer limits. The following contract
changes only the auxiliary profile, not ordinary process behavior.

### Auxiliary process/stream contract

`sandbox.process.start` gains the discriminant `ioProfile: standard | portal-relay`;
normalization selects `standard` when omitted. `portal-relay` selects fixed
runtime-owned bounds, not caller-selected unlimited values. Its process handle
records the profile; subsequent stream operations derive behavior from that
handle. The guest Portal protocol exposes no process-start operation.

For relay stdin, the existing `sandbox.stream.write` request additionally carries
`acknowledgedThrough`, initially -1. This is the highest contiguous sequence for
which the bridge actually received `written` or `already-written`. It is the
sole acknowledgment event; merely seeing a higher submitted sequence is not
acknowledgment. The existing write result acknowledges bytes accepted into the
SSH channel, not guest application processing or a Portal effect.

The bridge has exactly one stdin writer and awaits each write result before
submitting the next sequence. Gateway Runtime retains its per-stream `writeTail`
serialization and owns `nextWriteSequence`, `acknowledgedThrough`,
`evictedThrough`, total bytes, and at most 64 retained records. Within that
serialized operation it validates the entire request before mutation:

- acknowledgment must be monotone, below `nextWriteSequence`, and cover only
  records known written; a future acknowledgment is rejected;
- the next new sequence writes once; it increments sequence/bytes only on
  successful channel acceptance;
- an identical retained duplicate returns `already-written` without writing;
  a different digest/content for that sequence is rejected;
- before adding record 65, evict oldest records only through the acknowledged
  watermark; retain the scalar `evictedThrough` after deletion;
- any evicted, skipped, or invalid sequence is rejected without writing; a
  concurrent out-of-order arrival is rejected, not queued waiting for a gap;
- a channel write of uncertain completion records ambiguity and stops relay
  admission. It cannot be acknowledged, evicted into retryability, or replayed.

Thus a lost write response cannot advance acknowledgment. A bounded exact
sequence/digest retry may retrieve an existing written receipt while the same
live attachment remains valid; it is not a replay of a Portal call. Connection
loss still closes the scope, without reconnect/replay. An evicted sequence is
never re-executed even if its original response is unavailable.

For relay stdout, `sandbox.stream.read` uses consuming cursor semantics under
this profile and accepts a bounded `waitMs`. The bridge owns exactly one reader
per stream. The first read has no cursor; each subsequent read presents the
previous returned `nextCursor`, acknowledging bytes through that cursor. A
repeat of the last input cursor returns the same unacknowledged chunk. An old,
forged, or concurrent-reader cursor is rejected. The runtime retains only the
acknowledged cursor and current offered cursor; it never evicts unread bytes.
No-data reads await output, process termination, cancellation, or `waitMs`
expiry through the existing scheduler; timeout returns empty data with the same
cursor. The bridge waits again rather than spinning or interpreting it as EOF.

The auxiliary stdout/stderr queue has a 4 MiB hard cap: pause the underlying SSH
channel at 3 MiB and resume below 1 MiB after consumption. Strict SSH's process
channel port gains channel-local pause/resume operations; no shared SSH
connection is paused. At the hard cap, close the auxiliary channel and report
transport ambiguity rather than dropping a byte. Stderr is drained separately
and never parsed as protocol. Ordinary retained snapshot/log cursor behavior
does not change. These read/write/profile variants belong to the canonical
private process schemas and their Python/TS projections, not the guest wire.

Before a guest request enters Portal, the bridge reserves a pending slot,
request bytes, and enough remaining output credit for one maximum result
message; artifact credit includes the known requested range and base64 overhead.
At insufficient capacity it returns overload without Portal dispatch. Unused
reservation credit is released at completion. Transfer totals never reset as
acknowledged buffers are released. A reserved control budget of 8 KiB remains
available for cancellation/close. Exhaustion stops admission and drains only
already-reserved replies; a peer exceeding its credit closes the scope. If an
already-dispatched response is lost at a hard cap, its effect remains uncertain.

No automatic relay restart/replay occurs within a scope. The next independently
authorized invocation starts fresh. Bounds are transport/resource guarantees,
not claims that arbitrary Tool VM code is contained.

For artifact reads, retain the public 16 MiB maximum but service it as sequential
64 KiB authorized range reads through the private UDS. Validate reference,
offset, and progress on each chunk; stream framed chunks to the guest transport
and reconstruct the single canonical result there within the advertised bound.
Reserve assembly capacity before admission, including base64 expansion and
canonical result encoding; admit only one maximum-sized artifact assembly at
a time per bridge. Duplicate, missing, overlapping, or out-of-order chunks are
transport errors; they never produce a successful partial artifact.
Do not place a 16 MiB base64 result in a 1 MiB UDS message. Interleaved replies
retain IDs and offsets. Mid-read failure returns no fabricated complete artifact.

## Approval and cancellation sequence

```text
Guest code        SDK bridge          Portal/controller       Human route
   │ call              │                    │                    │
   ├──────────────────►│ call(fixed context) │                    │
   │                   ├───────────────────►│                    │
   │                   │◄─ approval_required┤                    │
   │ awaiting          ├── existing presenter(exact session) ────►│
   │                   │◄──────────────────── approve / deny ────┤
   │                   ├── approval.decide ──►│                   │
   │                   ├── exact item retry ►│                   │
   │◄─ canonical result┤                    │                    │

Decision and retry remain trusted-side; the guest never sends a decision.

Cancellation / scope close
   └── bridge stops admission and cancels request/presentation tasks
       └── managed UDS AbortSignal reaches capability core/backend
           └── completed effect is retained; cancellation is not rollback
```

### Cancelling an admitted controller CLI

R5 requires cancellation to reach the owned call. Cancelling the Gateway's
awaiting promise alone cannot stop a controller-host process. The existing
host executor already kills its child on AbortSignal; the managed-VM executor
already accepts that signal. The missing link is between Gateway control
submission and controller execution, not another guest transport.

Current source separates three facts:

- `gateway-control-command-client.ts` returns only the eventual command result;
  it provides no in-flight cancellation handle.
- `gateway-control-admission-classification.ts` refuses gateway-origin
  `operation_cancel` as `unproven_gateway_cancel`; the domain handler also
  rejects it when reached directly.
- `gateway-control-domain-handler.ts:1088` creates a configured-CLI abort owner
  only after authorization, connected to expiry but not originating cancellation.

The target extends the existing `operation_cancel` gateway variant for
configured-CLI operations. Its target is the original command's UUID, carried
as `activeOperationId`, not a guest request ID, PID, lease, or shared caller
context. It carries the existing authenticated adapter evidence for the
controller-execution principal; validation reuses the caller-registration proof
validator without allocating another caller context. Controller-originated
cancellation retains its existing contract. No guest frame gains this API.

```text
UNCHANGED: guest cancel / relay loss
  └─ SDK scope → private UDS → Portal backend AbortSignal

ADDED: Gateway command lifetime
  ├─ original command → existing control transport → controller admission
  │                                            └─ record exact command owner
  └─ cancellation → same accepted session, existing operation_cancel
                                              │
CHANGED: controller validates proof + session + command ownership
  ├─ queued/authorizing → mark cancelled → no later dispatch
  ├─ running → abort existing executor → observe termination or uncertainty
  └─ completed/unknown → no new effect; never claim rollback

UNCHANGED: original result returns through the original command correlation.
Cancellation acknowledgment is not the command's result or proof of no effect.
```

The controller control-session admission owner registers the operation after
authenticated classification and before queue admission is acknowledged. The
record holds command ID, accepted session/connection and boot/epoch identity,
validated stable principal, operation kind, expiry and cancellation state.
It is one in-memory lifetime record per admitted configured CLI, bounded by
existing queued/active admission budgets. It is neither durable execution
history nor a second approval or replay ledger.

The same owner releases records on admission refusal or actual cleanup
completion. Expiry and session retirement request cancellation; they do not
prove cleanup completion. Session retirement first marks queued work cancelled
and aborts running work. Cleanup retains ownership and capacity charges until
the underlying work settles, independently of caller-response settlement. It never kills a
whole shared Tool VM to cancel one command. Caller-context registration remains
unchanged: those contexts are cached and shared, so releasing one is not a
valid substitute for cancelling an individual command.

Gateway command submission observes the Portal signal before emitting the
original frame. Once emitted, it retains a correlated lifetime handle tied to
that accepted session. Cancellation waits for original admission receipt before
using the existing bounded safety lane; it does not wait for command completion.
If the receipt or session is lost, the original call remains uncertain and is
never replayed. A cancel must never be sent on a replacement session. Controller
session retirement and the original execution deadline remain independent
termination paths when cancellation cannot be delivered.

Only authenticated gateway-origin cancellation of this supported operation
kind enters the safety lane. Both sender and receiver validate direction and
principal; the controller also compares the exact target record. Unknown,
cross-principal, cross-session, expired and unsupported targets cannot abort
anything. The safety lane retains its existing resource limits; authority-lane
saturation must not make a cancellation wait behind the command it cancels.

The domain execution path uses the admission-owned signal, combined with its
existing expiry behavior, instead of a disconnected cancellation owner. It
checks that signal after each awaited authorization/approval step and before
executor dispatch. Cancellation does not change approval records or restore a
consumed grant. Already-running effects may remain uncertain; registered OAuth
and Git actions are not given invented rollback or process-kill semantics.

```text
Controller-owned operation lifetime

  admitted/queued ──► authorizing ──► running ──► settled
       │                  │             │
       └──── cancel ──────┴─────────────┘
                          │
                          ▼
                   cancellation requested
                     ├─ before dispatch: settle without dispatch
                     └─ after dispatch: abort; retain actual certainty

No cancelled-to-running transition. No successor-session adoption.
Duplicate cancellation has no additional effect. A completed result wins
over later cancellation; acknowledgement never rewrites that result.
```

This structure reuses the control session, proof verifier, admission budgets,
safety lane and executor signals. It costs controller/Gateway maintainers an
operation-lifetime handle and authenticated cancellation wiring. A separate
reverse socket would duplicate authority and transport ownership. Waiting only
for command expiry preserves a bound but does not implement caller cancellation.
A persistent job supervisor is unnecessary without a detached-job requirement.

Proof observes both sides of the boundary: unit state transitions and wrong-
owner rejection; real control-session cancellation while authorization is
paused and while authority capacity is full; host child exit before its natural
deadline; unchanged unrelated concurrent command; and real Tool VM relay loss
after an admitted effect, with uncertain caller outcome and no replay. Lost
receipt, session replacement and late cancellation must retain honest certainty.
The live fixture's 10-second observation window is a proof bound, not a new
public latency SLA. Vendor-side effects are not rolled back by local cancellation.

#### Caller response and cleanup have different completion points

At the private UDS request owner, a valid cancellation of a pending Portal
request atomically marks that request's reply settled, aborts its signal, and
sends one request-local JSON-RPC cancellation error. This is a transport-level
cancellation, not a canonical claim of non-dispatch or observed process exit.
It uses the original request ID. A response already emitted wins the race;
otherwise the later dispatch result/error is consumed but not sent again.
Non-Portal private RPC behavior is unchanged.

This immediate terminal reply lets the existing Python cancelled-response
drain complete without waiting for controller authorization, termination, or
the original execution timeout. The shared UDS attachment and unrelated
requests remain live. The UDS pending-dispatch capacity charge stays with the
underlying task until it settles; replying early does not create unlimited
background work. Repeated cancellation is inert while that task remains owned.
Malformed frames and actual connection faults retain their existing behavior.

```text
Portal cancellation at private UDS owner
  ├─ reply open → one cancellation error → Python drains exact reply
  │                                      └─ unrelated callers stay connected
  └─ dispatch still live → abort signal → controller/executor cleanup
                                          └─ release retained charge on settle

Late result: consume, never emit a second reply.
Early reply: never treated as proof of process exit or rollback.
```

#### Retired work remains charged until cleanup finishes

The existing controller process-admission coordinator owns the retained-work
charge across session replacement. It reuses each admission work record rather
than introducing a second command registry or persistent supervisor. For
configured-CLI work, one charge spans queued, authorizing, running and
retired-but-unsettled states. Successor sessions share that process-wide count
and byte budget; unregistering a session cannot erase retained predecessor
charges. Local active-work slots also remain charged while their underlying
execution is unsettled. Cancellation acknowledgments do not release either.

Queued work can release its charge once it is irrevocably fenced from execution.
An authorization already awaiting another owner retains its charge until the
await settles; its cancelled signal prevents subsequent authorization stages or
dispatch. Unresponsive cleanup returns uncertainty to callers within the
existing bounded response path, but retains its charge. At exhaustion, refuse
new configured-CLI admission rather than accumulate unbounded predecessor work.
This bounded fail-closed capacity loss is visible in admission diagnostics;
normal settlement releases it, and controller lifecycle restart resets
in-memory ownership under existing process management. No automatic restart is
introduced to hide a stuck operation.

Running host work has separate kill-requested and exit-observed facts. Sending
SIGKILL or rejecting the executor promise does not prove termination. Its
executor-owned child close/error observation completes resource cleanup; a
bounded unconfirmed-termination response remains uncertain while the child is
still counted. Managed-VM work retains the existing command-group termination
and retirement owner; an unsafe termination cannot release ownership merely
because a caller stopped waiting. No PID becomes cancellation authority.

Proof holds authorization beyond the private UDS drain timeout, cancels that
request, and successfully completes another on the same connection. Releasing
authorization later must produce neither dispatch nor a duplicate reply. A
second proof repeatedly replaces sessions while authorization is held, verifies
retained work remains charged and bounded, then releases it and observes
capacity recovery. Delayed child exit must remain distinct from an accepted
kill request in both result certainty and cleanup accounting.

### Scope-close versus approval-retry ordering

The bridge reuses `execute_portal_call_with_approval`, with scope-owned admission
callbacks around decision submission and exact retry. The scope and its task
registry live on one asyncio loop. `admit(stage, coroutine_factory)` performs,
without awaiting: check `active` and deadline, register the child task with the
scope's cancellation owner, then schedule it. `close()` on that same loop
atomically changes `active` to `closing`, disables admission, and cancels every
registered task before yielding. Calls from middleware threads are marshalled
to that loop; they never mutate scope state themselves. This non-yielding
transition is the linearization gate, not a check followed by an unregistered
future. No lock is held across Portal I/O or human interaction.

The initial call, post-presentation decision, and post-decision exact retry each
require separate admission. Completion of one stage grants no permission for
the next. All successful/failed paths unregister their task in `finally`.

| Race winner | Result and allowed effect |
| --- | --- |
| Closure before decision admission | No approval decision or retry is submitted; canonical non-dispatch cancellation/expiry |
| Decision admission, then closure before retry admission | A decision may be recorded, but no retry is submitted; canonical non-dispatch cancellation for the protected item |
| Retry admission before closure | Retry is already registered/in flight; closure cancels it through UDS and Portal signals. Preserve completed outcome, known non-dispatch, or uncertainty according to actual evidence—never promise rollback |
| Human response after closing | Discard response for execution purposes; the gate rejects decision and retry admission |

An admitted coroutine checks cancellation before its first transport write;
after acquiring the UDS write lock there is no await between that check and
writing the frame. Cancellation while waiting for the lock sends no request.
A frame written before closure may already have reached Portal; propagated
cancellation bounds later work but does not retroactively make it undispatched.
Portal checks the signal before reservation/arming/dispatch where applicable,
while existing controller freshness and consumption checks remain authoritative.

To prevent an approved-but-unretried item from being reused by a successor
scope, the bridge gives Portal a scope-qualified call ID, derived from a fresh
trusted-side invocation nonce and caller item ID. Existing `deterministicOperationId`
uses call ID plus principal/revision/surface, not conversational correlation
(`tool-portal-service.ts:628`), so correlation alone is insufficient. Encoding
`bridge-` plus the SHA-256 hex digest of the canonical tuple produces a fixed-size
valid call ID (the current RequestIdSchema has no length maximum), stable for exact
retry within the scope and different across scopes. Arguments, name, namespace,
and policy are unchanged. Map result item IDs back to caller IDs; leave opaque
Portal operation IDs intact. Do not expose the internal call-ID mapping to the
guest or preserve it after closure.

If approval was recorded but retry was not admitted, it is not consumed by a
fake execution or reclassified as denied: the controller keeps its existing
record until its normal expiry/retirement, and the bridge returns cancellation.
No successor scope can generate the same scoped call ID. If retry was admitted,
existing reservation/consumption semantics apply. A blocked native presenter
thread may finish later, but its result has no admission authority; the bridge
does not wait indefinitely for it or start a replacement call.

Cancellation must not be swallowed as presenter-unavailable. This ordering
defines 'late approval' precisely: approval after closure cannot start work;
work admitted before closure can have a completed or uncertain effect.

## Lifetime and concurrency

| Scope state | Owner / allowed transition | Behavior |
| --- | --- | --- |
| created | middleware; lazy open on first managed launch | Immutable projection/conversation, no guest endpoint yet |
| opening | SDK bridge; active environment + helper handshake | One opener per invocation; concurrent launches join it |
| active | bridge; request admission within bounds | Independent calls multiplex; each callback closes over this scope |
| closing | middleware cancellation/completion, authority loss, or transport failure | Reject new work first; cancel/drain owned tasks within bounded cleanup deadline |
| closed | bridge cleanup completes | Endpoint cannot attach to a successor; repeat close is harmless |

There is no closed-to-active transition. Scope close does not close the shared
Gateway SDK client or shared Tool VM; it cancels its own relay process/streams.
Cleanup removes only the invocation's guest socket directory. Gateway/Tool VM
loss causes existing active-use retirement and invalidates the bridge.

Multiple conversations may share one Tool VM but never one mutable conversation
slot. Each invocation has its own socket and frozen callbacks. These paths
prevent accidental cross-routing; they do not isolate malicious processes of
the same agent inside a shared arbitrary-execution VM. Cross-agent isolation
still comes from separate managed projections/VM bindings and Portal checks.

Nested Tool VM capability calls may acquire an additional active use and SSH
channel; the existing controller permits same-process/attachment concurrent
uses (`tool-vm-lease-authority-state.ts:408–447`). Never hold a bridge-wide lock
while awaiting Portal or human approval. Runtime capacity exhaustion rejects
the nested operation; it must not wait for the parent composition to finish.

## Failure ownership

| Failure | Detection and owner | Containment / returned result |
| --- | --- | --- |
| Helper absent or version mismatch | bridge opening | Portal context unavailable; no fallback or runtime install |
| Missing real conversation | middleware/dispatch binding | Portal calls unavailable; ordinary execution not redefined |
| Forged envelope or cross-agent reference | bridge parser / Portal artifact authority | Reject before effect; guest identity fields never used |
| One provider fails | existing Portal backend | Preserve item-level partial result; other independent calls continue |
| Approval route absent/expired/denied | existing presenter/controller | Canonical non-dispatch outcome |
| Caller cancels | guest transport and bridge task | Propagate cancellation; retain completed effects and exact known outcome |
| Helper/SSH/UDS lost | respective transport, bridge owner | Close scope; outstanding calls may be uncertain; no replay |
| Buffer or channel capacity exhausted | bridge/runtime | Reject undispatched work; never silently truncate protocol frames |
| Cleanup cannot confirm process exit | managed process runtime | Preserve ambiguity and existing liveness handling; do not claim successful cancellation or create successor automatically |

Diagnostics contain version, bounded error class, operation IDs, generation,
and timing—not argument/result bodies, credentials, socket tokens, or raw
provider errors. Results remain with the caller and existing artifact store;
the bridge adds no durable request log or result database.

## Agent instructions

Extend the existing orientation renderer with a compact explanation of the
automatic SDK/CLI interface and a pointer to packaged local examples. Preserve
its session-once `pre_llm_call` injection and byte budget; reduce displayed
namespace entries to fit rather than grow the prompt or add a second pipeline.
Startup checks validate package/bridge feature compatibility; invocation
readiness is checked when the bridge opens, not asserted by an old inventory.

The local runtime guide states: composition runs in Tool VM; discover/describe
through Portal; use ordinary Python/TS control flow; check each result; await
required human approval; do not replay uncertain effects; the endpoint expires
with the invocation. Describe what is installed separately from what is live.

## How each obligation is proved

| Requirement / contract | Realization | Proof seam |
| --- | --- | --- |
| R1 / C1–C2, C6 | Existing clients, local transports, CLI | Portable schema parity; real guest Python/TS/CLI calls and result-dependent composition |
| R2 / C4 | Image overlay, middleware scope, launch injection | Both architectures' imports from work/tmp directories; helper mismatch and missing context |
| R3 / C1 | Fixed-context trusted dispatch to existing Portal | Real MCP and host/credentialed/Tool VM destination effects; forged identity and hidden/denied calls |
| R4 / C3 | Existing approval helper + scope admission gate and qualified call IDs | Barriers after presentation/before decision/after decision/before backend dispatch; both close-race winners; no successor approval reuse; real native approval while guest awaits |
| R5 / C2, C4–C5 | Bounded framing, explicit write acknowledgments/consuming reads, operation-owned controller cancellation, artifact chunks | More than 64 writes; lost/duplicate acknowledgment; evicted/skipped sequence rejection with byte-order inspection; stalled-reader pause/resume; reordered replies; saturation; post-effect disconnect; multi-chunk artifacts; queued/running cancellation over the real control channel, wrong-owner rejection, independent-call preservation and host process exit before natural timeout |
| R6 / C4 | Existing orientation and isolation boundaries | Model-request inspection, package-only consumer without Hermes, no secret/authority leakage |

```text
Real-VM proof driver
  └─ real Hermes invocation/middleware (for identity and approvals)
      └─ real Tool VM program + installed SDK / CLI
          └─ real guest socket + relay + SSH + Gateway UDS
              └─ real managed Tool Portal and controller
                  ├─ local deterministic MCP server (real protocol, fake vendor)
                  ├─ real configured CLI with observable side effect
                  └─ real human approval adapter/channel

Observe: returned program data, destination effect, exact approval recipient,
denied/no-effect cases, cancellation certainty, and absence of leaked authority.
```

Unit proof covers codecs, scope state, write-window guards, and canonical
projections. Integration proof covers real local sockets/stream adapters with
substituted VM boundaries. Neither replaces the real-VM path above. A local
deterministic MCP server proves MCP transport, not vendor availability. Beta
remains separate deployment evidence. PR A integration waits for its landed
target; this design neither copies it nor claims it tested.
