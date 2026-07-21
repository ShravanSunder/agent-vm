# Agent VM Tool Portal service, Gateway runtime, and SDK contract

Date: 2026-07-12
Status: draft under maintainer review

This spec defines the target Tool Portal service, Gateway runtime, client SDK,
sandbox, execution, communication, lifecycle, recovery, and observability
contracts for managed OpenClaw and Hermes Gateway VMs.

The companion [glossary](./glossary.md) is normative. Terms in this spec have
the meanings defined there.

## Supersession

This contract supersedes predecessor design requirements where they conflict:

- `docs/specs/2026-06-25-tool-portal-composition-contract.md` remains source
  history for Tool Portal semantics, CLI policy, and controller
  re-authorization, but Python SDK is now version-1 scope and managed plugins no
  longer host Tool Portal in process.
- `docs/specs/2026-06-30-gateway-control-session-hard-cutover.md` remains source
  history for authority and control semantics, but a failed service probe is no
  longer required to corroborate sustained authority-bearing control death.
- `docs/specs/2026-07-01-socketio-control-protocol-semantics.md` remains source
  history for bounded control admission, but the controller may broker a
  separate bounded execution data connection for controller-owned runners and
  host actions. Socket.IO itself remains control-only.
- `docs/specs/2026-07-12-gateway-managed-vm-package-boundaries.md` remains a
  normative substrate. Its hard package rename, backend-neutral `ManagedVm`,
  owned-directory fencing, durable process identity, narrow capability
  projection, exact two-module Gondolin import allowlist, declaration/package
  artifact guards, and real-VM boundary proof remain mandatory. This contract
  extends that graph; it does not replace or weaken it.
- The sibling `2026-07-12-hermes-agent-vm-integration.md` remains source history
  for Hermes BaseEnvironment, operation-group, process, strict-SSH, lifecycle,
  and proof constraints. Its direct MCP Portal topology, TypeScript integration
  runtime, Hermes-child supervision, child-local restart, and direct-MCP
  non-goals are superseded. A managed Hermes integration is one framework
  service sibling using one GatewayRuntimeClient and the common Tool Portal
  service.
- The sibling
  `docs/specs/2026-07-17-agent-vm-storage-layout/2026-07-17-agent-vm-storage-layout.md`
  is normative for host storage classes, per-agent workspaces, managed Tool VM
  guest paths, optional workspace Git, and capability rebinding. Where predecessor text mentions `selfRoot`,
  `workRoot`, `/agent`, durable RealFS `/work`, two-root coherence, raw
  `workMountDir`/`hostWorkMountDir` authority, or `gateway.zoneGit`, the storage
  contract supersedes it. This document owns service and execution behavior
  against the controller-selected storage binding; it does not redefine the
  storage model.

No predecessor behavior survives as a compatibility path unless this contract
states it explicitly. The deliberate recovery changes here make Tool Portal
service-process or framework-service-process loss Gateway-fatal, remove
same-Gateway process replacement, and remove service-probe corroboration from
sustained control-session death. Existing controller-owned grace, retry budgets,
cooldown, stabilization, fencing, durable identity, positive containment, and
no-flap behavior remain unless this contract states a different rule.

## Product intent

Agents need one portable capability product and one dependable managed sandbox
runtime:

- Generic MCP clients and CLIs can discover and invoke the portable
  capabilities admitted by their runtime mode. Managed mode includes bounded
  persistent-sandbox work; standalone version 1 admits MCP-provider-backed
  capabilities without acquiring implicit VM or controller authority.
- Managed OpenClaw and Hermes integrations can use the same capabilities plus
  direct execution, filesystem, process, stream, and terminal behavior required
  by their native sandbox APIs.
- One ToolPortalService owns the controller relationship, agent-specific Tool
  VM bindings and SSH connections, both request surfaces, capability catalog,
  policy, approval semantics, routing, normalized results, and connection
  status regardless of transport or language.
- The controller remains the sole durable VM, lease, credential, execution,
  approval-freshness, and recovery authority.
- Gateway, Tool VM, communication, SSH, and telemetry failures have explicit,
  typed containment and recovery behavior.
- Routine LLM interaction remains simple and fast. Reliability mechanisms are
  bounded and proportional to actual command/file data, not built as a generic
  distributed streaming platform.

## Success promise

```text
standalone Tool Portal consumer
  -> ToolPortalMcpClient or generic MCP
  -> configured standalone Tool Portal MCP projection
  -> ToolPortalService
  -> Capability API
  -> exactly one trusted capability binding
  -> canonical result

managed OpenClaw / Hermes adapter
  -> exactly one GatewayRuntimeClient
     -> authenticates framework-native agent origin
     -> maps origin through one controller-authored ManagedAgentProjection
     -> .portal list/search/describe/call
        -> ToolPortalService Capability API
        -> configured backend; a tool_vm_runner may use the agent's Tool VM
     -> .sandbox exec/fs/process/stream/attach
        -> ToolPortalService SSH Sandbox API
     -> both Tool VM paths converge only after distinct admission
        -> current agent-specific Tool VM binding
        -> current agent-specific maintained SSH connection
        -> /workspace is the selected filtered durable agent workspace
        -> /work is fresh rootfs/COW hot work and the default cwd
        -> /gitdirs contains the optional persistent workspace Git database
        -> /agent-vm contains reviewed read-only runtime inputs

controller
  -> durable authority and recovery decisions
  -> prepares immutable config, mounts, environment, ingress, and boot inputs
  -> boots and manages one Gateway VM; never starts guest service processes

Gateway VM boot contract
  -> starts one Tool Portal service process
  -> starts one OpenClaw or Hermes framework service process
  -> exact sibling roles start concurrently; neither supervises the other

Gateway runtime
  -> implementation role hosted by the Tool Portal service process
  -> constructs and hosts one ToolPortalService

ToolPortalService
  -> owns current-epoch controller, binding, SSH, execution, artifact,
     capability, and status mechanics
  -> never shares a Tool VM binding, SSH connection, environment, process,
     stream, terminal, or result handle across agents
```

For a cross-mode equivalence cohort, a standalone MCP-provider call and managed
UDS MCP-provider call bind equivalent agent, profile assignment, namespace policy, capability,
canonical public arguments, and approval state. Within that cohort the call has the same
visibility, approval, routing, terminal meaning, errors, artifacts, and result
semantics. Authentication envelopes, progress encoding, bounded text rendering,
and cancellation transport may differ. Surface policy may intentionally deny a
capability outside the cohort; such denial is proven as scoped divergence, not
implemented as a second semantic router.

## Product non-goals

- No compatibility aliases or dual managed paths.
- No OpenClaw- or Hermes-owned Tool Portal service.
- No managed plugin with ToolPortalMcpClient; managed plugins use only
  GatewayRuntimeClient over the private UDS.
- No managed Gateway Tool Portal HTTP, MCP, stdio, or public ingress listener.
- No raw lease, active-use, SSH, PID, signal, VM, recovery, or controller
  authority exposed to any client.
- No public remote equivalent of the private UDS surface.
- No generic shell-string interpreter for controller-owned execution.
- No generated per-capability MCP tools in version 1.
- No MCP PTY, attach, raw stdin, or unbounded byte stream.
- No process, VM, socket, SSH, lease, or command continuity across replacement.
- No parent/child, launch, supervision, restart, or adoption relationship
  between the Tool Portal service and the selected framework service.
- No controller `ManagedVm.exec()` call, process API, or equivalent post-boot
  command starts either managed Gateway service process.
- No same-Gateway restart or replacement of either sibling service process.
- No exactly-once promise across an ambiguous side-effect boundary.
- No automatic replay of an ambiguous or non-idempotent mutation.
- No Gondolin patch, pnpm patch, fork, or VM-backend redesign.
- No broad OpenClaw fork or alternate tool stack. The only framework-core
  extension is the narrow managed SandboxBackend native-agent identity,
  workspace routing, mandatory UDS filesystem bridge, and
  agent-authored-versus-managed skill policy required by R5c and proven against
  the pinned managed OpenClaw version. It cannot restore `/agent`, a durable
  `/work` mount, raw host-path authority, or plugin-local lease/SSH/runtime logic.
- No agent-vm-owned Zig/native helper, privileged in-guest launcher, separate
  runtime/framework OS-principal boundary, or HMAC/bearer protocol between
  trusted components inside one Gateway VM.
- No requirement to add a second VM backend.
- No migration of the Agent Worker Gateway into `@agent-vm/gateway-runtime`.
  Worker keeps its direct per-task `GatewayLifecycle` process model.
- No native Gondolin filesystem handle, `getVmInstance()`, aggregate
  `ManagedVmProvider`, or raw-path fallback in Gateway runtime or controller
  execution domains.

## Requirements

### Product and ownership

R1. Tool Portal is the managed capability product and its backend semantic
scope includes MCP Portal-mediated and non-MCP capability classes.

R2. MCP Portal remains independently usable and owns only upstream MCP provider
configuration, credentials, sessions, transport, validation, and routing.

R2a. The authored configuration files have distinct product scopes.
`mcp.config.jsonc` owns upstream MCP providers, transports, egress, and provider
secrets. `mcp-portal.config.jsonc` owns the focused standalone MCP Portal
product. `tool-portal.config.jsonc` owns Tool Portal in both managed and
standalone modes: agent/profile assignments, cross-backend namespace bindings,
tool visibility, call policy, approval policy, and mode-specific entrypoint and
authentication configuration. It is one strict discriminated union on `mode`.
The `managed` branch permits only the fixed private UDS and forbids standalone
endpoint/authentication fields. The `standalone` branch explicitly enables and
configures each HTTP/MCP/stdio entrypoint and its authentication and admits only
`mcp_provider` bindings in version 1. `tool_vm_runner` and
`controller_host_action` require managed controller/Gateway authority and are
rejected by standalone schema and startup validation rather than receiving an
implicit local or controller connector. The schemas
may reuse strict lower-level selector and authentication primitives, but there
is no implicit merge, inheritance, compatibility alias, or generic
`portal.config.jsonc` source.

R3. ToolPortalService is the one transport-neutral application-service owner in
each Tool Portal composition. In every mode it owns the Capability API,
caller-scoped catalog visibility, profile policy, portable approval behavior,
capability binding/routing, normalized public results/events, and artifacts. In
managed mode it additionally owns the controller relationship, current
agent-specific Tool VM bindings, proactive SSH connection establishment and
health, SSH Sandbox API, and per-agent connection status. Standalone version 1
constructs none of those managed-only authorities. Internal capability-routing,
binding, connection, sandbox, artifact, and status components may remain
separate by responsibility, but none is a second service owner or independent
authority.

R3a. Every Tool Portal profile uses `profiles.*.namespaces`. Each namespace
selects one backend and owns tool visibility, call, and approval policy. The
former `profiles.*.capabilities` key is removed in one hard cut with no alias or
dual reader. Managed Gateway composition derives ToolPortalService policy from
the `managed` branch of authored `tool-portal.config.jsonc`, never from
`mcp-portal.config.jsonc`. Standalone Tool Portal derives the same semantic
policy from the `standalone` branch. Every configured agent reaches one
ToolPortalService and one shared MCP-provider runtime per service process;
trusted invocation context selects the caller's authorized view per operation,
not a separate agent-bound backend.

R4. Canonical contract modules own representation and runtime validation;
ToolPortalService owns live semantic, binding, connection, and execution
decisions inside its controller-authorized ceiling. Co-location inside one SDK
distribution does not permit either ownership to absorb the other.

R5. Managed OpenClaw and Hermes adapters construct exactly one
GatewayRuntimeClient and do not construct ToolPortalMcpClient or host
ToolPortalService.

R5a. Before Gateway boot, the controller materializes exactly one immutable
`ManagedAgentProjection` for every configured Agent VM agent. Each projection
contains `agentId`, one discriminated `frameworkIdentity`,
`toolPortalProfileId`, and `profileAssignmentRevision`. `frameworkIdentity` is
exactly `{ kind: "openclaw", agentId }` or `{ kind: "hermes", profileName }`.
Framework Gateway paths may be deterministically derived from agent identity
for native framework use, but no host path or managed Tool VM guest path is
caller authority. The exact workspace source, optional workspace Git policy and
database, owned-directory identities, and Tool VM generation belong to a
separate controller-owned current Tool VM storage binding. Missing,
duplicate, ambiguous, undeclared, cross-kind, or colliding identities fail
before Gateway admission.

R5b. One long-lived GatewayRuntimeClient connection may serve multiple
configured agents only through the selected framework's native identity
separation. The framework adapter is the managed origin authenticator: it
derives the actual OpenClaw agent ID or routed Hermes profile from
framework-owned callback/routing state, rejects missing, ambiguous, mismatched,
undeclared, or model-supplied identity, and maps it to exactly one
ManagedAgentProjection. It sends a trusted invocation envelope outside public
arguments containing the projection's stable principal, optional
framework-validated requester context, and optional correlation. The Tool
Portal service trusts the admitted adapter only for callback-origin validation;
it independently validates the asserted principal against the immutable
projection and resolves the current controller-authorized Tool VM storage
binding. Requester, correlation, public arguments, and adapter payloads never
select `/workspace`, `/gitdirs`, a host directory, mount, lease, Tool VM, SSH
identity, profile assignment, or process authority.

The long-lived GatewayRuntimeClient and UDS attachment may multiplex configured
agents, but Tool VM connection state may not. ToolPortalService owns one
independent connection slot for each configured `agentId`. Each slot contains
that agent's current binding, SSH connection, environment registry, process
registry, stream/terminal registry, retained-result registry, and status record,
and accepts only the complete matching stable principal, assignment revision,
Gateway epoch, Tool VM binding, and generation. No lookup may fall back to the
UDS client connection, framework kind, Tool Portal profile, or process-global
state, and one agent's failure or replacement cannot retire, reroute, or satisfy
another agent's connection. The sole version-1 exception is bounded
transport-level head-of-line delay on the shared framework UDS attachment under
R25a/R25b. That delay never changes another agent's authority, binding, SSH
connection, registries, handles, retirement, routing, or failure state and never
blocks the separate controller control plane.

R5c. The managed OpenClaw adapter maps every configured Agent VM `agentId`
exactly once to the same native `agents.list[].id`. OpenClaw's per-agent native
workspace remains `/zone/agents/<agentId>` in the Gateway VM: it is the
framework-native home for identity/instruction files, memory, agent-authored
skills, and prompt construction, and identifies the same durable workspace
exposed to the selected Tool VM at `/workspace`. OpenClaw SDK `workspaceDir` is
validated only as a configured-agent identity selector; it does not cross
Gateway Control as host-path or guest-path authority. OpenClaw `agentDir`, auth
profiles, sessions, and other protected framework state remain separate under
the preserved Gateway `stateDir` paths and never enter a Tool VM. The plugin
registers Tool Portal native tools, one long-lived UDS client lifecycle, and one
thin UDS-backed OpenClaw `SandboxBackend`. The backend routes shell/process
execution and the filesystem bridge through GatewayRuntimeClient; it owns no
controller, lease, active-use, SSH, VM, path-translation, or recovery logic.
Relative tool paths and default execution cwd resolve to rootfs/COW `/work`;
explicit durable agent-file paths resolve under `/workspace`; the optional
workspace Git database appears only at `/gitdirs/workspace.git`; reviewed generated inputs under
`/agent-vm` are read-only. No terminal, process, code, file, edit, or apply-patch
operation falls back to the Gateway filesystem or a direct plugin SSH path.
Pinned OpenClaw `2026.6.8` already models distinct sandbox `workspaceDir` and
`agentWorkspaceDir` roots, lets a registered backend expose its workdir and
remote agent-workspace root, routes both through one backend filesystem bridge,
and protects skill-source overlays in a writable sandbox. The managed adapter
reuses those contracts with `/work` as the backend workdir and `/workspace` as
the remote agent-workspace root; it does not replace the stock
workdir/agent-workspace routing machinery.
Four pinned gaps require one narrow reviewed OpenClaw integration hook:
`CreateSandboxBackendParams` does not carry the resolved native agent ID, and
core automatic memory flush selects and path-maps through the sandbox workspace
rather than the durable agent workspace. Sandbox context also falls back to a local
filesystem bridge when a backend omits one, and stock skill protection treats
agent-workspace skill sources and deployment-managed skills as one read-only
class. The hook therefore passes the resolved framework agent ID to backend
creation; supplies `/workspace` as both the automatic memory-flush root and its
filesystem-bridge mapping root; marks the managed backend's UDS filesystem
bridge mandatory before any local fallback is constructed; and distinguishes
writable agent-authored skills beneath `/workspace` from the separate read-only
deployment-managed skill projection. Bridge and exec paths expose the same
mutability for both skill classes. A tool-name/path heuristic or
`before_tool_call` rewrite is not a sufficient contract. Exact type names and
overlay allocation are plan-owned; collapsing the roots, duplicating unrelated
stock mount logic, or restoring plugin-local authority is not.

R5d. The managed Hermes adapter maps every configured Agent VM `agentId`
exactly once to a unique native Hermes `profileName`. One Hermes Gateway service
may multiplex all configured profiles. The routed `SessionSource.profile`, not
a process-global default or model/session field, selects the current projection.
Managed materialization supplies the exact allowed profile set; the upstream
behavior that discovers every named profile beneath the Hermes profiles root is
not admission authority. An extra local profile, an omitted configured profile,
or two projections naming one profile fails before readiness. Every managed
ingress and routed turn revalidates the routed profile against the immutable
cohort before adapter, session, environment, or tool state is created.
Post-readiness profile-set drift is rejected immediately, makes the projection
cohort unhealthy and Gateway-fatal, and routes recovery to whole-VM replacement;
it never activates an adapter or falls back to `default`. Hermes
`profileName` is framework identity and remains distinct from
`toolPortalProfileId`, which selects Tool Portal policy only.
Hermes retains whole-turn context-local `HERMES_HOME`, fail-closed profile
secret scope, profile-stamped session keys, and profile-scoped adapter/config
loading. Session reads/writes are profile-isolated; physical stores may be
separate or safely namespaced inside one protected store, but no query, cache,
resume, branch, or history operation crosses profiles. The complete
`HERMES_HOME` is protected framework state and is never mounted into a Tool VM.
Only explicitly framework-approved agent-owned files originate from the
canonical `zoneFilesDir/agents/<agentId>` workspace and may appear through
Hermes-native profile paths and the selected Tool VM `/workspace` projection;
config, `.env`, credentials, sessions, Gateway state, logs, caches, and other
runtime files do not. The managed Hermes integration exposes that content at
the framework's expected per-profile paths through a narrow projection with one
storage owner; it does not copy, merge, or independently synchronize two
writable authorities.

R5e. Hermes terminal, file, code-execution, and process behavior use one managed
Python `BaseEnvironment` backed by the same GatewayRuntimeClient/UDS service as
OpenClaw. Inside the Tool VM the environment starts at rootfs/COW `/work`,
exposes the selected durable workspace at `/workspace`, the optional workspace
Git database at `/gitdirs/workspace.git`, and reviewed read-only runtime inputs at `/agent-vm`, and
preserves BaseEnvironment logical cwd, environment snapshot, nested
file-operation, process-handle, cancellation, and ambiguity semantics.
Process-global `TERMINAL_CWD`, `os.getcwd()`, and
`TERMINAL_ENV=local` are not path or execution authority in managed mode. A
missing, stale, or mismatched managed environment fails closed; managed mode
never executes terminal, file, or `execute_code` work in the Hermes Gateway
process. Environment and file-operation registries never use Hermes's ordinary
collapsed `default` task key in managed mode; they key the complete managed
projection and live generations.

R6. Gateway runtime is the Gateway-local infrastructure implementation hosted by
one managed Tool Portal service process. That process constructs and hosts one
ToolPortalService. ToolPortalService owns UDS admission, the Gateway-side
control endpoint/peer, agent-specific Tool VM bindings, Tool VM connection
management, direct SSH/process/stream/terminal custody, both request surfaces,
connection status, and its own bounded shutdown. It does not launch, parent,
supervise, signal, restart, or adopt the selected framework service. The
controller initiates the Socket.IO connection. Gateway runtime cannot mint
controller authority.

R6a. A managed Gateway image implements one exact Managed Gateway Boot Contract:
one common Tool Portal service boot entry plus exactly one selected
OpenClaw-or-Hermes framework service boot entry. The existing Gondolin guest
boot/init extension starts both long-lived roles without waiting for either role
to become ready, then continues its normal handoff to `sandboxd`. The two
service processes are siblings and both run under the existing guest-root
service identity, UID/GID `0`. The boot path introduces no UID/GID transition,
separate service account, cross-UID filesystem projection, or in-VM principal
boundary. The boot extension is image-owned startup
plumbing, not a third agent-vm service, resident supervisor, generic service
graph, restart manager, or new launcher executable. It never restarts either
role. The controller supplies immutable configuration, mounts, environment,
expected identities, and ingress policy and calls `ManagedVm.start()`; it never
starts either role through `ManagedVm.exec()` or an equivalent guest-process
API. Worker retains its direct per-task process lifecycle and does not use this
managed boot contract.

R6b. The Tool Portal service constructs exactly one shared MCP-provider runtime and one
MCP backend port for its ToolPortalService. The port accepts the service's
server-validated trusted invocation context and required dispatch authority on
every operation. Internal agent-scoped catalog, session, or cache views may
prevent state leakage, but they do not create per-agent provider backends,
independent policy authorities, or caller-selectable routing.

R6c. The controller materializes the immutable semantic snapshot, expected
Gateway/Tool-Portal/framework identities, protected runtime configuration, and
shared observability sink before booting the VM. Concurrent guest startup may
let the framework reach the UDS before the Tool Portal service publishes it. The
framework client retries only expected pre-publication absence/refusal within a
bounded, abortable, current-epoch deadline. Invalid handshake, permission,
protocol/schema, wrong-framework, wrong-projection-cohort, stale-generation, and
retired-epoch failures fail closed immediately. The adapter stops retrying,
becomes terminal-fatal and unready or exits, and permits a new attachment
attempt only after whole-VM replacement. Aggregate readiness requires positive
identity and health for both sibling processes, the active semantic revision,
UDS publication, one accepted current framework attachment, the control
relationship, and required backend/provider planes. Start-call success,
listener-only health, framework-only health, or telemetry health alone is never
aggregate readiness.
An agent without a current Tool VM binding need not have an SSH connection for
Gateway aggregate readiness. Once the controller publishes a binding, that
agent's Tool VM execution surface is unready until ToolPortalService reports its
agent-specific connection `ready`; backend-kind readiness or another agent's
healthy connection cannot substitute for that proof.
The VM boot and readiness join form one admission transaction. Any boot-entry
failure, early process death, readiness timeout, or abort withdraws admission,
and the controller positively contains the complete VM before reporting startup
failure. A running or ready sibling never makes the Gateway adoptable, never
publishes ingress by itself, and never permits same-VM repair. The controller
observes service identity and health but does not own guest PID lifecycle.
Tool Portal service loss is evidenced by loss of its authority-bearing control
session. While the Tool Portal service remains live, framework exit or
disconnect is evidenced by loss of the current UDS attachment and reported over
control; framework hang is evidenced by its framework-native readiness or
request-liveness deadline. That observation must complete a current-epoch
event-loop/request round trip through the framework's native dispatch and
adapter-origin path without invoking an LLM or upstream provider; process
existence, a bound port, or attachment liveness alone is insufficient. The exact
OpenClaw and Hermes probe shapes are plan-owned. Before readiness, a boot-entry failure or early death
is evidenced by the readiness join never completing. These signals are health
and accountability observations only: they grant no component launch, signal,
restart, supervision, adoption, or guest-PID authority over its sibling.

R6d. The framework owns the Gateway ingress. The managed framework-facing Tool
Portal Capability API and SSH Sandbox API are private-UDS-only: managed mode has
no root or public ingress, framework-facing HTTP route or listener, MCP listener,
stdio server, public credential set, managed-MCP readiness plane, rotation, or
drain contract. The private controller-initiated Socket.IO control endpoint and
the explicit private non-`/` controller-execution data route are permitted
controller-only endpoints. They are not Tool Portal API projections, are not
framework-facing, and are never Gateway ingress. Standalone Tool Portal
entrypoints are outside the Gateway VM and cannot be enabled by managed
configuration.

R6e. ToolPortalService maintains connection state independently for every
configured agent. After the controller publishes a valid current binding and
SSH access grant for one agent, ToolPortalService immediately begins that
agent's SSH connection instead of waiting for the first capability or direct
sandbox request. The agent-specific connection progresses through the distinct
`unbound`, `connecting`, `ready`, `reconnecting`, `degraded`, and `retired`
states with typed reason and freshness evidence reported over the existing
controller relationship. Only `ready` admits new Tool VM work. Requests while
the current connection is not ready fail with a typed retryable-unavailable or
terminal stale/retired result according to the binding state; they never borrow
another agent's connection or silently execute in the Gateway process.

Each connection is bound to one configured `agentId` and its complete stable
principal, assignment revision, Gateway epoch, current controller-authorized
Tool VM binding and lease authority, Tool VM generation, and pinned SSH server
identity. Active-use authority belongs to each admitted operation or operation
group, not to the maintained connection. A capability and a direct sandbox
operation for the same agent may share that exact connection manager and
lower-level SSH transport. Connections,
environments, processes, streams, terminals, retained results, cwd, and
filesystem handles never cross agents, framework identities, assignments,
Gateway epochs, or Tool VM generations. Replacement retires the old generation
for that agent and proactively connects only its controller-authorized
successor.

Connection readiness is not active-use evidence. Establishing, probing,
heartbeating, or retaining an idle SSH connection does not start or prolong a
lease active-use interval and cannot defeat controller idle reap. Each admitted
capability or direct sandbox operation starts and heartbeats its own bounded
operation or operation-group use; terminal cleanup ends that use. The
controller may retire an idle binding or Tool VM while its connection is
healthy, after which ToolPortalService closes that exact connection, retires its
handles, and reports the binding no longer ready.

R7. Controller owns durable Gateway/Tool VM parentage, paths, profiles,
credentials, leases, active uses, controller-owned execution, approval-record
validity, execution-fingerprint freshness, and recovery.

R7a. Every controller-owned runner is an operation-scoped VM leaf parented by
the current controller epoch and the exact originating Gateway epoch, principal,
and operation. Before protected work dispatch, the controller durably records
its reservation, VM ID, host PID, process start identity, command, generation,
and parentage using the existing managed-VM ownership/termination invariants.
Gateway retirement, controller restart, cancellation, or terminal cleanup fences
and positively contains the runner; it is never adopted or automatically
replaced. Unproven containment is owner-unsafe and the operation remains
ambiguous.

R7b. Before Gateway admission, the controller compiles authored
`mcp.config.jsonc`, authored `tool-portal.config.jsonc`, and controller-owned
surface/lifecycle data into one revisioned catalog/profile/policy/binding/provider
configuration snapshot. Managed composition does not consume
`mcp-portal.config.jsonc`. The Tool Portal service validates and activates the
snapshot atomically; it does not watch or independently reload deployment files.
The semantic snapshot is immutable for the Gateway epoch and changes require
Gateway replacement. Managed mode has no public Tool Portal credential state to
rotate. Readiness requires desired and active semantic revisions to match.

R7c. `stateDir` remains the per-zone durable Gateway state root and its
existing Gateway-visible relative paths are preserved exactly. OpenClaw,
Hermes, and Worker may mount their configured `stateDir` read-write at their
existing framework paths. Effective framework configuration, agent/profile
state, plugin state, existing sandbox records, task state, and other
framework-owned persistence remain at their current relative paths; this
correction does not introduce a `framework/` wrapper, rename a Gateway path,
or move an existing `stateDir` child. Managed-agent workspaces live directly at
`zoneFilesDir/agents/<agentId>`. An optional workspace Git database lives only
in the selected `runtimeDir` Git subtree. Neither is a controller record or
framework runtime state, and neither repurposes an existing
`stateDir` path.

R7d. Controller-owned durable records never live under or below any zone's
`stateDir` and are never mounted into a Gateway or Tool VM. One required
top-level `system.jsonc` path, `controllerStateDir`, belongs to the controller deployment, has no
default, and resolves relative to the system config file like `cacheDir` and `runtimeDir` before
canonical disjointness validation. It contains
per-zone records beneath `zones/<zoneId>/`: `approvals/**`,
`gateway-runtime.json`, and `tool-leases/**` where those record families apply.
Worker task Gateway records use a controller-owned task child beneath that
zone rather than the Worker-mounted `/state`. The deployment-wide controller
process-ownership lock remains process-lifetime coordination under
`runtimeDir`; it is not moved into durable controller state.
`controllerStateDir` must be canonically path-disjoint from `cacheDir`,
`runtimeDir`, every zone `stateDir`, every `zoneFilesDir`, every backup output,
managed observability storage, and every other Gateway or Tool VM mount source.

R7e. The controller-state relocation is a hard cut for the live beta Gateway
paths. Production readers and writers used by Gateway startup, Tool Portal,
OpenClaw, Hermes, leases, approvals, and workspace Git push consume only
`controllerStateDir`; there is no fallback, dual read, shadow write, adoption,
or compatibility alias for controller records under `stateDir`. Backup, restore,
legacy migration, doctor/destroy cleanup, and other administrative consumers
are not part of this beta goal and retain their current behavior.

R7f. Human-authored deployment configuration is controller input, not
Gateway-owned mutable state. Managed OpenClaw removes the broad authored
configuration-directory mount: the former plugin-local MCP Portal `configDir`
consumer is rejected in managed mode, and the controller already materializes
the exact effective framework, Tool Portal, and MCP inputs before boot.
Runtime/plugin writes use the existing Gateway `stateDir`, cache, log, or
zone-file paths instead. If real framework proof discovers one required
companion input, the controller materializes only that reviewed file closure
into a protected generated subtree; it never restores the authored parent
mount. A managed Gateway, including guest root, cannot read unrelated authored
siblings or persist changes into controller-authored desired configuration for
a successor epoch.

R7g. `zoneFilesDir` contains exactly one canonical durable workspace per
configured long-lived agent:

```text
<zoneFilesDir>/agents/<agentId>/
  .git   optional pointer only
  agent-authored files and framework-approved directories
```

The Gateway keeps its existing `/zone -> zoneFilesDir` mount. OpenClaw retains
`/zone/agents/<agentId>` as its native Gateway workspace. Hermes projects only
its approved subset into native profile locations. Authored config, framework
callbacks, adapters, models, and Tool Portal requests never provide host
equivalents, and neither framework mapping is Tool VM mount authority.

R7h. A managed Tool VM receives one controller-selected filtered workspace
capability at `/workspace`, at most one optional persistent workspace Git
capability at `/gitdirs/workspace.git`, a fresh rootfs/COW `/work`, reviewed read-only
generated inputs at `/agent-vm`, and guest tmpfs at `/tmp`. It receives no
durable `/agent`, `/self`, `/scratch`, durable RealFS `/work`, whole `/zone`,
sibling workspace, sibling Git database, `stateDir`, complete framework home,
controller state, authored configuration parent, runtime parent, cache parent,
or backup directory. There is no raw host-path fallback. Because the Gateway
siblings run as guest root in one trusted VM, per-agent separation remains an
admission/routing invariant and Tool VM mount boundary, not a claimed Unix
isolation boundary between the siblings.

R7i. `zones[].agents[].workspaceGit` is the only managed long-lived-agent Git
policy. Its exact strict discriminated union is:

```ts
type WorkspaceGitPolicy =
	| { readonly mode: 'local' }
	| {
			readonly mode: 'remote';
			readonly remote: {
				readonly repoUrl: string;
				readonly branch: string;
				readonly defaultBranch: string;
			};
	  };
```

Absence means no workspace Git database or pointer. `local` creates isolated
host-local history and has no remote or push surface. `remote` creates the same
isolated database and exposes `workspace_git_push` through Tool Portal as a
`controller_host_action`; the request travels over the private Tool Portal and
Gateway Control path, and the controller uses host-only HTTPS credentials. Tool
VM outbound Git SSH remains read-only and rejects `git-receive-pack`. A Tool
Portal profile that attempts to expose `workspace_git_push` to a `local` or
Git-disabled agent fails managed configuration/preflight. The action derives the
exact agent, repository, non-default branch, and current workspace Git binding
from trusted configuration; caller arguments cannot select or widen them.

Whole-zone writable Git authority is rejected. The controller treats all
agent-writable Git state as hostile. Current Worker task `repos[]`,
`repoPushPolicies`, `/work/repos`, and task Git behavior remain unchanged and do
not use this policy.

R7j. Tool VM persistent capability rebinding follows the Agent VM Storage Layout
And Agent Workspace Contract. Gateway Runtime consumes the controller-selected
binding and lifecycle evidence without weakening, duplicating, or reinterpreting
that authority. The same RealFS workspace is one source, not two synchronized
writable authorities. Backup, restore, legacy migration, and destructive
administrative consumers are outside this beta delivery.

### SDK and surface behavior

R8. TypeScript and Python each ship usable ToolPortalMcpClient and
GatewayRuntimeClient implementations. Generated schemas without client
behavior are not an SDK.

R9. ToolPortalMcpClient exposes Tool Portal `list`, `search`, `describe`, and
`call` over standard MCP plus authenticated bounded artifact readback through
standard MCP resources. It exposes no privileged sandbox-authority method.

R10. GatewayRuntimeClient exposes `.portal` with the same four Capability API
operations and `.sandbox` with direct SSH Sandbox API environment, execution,
filesystem, process, stream, terminal, and attachment operations. Both clients
expose an artifact reader that preserves the same authorization and generation
fencing.

R11. Standalone Tool Portal MCP advertises only `tool_portal_list`,
`tool_portal_search`, `tool_portal_describe`, and `tool_portal_call` in version
1. Standalone MCP Portal retains `mcp_portal_*`.

R11a. The standalone Tool Portal MCP server is a transport projection over the
standalone process's existing ToolPortalService instance. Streamable HTTP,
stdio, CLI, or SDK adapters do not instantiate a second service or policy state.

R11b. The `standalone` Tool Portal config branch explicitly enables each
entrypoint, binds its address/route, and selects its authentication. Every HTTP
request authenticates independently. A bearer credential identifies exactly one
configured agent/profile under a Tool-Portal-specific audience; a per-agent
HMAC proves approval for the exact protected call digest and is bounded,
expiring, and replay-protected. MCP Portal and Tool Portal credentials are not
interchangeable. A scoped stdio adapter has one immutable out-of-band principal.
Standalone retirement stops admission, drains within a positive bound, closes
sessions/listeners, and retires the shared service. None of this listener or
credential lifecycle exists in managed Gateway mode.

R11c. Artifact readback is a version-1 surface without a fifth Tool Portal tool.
The MCP projection exposes authenticated bounded resources; TypeScript/Python
clients expose `artifacts.read`, and GatewayRuntimeClient projects the same
operation over UDS. Artifact IDs are correlation only. Each read reauthorizes
principal, surface, agent/profile/subject, capability, operation/generation,
artifact fingerprint, expiry, and byte/range bounds. The Tool Portal service owns a
bounded epoch-local artifact store; epoch retirement deletes or invalidates its
contents, and no reference exposes a host or guest path.

R12. The portable Tool Portal call/result contract represents bounded
capabilities, including capabilities whose configured backend executes in the
current Tool VM sandbox, with finite requests/results, explicit
time/byte/process bounds, opaque handles, bounded logs, and artifacts. Managed
UDS `.portal` may invoke
those bindings. Standard standalone MCP version 1 does not author or advertise
them because it has no privileged backend authority. The portable shape never
exposes PTY, attach, raw streams, SSH, lease, PID, or Gateway lifecycle.

R13. TypeScript and Python validate the same authored schemas, protocol
version, canonical JSON subset, discriminants, defaults, errors, and fixtures.
Version skew fails before method admission.

R13a. The TypeScript SDK distribution ships a `tool-portal` CLI using
ToolPortalMcpClient. It exposes list/search/describe/call over configured
Streamable HTTP or scoped stdio, discovers endpoint and credentials only from
explicit operator arguments or protected deployment configuration, renders the
canonical result on stdout, sends diagnostics to stderr, uses stable exit
classes, maps interrupt to MCP cancellation, and owns no catalog, policy,
approval, binding, or backend logic.

R13b. Zod remains the authored contract source, but shared contracts use a
portable authoring profile. Every cross-field refinement, default, canonical
normalization, or numeric constraint that JSON Schema cannot preserve directly
uses a named machine-readable refinement descriptor with generated TypeScript
and Python validators. Anonymous/unregistered refinements and transforms are
forbidden on cross-language schemas. A structural guard rejects unexportable
constraints before fixtures run; generated schemas carry refinement identities,
and both runtimes apply the same defaults and canonical JSON rules.

### Capability and Tool VM access

R14. A public capability is `{ namespace, name }` plus public arguments.
Trusted configuration selects exactly one profile-revision-specific capability
binding. Backend kind and runner profile are not public selectors.

R15. Supported backend kinds are `mcp_provider`, `tool_vm_runner`, and
`controller_host_action`. In version 1, `tool_vm_runner` uses the trusted
`sandbox_ssh` profile against the caller's current agent-specific Tool VM
connection. Controller-owned execution remains a separate controller execution
path; it is not another `tool_vm_runner` profile. Managed mode may bind all
three backend kinds. Standalone version 1 may bind only `mcp_provider`;
selecting either privileged backend kind is a configuration and startup error.
A future standalone host adapter for VM, SSH, or host-action authority requires
a separate explicit contract and cannot be inferred from ToolPortalService's
generic backend ports.
The `workspace_git_push` controller host action is narrower still: it exists in
an agent's managed catalog only when that agent's trusted workspace Git policy
selects remote mode. Local and Git-disabled agents never receive that capability.

R16. Broad CLI allowances fix a trusted executable and mandatory prefix while
admitting only an already-tokenized, strictly validated caller argv tail and
bounded stdin. Promoted typed capabilities compile typed public fields to a
stricter trusted template.

R17. Controller-owned execution recomputes executable, mandatory prefix,
credentials, cwd, environment, egress, output, artifacts, cancellation, and
target from trusted controller configuration. Public or Gateway payloads cannot
select or override those fields.

R18. Controller host actions are typed host-side operations. A generic
execute-command route is not a Tool Portal backend.

R19. Persistent Tool VM execution uses direct strict-pinned SSH owned by
ToolPortalService and supplied by Gateway runtime implementation mechanics. The
controller grants one exact agent-specific Tool VM binding and SSH access grant
but does not proxy command, file, process, stream, or terminal bytes.
ToolPortalService proactively establishes and owns the corresponding
agent-specific SSH connection, uses it for admitted Capability API backends and
direct SSH Sandbox API operations, reports its status to the controller, and
never shares it across agents.

R19a. Tool VM outbound Git SSH is a separate read-only egress capability, not
the R19 Gateway-to-Tool-VM data path. It may admit `git-upload-pack` for
fetch/clone/pull and rejects `git-receive-pack`. Remote workspace push uses only
the controller-owned `workspace_git_push` host action with host-only HTTPS
credentials. No raw credential enters the Tool VM, Gateway, Tool Portal result,
telemetry, or generated instruction.

R20. Controller-owned runner and host-action output uses the separate
controller execution data connection, never Socket.IO, MCP progress, or OTLP.

R20a. Controller-owned runners use the backend-neutral `ManagedVm` streaming
exec contract. The neutral exec options gain explicit pipe/discard modes and a
bounded output window, expressed only with agent-vm-owned structural types.
Runner artifact extraction, when required, uses a controller-selected stock
guest tool invoked with fixed direct argv over that exec contract. Only a
strictly validated controller-selected runner-scratch artifact identifier may
vary; caller input cannot select the executable, command prefix, or guest root.
The controller enforces byte/type/time bounds on the returned stream. There is
no agent-vm-owned native helper, general `ManagedVm` filesystem surface,
caller-authored shell artifact command, native Gondolin handle, or third adapter
importer.

### Communication and resource bounds

R21. The private local protocol uses one protected full-duplex Unix-domain
socket connection per admitted managed-plugin attachment and JSON-RPC 2.0 with
bounded `Content-Length` framing. The one Tool Portal service in each Gateway VM
owns `/run/agent-vm/gateway-runtime/managed-plugin.sock` below its mode-`0700`
runtime directory. The path is never exposed through ingress, a Tool VM mount,
or persistent state; epoch fencing remains protocol and lifecycle state.

R22. JSON-RPC request IDs are correlation only. Domain operation identity,
payload digest, retry class, generation fencing, and terminal retention are
explicit domain fields.

R23. JSON-RPC batching is disabled in version 1. Unknown methods, unknown
fields, malformed/duplicate headers, invalid lengths, invalid UTF-8/JSON,
oversized or partial frames, and incompatible versions fail closed.

R24. UDS control, metadata, stdout, stderr, stdin, and bounded binary content
use bounded JSON-RPC messages in version 1. There is no custom binary
subprotocol and no large per-client application output queue.

R25. A UDS sender reads and encodes at most one bounded application chunk,
writes it, pauses the source when writable pressure applies, waits for drain,
and only then reads the next chunk. Total operation bytes are bounded,
truncated, or redirected to a bounded artifact.

R25a. GatewayRuntimeClient does not keep a per-stream output queue. When a
downstream stream consumer applies pressure, the client pauses socket reads
globally until that consumer resumes or the stream is cancelled/closed. Cancel
or close may discard unread chunks for that stream before resuming. Version 1
accepts temporary sibling-data head-of-line delay across unrelated agents and
profiles sharing one attachment in exchange for bounded memory and no credit
protocol. This is the sole exception to cross-agent progress independence: the
delay remains inside the R25b pause deadline and configured latency ceiling,
never changes another agent's authority or state, never blocks the separate
Gateway control plane, and cannot become unbounded availability coupling.
Revisit when measured cross-agent/profile delay reaches the configured ceiling.

R25b. Global read pause is time-bounded and has a local escape transition. A
local cancel/close, attachment retirement, or pause deadline first marks the
affected stream discard-draining, resumes frame parsing without awaiting a
remote acknowledgement, discards only that stream's queued data, continues to
process terminal/control and unrelated frames, and completes only from
authoritative terminal evidence. The retained-byte invariant is one
source-owned application chunk per serializer plus explicitly bounded parser,
Node, and kernel buffers; it is not an end-to-end one-unacknowledged-chunk claim.

R26. The controller execution data connection provides end-to-end bounded
producer backpressure. Every intermediary stops reading upstream until
downstream capacity exists. Stream pause/drain or explicit credits are both
valid if no hidden library queue can grow without bound.

R26a. The controller initiates the execution data connection to an explicit
private Tool Portal service ingress route. The connection has independent
authentication, queue/accounting budgets, codec work limits, and scheduling
from Socket.IO control, public MCP, and OTLP. Continuous saturated execution
must preserve bounded control heartbeat, safety cancellation, and recovery
admission latency; transport separation alone is not sufficient proof.
Saturation means sustained offered work at or above every configured queue and
concurrency cap for a bounded observation window. Heartbeat, safety-cancellation,
and recovery admission must each complete within their existing configured
delivery/grace deadline; an arbitrary test timeout or eventual success is not
an acceptance threshold.

R27. Gateway control admission remains independently bounded by server-derived
`safety`, `authority`, `liveness`, and `diagnostic` classes. Bulk execution and
telemetry never enter those queues.

R28. A stalled or disconnected consumer cannot cause unbounded memory,
unbounded disk, loss of cancellation admission, or control-heartbeat starvation.

R29. MCP results are bounded structured results and authenticated artifact
references. MCP progress is small, coalescible, rate-limited advisory state and
never raw output.

### Results, cancellation, and ambiguity

R30. MCP `structuredContent` carries the canonical result. Text content is a
bounded deterministic rendering; `isError` derives from canonical item status.

R31. Canonical results preserve per-call identity, ordering, structured value,
artifacts, truncation, safe diagnostics, terminal disposition, outcome
certainty, retry class, operation identity, and owning generation.

R32. Cancellation is a priority request and not proof of rollback or process
termination. Results distinguish request accepted, cancellation pending,
termination proven, already terminal, and ambiguous.

R33. A disconnect after a side effect may have occurred produces a retained
terminal result or `ambiguous`; it never causes blind automatic replay.

R34. Background work has an opaque generation-bound handle, bounded lifetime,
process count, output/log retention, artifact bytes, and explicit status/wait/
logs/cancel operations. Detached unowned work is forbidden.

R34a. Canonical call-item and operation-control results use the normative
outcome algebra below. `retryable: boolean`, optional certainty fields, or a
diagnostic string cannot substitute for the discriminated outcome and retry
class. Ambiguous, replaced, timed-out, or cancelled work is never automatically
replayed merely because the owning process is no longer running.

R34b. The Hermes managed BaseEnvironment preserves logical cwd and exported
environment-snapshot semantics inside the current Tool VM, one re-entrant
controller-visible operation group/active use for `execute_code` and its nested
polling/file work, group cancellation and ambiguity propagation, and
generation-bound ProcessHandle status/wait/log/write/EOF/kill behavior. Its
initial cwd is `/work`; later relative terminal, file, and code operations use
the environment's live cwd rather than process-global Gateway state. Tool VM
replacement boots a fresh trusted-image successor with freshly validated
`/workspace` and the optional `/gitdirs/workspace.git` capability while
predecessor termination proceeds, but it admits no successor persistent writes
or routing until predecessor access is fenced. Replacement creates a fresh
`/work` and retires live process, environment snapshot, cwd, stream, and
operation authority.

R34c. A background `process.start` capability completes successfully only for
the bounded act of creating and recording the generation-bound process handle.
That call item may therefore be `completed/succeeded` while the referenced
background process remains running. Subsequent status/wait/log/write/EOF/cancel
operations own the process lifecycle and never reinterpret the start-call
outcome as proof that the process itself terminated.

### Lifecycle and recovery

R35. Gateway VM is the atomic recovery and security-reset unit. Gateway VM,
Tool Portal service process, selected OpenClaw/Hermes service process, control
relationship, UDS attachments, credentials, and descendant Tool VMs share one
Gateway epoch fencing subtree.

R36. Tool Portal service-process death, selected OpenClaw/Hermes service-process
death, Gateway VM death, or exhausted bounded control/UDS recovery is
Gateway-fatal and replaces the Gateway VM. Neither sibling is restarted,
replaced, adopted, or allowed to survive as the authority-bearing service in the
same Gateway epoch. A transient UDS reconnect remains legal only for the same
positively identified still-live sibling processes within the existing bounded
reconnect contract.

R37. Sustained authority-bearing control-session death after bounded grace is
independently sufficient for Gateway replacement. A healthy `/health` or
service-ingress observation cannot suppress it. This changes the corroboration
predicate only; existing controller-owned retry budgets, cooldown, stabilization,
fencing, durable identity, positive containment, and no-flap rules remain.

R38. Tool VM death, SSH identity failure, or unrecoverable Tool VM health
eagerly replaces only that Tool VM when the Gateway runtime remains healthy.
Profile-assignment or other controller-authored compatibility changes fence the
old leaf and replace it through the same generation cutover on controlled
cutover or next demand. Idle expiry and ordinary release do not eagerly create a
successor; later demand creates one. Proactive SSH means ToolPortalService
connects immediately after the controller publishes that new binding. It does
not mean ToolPortalService creates an unrequested Tool VM or binding.

R39. Tool VM replacement boots only a fresh successor from the configured
trusted image. It rebinds the selected persistent `/workspace` and optional
`/gitdirs/workspace.git` after predecessor access fencing, but does not
automatically reconstruct any project worktree. The agent may recreate
disposable project work beneath the fresh rootfs/COW `/work`. Replacement never checkpoints or
resumes the unhealthy predecessor and never preserves predecessor `/work`,
rootfs, VM, process, PID, stream, socket, SSH, cwd, environment snapshot,
installed-package state, untracked files, uncommitted `/work` changes, or
ambiguous command state.

R40. Gateway replacement and controller restart require positive containment of
the complete predecessor Gateway authority subtree before successor Gateway
admission. Logical epoch flags or timer expiry alone cannot contain a Gateway,
its descendants, or controller-owned runners.

R40a. Tool VM leaf replacement has three distinct milestones. Authority fencing
is the per-agent linearization point that removes the old leaf from current
routing, rejects every new operation and handle, invalidates cached SSH custody,
and begins identity-verified termination. After authority fencing, the controller
may immediately create and boot one non-routable trusted-image successor with
freshly validated workspace and optional workspace Git capability in parallel
with old-leaf termination. That successor's boot contract must not read or write
selected persistent data or accept agent work before access fencing. Controller
workspace/Git materialization and readiness checks that touch selected
persistent data wait on the same existing lease-flow fence; no new I/O
gate or service is introduced. Access fencing positively proves that the exact recorded Tool VM host
process is absent, so the old leaf can no longer use SSH, VFS, mediated network,
or guest execution to mutate persistent workspace or Git state. Stale-generation
requests remain rejected. `ManagedVm.close()` completion, health loss, lease
retirement start, capability-object closure, elapsed time, or telemetry alone is
insufficient. Only after access fencing may the successor perform persistent
I/O and become current. Provider bridge,
owned-transfer, listener, port, runtime-record, and ancillary cleanup may finish
asynchronously after successor admission; post-containment cleanup debt never
revokes the successor. If access fencing is unproven, the successor remains
non-routable and receives no tool request, the old leaf becomes owner-unsafe,
and no second successor is created.

R40b. The persistent `/workspace` and optional `/gitdirs/workspace.git` source
retain the backend-neutral `OwnedHostDirectory` contract. The controller
validates each canonical identity, acquires and revalidates a fresh capability
set for the one successor, transfers each capability exactly once to the
selected provider, closes them on every failure and VM-close path, and never
reduces one to a raw path. Capability acquisition and non-routable successor
boot may overlap old-leaf termination; persistent I/O and current-route
publication may not. `/work` is created from the successor VM's rootfs/COW and
is never represented by `OwnedHostDirectory`. Workspace is mandatory and
workspace Git is optional. No partial persistent capability set becomes current,
and admission does not wait for post-containment cleanup debt to clear.

R41. When the controller restarts, it uses durable ownership/process evidence
to terminate the recorded old Gateway subtree and starts fresh. It never adopts
old Gateway or Tool VM authority. Missing or unsafe containment becomes
operator-required owner-unsafe state.

R41a. Controller restart applies the same non-adoption rule to recorded
controller-owned runners. Provisioning and running runner records are contained
before any successor operation from the same Gateway/principal scope is
admitted. Crash cuts before identity publication, after publication but before
dispatch, during side effects, and during result streaming have explicit cleanup
and truthful terminal/ambiguous outcomes.

R42. Old environment, operation, process, stream, artifact, attachment, lease,
and credential handles fail after their owning epoch/generation retires and
never rebind to reused OS identities.

R42a. The stable managed principal is the identity subset of one
ManagedAgentProjection: `agentId`, discriminated `frameworkIdentity`,
`toolPortalProfileId`, and `profileAssignmentRevision`. Callers never repeat or
select storage identities. Managed live-handle authority binds the principal
and complete assignment revision to the current storage-binding generation,
Gateway identity, Tool-VM generation, SSH generation, and opaque handle.
Optional requester and correlation fields may be logged or bound into
approval/artifact fingerprints when present, but changing a
session/run/tool-call identifier does not retire a live handle for the same
still-authorized principal and generations. A wrong framework identity,
principal, assignment revision, storage binding, workspace Git policy, or
replaced generation always fails.

### Health and observability

R43. Health is a vector of independent Gateway VM, Tool Portal service process,
selected framework service process, framework-native service, ToolPortalService/
Capability API catalog, ManagedAgentProjection cohort, MCP provider, control
session, lease, per-agent Tool VM binding, per-agent maintained SSH connection,
Tool VM, active-use, UDS,
execution-stream, Tool Portal telemetry, and framework telemetry planes.

R44. Readiness is a controller-derived admission decision. A green observation
in one plane cannot erase or reset another plane's failure. One agent's healthy
binding or SSH connection cannot satisfy another agent's readiness, and
backend-kind readiness cannot substitute for a required agent-specific
connection probe.

R45. Telemetry records bounded state transitions and decisions for control
connect/accept/disconnect/reconnect exhaustion, fencing, recovery decision,
successor stability, Tool VM replacement, stream saturation, truncation, and
ambiguous outcome.

R45a. One Tool VM replacement cohort carries correlated bounded trace/log
evidence for `replacementId`, `traceId`, `zoneId`, `agentId`, reason, old/new
lease ID, VM ID, Tool VM generation, TCP slot, workspace Git mode, selected
remote branch when remote, boot/fence/handoff/cleanup durations,
`replacementStrategy=fresh-trusted-image`, `workspacePreserved=true`,
`workspaceGitPreserved=true`, and `rootfsWorkPreserved=false`. These identities
are never metric labels. The evidence proves boot/teardown overlap,
predecessor-fence-before-successor-persistent-write/routing, stale-generation
rejection, exactly one current route, post-fence cleanup independence, and
Gateway/successor/sibling survival.

R46. Routine successful heartbeat/operation evidence is aggregated. Metrics
use bounded cardinality; operation/handle IDs appear only in bounded logs or
traces when permitted.

R47. OTLP and diagnostic exporters are bounded and lossy under pressure. They
cannot mutate lifecycle state, block control/execution, or share their queues.

R47a. The Tool Portal service and the selected OpenClaw/Hermes framework service
are both first-class producers of OTLP traces, metrics, and logs. They use the
same controller-configured mediated collector endpoint and the same sink and
sanitization policy, but distinct fixed service resources and independently
bounded exporter queues. Controller-authored lifecycle configuration fixes the
expected producer attribution and common bounded Gateway attributes. This is
diagnostic attribution, not cryptographic or OS-principal isolation between the
trusted siblings; a compromised trusted sibling can emit misleading telemetry.
Stack reachability is not producer or storage proof: acceptance requires
positive safe markers attributed to both services in all three stored signal
types within one bounded query window, plus bounded exporters, source
suppression, and collector scrubbing.

R47b. Trusted W3C trace context crosses UDS in bounded protocol metadata outside
public/model-authored arguments. The Tool Portal service validates and extracts
that context and creates service/backend spans with correct parentage or explicit
links. Trace context, baggage, operation identifiers, and correlation fields are
never authority, public selectors, or metric labels. Baggage is absent by default
and any admitted fields are schema-allowlisted and bounded. Source producers
suppress content and secrets; collector scrubbing remains defense in depth.
Exporter outage, saturation, or missing signals remain visible diagnostic planes
but cannot block UDS/control/execution or independently authorize recovery.

### Security

R48. Standalone Tool Portal MCP identity binds the Tool-Portal-specific
credential audience, agent, selected profile revision, and credential version.
Each HTTP request reauthenticates; MCP session ID is never a bearer credential.
Managed UDS identity instead follows R5b: the admitted framework plugin validates
origin, while Tool Portal validates and authorizes the stable asserted principal.

R49. Managed-plugin UDS admission relies on the Gateway VM isolation boundary,
not on a second cryptographic or OS-principal boundary inside that VM. Gateway
runtime inside the Tool Portal service, OpenClaw/Hermes, the managed plugin,
and any operation-scoped transport helper are one trusted in-VM subsystem under
one shared guest-root service principal, UID/GID `0`. The sibling process boundary
provides address-space, event-loop, and crash isolation; it is not an OS
security boundary. Framework/plugin subprocesses remain in this trusted
guest-root domain unless they independently drop privileges as an
implementation detail, which cannot create or receive controller authority. The
mandatory handshake binds protocol/schema version, current Gateway/runtime/
framework epochs, client kind, the exact ManagedAgentProjection cohort digest,
and attachment generation.
The server derives surface class and authority from the controller-authored
snapshot and current lifecycle state; public or client-supplied fields cannot
mint authority. Only one active connection is admitted for each attachment,
and duplicate, replayed, stale-generation, wrong-projection-cohort,
wrong-client-kind, and retired-epoch attempts fail closed.

R50. Surface class is server-derived. Public MCP, UDS, CLI, SDK, model, and
provider fields cannot supply trusted identity, profile, approval proof,
capability binding, credentials, lease/use IDs, executable policy, paths, VM
profile, or recovery choice.

R51. The Tool Portal service has current-epoch custody of provider sessions, SSH
material, attachment state, artifacts, and handles. Clients, model-visible data,
Tool VM environment, persistent workspace/Git state, disposable `/work`
content, logs, and telemetry never receive private authority material.
Read-only repository-scoped Git SSH forwarding is a mediated capability, not
credential disclosure. Controller HTTPS credentials remain host-only, and no
writable outbound Tool VM Git SSH route exists.

R52. The canonical sandbox path grammar accepts normalized relative paths under
the current environment cwd. Relative paths begin under rootfs/COW `/work` for a
new environment. Explicit absolute paths may address `/work`, `/workspace`, or
admitted `/gitdirs` resources. `/agent-vm` is readable only where the operation
permits reviewed generated inputs; writes, rename, removal, or replacement are
rejected. `/tmp` remains guest tmpfs and carries no persistence promise. A
backend binding exposes only the selected `/workspace` and exact `/gitdirs`
members. Standard standalone version 1 has no sandbox path surface and rejects
managed storage-binding fields rather than aliasing them to host state. Another
agent's root, `/zone`, Gateway `stateDir`, framework home/agentDir, controller
path, runtime parent, backup path, another agent's workspace Git resource, managed-skill
backing, NUL, and parent traversal are rejected at the API boundary. Writes to
distinct read-only managed-skill inputs are rejected. Every
operation enforces entry, depth, byte, and time bounds. The implementation uses
the common GatewayRuntimeClient and existing strict-SSH/stock guest operations
inside the Tool VM. Symlinks, mounts, and rename races remain guest-filesystem
behavior contained by the disposable Tool VM and its Gondolin-provided mounts.
A client path is never translated into a caller-supplied controller-host path,
a general `ManagedVm` filesystem call, or a native Gondolin handle. Host
containment remains controller-derived root authorization plus
`OwnedHostDirectory` acquisition/revalidation and the provider's stock mount
fencing. No agent-vm-owned native or openat-style helper is required inside the
Tool VM.

R53. Broad CLI validation rejects shell/control tokens, substitution,
redirection, nested launchers, response-file expansion where unsafe,
credential/config/endpoint/plugin overrides, path escape, and policy-changing
flags. Caller argv is never parsed as Bash.

R54. Approval proof is internal and one-use, bound to principal, surface,
capability, canonical arguments, catalog/policy/binding revisions, execution/
artifact fingerprint, expiry, and current epochs. Public arguments never carry
it.

R54a. ToolPortalService owns one approval-policy meaning, but proof custody is
mode-specific. In managed mode it emits a bounded challenge intent and the
controller persists, validates, atomically consumes, and converts the exact R54
fingerprint into a one-use dispatch grant. In standalone mode, the configured
agent's distinct Tool-Portal HMAC key verifies an expiring, replay-protected
approval token over the exact protected-call digest; the standalone service
consumes its token ID before dispatch. Surface adapters may render or relay a
challenge but cannot mint approval. Denied, expired, revoked, replayed,
concurrent, cross-principal, cross-surface, wrong-audience, or
changed-fingerprint attempts remain not-dispatched. A crash after consumption
but before dispatch is retained as not-dispatched only when non-dispatch is
proven; otherwise it is ambiguous and never automatically replayed.

## Spec boundary and separability map

```text
canonical portal contracts
  owns: capability/catalog/result/error/artifact representation and fixtures
  exposes: strict TS schemas, JSON Schema, cross-language fixtures
                    |
                    v
ToolPortalService
  owns in every mode: live catalog, profile policy, surface eligibility,
        approval semantics, capability binding/routing, normalized results
  additionally owns in managed mode: controller peer, per-agent Tool VM
        bindings, proactive per-agent SSH connections, SSH Sandbox API,
        connection status, processes, streams, terminals, and artifacts
  exposes: Capability API in every mode; SSH Sandbox API only in managed mode
        ^                                      ^
        | standalone MCP projection            | managed protected UDS projection
        |                                      |
ToolPortalMcpClient                       GatewayRuntimeClient
  Capability API                           .portal Capability API
                                           .sandbox SSH Sandbox API
        |                                      ^
        |                                      |
        v                                      |
standalone Tool Portal process          managed Tool Portal service process
  owns: configured MCP/HTTP/stdio         hosts: Gateway runtime and exactly one
        auth and projection                     ToolPortalService
  no controller/binding/SSH authority      owns: process health and bounded drain
                                                   ^
                                                   | private UDS
                                                   v
                                          gateway framework process
                                            OpenClaw XOR Hermes
                                            thin adapter + one GatewayRuntimeClient
                                            native identity -> ManagedAgentProjection
        ^                                      ^
        |                                      |
        +------------------+-------------------+
                           |
          Managed Gateway Boot Contract
          exact image-owned boot entries; not a service or supervisor
                           ^
                           |
controller / agent-vm composition
  owns: immutable boot inputs, aggregate readiness, durable VM/lease/path/
        credential/execution/approval/recovery authority; ManagedAgentProjection
        identity cohort and controller-owned Tool VM storage binding; no
        guest-service launch
  exposes to ToolPortalService: bounded control, agent-specific binding and
        SSH access grants, controller-owned execution stream
                           |
             +-------------+-------------+
             |                           |
             v                           v
per-agent Tool VM                  controller-owned runner / host
  disposable execution leaf         controller-authorized execution
  one exclusive binding and SSH      bounded controller data connection
  /workspace + rootfs /work
  optional /gitdirs/workspace.git + read-only /agent-vm

Capability API tool_vm_runner ----+
                                  +--> same agent-specific binding/SSH --> Tool VM
SSH Sandbox API ------------------+

managed VM substrate
  gateway-lifecycle -> managed-vm <- gondolin-vm-adapter
  controller composition selects adapter only in the two approved modules
  Tool Portal/framework services and clients never import ManagedVm or Gondolin
```

No lower surface may import an upper implementation to bypass its contract.

## Client contracts

### Common portal operations

Both clients expose the same canonical operations:

```text
list(request)     -> catalog summaries
search(request)   -> scoped catalog matches
describe(request) -> ordered full descriptors
call(request)     -> ordered canonical item results
```

Every operation receives trusted principal/surface context from its attachment
or MCP session outside the public request schema. A managed adapter passes the
framework-derived invocation context as a distinct SDK options object; the UDS
client never merges it into public arguments or sends caller-selected roots.
The service resolves the complete ManagedAgentProjection from the validated
principal and active assignment revision. A Capability API call resolves a Tool
VM binding only when its configured backend requires one. A managed SSH Sandbox
API request always resolves the caller's current agent-specific binding and
ready SSH connection. Neither client sends workspace roots, Git-directory host
paths, guest-path mappings, Tool VM identities, or SSH material.
Cross-surface equality applies only to the equivalence cohort defined by the
success promise.

### ToolPortalMcpClient

ToolPortalMcpClient is suitable for generic MCP clients, the Tool Portal CLI,
and optional direct TypeScript/Python consumers. Its constructor accepts a
standard MCP transport and credentials appropriate to that transport. It owns
MCP connection/session lifecycle, typed errors, cancellation mapping, and
canonical result decoding. `artifacts.read(reference, bounds)` uses authenticated
MCP resource read and never treats the reference ID as authorization.

It connects only to a standalone Tool Portal entrypoint. A scoped stdio adapter
forwards to that same standalone service under one immutable MCP-limited
principal; it does not create another ToolPortalService instance. It is never a
managed Gateway client.

It does not expose:

```text
environment handles   raw stdin/stdout/stderr   PTY/resize/attach
lease/use mutation    raw SSH                   OS PID/signal
controller profiles   Gateway lifecycle         runtime-local filesystem
```

### Tool Portal CLI

The TypeScript SDK distribution owns the `tool-portal` executable as a thin
ToolPortalMcpClient adapter. It supports the same four operations plus bounded
`artifact-read` result retrieval over configured Streamable HTTP or scoped stdio
and never executes a capability locally.

Machine-readable canonical JSON is the default stdout contract. Safe human
diagnostics use stderr. Exit `0` means the canonical result is wholly successful,
exit `1` means a canonical mixed/error result was returned, and exit `2` means
usage, authentication, transport, or protocol negotiation failed before a
canonical result existed. Interrupt requests MCP cancellation and then reports
the resulting terminal, pending, or ambiguous disposition truthfully. Exact
endpoint/credential option spelling is plan-owned; implicit policy discovery is
forbidden.

### GatewayRuntimeClient

GatewayRuntimeClient is the only managed-plugin client. Its constructor accepts
the private epoch-scoped UDS endpoint plus immutable current-epoch attachment
metadata produced by controller-owned lifecycle materialization before both
sibling services start. The Tool Portal service validates that metadata against
the active Gateway boot/attachment state. The metadata is lifecycle context, not
a bearer credential. It exposes:

```text
.portal
  list / search / describe / call

.artifacts
  read

.sandbox
  environment.open / close / status
  exec.start / wait / cancel
  fs.stat / list / read / write / mkdir / rename / remove
  process.start / status / wait / logs / cancel
  stream.read / write / close
  terminal.attach / resize        only where the managed framework requires it
```

Exact method names may be normalized during planning, but the semantic groups,
privilege ceiling, generation fences, and absence of raw authority are
normative.

`.portal` and `.sandbox` are request-shape facets of one client to one
ToolPortalService, not separate services, connection owners, or execution
runtimes. A `.portal` capability whose configured backend is `tool_vm_runner`
and a `.sandbox` request for the same agent converge on that agent's one current
binding and maintained SSH connection only after their distinct admission
paths. No facet owns or receives raw SSH material.

### OpenClaw managed SandboxBackend

OpenClaw already treats a sandbox backend as the place where shell/process and
filesystem tools execute. The managed plugin registers one backend whose handle
is a thin projection over its one long-lived GatewayRuntimeClient:

```text
OpenClaw turn for agents.list[].id
  -> plugin authenticates native agent origin
  -> projection selects stable agent
  -> OpenClaw SandboxBackend handle
       buildExecSpec/finalizeExec  -> UDS-backed execution transport
       runShellCommand             -> SSH Sandbox API
       createFsBridge              -> UDS filesystem methods
  -> ToolPortalService
  -> current agent-specific Tool VM binding
  -> current agent-specific maintained SSH connection
  -> Tool VM
```

The backend may use an SDK-owned ephemeral transport helper when the pinned
OpenClaw `buildExecSpec` contract requires a locally spawned argv to carry
stdin/stdout/stderr/PTY. Such a helper is an implementation detail of the one
SandboxBackend handle: it attaches only to a previously admitted current-epoch
operation and owns no semantic client, agent mapping, path mapping, policy,
lease, SSH, VM, or recovery authority. The framework plugin and helper never
retain the old direct controller/lease/SSH implementation.

OpenClaw's native agent workspace remains `/zone/agents/<agentId>` in the
Gateway process for prompt files, memory, and agent-authored skill discovery.
The backend's logical sandbox workdir is rootfs/COW `/work`; its filesystem
bridge additionally admits the selected durable `/workspace`, optional
`/gitdirs/workspace.git`, and read-only `/agent-vm` inputs. The selected OpenClaw configuration
must prove that normal terminal/process/read/write/edit/apply-patch/code work
reaches this backend, default relative paths reach `/work`, explicit
`/workspace` reads and writes reach only the current agent's durable workspace,
workspace Git does not cross agents, managed skills remain read-only,
and no Gateway-local fallback remains. Exact `workspaceAccess`,
filesystem-policy, and apply-patch-policy settings are plan-owned because
upstream defaults do not by themselves establish this storage contract.

### Hermes managed BaseEnvironment

Hermes already routes terminal and shell-backed file operations through a
BaseEnvironment and uses the same environment cohort for non-local
`execute_code`. Managed mode registers one Agent VM environment kind backed by
the Python GatewayRuntimeClient:

```text
Hermes turn for SessionSource.profile
  -> adapter authenticates routed profile
  -> projection selects canonical agent
  -> managed BaseEnvironment(cwd=/work)
       execute / process handles   -> SSH Sandbox API
       ShellFileOperations         -> same environment and live cwd
       execute_code                -> same Tool VM operation group
  -> ToolPortalService
  -> current agent-specific Tool VM binding
  -> current agent-specific maintained SSH connection
  -> Tool VM
```

The environment is selected from whole-turn profile context and an explicit
projection, not `TERMINAL_ENV`, `TERMINAL_CWD`, the process cwd, a model field,
or a literal `default` cache key. It preserves Hermes's live cwd and exported
environment snapshot inside the Tool VM. `execute_code` and its nested tool
RPC/file polling remain in the same re-entrant operation group and current
binding. Managed-mode environment creation, lookup, and cleanup key the
canonical agent, Hermes profile, assignment revision, Gateway/attachment epoch,
and Tool-VM generation so no environment, file helper, process handle, result,
or cwd crosses profiles or replacements.

### Language distributions

Version 1 ships one TypeScript SDK distribution and one Python SDK distribution,
each exporting canonical contracts and both explicit clients through isolated
modules and constructors. One distribution does not imply one polymorphic
client or one dependency graph.

The clients must not share optional dependencies in a way that causes managed
plugins to import MCP runtime code or generic MCP consumers to import UDS/
Gateway runtime code.

## Tool Portal and MCP composition

```text
standalone MCP Portal
  MCP client -> mcp_portal_* -> MCP Portal -> upstream providers

standalone Tool Portal over configured MCP
  MCP client -> tool_portal_* -> ToolPortalService
                                -> Capability API
                                -> mcp_provider -> MCP Portal backend seam

managed Tool Portal over UDS
  managed plugin -> GatewayRuntimeClient.portal
                 -> same ToolPortalService Capability API

managed SSH Sandbox over UDS
  gateway framework -> GatewayRuntimeClient.sandbox
                    -> same ToolPortalService SSH Sandbox API
```

Tool Portal composes MCP Portal through one exported provider backend seam. It
does not import MCP Portal core internals or expose `mcp_portal_*` identity in
managed mode.

```text
managed Gateway authored inputs
  mcp.config.jsonc          upstream providers/transports/secrets
  tool-portal.config.jsonc  agents/profiles/bindings/visibility/call policy
            |
            v
  controller-authored immutable semantic snapshot
            |
            v
  one ToolPortalService -> one shared MCP-provider runtime

standalone Tool Portal authored inputs
  mcp.config.jsonc + tool-portal.config.jsonc(mode=standalone)

standalone MCP Portal authored inputs
  mcp.config.jsonc + mcp-portal.config.jsonc
```

All configured agents in one Tool Portal process use the same MCP-provider runtime. ToolPortalService
validates the trusted invocation context, resolves the current profile and
surface policy, and issues the required dispatch-authority variant before the
shared backend runs. Agent identity may scope internal catalog/session/cache
state, but it never selects a different provider backend. Standalone MCP Portal
and standalone Tool Portal reuse bearer and approval-HMAC primitives with
distinct purpose/audience derivation; neither product accepts the other's
credentials. No standalone credential enters managed Gateway policy or adds an
in-VM HMAC boundary.

Standalone Tool Portal owns its explicitly configured listener/authentication
adapter, session lifecycle, and bounded drain around the same ToolPortalService
reference. A stdio or CLI adapter is a transport forwarder to this projection
and never a second service host. Managed Gateway composition owns none of these
public entrypoint responsibilities.

The version-1 standalone composition constructs only the MCP-provider backend
port. Its config compiler and composition root both reject `tool_vm_runner` and
`controller_host_action`; a generic ToolPortalService port type is not authority
to construct either backend. Cross-mode semantic equivalence applies only to a
capability whose backend kind is supported in both compared modes. A
managed-only capability is absent or surface-denied in standalone mode without a
second semantic router.

Gateway startup receives one controller-authored semantic configuration snapshot
with explicit catalog, profile assignment, policy, binding, provider, and schema
revisions. Managed mode exposes that service only over UDS. Standalone mode may
project the same service over each explicitly configured entrypoint. Credential
rotation in standalone mode updates only the authentication adapter's versioned
credential set; it cannot mutate semantic policy. A managed policy or binding
change replaces the Gateway epoch.

The standalone MCP projection exposes its service-owned artifact store as an
authenticated MCP resource provider. Resource URIs contain only an opaque
artifact identifier; every read resolves current authority and byte/range bounds
through ToolPortalService before storage access.

## Capability API and SSH Sandbox API

Both APIs may operate inside the same assigned Tool VM sandbox. They differ by
request and admission semantics, not by execution location or connection owner.
ToolPortalService owns both paths and their shared agent-specific binding and
SSH connection.

### Capability API

A Capability API caller selects `{ namespace, name, arguments }`.
ToolPortalService resolves catalog visibility, profile policy, approval, and one
configured backend. A `tool_vm_runner` backend may execute a bounded operation
inside the caller's current Tool VM through the same maintained SSH connection
used by the SSH Sandbox API. The caller does not select raw argv, SSH material,
lease, Tool VM, or connection.

Candidate MCP-projectable semantic families include:

```text
sandbox.exec
  finite foreground execution, bounded stdin/time/output, no PTY or attach

sandbox.fs.stat/list/read/write/mkdir/rename/remove
  canonical sandbox paths, bounded entries/bytes, artifact overflow

sandbox.process.start/status/wait/logs/cancel
  opaque handle, bounded process count/lifetime/log cursor, explicit terminal state
```

These are ordinary Tool Portal capabilities. Their public descriptors do not
expose the backend kind, runner profile, executable, credential, path,
lease/use identity, SSH, or process ID.

### SSH Sandbox API

The managed-only SSH Sandbox API accepts direct execution, filesystem, process,
stream, environment, and terminal requests from the authenticated gateway
framework adapter. It supports streaming, stdin, binary transfer, PTY,
attachment, resize, and generation-bound process interaction. It does not
perform capability catalog lookup or per-command capability approval. It
operates only on the authenticated agent's current binding and ready maintained
SSH connection and never routes to controller-owned runners or host actions.

Standalone version 1 exposes only the Capability API through explicitly
configured transports. It has no controller relationship, managed binding,
maintained Tool VM SSH connection, or SSH Sandbox API.

## Broad CLI and promoted capability contract

```text
broad capability
  public: validated argv tail + reason + bounded stdin
  trusted: executable + mandatory prefix + credentials + cwd/env/egress/output

promoted typed capability
  public: domain fields
  trusted: compile to executable + mandatory prefix + validated flags/values
```

Both appear in the same Tool Portal catalog. Promotion narrows the public
schema and authority; it does not create a second executor or catalog.

The controller independently parses the dispatch intent, looks up the trusted
binding, canonicalizes public arguments, recomputes the execution fingerprint,
checks approval freshness, and executes an array argv. It never executes a
caller-authored shell string.

## Approval lifecycle and trust flow

```text
ToolPortalService policy decision
  -> no approval required
       -> mode-specific final admission / backend dispatch
  -> approval required
       -> managed: controller persists pending challenge + exact fingerprint
       -> standalone: caller obtains exact-call per-agent HMAC approval token
       -> surface renders challenge to authenticated human/operator
       -> managed controller or standalone verifier atomically consumes proof
       -> one-use backend dispatch grant or controller-owned execution
```

The managed controller approval port is an explicit protected operator surface,
never a Tool Portal capability or model-callable method. Managed OpenClaw/Hermes
adapters may render a challenge through framework-native human approval UX.
Standalone HTTP MCP, stdio, and CLI callers receive the same typed
`approval-required` disposition and return a Tool-Portal-audience HMAC approval
token through the configured protected-call field/header contract. UI and
transport spelling are plan-owned. Standalone same-user protection of the
authored key/config file is explicitly deferred; runtime verification,
audience separation, expiry, fingerprint binding, and replay prevention are not.

For `mcp_provider` and `tool_vm_runner`, successful consumption yields a
one-use dispatch grant bound to the exact operation; Gateway runtime cannot
execute before receiving it. For `controller_host_action`, the controller
consumes and dispatches atomically within its execution state machine. Prompt
UX may differ by surface, but policy meaning and admission semantics do not.

## Protocol profiles

### MCP profile

- Standard MCP JSON-RPC and session semantics.
- Streamable HTTP or scoped stdio transport.
- Immutable authenticated principal per session/process.
- Four universal Tool Portal tools.
- Canonical result in `structuredContent`.
- Bounded deterministic text rendering.
- Advisory progress only.
- Standard request cancellation maps to the authenticated caller's operation;
  it is not exposed as a model-callable authority tool.

### Private UDS profile

- Unix-domain socket local to one Gateway VM.
- The one Tool Portal service owns the fixed
  `/run/agent-vm/gateway-runtime/managed-plugin.sock` path below its private
  runtime directory; it is never exposed through ingress or Tool VM mounts.
- One persistent full-duplex connection per managed-plugin attachment.
- JSON-RPC 2.0 with strict `Content-Length` framing.
- Mandatory handshake before other methods.
- Handshake binds protocol/schema version, Gateway/runtime/framework epochs,
  client kind, exact ManagedAgentProjection cohort digest, and attachment generation.
- The Tool Portal service derives surface and operation authority from its immutable
  snapshot and lifecycle state; handshake fields are validation inputs, not
  authority or cryptographic proof.
- Batches disabled.
- Requests/responses plus bounded notifications for terminal events and chunks.
- Reconnect cannot cross retired epochs or silently resume ambiguous work.

### UDS bounded-stream rule

```text
source readable
  -> read one bounded chunk
  -> encode one bounded JSON-RPC message
  -> socket.write(message)
     -> accepted: read next chunk
     -> pressure: pause source, await drain, then read next chunk
```

There is no large application queue. Small unavoidable Node/kernel buffers are
bounded by configured stream limits. A disconnect stops further source reads.
Operation output beyond policy becomes truncation, a bounded artifact, or a
typed resource-exhaustion outcome.

GatewayRuntimeClient likewise does not demultiplex a slow stream into an
unbounded application queue. It pauses socket reads globally while the
downstream consumer is backpressured. This may delay sibling output within the
same managed-plugin attachment in version 1.

```text
flowing
  -> downstream-paused           pause socket reads; start bounded pause deadline
  -> flowing                     downstream resumes before deadline

downstream-paused
  -> discard-draining            local cancel/close, retirement, or deadline
  -> resume socket reads         do not wait for remote acknowledgement
  -> discard target data frames  continue terminal/control and sibling parsing
  -> terminal                    only authoritative evidence completes operation
```

Streaming retains the exact source/chunk/buffer invariant owned by R25b;
`socket.write() === true` remains bounded-buffer acceptance, not delivery or
acknowledgement. A disconnect stops source reads. The separate Gateway control
plane remains unaffected.

This mechanism is sufficient for normal LLM token rates and bounded binary
transfers. A separate binary subprotocol is added only after measurement proves
JSON encoding or bounded base64 chunking materially harms real workloads.

### Gateway control profile

- Private controller-initiated Socket.IO control relationship with the Tool
  Portal service.
- Carries authority, liveness, lease/use, admission, cancellation, recovery,
  bounded state transition, and terminal metadata.
- Never carries terminal/file/provider/log/trace/metric/OTLP bulk bytes.
- Safety, authority, liveness, and diagnostics have independent bounded
  admission and explicit saturation behavior.

### Controller execution profile

- Controller-initiated authenticated full-duplex WebSocket to an explicit
  private non-`/` Tool Portal service URL route, distinct from Socket.IO and
  from the public MCP audience.
- Used only for controller-owned runner and host-action data.
- Logical streams bind principal, operation, channel, execution fingerprint,
  Gateway/runtime epochs, sequence, EOF, and cancellation.
- The producer stops when downstream cannot accept the next bounded chunk.
- Exact pause/drain versus explicit-credit implementation is plan-owned; no
  hidden WebSocket/library queue may make retained memory unbounded.
- Per-operation, per-principal, per-Gateway, and global concurrency/byte/time
  limits apply.
- Parser buffers, WebSocket queues, artifact buffers, codec work, and event-loop
  scheduling have independent accounting and bounded work slices so saturated
  execution cannot starve control heartbeat, safety cancellation, or recovery.

### Telemetry profile

- Tool Portal service and selected framework each emit OTLP traces, metrics, and
  logs through the same mediated collector endpoint into the same configured
  sink.
- Distinct fixed service resources and independently bounded queues/failure
  evidence for each producer.
- Trusted bounded W3C trace context crosses UDS outside public arguments;
  arbitrary baggage and caller-authored trace authority are rejected.
- Routine success aggregation, transition-focused evidence, source-side content
  suppression, and collector scrubbing.
- Lossy under saturation; never lifecycle or authorization authority.

## Canonical call-result algebra

Discovery results use their operation-specific schemas. Every `call` item that
admits backend work carries `operationId`, its owning generation, and exactly one
terminal execution disposition:

```text
not-dispatched
  certainty: proven
  retryClass: safe-before-dispatch

completed
  completion: succeeded | failed
  certainty: proven
  retryClass: forbidden | policy-gated

cancelled-proven | timed-out-proven
  certainty: proven-terminated
  retryClass: manual-only

replaced-proven
  certainty: proven-terminated
  priorSideEffects: possible
  retryClass: manual-only

ambiguous
  certainty: side-effects-and-termination-unknown
  retryClass: forbidden
```

`status: ok` is legal only with `completed/succeeded`. Every other terminal
disposition has `status: error` and a matching typed error. `replaced-proven`
proves the old generation can no longer execute; it does not prove that earlier
side effects did not occur. A retry policy may be stricter than the listed
class, never weaker.

Cancellation/status methods may return non-terminal `running` or
`cancellation-pending`; those are operation-control results, not terminal call
items. Retained-result lookup for the same operation is not execution replay.
MCP `isError` is true when any canonical item has `status: error`; deterministic
text and CLI exit status derive from the same canonical envelope.

## Execution data flows

### Tool VM execution convergence

```text
Capability API
  -> framework-native identity -> ManagedAgentProjection
  -> capability catalog / policy / approval
  -> configured tool_vm_runner backend

SSH Sandbox API
  -> framework-native identity -> ManagedAgentProjection
  -> direct sandbox request admission

both paths
  -> ToolPortalService
  -> controller-authorized current agent-specific binding
  -> ready agent-specific maintained SSH connection
  -> disposable Tool VM
  -> selected filtered durable workspace at /workspace
  -> fresh rootfs/COW hot work at /work
  -> optional persistent workspace Git database at /gitdirs/workspace.git
  -> reviewed read-only inputs at /agent-vm
  -> bounded result/stream to caller
```

The controller publishes binding and SSH access authority and receives
connection, use, health, and terminal status. It does not carry persistent Tool
VM bytes. Capability admission and direct sandbox admission remain distinct;
their Tool VM data paths converge only at the current binding and maintained
SSH connection.

### Controller-owned runner

```text
capability call
  -> ToolPortalService binding/policy
  -> bounded controller dispatch intent
  -> controller recomputes trusted execution plan and approval fingerprint
  -> controller reserves + durably records operation-scoped ManagedVm runner
  -> backend-neutral ManagedVm pipe-mode exec
  -> fixed controller-authored stock guest-tool argv when file output is selected
  -> controller execution data connection
  -> Gateway runtime
  -> epoch-local authenticated artifact store when output overflows
  -> canonical Tool Portal result / artifact reference
```

The controller runner domain imports only `managed-vm`; the Gondolin adapter
translates neutral pipe/window options inside its existing package. Artifact
extraction is a fixed protocol over direct argv and stdout, not a general guest
filesystem port. Bounded stdin is fully received and validated before dispatch;
controller-runner V1 does not promise interactive stdin or PTY.

### Host action

```text
capability call
  -> ToolPortalService binding/policy
  -> bounded controller dispatch intent
  -> controller recomputes fixed host operation
  -> trusted host process
  -> controller execution data connection
  -> Gateway runtime
  -> canonical Tool Portal result / artifact
```

## Lifecycle state machines

### Gateway authority lifecycle

```text
absent
  -> reserving
  -> booting
  -> sibling-services-starting       guest boot has started both exact roles
  -> joining-readiness               independent service/UDS/control planes
  -> control-attaching
  -> ready

ready
  -> reconnecting                 transient control connection loss
  -> fencing                      Gateway-fatal observation
  -> replacing                    positive predecessor quiescence
  -> ready                        fresh Gateway epoch only

fencing
  -> owner-unsafe                 containment cannot be proved
  -> replacing                    subtree positively quiesced
```

Guest boot starts the two siblings concurrently; the state diagram does not impose a
Tool-Portal-before-framework or framework-before-Tool-Portal order. No transition
restarts OpenClaw, Hermes, or the Tool Portal service inside the same Gateway VM.
Either sibling's death retires the Gateway epoch.

### Agent Tool VM connection lifecycle

```text
unbound
  -> connecting       controller published this agent's current binding/access grant
  -> retired          assignment or Gateway epoch retired

connecting
  -> ready            pinned SSH identity and required session probes succeeded
  -> reconnecting     retryable connection loss within current binding/generation
  -> degraded         bounded retry budget or required probe failed
  -> retired          binding/generation/assignment/Gateway epoch retired

ready
  -> reconnecting     current connection lost; new work fails retryably
  -> degraded         current binding cannot satisfy required Tool VM access
  -> retired          binding/generation/assignment/Gateway epoch retired

reconnecting
  -> ready            same current binding/generation re-established and revalidated
  -> degraded         bounded retry budget exhausted
  -> retired          binding/generation/assignment/Gateway epoch retired

degraded
  -> connecting       controller publishes an authorized successor binding
  -> retired          assignment or Gateway epoch retired
```

Every state belongs to one stable principal and complete binding generation.
There is no global default connection and no cross-agent fallback. Capability
and direct sandbox requests admit Tool VM work only in `ready`; connection
establishment and health reporting do not wait for the first tool request.

### Tool VM lifecycle

```text
absent
  -> creating
  -> SSH-pinning
  -> available
  -> leased
  -> active

active / leased / available
  -> authority-fenced             removed from routing; new work rejected
       |-> access-fencing         exact recorded process termination in progress
       `-> successor-creating     trusted-image boot; non-routable; no persistent I/O
  -> access-fenced                exact recorded process proven absent

authority-fenced / access-fencing
  -> owner-unsafe                 write/access containment cannot be proved

successor-creating
  -> successor-ready              boot and SSH ready; still non-routable
  -> failed                       close successor; predecessor cleanup remains tracked

access-fenced + successor-ready
  -> available                    successor becomes the one current leaf
  -> retiring                     predecessor cleanup remains tracked independently

retiring
  -> retired                      provider/port/record cleanup complete
  -> cleanup-debt                 post-containment cleanup remains retryable
```

Tool VM replacement preserves the healthy Gateway epoch and ToolPortalService.
One agent has exactly one current/routable leaf and zero or more physically
existing retiring predecessors. Cleanup authority for each predecessor remains
bound to its generation after routing authority moves to the successor.

### Controller-owned runner lifecycle

```text
absent
  -> reserved                       durable parent/operation record exists
  -> creating
  -> started                        VM id + host process identity recorded
  -> admitted                       approval/fingerprint revalidated
  -> running
  -> terminal                       result retained; VM positively contained

reserved / creating / started / admitted / running
  -> fencing                        cancel, Gateway retirement, controller restart,
                                    runner death, stream loss, or policy failure
  -> destroying                     predecessor positively quiesced
  -> terminal | owner-unsafe        evidence decides certainty
```

A runner is never leased, exposed through SSH, reused, adopted, or replaced in
place. Gateway retirement fences every runner originating from that Gateway
epoch even though the runner is a controller-owned VM rather than a Tool VM.

### Execution operation lifecycle

```text
requested
  -> admitted
  -> dispatched
  -> running
  -> completed/succeeded | completed/failed | not-dispatched
             | cancelled-proven | timed-out-proven
             | replaced-proven | ambiguous
```

Transport disconnect and cancellation request are observations, not terminal
states. Only executor- or containment-backed evidence establishes a proven
terminal outcome.

### Managed-plugin attachment lifecycle

```text
socket-published
  -> handshaking
  -> attached
  -> active
  -> reconnecting                 same still-valid epochs/process
  -> retired                      process/runtime/Gateway retirement
```

Only one current connection may own an attachment generation. Duplicate or
stale handshakes are rejected, and old handles do not cross attachment-
generation retirement.

## Recovery contract

### Atomic Gateway recovery triggers

- Gateway/QEMU process death.
- Tool Portal service process death.
- OpenClaw or Hermes framework service process death.
- Sustained control-session death after bounded reconnect/death grace.
- Private UDS admission/runtime failure after bounded recovery.
- Security fencing or authority mismatch requiring reset.

Gateway service `/health` may remain green during several of these failures.
That observation does not corroborate or veto the authority-bearing trigger.

### Gateway recovery containment barrier

Before successor admission:

1. Seal the old Gateway and controller-runner generations against new
   controller authority.
2. Stop Tool Portal service admission, framework attachment, and both siblings'
   new work.
3. Terminate the recorded predecessor process/VM subtree.
4. Prove the predecessor cannot initiate direct SSH writes.
5. Prove descendant Tool VMs cannot mutate persistent sandbox state and
   originating controller runners can no longer execute protected work.
6. Retire all credentials, sessions, leases, uses, and handles.
7. Admit the successor with fresh epochs/generations.

If steps 3 through 5 cannot be proved, the zone is owner-unsafe and requires
operator action. The controller does not start a potentially concurrent owner.

### Tool VM leaf rollover barrier

For an unhealthy or stale Tool VM leaf, the controller serializes the transition
by Gateway identity plus agent identity:

1. Atomically remove the old generation from current routing and reject all new
   lease uses, SSH operations, filesystem/process handles, and VM operations.
2. Preserve inflight outcomes as failed, cancelled, proven not-dispatched, or
   ambiguous; automatically replay only work proven not dispatched.
3. In parallel, reverify the recorded host-process identity and start the
   bounded exact-target TERM-to-KILL sequence, while acquiring a fresh complete
   `/workspace` plus optional `/gitdirs/workspace.git` capability set and booting
   one trusted-image successor. The successor is non-routable and performs no
   persistent I/O.
4. Prove the exact recorded predecessor process is absent. This is the access-
   fenced milestone: stale generations remain rejected and A can no longer
   write `/workspace` or `/gitdirs`. Listener, provider, transfer, port, record,
   and telemetry disposal continue as cleanup rather than independent gates.
5. Publish the successor as the one current leaf. Only then may Tool Portal
   route agent requests that can write its selected persistent resources.
6. Continue provider close, SSH/port release, record deletion, and ancillary
   cleanup for the retiring predecessor without holding the current-leaf lock.

Failure before step 4 is `containment-unproven`: a booting successor may be
closed, but it never receives a tool request or routing authority. Failure in
successor boot or persistent capability preparation prevents admission and
closes that successor. Failure after step 5 is typed post-containment cleanup
debt; it remains visible and retryable
but does not revoke or block the successor.

### Controller restart

Controller restart is not session recovery. The new controller epoch reads the
durable runtime/process ownership record, terminates the recorded old Gateway
subtree and every recorded controller-owned runner, verifies containment, and
starts a fresh Gateway epoch. It never adopts a live predecessor VM merely
because it responds.

The storage engine for durable ownership records is plan-owned. The
controller/Gateway ownership split, `controllerStateDir/zones/<zoneId>`
record boundary, durability, write ordering, crash cut points, and non-adoption
are spec-owned.

## Health and observability contract

### Health vector

```text
Gateway VM          process/ownership identity and containment
Tool Portal process independent service process identity and liveness
framework process   OpenClaw/Hermes process identity and liveness
framework service   native service readiness and adapter attachment
ToolPortalService   catalog/config/policy/binding revision readiness
agent projections   exact native identity/profile cohort revision
storage binding     workspace/Git selection and binding generation
MCP provider        upstream provider/session readiness
control session     accepted authority-bearing relationship and heartbeat age
lease authority     current lease transitions
agent connection    per-agent binding/SSH state, generation, reason, freshness
active use          operation/group heartbeat and ambiguity state
Tool VM             VM generation and guest health
SSH                 exact per-agent pinned identity and functional probe
UDS admission       listener, handshake rejection, attachment pressure
execution stream    connection/stream saturation and consumer progress
Tool Portal OTEL    traces/logs/metrics export, drops, queue pressure
framework OTEL      traces/logs/metrics export, drops, queue pressure
```

Readiness names every failed plane and its age/reason. One successful plane
never resets another plane's failure counter or recovery trigger. Per-agent
connection identities belong in bounded state, traces, and logs rather than
metric labels. An idle healthy connection is not active use.

### Required transition evidence

- Gateway control connect, accepted, disconnected, reconnect attempt,
  reconnect exhausted, fenced, and successor stable.
- UDS socket published/retired, handshake accepted/rejected, attachment
  active/retired, duplicate/stale rejection, and stale handle rejection.
- Per-agent binding published/retired, SSH connecting/ready/reconnecting/
  degraded/retired, generation mismatch, cross-agent lookup rejection, and
  connection status delivered to the controller.
- Gateway recovery considered, selected, suppressed, owner-unsafe, started,
  failed, and completed.
- Tool VM creation, SSH pinned, lease/use active, leaf fenced/replaced, and
  persistent state rebound.
- Tool VM replacement cohort, trusted-image boot start/ready, exact predecessor
  termination/access fence, persistent-write admission, route publication, and
  asynchronous cleanup.
- Controller-runner reserved/identity-recorded/admitted/fenced/contained and
  controller-restart cleanup transitions.
- Execution admitted, dispatched, running, cancellation requested, terminal
  certainty, truncation/artifact, and ambiguity.
- UDS/controller stream high-water pressure, producer pause duration, dropped
  progress, truncation, artifact overflow, and disconnect.
- Tool Portal and framework producer configured/exporting/degraded transitions,
  signal-specific drops, and distinct stored-service evidence in the shared sink.

Routine heartbeats update aggregate counters/gauges. They do not write noisy
per-tick high-cardinality evidence.

### Cardinality and isolation

Metrics may label bounded component kind, state, result, backend kind, runner
profile, and error class. Agent IDs, operation IDs, handles, lease IDs, paths,
credentials, and raw errors do not become metric labels.

Telemetry exporter failure is visible through bounded drop/queue evidence and
does not block or alter product operation.

## Security model

### Trust boundaries

```text
controller host
  trusted durable authority

Gateway VM trusted subsystem
  Tool Portal service + selected framework service + managed plugin + bridge
  one in-VM trust domain and one shared guest-root principal, UID/GID 0
  current-epoch custody and mechanics, never durable controller authority

generic MCP caller
  authenticated portable lower-privilege principal

model / Tool VM / upstream provider
  untrusted arguments, code, files, stdout/stderr, results, and metadata
```

Compromise of either guest-root sibling compromises the complete Gateway VM
trust domain; the design does not claim containment between those siblings.
That compromise does not grant controller-host authority because controller
state is absent from every guest mount and boot input. Gateway-root or
controller-host compromise is otherwise outside this contract. OpenClaw,
Hermes, their managed plugins, any operation-scoped transport helper, and the Tool Portal service
hosting Gateway runtime are
trusted together once admitted into the Gateway VM. The contract does not claim
security against one of those components inspecting or impersonating another
inside the same VM; VM isolation is the boundary that keeps model/Tool-VM code
and the host/controller outside that trust domain. The private UDS and strict
protocol still provide lifecycle fencing, bounded resource use, and explicit
authority derivation, but they are not a cryptographic or OS-principal boundary.

### Identity and credential invariants

- Standalone MCP authenticates every request and binds one immutable
  Tool-Portal-audience agent/profile principal to a session. Remote HTTP
  requires confidential transport, an explicit non-`/` URL route, and
  host/origin controls.
- Stdio has one immutable out-of-band principal and remains MCP-limited.
- UDS attachment is bound to current Gateway/runtime/framework epochs, client
  kind, exact ManagedAgentProjection cohort digest, and one active attachment generation. Its
  lifecycle metadata is not a bearer credential.
- Any OpenClaw buildExecSpec helper matches a current pending operation and
  consumes its reservation exactly once. Operation identifiers remain
  correlation, not cross-boundary authorization.
- In managed mode the plugin validates framework origin; the service derives
  surface class and validates the stable principal against the complete
  ManagedAgentProjection and admitted set. In standalone mode bearer
  authentication derives the agent and Tool Portal profile. Public arguments
  never supply either identity, a workspace/Git binding, a host path, or a
  guest-path mapping.
- Managed Tool Portal authorization comes from the active
  `tool-portal.config.jsonc`-derived semantic snapshot. Standalone Tool Portal
  and standalone MCP Portal bearer/HMAC material have distinct audiences and
  neither is accepted as managed Tool Portal authority.
- Gateway/runtime/framework/Tool VM generation retirement invalidates old
  managed handles before successor admission. Standalone credential versions
  and service generations independently fence standalone sessions and handles.
- Artifact references and approval challenge IDs are correlation only. Every
  use re-resolves the authenticated principal, current revisions, and owning
  epochs before storage access or dispatch.

### Authority and custody invariants

- Public fields never carry trusted caller context, approval proof, controller
  proof, credential, executable policy, lease/use authority, SSH, PID, host
  path, VM profile, or recovery choice.
- The Tool Portal service never delegates private provider/SSH/attachment material.
- Artifact bytes are held only in the bounded epoch-local store and are released
  only after readback reauthorization; raw storage paths never cross a client
  boundary.
- Approval decisions and proofs live only in controller-owned durable state and
  one-use dispatch grants; Gateway runtime, its service host, and adapters never
  mint them.
- `controllerStateDir` and every descendant remain host-controller-only.
  Approval records, managed/Worker Gateway runtime records, and Tool VM lease
  records never enter framework state, immutable boot inputs, environment,
  artifacts, telemetry, or any Gateway/Tool VM mount.
- Identifiers and handles are correlation, not bearer authority. Every use
  resolves against authenticated principal and current epochs/generations.
- ToolPortalService centrally enforces surface eligibility; adapters do not
  keep independent allowlists.

## Package and dependency contract

Target package roles are:

```text
@agent-vm/gateway-lifecycle
  existing gateway-kind lifecycle, lease/active-use/health vocabulary, neutral
  Gateway VM requirements, direct Worker process spec, and neutral managed
  boot/readiness metadata; no managed guest launch commands, process objects,
  spawn callbacks, or restart callbacks

@agent-vm/managed-vm
  existing backend-neutral VM creation/runtime/streaming-exec, image,
  diagnostics, and single-use owned-directory contracts; no native handles or
  general guest filesystem surface

@agent-vm/gondolin-vm-adapter
  sole stock-Gondolin implementation of managed-vm; no Gateway/controller
  policy and no native handle exported to domain consumers

@agent-vm/openclaw-gateway / future @agent-vm/hermes-gateway
  host GatewayLifecycle implementations that produce framework-specific image,
  immutable configuration, ingress, readiness, and pinned framework-integration
  material; OpenClaw owns only the narrow managed identity/workspace hook,
  Hermes owns the
  managed environment registration; managed service startup itself is owned by
  the selected image's exact boot contract

@agent-vm/worker-gateway
  unchanged direct per-task process lifecycle; no Gateway runtime dependency

@agent-vm/tool-portal
  portable capability semantic core, catalog, policy, approval semantics,
  capability binding/router, capability-backend ports, controller backend
  adapters, CLI allowance validation, and standalone ToolPortalService
  composition with explicitly configured MCP/HTTP/stdio entrypoints plus
  bearer/HMAC auth; consumes the MCP Portal provider seam

@agent-vm/agent-portal-sdk
  /contracts: canonical portal, sandbox, identity, result, error, artifact
    schemas; authored Zod, generated JSON Schema, shared fixtures
  /tool-portal-mcp-client: TypeScript ToolPortalMcpClient
  /gateway-runtime-client: TypeScript GatewayRuntimeClient
  /cli: tool-portal executable using ToolPortalMcpClient
  separate exports, constructors, and dependency edges; contract-only
  consumers do not import either client implementation

Python agent-portal-sdk distribution
  mechanically derived runtime models and shared fixtures
  Python ToolPortalMcpClient and GatewayRuntimeClient in isolated modules

@agent-vm/gateway-runtime
  common Tool Portal service executable and boot entry, Gateway-local
  managed ToolPortalService composition, protected UDS server, Capability API
  and SSH Sandbox API projections, Gateway-side control endpoint, per-agent
  binding/connection manager, Tool VM client, SSH/process/stream/terminal
  implementation, artifact store, readiness, and status publication;
  no public Tool Portal MCP/HTTP/stdio listener and no framework launch or
  supervision

@agent-vm/mcp-portal
  standalone MCP Portal, upstream provider runtime, and exported MCP-provider
  backend implementation/seam consumed by Tool Portal

@agent-vm/gateway-control-contracts
  bounded private controller/Gateway control protocol

@agent-vm/controller-execution-contracts
  controller re-authorization and execution data contracts

@agent-vm/openclaw-agent-vm-plugin
  thin OpenClaw adapter using one long-lived GatewayRuntimeClient; native tool
  registration, native-origin validation, and one UDS-backed SandboxBackend;
  any buildExecSpec helper is operation-scoped transport only

Hermes Agent VM plugin/backend distribution
  thin Python profile-origin and managed-BaseEnvironment adapter using
  GatewayRuntimeClient only

@agent-vm/agent-vm
  controller/operations CLI, immutable managed Gateway boot inputs, aggregate
  readiness, durable ownership, recovery, VM/lease/execution/approval authority,
  and concrete-provider composition; it boots the VM but never launches a
  managed guest service and does not own the Tool Portal client CLI
```

Exact Python distribution availability and final publish spelling are
plan-owned, but the role and import name must be unambiguous and tested.

### Allowed dependencies

```text
consumer / subpath                       allowed runtime dependencies

agent-portal-sdk root + /contracts       Zod and contract primitives only;
                                          root export is contract-only

/tool-portal-mcp-client                  contracts + standard MCP client
                                          transport dependencies only

/gateway-runtime-client                  contracts + UDS/JSON-RPC transport
                                          dependencies only; no MCP/SSH/VM

/cli                                     ToolPortalMcpClient + CLI parsing and
                                          protected config discovery only

tool-portal                              contracts + config contracts +
                                          controller-execution contracts +
                                          mcp-portal provider/auth seams +
                                          standalone MCP server dependencies;
                                          portable capability core only, no
                                          UDS/SSH/controller runtime internals

mcp-portal/mcp-provider-backend          contracts + MCP provider runtime;
                                          no ToolPortalService or UDS

gateway-runtime                          contracts + tool-portal +
                                          gateway-control contracts +
                                          controller-execution contracts +
                                          gateway-lifecycle boot/readiness contracts +
                                          managed ToolPortalService,
                                          Gateway-side control/Tool VM/UDS/SSH code;
                                          no managed-vm or concrete adapter

openclaw-gateway / hermes-gateway        gateway-lifecycle only; framework
                                          image/config/readiness preparation, no
                                          controller guest-process launcher,
                                          runtime implementation, or VM adapter

worker-gateway                           gateway-lifecycle only; direct process
                                          contract remains explicit

gondolin-vm-adapter                      managed-vm + Gondolin SDK only

agent-vm controller domains              gateway-lifecycle + managed-vm +
                                          gateway/control execution contracts;
                                          narrow injected capabilities only

agent-vm Gateway composition             immutable config/mount/environment/
                                          ingress + exact selected image boot
                                          contract; no controller guest-process
                                          launch and no generic service graph

agent-vm composition/build modules       concrete adapter allowed only in
                                          composition/gondolin-managed-vm-provider.ts
                                          and build/gondolin-managed-vm-build-tooling.ts

managed OpenClaw/Hermes adapters         GatewayRuntimeClient only, plus their
                                          framework adapter contracts

portable consumers                       ToolPortalMcpClient or generic MCP only
```

The Python distribution mirrors these ceilings: its root does not eagerly
import either transport client; contract models, MCP client, and UDS client are
separate import modules. Python MCP imports do not load UDS/Gateway dependencies,
and Python UDS imports do not load MCP, SSH, controller, ManagedVm, or Gondolin
dependencies.

### Forbidden dependencies

- Clients to Tool Portal policy/router/backend implementations.
- Agent Portal SDK root/contracts exports to MCP, UDS, CLI, bridge, SSH, VM, or
  controller runtime dependencies.
- ToolPortalMcpClient or the Tool Portal CLI to UDS/Gateway runtime modules.
- Python clients to controller runtime, Socket.IO, lease implementation, SSH,
  ManagedVm, or Gondolin.
- The portable capability core used by ToolPortalService to OpenClaw, Hermes,
  UDS, Socket.IO, SSH, or controller runtime internals. The managed
  ToolPortalService aggregate belongs to Gateway runtime and may depend only on
  the narrow agent-vm-owned UDS, control, binding, SSH, and status contracts
  required by this spec; it never imports framework or concrete VM-adapter code.
- ToolPortalMcpClient to Gateway runtime or controller internals.
- GatewayRuntimeClient to MCP Portal core or direct SSH.
- Gateway runtime to `managed-vm`, `gondolin-vm-adapter`, the Gondolin SDK,
  OpenClaw/Hermes host lifecycle implementations, or controller runtime.
- Managed plugins to ToolPortalMcpClient, Tool Portal runtime, lease, SSH, or
  control implementations.
- Any OpenClaw buildExecSpec transport helper to Tool Portal operations,
  capability routing, identity/root selection, lease/use mutation, SSH
  material, controller policy, or persistent attachment authority.
- Gateway runtime to controller-owned policy/state mutation.
- Controller to framework-specific OpenClaw/Hermes client implementations.
- Any production module other than the two existing `agent-vm` composition/build
  modules to `gondolin-vm-adapter`; any package other than that adapter to the
  Gondolin SDK.
- Any controller domain to aggregate `ManagedVmProvider`; it may import only the
  narrow neutral capability it receives.

The package split is boundary-driven, not purity-driven. One SDK distribution
per language contains contracts and both explicit clients behind isolated
subpaths. Runtime/service ownership remains in separate packages. A dedicated
contracts package is deferred until an independent consumer or release cadence
requires that release boundary.

Exact allocation or renaming of the current capability-only
`ToolPortalService` type is plan-owned. The resulting code must leave exactly
one top-level managed ToolPortalService owner in Gateway runtime and one clearly
subordinate portable capability core; the current four-method object cannot
remain ambiguously named as the whole service while control, SSH, sandbox, and
status ownership lives beside it.

The combined graph is additive to the managed-VM boundary contract. Gateway
runtime and the framework lifecycle packages reuse neutral service/health
vocabulary from `gateway-lifecycle`; none owns the other's launch. `agent-vm`
is the only managed Gateway configuration/admission composition root and depends directly on
`controller-execution-contracts` to validate and execute controller intents.

## Alternatives and tradeoffs

### One transport-polymorphic client

Rejected. It makes privilege and method availability constructor-state
dependent, encourages managed plugins to import MCP dependencies, and obscures
the distinct admission semantics of the Capability API and SSH Sandbox API.

### MCP for all managed operations

Rejected. MCP is appropriate for portable bounded tools but cannot honestly
represent the direct environment/process/stream/terminal lifecycle or protected
local authority without becoming a private nonstandard protocol.

### HTTP/JSON over UDS

Rejected for the managed runtime. Unary HTTP is simple for four capability
operations but needs a second convention for bidirectional lifecycle,
cancellation, and bounded stream events.

### gRPC or ConnectRPC

Deferred. They provide stronger generated stubs but add HTTP/2/codegen/runtime
complexity before the method set and cross-language fixtures justify it.

### Custom binary UDS framing

Deferred. Local JSON-RPC is fast enough for expected LLM and bounded binary
rates. One source-owned application chunk per serializer plus explicit
parser/Node/kernel retained-byte caps avoid unbounded buffers. Revisit only
after measured CPU, allocation, latency, or throughput evidence.

### Large per-client output queues

Rejected. They increase failure-state memory without improving normal LLM
throughput. Producer pause, one source-owned application chunk per serializer,
explicit parser/Node/kernel retained-byte caps, pause deadlines, total caps,
artifacts, and truncation provide the required containment.

### Same-Gateway managed-process recovery

Rejected. It preserves stale custody and creates separate OpenClaw/Hermes/
runtime recovery models. Gateway VM replacement is fast enough and provides a
clean authority/security reset.

### Native or general ManagedVm filesystem access

Rejected. A native Gondolin filesystem handle would recreate the backend leak
removed by the managed-VM cut, while a general neutral filesystem API would
expand every backend's authority for one narrow runner-artifact need. The
controller instead invokes one fixed controller-authored stock guest-tool argv
through structural ManagedVm streaming exec. The executable, prefix, root, and
bounds are not caller-selected, and no general guest filesystem access is
exposed.

### Runtime-parent and framework-child topology

Rejected. Making the Tool Portal service launch or supervise OpenClaw/Hermes
couples the common service to framework process APIs and creates a second
recovery owner. The accepted Managed Gateway Boot Contract starts the two exact
sibling roles during VM boot, with aggregate readiness and one controller-owned
whole-VM recovery decision. Worker deliberately remains on its separate direct
per-task lifecycle.

### Controller-launched managed guest services

Rejected. Controller `ManagedVm.exec()` startup makes the host controller a
guest-process launcher and adds post-boot command round trips, partial-launch
cleanup, and same-VM process ownership that the Gateway recovery model does not
need. The controller prepares immutable inputs and boots the VM; the selected
image's exact boot contract starts both roles. Actual startup improvement is an
E2E measurement, not an assumed guarantee.

### Generic in-VM service graph or guest supervisor

Rejected. Version 1 requires exactly two named service roles, not an arbitrary
service list, init system, launcher, or restart graph. A third long-lived service
or independently recoverable component requires explicit architecture review.

## Accepted V1 compromises and revisit signals

- Four universal MCP tools: revisit when catalog payload limits or measured
  discovery round trips materially harm real agents.
- Handwritten clients over generated/validated models: revisit after a third
  SDK language, a materially larger method registry, or an escaped semantic
  drift defect.
- One common Tool Portal service process and one selected framework service
  process are siblings in the same Gateway VM trust domain. The exact pair and
  whole-VM recovery model remain fixed until a third service, measured
  replacement cost, or concrete isolation requirement justifies revisiting it.
- Concurrent startup accepts one bounded UDS-publication race rather than a
  dependency launcher. Revisit only if measured attachment latency approaches
  the startup deadline or materially harms availability.
- One UDS connection with JSON-RPC chunks: revisit if bounded saturation proves
  cancellation latency, fairness, CPU, or allocation unacceptable.
- Existing CLI allowance grammar: revisit if a new backend duplicates
  normalization or a promoted operation cannot be expressed without weakening
  policy.

## Proof expectations

The implementation plan must operationalize each proof layer without weakening
the requirement:

| Requirement area | Proof expectation |
| --- | --- |
| Contracts | Strict unknown-field/version/framing rejection; registered machine-readable portable-refinement descriptors; structural rejection of anonymous shared refinements/transforms; generated schema/validators; shared TS/Python valid, invalid, boundary, malformed, default, canonicalization, and outcome-algebra fixtures. |
| Configuration and identity | Strict discriminated-union fixtures prove managed rejects every standalone endpoint/auth field, standalone requires explicit entrypoint/auth configuration and rejects `tool_vm_runner`/`controller_host_action`, and `profiles.*.capabilities` is rejected everywhere. Managed projection fixtures prove exact one-to-one `agentId` mapping to discriminated OpenClaw-agent or Hermes-profile identity, distinct Tool Portal profile identity, the exact optional `WorkspaceGitPolicy` union, whole-projection revision changes, exact configured sets, and rejection of caller/model path or identity selection. Catalog and egress fixtures prove local or absent workspace Git exposes no push surface, remote workspace Git exposes only the `workspace_git_push` controller host action with host-only HTTPS credentials, and Tool VM Git SSH remains read-only. Storage-binding fixtures separately prove controller-owned noncolliding workspace and optional `/gitdirs/workspace.git` capabilities. Plugin-origin tests distinguish required stable principal, optional requester, and optional correlation; session changes preserve same-principal/current-generation handles while cross-principal, cross-framework, wrong-binding-revision, or stale-generation use fails. |
| Service ownership | Managed production proof shows exactly one ToolPortalService owns the controller peer, per-agent bindings and proactive exclusive SSH connections, Capability API, SSH Sandbox API, artifacts, readiness/status, and one provider runtime. The managed framework-facing surfaces have no HTTP/MCP/stdio listener or Gateway ingress; only the private controller-initiated Socket.IO control endpoint and explicit private non-`/` controller-execution data route are permitted outside the UDS surface. Standalone proof shows every explicitly enabled entrypoint projects one shared ToolPortalService/provider runtime with no controller, binding, SSH, or SSH Sandbox authority. Structural proof rejects a second service, connection owner, or policy state in plugins, clients, adapters, and entrypoints. |
| Managed Gateway boot | Image/build-contract proof admits exactly one Tool Portal boot entry plus exactly one OpenClaw-or-Hermes boot entry, rejects child recipes/arbitrary service arrays, and leaves Worker direct. Controller integration proves managed startup calls `ManagedVm.start()` without `ManagedVm.exec()` launch commands, joins aggregate readiness, and contains every boot/readiness failure without ingress or adoptable work. Stock-VM process evidence proves both sibling roles started from VM boot as UID/GID `0` and neither is parent, supervisor, restarter, or adopter of the other. A first-class structural guard rejects managed-Gateway `setpriv --reuid/--regid`, `frameworkServiceUser`, `openClawServiceGuestOwnership`, `projected-guest-identity`, `ManagedVmGuestOwnership`, numeric service-account creation/pinning, or equivalent guest-identity projection. Before deleting the prior post-boot launch path, capture a one-time boot-to-ready baseline using the same fixture, host/hardware, cache state, readiness definition, sample count, and reporting method as the new path; report both distributions and the delta. The baseline is evidence only and must not preserve a compatibility path. Structural guards must also reject framework launch/supervisor/child-recipe imports or exports in `gateway-runtime` and the neutral managed lifecycle boundary, including the known `managed-framework-child-supervisor`, `ManagedFrameworkChildRecipe`, `ManagedFrameworkRuntimeSpec`, and `childRecipe` residue, without banning unrelated subprocess use. |
| Package ceilings | Manifest, source import, emitted-declaration, runtime module-load/bundle, root-export, package-artifact exact-HEAD, and Python import-graph proof for every allowed/forbidden subpath edge. The managed OpenClaw overlay/hook is pinned, minimal, structurally scoped to native-agent identity, `/workspace/memory` routing, rootfs/COW `/work`, optional `/gitdirs/workspace.git`, mandatory backend bridge, and agent-authored-versus-managed skill mutability, and cannot import Agent VM controller/lease/SSH/runtime implementations. |
| Managed VM boundary | Structural/declaration/package-artifact guards preserve the hard package names, backend-neutral contracts, narrow controller capability imports, exact two-module Gondolin adapter allowlist, no native handle/filesystem escape, and no compatibility aliases; a stock real VM proves the neutral exec, owned-directory, durable identity, health, and recovery seams. |
| Standalone Tool Portal MCP | Standard client proves four `tool_portal_*` tools, canonical `structuredContent`, bounded text/progress, explicit non-`/` URL ingress, Tool-Portal-audience bearer identity, per-agent exact-call HMAC approval, stale/wrong-audience/replay rejection, auth/session isolation, readiness/drain, cancellation, and redaction against the one standalone service. |
| CLI | Packed/built `tool-portal` binary proves all four operations, HTTP/stdio configuration, auth failure, canonical JSON stdout, stderr separation, mixed-result exit status, interrupt cancellation, and no second service or local policy. |
| Cross-mode semantics | A matched stable principal/profile/namespace-policy/binding-revision/arguments/approval cohort for an `mcp_provider` capability through standalone MCP and managed UDS yields equivalent visibility, approval meaning, binding, result, error, artifact, and outcome semantics while preserving mode-specific proof custody. Separate fixtures prove intentional standalone denial of managed-only backend kinds without a second router. |
| SDKs | Real TS and Python clients connect, negotiate, cancel, reconnect safely, reject skew, and preserve typed results/errors. |
| OpenClaw adapter | Selected OpenClaw `2026.6.8` proof uses at least two configured agents through one long-lived GatewayRuntimeClient and one registered UDS-backed SandboxBackend. It proves native `agents.list[].id` origin, exact projections, unconfigured/mismatched/colliding rejection, and no cross-agent cache/handle/result visibility. Stock managed-tool proof establishes ordinary relative terminal/file/edit/apply-patch work and default cwd at rootfs/COW `/work`; explicit writable `/workspace` access to only the current agent's filtered durable workspace; optional per-agent Git at `/gitdirs/workspace.git`; automatic memory flush and bridge mapping at `/workspace/memory`; writable agent-authored skills through both bridge and exec; distinct managed skills read-only; read-only `/agent-vm`; mandatory backend-provided UDS filesystem bridge; and hard failure with zero Gateway-local fallback/mutation when the bridge/service is absent. Per-agent catalog proof exposes `workspace_git_push` only for remote workspace Git. Any buildExecSpec helper proves current-operation attachment, stdin/PTY/signal/late-terminal/finalize fidelity, no independent client or authority, and no direct controller/lease/SSH/path residue. |
| Hermes adapter | Pinned Hermes proof uses at least two configured agents mapped bijectively to an exact controller allowlist of normalized native profiles and rejects an undeclared on-disk profile, implicit `default`, duplicate/case-normalization collision, missing profile, wrong Tool Portal profile, and shared workspace. Creating or exposing an undeclared profile after readiness is rejected before adapter/session/environment state, makes the cohort unhealthy/Gateway-fatal, and never falls back to `default`. Concurrent turns prove routed `SessionSource.profile`, protected HERMES_HOME/config/secret/session isolation, approved filtered `/workspace`, rootfs/COW `/work` cwd, optional `/gitdirs/workspace.git`, read-only `/agent-vm`, identity-keyed environment/file/process/result caches, intentional same-profile sharing only, and `workspace_git_push` catalog presence only for remote workspace Git. Terminal, ShellFileOperations, and non-local `execute_code` converge on one managed BaseEnvironment/operation group; missing or skewed managed registration fails unavailable with no local/generic-SSH fallback. Tool-VM shell attacks cannot reach complete HERMES_HOME, sibling profiles, UDS, controller state, auth/session DB, or Gateway state. |
| UDS and in-VM trust | Stock-image proof shows the fixed VM-local socket is private, absent from ingress/Tool VM mounts/persistent state, and usable by the managed framework within the same shared guest-root Gateway-VM trust domain. Protocol tests reject method-before-handshake, duplicate connection, stale epoch/generation, wrong client kind, wrong projection-cohort digest, workspace/Git-binding or host-path authority injection, and cross-agent handles. |
| UDS streaming | Slow/frozen/disconnected client proves the exact source/parser/Node/kernel retained-byte bound, producer pause, pause deadline, local discard-drain escape, local and server cancellation/terminal access behind queued data, total caps, and truncation/artifact behavior. A two-agent saturation fixture freezes one agent's consumer and proves the other agent experiences at most the configured bounded head-of-line delay, retains independent authority/binding/SSH/registry/handle/routing/failure state, and continues to receive controller-plane safety, liveness, and recovery operations within their configured deadlines. |
| CLI security | Shell tokens, launchers, config/credential/endpoint/plugin overrides, response files, path/host escapes, and policy-changing flags fail. |
| Approval | Managed controller and standalone HMAC tests separately prove concurrency, replay, denial, revocation/expiry, changed fingerprint, wrong audience, cross-principal/surface, restart, and crash cuts before/after atomic one-use consumption, with one ToolPortalService policy meaning and truthful not-dispatched versus ambiguous outcomes. |
| Artifacts | MCP resources and both SDK clients prove bounded range readback, per-read reauthorization, cross-principal/surface/generation denial, expiry/epoch retirement, fingerprint mismatch, no path disclosure, and store byte/count/lifetime caps. |
| Persistent Tool VM | Managed proof distinguishes Capability API admission from direct SSH Sandbox API admission, then shows both converge only on the same agent's current binding and ToolPortalService-owned strict-pinned SSH connection. It proves that an unbound agent creates no lease, Tool VM, or SSH connection; controller publication of that agent's binding starts only its proactive `connecting`/`ready` lifecycle; an idle healthy connection does not prevent real controller idle expiry; expiry retires that exact binding and connection; and later demand may create a successor. It also proves loss/retirement status, typed not-ready behavior, connection readiness independent from active use, and rejection of cross-agent connection or handle reuse. Standalone version 1 exposes neither a Tool VM backend nor SSH Sandbox API. The managed VM exposes the current agent's filtered durable `/workspace`, fresh rootfs/COW `/work`, optional `/gitdirs/workspace.git`, read-only `/agent-vm`, and tmpfs. Real exec/fs/process/stream/terminal behavior, durable workspace modification, predecessor hot-work loss, fresh trusted-image successor boot, background status/log/cancel, replacement, exact identity pin, stale-handle rejection, and predecessor-fence-before-successor-persistent-write/routing are proven. A real remote fixture proves Tool VM Git SSH permits fetch and rejects push while host-only HTTPS `workspace_git_push` preserves sanitized expected-head/CAS behavior and rejects the configured default branch. |
| Filesystem safety | Real Tool VM fixtures prove relative/default-cwd rootfs/COW `/work`, explicit filtered `/workspace`, optional `/gitdirs/workspace.git`, read-only `/agent-vm`, writable agent-authored skills where policy permits, and cross-agent/`/zone`/state/framework-home/controller/another-agent-workspace-Git/managed-skill write denial through both filesystem and exec paths. They prove NUL/`..` rejection, entry/depth/byte/time limits, bounded symlink/error behavior, no caller-supplied controller-host path derivation, no general ManagedVm/native filesystem escape, and stock Gondolin/OwnedHostDirectory fencing for every persistent capability. |
| Controller execution | Real runner/host output proves controller-initiated private-route authentication, end-to-end bounded producer pressure, independent queue/CPU/codec budgets, no Socket.IO/OTLP bytes, and configured heartbeat/cancellation/recovery deadlines under sustained cap saturation. Runner crash cuts cover reservation, identity publication, dispatch, side effects, streaming, containment, and no adoption; artifact extraction uses only fixed controller-authored stock-tool argv over neutral bounded-window exec. |
| Recovery | Real Gateway fault with `/health` green and control dead replaces the Gateway; independent Tool Portal/framework process death replaces the VM without a same-VM process successor; Tool VM death eagerly replaces only the leaf. Controller-restart proof adopts neither sibling and contains the whole predecessor VM. |
| Containment | Tool VM proof distinguishes authority fencing, non-routable trusted-image successor boot, exact-process access fencing, persistent-write/routing admission, and asynchronous cleanup completion. Successor boot overlaps exact-target predecessor teardown, but no successor tool request, persistent write, or routing begins until the predecessor runner is proven absent and stale-generation handles are rejected. `ManagedVm.close()`, health loss, retirement start, or telemetry alone is insufficient. Listener/provider/transfer/port/record cleanup continues afterward and does not revoke the successor; unproven access fencing leaves the predecessor owner-unsafe and the booting successor non-routable. Exact predecessor termination never invokes backend-global child cleanup and does not kill the Gateway, successor, or sibling Tool VMs. |
| Controller restart | Crash-cut evidence around durable ownership writes proves old-tree termination, no adoption, and fresh epochs. |
| State ownership | Config and structural mount proof preserves Gateway-visible `stateDir` paths while proving `controllerStateDir` absent from every Gateway and Tool VM mount or boot input. One canonical `zoneFilesDir/agents/<agentId>` workspace is created; its optional workspace Git database lives only under the agent-keyed runtime Git subtree. Tool VMs receive only the selected `/workspace`, rootfs/COW `/work`, optional `/gitdirs/workspace.git`, read-only `/agent-vm`, and tmpfs. Real OpenClaw and Hermes Tool Portal calls prove the live beta paths without backup, restore, migration, or repo-wide administrative cleanup gates. |
| Health and observability | Managed matrix proof independently faults Gateway VM, Tool Portal process, framework process/native service, ToolPortalService capability catalog, per-agent binding and SSH connection, projection-cohort revision and post-readiness profile drift, MCP provider, control, lease, active use, Tool VM, UDS, execution stream, and each producer's telemetry plane. It proves one agent's connection state cannot make another ready or unready, proactive connection health does not count as active use, and a hung-but-connected framework fails the native event-loop/request round-trip probe. Standalone listener/session health is proven separately and never creates a managed connection plane. Incident reconstruction preserves each plane's reason/age, saturation, decision, suppression/owner-unsafe reason, and successor stability without cross-plane reset or cardinality flood. Same-window collector/Victoria evidence positively finds both managed sibling service identities in traces, logs, and metrics, proves one real framework-to-UDS-to-backend trace for each request surface, and pairs positive safe markers with negative secret/content/cardinality canaries. Exporter outage or poisoning remains bounded and non-authoritative. |
| CI, release, and docs | Authoritative check/CI and release-artifact lanes own the structural, declaration, package-artifact exact-HEAD, documentation-terminology, and real-VM boundary gates; canonical docs contain only the hard package names and approved import boundary. |
| Real integrations | Managed OpenClaw and Hermes each use one GatewayRuntimeClient against the same common Tool Portal service executable, expose Tool Portal capabilities, and execute real sandbox work through stock Gondolin. OpenClaw proof covers at least two configured native agents with distinct durable workspaces, optional workspace Git, Tool Portal profiles, stable trusted contexts, mismatch rejection, native memory/core/skill writes, rootfs/COW hot work, fresh trusted-image replacement with no automatic project-worktree reconstruction, controller-owned workspace Git push, and no cross-agent cache/handle/result/file leakage. Pinned Hermes proof covers at least two configured agents mapped to an exact allowed set of distinct native profiles and Tool Portal profiles; protected HERMES_HOME/config/secrets/session/Gateway state never enters a Tool VM; only approved durable content projects to `/workspace`; hot work uses `/work`; optional workspace Git uses `/gitdirs/workspace.git`; remote Git push uses `workspace_git_push` with Tool VM Git SSH remaining read-only; every Tool Portal call carries stable routed context; no environment/file/session/cache leakage occurs; and logical cwd/environment-snapshot semantics within one lease, explicit reset on fresh replacement, terminal/file sharing, re-entrant non-local `execute_code`, cancellation/ambiguity propagation, complete ProcessHandle lifecycle, replacement loss, and Python/TS contract parity hold. Fake, schema-only, or single-agent-only framework processes are not proof. |
| Beta acceptance | The beta deployment contains separate real OpenClaw and Hermes Gateway zones using the same configured collector/Victoria sink. Each Gateway contains at least two configured agents with distinct framework identities, Tool Portal profiles, durable workspaces, and Git policies. Provider-verified GPT-5.6 Luna high exercises both real Gateway paths through exact synced artifacts and proves framework behavior, Tool Portal capabilities, unrestricted SSH Sandbox API behavior in each selected Tool VM, workspace isolation, rootfs/COW hot-work loss, controller-owned `workspace_git_push`, configured-default-branch rejection, fresh Tool VM replacement, and same-sink traces/logs/metrics. Backup, restore, migration, destructive-consumer cleanup, exhaustive fault permutations, and performance-distribution studies are not beta gates. |

Inventory or skipped tests do not prove a live VM, control, SSH, provider, or framework path.

## Plan-owned choices

- Exact TypeScript names and file allocation for neutral managed boot/readiness
  metadata, provided both roles remain named, complete, non-generic, and preselected.
- Exact image/build-file allocation for the two boot entries and their service
  evidence, provided Gondolin init starts both, continues to `sandboxd`, adds no
  supervisor/restart/service graph/shell authority/controller launch, and contains failure.
- Exact bounded TypeScript/Python startup retry durations and backoff; only
  pre-handshake socket absence retries, while invalid/stale/authority failures fail closed.
- Exact author-facing observability schema and service-resource attribute names,
  provided one zone policy targets one mediated sink, both producers emit all three signals
  under distinct controller-fixed identities, and context is bounded/non-authoritative.
- Exact JSON-RPC method names and schema file allocation within the normative
  semantic groups.
- Frame/chunk/total byte defaults, provided all remain bounded and tested.
- Exact runtime-directory allocation details, attachment-generation
  representation, and reconnect window, provided the fixed
  `/run/agent-vm/gateway-runtime/managed-plugin.sock` path stays Gateway-private,
  epoch fencing remains protocol/lifecycle state, and authority stays
  server-derived.
- Exact names/file allocation for the pinned OpenClaw managed SandboxBackend
  identity/workspace hook and any operation-scoped buildExecSpec helper. The
  hook must carry native agent identity, route automatic memory flush and its
  bridge mapping to `/workspace/memory`, require the backend-provided UDS bridge without a
  local fallback, and give writable agent-authored skills and read-only managed
  skills identical bridge/exec behavior; a helper still requires a current pending
  reservation and atomic one-use consumption before duplicate/stale failure.
- Exact managed Hermes BaseEnvironment factory/registration shape,
  identity/generation cache key, exact-profile allowlist materialization, and
  physical session-store allocation, provided profile identity and protected
  state remain isolated, all execution reaches UDS, and no default/local/ambient
  fallback exists.
- Exact fixed read-only managed-skills guest path and projection packaging,
  provided neither framework treats writable agent-authored skills as managed
  policy and Tool VMs cannot mutate the managed source.
- Exact standalone Tool Portal HTTP listener count/route grouping, explicitly
  enabled transport set, bearer/HMAC field spelling, rotation mechanism, and
  Tool Portal CLI endpoint spelling; managed framework-facing API surfaces
  remain private-UDS-only and standalone version 1 remains MCP-provider-only.
- Superseded by the Tool Portal wrap-up hard cut: the unused self-revision
  manifest, cross-view readback retry, and atomic manifest helper are removed
  rather than retained as a production or proof surface.
- Exact requester-context field names and correlation field set, provided the
  three-part principal/requester/correlation split and authority rules hold.
- Exact portable-refinement descriptor/generator emitting TypeScript and Python
  validators plus refinement identities; JSON Schema generation alone is insufficient.
- Exact stock guest operations used for Tool VM filesystem methods and runner
  artifact extraction: normalized paths/identifiers, fixed controller-authored argv,
  output framing, and bounds. No agent-vm-owned native
  helper or general ManagedVm filesystem surface may be introduced.
- Exact backend-neutral ManagedVm exec pipe/discard and bounded-output-window
  shapes using agent-vm-owned structural contracts without a native adapter handle.
- Exact controller execution WebSocket framing and whether backpressure uses
  stream pause/drain, explicit credits, or both.
- Exact TypeScript and Python package publish spelling after registry checks.
- Whether SDK client modules split into separate packages after evidence;
  separate client types and dependency ceilings are not optional.

None of these choices may introduce a compatibility path, second semantic
router, unbounded queue, or client-selected authority.

## Open decisions

No product or architecture decision remains open in this corrected draft. The
managed Tool Portal and selected framework service are separate sibling
processes running as guest UID/GID `0` inside one trusted Gateway-VM domain.
That choice preserves the existing guest execution and host-backed mount model,
adds no Gondolin or cross-UID mechanism, and grants no access to
`controllerStateDir`, which remains outside every guest mount and boot input.

The plan must validate plan-owned choices against current APIs and the proof
expectations above. If the pinned OpenClaw integration cannot add native-agent
identity, route memory and file operations to filtered `/workspace`, preserve
rootfs/COW `/work`, and require the UDS bridge without a broader framework
rewrite, Hermes cannot
provide an exact profile allowlist and identity-keyed environment without local
fallback, VM boot cannot produce adequate sibling evidence without a resident
launcher/supervisor, framework initialization cannot tolerate bounded UDS
startup retry, aggregate readiness requires circular ownership, or either
producer cannot bound OTEL export/context, return with evidence rather than
weakening this contract.
