# Managed Gateway Control-Session Resilience Specification

Date: 2026-08-02
Scope: managed OpenClaw and Hermes Gateway zones

## The user problem

A managed Gateway can remain alive and continue its framework, channel, and model work while its separate controller control session is permanently absent. In the observed Sunfam incident, Discord recovered after the host woke, but Tool VM-backed operations did not. The user saw a responsive agent whose tools remained broken until an operator restart.

The failure is unacceptable because the interruption was finite. Once the host, controller, existing Gateway, and control endpoint are available again, the same Gateway must recover its controller authority automatically. Host sleep or a temporary network interruption may delay recovery; it must not turn a recoverable connection loss into a permanent tools-only outage.

The earlier pre-sleep `sandbox.environment.open` failures are a separate incident. They happened before Tool VM lease or SSH work and are not explained or repaired by this specification.

## Consumers and required outcomes

| Consumer | Required outcome |
| --- | --- |
| Managed-Gateway user | Tool-backed work becomes available again after a finite interruption without restarting OpenClaw, Hermes, or the controller. |
| Running OpenClaw or Hermes session | Its working framework, channel, and model path is preserved while the control connection recovers. |
| Operator or incident responder | Connection loss, retry progress, acceptance, stabilization, and any continuing blocker are distinguishable from framework health and Tool VM lease or SSH health. |

Success means all of the following:

1. A finite controller-to-Gateway control interruption cannot permanently disable Tool VM-backed work.
2. Recovery begins or resumes automatically when execution resumes after sleep or suspension.
3. Recovery retains the current controller, Gateway, process, peer, zone, and attachment authority checks.
4. The same guarantee applies through the shared managed-Gateway path for OpenClaw and Hermes.

## Requirements

### R1 — Recover after any finite interruption

After a managed Gateway has established an accepted control session, if that transport is lost for any finite duration, the system MUST automatically attempt to restore an accepted current control session whenever the host, controller, current Gateway, and control endpoint can run and communicate again.

Elapsed wall-clock time, host sleep duration, or a number of failed connection attempts MUST NOT by itself permanently stop future connection attempts.

### R2 — Resume after sleep or suspended execution

While the host is fully asleep, recovery work is not required to execute. When the host resumes in DarkWake or FullWake, overdue recovery work MUST remain eligible and MUST resume without an operator action or a new user tool call.

A wall-clock jump across a retry threshold MAY change diagnostic severity or make the next attempt immediately due. It MUST NOT convert the recoverable relationship into a terminal exhausted state.

### R3 — Preserve the current Gateway during connection recovery

Control-session recovery for a current Gateway MUST NOT restart or replace the Gateway VM, OpenClaw, or Hermes. It MUST NOT require Gateway startup-secret resolution.

Existing whole-Gateway recovery remains governed by its independent lifecycle and health policy. Control transport loss alone MUST NOT introduce a new broad-replacement policy.

### R4 — Preserve authority and fencing

Every connection attempt MUST use the current controller, Gateway, process, peer, and zone identity and a fresh attachment generation. Only a hello accepted by the current Gateway control endpoint may establish the session.

Stale, mismatched, superseded, or disposed attempts MUST NOT publish control messages, heartbeats, bindings, leases, or other authority. Recovery liveness MUST NOT weaken the existing admission, sequence, source-generation, or ownership fences.

### R5 — Keep recovery single-owner and idempotent

For one current Gateway lifetime, duplicate timer, disconnect, and health-watchdog triggers MUST converge on one effective connection-maintenance activity. They MUST NOT create competing accepted sessions or reset progress in a way that delays an already due attempt.

The connection-maintenance owner remains alive for that exact Gateway lifetime. It becomes dormant while a current session is accepted and resumes dialing when that session is lost. It stops only when the Gateway lifetime is explicitly disposed or superseded.

### R6 — Do not replay application work

Control recovery MUST NOT buffer or replay an interrupted tool or application command unless that command already has independent idempotency authority. A lost or ambiguous in-flight operation retains its existing failure or unknown outcome; reconnecting MUST NOT falsely report it as successful.

### R7 — Expose truthful connection state

Operator-visible evidence MUST distinguish at least:

- attachment lost;
- connection attempt started;
- connection attempt failed or timed out;
- retry scheduled, including the next due time or delay;
- hello accepted or rejected;
- accepted connection stabilizing;
- accepted connection stable;
- recovery owner disposed or superseded.

Evidence MUST include enough redacted zone and Gateway-source correlation to separate current attempts from stale ones. Repeated equivalent attempt outcomes MAY be coalesced when the evidence preserves their count, first and latest observation times, latest bounded outcome, and next retry time. Telemetry is diagnostic and MUST NOT become connection or lifecycle authority.

Zone health MUST NOT report the control relationship healthy when no current accepted session exists. Framework readiness, control-session health, Tool VM binding or lease health, and Tool VM SSH or data-plane health remain separate failure surfaces.

### R8 — Health monitoring is a recovery backstop

If health monitoring observes a stale or absent current control session, it MUST be able to ensure that connection maintenance is active. This action MUST be idempotent and safe when a connection attempt, retry timer, or accepted current session already exists.

When health monitoring is enabled for a managed zone, production composition MUST provide this recovery backstop. Its absence MUST be detectable by automated proof rather than silently disabling recovery. Deliberately disabling health monitoring removes the independent watchdog but MUST NOT disable the manager's primary self-sustaining dial loop.

### R9 — OpenClaw and Hermes parity

R1 through R8 MUST hold for both managed OpenClaw and managed Hermes zones. Framework-specific adapters MUST NOT own or fork the connection-maintenance policy.

## Failure and boundary behavior

| Situation | Required behavior |
| --- | --- |
| Host or VM execution is paused | No timer progress is promised while paused; recovery remains eligible. |
| Host resumes after a long pause | An overdue attempt runs without failing because the pause exceeded an episode deadline. |
| Endpoint remains unavailable | Attempts continue with bounded per-attempt work and capped delay while the Gateway lifetime remains current. |
| Hello is rejected | The attempt is fenced and disposed; later attempts retain current admission rules. |
| A session is accepted and then disconnects | The same recovery owner returns to connection maintenance. |
| Health watchdog fires during an active attempt or scheduled retry | The request is an idempotent no-op or joins existing activity. |
| Current Gateway is disposed or superseded | Its recovery owner and timers stop; all late callbacks and socket results are stale. |
| Tool VM lease or SSH still fails after control returns | Report that distinct failure honestly; do not classify it as a control reconnect failure. |

## Explicit non-goals

- No Gateway-to-controller callback, HTTP POST, or Gateway-initiated control connection.
- No replacement of the identity-owning connection manager as a recovery technique.
- No redesign of whole-Gateway recovery, secret resolution, or 1Password behavior.
- No macOS power-management or lid-close policy change.
- No diagnosis or repair of the separate pre-sleep Tool Portal admission failures or generic UDS error erasure.
- No automatic Tool VM probe, new Tool VM readiness state, or aggregate health API redesign.
- No promise that commands continue executing while the host is asleep.
- No exact global recovery deadline or maximum attempt count. Per-attempt timeout and capped retry delay remain implementation policy provided they cannot terminate the current Gateway's recovery owner.

## Proof obligations

| Proof | Requirements | Evidence required |
| --- | --- | --- |
| V1 Sleep and wall-clock resilience | R1, R2, R5 | Deterministic clock/timer evidence pauses execution beyond the former 60-second/16-attempt boundary, resumes it, and observes a new attempt from the same recovery owner. No wall-clock jump produces terminal exhaustion. |
| V2 Attempt lifecycle and authority | R4, R5 | Automated behavior covers refusal, timeout, accepted hello, disconnect, stale callback, duplicate trigger, source supersession, and disposal. At most one current socket attempt and one accepted current session exist. |
| V3 Health backstop and production wiring | R7, R8 | Real controller composition with health monitoring enabled proves stale health invokes the current Gateway's idempotent recovery entry point; missing wiring fails an automated test. With monitoring disabled, the manager's own loop continues. The existing health-event pipeline exposes the required current transition and coalesced durable evidence without unbounded identical records. |
| V4 OpenClaw recovery | R1–R8 | Production-shaped OpenClaw evidence uses a real controller, Gateway VM, control transport, Tool Portal, Tool VM lease, and SSH/data plane. It interrupts control beyond the former terminal budget, preserves the same Gateway and a normal no-tool framework interaction, restores the endpoint, and completes a fresh non-mutating Tool VM-backed operation without restarting the Gateway or controller. No skip or fake VM/provider boundary satisfies this proof. |
| V5 Hermes parity | R1–R9 | Equivalent production-shaped Hermes evidence exercises the shared connection owner and Hermes normal managed environment/Tool VM path with the same interruption and identity-preservation checks. |
| V6 Outcome honesty | R6 | Cross-process evidence interrupts an operation at an ambiguous point and proves reconnect does not replay it or convert its result to success. |
| V7 Regression | R1–R9 | Existing within-delay reconnect, admission/fencing, control messaging, Gateway lifecycle, Tool VM lease, and SSH/data-plane behavior remains green for both managed frameworks. |

Inventory-only, schema-only, mocked-provider, or skipped E2E results do not satisfy V4 or V5.

## Traceability

```text
responsive agent with permanently dead tools
  -> automatic recovery after finite interruption
     -> R1 R2 R5
        -> V1 V4 V5

working Gateway must survive narrow repair
  -> preserve service and authority
     -> R3 R4 R6
        -> V2 V4 V5 V6

silent failure must be diagnosable and self-correcting
  -> truthful evidence plus watchdog backstop
     -> R7 R8 R9
        -> V3 V4 V5 V7
```

## Governing evidence

Repository source baseline: Git commit `d997cda4421260bbc5f95dcb7e1de8b401e1e0a6`.

- User direction in this design conversation is normative for the required outcome, preservation boundary, OpenClaw/Hermes parity, and narrow complexity budget.
- `tmp/debug-workflows/2026-07-30-agent-vm-openclaw-issues-tool-runner-heartbeat/debug-investigation.md` is observational evidence for the split Discord/control outage and the unobserved reconnect window.
- `packages/agent-vm/src/controller/control-session/gateway-disposable-control-session-client.ts` is observational evidence for the current 60-second/16-attempt terminal episode, per-attempt socket ownership, attachment generations, admission, and stabilization.
- `packages/agent-vm/src/controller/health/gateway-service-health-monitor.ts` and `packages/agent-vm/src/controller/controller-runtime.ts` are observational evidence for the optional dead-control recovery callback and its missing production wiring.
- `packages/control-protocol-contracts/src/index.ts` and `packages/agent-vm/src/controller/control-session/control-session-client.ts` are observational evidence for current per-attempt timeout and capped reconnect backoff.
- `packages/gateway-runtime/src/control-endpoint/gateway-control-session-service.ts` is observational evidence for hello acceptance, identity matching, stale attachment rejection, and supersession.
- `docs/architecture/openclaw-gateway.md` and `docs/subsystems/controller.md` are normative maintainer sources for the managed-Gateway, controller, Tool Portal, lease, and SSH boundaries.

The exact first post-wake socket and hello outcomes remain unobserved because the relevant controller console window was not retained. The design must not claim which individual attempt failed; it must remove the terminal failure class regardless of that missing detail.
