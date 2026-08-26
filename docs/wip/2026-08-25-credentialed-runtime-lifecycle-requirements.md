# Credentialed Runtime Lifecycle Requirements

Status: WIP requirements correction. This document records product intent,
boundaries, and missed design context. It is not a Specification, Program
Design, or implementation plan.

## Problem

Agent VM needs to expose approved external CLIs whose authentication depends on
local credential files, keyrings, refresh state, or similar runtime state. The
agent must be able to invoke those CLIs repeatedly through Tool Portal without
receiving raw credentials or direct control over the credentialed runtime.

The currently shipped `configured_cli` Managed VM target creates a fresh VM for
each invocation and destroys it when that invocation ends. That behavior makes
the RPC call the runtime-lifecycle boundary. It does not match the intended
model in which Tool Portal admits multiple independent calls into one
controller-owned, temporarily retained capability runtime.

The practical effect is repeated VM startup and repeated credential-state
materialization for consecutive calls that belong to the same authorized agent
and capability. It also prevents CLI-maintained runtime state from remaining
available across those calls.

## Affected Users And Stakeholders

| ID | Class | Need or outcome | Why it matters | Priority | Authority |
| --- | --- | --- | --- | --- | --- |
| U1 | Agent user | Repeated approved calls to the same credentialed CLI should use a compatible live runtime instead of starting a new VM for every request. | Interactive tool use commonly involves several related calls, and repeated startup adds avoidable latency and churn. | Must | Owner-authorized clarification, 2026-08-25 |
| U2 | Deployment operator | The controller must remain the authority over creation, reuse, retirement, and destruction of credentialed runtimes. | The model or framework must not gain VM, lease, credential, filesystem, or lifecycle authority. | Must | Owner-authorized clarification, 2026-08-25 |
| U3 | Security operator | Reusing a runtime must not weaken per-call Tool Portal policy, approval, identity, or argument admission. | Runtime reuse is an execution optimization and state boundary, not reusable authorization. | Must | Existing Tool Portal authority model and owner clarification, 2026-08-25 |
| U4 | Agent user | Credential-dependent CLI state needed by consecutive calls should remain available while the compatible runtime is retained. | File- and keyring-oriented CLIs such as `gog` expect local state and may update it during ordinary operation. | Must | Earlier credentialed-runner designs plus owner clarification, 2026-08-25 |
| U5 | Deployment operator | An unused credentialed runtime must be retired automatically after a bounded idle period. | Credentialed runtimes should not remain alive indefinitely when they are no longer serving requests. | Must | Earlier credentialed-runner designs plus owner clarification, 2026-08-25 |
| U6 | Security operator | Active work must not be destroyed merely because an idle deadline passes. | Long-running approved calls need a live runtime until they finish or reach their independently authorized timeout or cancellation boundary. | Must | Existing active-use lease model retained as an outcome requirement |
| U7 | Deployment operator | A runtime whose authorization-relevant identity is no longer compatible must not be reused. | Changes to the agent, capability, policy, image, credentials, or controller ownership may invalidate the prior runtime boundary. | Must | Existing controller and Tool VM lease safety model retained as an outcome requirement |

## Required Outcomes

### O1 — RPC Calls And Runtime Lifetimes Are Separate

One Tool Portal call is one independently admitted operation. Completion of a
call does not by itself require destruction of the compatible credentialed
runtime that executed it.

### O2 — Compatible Calls Reuse A Live Runtime

When an authorized agent makes another call to the same compatible
credentialed capability while its runtime remains available, the system reuses
that runtime. The agent does not select the runtime or provide its identity.

### O3 — Every Call Retains Independent Authorization

Runtime reuse does not carry forward visibility, argument admission, denial,
approval, timeout, or cancellation authority from an earlier call. Each call
must independently satisfy the current Tool Portal and controller policy before
execution.

### O4 — Credential State Is Available Only Within Its Authorized Runtime Scope

Credential files and mutable CLI authentication state needed for execution may
remain available for the lifetime of the compatible credentialed runtime. They
must not become agent-visible, model-visible, part of the ordinary Tool VM
workspace, or selectable through caller-supplied paths, environment values, or
credential references.

This outcome does not select a filesystem provider, database, encryption
scheme, secret store, mount layout, or materialization mechanism.

### O5 — Idle Runtimes Retire Automatically

After the last active use ends, a bounded idle period begins. A compatible call
during that period may reuse the runtime and renew its idle period. If the idle
period expires with no active work, the controller retires the runtime and its
live credential state.

The owner has proposed 15 minutes as the initial idle period. Whether that
value is fixed, configurable, or bounded by policy remains unresolved and is
not established by this Requirements document.

### O6 — Active Work Prevents Idle Retirement

A runtime with one or more active uses is not considered idle. Idle retirement
may begin only after every active use has reached a terminal outcome.

### O7 — Incompatible Or Untrusted Runtimes Are Not Reused

The controller must reject reuse when it cannot prove that the existing runtime
still belongs to the current authorized agent and capability context. A stale,
incompatible, unhealthy, or ownership-ambiguous runtime must not receive a new
call.

### O8 — Controller Lifecycle Events Bound Runtime Survival

Credentialed runtimes are temporary controller-owned resources. They do not
gain a right to survive controller or zone lifecycle events, explicit
retirement, authorization changes, or loss of trustworthy containment evidence.

## Boundaries And Non-Goals

- This work does not create a generic credentialed shell.
- The agent does not receive SSH, filesystem browsing, arbitrary process, VM,
  lease, or credential-maintenance access to the credentialed runtime.
- Runtime reuse does not authorize a command, flag, argument, write, or network
  destination that current Tool Portal policy would otherwise deny or require
  approval for.
- This document does not require preserving the shipped one-VM-per-call
  behavior as a separate compatibility mode.
- This document does not decide whether credentialed runtime support belongs to
  `configured_cli`, another Tool Portal backend, or a distinct internal runtime
  abstraction.
- This document does not select RealFS, an in-memory VFS, SQLite, controller
  process memory, `stateDir`, 1Password, or another credential-storage design.
- This document does not decide credential refresh, rotation, or durable
  writeback behavior.
- This document does not define an artifact-transfer system or cross-command
  workflow composition.
- Existing ordinary Tool VM and controller-host execution behavior is outside
  this correction unless a later Specification explicitly changes it.

## What Was Missed

The August configured-CLI design treated `ephemeral_managed_vm` as explicitly
operation-scoped. Its Requirements, Specification, Program Design, and proof
obligations all required one fresh VM per invocation with no lease or reuse.
The implementation therefore matches that design.

That design did not reconcile its one-shot lifecycle with the repository's
earlier credentialed-runner work:

- `docs/superpowers/plans/2026-05-20-credentialed-tool-system.md` records the
  need for both per-call and warm-lease credentialed runtimes, makes a short
  warm lease the default for provider tools, names `gogcli` as an initial
  consumer, and separates the agent-callable execution path from protected
  credential maintenance.
- The historical
  `docs/superpowers/plans/2026-05-22-credentialed-runner-v1.md`, introduced by
  commit `844bc478`, was an executable follow-up centered on controller-owned
  warm runner leases, active uses, idle expiry, Gondolin RPC execution, and
  controlled credential state. It was deleted unimplemented during the July 4
  Socket.IO control-plane cutover in commit `af018d29`.
- Earlier May 11 and May 15 plans explored per-call runners. The May 20 design
  explicitly superseded that as the only lifecycle by supporting both modes and
  selecting warm leases as the default for ordinary provider tools.

The August design was scoped around generic configured CLI execution and
approval presentation. It explicitly excluded credential profiles and a new
credential authority. In doing so, it introduced a one-shot Managed VM target
without carrying forward or explicitly rejecting the already documented
multi-request credentialed-runtime requirement.

The missed reconciliation matters because the two designs use the word
"ephemeral" differently:

- In the broader Agent VM lease model, an ephemeral VM is created on demand,
  retained temporarily, and destroyed by controller lifecycle policy.
- In the August configured-CLI model, an ephemeral VM is created and destroyed
  for one operation.

The corrected meaning for credentialed Tool Portal runtimes is the former:
temporary and controller-retired, but reusable across independently authorized
requests while compatible and live.

## Evidence Expected From A Future Specification

A later Specification should make the required observable behavior precise
enough to prove at least the following without prescribing internal structure
in this document:

- Two compatible consecutive calls can execute through the same live
  credentialed runtime.
- Each reused call is independently admitted under current policy and approval
  requirements.
- Credentialed runtime state remains unavailable to the agent and ordinary Tool
  VM surfaces.
- Active work prevents idle retirement.
- An idle runtime is eventually retired after the effective idle period.
- A call after retirement receives a newly established compatible runtime.
- A call does not reuse a runtime after an authorization-relevant compatibility
  change or loss of trustworthy ownership evidence.
- Controller or zone shutdown does not leave an adoptable credentialed runtime
  outside controller ownership.

## Open Requirements Questions

1. Is 15 minutes the required default idle period, or only the first deployment
   preference?
2. Must different approved command families for the same provider share runtime
   state, or is reuse scoped more narrowly?
3. Which credential-state changes, if any, must survive runtime retirement?
4. Is an explicitly requested per-call lifecycle still a required high-risk
   option, or should the corrected system expose only controller-retained
   runtimes with bounded idle retirement?
5. What externally observable operator action must force immediate retirement
   after credential revocation or reconfiguration?
