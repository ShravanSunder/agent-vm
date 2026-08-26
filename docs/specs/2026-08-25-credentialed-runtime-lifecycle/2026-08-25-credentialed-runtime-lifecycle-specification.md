# Credentialed Runtime Lifecycle Specification

## Authority and scope

This specification defines the observable configuration, authorization, runtime-lifecycle, isolation, and proof contract authorized by the [Credentialed Runtime Lifecycle Requirements](./2026-08-25-credentialed-runtime-lifecycle-requirements.md).

It refines the existing `configured_cli` `ephemeral_managed_vm` target for credentialed execution. For that credentialed target, it supersedes the August 20 uncredentialed-only and registered-action-promotion-only contract, the prohibition on controller-materialized credential files and a code-owned credential mount, the one-VM-per-call guarantee, and the no-reuse guarantee. It preserves August's configured CLI path/flag admission, direct array argv, timeout, output, exact-intent approval, caller-nonselectable target, caller-nonselectable credentials/mounts/paths/environment, no-host-fallback, Hermes presentation, and leased Tool VM separation.

## Observable context

```text
deployment operator
  ├── assigns each managed agent one Tool Portal profile
  ├── assigns that agent's named 1Password credential bindings
  └── configures credentialed operations with one runtime identity
                         │
                         ▼
authenticated managed agent ── one Tool Portal call ──▶ Agent VM
                         │                              │
                         │                    current policy + approval
                         │                              │
                         │                    per-agent runtime acquire
                         │                              │
                         │                 create or reuse Managed VM
                         │                              │
                         └────────── one active command/result ◀──────┘

observable negative space:
  no caller-selected agent, profile, credential, runtime, VM, or lease
  no runtime sharing between agents
  no credentialed controller-host execution
  no credential copy in controller SQLite
  no stopped-runtime checkpoint or COW snapshot
  no change to leased Tool VM strict-SSH behavior
```

## Normative requirements

### R1 — Credentialed access derives from trusted agent configuration

When a managed agent calls a credentialed configured CLI operation, Agent VM MUST derive the agent identity and Tool Portal profile from the authenticated managed-Gateway caller context. The call MUST be admitted only when all of the following are current:

- the agent is declared by the zone and Tool Portal configuration;
- the agent's assigned profile exposes the namespace and operation;
- the profile's existing `tools` and `calls` policy admits the call;
- the agent declares the named credential binding required by the operation;
- the managed-Gateway framework identity and immutable agent projection match the controller-authenticated principal.

The public or private call payload MUST NOT accept agent id, profile id, credential binding id, credential reference, runtime id, VM identity, or lease identity as caller authority. Unknown agents, missing profiles, missing credential bindings, mismatched framework identity, and forged authority fields MUST fail before runtime acquisition.

Trace: U3, U4, U5, U6 → O3, O4.

### R2 — Agent credential bindings are bounded file sets

Managed Tool Portal configuration MUST extend each agent assignment with an optional strict `credentialBindings` record. Each binding MUST contain a strict non-empty `files` record of at most 16 logical file names. Each file value MUST use the existing 1Password secret-reference shape with exactly `source: "1password"` and an `op://` reference. Logical file names MUST be unique within the binding and match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`; they are not guest paths.

Conceptual authored shape:

```jsonc
{
  "agents": {
    "sun": {
      "profile": "google-enabled",
      "credentialBindings": {
        "google": {
          "files": {
            "service-account": {
              "source": "1password",
              "ref": "<operator-authored 1Password reference>"
            }
          }
        }
      }
    }
  }
}
```

The Tool Portal profile remains the capability-policy assignment. `credentialBindings` selects durable authentication file sources for that agent and MUST NOT act as a second capability allowlist. Assigning two agents to the same profile MUST NOT cause them to share credential bindings, resolved credentials, a Managed VM, or runtime-local state.

Model-visible catalogs, call results, approval displays, diagnostics, and Gateway-safe projections MUST omit credential references and resolved values.

Trace: U5, U6, U10 → O3, O6.

### R3 — A credentialed target declares trusted runtime and binding names

A credentialed `ephemeral_managed_vm` configured CLI operation MUST bind one non-empty authored `runtimeId`, one non-empty `credentialBinding`, and a strict non-empty `credentialFiles` array of at most 16 mappings. Each mapping MUST contain one logical `source` name from the selected agent binding and one unique UTF-8 `path` of at most 256 encoded bytes beneath the code-owned credential root. The path MUST be relative, use `/` separators, and contain only non-empty segments matching `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`; `.` and `..` segments, control characters, symlinks, and duplicate source or destination names MUST be rejected. These are trusted configuration fields and MUST NOT appear in public call input.

Operations with compatible executable, image, runtime policy, and authentication needs MAY use the same `runtimeId` and `credentialBinding`, allowing Calendar, Gmail, Drive, and other Gog operations for one agent to share a runtime. An operation requiring a different authentication identity, image, or incompatible runtime policy MUST use a different effective runtime identity.

A credentialed target with a missing runtime id, missing binding name, binding name absent from the calling agent, missing/mismatched file source, unsafe destination path, or credential source other than 1Password MUST fail before approval dispatch or runtime acquisition.

Trace: U1, U5, U6 → O2, O3.

### R4 — Runtime-group compatibility is separate from per-call authority

All operations sharing one authored `runtimeId` in an effective profile MUST compile to one runtime-group compatibility revision. Configuration MUST reject the group when any member disagrees on a runtime-shaping field. The revision MUST include the controller-derived:

- zone and controller ownership epoch;
- authenticated stable agent identity;
- authored runtime id;
- prepared Managed VM image identity and fingerprint;
- rootfs mode, code-owned resources, mount policy, and credential root;
- allowed hosts and VM-level environment policy;
- agent credential-binding name, authored binding revision, and credential-file mapping.

The runtime-group revision MUST exclude command paths, flag rules, approval disposition, reason, argv, stdin, command timeout, output bounds, and guest cwd when those remain per-call execution policy rather than VM-construction authority. Every call continues to bind its complete current operation policy through the existing per-call semantic revision and approval/direct authority.

The controller MAY reuse an existing runtime only when the complete runtime-group revision matches and current health and containment evidence remains trustworthy. Agent identity MUST always participate in compatibility, even when two agents share the same profile and runtime id. A runtime-group change MUST prevent reuse and retire or fence the old runtime. A per-call-only policy change MUST stale the affected call authority but MUST NOT retire an otherwise compatible runtime.

Trace: U2, U3, U6, U9 → O2, O8.

### R5 — Every RPC remains independently authorized

Each Tool Portal item remains one independently admitted command. Immediately before atomically acquiring the runtime's single active-command slot, the controller MUST recompute current profile visibility, configured CLI admission, exact approval intent or direct authority, timeout, and runtime-group compatibility.

Only a call that has reached final controller admission MAY acquire or reuse the runtime and attempt to acquire its active-command slot. A call that is denied, pending approval, expired, cancelled, stale, malformed, missing current authority, or rejected for credential/runtime incompatibility MUST:

- create no runtime;
- renew no runtime idle deadline;
- register no active command;
- execute no guest process;
- produce a bounded proven-not-dispatched result under the existing Portal result contract.

Approval of one call MUST NOT approve, reserve, or admit a later call that reuses the same runtime.

Trace: U3, U4 → O1, O4.

### R6 — Compatible admitted calls create or reuse one Managed runtime

After final call admission, the controller MUST acquire the compatible runtime for the authenticated agent and runtime identity:

- if no compatible live runtime exists, it MUST establish a new controller-owned Managed VM;
- if one compatible live runtime exists within its idle window, it MUST reuse that runtime;
- if the compatible runtime already has an active command, it MUST return the retryable busy result defined by R7 without renewing the runtime, creating another VM, or retaining work for later dispatch;
- if a prior runtime is expired, incompatible, unhealthy, fenced, or retired, it MUST NOT be reused;
- if prior containment or ownership is ambiguous, the call MUST fail rather than adopt the runtime or silently create an unsafe successor.

Runtime acquisition MUST NOT expose the Managed VM identity or a lease handle to Hermes, Gateway Runtime public input, the model, or the agent. Those consumers receive only the existing per-call capability result.

Trace: U1, U3, U9 → O1, O2, O8.

### R7 — A busy runtime rejects rather than queues

At most one configured CLI command MAY execute at a time inside one credentialed runtime. If another call reaches final admission while that runtime has an active command, Agent VM MUST return a bounded retryable `runtime_busy` result that is proven not dispatched.

The busy call MUST NOT enter a queue, wait for a turn, renew the idle deadline, reserve future execution, or dispatch after its response. Retrying is a new Tool Portal call that repeats current visibility, policy, approval, and compatibility checks. Its full command timeout begins only if that new call acquires the active-command slot and guest execution begins. Commands using different agent runtimes MAY execute concurrently.

Runtime-local CLI and authentication state produced by a completed command MUST be visible to the next compatible command in that runtime. A failed, timed-out, or cancelled command MAY make the runtime ineligible for reuse if current health or state safety cannot be established; the system MUST NOT automatically replay that command.

Trace: U2, U7, U9 → O5, O8.

### R8 — 1Password materializes authentication without controller credential storage

When creating a credentialed runtime, the controller MUST resolve every referenced file in the authenticated agent's configured 1Password binding. Each resolved value MUST be valid UTF-8 and at most 1,048,576 encoded bytes; the binding's total resolved content MUST be at most 4,194,304 encoded bytes. The controller MUST materialize each value at its validated configured relative path beneath one code-owned memory-backed credential root supplied only to that Managed VM. The guest mount MUST be root-owned and hardened read-only; credential files MUST be regular files with mode `0600`. Credential files MUST NOT be written into the rootfs/COW overlay.

The resolved credential value MUST NOT be written to:

- controller SQLite;
- runtime identity or lifecycle records;
- approval records;
- effective Tool Portal configuration;
- model-visible output or diagnostics;
- the ordinary leased Tool VM workspace.

Controller records MAY retain the non-secret authored binding revision, logical file names, destination paths, and lifecycle metadata needed to decide compatibility without retaining credential bytes or a content-derived secret fingerprint. Destroying the runtime MUST remove its memory-backed credential files. A new runtime MUST resolve its durable authentication material from 1Password again.

1Password values are resolved only when creating a runtime. Changing the authored binding or file mapping MUST change the runtime-group revision and retire or fence the old runtime. Changing only the value behind an unchanged `op://` reference is not polled while the runtime is live; it becomes effective on the next runtime creation. An operator requiring immediate replacement MUST explicitly retire that agent runtime. Runtime-local CLI caches and mutations are disposable. This release does not promise credential writeback to 1Password or persistence of runtime-mutated authentication state after retirement.

Trace: U2, U10 → O6.

### R9 — Idle time begins after the final active command

The credentialed runtime idle TTL MUST be the code-owned fixed value 900,000 ms. Configuration and callers MUST NOT override it in this release.

A runtime is active from immediately before its guest command begins until that command reaches its terminal execution outcome and required result cleanup has completed. While active, the runtime MUST NOT be retired by the idle policy. When the final active command ends, the runtime becomes idle and its 15-minute deadline begins.

An admitted compatible call that starts execution before the idle deadline MAY reuse the runtime. Runtime acquisition and the new active command MUST atomically prevent an idle reaper from retiring that runtime. A call arriving after idle expiry MUST not revive the expired runtime; after safe retirement it receives a newly established compatible runtime.

Trace: U7, U8 → O5, O7.

### R10 — Invalidation and lifecycle events retire or fence the runtime

The controller MUST prevent new calls and initiate retirement or access fencing when any of the following occurs:

- the fixed idle TTL expires with no active command;
- the operator explicitly retires the runtime or revokes/reconfigures its credential binding;
- the agent assignment, runtime identity, image fingerprint, authored credential-binding revision, credential-file mapping, or another runtime-group revision input changes;
- the zone stops or restarts;
- controller ownership is lost or replaced;
- VM health, process identity, or containment evidence becomes untrustworthy.

Normal retirement MUST wait for an active command to reach its independently governed terminal boundary. Controller shutdown, explicit force retirement, or loss of trustworthy containment MAY cancel active work under existing controller-owned cancellation authority. A forced or failed retirement MUST NOT yield runtime adoption or replay authority.

After retirement, the old runtime identity may remain only as non-secret lifecycle evidence and MUST be rejected for later calls.

Trace: U8, U9 → O7, O8.

### R11 — Credentialed execution remains inside a Managed VM

Credentialed configured CLI commands MUST execute inside the acquired Managed VM using direct array argv without shell evaluation. They MUST NOT execute through `controller_host`, inherit the controller process's host filesystem authority, or reuse the caller's leased Tool VM.

The runtime MUST expose no agent SSH, Tool VM lease, caller-selected mount, arbitrary host path, credential-maintenance surface, or VM handle. Network, environment, cwd, stdin, stdout, stderr, timeout, and executable authority remain controller-derived under the existing configured CLI contract.

The existing `tool_vm_runner` backend MUST remain the separate Gateway-owned path to the caller's current leased Tool VM over strict SSH. Credentialed runtime lifecycle changes MUST NOT route `tool_vm_runner` through the controller execution RPC or credentialed Managed VM.

Trace: U3, U11 → O9.

### R12 — `ephemeral_managed_vm` uses the reusable meaning by hard cutover

For a credentialed configured CLI target, `ephemeral_managed_vm` MUST mean a controller-created, non-durable Managed runtime retained across independently authorized compatible calls and retired by controller lifecycle policy.

The prior guarantee of one fresh VM per operation is superseded for this credentialed target. Configuration MUST NOT add a `per_call` lifetime, one-shot compatibility flag, second target kind, or fallback from reusable runtime acquisition to controller-host execution.

Existing uncredentialed `ephemeral_managed_vm` deployment compatibility is not promised by this correction because repository evidence found no current deployment consumer. If a real consumer is identified before implementation, compatibility becomes a new owner decision rather than an inferred second mode.

Trace: U1, U12 → O10.

### R13 — The runtime uses a prepared CLI image and disposable rootfs/COW

The credentialed Managed VM MUST start from the controller-prepared immutable image already bound by the configured CLI target. The configured executable MUST be present in that image before runtime acquisition; establishing a runtime MUST NOT install, download, or update the CLI or its dependencies.

The runtime MUST use the normal writable rootfs/COW overlay for CLI working files, caches, and other non-credential runtime writes. Rootfs writes MAY remain visible while that VM is retained, but the overlay MUST be deleted when the VM closes and MUST NOT be checkpointed, restored, or adopted by a later runtime. Memory-backed storage is reserved for the credential surface defined by R8; no `rootfsMode: "memory"` requirement is introduced.

Provider or image caching performed before agent-specific credentials and mutable runtime state are introduced MAY accelerate VM creation. Such caching MUST remain an immutable-image concern and MUST NOT preserve a stopped agent runtime.

Trace: U2, U10, U13 → O6, O11.

## C1 — Observable runtime lifecycle

```text
call received
  → authenticate managed agent
  → resolve assigned profile and agent credential binding
  → validate call policy and exact approval/direct authority
  → resolve current runtime compatibility
      ├── compatible live runtime ──► reuse
      ├── none or safely retired ──► create rootfs/COW VM from prepared image
      └── ambiguous predecessor ───► reject
  → atomically revalidate and acquire active-command slot
      ├── slot busy ──► retryable runtime_busy; zero effects
      └── slot free ──► begin active command
  → execute direct argv inside Managed VM
  → finish result and active command
  → runtime idle for 15 minutes
      ├── compatible admitted call ──► active again
      └── idle deadline ─────────────► retire
```

## C2 — Configuration and access contract

The authored configuration relationship is:

```text
agents.<agentId>
  ├── profile ───────────────► profiles.<profileId>
  │                              └── namespaces / tools / calls
  └── credentialBindings
         └── <bindingId>.files
                └── <sourceName> ──► 1Password SecretRef

configured_cli.executionTarget
  ├── kind: ephemeral_managed_vm
  ├── runtimeId
  ├── credentialBinding ──────► current agent's bindingId
  └── credentialFiles
         └── sourceName ──────► relative path below credential root
```

Profiles may be shared as policy. Credential bindings and runtime instances are agent-specific. Assigning another agent to a profile grants that profile's capabilities but does not supply a required credential binding; the second agent must receive its own explicit binding before credentialed calls can execute.

## C3 — Failure and result contract

| Condition | Observable result | Runtime effect |
| --- | --- | --- |
| Agent/profile/credential binding not authorized | Proven not dispatched | No create, renew, or guest execution |
| Approval pending, denied, expired, or stale | Existing bounded Portal outcome | No create, renew, or guest execution |
| Compatible runtime idle and healthy | Normal per-call result | Same VM reused; idle deadline resets after command completes |
| No compatible runtime | Normal per-call result or bounded setup failure | One new per-agent VM established; no fallback to host |
| Same-runtime concurrent call | Retryable `runtime_busy`, proven not dispatched | No queue, renewal, reservation, VM creation, or late execution |
| Different-agent calls | Independent per-call results | Separate runtimes may execute concurrently |
| Idle TTL expires | Later call creates a new runtime | Old runtime retired; runtime-local state removed |
| Runtime-group revision changes | Current call re-evaluated; stale compatibility rejected | Old runtime fenced/retired; never reused |
| Per-call-only policy changes | Existing stale-authority result for affected call | Compatible runtime may remain; no stale call dispatch |
| Guest command fails, times out, or is cancelled | Existing target-specific bounded or ambiguous result | No automatic replay; reuse only if runtime remains trustworthy |
| Retirement/containment cannot be proven | Ambiguous/forbidden retry under existing Managed VM result contract | Runtime remains fenced; no adoption or unsafe successor |
| 1Password resolution fails | Bounded setup failure, proven before guest execution | No credential copy persisted; no fallback credential source |
| Runtime retirement | Existing bounded retirement result | VM closes; rootfs/COW overlay is deleted; no checkpoint or restore artifact is produced |

## Cross-cutting obligations

- **Security:** Credential access is default-deny, per authenticated agent, and non-caller-selectable. Credential bytes remain limited to resolution and the runtime-local Managed VM boundary.
- **Privacy:** Credential values and references are absent from model-visible catalogs, approvals, results, logs, diagnostics, and telemetry. Native human identity remains governed by the existing Hermes approval contract.
- **Reliability:** Runtime reuse never carries authorization, never queues a busy call for late execution, never revives an expired runtime, and never adopts an ownership- or containment-ambiguous predecessor.
- **Performance:** No new command-start latency threshold is promised. The required improvement is observable reuse within the fixed idle window rather than one VM creation per call.
- **Operability:** Operators can determine, without credential disclosure, which agent/runtime identity is active, idle, retired, or fenced and why it became incompatible.
- **Data lifecycle:** Durable authentication remains in 1Password. Runtime-local authentication files live only in the memory-backed credential surface; CLI working files and caches live in rootfs/COW. Both end with the runtime. Non-secret lifecycle evidence may outlive it under existing controller retention policy.
- **Startup and retirement cost:** Runtime acquisition performs no CLI installation and retirement performs no checkpoint or snapshot export. No numeric latency threshold is promised until measured evidence establishes one.
- **Compatibility:** The configured CLI admission, approval, Hermes presenter, result, and leased Tool VM contracts remain unchanged except for the credentialed Managed VM lifecycle and agent credential-binding configuration defined here.

## Proof obligations

| ID | Observable obligation | Evidence class |
| --- | --- | --- |
| V1 | Configuration accepts agent-specific bounded 1Password file sets and credentialed target file mappings, and rejects missing agents/profiles/bindings/sources, non-1Password sources, unsafe or duplicate paths, excess files or bytes, unknown fields, and caller-authored authority. | Automated schema behavior and generated-schema inspection |
| V2 | Trusted Hermes agent identity selects exactly its immutable Tool Portal profile and credential binding; undeclared, mismatched, or forged identities dispatch zero effects. | Cross-process authorization integration and misuse cases |
| V3 | Two compatible Gog operations for one agent reuse the same Managed VM while each independently follows direct or approval-required policy. | Controller/Tool Portal integration with runtime identity and effect observation |
| V4 | Two agents assigned the same profile require separate credential bindings and receive distinct runtime identities, credential-materialization surfaces, mutable state, and VMs. | Cross-process integration with per-agent state and VM observations |
| V5 | A concurrent same-runtime call returns retryable `runtime_busy`, is never queued or dispatched later, and leaves the active command independent; different agent runtimes can overlap. | Deterministic concurrency integration with zero-effect and overlap observation |
| V6 | Denied, pending, expired, cancelled, stale, missing-binding, and busy calls create no VM, do not touch an idle deadline, and execute no guest process. | Controller/approval/runtime integration with zero-effect counters |
| V7 | A completed command's runtime-local state is visible to the next compatible command and absent from a new runtime after retirement. | Real Managed VM state inspection across calls and retirement |
| V8 | Active work survives idle-reaper passes; reuse before 900,000 ms retains the VM; expiry after 900,000 idle ms retires it; a later call creates a new VM. | Deterministic clock integration plus real Managed VM lifecycle evidence |
| V9 | Every enumerated runtime-group input change prevents reuse, while a per-call-only policy change stales call authority without unnecessary runtime retirement; ambiguous containment blocks adoption and unsafe succession. | Table-driven compatibility behavior plus controller/VM lifecycle integration |
| V10 | Runtime creation resolves the correct bounded 1Password file set, enforces paths, sizes, and modes, exposes it only inside the memory-backed credential surface, writes no credential value into rootfs/COW, and stores no credential value or secret-derived fingerprint in SQLite, effective config, runtime records, logs, or results. An unchanged live binding is not re-resolved; explicit retirement causes the next VM to receive the changed value. | 1Password E2E, state inspection, rotation/retirement transcript, and leakage/misuse analysis |
| V11 | Hermes receives per-call results and approval interactions but no runtime lease, VM identity, credential reference, or credential value. | Real Hermes interaction and private-contract inspection |
| V12 | Real credentialed configured CLI execution occurs in a Managed VM, cannot observe a controller-host sentinel, uses direct argv, and never enters leased Tool VM SSH. | Real Managed VM E2E plus host-sentinel and Tool VM regression evidence |
| V13 | Hard-cut configuration and runtime behavior provide no one-shot lifetime, second target, host fallback, or compatibility alias. | Generated-schema inspection, static boundary inspection, and runtime target observation |
| V14 | A real runtime starts with the configured CLI already present, uses the normal rootfs/COW overlay, performs no runtime installation or checkpoint, retains a rootfs marker only during that lease, and exposes no marker after retirement and replacement. | Real Managed VM lifecycle and filesystem observation |

Requirement coverage:

| Authorized needs | Problem | Outcomes | Requirements | Observable contract | Proof |
| --- | --- | --- | --- | --- | --- |
| U1, U2 | P1 | O1, O2, O5 | R3–R7 | C1, C2 | V3, V5, V7 |
| U3, U4 | P1 | O1, O4 | R1, R5, R6 | C1, C3 | V2, V6, V11 |
| U5, U6 | P2 | O3 | R1–R4 | C2 | V1, V2, V4 |
| U7, U8 | P1 | O5, O7 | R7, R9 | C1, C3 | V5, V8 |
| U9 | P1 | O8 | R4, R6, R10 | C1, C3 | V9 |
| U10 | P4 | O6 | R2, R8 | C2, C3 | V10 |
| U11 | P3 | O9 | R11 | C1, C3 | V12 |
| U12 | P1 | O10 | R12 | C1, C2 | V13 |
| U13 | P1 | O11 | R13 | C1, C3 | V14 |

## Undefined behavior and negative space

- No same-runtime command queue or fairness order exists. A busy response has zero future execution authority.
- No durable persistence is promised for CLI caches or runtime-mutated authentication state.
- No generic credential rotation, writeback, interactive OAuth, or credential-maintenance API is defined.
- No live runtime polls unchanged 1Password references. Immediate credential replacement requires explicit runtime retirement.
- No runtime is shared across agents. A future shared-service-account runtime requires a new owner-authorized contract.
- No configurable idle TTL, per-call lifetime, host fallback, or second credentialed execution target exists.
- No externally callable runtime create, renew, list, adopt, or lease API is defined for Hermes or the model.
- No COW checkpoint, stopped-runtime snapshot, hibernation, restore, or per-agent rootfs cache is defined.
- No change is made to ordinary controller-host configured CLI execution, registered actions, or `tool_vm_runner` strict-SSH semantics.
