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

The current branch's absence of PR A's `tool_vm` configured-CLI target MUST NOT
be concealed by a fake target, direct-shell substitute, or copied repair lane.
Its integration proof requires the landed prerequisite.

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

## Observable contracts

| Contract | Input / precondition | Output / boundary case |
| --- | --- | --- |
| C1: discovery and call | Active managed execution context; canonical public requests | Existing Portal result models; bad request fails before effect; hidden/denied remains hidden/denied |
| C2: composition | Python/TS calls or CLI processes in Tool VM | Caller controls order; independent results correlate correctly; no batch-wide rollback |
| C3: approval | Protected call with live originating conversation | Awaited canonical result after existing human decision, or explicit non-dispatch error when route is unavailable |
| C4: lifecycle | Active execution and its current managed authority | Calls stop being admitted after cancellation/retirement; predecessor context cannot attach to successor execution |
| C5: artifacts | Authorized opaque reference plus byte range | Bounded bytes and truncation metadata, or canonical denial/stale-reference failure |
| C6: CLI | Canonical JSON input and automatic managed context | Canonical JSON on stdout; exit 0 success, 1 canonical Portal failure, 2 client/transport failure; diagnostics on stderr |

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

- V1: real supported Tool VM images import both SDKs and invoke the CLI from
  work directories without manual endpoint setup; mismatch/missing context is
  visibly rejected. Package and generated-instruction inspection supplement it.
- V2: real Tool VM-origin programs compose MCP and configured-CLI calls through
  real Portal routing; observe returned data and the actual destination effect.
  Include a result-dependent second call and parallel calls with reversed
  completion order. Tool VM destination coverage requires PR A's landed target.
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

These are required implementation proof modalities, not evidence already run.
Performance has no new latency SLA; the obligation is bounded resources and
independent response progress. Browser UI, durable job recovery, and provider
SDK compatibility beyond the configured capability contract are out of scope.
