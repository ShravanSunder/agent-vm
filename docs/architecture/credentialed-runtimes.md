# Credentialed Managed Runtimes

[Overview](overview.md) > Credentialed Managed Runtimes

Credentialed Managed runtimes execute configured CLI capabilities that need
controller-projected credentials without giving the CLI controller-host
authority. They are controller-created, agent-owned Managed VMs that may serve
multiple independently authorized RPC calls while compatible and healthy.

This lifecycle belongs only to a `configured_cli` operation whose
`executionTarget.kind` is `ephemeral_managed_vm`. It does not change
`controller_host`, registered actions, Worker VMs, Gateway VMs, or the leased
Tool VM `tool_vm_runner` path.

## Lifecycle Boundaries

```text
Tool Portal RPC call
  ├── current policy and approval decision
  ├── one command/result boundary
  └── cancellation/timeout boundary

Credentialed runtime
  ├── key: zone + authenticated agent
  ├── one active command
  ├── compatible calls reuse the live VM
  └── retirement after 15 idle minutes or explicit containment event

Managed VM
  ├── immutable prepared image containing the CLI
  ├── disposable writable COW rootfs for CLI config/state/cache
  └── exactly one credential projection
      ├── file_binding: finalized read-only memory mount
      └── http_mediation: opaque environment placeholder, no credential mount
```

An RPC call does not own the VM lifetime. Completing one call returns a safe
runtime to idle; it does not authorize a later call. The controller recomputes
current authority immediately before assigning the active command slot. A
denied, stale, cancelled, expired, or incompatible call creates no guest
process and does not renew idle time.

For this target, `ephemeral` means controller-created, non-durable, and
automatically retired. It does not mean one VM per RPC. There is no checkpoint,
snapshot, stopped-runtime restoration, or one-shot compatibility mode.

## Ownership And Compatibility

The controller derives runtime ownership from authenticated Gateway Control
context. Callers cannot select the agent, profile, runtime group, credential
binding, credential reference, image, mount, environment value, or VM identity.

The runtime key is:

```text
zoneId + authenticated agentId
```

Compatibility additionally binds the prepared image and every VM-shaping
input, including credential binding/file mapping, credential discovery
environment, ordinary environment, allowed hosts, and owner epochs. Per-call
argv, reason, timeout, output limits, and approval disposition remain call
authority rather than runtime identity.

Two agents never share a credentialed runtime, even when they use the same Tool
Portal profile. All compatible credentialed operations for one agent share that
agent's single runtime slot. Configuration rejects conflicting VM-shaping
definitions rather than creating another runtime. A compatibility change retires
the idle predecessor before creating a successor.

## Admission And Concurrency

```text
current call authority
        │
        ▼
acquire keyed runtime lock
        │
        ├── owner unsafe ─────────────► fail closed
        ├── active compatible runtime ─► retryable busy
        ├── incompatible/expired idle ─► retire exactly
        ├── healthy compatible idle ───► reuse
        └── absent ────────────────────► create and start
        │
        ▼
final authorization + active-slot reservation
        │
        ├── cancelled/stale/zone closing ─► contain, no dispatch
        └── current ──────────────────────► direct array argv exec
```

There is no queue. A concurrent call for the same agent/runtime gets a
retryable busy result and must be submitted later as a new independently
authorized call. Different agent/runtime keys may execute concurrently.

The in-memory active slot is reserved before durable `current-active`
publication. After that publication, cancellation and the zone fence are
checked again before a command handle is returned. If either changed during
the durable write, the controller contains the VM rather than dispatching a
guest process.

## Credential And Filesystem Boundary

Each configured CLI target declares one strict credential projection. A
`file_binding` projection selects an agent `credentialBinding`, maps its bounded
1Password file references to guest-relative credential files, and maps
controller-owned environment names to the credential root or one credential file.
An `http_mediation` projection instead maps environment names to strict secret
sources and host allowlists; the VM receives opaque placeholders while raw values
remain in host-side Gondolin mediation.

For `file_binding`, the controller resolves the binding only while creating a
runtime, writes the files below `/run/agent-vm/credentials` in a finalizable
memory mount, applies regular-file/read-only/mode-0600 constraints, finalizes
the mount before VM start, and passes only controller-derived discovery paths
to the CLI.

For `http_mediation`, the controller resolves the secret while creating the
runtime and gives Gondolin the raw value plus its exact allowed hosts. The VM
has no credential mount and receives only a random opaque environment
placeholder. Gondolin substitutes the raw value only for matching outbound
requests.

Credential references and bytes never enter Gateway-safe effective config,
runtime records, model-visible results, or Tool VM artifacts. Mutable CLI
state belongs on the disposable COW rootfs, not in credential memory and not in
controller durable state.

## Idle And Retirement

A runtime becomes idle only after its active command reaches a terminal
outcome. Its fixed idle TTL is 15 minutes from that final completion. Reaping
never destroys active work merely because an older idle deadline passed.

The controller retires the runtime when:

- the fixed idle TTL expires;
- an operator requests exact retirement;
- its zone closes, restarts, or loses ownership;
- runtime compatibility changes;
- the recorded host process is missing or has a different identity;
- command completion or containment is unsafe; or
- durable publication cannot support safe continued ownership.

Operators can force immediate replacement of a value behind an unchanged
1Password reference:

```text
agent-vm controller credential-runtime retire \
  --zone <zone> --agent <agentId> [--force]
```

Without `--force`, an active runtime returns retryable `active`. With
`--force`, the controller cancels the active command, waits for its disposition,
and performs exact containment. Other results are idempotent `absent`,
`retired`, or fail-closed `owner-unsafe`. The route reuses zone `adminAccess`;
it is not exposed to the model or Gateway as a lease API.

## Durable Recovery

Non-secret lifecycle records live under:

```text
controllerStateDir/zones/<zoneId>/credentialed-runtimes/<recordId>.json
```

Records publish reservation, creation, VM/process identity, active/idle,
retiring, contained-terminal, and owner-unsafe evidence. They contain runtime
identity and cleanup evidence, never credential references or bytes.

Controller restart adopts no prior VM and replays no command. Recovery checks
the exact recorded pid, command, and process-start identity, terminates only a
matching predecessor, and removes the record only after containment is proven.
Ambiguous ownership leaves an owner-unsafe fence and prevents a successor.
Zone shutdown withdraws the runtime registry, fences new acquisition, drains
active use, and contains child runtimes before destroying the parent Gateway.

## Separation From Tool VMs

```text
configured_cli.ephemeral_managed_vm
  Gateway ─► controller RPC ─► credentialed runtime manager ─► direct argv

tool_vm_runner / Sandbox API
  Gateway ─► leased Tool VM ─► direct strict-pinned SSH
```

Credentialed runtimes do not receive a Tool VM lease, SSH identity, TCP slot,
workspace mount, or Sandbox API handle. Tool VMs do not inherit credentialed
runtime bindings, memory mounts, COW lifecycle, or per-command controller RPCs.

## Source Map

| Owner | Source |
| --- | --- |
| Config and runtime-group compilation | `packages/agent-vm/src/controller/credentialed-runtime/credentialed-runtime-registry.ts` |
| Credential memory materialization | `packages/agent-vm/src/controller/credentialed-runtime/credential-file-materializer.ts` |
| VM creation and direct execution | `packages/agent-vm/src/controller/credentialed-runtime/credentialed-managed-vm.ts` |
| Reuse, active slot, idle TTL, recovery, retirement | `packages/agent-vm/src/controller/credentialed-runtime/credentialed-runtime-manager.ts` |
| Durable lifecycle schema | `packages/agent-vm/src/controller/credentialed-runtime/credentialed-runtime-record.ts` |
| Configured CLI adapter | `packages/agent-vm/src/controller/runner/configured-cli-managed-vm-executor.ts` |
| Operator HTTP/CLI surface | `packages/agent-vm/src/controller/controller-runtime-operations.ts` and `packages/agent-vm/src/cli/controller-operation-commands.ts` |

For authored fields and a Gog example, see
[system.jsonc configuration](../reference/configuration/system-json.md#managed-tool-portal-authored-policy).
For controller route and cleanup details, see
[Controller Subsystem](../subsystems/controller.md). For storage classification,
see [Storage Model](storage-model.md#storage-classes).
