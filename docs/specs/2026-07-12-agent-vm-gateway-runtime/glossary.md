# Tool Portal service, Gateway runtime, and SDK glossary

Date: 2026-07-12
Status: normative companion to `agent-vm-gateway-runtime.md`

This glossary is part of the design contract. The primary spec, packages,
schemas, documentation, tests, metrics, and operator output use these terms with
the meanings below. A new synonym is not introduced when one of these terms is
accurate.

## Product and service terms

### Tool Portal

The portable capability system. Tool Portal owns the product meaning of a
capability catalog that can include upstream MCP-provider capabilities, named
Tool VM capabilities with bounded request/result contracts, controller-owned
runner capabilities, and controller host actions.

Tool Portal's backend semantic scope includes MCP Portal-mediated capabilities
plus non-MCP capability classes. It composes MCP Portal; it does not inherit MCP
Portal's API, transports, operation names, or complete unscoped catalog. Tool
Portal is not itself a transport, protocol, process, SDK, VM, or controller.

### ToolPortalService

The one transport-neutral Tool Portal application service hosted by a Tool
Portal service process. In every mode it owns the Capability API, live
caller-scoped catalog, profile policy, portable approval semantics, capability
binding/routing, artifacts, and normalized public results/events.

In managed mode the same ToolPortalService additionally owns the controller
relationship, current agent-specific Tool VM bindings, proactive and exclusive
per-agent SSH connections, SSH Sandbox API, environments, processes, streams,
terminals, and binding/connection readiness status. Capability API backends and
direct SSH Sandbox API requests may execute in the same Tool VM through the
same agent-specific maintained SSH connection after their distinct admission
paths. MCP and UDS adapters do not implement independent service ownership,
policy, binding, connection management, or routing.

In standalone version 1 ToolPortalService has no controller relationship,
managed binding, maintained Tool VM SSH connection, or SSH Sandbox API. For
controller-owned execution, the controller separately remains authoritative for
approval-record validity, execution-fingerprint freshness, and final execution
admission.

The implementation may keep a portable capability core, binding manager,
connection manager, sandbox runtime, artifact store, and status projection as
separate internal components. Those boundaries do not create another
ToolPortalService or connection owner.

### Capability API

The `list`, `search`, `describe`, and `call` request surface owned by
ToolPortalService in managed and standalone modes. A call selects
`{ namespace, name, arguments }`; ToolPortalService applies catalog visibility,
profile policy, approval, and exactly one configured backend. A backend may
execute inside an assigned Tool VM, but the caller does not receive arbitrary
shell or SSH authority.

### SSH Sandbox API

The managed-only direct execution surface owned by ToolPortalService and
projected through `GatewayRuntimeClient.sandbox`. It accepts authenticated
environment, execution, filesystem, process, stream, and terminal operations
for the calling agent's current Tool VM. It does not perform capability catalog
lookup or per-command capability approval. It always uses the calling agent's
current ready binding and maintained SSH connection and has no standalone
version-1 projection.

### MCP Portal

The reusable upstream MCP-provider product. It owns upstream MCP provider
configuration, sessions, provider credentials, MCP-specific schema validation,
transport selection, and provider routing.

Standalone MCP Portal remains independently usable and exposes
`mcp_portal_list`, `mcp_portal_search`, `mcp_portal_describe`, and
`mcp_portal_call`. Managed Tool Portal composes MCP Portal through its exported
MCP-provider backend seam. MCP Portal does not own Tool VM, sandbox, lease,
controller-runner, or Tool Portal policy semantics.

### MCP provider configuration

Authored `mcp.config.jsonc`. It owns upstream MCP providers, transports, egress,
provider secrets, and discovery metadata. It is shared input to managed Tool
Portal and standalone/external MCP Portal, but it does not grant an agent access
to a capability.

### MCP Portal configuration

Authored `mcp-portal.config.jsonc`. It owns only standalone/external MCP Portal
agent profiles, proxy authentication, credential versions, and external
approval-HMAC configuration. Managed Gateway composition does not load it or
derive Tool Portal authorization from it.

### Tool Portal configuration

Authored `tool-portal.config.jsonc`. One strict `mode` discriminated union owns
Tool Portal agent/profile assignments, cross-backend namespace bindings, tool
visibility, call policy, and approval policy in both runtime modes. The
`managed` branch is private-UDS-only and forbids standalone endpoint/auth fields.
The `standalone` branch explicitly enables and configures its HTTP/MCP/stdio
entrypoints, bearer identity, and per-agent HMAC approval and admits only
`mcp_provider` bindings in version 1. Managed-only `tool_vm_runner` and
`controller_host_action` bindings fail standalone schema/startup validation.
Every profile uses
`profiles.*.namespaces`; the former `capabilities` key has no alias or fallback.
It is not an implicit merge of MCP Portal configuration.

### Shared MCP-provider runtime

The one Tool-Portal-service-owned MCP provider runtime and ToolPortalService backend
port used by every configured managed agent. Trusted invocation context selects
an authorized per-operation view; it does not select or construct an agent-bound
provider backend. The runtime may keep agent-scoped catalog, session, or cache
state internally to prevent leakage while retaining one provider execution
authority.

### Gateway runtime

The Gateway-local infrastructure implementation packaged by
`@agent-vm/gateway-runtime` and hosted by the Tool Portal service process. It
constructs one ToolPortalService and supplies its protected UDS, Gateway-side
control, agent-binding, strict SSH, process, stream, terminal, artifact, and
status implementation mechanics.

Gateway runtime names an implementation role, not a separate process ancestor,
framework launcher, supervisor, controller, or recovery owner. It owns
current-epoch implementation mechanics inside its service host; ToolPortalService
remains their application-service owner. Gateway runtime does not launch,
signal, restart, or adopt OpenClaw/Hermes and does not mint controller authority
or independently select profiles, mounts, credentials, VMs, leases, or recovery
outcomes.

### Tool Portal service process

The one long-lived sibling process in a managed Gateway VM that hosts Gateway
runtime and exactly one ToolPortalService. It owns the private UDS path, shared
MCP-provider runtime, process health, and bounded drain. Its hosted
ToolPortalService owns current-epoch controller/binding/SSH/attachment/artifact/
process/stream/terminal custody and status. It exposes no framework-facing HTTP,
MCP, stdio, or public ingress listener. Its private
controller-initiated Socket.IO control endpoint and explicit private non-`/`
controller-execution data route are controller-only transport endpoints, not
Tool Portal API projections or Gateway ingress.

It is not Tool Portal the product, ToolPortalService the application object, the
controller, or the selected framework process. It never launches, parents,
supervises, signals, restarts, or adopts its framework sibling.

### Standalone Tool Portal service process

A Tool Portal host outside managed Gateway mode. It loads the `standalone`
branch of `tool-portal.config.jsonc`, constructs one ToolPortalService and one
shared MCP-provider backend runtime, and exposes only the explicitly enabled MCP/HTTP/stdio
entrypoints. It authenticates a Tool-Portal-specific bearer agent/profile and
verifies per-agent exact-call HMAC approvals. It has no managed-plugin UDS,
Gateway control relationship, Gateway epoch, framework sibling, or implicit
controller/VM/SSH authority. Version 1 rejects `tool_vm_runner` and
`controller_host_action`; generic backend ports do not create standalone
authority. Config-file protection against modification by another
same-user host process is deferred; runtime schema, authentication, audience,
replay, and policy enforcement are not.

### Managed Gateway Boot Contract

The exact image-owned guest boot rule for one managed Gateway VM. It contains
one common Tool Portal service boot entry and exactly one selected
OpenClaw-or-Hermes framework service boot entry. The existing Gondolin guest
boot/init extension starts both long-lived sibling roles without waiting for
either role to become ready, then continues its normal handoff to `sandboxd`.
Both long-lived service entries use the existing guest-root service identity,
UID/GID `0`; the boot contract introduces no UID transition, separate service
account, or cross-UID filesystem projection. The sibling process boundary is
for address-space, event-loop, and crash isolation, not Unix-principal
isolation.
The controller prepares immutable configuration, mounts, environment, expected
identities, ingress policy, and the selected image, calls `ManagedVm.start()`,
derives aggregate readiness, and owns whole-VM recovery. It never starts either
managed service through `ManagedVm.exec()` or an equivalent guest-process API.

The boot contract is startup behavior and metadata, not a third agent-vm
service, process supervisor, generic service array, init system, resident
launcher executable, or restart graph. It never restarts either sibling.

### Managed plugin

The OpenClaw- or Hermes-specific adapter running inside a managed Gateway VM.
It derives trusted framework context, registers framework-native tools, and
adapts framework sandbox/environment APIs to one GatewayRuntimeClient.

A managed plugin does not host ToolPortalService, create a managed
ToolPortalMcpClient, implement lease/SSH policy, or import controller runtime
code.

### Gateway framework

The selected OpenClaw or Hermes runtime and its thin managed adapter inside the
Gateway framework process. A Gateway framework authenticates native agent or
profile origin and uses one `GatewayRuntimeClient` to reach ToolPortalService.
It receives API behavior over private UDS, not raw SSH material, Tool VM
identity, lease authority, controller code, or connection ownership. Do not call
OpenClaw or Hermes Gateway runtime.

### Framework identity cardinality

The exact set of native framework identities one framework service must
separate safely. Both OpenClaw and Hermes admit multiple declared Agent VM
agents through one framework process and one GatewayRuntimeClient. OpenClaw
maps each admitted Agent VM agent exactly once to the same native
`agents.list[].id`. Hermes maps each admitted agent exactly once to one unique
normalized native profile name and serves exactly the controller-authored
profile set; an implicit `default` or extra on-disk profile is not admitted.
Every managed ingress revalidates that set before adapter/session/environment
state. Post-readiness drift is rejected, makes the cohort unhealthy and
Gateway-fatal, and never falls back to `default`.
Native framework identity, Tool Portal policy profile, the selected agent
workspace identity and projection policy, workspace Git policy, and assignment
revision are separate parts of one configured-agent assignment.
Identity, environment, session, tool, process, result, and handle caches never
cross projections or collapse unrelated agents onto a literal `default` key.
Cardinality never creates another Tool Portal service or semantic authority.

### ManagedAgentProjection

The controller-authored immutable assignment for one Agent VM agent:

```text
agentId
frameworkIdentity = openclaw.agentId | hermes.profileName
toolPortalProfileId
profileAssignmentRevision
```

The projection identifies one configured long-lived agent and binds its native
framework identity to one Tool Portal policy profile. The assignment revision
covers the complete controller-authored assignment, including the agent-keyed
storage policy, but no host path, guest path, raw directory, or filesystem
capability is repeated by callers.

The controller resolves the agent's canonical workspace, filtered projection
policy, and optional workspace Git policy and database from trusted
configuration when constructing the current Tool VM binding. Framework
adapters authenticate native origin and assert the stable identity subset; Tool
Portal validates that subset against the immutable projection cohort. Missing,
duplicate, ambiguous, cross-kind, colliding, or stale projections fail before
admission or dispatch.
The projection cohort digest is the canonical revision hash of the exact sorted
projection set admitted for one Gateway epoch; UDS attachment validates it but
cannot choose it.

### Agent workspace

The canonical durable, agent-authored filesystem owned by one configured
long-lived agent at `<zoneFilesDir>/agents/<agentId>/`. The OpenClaw Gateway
sees it through its native `/zone/agents/<agentId>` view. A selected managed
Tool VM sees only the controller-filtered projection at `/workspace`.

It may contain framework-approved instructions, identity, memory, persona,
heartbeat material, authored skills, notes, and similar durable content. It may
contain an optional `.git` text pointer when workspace Git is enabled. It never
contains controller records, credentials, sessions, framework databases,
caches, dependency trees, build products, complete `HERMES_HOME`, or
sibling-agent content.

### Workspace projection

The controller-selected view of one exact agent workspace exposed to one
managed Tool VM at `/workspace`. It is created from one single-use
OwnedHostDirectory plus a controller-authored positive visibility, hidden-path,
nested-read-only, and writable-override policy.

The projection never accepts a caller-, plugin-, framework-, or model-supplied
host path. ShadowProvider filtering is defense in depth inside the already
selected per-agent source; it is not the boundary against sibling workspaces,
framework-private state, or controller state.

### Hot work

Writable disk-backed rootfs/COW data under `/work` in a managed Tool VM. It is
the default location for project worktrees, dependency installs, builds,
packages, caches, large temporary data, and relative terminal/file/code
execution.

Hot work survives commands and process restarts only while that Tool VM lives.
It is not a VFS mount, is not RealFS-backed, is not included in zone backup, and
is discarded on Tool VM close or replacement.

### Workspace Git configuration

The strict optional `zones[].agents[].workspaceGit` policy for one configured
long-lived agent:

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

Absence disables Git. `local` creates one isolated host-local workspace Git
database with no remote or push surface. `remote` creates the same isolated
database and exposes `workspace_git_push` as a `controller_host_action`; the
controller uses host-only HTTPS credentials and rejects the configured default
branch. Tool VM Git SSH remains read-only and rejects `git-receive-pack`.

OpenClaw and Hermes use the same per-agent placement. The field is not
Gateway-global and is not valid for the current Worker zone type.

### Workspace Git database

The optional Git database for one durable agent workspace. The database lives
at `<runtimeDir>/zones/<zoneId>/gitdirs/agents/<agentId>/workspace.git` and is
projected into that agent's Tool VM at `/gitdirs/workspace.git`. The workspace
contains only a `.git` text pointer; neither the pointer nor agent-writable Git
configuration grants controller authority.

### Generated runtime inputs

Reviewed controller-generated runtime facts and resources exposed read-only at
`/agent-vm`. They describe granted paths, backing, durability, optional workspace
Git, and available operations. They contain no raw credentials, host
paths, controller records, or authorization decisions, and they cannot select
or widen a capability.

### OpenClaw managed SandboxBackend

The thin OpenClaw backend registered by the managed plugin over its one
GatewayRuntimeClient. It authenticates native agent origin, resolves the
configured agent identity from OpenClaw's native workspace context, and routes
execution, process, and filesystem methods through UDS. The current Tool VM
filesystem contract is the selected filtered durable workspace at `/workspace`,
VM-lifetime rootfs/COW hot work at `/work`, optional workspace Git at
`/gitdirs/workspace.git`, and reviewed read-only generated inputs at
`/agent-vm`.

OpenClaw ordinary memory, persona, heartbeat, authored-file, and skill behavior
remains native against its Gateway `/zone/agents/<agentId>` view and the
corresponding Tool VM `/workspace` projection. The backend owns no controller,
lease, active-use, SSH, host-path translation, VM, or recovery logic and has no
local filesystem fallback.

An operation-scoped buildExecSpec helper may attach OpenClaw-owned
stdin/stdout/stderr/PTY to one exact pre-admitted operation. It is ephemeral
transport, not a second client or service. It cannot select identity, roots,
command, environment, lease, SSH, profile, credentials, or recovery authority.

### Hermes managed BaseEnvironment

The thin Python BaseEnvironment implementation used only in managed Gateway
mode. It maps routed `SessionSource.profile` through one
ManagedAgentProjection, uses the one GatewayRuntimeClient, and presents the same
current Tool VM contract: durable filtered `/workspace`, VM-lifetime rootfs/COW
`/work`, optional `/gitdirs/workspace.git`, and read-only `/agent-vm`.

Hermes native memory, skill, soul, and profile-state tools continue to operate
against `HERMES_HOME` in the Gateway VM. Only explicitly agent-owned,
framework-approved durable files may be projected into `/workspace`; complete
`HERMES_HOME`, credentials, sessions, configuration, logs, caches, and
databases never enter the Tool VM.

The environment preserves Hermes logical cwd, exported-environment snapshots,
file-operation sharing, ProcessHandle, cancellation, and re-entrant
`execute_code` semantics over UDS. Its cache key includes canonical agent,
native profile, assignment revision, Gateway/attachment epoch, and Tool-VM
generation. `TERMINAL_ENV`, `TERMINAL_CWD`, `os.getcwd()`, generic SSH, and
literal `default` are not managed execution or path authority. Missing/skewed
registration fails unavailable without local fallback.

### OpenClaw Gateway workspace view

OpenClaw's framework-native Gateway view of `zoneFilesDir` at `/zone`. For one
agent, `/zone/agents/<agentId>` identifies the configured agent workspace. The
SDK `workspaceDir` is validated only as agent identity evidence and is
translated immediately into an `agentId`-keyed capability request; it never
crosses Gateway Control as host-path or Tool VM path authority.

### Hermes Gateway profile state

Hermes-owned `HERMES_HOME` and profile-private state retained in the Gateway VM.
Native Hermes memory and skill-management tools operate there. It is framework
state, not a Tool VM workspace, and is never projected wholesale into
`/workspace`.

### Agent Worker storage contract

The existing direct per-task Worker storage behavior, unchanged by this
cutover. Worker keeps its current rootfs/COW worktrees under `/work/repos`,
separate RealFS Git databases, and task-lifetime `/state` semantics. Worker does
not gain a persistent long-lived agent workspace or the managed Gateway
workspace Git contract.

### Framework service boot entry

The selected image's exact boot entry for one OpenClaw or Hermes sibling
process. Its framework lifecycle package owns framework-specific image,
configuration, ingress, and readiness material; the image boot contract owns
startup. It does not describe, construct, or launch the common Tool Portal
service. It is not a controller-executed command, process object, spawn callback,
supervisor, restart hook, plugin instance, raw secret, controller policy,
ManagedVm handle, or Gondolin handle.

Worker uses the distinct direct per-task lifecycle and does not use a Managed
Gateway Boot Contract or Tool Portal service.

### Semantic configuration snapshot

The controller-authored, revisioned catalog, profile-assignment, policy,
capability-binding, provider, and schema configuration compiled from authored
`mcp.config.jsonc`, authored `tool-portal.config.jsonc`, and controller-owned
surface/lifecycle data, then activated atomically by one Tool Portal service. It is
immutable for the Gateway epoch; a semantic change requires Gateway replacement.
Managed composition does not consume `mcp-portal.config.jsonc` and has no public
Tool Portal credential rotation. Standalone authentication changes cannot mutate
semantic policy.

### Standalone Tool Portal credential audience

The purpose-separated authentication domain for standalone Tool Portal. A
bearer identifies one configured agent/profile and a per-agent HMAC proves one
exact protected call. MCP Portal and Tool Portal derive different audiences and
cannot accept one another's credentials. Credential versions are authentication
state, not semantic configuration revisions.

## Capability terms

### Capability

A portable public action identified by `{ namespace, name }` with one semantic
input schema, output/result contract, policy meaning, and safe description. The
effective caller-scoped catalog selects exactly one capability binding for the
active profile and revision; capability identity does not globally fix a
backend.

The caller selects capability identity and public arguments. Trusted config and
the controller select execution authority. A capability is not synonymous with
an MCP tool, CLI executable, shell command, backend, or VM.

### Tool

A model- or client-facing descriptor registered by an adapter. An MCP tool or
framework-native tool may represent a Tool Portal operation. Tool names and
transport conventions are adapter vocabulary; capability identity remains
`{ namespace, name }` inside Tool Portal.

### Capability binding

The trusted, profile-revision-specific mapping from one visible capability to
exactly one backend kind and its backend-specific reference. ToolPortalService
owns binding totality and ambiguity rejection. The binding is not public caller
input and is normally hidden from model-visible descriptors and results.

### Backend kind

The top-level implementation category selected by a capability binding. The
supported kinds are:

- `mcp_provider`: an upstream MCP capability through MCP Portal;
- `tool_vm_runner`: execution using one trusted Tool VM runner profile;
- `controller_host_action`: controller-owned execution on the trusted host.

Managed mode may bind every kind. Standalone version 1 may bind only
`mcp_provider`; the other kinds require managed controller/Gateway authority and
are rejected rather than mapped to local ambient authority.

`workspace_git_push` is a `controller_host_action` present only in the managed
catalog of an agent whose workspace Git policy selects remote mode. It is absent
for local and Git-disabled agents.

### Tool VM runner profile

The trusted execution profile within `tool_vm_runner` in version 1:

- `sandbox_ssh`: bounded work in the caller's current Tool VM through direct
  strict SSH owned by ToolPortalService and implemented by Gateway runtime.

The profile is trusted binding detail, not a backend kind or public selector.
Controller-owned execution uses the separate controller execution path; it is
not another `tool_vm_runner` profile.

### Tool VM capability

A named Capability API operation whose configured backend performs a persistent
Tool VM action and whose complete request, result, cancellation, and
recovery semantics fit the portable Tool Portal/MCP call model. Examples
include capped foreground execution, bounded file operations, and background
process operations using opaque handles and bounded log cursors.

Managed UDS `.portal` may invoke this portable shape. Standard standalone MCP
version 1 does not expose it because no standalone VM/controller authority is
defined.

It does not expose raw byte streams, PTY, attach, resize, SSH, lease operations,
or OS PIDs.

Its defining distinction is named capability admission, not whether execution
occurs inside a sandbox. It may execute inside the same Tool VM as a direct SSH
Sandbox API operation.

### SSH Sandbox operation

A direct managed-runtime request requiring execution, filesystem, process,
stream, environment, stdin, PTY, attach,
resize, binary file transfer, or generation-bound process interaction that
cannot be represented honestly as one bounded generic MCP tool call.

SSH Sandbox operations are available only through
`GatewayRuntimeClient.sandbox` over the protected UDS surface and operate on the
authenticated agent's current ready binding and maintained SSH connection.
They do not perform capability lookup or per-command capability approval.
Controller-owned runners and host actions remain Capability API calls through
ToolPortalService.

### Broad CLI allowance

A capability whose public input contains a caller-selected, already-tokenized
argv tail. Trusted policy fixes the executable, mandatory argv prefix,
credential profile, cwd, environment, egress, stdin, output, artifact, and
cancellation behavior. The argv tail passes strict shell/control-token and
CLI-specific validation before controller recomputation.

The authority grant covers every CLI operation admitted by the configured
grammar and credentials.

### Promoted typed capability

A domain-specific capability whose public schema contains typed fields rather
than raw argv. Trusted controller configuration compiles those fields into a
fixed executable and mandatory command prefix plus validated flags/values.

For example, `google.calendar.list` may compile to `gogcli calendar.list` plus
validated arguments without exposing the executable or prefix publicly.

## Client and SDK terms

### SDK

A usable language distribution containing client behavior, connection
lifecycle, runtime validation, typed errors, cancellation, and conformance
fixtures. A schema-only package is a contract package, not an SDK.

### ToolPortalMcpClient

The portable TypeScript or Python Tool Portal client over standard MCP. It
exposes the Tool Portal Capability API: `list`, `search`, `describe`, and
`call`. Standalone version 1 admits only configured `mcp_provider`
capabilities. Managed-only Tool VM and controller backends are not authority of
this client or its standalone service.

ToolPortalMcpClient does not expose the SSH Sandbox API, PTY, attach, raw
process input, lease control, SSH, controller RPC, or Gateway lifecycle.

### Tool Portal CLI

The `tool-portal` executable shipped by the TypeScript Agent Portal SDK. It is a
thin ToolPortalMcpClient adapter for list/search/describe/call over configured
Streamable HTTP or scoped stdio. It owns argument parsing, protected endpoint/
credential discovery, canonical stdout, safe stderr diagnostics, exit classes,
and interrupt-to-cancellation mapping. It owns no Tool Portal policy or backend
logic and is distinct from a broad CLI allowance capability.

### GatewayRuntimeClient

The protected TypeScript or Python client over the Gateway runtime UDS. It
exposes `.portal` as the Tool Portal Capability API plus `.sandbox` as the
managed SSH Sandbox API for environments, execution, filesystem, processes,
streams, terminals, and attachment. These are projections of one
ToolPortalService, not separate service or connection owners.

GatewayRuntimeClient is the only managed-plugin client. Its richer I/O and
lifecycle surface does not grant authority to choose credentials, leases,
profiles, mounts, controller runners, or recovery actions.

### Surface class

Trusted, authenticated caller provenance that determines which capability
facets are visible and callable. It is derived from an MCP principal/session or
managed-plugin attachment, never from public arguments. ToolPortalService
enforces surface class before catalog visibility, approval, and routing;
adapters only authenticate and translate.

### Trusted invocation context

The out-of-band invocation envelope, never public or model-authored. In managed
mode the framework plugin is the origin authenticator: it derives and validates
the real calling agent from framework-owned callback/routing state. The envelope
separates the ManagedAgentProjection's required stable identity subset,
optional framework-validated requester context, and optional
session/run/tool-call correlation. Gateway runtime trusts the admitted plugin
for callback-origin validation, then validates the principal against the exact
immutable projection cohort and resolves the controller-authored current Tool
VM binding for that agent. Public arguments and correlation fields cannot
select a workspace, Git resource, host path, guest path, profile, mount, or
bearer authority.

### Canonical portal contracts

The transport- and language-neutral capability/catalog request, result, error,
event, approval, artifact, capability, and descriptor schemas shared by
ToolPortalService, ToolPortalMcpClient, GatewayRuntimeClient, and adapters.

TypeScript/Zod is the authored schema source. Generated JSON Schema and shared
fixtures drive Python runtime models and cross-language conformance.

### Portable refinement descriptor

A named machine-readable definition for a shared-schema cross-field rule,
default, canonical normalization, or numeric constraint that plain JSON Schema
cannot preserve. The contract generator emits matching TypeScript and Python
validators and records the refinement identity in generated schemas. Anonymous
shared `.refine`, `.superRefine`, or transforms are forbidden because a generic
JSON Schema export cannot prove semantic parity.

### Canonical sandbox contracts

The shared environment, execution, filesystem, process, stream, attachment,
cancellation, output-bound, and generation-fencing schemas. Shared
identity/error/artifact primitives are imported rather than redeclared. A
Tool VM capability backend may reuse these lower-level sandbox primitives while
retaining Capability API admission and canonical capability results. The SSH
Sandbox API uses these contracts directly. A transport may project only the
subset it can represent honestly.

### Transport projection

An MCP or UDS representation of canonical service operations. A projection may
adapt framing, authentication, progress, streaming, and result encoding. It
adds no catalog, policy, approval, backend-selection, or normalization
authority.

## Protocol and transport terms

### Protocol

The method, message, state, ordering, version, error, cancellation, replay, and
flow-control contract between peers. JSON-RPC 2.0 supplies an envelope; it does
not by itself supply domain lifecycle, idempotency, backpressure, or authority.

### Transport

The byte-carrying mechanism used by a protocol, such as MCP Streamable HTTP,
MCP stdio, a Unix-domain socket, Socket.IO, WebSocket, or SSH. Transport choice
does not select Tool Portal policy or controller authority.

### Standalone Tool Portal MCP surface

The portable Tool Portal projection using standard MCP JSON-RPC and MCP
session semantics. Version 1 advertises only `tool_portal_list`,
`tool_portal_search`, `tool_portal_describe`, and `tool_portal_call`.

MCP `structuredContent` carries the canonical result. Text content is a bounded
deterministic rendering. Progress is advisory and never raw output streaming.
It exists only in standalone Tool Portal mode. The `standalone` config branch
explicitly enables the entrypoint and owns its non-`/` route, bearer/HMAC
authentication, credential version, and bounded retirement. The process owns
the configured listener, authentication adapter, projection readiness, and
session drain around one ToolPortalService instance. Managed Gateway mode has no
Tool Portal MCP surface.

### Private UDS surface

The Gateway-local protected JSON-RPC surface used by GatewayRuntimeClient. Its
fixed socket lives at `/run/agent-vm/gateway-runtime/managed-plugin.sock` below
the Tool-Portal-service-owned mode-`0700` directory and is not exposed through ingress,
Tool VM mounts, or persistent state. It binds one current managed-plugin
attachment and exposes the Capability API plus managed SSH Sandbox API. UDS
carries requests and results; it never transfers ToolPortalService's raw SSH
connection or connection ownership to the gateway framework.

The Tool Portal service, the managed framework, its plugin, and any
operation-scoped transport helper are trusted together inside the Gateway VM.
The mandatory handshake binds
protocol/schema version, Gateway/runtime/framework epochs, client kind,
the exact ManagedAgentProjection cohort digest, and attachment generation; the
server derives surface and operation authority from current state. Duplicate,
stale, wrong-kind, and wrong-projection-cohort attachments fail closed.

Version 1 uses bounded JSON-RPC messages for control, metadata, stdout, stderr,
stdin, and bounded binary chunks and follows the source/chunk/buffer invariant
owned by spec requirement R25b. A successful socket write is not delivery
acknowledgement. A global client read pause has a bounded deadline.
Local cancel/close or deadline enters discard-draining and resumes parsing
without awaiting a remote acknowledgement. One shared attachment may temporarily
cause head-of-line delay for unrelated agents/profiles only within the configured pause
deadline and latency ceiling. This is the sole version-1 cross-agent progress
exception: it never changes another agent's authority, binding, SSH connection,
registries, handles, retirement, routing, or failure state; never blocks the
separate control plane; and cannot become unbounded availability coupling.
Non-retryable handshake rejection terminates attachment retry and leaves the
framework terminal-fatal/unready or exited until whole-VM replacement. The
protocol has no large per-client output queue and no custom binary subprotocol
in version 1. Large outputs use bounded artifacts or explicit truncation.

### Gateway VM trust boundary

The isolation boundary around the Tool Portal service hosting Gateway runtime,
OpenClaw/Hermes, the managed plugin, and any operation-scoped transport helper.
Those components form one trusted in-VM subsystem and share one guest-root
service principal, UID/GID `0`. Separate
sibling processes do not create an OS security boundary. The design does
not claim protection against one trusted component inspecting or impersonating
another inside the VM. VM isolation protects the controller host and keeps
model/Tool-VM code outside this trust domain; private UDS lifecycle fencing and
strict schemas protect correctness and boundedness, not an additional in-VM
security perimeter.

### Gateway control plane

The bounded authenticated Socket.IO protocol between the controller and one
managed ToolPortalService implemented by Gateway runtime. The controller
initiates the physical connection; ToolPortalService owns the accepted logical
relationship. It carries attachment, per-agent binding and SSH access grants,
connection status, lease, active-use, runner admission,
cancellation, recovery commands, bounded state transitions, and final result
metadata.

It never carries bulk terminal output, file bytes, MCP payloads, logs, traces,
metrics, or OTLP.

### Control admission class

The server-derived scheduling class for one control operation: `safety`,
`authority`, `liveness`, or `diagnostic`. Each class has independent bounded
capacity and an explicit saturation disposition. A sender cannot select its
class. Bulk execution bytes and telemetry never enter control-admission queues.

### Controller execution data connection

The dedicated authenticated full-duplex Tool-Portal-service/controller connection for
controller-owned runner or host-action stdout, stderr, bounded stdin,
file/artifact bytes, EOF, and stream sequencing. It is physically separate from
the Gateway control plane and telemetry plane. The controller initiates it to an
explicit private non-`/` Tool Portal service URL route. Its authentication,
audience, queues, accounting, codec work, and scheduling are independent from
public MCP, Socket.IO control, and OTLP.

### Controller execution stream

One operation- and channel-specific logical byte sequence carried by the
controller execution data connection. End-to-end producer backpressure keeps
every buffering layer bounded: the next chunk is not read until downstream
capacity exists. Exact implementation may use stream pause/drain or explicit
credits; a second socket without bounded producer backpressure does not satisfy
this contract.

The controller execution data connection carries bytes for controller-owned
runners and host actions only. Persistent Tool VM command/file/process bytes
remain on the direct Tool VM SSH data path.

### Tool VM SSH data path

The direct strict-pinned SSH path owned by ToolPortalService inside the Tool
Portal service process to the caller's current Tool VM. Command, filesystem,
process, stream, and terminal bytes bypass the controller. Controller authority
publishes the exact agent-specific Tool VM binding and SSH access grant;
ToolPortalService proactively establishes, pins, monitors, and uses the
corresponding connection.

Tool VM outbound Git SSH is a separate read-only egress capability. It permits
`git-upload-pack` for fetch/clone/pull and rejects `git-receive-pack`. Remote
workspace push uses only `workspace_git_push` through the controller-owned host
action. This does not change the direct Gateway-to-Tool-VM SSH data path.

### Agent Tool VM connection

One ToolPortalService-owned maintained SSH connection for one configured
`agentId` and its exact stable principal, assignment revision, Gateway epoch,
Tool VM binding and generation, and pinned SSH server identity. A Capability API
backend and direct SSH Sandbox API operation may share it only for that same
agent and generation. It is never global, profile-only, UDS-connection-scoped,
transferable to a gateway framework, or reusable across agents or replacements.

ToolPortalService begins connecting immediately after the controller publishes
the binding/access grant. Proactive connection establishment does not create an
unrequested Tool VM or binding and does not count as active use.

### Agent Tool VM connection status

The bounded per-agent state record ToolPortalService reports over its existing
controller relationship: `unbound`, `connecting`, `ready`, `reconnecting`,
`degraded`, or `retired`, plus typed reason, binding/generation identity, and
freshness. Only `ready` admits new Tool VM work. Another agent's status cannot
satisfy or suppress this record.

### Telemetry plane

OTLP metrics, traces, and logs plus bounded local diagnostic evidence. The Tool
Portal service and selected framework are distinct producers using the same
mediated collector/sink and sanitization policy, distinct fixed service
resources, and independently bounded exporter queues. Trusted bounded W3C trace
context may cross UDS outside public arguments; it is never authority or a
metric label. The fixed service resources provide controller-configured
diagnostic attribution, not cryptographic or OS-principal isolation between the
trusted siblings. A trusted sibling can emit misleading telemetry; source
suppression, bounded exporters, collector scrubbing, and positive stored markers
constrain and expose that risk. Telemetry is not lifecycle authority and cannot
block, mutate, or share queues with control or execution streaming. Routine
successful heartbeat evidence is aggregated.

### Sibling fatal observation

Non-supervisory evidence that one managed sibling can no longer satisfy the
Gateway contract. Tool Portal service loss appears as authority-bearing control
session loss. Framework exit or disconnect appears as current UDS attachment
loss reported over control while Tool Portal remains live. Framework hang
appears as expiry of its native readiness or request-liveness deadline. Before
readiness, early boot failure appears as a readiness join that never succeeds.
These observations trigger controller-owned whole-VM recovery; they grant no
launch, signal, restart, supervision, adoption, or guest-PID authority.

## VM and execution terms

### Gateway VM

The managed isolation boundary containing one Tool Portal service process and
exactly one trusted OpenClaw-or-Hermes framework service process. Gateway
runtime, framework, plugin, and any operation-scoped transport helper are one
trusted in-VM subsystem. The two services are siblings; neither owns the other's lifecycle.
The VM is the atomic recovery and security-reset unit.

### Tool VM

One disposable untrusted VM instance controller-owned as a descendant of one
exact Gateway epoch and compatible ManagedAgentProjection. It is reached by
direct strict SSH and may run arbitrary agent-controlled shell/code inside its
isolation boundary. Its managed filesystem contract is:

```text
/workspace   one selected filtered durable agent workspace
/work        writable rootfs/COW hot work for this VM lifetime
/gitdirs     optional writable /gitdirs/workspace.git only
/agent-vm    reviewed read-only generated inputs
/tmp         guest tmpfs
```

It receives no sibling workspace or Git database, whole `/zone`, `stateDir`,
`controllerStateDir`, complete framework home, credential store, runtime
parent, cache parent, backup directory, or raw host path.

A Tool VM is not a controller-owned runner.

### Persistent sandbox state

The selected durable agent workspace and optional workspace Git database that
may be projected into a successor Tool VM. Persistence does not
include `/work`, `/tmp`, rootfs, installed packages, build products, processes,
PIDs, sockets, SSH keys, leases, generations, or uncommitted hot-work content.

### Persistent sandbox

The product behavior that operates on persistent sandbox state through a
disposable current Tool VM. A trusted-image successor may boot while exact
predecessor termination proceeds, but it receives no tool request and performs
no persistent write until the predecessor's exact process is proven absent. The
product does not promise VM, process, hot-work, or uncommitted-worktree
continuity.

### Controller-owned execution

The umbrella for execution whose executable plan, credentials, cwd,
environment, egress, output, artifacts, cancellation, and target are recomputed
and authorized by the controller. Its target is either a controller-owned
runner or a host action.

### Controller-owned runner

An operation-scoped ephemeral ManagedVm execution environment created for
controller-owned execution and parented durably by controller epoch,
originating Gateway epoch, principal, and operation. Its reservation, VM/process
identity, command, and generation are recorded before protected dispatch. It has
no agent SSH, is never adopted or automatically replaced, and is positively
contained on retirement, restart, cancellation, or cleanup. Unproven
containment is owner-unsafe and leaves the outcome ambiguous.

### Host action

A controller-owned operation executed on the trusted controller host. A
configured CLI-prefix host action may admit a validated caller argv tail, but
the executable, prefix, OS context, credentials, environment, cwd, and
cancellation policy remain trusted controller configuration.

### ManagedVm

The backend-neutral controller-side VM behavior contract. Gondolin is the
shipping adapter, not the domain type. Managed plugins and Python clients never
receive ManagedVm.

### Managed VM substrate

The retained backend-neutral package boundary formed by
`gateway-lifecycle -> managed-vm <- gondolin-vm-adapter`. Gateway and Tool VM
controller domains consume narrow structural capabilities; only
`composition/gondolin-managed-vm-provider.ts` and
`build/gondolin-managed-vm-build-tooling.ts` may import the concrete adapter,
and only the adapter may import the Gondolin SDK. Compatibility aliases, native
handles, general VM filesystem escape hatches, and aggregate provider imports
in controller domains are forbidden.

### OwnedHostDirectory

The single-use backend-neutral capability representing one
controller-validated, canonical, pinned host directory selected for VM
construction. Separate owned capabilities represent the workspace source and
optional workspace Git database. A capability is descriptive identity plus custody,
never a raw caller-authorized path.

It is revalidated immediately before transfer, transferred exactly once, and
closed on every failed construction or teardown path. Fresh successor
capabilities may be acquired, revalidated, transferred, and used for
non-routable successor boot while predecessor termination proceeds. Persistent
reads, writes, materialization, tool admission, and current-route publication
through those capabilities wait until the controller has produced the
exact-process and access-containment receipt.

## Authority and lifecycle terms

### Authority

The right to decide or perform a protected action. The controller is the sole
durable authority for VM ownership, paths, profiles, credentials, leases,
active uses, controller approval-record validity, execution-fingerprint
freshness, execution admission, generations, and recovery.

### Controller state directory

The required top-level `system.jsonc` path for one controller deployment. It has
no default and resolves relative to the system config file like `cacheDir` and
`runtimeDir` before canonical disjointness validation. It stores per-Gateway records beneath
`zones/<zoneId>/`, including approval records, the Gateway runtime record,
Tool VM lease records, and controller-owned Worker task Gateway records where
applicable. It is canonically disjoint from every VM mount source, is never
mounted into a Gateway or Tool VM, and is not the process-lifetime controller
ownership lock under `runtimeDir`.

### Gateway state directory

The configured per-zone `stateDir` whose existing framework-visible relative
paths remain stable and may be mounted read-write into the selected Gateway VM.
It contains Gateway/framework persistence, not controller approval, Gateway
runtime, Tool VM lease, or controller-owned Worker task Gateway records. The
controller-state hard cut does not add a framework wrapper or rename existing
Gateway paths.

### Custody

Temporary possession and use of current-epoch sensitive material after an
authority decision. ToolPortalService, using Gateway runtime implementation
mechanics, may have custody of SSH material, upstream-provider credentials,
operation handles, artifacts, and stream state without becoming their authority
source.

### Managed-plugin attachment

A private-UDS, lifecycle-fenced binding between one managed-plugin process epoch
and one Tool Portal service/runtime scope. Attachment identity comes from current runtime
state and a strict epoch/generation handshake, not model-authored request fields
or filesystem path segments. Only one current connection may own an attachment generation;
retirement invalidates its requests and handles.

### Controller epoch

One controller authority-process lifetime. A controller restart creates a new
epoch and never adopts predecessor Gateway or Tool VM authority.

### Gateway control connection

One physical Socket.IO connection between controller and the Tool Portal service
hosting Gateway runtime. It
may change during reconnect without creating a new Gateway epoch.

### Gateway control session

One controller-admitted logical control relationship fenced by controller,
Gateway, Tool Portal service, framework service, and accepted control-attachment identities.
A connection is not a session, and a reconnect cannot cross an invalid epoch.

### Framework service epoch

One admitted OpenClaw or Hermes sibling-process lifetime inside a Gateway epoch.
It is selected and materialized before sibling startup and is not derived from
parentage. Its death is Gateway-fatal under the atomic recovery model.

### Control attachment generation

One monotonically admitted controller/Gateway control-session attachment. It
changes when the control protocol accepts a replacement attachment and is
distinct from a managed-plugin attachment generation.

### Managed-plugin attachment generation

One admitted managed-plugin process attachment to the Gateway runtime. A
transport reconnect for the same still-valid process does not silently create
new process authority; process replacement creates a new generation.

### Gateway epoch

One controller-admitted Gateway VM authority lifetime. It is the fencing and
subtree-membership scope for one Tool Portal service identity, one framework
service identity, and all attachment generations, Tool VMs, leases, processes,
streams, and handles.

### Runtime epoch

One Tool Portal service process lifetime hosting Gateway runtime within a Gateway
epoch. The term is retained for the existing protocol field and never implies
that this process parents the framework service. Runtime loss causes Gateway VM
replacement rather than authority transfer to a same-VM successor.

### Tool VM generation

One controller-authorized Tool VM and exact SSH server identity lifetime.
Replacement creates a new generation and retires every old process, stream,
SSH, and filesystem-session handle.

### Lease

Controller-owned authority binding one compatible ManagedAgentProjection to
one current Tool VM generation, the selected workspace capability and exact
directory identity, the optional workspace Git capability and exact directory
identity, and one agent-specific SSH access grant. A lease ID is correlation, not
sufficient authority.

### Active use

Controller-visible evidence that one admitted operation or operation group is
currently using a lease. Active use protects legitimate work from idle reap and
has bounded heartbeat, ambiguity, terminal, and cleanup semantics. It is not an
operation result, handle, idempotency key, or transport request identity.
An established or healthy idle Agent Tool VM connection is not active use and
does not prevent idle reap.

### Portal request

One ToolPortalService `list`, `search`, `describe`, or `call` invocation. A
request may contain multiple items; its request ID is correlation only.

### Capability call

One `{ namespace, name, arguments }` item within a portal call request. It
produces one canonical item result and may cause an execution operation.

### Approval challenge

A bounded request created after ToolPortalService decides that the exact
principal, surface, capability, canonical arguments, revisions, and
execution/artifact fingerprint require human approval. Managed mode persists it
through the controller; standalone mode returns the exact digest required for a
Tool-Portal-audience per-agent HMAC. Its identifier is correlation only and
cannot authorize dispatch.

### Approval decision

In managed mode, an authenticated operator's approve or deny response recorded
through the protected controller approval port with approver identity,
provenance, expiry, revocation state, and the exact challenge fingerprint.
Surface adapters may render the challenge but cannot create this decision.

### Standalone approval token

An expiring, replay-protected HMAC over one configured standalone Tool Portal
agent and the exact ordered protected-call digests. The runtime consumes its
token ID before dispatch. It cannot be used for another agent, audience,
arguments, namespace/tool, or credential version and is not accepted in managed
mode or by standalone MCP Portal.

### Dispatch grant

The one-use authority produced only after atomic validation and consumption of
the mode-specific approval proof. It is bound to one exact operation and backend
dispatch. Reuse, changed fingerprint, cross-principal/surface use, expiry,
revocation, wrong audience, and stale generations fail. For controller-owned
execution, consumption and dispatch are ordered by the controller's durable
state machine.

### Execution operation

One admitted backend-work lifecycle caused by a Capability API call or SSH
Sandbox API request. It may outlive the initiating portal or JSON-RPC request.

### Control operation

One bounded Gateway control-plane command. It is not a public capability call
or execution operation.

### Operation group

One controller-visible active-use owner for a foreground operation and its
authorized re-entrant child operations. Hermes non-local `execute_code` uses an
operation group so polling/nested file operations do not create conflicting
independent active uses.

### Operation handle

An opaque, scoped, generation-bound identifier for querying or controlling
accepted work. It is not a JSON-RPC request ID, MCP request ID, bearer token,
lease ID, or OS PID.

### Environment handle

An opaque managed-plugin-attachment- and Tool-VM-generation-bound reference to
the current persistent sandbox environment. It is never a lease ID, SSH
endpoint, or authority token.

### Process handle

An opaque operation handle for a background process in one Tool VM generation.
It never exposes or rebinds a raw OS PID.

### Stream handle

An opaque execution-operation- and generation-bound reference to one bounded
byte stream. It is never a socket descriptor or authority token.

### Tool VM binding

The controller-authorized, agent-specific association among one stable managed
principal, assignment revision, current Tool VM generation, storage projection,
lease authority, and exact SSH server identity. ToolPortalService validates and
caches the binding but does not create its authority. A binding is not an SSH
connection, active use, or transferable framework handle.

### Stable managed principal

The identity subset of one ManagedAgentProjection: `agentId`, discriminated
`frameworkIdentity`, `toolPortalProfileId`, and `profileAssignmentRevision`. It
is controller-authored from validated framework origin
and immutable assignment material. Workspace and Git policy are resolved from
trusted agent-keyed configuration into the current Tool VM binding; callers do
not repeat paths or capability identities. Gateway identity and Tool-VM/SSH
generations are separate fences bound to live authority; they are not fields of
the stable principal. Requester identity and session/run/tool-call correlation
may refine audit or approval fingerprints when present, but a correlation
change alone does not retire a live handle for the same still-authorized
principal and generations.

### Current Tool VM leaf

The one Tool VM generation currently routable for an agent under one Gateway
identity. Routing is keyed by Gateway plus agent identity, while authorization
still requires the complete stable managed principal. A profile-assignment
revision change therefore serializes with the same agent's current transition
instead of creating a second independently current leaf.

### Retiring Tool VM leaf

A physically existing predecessor that has permanently lost current routing and
new-operation authority. Zero or more retiring leaves may coexist with one
current leaf. Each retains generation-specific cleanup authority until its
provider, port, runtime-record, and ancillary cleanup are complete.

### Exact-process and access-containment receipt

Controller-owned positive proof required before a booting successor Tool VM may
receive a tool request, perform persistent writes, or become current. The receipt
proves that new Tool SSH admission and old generation-bound handles are fenced
and that the exact recorded predecessor runner identity has been terminated and
observed absent. Exact process absence is the persistent-write fence because no
predecessor guest execution remains to use SSH, VFS, mediated network, or the
selected workspace/Git mounts. This is evidence from the existing lease and
exact-process termination path, not a separate service or generic I/O-fencing
system.

`ManagedVm.close()` completion, health loss, lease-retirement start,
capability-object closure, elapsed time, or telemetry alone is not this receipt.
Listener, provider, owned-transfer, port, runtime-record, and telemetry disposal
are cleanup after exact process absence; they are not additional successor-
admission gates. If exact identity or process absence cannot be proven, the
controller preserves the durable record, keeps the booting successor
non-routable, and creates no second successor.

### Post-containment cleanup debt

Retryable bookkeeping after the exact-process and access-containment receipt,
such as listener/provider/owned-transfer close, port reservation release,
ancillary artifact cleanup, telemetry finalization, or runtime-record deletion.
The predecessor process is already absent and its generation is unroutable, so
this bookkeeping cannot restore its write authority. It stays attributed to the
retiring generation and does not revoke the current successor.

### Fencing

Making prior authority, credentials, bindings, sessions, and handles unusable
before successor work is admitted. For a Tool VM leaf, authority fencing stops
new routing immediately and the exact-process and access-containment receipt
positively proves the predecessor process is absent before successor tool work,
persistent writes, or routing. A non-routable trusted-image successor may boot
during that exact-target termination. Physical bookkeeping cleanup may finish
later, but successor admission never depends on a logical flag or timer expiry
alone.

### Ambiguous outcome

A terminal classification used when execution may have reached a protected
side-effect boundary but completion or cancellation cannot be proven. An
ambiguous mutation is fenced and never automatically replayed.

### Operation outcome

The canonical discriminated terminal classification for an execution operation:

- `not-dispatched`: protected work provably never began;
- `completed`: the executor returned a proven `succeeded` or `failed` terminal
  result;
- `cancelled-proven` or `timed-out-proven`: termination is proven, but prior
  side effects may exist;
- `replaced-proven`: containment proves the old generation can no longer
  execute, but prior side effects may exist;
- `ambiguous`: side effects or termination cannot be proven.

Canonical Capability API and SSH Sandbox API results preserve this discriminant,
termination certainty, prior-side-effect meaning, retry class, owning
generation, and operation identity rather than flattening them into a transport
error. `running` and `cancellation-pending` are non-terminal operation-control
states, not terminal outcomes.

### Retry class

The canonical limit on a new execution attempt: `safe-before-dispatch`,
`policy-gated`, `manual-only`, or `forbidden`. An implementation or policy may
be stricter, never weaker. Ambiguous work is always forbidden from automatic
replay. Looking up the retained result for the same operation is not a retry.

### Atomic Gateway recovery

Fenced retirement and replacement of the complete Gateway authority subtree:
Tool Portal service process, selected framework service process, managed-plugin
attachments, control session, credentials, Tool VMs, leases, and live handles.
Successor admission requires positive predecessor quiescence; cached SSH custody
and old Tool VMs must no longer be able to mutate selected persistent workspace
or Git capabilities.

### Independent Tool VM replacement

Replacement of one failed Tool VM/SSH leaf while preserving the healthy
Tool Portal service, framework service, and ToolPortalService. Persistent
sandbox state may remain; old live process, stream, SSH, and VM state does not.
The old generation is removed from routing and every old generation-bound
handle is invalidated. In parallel, the controller starts exact-target
predecessor termination and boots one non-routable successor from the configured
trusted image with fresh owned `/workspace` and optional
`/gitdirs/workspace.git` capabilities. After the exact-process and
access-containment receipt, it admits persistent writes and routes the successor.
It performs no automatic project-worktree reconstruction and never checkpoints
or resumes the unhealthy predecessor. Uncommitted `/work` content is not
recovered. Post-containment bookkeeping cleanup continues asynchronously without
revoking the current successor.

## Result and observability terms

### Canonical result

The transport-neutral Tool Portal result containing per-call identity,
ordering, success/error status, structured value, artifacts, truncation,
diagnostics, safe audit correlation, and—when backend work is admitted—operation
identity, owning generation, operation outcome, certainty, prior-side-effect
meaning, and retry class. MCP, CLI, and UDS capability projections preserve this
meaning and reject illegal cross-field combinations. MCP `isError`, deterministic
text, and CLI exit status derive from this envelope.

### Artifact reference

A safe bounded reference to output stored outside the model-visible result. It
contains no host path, credential, raw lease, SSH material, or authority.

### Authenticated artifact store

The bounded Gateway-epoch-local store for artifact bytes referenced by canonical
results. It enforces byte, item, range, and lifetime limits; epoch retirement
deletes or invalidates its contents. Storage identifiers and paths never cross
the client boundary.

### Artifact readback

The authenticated bounded retrieval operation exposed through MCP resources and
SDK `artifacts.read`. Every read reauthorizes principal, surface,
agent/profile/subject, capability, operation/generation, artifact fingerprint,
expiry, and requested range. An artifact ID is correlation only, not bearer
authority.

### Progress event

A small, bounded, rate-limited, advisory update. It may be dropped or
coalesced and is never required to determine terminal state. Progress is not a
sandbox byte stream.

### Health vector

Independent health state for the Gateway VM, Tool Portal service process,
selected framework service process, framework-native service,
ToolPortalService Capability API/catalog, exact ManagedAgentProjection cohort,
MCP provider plane, control session, lease authority, per-agent Tool VM binding,
per-agent Agent Tool VM connection, Tool VM, active use, execution stream, UDS
admission, Tool Portal telemetry producer, and framework telemetry producer.
Standalone listener/session health is a separate non-Gateway vector. A green
plane or one healthy agent cannot erase another plane or agent's failure.

### Health observation

Time-bounded evidence about one health-vector plane. It is advisory unless its
owner is the authority source for the observed transition.

### Liveness

Evidence that a component or process responds. Liveness does not imply that
its authority-bearing relationships are usable.

### Framework-native request-liveness

A current-epoch event-loop/request round trip through the selected framework's
native dispatch and adapter-origin path without invoking an LLM or upstream
provider. It detects a hung-but-connected framework. A process, bound port, or
UDS attachment alone is not this evidence.

### Readiness

The controller-derived decision that new work may be admitted. Readiness is
computed from the health vector and cannot be inferred from one green plane.

### Reconnect

Restoration of a transport connection within the same still-valid epochs and
session authority. Reconnect does not replace a VM or transfer authority.

### Gateway-fatal failure

Loss of the Gateway VM, Tool Portal service process, or selected framework
service process, or exhaustion of bounded control/UDS recovery defined by the
state machine. Either process loss is immediately Gateway-fatal and permits no
same-VM service restart. After bounded grace,
sustained authority-bearing control-session death is sufficient even while
unrelated service ingress remains live.

### Recovery decision

The controller-owned selection of atomic Gateway recovery, independent Tool VM
replacement, or operator-required fencing. A healthy observation in one plane
cannot veto a proven fatal failure in another.

## Naming rules

- Use `Tool Portal` for the product/semantic system and `ToolPortalService` for
  its one application-service owner. Use `Capability API` for named
  `list/search/describe/call` admission and `SSH Sandbox API` for direct managed
  environment/exec/filesystem/process/stream/terminal requests. Execution in a
  Tool VM does not make the two request surfaces equivalent.
- Use `MCP Portal` only for the upstream MCP-provider product.
- Use `Gateway runtime` for the Gateway-local infrastructure implementation
  hosted by the Tool Portal service process; never use it for a process parent,
  supervisor, controller, or the OpenClaw/Hermes process.
- Use `gateway framework` for the selected OpenClaw or Hermes runtime and thin
  managed adapter; never call either one Gateway runtime.
- Use `Tool Portal service process` for the common sibling process and
  `ToolPortalService` for its transport-neutral application object.
- Use `Agent Tool VM connection` for ToolPortalService's exclusive maintained
  SSH connection for one exact agent binding/generation. Never use a global,
  profile-only, client-connection, or framework-wide SSH connection term.
- Use `standalone Tool Portal service process` for the non-Gateway host with
  explicitly configured MCP/HTTP/stdio entrypoints; never call those managed
  Gateway ingress.
- Use `stable managed principal`, `requester context`, and `correlation`
  separately; never call a session identifier lease/process authority.
- Use `ManagedAgentProjection` for the complete controller-authored assignment,
  `frameworkIdentity` for native OpenClaw-agent/Hermes-profile identity, and
  `toolPortalProfileId` for Tool Portal policy. Never use bare `profileId` when
  Hermes framework identity and Tool Portal policy can both be meant.
- Use `agent workspace` for the canonical durable
  `<zoneFilesDir>/agents/<agentId>/` tree and `workspace projection` for its
  controller-filtered Tool VM view at `/workspace`. Use `hot work` for
  VM-lifetime rootfs/COW `/work`. Never call `/work` durable, RealFS-backed, or
  a mount.
- Use `workspace Git database` for the optional `/gitdirs/workspace.git`. Use
  `workspaceGit` for the strict optional per-agent configuration and
  `workspace_git_push` for its controller-owned remote push path; never use
  whole-zone Git as current authority.
- Use `OpenClaw managed SandboxBackend` and `Hermes managed BaseEnvironment`
  for the framework-native adapters over one GatewayRuntimeClient. Any
  buildExecSpec helper is transport only, never a service or authority.
- Use `Managed Gateway Boot Contract` for the image-owned exact-two-role startup
  rule; it is never called a service process, controller launcher, or supervisor.
- Use `framework service process` for the selected OpenClaw/Hermes sibling and
  `framework service boot entry` for its image-owned startup material; never use
  `framework child`, `child recipe`, or controller-launched service.
- Use `Tool VM` only for the disposable current sandbox VM. Use `persistent
  sandbox state` only for the selected durable workspace and Git capabilities;
  `/work` is explicitly excluded.
- Use `exact-process and access-containment receipt` for the positive proof
  required before persistent capability reuse. `ManagedVm.close()`, health
  loss, retirement start, and elapsed time are not synonyms.
- Use `/zone` only for the framework-native OpenClaw Gateway view and
  `HERMES_HOME` only for Hermes Gateway framework state. Neither is a Tool VM
  mount.
- Worker `/work/repos` and `/state` remain Worker-specific vocabulary and do
  not imply the managed long-lived-agent workspace contract.
- Use `controller-owned execution` as the umbrella, `controller-owned runner`
  only for ephemeral ManagedVm execution, and `host action` only for trusted
  host execution.
- Use `capability` for `{ namespace, name }`; use `tool` for an adapter's
  model/client registration.
- Use `control plane`, `execution stream`, `Tool VM SSH data path`, and
  `telemetry plane` distinctly.
- Use `protocol` for message/state guarantees and `transport` for byte
  carriage.
- Use `operation handle` or `process handle`, never `PID`, when discussing
  public or cross-process identity.
- Use `Tool VM capability` for a named Capability API backend that executes in
  the Tool VM, and `SSH Sandbox operation` for direct managed work admitted
  through `GatewayRuntimeClient.sandbox`.
- Qualify `capability binding`, `Tool VM binding`, `control attachment
  generation`, and `managed-plugin attachment generation`; never use bare
  `binding`, `attachment`, or `generation` when more than one meaning is
  possible.
