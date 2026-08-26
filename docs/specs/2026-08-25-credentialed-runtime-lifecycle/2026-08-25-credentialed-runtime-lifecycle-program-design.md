# Credentialed Runtime Lifecycle Program Design

## Governing contract

- [Requirements](./2026-08-25-credentialed-runtime-lifecycle-requirements.md)
- [Specification](./2026-08-25-credentialed-runtime-lifecycle-specification.md)

The fixed outcome is one controller-owned credentialed Managed VM runtime per authenticated agent and authored runtime identity. Every Tool Portal call remains independently authorized. One live command occupies the runtime; a concurrent same-runtime call returns retryable `runtime_busy`. A successful runtime remains reusable until 15 idle minutes elapse. Credential files are resolved from the agent's 1Password-backed file binding into a read-only finalizable memory mount; ordinary CLI working state remains in disposable rootfs/COW. Retirement discards both.

This design changes no `controller_host`, registered-action executor, Hermes approval presenter, or `tool_vm_runner` strict-SSH behavior. It adds no external lease API, shared-agent runtime, queue, credential database, writeback path, checkpoint, or compatibility mode.

## Current system and required deltas

| Current owner | Current behavior | Required delta |
| --- | --- | --- |
| Managed Tool Portal config contracts | An agent assignment contains only `profile`; configured `ephemeral_managed_vm` is uncredentialed and operation-scoped. | Add controller-only agent credential file bindings and runtime-group/file-mapping target policy; safe projections omit every binding and path. |
| Effective Tool Portal materializer | Persists a complete effective Tool Portal config and derives Gateway-safe catalog/admission material. | Split controller-only credential/runtime registry from the persisted Gateway-safe effective config. Never persist credential refs in effective artifacts. |
| Controller execution authorization | Derives the trusted agent/profile, current operation, approval/direct authority, binding revision, and per-call fingerprint. | Return the controller-only credentialed runtime resolution context beside the existing authorized operation. Keep per-call authority unchanged. |
| Configured Managed VM executor | Revalidates, creates one operation ledger entry, creates one VM, executes once, proves containment, and closes. | Acquire a per-agent runtime command slot, execute on a retained VM, and complete/release the active slot without closing a healthy compatible runtime. |
| Managed VM runner factory | Creates code-owned COW/no-mount/no-SSH one-shot VMs and drains bounded output. | Create COW VMs with one read-only finalizable memory credential mount, finalize credentials before start, and expose a retained controller-only handle. |
| Controller runner operation ledger | Owns one operation-to-one-VM creation, dispatch, result, and containment. | No longer owns configured credentialed execution. A runtime record owns VM-lifetime crash cleanup; the existing per-call approval ledger continues to own call dispatch authority. |
| Tool VM lease manager | Reuses per-agent VMs with SSH, TCP slots, workspace/Git roots, Gateway bindings, active-use heartbeats, and idle retirement. | Intentionally unchanged. Credentialed runtimes reuse its lifecycle semantics and generic idle helper, not its SSH/workspace authority types. |
| Managed VM provider | Supports COW roots, `finalizable-memory` mounts, pre-start file finalization, direct argv exec, process identity, and exact termination. | Reuse unchanged capabilities. No provider extension is required. |
| Secret resolver | Resolves `SecretRef` and batches 1Password references to strings. | Reuse unchanged; the credential materializer supplies validation, bounds, path mapping, and byte conversion. |

Current configured Managed VM execution path:

```text
Gateway Control configured_cli
  → controller authorization
  → configured-cli-managed-vm executor
  → operation ledger reserve
  → create/start one Managed VM
  → final authorization reload
  → vm.exec
  → close/exact termination
  ← one bounded result
```

Current Tool VM lease path, intentionally preserved:

```text
Gateway Runtime tool_vm_runner
  → Gateway Control lease create/renew/active-use
  → Tool VM lease manager
  → TCP slot + SSH + workspace/Git bindings
  → direct Gateway-to-Tool-VM strict SSH
```

## Structural crux and alternatives

The crux is where reusable runtime lifecycle authority should live without importing Tool VM access authority or duplicating a second external lease plane.

| Alternative | Gain | Cost and failure exposure | Disposition |
| --- | --- | --- | --- |
| Generalize the Tool VM lease manager for both runtimes | Maximum code reuse of durable authority and active-use machinery. | Forces credentialed execution through abstractions shaped around SSH, TCP slots, workspace/Git roots, Gateway-published bindings, heartbeat recovery, and external lease RPCs; expands regression surface far beyond the required behavior. | Rejected for this delivery. |
| Retain one-shot runner and add COW checkpoint/restore | Reuses current operation ledger and can appear fast after first run. | Persists stopped-agent runtime state, conflicts with 1Password-only durability, and keeps RPC/VM lifetime coupling hidden behind snapshots. | Rejected by contract. |
| Controller-local credentialed runtime lease manager | Keeps Tool VM path untouched; directly owns per-agent reuse, busy admission, exact VM lifecycle, and idle retirement; reuses Managed VM and idle/termination primitives. | Adds one narrow internal manager and runtime-record type. Controller/runtime maintainers own that cost. | Selected. |

The selected manager is not a second public lease system. It has no Gateway/model lease contract, renewal RPC, SSH binding, or caller-visible lease id. “Lease” describes controller-owned lifetime state only.

Revisit generalizing a shared lease core only if a third controller-local reusable Managed VM consumer needs the same lifecycle or if duplicated lifecycle logic becomes materially larger than the Tool VM coupling avoided here.

## Integrated system

```text
authored tool-portal.config.jsonc
  agents.<agent>.credentialBindings.files ── 1Password refs
  configured_cli.executionTarget
    runtimeId + credentialBinding + credentialFiles
                           │
                           ▼
Credentialed Runtime Config Compiler
  validates agent bindings, file maps, runtime groups
  computes runtime-group revision
           ┌───────────────┴─────────────────┐
           ▼                                 ▼
controller-only registry              Gateway-safe projection
  binding refs + file maps             profile + catalog/call policy
  runtime-group authority              no refs/paths/runtime identity
           │                                 │
           │                          Tool Portal call/approval
           │                                 │
           └───────────────┬─────────────────┘
                           ▼
controller current-call authorization
                           │
                           ▼
Credentialed Runtime Lease Manager
  key: zone + agent + runtimeId
  lock: one lifecycle/active-slot mutation at a time
  create | reuse | busy | retire
           │
      create only
           ▼
Credential File Materializer
  resolveAll(1Password refs)
  validate bytes and relative paths
  finalize read-only memory mount before VM start
           │
           ▼
retained Managed VM
  prepared image with CLI
  rootfs/COW working state
  /run/agent-vm/credentials read-only memory mount
  no SSH, Tool VM lease, TCP hosts, mediation, or host mounts
           │
           ▼
one direct argv command
  success/observed exit ──► release slot; retain runtime
  uncertain failure ──────► fence and retire runtime
  15 idle minutes ────────► retire runtime
```

## Components and singular ownership

| Component | Sole ownership | Consumers | Reason to change |
| --- | --- | --- | --- |
| Credentialed Runtime Config Compiler | Agent binding validation, runtime-group membership, file-map validation, controller-only group revision, and safe projection omission | Effective-config materializer, controller registry, semantic revision owner | Authored credential/runtime contract changes. |
| Controller Credentialed Runtime Registry | Current atomic mapping from agent/profile/operation to runtime group and unresolved 1Password file refs | Controller authorization and runtime manager | Current controller-only policy generation changes. |
| Credential File Materializer | Batched secret resolution, UTF-8/size validation, logical-name to relative-path mapping, fixed permissions, and pre-start finalization | Runtime manager | Credential file contract or materialization limits change. |
| Credentialed Runtime Lease Manager | Per-key lock, compatible runtime map, active-command slot, creation/reuse/busy/retirement, idle timestamps, and shutdown | Configured Managed VM executor, idle reaper, operator retirement | Reusable runtime lifecycle changes. |
| Credentialed Runtime Record Store | Non-secret VM/process/parent identity and retirement evidence needed for crash cleanup | Runtime manager and controller startup recovery | Durable cleanup evidence schema changes. |
| Credentialed Managed VM Factory | Code-owned Managed VM request and retained handle | Runtime manager | Image, resources, mount, or containment construction changes. |
| Configured Managed VM Command Executor | Per-call final authorization, direct argv/I/O/timeout execution, result projection, and runtime completion outcome | Controller execution dispatcher | Configured command behavior changes. |
| Credentialed Runtime Idle Reaper | Periodic expired-candidate selection using the existing cutoff-safe release contract | Runtime manager | Reaper cadence or generic idle selection changes. |
| Operator Retirement Adapter | Authenticated zone/agent/runtime retirement request and bounded result | Controller CLI/operations | Operator recovery surface changes. |
| Existing Controller Approval Ledger | Exact call intent, decision, reservation, and at-most-one dispatch arm | Controller authorization | Intentionally unchanged. |
| Existing Tool VM Lease Manager | Leased Tool VM SSH/workspace/TCP lifecycle | `tool_vm_runner` only | Intentionally unchanged. |

Allowed dependency direction:

```text
config contracts
  → credentialed runtime compiler
      → controller-only registry
          → controller authorization
              → command executor
                  → runtime lease manager
                      → credential materializer
                      → Managed VM factory/provider
                      → runtime record store

idle reaper/operator adapter → runtime lease manager
```

Forbidden edges:

- Gateway/model input to agent id, credential binding/ref, file path, runtime id, runtime handle, or lease authority;
- Gateway-safe projection or persisted effective config to credential refs or credential file paths;
- credentialed runtime manager to Tool VM lease manager, TCP pool, SSH client, workspace/Git roots, Tool VM active-use RPC, or Tool VM artifacts;
- Tool VM manager to credentialed runtime registry or credential memory mount;
- command executor directly creating/closing VMs or mutating runtime-map state;
- credential materializer writing rootfs/COW, controller SQLite, runtime records, logs, or results;
- runtime record store becoming current in-process runtime authority or retaining credential bytes;
- Managed VM credentials entering environment, mediation, image layers, checkpoint, or host-directory mounts.

## Configuration compilation and authority separation

The authored agent binding shape remains controller-only:

```ts
interface CredentialBindingConfig {
  readonly files: Readonly<Record<string, {
    readonly source: '1password'
    readonly ref: string
  }>>
}

interface CredentialFileMappingConfig {
  readonly source: string
  readonly path: string
}
```

The credentialed target extends the existing `ephemeral_managed_vm` variant with:

```ts
interface CredentialedManagedVmTargetConfig {
  readonly kind: 'ephemeral_managed_vm'
  readonly runtimeId: string
  readonly credentialBinding: string
  readonly credentialFiles: readonly CredentialFileMappingConfig[]
  // existing imageReference, guestCwd, environment, allowedHosts remain
}
```

The compiler performs four distinct operations:

1. Validate every agent binding and target file map against the Specification bounds.
2. Resolve each profile's operations into runtime groups by authored `runtimeId` and reject conflicting runtime-shaping fields.
3. Compute one canonical runtime-group revision from image fingerprint, rootfs/resources/mount policy, allowed hosts, VM-level environment, credential root, binding name, authored binding structure, and file map. Per-call-only policy remains outside this revision.
4. Produce two outputs from source data rather than redacting one object:
   - a controller-only in-memory registry containing unresolved SecretRefs and group authority;
   - the existing persisted/Gateway-safe effective Tool Portal configuration containing only agent profile assignment and safe controller-execution projection.

The atomic gateway semantic cohort includes the controller registry revision and Gateway projection revision. A controller execution request is admitted only when caller context, persisted safe projection, and controller-only registry belong to the same current cohort.

Credential refs never enter the atomic effective-config files. Controller restart reconstructs the registry from authored config before enabling credentialed execution.

## Controller-only registry interfaces

```ts
interface CredentialedRuntimeResolution {
  readonly agentId: string
  readonly credentialBinding: ResolvedCredentialBindingDefinition
  readonly fileMappings: readonly CredentialFileMappingConfig[]
  readonly groupRevision: string
  readonly profileId: string
  readonly runtimeId: string
  readonly target: NormalizedCredentialedManagedVmTarget
}

interface ControllerCredentialedRuntimeRegistry {
  resolve(request: {
    readonly agentId: string
    readonly operationName: string
    readonly profileId: string
    readonly semanticRevision: string
  }): CredentialedRuntimeResolution
}
```

`resolve` is synchronous against one immutable current registry snapshot. It returns unresolved 1Password refs only to controller-owned consumers. Unknown agents, profiles, operations, bindings, sources, or semantic cohorts return a typed pre-dispatch denial.

The existing controller authorization result gains the trusted `agentId`, `profileId`, and `CredentialedRuntimeResolution`. None enters Gateway Control input or portable results.

## Credential materialization

The factory declares exactly one read-only finalizable memory mount at the code-owned guest path `/run/agent-vm/credentials`. Before VM start, the materializer:

1. Selects only sources referenced by the runtime group's file map.
2. Calls the existing `SecretResolver.resolveAll` once for VM creation.
3. Validates every resolved string and total byte count.
4. Converts strings to UTF-8 bytes and maps them to canonical relative paths.
5. Calls `ManagedVm.finalizeMemoryMount` exactly once with file mode `0600`.
6. Starts the VM only after successful finalization.

The mount is read-only inside the guest. The CLI image and trusted mandatory argv/environment policy point the configured CLI at the code-owned credential root. Ordinary CLI working files and caches remain on rootfs/COW.

Materialization failure poisons creation: the VM is closed or exactly terminated, no current runtime is published, no guest command starts, and diagnostics omit values and refs.

The controller retains only the authored binding/group revision. It does not fingerprint secret bytes. A changed 1Password value behind an unchanged ref is observed at the next VM creation. The operator retirement adapter forces that creation boundary when immediate replacement is needed.

## Runtime identity and lifecycle state

Runtime lookup key:

```text
zoneId + authenticated agentId + authored runtimeId
```

Compatibility authority additionally binds:

```text
controller epoch + parent Gateway epoch + stable principal
+ controller registry cohort + runtime-group revision
```

Controller-only live lease:

```ts
interface CredentialedRuntimeLease {
  readonly agentId: string
  readonly createdAtMs: number
  readonly groupRevision: string
  readonly id: string
  readonly lastUsedAtMs: number
  readonly parentGateway: GatewayEpochIdentity
  readonly processIdentity: ManagedVmProcessIdentity
  readonly runtimeId: string
  readonly stablePrincipal: GatewayStablePrincipalDigest
  readonly vm: ManagedVm
  readonly zoneId: string
  readonly activeCommand?: {
    readonly operationId: string
    readonly startedAtMs: number
  }
}
```

The runtime manager owns all transitions:

| State | Entry | Permitted transition | Illegal path |
| --- | --- | --- | --- |
| absent | No current compatible lease | `provisioning` after keyed-lock admission | Caller-supplied or adopted runtime identity |
| provisioning | Current group/agent admitted | `current-idle` after credential finalization, VM start, process identity publication, and final authorization | Guest exec before finalization/identity/current authority |
| current-idle | Compatible VM, no active command | `current-active`, `retiring` | Idle renewal from denied/busy call |
| current-active | One command slot owned | `current-idle` on observed safe completion; `retiring` on unsafe/forced outcome | Second active command or ordinary idle reaping |
| retiring | Access fenced; exact cleanup in progress | `retired` after process/VM absence proof | New command or successor adoption |
| retired | Cleanup proven; record removable | New independent `provisioning` | Reuse of old handle or lease id |
| owner-unsafe | Cleanup/identity/containment unproven | Operator remediation or later exact cleanup | Successor creation, reuse, or safe-retry claim |

Only `current-idle` may be reused. No runtime state is exported to Gateway or model consumers.

### Crash-durable runtime record

The record store reuses `createCrashDurableRecordStore` and one strict versioned discriminated union. It does not reuse the one-shot operation-record schema and introduces no new database.

Every variant contains `recordVersion`, monotonic `generation`, controller/Gateway epochs, zone id, agent id, stable principal, runtime id, group revision, record id, and bounded timestamps. Credential refs, values, file contents, secret fingerprints, argv, stdin, and output are forbidden.

```ts
type CredentialedRuntimeRecord =
  | { readonly kind: 'reserved' }
  | { readonly kind: 'creation-started' }
  | { readonly kind: 'vm-created'; readonly vmId: string }
  | {
      readonly kind: 'identity-published'
      readonly identity: ManagedVmProcessIdentity
      readonly vmId: string
    }
  | {
      readonly kind: 'current-idle'
      readonly identity: ManagedVmProcessIdentity
      readonly idleExpiresAtMs: number
      readonly lastUsedAtMs: number
      readonly vmId: string
    }
  | {
      readonly kind: 'current-active'
      readonly activeOperationId: string
      readonly identity: ManagedVmProcessIdentity
      readonly startedAtMs: number
      readonly vmId: string
    }
  | {
      readonly kind: 'retiring'
      readonly identity: ManagedVmProcessIdentity | null
      readonly reason: CredentialedRuntimeRetirementReason
      readonly vmId: string | null
    }
  | {
      readonly kind: 'contained-terminal'
      readonly containment: 'proven'
      readonly identity: ManagedVmProcessIdentity | null
      readonly vmId: string | null
    }
  | {
      readonly kind: 'owner-unsafe'
      readonly containment: 'unproven'
      readonly identity: ManagedVmProcessIdentity | null
      readonly reason: string
      readonly vmId: string | null
    }
```

Durable ordering is mandatory:

```text
reserve record
  → creation-started
  → create unstarted Managed VM handle
  → vm-created record
  → start VM
  → read exact host process identity
  → identity-published record
  → finalize current authorization
  → current-active record
  → guest exec
  → current-idle record on safe completion
  → retiring record before access cleanup
  → contained-terminal after exact termination/absence proof
  → delete record
```

The live map is published only after `identity-published` and current final authorization. A durable `current-active` write precedes guest exec. A durable `current-idle` write precedes making the slot reusable.

Crash-window recovery:

| Last durable state | Recovery authority | Successor rule |
| --- | --- | --- |
| `reserved` or `creation-started` | No started VM is permitted before `vm-created`; mark contained terminal. | Successor allowed after terminal write. |
| `vm-created` without process identity | VM may have started before crash; exact target is not proven. Mark `owner-unsafe`. | Successor blocked until operator cleanup proves absence. |
| `identity-published`, `current-idle`, or `current-active` | Exact-terminate recorded process, close/observe absence, then mark contained. Never replay active command. | Successor allowed only after containment proof. |
| `retiring` with identity | Resume exact termination and containment. | Successor blocked until contained. |
| `retiring` without identity | Mark owner-unsafe unless provider evidence proves no process/endpoint. | Successor blocked while unproven. |
| `owner-unsafe` | No automatic adoption or overwrite. | Successor rejected. |
| `contained-terminal` | No live authority remains; record may be deleted. | Successor allowed. |

Recovery runs before credentialed execution is enabled for a zone. It adopts zero VMs and redispatches zero commands.

## Behavioral interfaces

### Acquire one command slot

```ts
type AcquireCredentialedRuntimeCommandResult =
  | { readonly kind: 'acquired'; readonly command: CredentialedRuntimeCommandHandle }
  | { readonly kind: 'busy' }
  | { readonly kind: 'not-dispatched'; readonly reason: string }
  | { readonly kind: 'owner-unsafe'; readonly reason: string }
```

The executor supplies trusted current resolution plus an async final-authorization callback. Under the runtime-key lock, the manager:

- retires incompatible or expired idle predecessors;
- returns `busy` when a compatible runtime is active;
- creates a runtime when absent;
- invokes final authorization after all asynchronous creation/materialization/start work and immediately before assigning the active slot;
- atomically assigns the active slot and returns a controller-only command handle.

The command handle exposes only `exec` and `complete`; it does not expose a public lease id, raw VM handle, credentials, or lifecycle mutation.

### Complete one command

```ts
type CredentialedRuntimeCommandOutcome =
  | { readonly kind: 'completed' }
  | { readonly kind: 'retire'; readonly reason: string }
```

Observed process completion, including a bounded non-zero exit, may return the runtime to idle. Timeout, controller cancellation during exec, output-stream failure, lost process result, VM health loss, or uncertain command termination selects `retire`. `complete` is idempotent for the exact handle and rejects mismatched/stale handles.

The runtime returns to idle only after result cleanup is complete. `lastUsedAtMs` is set at that transition, starting the fixed 15-minute idle window.

### Retire a runtime

Retirement fences new command acquisition under the runtime-key lock, persists `retiring`, terminates the exact recorded host process, closes the Managed VM, proves process/endpoint absence through existing capabilities, deletes the runtime record, and removes the live map entry. Normal idle retirement refuses an active runtime; forced controller/zone/operator retirement cancels the active handle and then follows exact cleanup.

### Operator retirement contract

The existing controller client/admin-route pattern exposes exactly one operation:

```text
agent-vm controller credential-runtime retire
  --config <system-config>
  --zone <zoneId>
  --agent <agentId>
  --runtime <runtimeId>
  [--force]
```

The CLI calls the authenticated controller route:

```text
POST /zones/:zoneId/credentialed-runtimes/:runtimeId/retire
body: { agentId, force }
```

The route uses the existing zone admin authorization when `adminAccess` is configured. It accepts no lease id, VM id, credential binding/ref, process identity, or file path.

```ts
type RetireCredentialedRuntimeResult =
  | { readonly kind: 'retired' }
  | { readonly kind: 'absent' }
  | { readonly kind: 'active'; readonly retryable: true }
  | { readonly kind: 'owner-unsafe'; readonly retryable: false }
```

`force: false` returns `active` without cancellation when a command owns the slot. `force: true` uses existing controller-admin cancellation authority, waits for the command disposition, fences access, and performs exact retirement. `absent` is idempotent success. Containment failure returns `owner-unsafe` and leaves durable fencing in place.

## Current-to-target call-path delta

| Edge | Status | Owner and semantics | State/effect and result |
| --- | --- | --- | --- |
| Gateway Tool Portal → Gateway Control `configured_cli` | Intentionally unchanged | Existing private authenticated per-call RPC | Carries only capability identity, public input, and existing call authority. |
| Gateway Control handler → controller authorization | Changed | Existing authorization also resolves current controller-only credentialed runtime definition | Returns trusted agent/profile/runtime resolution or proven denial. |
| Authorization → one-shot operation ledger | Removed | Credentialed path no longer creates an operation-to-VM ledger entry | One-shot lifecycle ceases to be authority. |
| Authorization → runtime manager acquire | Added | Async controller-only call with final-authority callback | Returns acquired, busy, not-dispatched, or owner-unsafe. |
| Runtime manager → credential materializer | Added on creation only | Batched external 1Password resolution and pre-start memory finalization | Produces no persistent credential bytes; failure is pre-dispatch. |
| Runtime manager → Managed VM factory/start | Changed | VM is created only when absent and retained after healthy command completion | Publishes non-secret process/runtime identity before command use. |
| Runtime manager → final authorization | Added/retained at new boundary | Final current call/group/epoch comparison occurs immediately before active-slot assignment | Stale call creates zero guest effects; a newly created stale VM is retired. |
| Command handle → `ManagedVm.exec` | Changed owner | Existing direct argv/output/timeout logic executes on retained VM | Per-call result remains existing portable shape. |
| Command completion → VM close | Removed on safe completion | Healthy compatible VM becomes idle | Runtime-local COW and credential memory remain until retirement. |
| Idle reaper/operator/zone close → runtime manager retire | Added | Controller-owned exact cleanup | COW and credential memory disappear; no snapshot. |
| Controller CLI/client → authenticated credential-runtime retire route → runtime manager | Added | Admin operation keyed only by zone/agent/runtime plus force | Returns retired, absent, active, or owner-unsafe; no secret/VM identity exposure. |
| `tool_vm_runner` → Tool VM lease/SSH | Intentionally unchanged | Existing Gateway-owned strict-SSH path | No credentialed runtime edge. |

Target normal sequence:

```text
Hermes/Gateway     Controller Auth      Runtime Manager      1Password/VM
      │                  │                    │                    │
      │─ configured call▶│                    │                    │
      │                  │─ current policy ─▶│                    │
      │                  │                    │─ keyed acquire ────│
      │                  │                    │  create if absent   │
      │                  │                    │─ resolve/finalize ─▶│
      │                  │                    │◀─ VM current ───────│
      │                  │◀─ final recheck ──│                    │
      │                  │─ current result ─▶│                    │
      │                  │                    │─ active slot        │
      │                  │                    │─ direct argv ──────▶│
      │                  │                    │◀─ result ───────────│
      │                  │                    │─ complete → idle    │
      │◀─ portable result│                    │                    │
```

Busy branch:

```text
second same-runtime call
  → current authorization
  → keyed acquire sees activeCommand
  → retryable runtime_busy, proven not dispatched
  → no queue, renewal, reservation, VM create, or later callback
```

## Concurrency and consistency

- One keyed lock per `zoneId + agentId + runtimeId` serializes runtime-map and active-slot transitions, not command execution duration.
- Creation holds the key's provisioning ownership so two simultaneous first calls cannot create two VMs. After creation and final authorization, the first call receives the slot; the second observes busy.
- Command exec runs outside the key lock while `activeCommand` remains authoritative. Other runtime keys proceed independently.
- Completion, idle reaping, explicit retirement, config invalidation, and zone shutdown reacquire the same key before mutation.
- Idle reaping uses the existing cutoff compare: a lease touched after candidate selection is not retired by a stale reaper decision.
- Busy, denied, stale, or malformed calls never touch `lastUsedAtMs`.
- Runtime-group revisions are canonical and order-insensitive. Per-call policy revisions remain independent and continue to stale exact call authority.
- No heartbeat is required for controller-local command execution: the controller directly owns the command promise and cancellation signal. Controller process loss makes the durable runtime record recovery authority and triggers destruction, never adoption.

## Failure and recovery

| Failure or interleaving | Detection owner | Containment and observable result | Recovery owner |
| --- | --- | --- | --- |
| Agent/profile/binding/file map invalid | Config compiler/authorization | Generation or call rejected before VM creation | Operator corrects config. |
| 1Password resolution/UTF-8/size failure | Credential materializer | VM absent or closed; proven not dispatched; no secret diagnostic | Operator corrects binding/value and retries. |
| Memory finalization failure | Materializer/factory | Finalization poisoned; close exact VM; no start/exec | New call may create after cleanup proof. |
| Policy/group/epoch changes during creation | Final authorization callback | No guest exec; created VM retired; proven not dispatched if containment succeeds | New independently authorized call. |
| Concurrent same-runtime call | Runtime manager | Retryable `runtime_busy`; zero future authority | Caller submits a new call later. |
| Command timeout/cancel/stream/result uncertainty | Command executor | Existing bounded/ambiguous per-call result; runtime fenced and retired; no replay | New call only after containment. |
| Non-zero observed exit | Command executor | Existing completed command result; runtime may return idle | Caller decides next call. |
| Idle reaper races with new call | Runtime manager keyed lock + cutoff | Exactly one wins; touched/active runtime survives, expired runtime retires | Automatic. |
| Config/group revision changes while idle | Registry/runtime manager | Old runtime fenced and retired before new active slot | New call creates current group. |
| 1Password value changes behind same ref | Not polled while live | Existing runtime continues until retirement; external revocation may cause command auth failure | Operator explicitly retires for immediate replacement; otherwise next creation resolves current value. |
| Controller crashes with current runtime | Startup recovery from non-secret record | Exact recorded process termination; no adoption or call replay | Controller before enabling credentialed execution. |
| Controller crashes after VM start but before identity publication | Recovery sees `vm-created` without exact identity | Durable owner-unsafe fence; no successor | Operator cleanup or provider-backed absence proof. |
| Exact termination/absence unproven | Runtime manager/record store | `owner-unsafe`; successor and safe retry blocked | Operator cleanup or later successful exact termination. |
| Gateway/zone stops or parent epoch changes | Zone lifecycle | Fence and force-retire all owned credentialed runtimes | Controller zone lifecycle owner. |
| Operator retires active runtime without force | Admin route/runtime manager | Typed `active`; command continues; no state mutation | Operator retries later or explicitly selects force. |
| Operator force-retires active runtime | Admin route/runtime manager | Controller-owned cancellation then exact cleanup; contained or owner-unsafe result | Operator observes bounded result; next call only after containment. |

No command is automatically retried. No credential resolution failure falls back to environment/config values. No credentialed execution falls back to controller host or leased Tool VM.

## Trust and data boundaries

```text
untrusted/model-controlled
  argv + reason + permitted stdin/timeout
              │ existing schema/policy/approval
              ▼
Gateway-safe Tool Portal
  no agent override, credential ref, file map, runtime id, VM/lease id
              │ authenticated Gateway Control + caller context
              ▼
controller trust boundary
  current call authority + controller-only runtime registry
              │
      ┌───────┴─────────────────────┐
      ▼                             ▼
1Password                       Managed VM
durable secret source           prepared image + rootfs/COW
      │ resolved only on create      │
      └──────► read-only finalizable-memory credential mount
                                      │
                                      ▼
                                 direct argv CLI

separate unchanged boundary:
tool_vm_runner → current Tool VM binding → strict SSH → leased Tool VM
```

Assets are agent-to-profile authority, credential refs/values, runtime-group revision, current runtime/process identity, per-call approval/direct authority, rootfs/COW state, and containment evidence.

Credential refs remain only in authored config and the controller-only in-memory registry. Credential values exist only during resolver/materializer execution and inside the Managed VM memory provider. Runtime records contain neither.

## Operator retirement and observability

The runtime manager exposes the controller-internal retirement operation keyed by zone, agent, and authored runtime id. `agent-vm controller credential-runtime retire` and its authenticated controller client/route adapter expose the exact contract defined above; they do not expose lease ids, VM handles, or credentials.

Operator-visible status may report bounded non-secret fields: zone, agent, runtime id, lifecycle state, created/last-used/idle-expiry times, image/group revision identifiers, and retirement reason. Public health/status must continue redacting raw lifecycle ids where existing policy requires it.

Explicit retirement is idempotent when no current runtime exists. Active retirement requires the existing force/cancellation authority; ordinary idle retirement never destroys an active command.

## Compatibility and cutover

This is a hard cut for `ephemeral_managed_vm`:

- authored target schema requires runtime id, credential binding, and credential file mappings;
- effective schema and Gateway projection move in one semantic cohort;
- the one-shot configured Managed VM runner and operation ledger are removed from the configured CLI production path;
- there is no parser alias, optional lifetime, uncredentialed one-shot variant, host fallback, or migration of old runner records into reusable leases;
- startup recovery contains old one-shot records before enabling the new target;
- current Tool VM lease, SSH, file/process, and artifact contracts do not change.

Rollback restores one complete prior package/config/image cohort. It does not read new credential bindings or adopt new reusable runtime records.

## Proof architecture

### Unit floor

Pure tests own:

- agent binding/file-map schemas, bounds, canonical paths, duplicates, unknown fields, and generated JSON Schema;
- controller-safe projection omission of bindings, refs, file maps, and runtime identities;
- runtime-group compilation, conflict rejection, canonical revision stability, group-field mutations, and per-call-policy exclusion;
- per-agent runtime keying and cross-agent separation;
- lifecycle reducer/state transitions, busy/no-queue behavior, cutoff-safe idle decisions, completion outcomes, and illegal transitions;
- credential materialization inventory, UTF-8/byte bounds, fixed modes, and no secret-derived metadata;
- exhaustive error/result mapping and Tool VM forbidden-edge checks.

### Integration floor

Real config parsing/materialization, Tool Portal service, private UDS/Gateway Control, caller context, controller authorization, runtime registry, runtime manager, record store, and command executor run together. Managed VM factory, exact termination, clock, and 1Password resolver may be deterministic fakes.

It observes same-agent reuse, cross-agent separation, different-operation group sharing, busy zero effects/no late dispatch, creation races, final reauthorization, group invalidation, idle cutoff, explicit retirement, crash recovery, and Tool VM non-interaction.

Crash recovery is interrupted after every durable state transition. The harness proves the state-specific exact-termination or owner-unsafe result and zero successor creation while fencing remains. The controller CLI/route integration proves absent, active, force-retired, and owner-unsafe result variants plus zone-admin enforcement.

### Real Managed VM floor

The production factory/provider and a prepared fixture image prove:

- one VM id is reused across two compatible operations for one agent;
- another agent receives another VM and credential memory surface;
- `/run/agent-vm/credentials` is memory-backed/read-only with exact files and modes;
- rootfs/COW marker persists during the lease and disappears after retirement;
- CLI is present without runtime installation;
- direct argv, allowed hosts, cwd/environment, output, timeout, no SSH/TCP/host mounts, and exact retirement work;
- ambiguous containment blocks successor creation.

### 1Password floor

The repository's test 1Password account resolves a bounded file value through the production resolver. A real VM reads the expected credential file while controller effective artifacts, SQLite lock storage, runtime records, logs, projections, and results contain neither credential bytes nor raw refs. Explicit retirement followed by creation observes a changed test-vault value.

### Hermes floor

Real Hermes, Tool Portal, controller, and production runtime path prove direct/approved calls reuse the correct agent runtime, denial creates no VM/effect, busy is returned without late dispatch, and Hermes receives no runtime/credential authority.

### Tool VM regression floor

Existing `tool_vm_runner` integration and real strict-SSH proof confirm current agent Tool VM acquisition, active-use/renewal, command/file/process behavior, and artifacts remain unchanged and never invoke the credentialed manager.

## Requirement, design, and proof trace

| Specification | Structural realization | Minimum proof |
| --- | --- | --- |
| R1–R3 | Config compiler, split controller registry/safe projection, authorization resolution | Unit schema/projection plus real caller-context integration |
| R4 | Runtime-group compiler/revision separate from per-call semantic authority | Canonical unit matrix and multi-operation integration |
| R5–R7 | Final-authorization callback and runtime manager active slot/busy result | Authorization/runtime integration and concurrency proof |
| R8 | Credential materializer plus read-only finalizable memory mount | Unit inventory, 1Password E2E, real VM inspection |
| R9–R10 | Runtime manager, keyed lock, idle reaper, exact crash-durable record sequence, operator route/CLI, and zone retirement | Deterministic clock/crash/interleaving integration, black-box operator proof, and real retirement |
| R11 | Code-owned Managed VM factory and preserved Tool VM backend | Real VM containment plus Tool VM regression |
| R12 | Hard-cut schemas and removal of one-shot production path | Schema/static edge inspection and runtime target observation |
| R13 | Prepared image, rootfs/COW, no checkpoint/install | Real VM lifecycle/filesystem observation |

Accepted requirements remain covered: U1–U2 by compatible retained runtimes and state continuity; U3–U4 by controller-only lease/call authority separation; U5–U6 by trusted agent registry resolution and per-agent keys; U7 by the single active slot and busy result; U8 by fixed idle reaping; U9 by group/health/ownership fencing and exact cleanup; U10 by 1Password materialization and non-secret records; U11 by Managed VM containment; U12 by hard cut; and U13 by prepared image plus disposable rootfs/COW.

## Deliberate simplifications and revisit signals

- No generalized Tool VM/credentialed lease core: selected to protect the current SSH/workspace lifecycle. Revisit with a third controller-local reusable VM consumer or material duplication evidence.
- No active-use heartbeat: controller-local execution already observes the command promise. Revisit only if execution ownership moves outside the controller process.
- No command queue: busy returns immediately. Revisit only with real concurrent-call demand and an owner-approved queue-time contract.
- No per-call 1Password polling or secret fingerprint: explicit retirement and the 15-minute bound are sufficient for v1. Revisit if measured revocation latency is unacceptable.
- No COW checkpoint/restore or credential writeback: all runtime-local state ends at retirement.
- No new external lease/list/adopt API, presenter, service, database, host sandbox, or Tool VM integration.
