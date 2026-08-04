# Tool VM Retirement Authority Requirements

Date: 2026-08-03
Priority: critical
Priority assigner: repository maintainer
Authority: owner-confirmed requirements from the 2026-08-03 Sunfam incident discussion

## Problem boundary

A Tool VM lease can become eligible for idle retirement while the Gateway still has a persistent SSH connection to that VM. The Controller currently waits for full VM cleanup before it tells the Gateway that the binding retired. That ordering can block retirement behind the very SSH connection the later notification is supposed to close.

If a tool call arrives during that blocked retirement, it can wait for the 180-second binding-result timeout, rotate the Controller-to-Gateway connection, and still allow lease creation to finish after the caller has failed. The Controller and Gateway can then disagree about which binding exists, causing all later file and shell operations for that agent to fail quickly even though the Gateway and a Tool VM process remain alive.

This work repairs that production sequence. It does not reopen the earlier mixed-version image incident.

## Terms used by these requirements

| Term | Meaning |
| --- | --- |
| Lease | The Controller-owned lifetime and generation record for one agent's Tool VM. Completing a tool call does not end the lease. |
| Binding | The Gateway's local route from an agent identity to one exact Tool VM lease and SSH connection. It is derived from Controller authority. |
| Control connection | One accepted Controller-to-Gateway connection. Reconnection creates a new connection identity; it does not itself require a new Tool VM. |
| Command expiry | The existing per-command authority deadline, shorter than the 180-second binding-result wait. Crossing it must finish the caller-visible command without closing the otherwise healthy shared control connection. |
| Fence | Make an old lease or binding unavailable for new work before destructive or replacement work proceeds. |
| Successor | A later Tool VM lease admitted as current for the same agent after its predecessor is proven absent. Its VM process may boot provisionally before absence, but it cannot enable SSH, commit, publish, route, or serve work early. |

## Authorized user requirements

| ID | Owner-confirmed requirement | Observable pass condition | Failure that must be prevented | Priority |
| --- | --- | --- | --- | --- |
| U1 | Tool-backed work must recover automatically after an idle-eligible Tool VM lease retires for managed OpenClaw and Hermes agents. A framework-held active environment is not idle-eligible and must remain usable until that environment ends its active use. | OpenClaw recovers through a real before/after-idle transition. Hermes remains usable through its real shared-runtime path while its cached environment keeps the lease active. Neither path requires restarting the Gateway or framework. | One actual idle retirement causes a permanent tools-only outage, or the idle reaper retires a framework-active environment. | Critical |
| U2 | The Controller remains authoritative for fencing the old lease, proving Tool VM destruction, and admitting a successor as current. | No successor enables SSH, commits as current, publishes, or becomes routable until the Controller has fenced its predecessor and proven the predecessor VM absent. | Gateway-local state, a provisionally booted process, a live process record, or a reconnect independently grants lease authority. | Critical |
| U3 | When the Controller retires a binding, the Gateway must synchronously remove that exact binding from routing and close its SSH client. | Once the Gateway accepts an exact retirement request, new calls cannot select the old binding, and local SSH close begins before acknowledgement. | The Gateway acknowledges retirement while the old binding remains routable or its SSH client remains intentionally open. | Critical |
| U4 | Calls arriving during replacement must share one bounded per-agent transition and wait until the successor is ready. | Concurrent same-agent calls coalesce behind one retirement/provision/publication transition; unrelated agents continue independently. | Calls race separate successors, observe a half-initialized binding, or fail immediately only because retirement is in progress. | Critical |
| U5 | The fix must stay inside existing lease, binding-publication, Gateway binding-map, and exact-process-termination owners. | The change needs no Gateway restart, new supervisor, recovery manager, persistent queue, database, compatibility path, or public protocol. | A leaf Tool VM communication failure expands into whole-Gateway lifecycle machinery. | Critical |
| U6 | The complete production interleaving must be reproducible deterministically with an inspectable ordered event log, then proven through the real OpenClaw and Hermes Tool VM paths. | The integration test emits the retirement, connection-rotation, late-authority, successor, and waiting-call events; OpenClaw proves real before/after-idle recovery, and Hermes proves the real shared Tool VM path remains compatible with its active-environment lifecycle, with no skips. | A collection of isolated unit tests, one adapter-only proof, or sleeps is presented as proof of the shared production path. | Critical |

## Boundary check 1

The repository maintainer confirmed this boundary in the incident discussion:

- Controller authority is definitive for lease fencing, exact Tool VM termination, absence proof, and successor admission.
- Gateway authority is local and derived: remove the exact binding from its map, close the corresponding SSH client, and acknowledge that local action.
- New same-agent tool calls wait behind the existing transition until initialization is complete.
- A dead Gateway remains governed by existing whole-Gateway lifecycle behavior; this work addresses communication impairment while the Gateway remains otherwise alive.
- The design must solve the observed idle-retirement race without theoretical recovery machinery.
- OpenClaw and Hermes consume the same shared retirement correction. Their framework plugins do not become lease or VM lifecycle owners. OpenClaw requires the real idle-retirement proof; Hermes requires a real shared-runtime compatibility proof because its cached environment intentionally keeps active use open and is not idle-eligible until cleanup.
- Deterministic simulation with a readable log is required before implementation can be considered proven.

## Explicit exclusions

- The stale prepared-image/version-skew defect and package release mechanics.
- Gateway, OpenClaw, Hermes, or controller restart as the repair for this leaf failure.
- Automatic Tool VM replacement merely because the control connection reconnects.
- A new general-purpose cancellation framework, lifecycle supervisor, durable work queue, or recovery database.
- Web-fetch HTTP 403, unavailable Firecrawl capability, cron visibility, and unrelated health findings from the same incident packet.
- A broad redesign of managed Gateway control-session resilience.
- Framework-specific retirement policy or duplicate lifecycle code in the OpenClaw or Hermes plugin.
- Production telemetry expansion beyond the minimum evidence needed by the scoped implementation. The required ordered log is first a deterministic proof artifact, not authority and not a new control plane.
