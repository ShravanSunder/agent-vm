# Credentialed Actions Design Spec

Status: design spec, not an executable implementation plan.

This spec supersedes `docs/superpowers/plans/2026-05-22-credentialed-runner-v1.md`
and absorbs the useful lease-substrate parts of
`docs/superpowers/plans/2026-05-29-vm-capability-lease-redesign.md` for design
purposes. Do not execute either plan directly. They predate, omit, or partially
mis-scope the current Tool VM lease model, MCP Portal managed-mode architecture,
Tool VM mediated placeholder support, gateway VM auto-recovery, prepared
Gondolin image cache, and credential custody split.

## Goal

Build an agent-facing credentialed action system that lets OpenClaw agents use
credentialed provider capabilities without giving the model raw credentials,
arbitrary argv, arbitrary filesystem paths, or provider runtime configuration.

The design must support two different truths at once:

1. Some credentialed work is safe and useful inside the existing agent Tool VM
   when credentials are HTTP-mediated placeholders.
2. Some credentialed work needs a controller-owned runner VM because provider
   state, OAuth refresh tokens, or CLI credential files must be isolated from the
   agent-controlled shell.

The shared abstraction is therefore not "a credentialed runner VM." The shared
abstraction is a credentialed action facade with independent custody and
execution backends.

## Why Replan

The previous runner plan made several now-stale assumptions:

- It treated a new `gondolin-rpc` runner VM as the only execution answer.
- It treated `/cred`, `/run-in`, `/run-out`, and `/scratch` as obvious guest
  paths without spelling out the Gondolin `/data` FUSE and bind-mount contract.
- It made trusted durable credential files the center of v1 instead of a
  high-trust exception.
- It did not account for Tool VM mediated placeholders over the non-login SSH
  command path that OpenClaw already uses.
- It did not model gateway VM recovery, Tool VM lease invalidation, and
  independent runner lease recovery as separate lifecycle surfaces.
- It did not carry forward the stronger at-rest encryption model from the older
  credentialed-tool-system design.
- It borrowed the MCP Portal "facade over raw upstream capability" direction but
  did not apply its strongest lessons: trusted agent identity, scoped catalogs,
  item-level approval, exact argument hashes, and fail-closed policy.
- The later VM capability lease redesign correctly identifies missing runner
  lease mechanics, but scopes out MCP Portal coexistence and credential state
  encryption. Those are not optional design afterthoughts for credentialed
  actions; they define which lease substrate is safe to use.

## Current Reality Anchors

- `packages/agent-vm/src/controller/leases/lease-manager.ts`
  - Tool VM lease identity is `zoneId + agentId`, not `leaseId`, cwd, profile,
    workspace, session key, TCP slot, or runtime record.
  - Compatibility checks decide whether an existing per-agent lease may be
    reused.
  - Active uses protect in-flight operations and idle expiry is ignored while
    active uses exist.

- `packages/agent-vm/src/controller/leases/tool-vm-runtime-record.ts`
  - Tool VM runtime records live under `tool-leases/<recordId>.json` in the
    controller state directory.
  - Records include a schema version, `recordId`, lease identity, VM identity,
    QEMU pid, process identity, config path, project namespace, zone id, gateway
    identity, TCP slot, session label, and creation time.
  - Runtime records are written atomically with private permissions.
  - Clean release deletes the record; close failure preserves it so the next
    startup can detect and reap or quarantine leaked VM processes.
  - Runner leases need this same operational safety model, not just an in-memory
    map.

- `packages/gateway-interface/src/runtime-paths/runtime-path-mapping.ts`
  - Runtime paths are translated between controller host, OpenClaw gateway, and
    Tool VM guest namespaces.
  - Parent traversal is rejected before normalization.
  - The path mapping model is the right pattern for any credential-action path
    that crosses a runtime boundary.

- `docs/subsystems/mcp-portal.md`
  - Managed OpenClaw MCP Portal is a native plugin facade, not an exposed HTTP
    server.
  - Agent identity comes from trusted OpenClaw context, not tool arguments.
  - Profiles are complete policies; no inheritance or implicit merging.
  - Approval is item-level and bound to exact agent id, namespace/tool name, and
    argument hash.
  - HTTP mediation is the default for provider secrets; raw env is an explicit
    exception only when the bytes cannot be mediated.
  - This is the strongest existing agent-facing facade and should be reused
    before adding bespoke OpenClaw plugin tools for credentialed actions.

- `packages/agent-vm/src/tool-vm/tool-vm-lifecycle.ts`
  - Tool VMs now receive HTTP-mediated placeholder env values through
    `/etc/profile.d`, `/etc/environment`, and sshd `SetEnv`.
  - Placeholder names are validated and reserved shell/runtime names are
    rejected.

- `packages/agent-vm/src/integration-tests/live-tool-vm-mediated-env.integration.test.ts`
  - A real Tool VM proves the placeholder is visible to the same non-login SSH
    shell shape that OpenClaw uses, and proves the VM does not see the raw token.

- `docs/superpowers/plans/2026-05-27-gateway-vm-auto-recovery.md`
  - Gateway service/control-link recovery is separate from Tool VM lease/SSH
    recovery.
  - Gateway restart force-releases Tool VM leases because OpenClaw gateway state
    changed.
  - Provider-only churn must not restart the gateway VM.

- `packages/agent-vm/src/controller/zone-runtimes/openclaw-zone-runtime.ts`
  - OpenClaw restart currently force-releases Tool VM leases before stopping the
    gateway lifecycle.
  - That is a dependency rule: Tool VM leases are coupled to the OpenClaw gateway
    runtime that requested and owns the Tool VM path.
  - Independent controller-owned runner leases must not inherit this behavior
    blindly. They should release on gateway restart only when their facade,
    active call, or backend explicitly depends on that gateway runtime.

- `docs/subsystems/gondolin-vm-layer.md`
  - `ssh-sandbox` is the only implemented capability transport today.
  - `gondolin-rpc` is reserved for controller-owned `ManagedVm.exec()` and
    `ManagedVm.fs` workloads.
  - `ManagedVm.fs` is the right filesystem API for controlled non-OpenClaw
    workloads once the controller owns the VM handle.

- `packages/gondolin-adapter/src/vm-adapter.ts`
  - `CreateVmOptions` already exposes rootfs mode, allowed hosts, mediated
    secrets, VFS mounts, optional `tcpHosts`, env, and session labels.
  - The adapter always sets Gondolin `vfs.fuseMount` to `/data`.

- Gondolin `exec.d.ts`
  - With `buffer: false`, stdout/stderr default to `ignore`.
  - Streaming requires `stdout: "pipe"` and `stderr: "pipe"`.
  - `ExecProcess.output()` yields labeled stdout/stderr chunks.
  - Piped output must be drained while the process runs.

- Gondolin `vm/fs.d.ts`
  - `VmFs` exposes `stat`, `readFile`, `readFileStream`, `writeFile`, `mkdir`,
    `rename`, `listDir`, and deletion.
  - It does not expose `lstat`, so a plan cannot claim symlink refusal through
    `ManagedVm.fs.stat()`.

## Design Thesis

Credentialed actions follow the MCP Portal method:

```text
agent-visible facade
  -> trusted agent identity
  -> scoped catalog
  -> schema validation
  -> approval policy
  -> custody resolver
  -> execution backend
  -> audited structured result
```

The agent never chooses:

- raw credentials;
- provider auth config;
- execution backend;
- VM profile;
- lease id;
- cwd;
- absolute host path;
- environment variables;
- executable path;
- argv array;
- shell string.

The agent chooses only an action name and schema-validated action arguments from
the policy-visible catalog.

## Two Independent Axes

Credential custody and credentialed execution are separate decisions.

```text
Axis 1: credential custody

  host-mediated
    Controller owns raw secret. VM gets placeholder. Gondolin injects the real
    value only into supported outbound HTTP request locations for allowed hosts.

  ephemeral-materialized
    Controller materializes a short-lived credential into one run. The VM sees a
    real value, but not a long-lived refresh token or client secret.

  trusted-credential-state
    A dedicated runner VM gets durable provider state mounted read/write. The VM
    can read refresh tokens, client secrets, keyrings, or provider config. This
    is explicit high-trust mode.

  host-brokered
    Controller or host-side broker owns the OAuth refresh loop and sends only
    non-refreshable access to the execution backend. This is future work unless
    a provider already has an easy host-side broker.


Axis 2: credentialed execution

  tool-vm-mediated
    Existing OpenClaw Tool VM over ssh-sandbox. Good when placeholders are
    enough and the action naturally belongs in the agent workspace.

  gondolin-rpc-runner
    Controller-owned ManagedVm. No SSH, no ingress service, fixed argv, native
    vm.exec/vm.fs. Good for typed provider CLIs and credential files.

  ephemeral-gondolin-runner
    Same controller-owned surface, but one VM per run. Best isolation, highest
    latency/cost.

  mcp-portal
    Use MCP Portal when the provider capability already exists as MCP. This is
    not a CLI runner and should not be duplicated as one.

  host-subprocess
    Future escape hatch for host-only integrations. Disabled by default.
```

These axes combine into valid and invalid products.

| Custody | Tool VM mediated | Gondolin RPC runner | Ephemeral VM | MCP Portal |
| --- | --- | --- | --- | --- |
| host-mediated | Valid default for header/query token CLIs and scripts. | Valid when the CLI can use placeholder env and we need fixed argv. | Valid but usually wasteful. | Existing MCP Portal pattern. |
| ephemeral-materialized | Risky; agent-controlled shell can read the value. Only for explicitly approved one-shot workflows. | Valid for short-lived tokens and one-shot files. | Strong default for high-risk one-shot actions. | Usually not needed. |
| trusted-credential-state | Invalid for v1. Do not mount long-lived `/cred` into the agent Tool VM. | Valid high-trust mode. | Valid but loses warm credential caches unless state is remounted. | Not applicable unless MCP provider owns state. |
| host-brokered | Valid future direction for OAuth refresh. | Valid future direction. | Valid future direction. | Already close to MCP Portal auth ownership. |

## Recommended V1 Shape

V1 should be a credentialed action facade with two implementation slices:

1. Ship the facade and policy model first.
2. Use the existing Tool VM mediated-placeholder backend for providers whose
   credentials can remain host-mediated.
3. Add the `gondolin-rpc-runner` backend only for providers/actions that truly
   require credential files, OAuth state, or fixed argv outside the
   agent-controlled shell.

This keeps the first implementation honest:

- We prove the real OpenClaw -> controller -> Tool VM path that already exists.
- We do not invent a runner lease manager before knowing which custody mode
  needs it.
- We still preserve a concrete path to actual credentialed runner VMs for
  provider CLIs such as `gog`.

## Agent-Facing Facade

The default agent-facing facade is an MCP Portal namespace. MCP Portal already
owns scoped catalogs, trusted agent identity, approval, redaction, and batch
result shape. Credentialed actions should extend that method instead of
rebuilding it behind bespoke native OpenClaw tools.

Native OpenClaw tools or generated helper packages may wrap the same core later
only when a specific OpenClaw integration needs a native command surface. They
must remain thin wrappers around the same facade core, policy engine, approval
model, and audit records. They must not create a second portal-like policy
system.

The internal contract stays:

```ts
interface CredentialedActionCall {
	readonly actionRef: string;
	readonly args: unknown;
}

interface CredentialedActionScope {
	readonly agentId: string;
	readonly zoneId: string;
	readonly profileId: string;
}
```

`agentId` must come from trusted OpenClaw context or controller-authenticated
caller context. It must not be accepted from model-visible action arguments.

Catalog entries contain:

- provider id;
- action name/ref;
- JSON Schema or Zod-derived validation schema;
- approval policy selector;
- custody requirement;
- execution backend selector, with optional per-action override over the
  provider default;
- output contract;
- egress requirement;
- optional maintainer action references.

Profiles are complete policies. A profile does not inherit from a default
profile. Empty allowlists expose nothing.

Backend dispatch is catalog-static. The agent never picks a backend at request
time. If a configured backend is unavailable, the call fails closed with a typed
backend-unavailable error. Fallback to a different backend is allowed only when
the catalog explicitly declares an ordered fallback set for that action and each
candidate satisfies the custody requirement.

## Approval Policy

Approval follows MCP Portal's item-level pattern.

Each action call is prepared independently:

1. Resolve trusted agent scope.
2. Resolve visible action catalog.
3. Validate args.
4. Compute canonical argument hash.
5. Decide allow/block/approval-required for that prepared call.

Approval tokens, if used, are server-side and short-lived. They are bound to:

- agent id;
- zone id;
- profile id;
- action ref;
- canonical args hash;
- optional artifact write intent hash.

Mixed batches must not become all-or-nothing approval prompts. Approval-free
calls can execute while approval-required calls return item-level
`approval_required` errors.

## Custody Modes

### host-mediated

Use when the provider credential can be carried in HTTP headers, Basic auth, or
query parameters supported by Gondolin mediation.

Properties:

- Controller resolves the raw secret.
- VM environment contains only the placeholder.
- Gondolin substitutes the real secret only for configured hosts.
- Raw secret never enters VM env, disk, stdout, or process memory through this
  mechanism.
- Existing Tool VM support already exposes placeholders to OpenClaw's non-login
  SSH command path.

Limits:

- Does not work for request bodies, opaque WebSocket payloads, arbitrary TCP
  protocols, or OAuth token exchanges that require a client secret in a POST
  body.
- The guest can still use the placeholder to send authenticated requests to
  allowed hosts, so allowed hosts remain a trust boundary.

Default backend:

- `tool-vm-mediated` for agent-workspace actions.
- `gondolin-rpc-runner` only when fixed argv/control is more important than
  workspace access.

### ephemeral-materialized

Use when a provider needs a real value inside the VM, but that value is
short-lived and scoped to a single run.

Properties:

- Controller or host broker mints the credential immediately before execution.
- Credential is written only to per-run input or env for the selected backend.
- Credential is deleted at run end and never durable state.
- Output redaction uses exact configured/minted secret values.

Limits:

- The VM sees the real value.
- Agent-controlled Tool VM use is high risk because the agent can inspect the
  value. Prefer `gondolin-rpc-runner` or `ephemeral-gondolin-runner`.

### trusted-credential-state

Use when a provider CLI must own durable state such as refresh tokens, keyrings,
client credentials, or local config.

Properties:

- Durable host path lives under zone `stateDir`, never `cacheDir`.
- Default agent-scoped path:
  `stateDir/credential-actions/agents/<agentId>/providers/<providerId>/profiles/<credentialProfileId>`.
- Explicit shared-profile path:
  `stateDir/credential-actions/shared/providers/<providerId>/profiles/<credentialProfileId>`.
- Directory mode is `0700`.
- It is secret backup state and should be included in encrypted backups.
- It should also be encrypted at rest before being exposed as a durable custody
  mode. The older credentialed-tool-system plan used age encryption with a
  1Password-held identity; that is the preferred model unless a new design
  explicitly accepts plaintext state under `stateDir`.
- VM can read and update the mounted state.
- Maintainer setup is separate from agent execution.

Limits:

- This mode intentionally weakens the "VM never sees credentials" guarantee.
- It must be explicit in deployment config and docs.
- It must not be mounted into the existing agent Tool VM in v1.
- If at-rest encryption is deferred, the implementation plan must name that as a
  security tradeoff and make the backup/encryption boundary explicit.

Default backend:

- `gondolin-rpc-runner`.
- `ephemeral-gondolin-runner` when the state mount is read-only plus a separate
  writeback flow, if a future design needs that.

### host-brokered

Use when the safest model is for the controller/host to own OAuth refresh and
send only non-refreshable access to the execution backend.

This is a strong direction for OAuth providers, but it is not required for the
first implementation unless `gog` or another target CLI can consume externally
brokered tokens cleanly without persistent in-VM state.

## Execution Backends

### tool-vm-mediated

Use the existing OpenClaw Tool VM lease and SSH data path.

Identity and lifecycle:

- Reuses the current Tool VM lease identity: `zoneId + agentId`.
- Credentialed action run id is not lease identity.
- Gateway restart force-releases these leases because Tool VM leases depend on
  the OpenClaw gateway process state.

Strengths:

- Already wired through OpenClaw.
- Already has live integration coverage for mediated placeholders.
- Best fit for actions that operate on the agent workspace.
- No new runner lease manager.

Costs:

- Agent controls the shell and workspace.
- Not appropriate for durable refresh tokens or client secret files.
- Catalog policy can guide action use, but it cannot prevent the model from
  running unrelated shell commands in the same Tool VM outside the facade.

V1 use:

- Default for host-mediated credentials where the agent needs the normal Tool VM
  environment.
- First smoke should prove this real path through OpenClaw, not only a fake
  controller call.

### gondolin-rpc-runner

Use a controller-owned `ManagedVm` directly.

Use compose-from-primitives, not a second full lease manager fork and not one
giant union manager. Shared modules should own per-key locks, active-use
lifecycle, runtime-record IO, liveness probes, reaper mechanics, and recovery
decisions. Thin capability-specific managers may adapt those primitives for Tool
VM SSH leases and runner capability leases. A runner with durable `/cred`
mounted is a worse crash leak than an ephemeral Tool VM, so it must not drop
runtime-record cleanup.

Core contracts:

- `RunnerLeaseId` is an opaque UUIDv7 type.
- `RunnerCapLease` extends the generic VM capability lease with
  transport `gondolin-rpc`.
- `RunnerLeasePeek` returns only non-secret compatibility and liveness metadata.
- Error types must distinguish suspended backend, lease-not-found,
  compatibility conflict, active-use conflict, and execution conflict.
- The generic `VmCapabilityLease` base should stay minimal. Runner-specific
  credential, artifact, and catalog state belongs on runner types, not the base.

Identity:

```text
zoneId + identityScope + providerId + credentialProfileId + custodyMode + backendId
```

`identityScope` is custody-conditional:

```text
trusted-credential-state     agent:<agentId> by default
ephemeral-materialized       run:<runId>; no warm lease reuse
host-mediated                profile:<profileId> only when the runner is stateless
host-brokered                profile:<profileId> unless the broker issues agent-scoped access
```

Agent-scoped identity remains the safe default for any warm runner that can
retain VM-local rootfs state, provider cache files, or per-agent outputs across
runs. Profile-shared identity is allowed only when config declares the runner
profile shareable, the credential profile is not agent-specific, maintainer
setup has no agent-specific state, and tests prove per-run input/output/scratch
cleanup prevents cross-agent leakage.

The implementation plan must test that agent-scoped, profile-shared, and
per-run identities do not alias each other.

Do not include:

- run id, except for `ephemeral-materialized` per-run identity where reuse is
  intentionally disabled;
- active use id;
- cwd;
- artifact path;
- lease id;
- VM id;
- process id;
- TCP slot.

Compatibility must include:

- provider id;
- credential profile id;
- custody mode;
- backend id;
- image profile and prepared image fingerprint;
- VFS layout version;
- state directory;
- allowed host set;
- rootfs mode;
- idle TTL policy;
- `sourceFingerprint`, if trusted credential state is enabled.

`sourceFingerprint` is non-secret credential-mount compatibility metadata. It
can include the state path identity, encryption recipient id, layout version,
and a non-secret state generation marker. It must not include refresh tokens,
client secrets, plaintext credential file contents, or decrypted digests. A
`sourceFingerprint` change forces a cold runner lease instead of reusing a warm
VM across credential-state rotation.

Lifecycle:

- A runner lease has active uses just like Tool VM leases.
- Idle expiry only closes a lease with zero active uses.
- Artifact streams count as active uses until the stream ends or fails.
- Maintainer mode is mutually exclusive with agent actions for the same lease.
- Controller shutdown force-releases all runner leases.
- Gateway VM restart does not release independent runner leases unless a runner
  backend explicitly depends on the gateway runtime.
- Gateway-coupled active calls should be cancelled or marked abandoned if the
  gateway that owns the request dies, even when the underlying runner VM is kept
  warm for future calls.
- Runtime record creation happens after the in-memory lease is stored and before
  the lease is exposed to callers, matching the Tool VM write-after-store
  ordering.
- Runner creation writes a runtime record containing at least `schemaVersion`,
  `recordId`, `leaseId`, `vmId`, `qemuPid`, process identity, `configPath`,
  project namespace, `zoneId`, provider/profile identity, session label, state
  path identity, image fingerprint, compatibility fingerprint, and creation
  time.
- Clean release deletes the runtime record.
- Close failure preserves the runtime record so next-startup cleanup can reap or
  quarantine the orphaned VM.
- Close failure also quarantines any reserved runtime resource, such as a TCP
  slot, until startup cleanup or explicit recovery decides it is safe to reuse.
- Startup cleanup must be scope-fenced to this controller project/zone, matching
  the Tool VM and gateway recovery safety model.
- Runtime records live under `stateDir/runner-leases/<recordId>.json` with
  private permissions. They are operational metadata, not credential state. For
  v1 they are included in encrypted `stateDir` backups like existing
  `tool-leases` runtime records. Do not claim `stateDir` records are
  backup-excluded unless the storage model and backup tooling are changed
  deliberately.
- Trusted credential state is separate from runtime records and remains under
  the encrypted credential state path.
- Liveness uses a five-second bounded `managedVm.exec(['true'], { signal })`
  probe or an equivalent cheap Gondolin RPC that proves the VM accepts
  controller commands.
- A suspended runner backend returns a distinct unavailable/suspended error and
  does not silently cold-start until recovery policy allows it.
- Recovery should reuse or generalize the gateway recovery decision ladder. The
  runner call site has three differences: there is no gateway `/readyz` probe
  because liveness is the bounded `vm.exec(['true'])` probe; a restart decision
  means evict-and-cold-start-on-next-acquire, not restart-in-place; and a
  suspended decision becomes a typed `RunnerBackendSuspendedError`.
- If a stale runtime record points at a live owned QEMU process, startup cleanup
  must close or terminate that process according to policy. It must not merely
  keep the record forever. If the pid is gone, delete the record. If process
  identity proves the pid is foreign, leave it alone and warn.
- A separate TCP-slot pool is needed only if the runner backend creates host
  listeners or `tcpHosts` entries that require reserved ports. A no-SSH,
  no-ingress, pure `ManagedVm.exec` runner should not allocate a TCP slot just
  because Tool VM leases do.

Execution:

```ts
const process = managedVm.exec([executablePath, ...argv], {
	buffer: false,
	cwd: runPaths.scratchDir,
	env: {
		AGENT_VM_CREDENTIAL_ACTION_RUN_ID: runId,
	},
	stderr: 'pipe',
	stdout: 'pipe',
	windowBytes: outputWindowBytes,
	signal: abortController.signal,
});

const [outputSummary, result] = await Promise.all([
	drainCredentialActionOutput(process, outputCaps),
	process.result,
]);
```

The executor must drain `process.output()` or both `stdout` and `stderr` streams
while the process runs. It must not rely on `result.stdout` or `result.stderr`
when using `buffer: false`.

Use the Gondolin VM SDK directly. Do not add an in-VM listener, custom RPC
server, or side-channel protocol for runner execution. The controller already
has the host-side control plane it needs:

- `managedVm.exec([executablePath, ...argv], ...)` for fixed argv. Array-form
  exec does not search `$PATH`, so `executablePath` must be absolute and
  catalog-owned.
- `process.output()` for labeled stdout/stderr streaming, or the SDK-provided
  `process.stdout` and `process.stderr` readable streams when separate
  consumers are clearer.
- `windowBytes` for bounded exec-output backpressure. If the controller does
  not drain piped output, the guest can stall when the credit window fills.
- `managedVm.fs.readFileStream(path)` for artifact streaming out of the VM.
- `managedVm.fs.writeFile(path, readableOrAsyncIterable)` for streaming bounded
  input into the VM.

The controller should stream through to the caller or artifact sink while
counting bytes and enforcing per-stream caps. It should not buffer unbounded
stdout, stderr, input files, or artifacts in memory. If a cap is exceeded, the
runner aborts the process, records a truncation/cap outcome, and ends the active
use predictably.

### ephemeral-gondolin-runner

Same control surface as `gondolin-rpc-runner`, but one VM per action run.

Use when:

- the action sees real credential material;
- the provider action has high blast radius;
- warm caches are not needed;
- boot latency is acceptable.

The same active-use and audit model still applies, but lease reuse is disabled.

### mcp-portal

Use MCP Portal when the provider capability is available as an MCP tool.

Do not duplicate MCP providers as credentialed CLI runners unless the CLI offers
a capability the MCP provider cannot expose. MCP Portal already solves scoped
catalog, provider auth, approval, redaction, and native OpenClaw plugin
execution for that class of integration.

### host-subprocess

Out of scope for v1.

Host subprocesses may be needed for macOS-only local integrations, but they are
weaker isolation than Gondolin. They require a separate opt-in spec and must use
the same facade, catalog, approval, argv, output, and audit contract.

## Storage And Path Mapping

Credentialed actions must extend the storage model and storage matrix before
implementation. Do not invent runner paths directly in the runner manager. The
storage matrix is the policy source for backup and performance semantics; the
runtime path mapper is the code source for cross-namespace path translation.

Add a credentialed-actions section to `docs/architecture/storage-matrix.md`
before writing the implementation plan:

```text
path or data                                           backing                backup
──────────────────────────────────────────────         ─────────────────      ─────────

stateDir/credential-actions/agents/<agentId>/          RealFS stateDir        yes
  providers/<providerId>/profiles/<profileId>/         encrypted secret
trusted credential state, default agent-scoped         backup state

stateDir/credential-actions/shared/providers/          RealFS stateDir        yes
  <providerId>/profiles/<profileId>/                   encrypted secret
explicitly shared trusted credential state             backup state

stateDir/runner-leases/<recordId>.json                 RealFS stateDir        yes
runner runtime record, no credential bytes             durable recovery record

runner run input                                       MemoryProvider or      no
bounded per-run files                                  rootfs/COW

runner run output                                      MemoryProvider first   no
bounded per-run files                                  streamed before close

runner scratch / cwd                                   rootfs/COW preferred   no
provider temp files, package/cache churn               deleted with VM
```

The host path resolver for credentialed actions should produce typed storage
locations instead of passing raw strings through the system:

- `CredentialActionStatePath` for encrypted durable credential state;
- `RunnerRuntimeRecordPath` for non-secret runtime records;
- `CredentialActionRunInputPath` and `CredentialActionRunOutputPath` for
  per-run transfer surfaces;
- `CredentialActionScratchPath` for VM-local scratch.

Any path that crosses controller, gateway, Tool VM, or runner namespaces must
use a runtime path mapping object and the shared translator. The mapper rejects
parent traversal before normalization; credentialed actions should inherit that
discipline rather than doing ad hoc `path.join()` validation at call sites.

## VFS And Runtime Paths

The spec uses logical mount roles:

- credential state;
- run input;
- run output;
- scratch.

For a `gondolin-rpc-runner`, the proposed guest paths are:

```text
/cred
/run-in/<runId>
/run-out/<runId>
/scratch/<runId>
```

This is valid only because Gondolin bind-mounts VFS mount keys at their literal
guest paths while also exposing all VFS content below `/data`. The implementation
plan must include a live test that proves the exact runner image sees these
literal paths. If that test fails, the runner must use `/data/<mount>` paths or
install explicit image aliases before any provider work begins.

No agent-facing API accepts those paths. The controller constructs them from the
run id. Any path crossing runtime boundaries must use the runtime path mapping
pattern and must reject parent traversal before normalization.

## Artifacts

The old plan's artifact policy is not safe enough.

`ManagedVm.fs.stat()` follows symlinks and `ManagedVm.fs` does not expose
`lstat()`. Therefore v1 must not claim symlink refusal unless one of these is
true:

1. Gondolin adds a no-follow or `lstat` API and the implementation uses it.
2. The artifact provider is proven by tests not to represent symlinks.
3. The controller reads artifacts from a host-owned provider surface that can
   enforce no-follow semantics.

Until then, v1 output should prefer:

- bounded stdout JSON;
- bounded stderr diagnostics;
- controller-authored structured records;
- explicit provider-specific fixed output files only when a symlink-safe read
  path exists.

If file artifacts are included in an implementation slice, the tests must prove:

- parent traversal rejection;
- unknown artifact name rejection;
- max file size enforcement before streaming;
- `managedVm.fs.readFileStream()` is used for artifact transfer, not
  full-file `readFile()` buffering;
- non-regular file rejection;
- symlink-to-credential-state cannot be published;
- artifact stream active-use protection prevents normal lease release mid-read.

## OAuth And `gog`

OAuth is a custody problem first, not an execution problem.

For `gog` and Google:

- Service accounts/domain-wide delegation are best for automated runner use when
  available. If the private key must enter the VM, this is
  `ephemeral-materialized` or `trusted-credential-state`, not host-mediated.
- User OAuth with refresh tokens is `trusted-credential-state` unless a
  host-brokered refresh design is implemented.
- `gog auth add --remote --step 1/2` is compatible with a non-PTY maintainer
  flow because the operator can complete browser auth outside the VM and submit
  the redirect URL through a protected maintainer action.
- Interactive PTY login is out of scope until a separate duplex maintainer
  transport exists.

Maintainer actions:

- are protected by zone admin auth;
- are invoked through controller-owned admin surfaces, starting with an
  `agent-vm controller credential-actions ...` CLI that calls protected
  controller operations;
- never appear in the agent-callable catalog;
- use fixed provider-defined actions;
- do not accept arbitrary argv, shell, env, cwd, or path input;
- acquire the same credential-state key lock used by agent runs;
- are mutually exclusive with agent actions on the same credential state;
- are non-PTY in v1. Browser or OAuth redirect steps must be modeled as fixed
  maintainer actions such as `prepare-auth-url` and `complete-auth-redirect`,
  not as interactive shell sessions.

## Security Invariants

- Default to HTTP mediation.
- Raw env for provider credentials is an explicit exception, following the
  gateway `rawEnvSecrets` pattern.
- Long-lived credential files are never mounted into the existing agent Tool VM
  in v1.
- The model never supplies executable paths, argv arrays, env maps, cwd, or host
  paths.
- Provider catalogs must deny shell binaries and shell launchers as argv[0].
- If catalog code builds argv, tests must prove user-derived args cannot become
  shell programs, path traversal, or undeclared provider paths.
- Allowed egress hosts are a trust boundary. A VM with access to a host can
  upload any data it can read to that host.
- WebSockets are handshake-mediated only. Opaque WebSocket payload auth is not a
  host-mediated credential mode.
- Request-body secrets are not HTTP-mediated. They require raw exception,
  host-brokered auth, ephemeral materialization, or trusted credential state.

## Audit And Correlation

Each action run gets:

- `runId`: UUIDv7;
- `activeUseId`: UUIDv7 or current active-use id type if generalized;
- `agentId`;
- `zoneId`;
- `profileId`;
- `providerId`;
- `actionRef`;
- `custodyMode`;
- `executionBackend`;
- `argvHash` for runner backends;
- args hash;
- approval token id if used;
- start/end timestamps;
- exit code or signal;
- stdout/stderr byte counts and truncation flags;
- artifact summaries;
- outcome: `completed`, `failed`, `cancelled`, `timed-out`, or `abandoned`.

`argvHash` must be deterministic. Use:

```text
sha256 hex of JSON.stringify(argv)
```

If a future implementation needs canonical JSON beyond arrays of strings, define
that canonicalization before writing tests.

## Config Model

Do not add a large config surface before the first backend slice is chosen.
The stable conceptual shape is:

```jsonc
{
  "credentialActions": {
    "profiles": {
      "default": {
        "actions": {
          "allow": ["google.calendar.list_events"],
          "requiresApproval": ["google.calendar.create_event"]
        }
      }
    },
    "providers": {
      "google": {
        "custodyMode": "host-mediated",
        "executionBackend": "tool-vm-mediated",
        "identityScope": "agent"
      }
    },
    "actions": {
      "google.calendar.list_events": {
        "provider": "google",
        "executionBackend": "tool-vm-mediated"
      }
    }
  }
}
```

`identityScope` is optional for Tool VM mediated execution because Tool VM lease
identity already comes from the existing per-agent Tool VM model. It becomes
required for warm `gondolin-rpc-runner` profiles where sharing policy affects
lease reuse.

When an independent runner VM is introduced:

- add `credential-runner` as a runtime audience;
- do not overload `both` to mean three runtimes. The credential-runner slice
  must introduce an explicit runtime-audience list shape for any config surface
  that can target gateway, Tool VM, and credential runner together;
- require provider hosts to be covered by `egressHosts` for
  `credential-runner` or an explicit audience list containing
  `credential-runner`;
- keep Tool VM backend provider hosts on `tool-vm`;
- keep raw runner env secrets behind an explicit allowlist if raw env is added;
- put trusted credential state under zone `stateDir`, not `cacheDir`.

## Implementation Slices

### Slice 0: freeze the old plan

- Mark `2026-05-22-credentialed-runner-v1.md` as superseded for execution.
- Keep `2026-05-20-credentialed-tool-system.md` as historical design input.
- Use this spec as the active design source.

### Slice 1: credentialed action facade over Tool VM mediated credentials

Purpose:

- Prove the agent-facing facade, trusted identity, profile policy, approval
  decisions, args hashing, audit records, and real OpenClaw Tool VM path.

Backend:

- `tool-vm-mediated`.

Custody:

- `host-mediated` only.

Required tests:

- catalog/profile unit tests;
- trusted agent identity tests;
- approval/hash tests;
- config validation for mediated hosts;
- MCP Portal namespace integration tests for item-level policy and per-item
  result shape;
- integration test with fake Tool VM backend;
- gated live OpenClaw/Gondolin smoke that exercises:
  OpenClaw native tool -> controller -> Tool VM lease -> SSH command path ->
  placeholder env visible -> raw secret not visible.

### Slice 2: `gondolin-rpc-runner` substrate

Purpose:

- Add actual controller-owned runner leases only after the facade exists.

Backend:

- `gondolin-rpc-runner`.

Custody:

- start with `host-mediated` or `ephemeral-materialized`;
- add `trusted-credential-state` only with maintainer lock and state path tests.

Required tests:

- VM spec tests for no SSH, no ingress, conditional `tcpHosts`, expected VFS
  paths, and prepared image cache use;
- `RunnerLeaseId` UUIDv7 validation tests;
- agent-scoped, profile-shared, and per-run lease identity tests;
- live VFS path test proving literal mount paths or `/data` paths;
- output drain test with stdout/stderr byte counts and caps;
- abort/truncation test;
- lease identity/compatibility tests, including non-secret credential mount
  source fingerprint changes;
- runtime record create/delete/preserve-on-close-failure tests;
- next-startup orphan cleanup test for a leaked runner VM;
- liveness probe success, timeout, and non-404/non-not-found error propagation
  tests;
- recovery tracker tests for healthy, stale, suspended, and cold-start-needed
  runner states;
- active-use heartbeat/end/tombstone tests;
- maintainer-vs-agent race test;
- controller shutdown force-release test;
- gateway restart dependency tests proving independent runners survive restart
  while gateway-coupled active calls are cancelled or abandoned;
- independent runner recovery test.
- storage matrix and typed path resolver tests proving credential state lives
  under `stateDir`, runtime records use `runner-leases`, run input/output are
  non-backup, and scratch is VM-local/rootfs or another explicit non-backup
  class;
- runtime audience config tests proving `credential-runner` uses an explicit
  audience list and does not extend `both`.

### Slice 3: trusted credential state and provider-specific maintainer flows

Purpose:

- Support OAuth state and CLI credential files.

Custody:

- `trusted-credential-state`.

Required tests:

- age-encrypted state round trip, or an explicit test proving the configured
  plaintext mode is rejected unless a named unsafe escape hatch is enabled;
- state dir resolves under `stateDir`, never `cacheDir`;
- directory mode is `0700`;
- maintainer action cannot run with active agent uses;
- agent action cannot run during maintainer action;
- maintainer actions are not listed in agent catalog;
- refresh token or client secret never appears in audit, stdout, stderr, or
  artifact metadata;
- provider-specific live smoke gated by real credentials.

### Slice 4: file artifacts

Purpose:

- Add artifact streaming only after symlink/no-follow safety is solved.

Required tests:

- symlink-to-credential-state rejection;
- file size cap before stream;
- active-use protection during stream;
- force release behavior while artifact stream is active;
- artifact URL/run id correlation.

## Test Pyramid

Unit tests:

- catalog profile resolution;
- action visibility;
- action args validation;
- approval decisions and hashes;
- custody/backend compatibility matrix;
- argv builder deny list;
- output drain and caps;
- runtime path mapping;
- credentialed-action storage path resolution;
- lease identity/compatibility;
- active-use lifecycle;
- runtime record lifecycle and next-startup cleanup;
- runner liveness and recovery decisions;
- gateway restart dependency classification for Tool VM leases, independent
  runner leases, and gateway-coupled active calls;
- audit record construction.

Integration tests:

- controller route to facade core with fake backends;
- fake `ManagedVm` runner exec/fs behavior;
- config validation across `zone.secrets`, `egressHosts`, and backend audience;
- OpenClaw plugin native tool calls with trusted `ctx.agentId`;
- MCP Portal credential-actions namespace calls with trusted identity and
  item-level approval;
- lease recovery invalidates stale handles without restarting gateway.

Live VM integration:

- Tool VM mediated placeholder is visible to non-login SSH shell and raw secret
  is not visible. Existing coverage should remain.
- `gondolin-rpc-runner` boots real image, runs fixed argv, drains stdout/stderr,
  and validates VFS paths.

Smoke:

- Real OpenClaw gateway, controller, plugin, Tool VM lease request, and Tool VM
  command path.
- Skipped live smoke is not evidence. If gated env is absent, report exactly
  what was not exercised.

Provider smoke:

- Optional, gated by provider-specific env and credentials.
- For Google/gog, smoke must declare whether it uses service account,
  host-mediated token, or trusted OAuth state.

## Open Questions

These should be resolved before writing an executable implementation plan:

1. Which first provider/action is the proof case: Google Calendar via `gog`,
   Linear via MCP Portal, or a minimal local fake provider?
2. For Google, do we want service accounts/domain-wide delegation first, or user
   OAuth with trusted credential state?
3. Do file artifacts wait for Gondolin no-follow/lstat support, or do we prove a
   symlink-free provider path for a limited v1 artifact channel?
4. Is age-encrypted durable credential state required for v1, or is
   plaintext-under-`stateDir` acceptable behind an explicit unsafe flag?
5. Does the first implementation need a shared host-mediated runner at all, or
   is Tool VM mediated execution enough until a provider needs fixed argv?

## Decision Summary

Adopt "Credentialed Actions" as the design name.

Use a facade-first design:

- the default facade is an MCP Portal namespace; native OpenClaw tools are
  wrappers, not a second policy system;
- agent-facing policy and approval are independent of execution;
- credential custody is independent of execution;
- existing Tool VM mediated env is a valid backend for host-mediated actions;
- `gondolin-rpc-runner` is the stricter backend for controlled argv, provider
  credential files, and future trusted state;
- trusted `/cred` is an explicit high-trust mode, not the default v1 model;
- durable trusted credential state should be encrypted at rest, preferably using
  the older age + 1Password-held identity model;
- runner leases use compose-from-primitives for locks, active-use,
  runtime-record, liveness, reaper, and recovery behavior;
- runner lease identity is custody-conditional: agent-scoped for trusted state
  by default, per-run for ephemeral materialization, profile-shared only for
  explicitly stateless/shareable host-mediated runners;
- credentialed action storage must be added to the storage matrix and resolved
  through typed storage/path mappers, not ad hoc strings;
- runner execution uses the Gondolin VM SDK directly: fixed absolute argv,
  streaming `process.output()`, streaming `vm.fs` file transfer, no in-VM
  listener, and no custom RPC;
- file artifacts are deferred until symlink-safe publication is real.

The next artifact should be a fresh TDD implementation plan derived from this
spec, not another patch over the old runner plan.
