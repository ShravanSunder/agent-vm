# Tool VM Portal composition specification

Authority: [Requirements](requirements.md). Realization: [Program design](program-design.md).

## What the caller experiences

```text
Python program ──────┐
TypeScript program ──┼──► [Tool Portal access from Tool VM] ──► capability
Shell / CLI ─────────┘                    │
                                         └──► approving human, when required
All three receive data / partial results / explicit failure.

Outside this surface: host administration, provider credential management,
direct selection of execution destinations, and workflow persistence.
```

P1: Existing clients need transport configuration not supplied in Tool VM.
O1: Installed clients work automatically in an admitted execution context.

P2: Hermes's nested-tool helper excludes Portal and does not carry real session
identity. O2: Ordinary code can compose Portal operations with correct routing
and human approval, independently of that helper's provider list.

P3: A new reverse connection could expose trusted framework authority or hide
uncertain effects. O3: Guest callers obtain only their Portal surface and retain
truthful outcomes across cancellation and failure.

## R1 — Reusable package surface (U1, U2)

The existing Python and TypeScript SDK packages MUST expose an automatically
configured client for `list`, `search`, `describe`, `call`, and bounded artifact
read. The existing `tool-portal` CLI MUST expose the same operations in the
managed execution environment. These operations MUST use the canonical portable
Portal request/result contracts; they MUST NOT require provider-specific code.

Python asynchronous calls and TypeScript promises MUST permit result-dependent
sequential calls and concurrent calls. The runtime MUST NOT impose a fixed
capability order or a seven-tool list. Existing Portal capacity and policy
remain applicable. No atomic transaction across separate calls is promised.

Clients MUST remain usable without importing Hermes. Existing explicitly
configured MCP HTTP/stdio clients remain legitimate external transports, not a
fallback to bypass unavailable managed authority.

## R2 — Automatic execution-environment setup (U1, U3)

Managed Tool VM execution MUST provide the matching SDK packages, CLI, and
connection context before agent code is told they are usable. Python imports
and Node package resolution MUST work from ordinary supported work directories,
not only from the package installation directory. Child processes launched by
the composition program MUST inherit the applicable connection context.

Connection context MUST identify only an available caller interface; callers
MUST NOT manually supply a profile, managed principal, controller credential,
or approval credential. Missing, stale, or incompatible context MUST produce a
bounded actionable error. The client MUST NOT silently use a host-local socket,
another session, an external MCP endpoint, or a different execution backend.

The composition program MUST run in Tool VM. Using SDK calls MUST NOT move that
program into the Gateway, controller host, or credentialed execution VM.

## R3 — Portal semantics and destination preservation (U4, U6)

Each call MUST pass through the existing managed Tool Portal with the admitted
agent's authority. Discovery, schema validation, visibility, call classification,
backend routing, and artifact access MUST retain their existing policy owners.
Guest-supplied fields MUST NOT establish agent identity or approval authority.

MCP capabilities and configured CLIs MUST use the same SDK interface. A call's
destination comes from configuration, not a guest-selected host. A configured
Tool VM target MAY return work to the same Tool VM only through normal Portal
admission; direct code execution remains a separate surface.

The existing `tool_vm` configured-CLI target MUST be reused. Its integration
proof must traverse normal Portal admission and routing, not a direct-shell
substitute.

## R4 — Human approval remains usable from code (U4, U5, U6)

A managed SDK call requiring approval MUST use the existing human approval
route for the originating conversation. Approval decisions and exact retry
MUST remain trusted-side operations. The guest MUST NOT acquire a way to call
`approval.decide` or manufacture a standalone approval token.

The code may await the call while a human decides. A denied, cancelled, expired,
or unavailable approval route MUST produce the corresponding canonical
non-dispatch outcome. Approval for one item MUST NOT repeat already successful
items or authorize modified arguments. Ending the originating execution MUST
prevent later approval from dispatching its pending call.

The conversational session and the reusable Tool VM identity MUST remain
distinct. Concurrent conversations sharing one agent's Tool VM MUST not route
approval to whichever conversation was most recently active.

## R5 — Data and failure semantics (U1, U5)

Clients MUST return canonical structured results, item-level errors, execution
certainty, and artifact references without flattening mixed success into one
string or one success flag. Artifact bytes MUST be read through the existing
authorized bounded-read contract, not an assumed shared filesystem path.

Transport failures MUST be distinguishable from canonical Portal failures.
Cancellation and deadlines MUST propagate to the owned call. Once dispatch
may have occurred, a lost connection MUST NOT be represented as proof that no
effect happened. Neither clients nor integration may automatically replay the
whole program or a possibly dispatched call.

One slow call MUST NOT prevent an unrelated concurrent response from being
delivered. Buffers, in-flight requests, and payloads MUST be bounded; overload
must reject new work before dispatch rather than grow an unbounded queue.
Provider effects completed before cancellation are not rolled back by this
feature.

## R6 — Instructions and trust boundaries (U3, U6)

Before the first relevant composition, the agent MUST receive concise guidance
showing the installed Python/TypeScript/CLI entrypoints, automatic connection
behavior, discovery-before-call, result composition, approval behavior, and
transport-failure handling. Stable full examples MUST be available locally.
Guidance MUST describe Tool VM as the origin and Portal as the router.

Instructions MUST reuse the existing bounded orientation/runtime-documentation
mechanisms. They MUST NOT inject the entire tool catalog, perform provider
discovery synchronously on each user turn, or claim an unavailable connection
works. Tool metadata and returned data are not authority-bearing instructions.

Provider and controller credentials MUST remain with their existing owners.
The new interface MUST NOT expose the rich managed-plugin socket, arbitrary
Gateway RPC, host filesystem paths, or cross-agent artifacts. Same-agent code
sharing an arbitrary-execution Tool VM is not a new process-isolation boundary.

## R7 — Selectable catalog exposure (U6, U7)

Standalone MCP Portal startup MUST accept an explicit choice between compact
discovery and individual MCP tool exposure. Managed Hermes startup configuration
MUST offer the equivalent choice for its native registered tools. Compact
exposure retains each surface's existing discovery and call tools. Individual
exposure MUST provide authorized capabilities with their exact input schemas and
identifiable namespaces. Both selections MUST invoke their respective existing
Portal authority and preserve that surface's canonical outcomes. Selection MUST
NOT change profiles, OAuth grants, approval policy, or
execution destinations, and MUST NOT disable managed SDK composition.

Before the selected catalog is advertised as ready, its tool definitions MUST
be prepared for the applicable authenticated caller. A client MUST NOT receive
another profile's definitions. For managed Hermes, generated definitions and
native catalog registration MUST be prepared once during managed Gateway
startup. Catalog mode MUST complete that preparation before Gateway readiness.
Compact mode MAY retain its existing generic discovery and SDK/CLI surface when
preparation is incomplete, but it MUST NOT advertise catalog or generated-SDK
readiness or guidance. Any complete profile catalog MUST remain immutable for
that Gateway lifetime. Definition changes MUST take effect only through a
managed Gateway restart, whose new epoch prepares a new complete catalog before
advertising it as ready. Catalog readiness means an interface is available; it
MUST NOT assert current OAuth consent, permission for every argument, or
guaranteed provider execution. Client-side deferred loading and model-context
injection remain the client's responsibility.

Failed namespace discovery MUST NOT be treated as intentional tool removal or
as a complete prepared catalog. In catalog mode, incomplete managed preparation
on the initial start or a later restart MUST keep that Gateway epoch from
readiness and MUST expose an actionable startup diagnostic. In compact mode, the
existing generic discovery surface MAY remain ready, but catalog/generated-SDK
guidance MUST remain absent. Standalone catalog-mode startup likewise MUST NOT
advertise an incomplete catalog through its existing session failure behavior.
Existing compact discovery retains its explicit partial-success diagnostics
after a ready start. A running managed Gateway MUST NOT live-refresh definitions
or silently substitute an incomplete catalog. Restart is the definition-change
boundary; this contract adds no automatic retry scheduler or alternate provider
connection.

External clients use standalone MCP Portal's existing authentication and policy;
managed Hermes retains its private managed authority. No new externally
accessible managed MCP endpoint is part of this contract.

## R8 — Generated TypeScript composition (U1, U3, U8)

Hermes's primary generated-SDK path MUST use foreground `terminal` to execute
TypeScript in Tool VM. Schema-derived named functions and argument definitions
MUST be available before guidance advertises them as usable. The agent MUST
receive bounded orientation and locally accessible instructions identifying
discovery, exact module imports, execution, result handling, and approval waits.
Generated functions MUST use the existing SDK connection and Portal semantics;
they MUST NOT resolve credentials or contact providers directly.

Generated public inputs MUST preserve wire names, required versus optional
fields, and supported schema constraints. Unsupported conversion MUST be
explicit rather than represented as an inaccurately precise type. The original
Portal schema remains authoritative for call validation. Canonical result
envelopes, including mixed outcomes and uncertainty, MUST remain inspectable.

Every invocation using generated definitions in one managed Gateway lifetime
MUST use its admitted profile's complete set for that epoch. Definition updates MUST become available only
after a successful managed Gateway restart prepares a new epoch; they MUST NOT
modify the running epoch. Definitions MUST confer no authority:
OAuth/account preflight, consent, approvals, and all ordinary policy checks MUST
run through the existing call path. Foreground completion or cancellation MUST
close invocation authority; background process management MUST NOT extend it.

Existing generic Python/TypeScript/CLI interfaces remain available. This addition
does not generate Python functions or expose Hermes's internal tool registry.

## R9 — Generation and loading costs (U9)

The prepared Gateway-epoch definitions MUST be reusable across executions.
Individual tool calls MUST NOT regenerate modules. Importing one namespace MUST
NOT require loading every namespace's generated definitions. A new Gateway
epoch's SDK MUST become visible as a complete usable set, never partially
written modules.

Proof MUST measure cold Gateway-start generation, same-epoch catalog reuse,
changed-catalog preparation on restart, namespace import latency, generated
size, and peak memory using representative small and large catalogs. Record
workloads and observed costs; no numeric latency guarantee is introduced.
Incremental generation is an optimization to justify from measured costs, not a
required second subsystem.

## Observable contracts

| Contract | Input / precondition | Output / boundary case |
| --- | --- | --- |
| C1: discovery and call | Active managed execution context; canonical public requests | Existing Portal result models; bad request fails before effect; hidden/denied remains hidden/denied |
| C2: composition | Python/TS calls or CLI processes in Tool VM | Caller controls order; independent results correlate correctly; no batch-wide rollback |
| C3: approval | Protected call with live originating conversation | Awaited canonical result after existing human decision, or explicit non-dispatch error when route is unavailable |
| C4: lifecycle | Active execution and its current managed authority | Calls stop being admitted after cancellation/retirement; predecessor context cannot attach to successor execution |
| C5: artifacts | Authorized opaque reference plus byte range | Bounded bytes and truncation metadata, or canonical denial/stale-reference failure |
| C6: CLI | Canonical JSON input and automatic managed context | Canonical JSON on stdout; exit 0 success, 1 canonical Portal failure, 2 client/transport failure; diagnostics on stderr |
| C7: MCP exposure | Startup selection and authenticated profile | Compact tools or individual schemas; identical Portal authority; no cross-profile catalog disclosure |
| C8: generated TypeScript | Ready Gateway epoch and active foreground invocation | Discoverable imports and composable functions; one immutable epoch catalog; closed invocation cannot admit calls |
| C9: generation reuse | Same Gateway epoch or restart with changed definitions | Same-epoch reuse or completely prepared new-epoch modules; no per-call generation; measured generation/import costs |

A search followed by describe followed by call is valid. Starting a second call
only after inspecting the first result is valid. Running two independent calls
concurrently is valid. Sending `trustedContext`, a different agent identity, or
an approval decision in a guest transport envelope is invalid.

## Requirement-to-proof coverage

| Need | Problem / outcome | Requirement / contract | Evidence |
| --- | --- | --- | --- |
| U1 | P1–P2 / O1–O2 | R1–R2, R5 / C1–C2 | V1, V2, V5 |
| U2 | P1 / O1 | R1 / C1, C6 | V1, V2 |
| U3 | P1 / O1 | R2, R6 / C4, C6 | V1, V6 |
| U4 | P2 / O2 | R3–R4 / C1, C3 | V2–V4 |
| U5 | P3 / O3 | R4–R5 / C2–C5 | V3–V5 |
| U6 | P3 / O3 | R3–R4, R6 / C1, C3–C5 | V3–V4, V6 |
| U7 | Compact-only MCP surface / native client discovery | R7 / C7 | V7 |
| U8 | Generic envelopes / discoverable typed composition | R8 / C8 | V8 |
| U9 | Per-call preparation and live drift / one stable prepared Gateway epoch | R9 / C9 | V9 |

- V1: real supported Tool VM images import both SDKs and invoke the CLI from
  work directories without manual endpoint setup; mismatch/missing context is
  visibly rejected. Package and generated-instruction inspection supplement it.
- V2: real Tool VM-origin programs compose MCP and configured-CLI calls through
  real Portal routing; observe returned data and the actual destination effect.
  Include a result-dependent second call and parallel calls with reversed
  completion order, including the existing configured Tool VM destination.
- V3: real managed human-approval interaction from an SDK call; approved,
  denied, expired, cancelled, and unavailable route cases; concurrent
  conversations; exact protected-item retry and no repeated successful effect.
- V4: misuse cases at the trusted boundary: forged identity/decision, another
  agent or artifact, stale generation, cancelled scope, and invalid envelope.
- V5: cross-process cancellation, broken transport after possible effect,
  partial result, overload, output bounds, and bounded artifact retrieval;
  inspect actual side effects to distinguish failure from non-dispatch.
- V6: actual Hermes model-input/runtime-document evidence for accurate bounded
  instructions; no credentials or full catalog; reusable SDKs work without
  Hermes imports and unrelated direct execution remains unchanged.

- V7: real MCP client enumeration and calls in both exposure modes, including
  distinct profiles and hidden capabilities; verify canonical call results and
  live authorization are preserved.
- V8: real Hermes foreground-terminal TypeScript program imports generated
  functions, performs dependent and concurrent calls, and returns selected
  output. Observe approval in the originating conversation, cancellation, OAuth
  consent/denial preservation, definition stability across executions in one
  Gateway lifetime, changed definitions after restart, and actual model
  orientation/local instructions. Preserve beta Google onboarding state.
- V9: reproducible generation and import measurements across representative
  catalog sizes, observing same-epoch reuse, changed preparation in a new epoch,
  complete publication, module loading, output bytes, and memory. Include failed
  initial and restarted-epoch namespace discovery: neither may advertise
  catalog/generated-SDK readiness, masquerade as complete preparation, or look
  like intentional tool removal. Catalog mode remains unready; compact mode
  retains its existing generic surface without generated guidance. Successful
  running epochs keep one prepared definition set while each call exercises live
  authorization.

These are required implementation proof modalities, not evidence already run.
Performance has no new latency SLA; the obligation is bounded resources and
independent response progress. Browser UI, durable job recovery, and provider
SDK compatibility beyond the configured capability contract are out of scope.
