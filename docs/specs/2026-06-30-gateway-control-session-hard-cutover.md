# Gateway Control Session Hard Cutover

Status: revised draft after fresh review
Date: 2026-06-30
Scope: managed gateway control planes, Tool Portal backend taxonomy,
controller-owned control RPC, Tool VM SSH exception

Related specs:

```text
docs/specs/2026-07-01-socketio-control-protocol-semantics.md
  Defines the shared Socket.IO-over-WebSocket transport, Zod v4 envelope,
  identity/fencing fields, delivery classes, reconnect/resync rules,
  backpressure rules, and proof expectations for gateway_control_rpc and
  worker_control_rpc.
```

## Product Intent

Managed gateway VMs should stop depending on gateway-to-controller raw TCP
control calls. This applies to OpenClaw Gateway, Agent Worker Gateway, and
future managed gateway modes. The controller must own gateway lifecycle, lease
mutation, task control, health, recovery, approval, and credential custody
through controller-initiated private control sessions over Gondolin ingress
WebSocket upgrade.

The cutover preserves the existing Tool VM SSH data plane for broad sandbox
execution. It does not turn the controller into a command stdout/stderr proxy
and does not replace the OpenClaw filesystem bridge.

Success means an operator can distinguish these failures without reading code:

```text
gateway infrastructure failure
OpenClaw service/readiness failure
plugin/control-service readiness failure
gateway control session failure
gateway control RPC operation failure
Worker task session failure
Worker task RPC operation failure
Tool VM lease/use failure
Tool VM SSH/data-plane failure
provider/channel runtime failure
```

## Current-State Evidence

Current managed gateway VMs materialize raw TCP mappings that let guests call
host/controller services. This spec is a hard cutover away from using those
mappings for controller control. The inventory matters because
"remove gateway-to-controller raw TCP" is not only OpenClaw lease control; Agent
Worker controller-tools use the same callback shape, and OpenClaw also has
provider bypass and observability mappings in today's generated VM specs.

```text
gateway VM -> controller
  controller.vm.host:18800 -> 127.0.0.1:<controller-port>
  Used by lease create, lease renew, active-use start, active-use heartbeat,
  active-use end, runtime status publish, health-event publish, and
  gateway-control-link probes.

worker VM -> controller
  controller.vm.host:18800 -> 127.0.0.1:<controller-port>
  Used by Agent Worker controller tools such as push-branches and pull-default.
  This is the same forbidden raw controller callback shape as managed OpenClaw
  control, even though the domain operations are Worker task operations instead
  of Tool VM lease operations.

gateway VM -> Tool VM SSH
  tool-<slot>.vm.host:22 -> 127.0.0.1:<tcpPool slot port>
  Used by command execution, file bridge operations, finalize, and cached
  lease probes.

OpenClaw gateway VM -> configured websocket bypass hosts
  zone.websocketBypass entries -> same host:port
  Used as raw TCP passthrough for provider/channel runtime paths.
  On branches rebased after the native WebSocket upgrade work, the adjacent
  config name may be `websocketUpgrades`; this spec is concerned with raw
  tcpHosts passthrough regression, not the spelling of the old field.

OpenClaw gateway VM -> observability collector
  configured collector grpc/http host:port -> target collector host:port
  Used for telemetry export when zone observability mode is collector.
```

The hard-cutover disposition is:

```text
controller.vm.host:18800
  remove from every managed gateway VM tcpHosts set. OpenClaw Gateway control
  moves to gateway_control_session plus gateway_control_rpc. Agent Worker
  Gateway task/control-tool communication moves to worker_control_session plus
  worker_control_rpc.

tool-<slot>.vm.host:22
  keep as the sole raw TCP exception for sandbox Tool VM SSH/data-plane access.

Gondolin outbound SSH egress (guest git read path)
  Gondolin `ssh` egress with an execPolicy is a separate sanctioned mechanism,
  not a `tcpHosts` mapping, and does not violate the tcpHosts-only invariant.
  It carries git-upload-pack reads to allowlisted upstream hosts and denies
  git-receive-pack and non-git exec. See "Git Access And Push Policy".

zone.websocketBypass / websocketUpgrades raw passthrough regression
  remove raw tcpHosts passthrough from managed OpenClaw gateway specs in this
  cutover. Native WebSocket mediation through Gondolin is allowed only when it
  does not recreate arbitrary gateway raw TCP egress.

observability collector tcpHosts
  remove from managed OpenClaw gateway tcpHosts in this cutover. Telemetry
  export must use an explicit controller/ingress-owned path or a later accepted
  exception spec.
```

The clean failure slice behind this spec is control-plane-before-SSH:

```text
OpenClaw tool call
  -> plugin starts active use
  -> gateway calls controller.vm.host:18800
  -> POST /lease/:leaseId/uses
  -> lease-use-start controller request timeout
  -> SSH/file bridge never starts
```

The cutover replaces the first path. It preserves the second path.

Reliability assumption: guest-to-host raw controller callbacks are the
unreliable establishment path for the incident class, while
controller-to-guest ingress is expected to be healthier because the controller
owns VM lifecycle, readiness probing, and the single session of record. The
cutover must prove this with a flap/soak lane: repeated disconnects during
active use must not extend liveness, must classify each disconnect, must not
wedge recovery, and must preserve Tool VM SSH after resync. If the new session
shows the same establishment failure class, stop and revise the design rather
than shipping a compatibility fallback.

## Definitions

```text
call surface
  A way a caller reaches Tool Portal or agent-vm capabilities:
  OpenClaw plugin, Tool Portal MCP server, CLI, SDK, HTTP API.

Tool Portal core
  Portable capability semantics, public request/result contracts, hooks,
  backend catalog resolution, safe errors, and approval/custody vocabulary.

Tool Portal backend
  A configured authority boundary that handles a portable capability after
  the Tool Portal router resolves { namespace, name }.

gateway control service
  The gateway-side private endpoint that the controller reaches through
  Gondolin ingress. For managed OpenClaw, this is an in-process private
  plugin-hosted route using OpenClaw's upgrade hook. The managed cutover does
  not ship a sidecar gateway-control service. Future gateway kinds may host the
  equivalent control endpoint in their own runtime, but they must satisfy the
  same private-control contract and JSON Schema wire contract.

gateway control session
  The controller-initiated, authenticated, generation-bound private
  Socket.IO-over-WebSocket control stream between controller and gateway
  control service. The controller connects through Gondolin ingress after
  readiness succeeds; the gateway does not initiate a controller callback.

gateway control RPC
  Strict Zod v4 command/command_result/event messages over a gateway control
  session, using the shared control protocol semantics defined by
  `2026-07-01-socketio-control-protocol-semantics.md`. These messages replace
  managed gateway-to-controller raw TCP control calls.

worker control service
  The Agent Worker gateway-side private endpoint that the controller reaches
  through Gondolin ingress. It may share the same implementation substrate as
  the Worker HTTP server, but this cutover uses it for Worker runtime control,
  Worker-originated controller tools, and observations rather than moving the
  existing Worker `/tasks` HTTP task-control surface.

worker control session
  The controller-initiated, authenticated, generation-bound private
  Socket.IO-over-WebSocket control stream between controller and Agent Worker
  gateway. The controller connects through Gondolin ingress after readiness
  succeeds. It replaces Worker VM calls to `controller.vm.host:18800`.

worker control RPC
  Strict Zod v4 command/command_result/event messages over a worker control
  session.
  In this cutover slice, these messages carry Worker-originated controller
  tools such as push-branches and pull-default plus runtime observations,
  cancel, and recovery. Existing Worker task submit/state/close remain
  controller-to-worker ingress HTTP until a later accepted task-control slice.
  Worker control reuses the shared control envelope but does not reuse the
  OpenClaw gateway operation enum.

controller public/operator HTTP API
  Host/operator/test/client-to-controller HTTP routes. This surface remains HTTP
  for controller liveness, operator status, zone administration, logs,
  credentials refresh, destroy/upgrade/enable-ssh/execute-command, and read-only
  health/status inspection. It is not the gateway heartbeat/control plane.

worker task HTTP API
  Worker-mode host/operator/client-to-controller routes for submitting and
  inspecting Agent Worker tasks. These routes remain host-facing controller
  APIs. They are not a VM-to-controller callback surface, and the Agent Worker
  gateway must not call them through `controller.vm.host:18800`.

OpenClaw operator HTTP API
  Host/operator/client-to-controller routes for OpenClaw zone administration and
  observation. These routes can probe gateway health through controller-owned
  checks, but the gateway does not publish recurring lease/control state through
  this surface after cutover.

gateway private ingress HTTP
  Controller-to-gateway private HTTP over Gondolin ingress. This surface is only
  for bootstrap liveness/readiness probes and the WebSocket upgrade endpoint,
  such as current OpenClaw service health/readiness, current Worker `/health`,
  and the cutover private Socket.IO upgrade path. It is not used for recurring
  lease mutation, active-use mutation, healthbeat, runtime-status publication,
  or Worker task/control-tool state.

legacy gateway-to-controller HTTP
  The removed managed path where any gateway VM calls `controller.vm.host:18800`.
  Lease create/get/peek/renew/release, active-use start/heartbeat/end,
  gateway health events, runtime status, gateway-control-link probes, Worker
  push-branches, and Worker pull-default move to the relevant control RPC
  domain or controller-owned ingress observation.

Tool VM SSH data plane
  Gateway-to-Tool-VM SSH/raw TCP through `tool-<slot>.vm.host:22`. This remains
  the sandbox_ssh data plane for command execution, file bridge operations,
  finalize, and SSH probes. It is not moved to WebSocket in this spec.

Tool VM runner
  Tool Portal backend for VM-backed work. It can use profiles such as
  sandbox_ssh or controller_rpc, but the backend kind stays tool_vm_runner.

control envelope
  Shared strict message envelope for controller-owned RPC/streaming. Identity,
  fencing, sequencing, delivery policy, and protocol version live only in this
  shared envelope. Domain payloads must not introduce renamed identity twins.

gateway trusted caller context
  Controller-private record that binds a gateway control session to the
  controller-selected agent, profile, workspace, work mount, approval/custody
  scope, and lease reuse keys. Gateway RPC payloads may reference this record by
  opaque id only; they do not carry those authority fields.
```

## Required Boundary Map

```text
Call surfaces / adapters
  owns:
    trusted caller derivation from the runtime
    transport adaptation
    model/public request parsing before Tool Portal
    runtime registration of the Tool Portal public surface
  exposes:
    Tool Portal request envelope
  forbids:
    policy forks
    direct controller authority
    direct MCP Portal model-facing tools in managed OpenClaw
    installing or exposing a separate managed OpenClaw MCP Portal plugin

      │ parsed request + trusted adapter envelope
      ▼

Tool Portal core
  owns:
    portable capability protocol
    catalog-static routing by { namespace, name }
    managed public operation names: tool_portal_*
    public result/error/event vocabulary
    approval and custody semantics
  exposes:
    backend dispatch intent
  forbids:
    Gondolin imports
    OpenClaw imports
    SSH imports
    controller runtime imports
    model-selected backend controls

      │ exactly one backend binding from trusted config
      ▼

Tool Portal backends
  owns:
    backend-specific implementation of Tool Portal hooks
  supported backend kinds:
    mcp_provider
    tool_vm_runner
    controller_host_action
  forbids:
    OpenClaw as a backend kind
    controller_rpc_runner as a catalog backend kind

      │ controller dispatch contract when authority is needed
      ▼

agent-vm controller
  owns:
    gateway_control_session
    trusted config
    lease records and active-use state
    VM lifecycle and generation binding
    approval store
    credential custody
    recovery decisions
    controller RPC execution
  forbids:
    trusting model-visible control fields
    trusting gateway-supplied policy fields
```

Managed OpenClaw does not hide MCP Portal by plugin-side filtering. The
OpenClaw plugin is a call surface that registers Tool Portal's public operation
names. Tool Portal owns the managed public vocabulary, and its public vocabulary
is `tool_portal_*`. If a configured capability resolves to MCP Portal, that is
an internal Tool Portal backend decision; the model still calls Tool Portal.

This backend taxonomy supersedes the earlier Tool Portal composition draft names
`mcp` and `credentialed_runner` for managed OpenClaw. The rename map is:

```text
earlier / shipped vocabulary       hard-cutover vocabulary
─────────────────────────────────  ─────────────────────────────
mcp                                mcp_provider
credentialed_runner                tool_vm_runner or
                                   controller_host_action, based on authority
zone_git_push model tool           tool_portal_call of a Tool Portal
                                   capability backed by controller_host_action
```

The managed model-visible surface is still only `tool_portal_*`. A
controller-owned operation such as zone git push may be a Tool Portal
capability, but its controller authority is selected by trusted configuration,
not by a model-visible backend selector.

## HTTP And WebSocket Surface Split

The cutover does not mean "all controller APIs become WebSocket." It means any
managed gateway VM origin stops using gateway-to-controller HTTP/raw TCP.
Controller public/operator HTTP remains the host-facing API. Gateway private
ingress HTTP remains the controller-to-gateway bootstrap/upgrade surface.
Recurring guest VM control operations move to domain-specific control RPC over
controller-initiated Socket.IO-over-WebSocket sessions. The shared transport,
delivery, identity, reconnect, and backpressure semantics are defined in
`2026-07-01-socketio-control-protocol-semantics.md`; this spec owns the gateway
and worker domain contracts that use those semantics.

```text
┌──────────────────────────────┐
│ host operator / CLI / tests  │
└──────────────┬───────────────┘
               │ HTTP stays HTTP
               ▼
┌──────────────────────────────────────────────────────────────┐
│ agent-vm controller public/operator API                      │
│   global liveness, zone operator health/status/admin,        │
│   Worker task submission/status/close, logs, credentials     │
└──────────────┬───────────────────────────────────────────────┘
               │ controller-to-gateway private ingress HTTP
               ▼
┌──────────────────────────────────────────────────────────────┐
│ gateway private control service / worker control service      │
│   current OpenClaw readiness/liveness probes                  │
│   current Worker /health probe                                │
│   GET /__agent-vm/ready                                       │
│   /__agent-vm/gateway-control -> Gateway WS upgrade           │
│   GET /__agent-vm/worker-ready                                │
│   /__agent-vm/worker-control  -> Worker WS upgrade            │
└──────────────┬───────────────────────────────────────────────┘
               │ gateway_control_rpc or worker_control_rpc over WS
               ▼
┌──────────────────────────────────────────────────────────────┐
│ lease/use control, runtime status, health events, cancel,    │
│ recovery coordination, Worker runtime observations,           │
│ Worker-originated controller tools                            │
└──────────────────────────────────────────────────────────────┘

Separate data plane:

gateway VM ── SSH/raw TCP ──▶ tool-<slot>.vm.host:22 ──▶ Tool VM
```

HTTP route disposition is normative:

```text
surface / route family                         disposition after cutover
─────────────────────────────────────────────  ───────────────────────────────
GET /health                                    stays public/operator HTTP;
                                               global controller liveness only

GET /controller-status                         stays public/operator HTTP

GET /zones/:zoneId/health                      stays public/operator HTTP;
                                               controller probes zone gateway
                                               readiness through owned checks

GET /zones/:zoneId/service-health              stays public/operator HTTP;
                                               controller probes service
                                               liveness through owned checks

GET /zones/:zoneId/health-snapshot             stays public/operator HTTP;
                                               read controller-owned snapshot

GET /zones/:zoneId/logs                        stays public/operator HTTP

POST /zones/:zoneId/credentials/refresh        stays public/operator HTTP

POST /zones/:zoneId/destroy|upgrade|
enable-ssh|execute-command                     stays public/operator HTTP
                                               with existing auth boundaries

POST /zones/:zoneId/worker-tasks               stays host-facing Worker task
                                               HTTP for external callers;
                                               controller continues to reach
                                               Worker /tasks over ingress in
                                               this cutover slice

GET/POST /zones/:zoneId/tasks/:taskId...       stays host-facing Worker task
                                               HTTP for external callers;
                                               Worker /tasks ingress remains
                                               the task-control path until a
                                               later accepted slice

POST /lease and /lease/:leaseId...             removed from managed gateway
                                               callers; equivalent semantics
                                               move to gateway_control_rpc

GET /leases                                    stays host/operator diagnostic
                                               HTTP unless a plan proves there
                                               are no live callers; not usable
                                               by managed gateway VMs

POST /zones/:zoneId/health-events              removed from managed gateway
                                               callers; gateway observations
                                               move to health_event RPC

gateway runtime status publish route           removed from managed gateway
                                               callers; status moves to
                                               runtime_status RPC

gateway GET /health to controller.vm.host      removed as readiness dependency;
                                               replaced by control-session and
                                               control-rpc state

Worker VM push-branches/pull-default calls     removed from Worker VM HTTP
to controller.vm.host                          callers; equivalent semantics
                                               move to worker_control_rpc

POST /zones/:zoneId/zone-git/push              removed from managed OpenClaw
                                               VM HTTP callers; model-visible
                                               zone_git_push is replaced by a
                                               Tool Portal capability backed by
                                               controller_host_action and
                                               transported privately
```

Server-side disposition is normative, not only caller-side. "Removed from
managed gateway callers" is not sufficient: a lease-mutation route that stays
reachable on the controller with no legitimate caller is the shippable fallback
hard cutover forbids, and today's `POST /lease` and `/lease/:leaseId/*` routes
carry no auth guard. For every route marked removed from managed gateway callers
(`POST /lease` and `/lease/:leaseId/*`, `POST /zones/:zoneId/health-events`, the
gateway runtime-status publish route, and `POST /zones/:zoneId/zone-git/push`),
the delivered controller must either delete the HTTP route or gate it behind an
operator auth boundary. It must not remain an unauthenticated VM-reachable
lease/health mutation surface. A residue proof asserts the deleted routes return
404 and any retained route requires operator auth.

`GET /zones/:zoneId/health` is an operator/controller observation route. It asks
the controller to evaluate the zone's configured gateway readiness path and
return what the controller can observe. It is not a gateway heartbeat endpoint.
Additional gateway heartbeat, active-use, lease, provider health, and runtime
status updates must use gateway_control_rpc after cutover.

Worker task HTTP routes remain public/operator controller routes for external
callers and tests. The existing controller-to-worker `/tasks` ingress path also
remains the Worker task-control path for this cutover because it already uses
the healthy controller-to-VM direction. Agent Worker VMs use
`worker_control_rpc` only for Worker-originated controller-owned operations such
as push-branches and pull-default, plus runtime observations, cancellation, and
recovery.

## Backend Taxonomy

Tool Portal backend kind is defined by authority boundary, not by physical
substrate or transport.

```ts
import { z } from "zod/v4";

export const ToolPortalBackendKindSchema = z.enum([
  "mcp_provider",
  "tool_vm_runner",
  "controller_host_action",
]);

export const ToolVmRunnerProfileSchema = z.enum([
  "sandbox_ssh",
  "controller_rpc",
]);

export const ToolPortalBackendBindingSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("mcp_provider"),
    mcpNamespace: z.string().min(1),
    mcpToolName: z.string().min(1),
  }).strict(),
  z.object({
    kind: z.literal("tool_vm_runner"),
    profile: ToolVmRunnerProfileSchema,
    runnerCapabilityId: z.string().min(1),
  }).strict(),
  z.object({
    hostActionId: z.string().min(1),
    kind: z.literal("controller_host_action"),
  }).strict(),
]);
```

`tool_vm_runner.profile = "sandbox_ssh"` preserves the existing broad sandbox
path. The agent/OpenClaw plugin gets broad Tool VM sandbox access after the
controller grants/renews lease and active-use state. Command and file data use
gateway-to-Tool-VM SSH.

`tool_vm_runner.profile = "controller_rpc"` is the controlled VM execution
shape. The controller owns execution, parses strict dispatch intent, recomputes
trusted argv/env/cwd/credential/egress policy, and may use `ManagedVm.exec()`,
`vm.fs`, or a private controlled service. This profile is not required to ship
in the gateway-control cutover slice, but the taxonomy reserves the place
without making `controller_rpc_runner` a model-visible backend kind.

`controller_host_action` remains a narrow controller-owned host operation. If a
future host/Mac service bridge needs stream-shaped RPC, it uses the shared
controller RPC envelope under this backend instead of becoming a separate
catalog backend by default.

## Hard Cutover Invariants

Hard cutover means removal. The delivered managed runtime must have one control
model, not old and new paths in parallel. Compatibility shims, fallback
controller callbacks, hidden `tcpHosts` escape hatches, and "temporary" dual
registration are not conforming implementations.

1. Managed gateway VMs must not use `controller.vm.host:18800` for controller
   control operations after cutover. This includes OpenClaw Gateway, Agent
   Worker Gateway, and future managed gateway modes.

2. The delivered managed gateway VM `tcpHosts` set must contain only
   `tool-<slot>.vm.host:22` entries for Tool VM SSH. Existing
   `controller.vm.host:18800`, raw provider WebSocket passthrough entries, and
   observability collector raw TCP mappings are removed or replaced by
   non-raw-TCP routes in this cutover unless a later spec explicitly accepts a
   named exception. After cutover, managed OpenClaw validation fails when
   `zone.websocketBypass` or a rebased `websocketUpgrades` implementation would
   require raw gateway `tcpHosts`, or when `zone.observability.mode =
   "collector"` would require gateway raw `tcpHosts`, unless an accepted
   replacement or exception spec is present. Gateway boot must fail closed
   rather than silently keeping or ignoring those mappings.

   The delivered managed gateway VM `allowedHosts` must also remove
   `controller.vm.host` for controller control. The controller reaches the VM
   through Gondolin ingress; the VM does not need controller-host egress for the
   control session. A later spec may define a named, non-control exception, but
   this cutover does not allow `allowedHosts` to preserve the old callback
   surface implicitly.

3. The controller initiates and owns the private control session. The gateway
   or worker VM hosts a private Socket.IO endpoint that is reachable only
   through Gondolin ingress. The gateway or worker does not call controller
   authority over raw HTTP/TCP, and the controller does not expose a VM-facing
   Socket.IO control server on `controller.vm.host:18800`.

4. Public/operator controller HTTP routes remain available for host operators,
   controller clients, tests, Worker task APIs, and OpenClaw zone administration.
   They must not be used by any managed gateway VM as a callback path for
   recurring lease, active-use, healthbeat, runtime-status, task-state, or
   controller-tool operations.

5. Gateway private ingress HTTP is limited to controller-initiated liveness,
   readiness, and Socket.IO WebSocket upgrade. Recurring control operations
   after upgrade are domain-specific control RPC frames, not plain HTTP
   requests. Socket.IO polling fallback is forbidden.

6. The gateway control session is private, authenticated, generation-bound, and
   controller-owned. It is not a public OpenClaw route, browser API, model tool,
   or operator command API.

7. Every runtime boundary parses strict Zod v4 schemas before forwarding. Unknown
   fields fail closed. TypeScript Socket.IO event maps are allowed only as
   developer ergonomics; Zod v4 schemas are the runtime authority.

8. Gateway control messages are intents or observations. The controller
   recomputes lease mutation, retryability, recovery, approval freshness,
   credential custody, execution policy, and VM authority from trusted state.

9. Model-visible requests and results must not carry trusted caller fields,
   approval proofs, VM generation, route tokens, raw credential profile ids,
   `hostWorkMountDir`, executable paths, argv/env/cwd, retry policy, egress
   policy, artifact host paths, or control-channel fields.

10. Tool VM SSH remains the data plane for `sandbox_ssh`. The gateway control
   session must not tunnel SSH stdout/stderr, OpenClaw filesystem bridge output,
   or arbitrary Tool VM file contents in this spec.

11. `gateway-control-link` becomes legacy raw-TCP vocabulary. Managed runtime
   status, docs, and tests must use `gateway-control-session` and
   `gateway-control-rpc` for the new control plane.

12. No compatibility mode may keep old gateway-to-controller raw TCP control as
    a co-equal managed path. Integration slices may use temporary test fixtures,
    but the delivered managed runtime must be hard cut over.

13. Every old managed control caller must be deleted, renamed, or rewritten onto
    the accepted control-session path. Plans must not satisfy this spec by
    leaving unused-but-shippable raw controller clients, fallback environment
    variables, old plugin registration names, or old health-loop wiring in the
    delivered managed artifact.

14. Managed OpenClaw uses the Tool Portal OpenClaw plugin surface. The existing
    OpenClaw MCP Portal plugin implementation may be renamed and retrofitted,
    but the delivered managed gateway must not install, register, or document a
    separate `openclaw-mcp-portal-plugin` path or `mcp_portal_*` model-facing
    tool surface. Hard cutover also applies to the managed plugin artifact and
    load path: the final managed gateway must remove or rename
    `openclaw-mcp-portal-plugin` / `@agent-vm/openclaw-mcp-portal-plugin`
    rather than retaining that identity behind `tool_portal_*` tools. This is a
    Tool Portal surface rule, not a plugin-side MCP hiding rule.

Managed OpenClaw residue rules:

```text
surface / artifact                         post-cutover rule
─────────────────────────────────────────  ───────────────────────────────────
model-visible managed tools                allow only tool_portal_list,
                                           tool_portal_search,
                                           tool_portal_describe,
                                           tool_portal_call

managed visibility owner                   Tool Portal owns public operation
                                           names; OpenClaw plugin registers
                                           and adapts them only

managed OpenClaw package/load identity     must be Tool Portal named; old
                                           openclaw-mcp-portal-plugin identity
                                           is removed or renamed

managed OpenClaw prompts/manuals/docs      must teach tool_portal_* only

standalone MCP Portal package/server       may keep mcp_portal_* for consumers
                                           that explicitly choose MCP Portal
                                           outside managed OpenClaw

MCP provider capabilities in Tool Portal    may be backed by MCP Portal
                                           internally, but remain visible only
                                           through tool_portal_* in managed
                                           OpenClaw

Tool Portal MCP call surface               may expose Tool Portal itself over
                                           MCP, but the model-facing operation
                                           names remain tool_portal_*
```

## Gateway Control Session Contract

The controller observes gateway readiness through Gondolin ingress and then
opens the private Socket.IO-over-WebSocket control session. This relies on
Gondolin ingress WebSocket upgrade: the host/controller sends the upgrade
request through the ingress gateway, the VM-private service returns `101
Switching Protocols`, and Gondolin tunnels opaque Socket.IO frames after the
upgrade.

```text
Controller                 Gondolin ingress          Gateway control service
    │                            │                          │
    │ boot gateway VM             │                          │
    │───────────────────────────▶ │                          │
    │                            │                          │
    │ GET OpenClaw /health        │ host -> guest            │
    │───────────────────────────▶ │────────────────────────▶ │
    │◀─────────────────────────── │◀──────────────────────── │
    │                            │                          │
    │ GET current readiness       │ private/control route    │
    │───────────────────────────▶ │────────────────────────▶ │
    │◀─────────────────────────── │◀──────────────────────── │
    │                            │                          │
    │ WS proposed private         │ controller initiated     │
    │ Socket.IO control path      │ websocket only           │
    │═══════════════════════════▶ │════════════════════════▶ │
    │                            │                          │
    │ gateway control RPC: lease, active-use, health, cancel │
    │◀═════════════════════════════════════════════════════▶ │
```

The spec intentionally names the endpoint `gateway control service`, not public
OpenClaw UI or model tooling. Managed OpenClaw hosts it through the
Tool Portal/OpenClaw plugin private route and must prove Socket.IO upgrade,
private authentication, generation binding, WebSocket-only transport, and no
public OpenClaw auth/session leakage.

### Placement And Route Ownership

The private control route names are fixed by the shared control protocol spec:

```text
gateway control readiness     GET /__agent-vm/ready
gateway control path          /__agent-vm/gateway-control

worker control readiness      GET /__agent-vm/worker-ready
worker control path           /__agent-vm/worker-control
```

Existing service probes remain service probes:

```text
OpenClaw /readyz and /health
  controller-observed OpenClaw application readiness and liveness.

Worker /health
  controller-observed Agent Worker process liveness.

Worker /tasks routes
  existing controller-to-worker ingress HTTP task-control path for this cutover;
  the public/operator controller API remains HTTP, and only Worker-originated
  controller-tool callbacks move to worker_control_rpc now.
```

Gateway VM-side ownership:

```text
@agent-vm/openclaw-gateway
  owns VM/process spec construction, Gondolin ingress wiring, and route/port
  exposure.

@agent-vm/openclaw-agent-vm-plugin
  owns the VM-side private OpenClaw gateway Socket.IO server integration in this
  cutover. It uses OpenClaw v2026.6.5's plugin `handleUpgrade(req, socket,
  head)` route hook to feed the Socket.IO engine manually. This version-couples
  managed OpenClaw control to that plugin upgrade API, so the implementation
  must prove the route hook before replacing the old raw controller path.
```

OpenClaw plugin upgrade proof is a cutover prerequisite, not an optional
implementation preference:

```text
route registration
  The managed OpenClaw plugin route contract must expose both the normal HTTP
  readiness handler and an upgrade handler with the Node signature
  handleUpgrade(req, socket, head). The local plugin API shim and tests must be
  updated to the selected OpenClaw v2026.6.5 route shape before planning treats
  the plugin-hosted path as implementable.

Socket.IO integration
  The Socket.IO server runs detached from its own listener. The plugin upgrade
  hook manually hands the accepted upgrade to the Engine.IO/Socket.IO server.
  The control service must not open a second guest port or a separate sidecar
  for managed OpenClaw.

pre-101 auth
  The plugin validates route privacy, domain, generation, controller epoch,
  VM-issued nonce, credential id, controller signature, expiry, and protocol
  version before returning 101. Public OpenClaw route auth, browser cookies,
  model credentials, plugin auth alone, and route ids alone are insufficient.

failure mode
  If the pinned OpenClaw plugin API cannot provide a private
  handleUpgrade-before-101 path, the cutover stops at spec revision. It must not
  silently fall back to a sidecar, `controller.vm.host`, HTTP polling, or raw
  WebSocket/Socket.IO control on another route.
```

Worker VM-side ownership:

```text
@agent-vm/worker-gateway
  owns VM/process spec construction and Gondolin ingress wiring only.

@agent-vm/agent-vm-worker
  owns the VM-side private worker Socket.IO server and is the first Worker-side
  runtime package allowed to import Socket.IO. It may share the existing Node
  process with Worker HTTP routes, but the private control route has separate
  auth, no public/model access, and a separate worker_control_rpc dispatcher.
```

### Session State

```ts
import { z } from "zod/v4";
import { ControlSessionStateSchema } from "@agent-vm/control-protocol-contracts";

// One shared session-state vocabulary for every control domain.
export const GatewayControlSessionStateSchema = ControlSessionStateSchema;

export const GatewayControlSessionIdentitySchema = z.object({
  bootId: z.string().min(1),
  controllerEpoch: z.string().min(1),
  expiresAtMs: z.number().int().positive(),
  generationId: z.string().min(1),
  peerId: z.string().min(1),
  sessionId: z.string().uuid(),
  zoneId: z.string().min(1),
}).strict();

export const GatewayControlSessionStatusSchema = z.object({
  connectedAtMs: z.number().int().positive().optional(),
  identity: GatewayControlSessionIdentitySchema,
  lastErrorClass: z.string().min(1).optional(),
  lastObservedAtMs: z.number().int().positive().optional(),
  reconnectAttempt: z.number().int().nonnegative().optional(),
  state: GatewayControlSessionStateSchema,
}).strict();
```

### Handshake Requirements

The controller-owned handshake credential is a VM nonce plus a controller
signature, not a static bearer secret placed in the VM. The VM control service
has a controller public key or equivalent verifier at boot. Its private
readiness endpoint issues a short-lived connect nonce bound to the domain, zone,
peer id, boot id, controller epoch, protocol version, and VM generation. Route,
runtime-record, and VM identifiers are controller-side issuance inputs that
select the generation/peer being authorized; they are not separate shared
handshake schema fields. The controller signs that nonce and the shared identity
fields before attempting the WebSocket upgrade. `credentialId` is an identifier,
not a bearer secret. The controller signature over the VM-issued nonce and bound
identity fields is the proof. Public OpenClaw auth, browser session cookies,
provider tokens, model credentials, plugin auth alone, route ids alone,
credential ids alone, or operator API tokens must not open a gateway control
session.

```ts
import { z } from "zod/v4";

export const GatewayControlHandshakeCredentialSchema = z.object({
  audience: z.literal("gateway_control"),
  bootId: z.string().min(1),
  controllerEpoch: z.string().min(1),
  credentialId: z.string().uuid(),
  expiresAtMs: z.number().int().positive(),
  generationId: z.string().min(1),
  issuedAtMs: z.number().int().positive(),
  nonce: z.string().min(32),
  peerId: z.string().min(1),
  protocolVersion: z.literal(1),
  zoneId: z.string().min(1),
}).strict();

export const GatewayControlHandshakeProofSchema = z.object({
  audience: z.literal("gateway_control"),
  bootId: z.string().min(1),
  controllerEpoch: z.string().min(1),
  credentialId: z.string().uuid(),
  expiresAtMs: z.number().int().positive(),
  generationId: z.string().min(1),
  issuedAtMs: z.number().int().positive(),
  nonce: z.string().min(32),
  peerId: z.string().min(1),
  protocolVersion: z.literal(1),
  signature: z.string().min(64),
  zoneId: z.string().min(1),
}).strict();

export const GatewayControlWebSocketUpgradeBindingSchema = z.object({
  credentialIdHeader: z.literal("x-agent-vm-control-credential-id"),
  domainHeader: z.literal("x-agent-vm-control-domain"),
  expiresAtHeader: z.literal("x-agent-vm-control-expires-at-ms"),
  issuedAtHeader: z.literal("x-agent-vm-control-issued-at-ms"),
  protocolHeader: z.literal("x-agent-vm-control-protocol"),
  queryCredentialsPresent: z.literal(false),
  signatureHeader: z.literal("x-agent-vm-control-signature"),
}).strict();
```

The handshake must bind at least:

```text
zoneId
generationId
controller epoch
peerId
VM-issued connect nonce
controller signature
session expiry
protocol version
```

Credential use rules:

```text
one-use
  The VM validates and atomically consumes the nonce/signature pair before
  returning `101 Switching Protocols`. A duplicate presentation is rejected and
  cannot evict the incumbent accepted session.

not model visible
  The signature, nonce, credential id, and route credential state never appear
  in Tool Portal request/result payloads, OpenClaw model-visible tools, logs,
  diagnostics, or operator exports.

generation bound
  A credential for an old runtime record, VM id, or route is represented by an
  old peer/generation binding and cannot authenticate a new control session.

route scoped
  The credential is valid only for the private control route and protocol
  version named by the controller.

identifier vs proof
  `credentialId` selects the expected pending nonce/proof record. It is not
  sufficient to authenticate. A request with a valid identifier but no matching
  controller signature fails before 101.
```

The controller initiates the Socket.IO/WebSocket upgrade and presents the proof
only as normalized upgrade headers. Query-string credentials are invalid. The
gateway control service validates the signature against its controller public
key, verifies every identity field, atomically consumes the nonce, and accepts
or rejects the upgrade. Failed attempts do not reveal whether the route id,
credential id, signature, zone, generation, boot id, or controller epoch was
wrong.

Stale generations, duplicate sessions, expired credentials, wrong controller
epoch, wrong zone, wrong route id, wrong protocol version, reused
credentials, and public gateway credentials fail closed.

## Gateway Control RPC Contract

Every frame is strict, versioned, discriminated, and parsed by Zod v4 before
forwarding.

Gateway control RPC rides inside the shared control protocol wire shape:

```text
Socket.IO event: control:message
  envelope: ControlEnvelopeSchema {
    domain: "gateway_control",
    kind: "command" | "command_result" | "event" | ...
    operation: "lease_create" | "health_event" | ...
  }
  payload: GatewayControlRpcMessageSchema
```

The shared `ControlEnvelopeSchema` is the only identity, fencing, sequencing,
and delivery layer. Gateway domain payloads must not carry renamed twins such as
`rpcSessionId`, `schemaVersion`, `sentAtMs`, `controllerInstanceId`, or a second
`zoneId`. Gateway payload schemas define operation payloads and domain
correlation only. The `kind` and `operation` discriminants appear in both the
envelope and the domain message because the domain discriminated union needs
them locally. Both layers use the same `ControlMessageKindSchema` strings —
commands are `"command"`, results are `"command_result"` — and the runtime
rejects any message where `envelope.kind !== message.kind` or
`envelope.operation !== message.operation` by strict string equality. Domain
correlation, session state, result base, and error schemas derive from the
shared `ControlCorrelationSchema`, `ControlSessionStateSchema`,
`ControlRpcResultBaseSchema`, and `ControlRpcErrorSchema` in
`@agent-vm/control-protocol-contracts`; domains extend them and never
redeclare a parallel vocabulary.

```ts
import { z } from "zod/v4";
import { ControlRpcResultBaseSchema } from "@agent-vm/control-protocol-contracts";

export const GatewayControlRpcOperationSchema = z.enum([
  "control_ping",
  "caller_context_register",
  "lease_create",
  "lease_get",
  "lease_peek",
  "lease_renew",
  "lease_release",
  "lease_use_start",
  "lease_use_heartbeat",
  "lease_use_end",
  "health_event",
  "runtime_status",
  "tool_portal_controller_host_action",
  "operation_cancel",
  "recovery_command",
]);

export const GatewayControlRpcResultSchema = z.enum([
  ...ControlRpcResultBaseSchema.options,
  "approval_required",
  "approval_stale",
]);
```

Operation payload schemas are defined per operation. Every payload is strict and
rejects controller-owned authority fields before dispatch:

```ts
import { z } from "zod/v4";
import {
  ControlCorrelationSchema,
  ControlRpcErrorSchema,
} from "@agent-vm/control-protocol-contracts";

export const GatewayControlForbiddenPayloadFieldSchema = z.enum([
  "adminToken",
  "agentId",
  "approvalProof",
  "argv",
  "controllerInstanceId",
  "cwd",
  "credentialProfileId",
  "egressPolicy",
  "env",
  "executablePath",
  "hostWorkMountDir",
  "profileId",
  "rawCredentialRef",
  "retryPolicy",
  "routeToken",
  "sessionKey",
  "sshIdentityPem",
  "vmGenerationOverride",
  "workMountDir",
]);

export const GatewayControlCapabilityRefSchema = z.object({
  name: z.string().min(1),
  namespace: z.string().min(1),
}).strict();

// Shared correlation vocabulary plus the gateway-only capability ref.
// ControlCorrelationSchema carries causationId, correlationId, requestId,
// runId, sessionKeyDigest, toolCallId, and traceId.
export const GatewayControlToolCallCorrelationSchema = ControlCorrelationSchema.extend({
  capability: GatewayControlCapabilityRefSchema.optional(),
}).strict();

export const GatewayControlTrustedCallerContextIdSchema = z.string().uuid();

export const GatewayControlTrustedLeaseContextSchema = z.object({
  agentId: z.string().min(1),
  agentWorkspaceDir: z.string().min(1),
  approvalScopeId: z.string().min(1).optional(),
  callerContextId: GatewayControlTrustedCallerContextIdSchema,
  custodyScopeId: z.string().min(1).optional(),
  hostWorkMountDir: z.string().min(1),
  profileId: z.string().min(1),
  sessionKeyDigest: z.string().min(32),
  workMountDir: z.string().min(1),
  zoneId: z.string().min(1),
}).strict();

export const GatewayControlCallerContextRefSchema = z.object({
  callerContextId: GatewayControlTrustedCallerContextIdSchema,
}).strict();

export const GatewayControlCallerContextRegisterPayloadSchema = z.object({
  adapterEvidence: z.object({
    agentId: z.string().min(1),
    agentWorkspaceDir: z.string().min(1),
    sessionKey: z.string().min(1),
    workMountDir: z.string().min(1),
    zoneId: z.string().min(1),
  }).strict(),
  correlation: GatewayControlToolCallCorrelationSchema.optional(),
}).strict();

export const GatewayControlLeaseCreateIntentPayloadSchema = z.object({
  callerContext: GatewayControlCallerContextRefSchema,
  correlation: GatewayControlToolCallCorrelationSchema.optional(),
  gatewayWorkspaceDir: z.string().min(1).optional(),
  idleTtlHintMs: z.number().int().positive().optional(),
}).strict();

export const GatewayControlLeaseIdPayloadSchema = z.object({
  leaseId: z.string().min(1),
}).strict();

export const GatewayControlLeaseUseStartPayloadSchema = z.object({
  correlation: GatewayControlToolCallCorrelationSchema.optional(),
  leaseId: z.string().min(1),
  useId: z.string().uuid(),
}).strict();

export const GatewayControlLeaseUseHeartbeatPayloadSchema = z.object({
  leaseId: z.string().min(1),
  observedAtMs: z.number().int().positive().optional(),
  useId: z.string().uuid(),
}).strict();

export const GatewayControlLeaseUseEndPayloadSchema = z.object({
  leaseId: z.string().min(1),
  reason: z.enum(["completed", "failed", "cancelled", "timed_out"]),
  useId: z.string().uuid(),
}).strict();

export const GatewayControlHealthEventPayloadSchema = z.object({
  agentId: z.string().min(1).optional(),
  attempt: z.number().int().positive().optional(),
  channelProviderId: z.string().min(1).optional(),
  correlation: ControlCorrelationSchema.optional(),
  elapsedMs: z.number().int().nonnegative().optional(),
  errorClass: z.string().min(1).optional(),
  errorCode: z.string().min(1).optional(),
  eventKind: z.string().min(1),
  leaseId: z.string().min(1).optional(),
  maxAttempts: z.number().int().positive().optional(),
  observedAtMs: z.number().int().positive(),
  operation: z.string().min(1).optional(),
  providerRuntimeHealth: z.enum([
    "healthy",
    "transitioning",
    "unhealthy_recoverable",
    "unhealthy_unrecoverable",
  ]).optional(),
  result: z.enum(["ok", "failed", "timeout", "degraded"]),
  safeDetails: z.record(z.string(), z.string()).optional(),
  statusCode: z.number().int().positive().optional(),
  useId: z.string().uuid().optional(),
}).strict();

export const GatewayControlRuntimeFindingSchema = z.object({
  id: z.string().min(1),
  ok: z.boolean(),
  safeMessage: z.string().min(1).optional(),
  severity: z.enum(["info", "warning", "error"]).optional(),
}).strict();

export const GatewayControlRuntimeStatusPayloadSchema = z.object({
  findings: z.array(GatewayControlRuntimeFindingSchema),
  observedAtMs: z.number().int().positive(),
  providerRuntimeHealth: z.enum([
    "healthy",
    "transitioning",
    "unhealthy_recoverable",
    "unhealthy_unrecoverable",
  ]).optional(),
  statusKind: z.string().min(1),
}).strict();

export const GatewayControlToolPortalControllerHostActionPayloadSchema = z.object({
  actionId: z.literal("zone_git_push"),
  correlation: GatewayControlToolCallCorrelationSchema.optional(),
  expectedHead: z.string().min(1),
}).strict();

export const GatewayControlActiveOperationIdSchema = z.string().uuid();

export const GatewayInitiatedOperationCancelPayloadSchema = z.object({
  activeOperationId: GatewayControlActiveOperationIdSchema,
  initiatedBy: z.literal("gateway"),
  reason: z.enum(["caller_cancelled", "gateway_shutdown", "operation_failed"]),
}).strict();

export const ControllerInitiatedOperationCancelPayloadSchema = z.object({
  activeOperationId: GatewayControlActiveOperationIdSchema,
  initiatedBy: z.literal("controller"),
  reason: z.enum(["controller_recovery", "operator_cancelled", "timeout"]),
}).strict();

export const GatewayControlOperationCancelPayloadSchema = z.discriminatedUnion("initiatedBy", [
  GatewayInitiatedOperationCancelPayloadSchema,
  ControllerInitiatedOperationCancelPayloadSchema,
]);

export const GatewayControlRecoveryCommandPayloadSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("refresh_runtime_status"),
  }).strict(),
  z.object({
    action: z.literal("restart_control_service"),
  }).strict(),
  z.object({
    action: z.literal("close_stale_session"),
    targetSessionId: z.string().uuid(),
  }).strict(),
]);

export const GatewayControlPingPayloadSchema = z.object({}).strict();

// Shared error shape; not redeclared per domain.
export const GatewayControlRpcErrorSchema = ControlRpcErrorSchema;

export const GatewayControlToolVmSshAccessSchema = z.object({
  host: z.string().min(1),
  identityPem: z.string().min(1),
  port: z.number().int().positive(),
  username: z.string().min(1),
}).strict();

export const GatewayControlLeaseSnapshotSchema = z.object({
  activeUseId: z.string().uuid().optional(),
  expiresAtMs: z.number().int().positive().optional(),
  leaseId: z.string().min(1),
  ssh: GatewayControlToolVmSshAccessSchema.optional(),
  state: z.enum(["idle", "active", "expired", "released"]),
  zoneId: z.string().min(1),
}).strict();

export const GatewayControlLeaseUseSnapshotSchema = z.object({
  leaseId: z.string().min(1),
  state: z.enum(["active", "ended", "expired"]),
  useId: z.string().uuid(),
}).strict();

// Why a lease/use operation was rejected. The old raw HTTP surface collapsed
// all of these into one "Lease not found" 404, which made the sunfam incident
// undiagnosable. Rejections must carry the discriminant.
export const GatewayControlLeaseRejectionReasonSchema = z.enum([
  "absent",
  "generation_stale",
  "force_released",
  "releasing",
  "use_tombstoned",
  "runtime_not_ready",
]);

// Domain correlation is the shared vocabulary from
// @agent-vm/control-protocol-contracts (causationId, correlationId, requestId,
// runId, sessionKeyDigest, toolCallId, traceId).
export const GatewayControlRpcDomainCorrelationSchema = ControlCorrelationSchema;

export const GatewayControlRpcResponsePayloadSchema = z.object({
  activeOperationId: GatewayControlActiveOperationIdSchema.optional(),
  approvalRequired: z.boolean().optional(),
  error: GatewayControlRpcErrorSchema.optional(),
  lease: GatewayControlLeaseSnapshotSchema.optional(),
  leaseRejectionReason: GatewayControlLeaseRejectionReasonSchema.optional(),
  leaseUse: GatewayControlLeaseUseSnapshotSchema.optional(),
  responseToMessageId: z.string().uuid(),
  result: GatewayControlRpcResultSchema,
}).strict();

export const GatewayControlRpcCommandMessageSchema = z.discriminatedUnion("operation", [
  GatewayControlRpcDomainCorrelationSchema.extend({
    kind: z.literal("command"),
    operation: z.literal("control_ping"),
    payload: GatewayControlPingPayloadSchema,
  }).strict(),
  GatewayControlRpcDomainCorrelationSchema.extend({
    kind: z.literal("command"),
    operation: z.literal("lease_create"),
    payload: GatewayControlLeaseCreateIntentPayloadSchema,
  }).strict(),
  GatewayControlRpcDomainCorrelationSchema.extend({
    kind: z.literal("command"),
    operation: z.literal("lease_get"),
    payload: GatewayControlLeaseIdPayloadSchema,
  }).strict(),
  GatewayControlRpcDomainCorrelationSchema.extend({
    kind: z.literal("command"),
    operation: z.literal("lease_peek"),
    payload: GatewayControlLeaseIdPayloadSchema,
  }).strict(),
  GatewayControlRpcDomainCorrelationSchema.extend({
    kind: z.literal("command"),
    operation: z.literal("lease_renew"),
    payload: GatewayControlLeaseIdPayloadSchema,
  }).strict(),
  GatewayControlRpcDomainCorrelationSchema.extend({
    kind: z.literal("command"),
    operation: z.literal("lease_release"),
    payload: GatewayControlLeaseIdPayloadSchema,
  }).strict(),
  GatewayControlRpcDomainCorrelationSchema.extend({
    kind: z.literal("command"),
    operation: z.literal("lease_use_start"),
    payload: GatewayControlLeaseUseStartPayloadSchema,
  }).strict(),
  GatewayControlRpcDomainCorrelationSchema.extend({
    kind: z.literal("command"),
    operation: z.literal("lease_use_heartbeat"),
    payload: GatewayControlLeaseUseHeartbeatPayloadSchema,
  }).strict(),
  GatewayControlRpcDomainCorrelationSchema.extend({
    kind: z.literal("command"),
    operation: z.literal("lease_use_end"),
    payload: GatewayControlLeaseUseEndPayloadSchema,
  }).strict(),
  GatewayControlRpcDomainCorrelationSchema.extend({
    kind: z.literal("command"),
    operation: z.literal("tool_portal_controller_host_action"),
    payload: GatewayControlToolPortalControllerHostActionPayloadSchema,
  }).strict(),
  GatewayControlRpcDomainCorrelationSchema.extend({
    kind: z.literal("command"),
    operation: z.literal("operation_cancel"),
    payload: GatewayControlOperationCancelPayloadSchema,
  }).strict(),
  GatewayControlRpcDomainCorrelationSchema.extend({
    kind: z.literal("command"),
    operation: z.literal("recovery_command"),
    payload: GatewayControlRecoveryCommandPayloadSchema,
  }).strict(),
]);

export const GatewayControlRpcEventMessageSchema = z.discriminatedUnion("operation", [
  GatewayControlRpcDomainCorrelationSchema.extend({
    kind: z.literal("event"),
    operation: z.literal("health_event"),
    payload: GatewayControlHealthEventPayloadSchema,
  }).strict(),
  GatewayControlRpcDomainCorrelationSchema.extend({
    kind: z.literal("event"),
    operation: z.literal("runtime_status"),
    payload: GatewayControlRuntimeStatusPayloadSchema,
  }).strict(),
]);

export const GatewayControlRpcCommandResultMessageSchema = GatewayControlRpcDomainCorrelationSchema.extend({
  kind: z.literal("command_result"),
  operation: GatewayControlRpcOperationSchema.exclude(["health_event", "runtime_status"]),
  payload: GatewayControlRpcResponsePayloadSchema,
}).strict();

export const GatewayControlRpcMessageSchema = z.discriminatedUnion("kind", [
  GatewayControlRpcCommandMessageSchema,
  GatewayControlRpcEventMessageSchema,
  GatewayControlRpcCommandResultMessageSchema,
]);
```

`GatewayControlRpcMessageSchema` is the normative wire contract. The legal
message shapes are:

```text
command / command_result
  control_ping, lease_create, lease_get, lease_peek, lease_renew,
  lease_release, lease_use_start, lease_use_heartbeat, lease_use_end,
  tool_portal_controller_host_action, operation_cancel, recovery_command

event only
  health_event, runtime_status

command_result payload
  always contains responseToMessageId and result. It may carry a sanitized
  lease or active-use snapshot only for lease/use operations, a
  leaseRejectionReason for non-ok lease/use results, and a sanitized error
  only for non-ok results.
```

Response payloads are constrained by operation:

```text
operation group                         allowed response payload
──────────────────────────────────────  ──────────────────────────────────────
control_ping                            result only
lease_create/get/peek/renew/release     result plus sanitized lease snapshot
lease_use_start/heartbeat/end           result plus sanitized active-use
                                        snapshot; lease snapshot allowed only
                                        when it is already model-safe; non-ok
                                        lease/use results carry
                                        leaseRejectionReason so force-released,
                                        generation-stale, and absent leases are
                                        operator-distinguishable
operation_cancel                        result plus activeOperationId
recovery_command                        result only
tool_portal_controller_host_action      result plus sanitized controller action
                                        result; for zone_git_push, expectedHead
                                        is a fast-forward precondition only,
                                        never a force-with-lease overwrite, and
                                        the controller enforces the Git Access
                                        And Push Policy

non-ok responses                        result plus sanitized error; may set
                                        approvalRequired only for
                                        approval_required/approval-stale cases
```

Active operation ids are controller-issued identifiers for long-running
controller-tracked RPC operations. They are not request `messageId`, not
`useId`, and not gateway-selected correlation ids. A gateway can only cancel an
operation id that the controller previously returned for the same
session/generation. Gateway-originated cancel frames cannot use controller-only
reasons such as `controller_recovery`, `operator_cancelled`, or `timeout`.

The operation matrix is normative. It defines who may initiate an operation,
who owns the state mutation, and which replay class applies. It is intentionally
not an implementation order.

```text
operation               initiator     authority owner   mutation / result
──────────────────────  ────────────  ────────────────  ───────────────────────
control_ping            either        controller        no state mutation;
                                                        session liveness only

lease_create            gateway       controller        controller creates or
                                                        rejects a lease from
                                                        trusted zone/profile
                                                        state; gateway payload
                                                        is intent/observation

lease_get               gateway       controller        read current lease
                                                        snapshot if scoped to
                                                        this session/generation

lease_peek              gateway       controller        read cached/non-mutating
                                                        lease snapshot

lease_renew             gateway       controller        renew only if lease,
                                                        generation, and session
                                                        preconditions hold

lease_release           gateway       controller        release only with
                                                        controller conflict and
                                                        active-use rules

lease_use_start         gateway       controller        create active-use record
                                                        exactly once for useId

lease_use_heartbeat     gateway       controller        extend liveness only for
                                                        current active use and
                                                        non-stale session

lease_use_end           gateway       controller        finalize active use with
                                                        tombstone/idempotent end

health_event            gateway       controller        record observation after
                                                        sanitization and source
                                                        classification

runtime_status          gateway       controller        record runtime/provider
                                                        observation; does not
                                                        mutate lease authority

tool_portal_controller_
host_action             gateway       controller        controller_host_action
                                                        selected by trusted
                                                        Tool Portal config;
                                                        includes zone_git_push

operation_cancel        either        controller        request/ack cancellation
                                                        for a known active
                                                        operation id only

recovery_command        controller    controller        narrow recovery action;
                                                        never arbitrary guest
                                                        shell, fs, or provider
                                                        command execution
```

Gateway operation delivery policies are normative:

```text
operation                          delivery policy
─────────────────────────────────  ──────────────────────────────────────────
control_ping                       acked_idempotent
caller_context_register           critical_idempotent; controller validates
                                   untrusted adapter evidence and issues the
                                   opaque callerContextId
lease_create                       critical_idempotent when callerContextId +
                                   idempotencyKey are present; otherwise
                                   single_use_critical
lease_get                          acked_idempotent
lease_peek                         acked_idempotent
lease_renew                        single_use_critical
lease_release                      acked_idempotent with lease generation fence
lease_use_start                    critical_idempotent keyed by generation,
                                   leaseId, and useId
lease_use_heartbeat                single_use_critical; never replayed after
                                   reconnect or queue uncertainty
lease_use_end                      acked_idempotent with use tombstone cache
health_event                       append_only_observation
runtime_status                     latest_wins snapshot plus append-only
                                   operation row when failure evidence matters
tool_portal_controller_host_action single_use_critical unless the action schema
                                   defines stable idempotency and terminal cache
operation_cancel                   acked_idempotent
recovery_command                   critical_idempotent with preconditions
```

The control RPC layer does not make gateway-supplied fields trusted. For
example, the controller still translates and validates work mounts, selects Tool
VM profiles from trusted config, resolves credential/approval state, manages
lease tombstones, and owns recovery decisions.

`GatewayControlTrustedLeaseContextSchema` is controller-private state, not a
wire payload from the gateway. It replaces the old raw HTTP lease authority
fields:

```text
old field                  post-cutover source of truth
─────────────────────────  ─────────────────────────────────────────────────
agentId                    trusted caller context selected by controller
agentWorkspaceDir          trusted caller context selected by controller
profileId                  controller lease resolver selects from zone config
sessionKey                 trusted caller context stores digest/reference only
workMountDir               trusted caller context after controller translation
hostWorkMountDir           controller internal trusted path only
idleTtlMs                  controller lease policy, optional gateway hint
```

Caller context issuance is a separate control operation, not part of
`lease_create`. The VM-side adapter may send `caller_context_register` with
adapter-derived evidence that mirrors only the non-profile OpenClaw SDK inputs.
Those fields are explicitly untrusted until the controller validates them
against the accepted control session, zone config, OpenClaw sandbox contract,
path translation rules, and session fences. Profile selection is not adapter
evidence; it is recomputed later by the controller lease resolver from trusted
zone configuration. On success, the controller creates or reuses a
controller-private `GatewayControlTrustedLeaseContextSchema` record and returns
only the opaque `callerContextId` in
`GatewayControlRpcResponsePayloadSchema.callerContext`.
`lease_create` then references that id and never carries raw authority fields.

`gatewayWorkspaceDir` and `idleTtlHintMs` in `lease_create` are untrusted
request context, not policy. The controller may reject, ignore, clamp, or
translate them from trusted zone/session state. The gateway never supplies
`workMountDir` as a trusted controller input, and it never supplies
`hostWorkMountDir`.

Behavioral parity with the old `/lease` HTTP routes means the controller keeps
the same authority outcomes, not that the old request schemas are copied onto
the control socket. The operation schemas are source-of-truth ownership tables:

```text
field class                         allowed in control payload?
──────────────────────────────────  ────────────────────────────────────────
gateway intent/observation          yes, after strict operation schema parse
correlation ids                     yes, via ControlCorrelationSchema only
callerContextId                     yes, opaque controller-issued reference
trusted lease/profile/work paths    no, controller-private context only
credential/session/approval proofs  no, controller-private context only
adapter registration evidence       only in caller_context_register, untrusted
policy knobs/retry/egress/env/cwd   no, controller recomputes or rejects
diagnostic details                  yes, only safe/redacted strings
```

Schema generation and tests must treat every value in
`GatewayControlForbiddenPayloadFieldSchema` as rejected from `lease_create` and
all operation payloads except the explicit `caller_context_register`
`adapterEvidence` object. The only allowed adapter evidence fields are
`agentId`, `agentWorkspaceDir`, `sessionKey`, `workMountDir`, and `zoneId`, and
they remain untrusted registration evidence until controller validation has
created a trusted context. `profileId` is not allowed in adapter evidence and is
always controller-selected.
Adding a new gateway payload field that affects authority, custody, execution
policy, filesystem location, or credential selection requires updating this
ownership table and the matching Zod/JSON Schema contract first.

## Worker Control Session And RPC Contract

Worker control uses the same shared Socket.IO control protocol, but it is a
separate domain from gateway control. It has its own package, operation enum,
state machine, timeout table, and dispatcher. It must not reuse
`GatewayControlRpcOperationSchema` or accept gateway lease/use payloads.

Worker control rides inside the shared wire shape:

```text
Socket.IO event: control:message
  envelope: ControlEnvelopeSchema {
    domain: "worker_control",
    kind: "command" | "command_result" | "event" | "snapshot" | ...
  }
  payload: WorkerControlRpcMessageSchema
```

Worker identity binds at least:

```text
zoneId
worker boot id
taskId, when a task exists
taskGeneration, when a task generation exists
controller instance id / controllerEpoch
session id
protocol version
```

Worker runtime record id, Worker VM id, and route id are controller-side
issuance inputs for the accepted peer/generation/session, not extra fields in
the shared hello or handshake proof schemas.

The VM-side worker control service is owned by `@agent-vm/agent-vm-worker`.
`@agent-vm/worker-gateway` configures and boots the VM process, but it does not
own the worker control dispatcher or task authority. The controller remains the
authority owner for task lifecycle, repository actions, cancellation, and
operator-visible status.

The worker handshake reuses the shared handshake credential/proof/upgrade-binding
shape from `@agent-vm/control-protocol-contracts` with `audience:
"worker_control"`. It uses the same VM-issued nonce plus controller signature,
the same `x-agent-vm-control-*` upgrade headers, and the same VM-side atomic
consumption before `101`. A worker credential cannot open a gateway session and
a gateway credential cannot open a worker session, because the audience,
`peerId`, and generation fields differ and fail closed. The worker control
service holds the controller public key or verifier provisioned at boot; it
never receives a reusable controller bearer secret.

This cutover deliberately narrows Worker control scope. Worker task submit,
state polling, and close already use controller-to-worker ingress HTTP through
the Worker `/tasks` server. They are not moved in this slice. The new
`worker_control` domain removes only Worker-originated controller callbacks and
adds session/runtime observations needed to replace `CONTROLLER_BASE_URL`.

```ts
import { z } from "zod/v4";
import {
  ControlCorrelationSchema,
  ControlRpcErrorSchema,
  ControlRpcResultBaseSchema,
  ControlSessionStateSchema,
} from "@agent-vm/control-protocol-contracts";

export const WorkerControlRpcOperationSchema = z.enum([
  "control_ping",
  "worker_capacity_snapshot",
  "worker_runtime_status",
  "worker_runtime_observation",
  "git_push",
  "git_pull_default",
  "operation_cancel",
  "recovery_command",
]);

export const WorkerControlRpcResultSchema = z.enum([
  ...ControlRpcResultBaseSchema.options,
  "accepted",
]);

export const WorkerControlTaskRefSchema = z.object({
  taskGeneration: z.string().min(1).optional(),
  taskId: z.string().min(1),
}).strict();

export const WorkerControlCommandRefSchema = z.object({
  commandId: z.string().uuid(),
  idempotencyKey: z.string().min(1),
}).strict();

export const WorkerControlGitPushPayloadSchema = z.object({
  branchName: z.string().min(1),
  command: WorkerControlCommandRefSchema,
  expectedHead: z.string().min(1).optional(),
  repoUrl: z.string().min(1),
  task: WorkerControlTaskRefSchema,
}).strict();

export const WorkerControlGitPullDefaultPayloadSchema = z.object({
  command: WorkerControlCommandRefSchema,
  currentBranch: z.string().min(1).optional(),
  currentHead: z.string().min(1).optional(),
  repoUrl: z.string().min(1),
  task: WorkerControlTaskRefSchema,
  worktreeDirty: z.boolean().optional(),
}).strict();

export const WorkerControlCapacitySnapshotPayloadSchema = z.object({
  activeTaskId: z.string().min(1).optional(),
  observedAtMs: z.number().int().positive(),
  state: z.enum(["idle", "running", "closing", "draining"]),
}).strict();

// Same shared session-state vocabulary as the gateway domain.
export const WorkerControlSessionStateSchema = ControlSessionStateSchema;

export const WorkerControlRuntimeObservationPayloadSchema = z.object({
  observedAtMs: z.number().int().positive(),
  sessionState: WorkerControlSessionStateSchema.optional(),
  state: z.enum(["running", "closing", "closed", "failed"]).optional(),
  task: WorkerControlTaskRefSchema,
}).strict();

export const WorkerControlRuntimeStatusPayloadSchema = z.object({
  findings: z.array(z.object({
    id: z.string().min(1),
    ok: z.boolean(),
    safeMessage: z.string().min(1).optional(),
    severity: z.enum(["info", "warning", "error"]).optional(),
  }).strict()),
  observedAtMs: z.number().int().positive(),
  statusKind: z.string().min(1),
}).strict();

export const WorkerControlPingPayloadSchema = z.object({}).strict();

export const WorkerControlActiveOperationIdSchema = z.string().uuid();

export const WorkerInitiatedOperationCancelPayloadSchema = z.object({
  activeOperationId: WorkerControlActiveOperationIdSchema,
  initiatedBy: z.literal("worker"),
  reason: z.enum(["caller_cancelled", "worker_shutdown", "operation_failed"]),
}).strict();

export const ControllerInitiatedWorkerOperationCancelPayloadSchema = z.object({
  activeOperationId: WorkerControlActiveOperationIdSchema,
  initiatedBy: z.literal("controller"),
  reason: z.enum(["controller_recovery", "operator_cancelled", "timeout"]),
}).strict();

export const WorkerControlOperationCancelPayloadSchema = z.discriminatedUnion("initiatedBy", [
  WorkerInitiatedOperationCancelPayloadSchema,
  ControllerInitiatedWorkerOperationCancelPayloadSchema,
]);

export const WorkerControlRecoveryCommandPayloadSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("refresh_runtime_status") }).strict(),
  z.object({ action: z.literal("restart_control_service") }).strict(),
  z.object({
    action: z.literal("close_stale_session"),
    targetSessionId: z.string().uuid(),
  }).strict(),
]);

// Shared error shape; not redeclared per domain.
export const WorkerControlRpcErrorSchema = ControlRpcErrorSchema;

export const WorkerControlGitResultSchema = z.object({
  branch: z.string().min(1).optional(),
  head: z.string().min(1).optional(),
  kind: z.enum(["pushed", "up_to_date", "advanced", "refused_not_fast_forward"]),
}).strict();

export const WorkerControlGitPushResultPayloadSchema = z.object({
  results: z.array(z.object({
    branch: z.string().min(1),
    repoUrl: z.string().min(1),
    success: z.boolean(),
  }).strict()),
}).strict();

export const WorkerControlPullDefaultResultPayloadSchema = z.discriminatedUnion("kind", [
  z.object({
    defaultBranch: z.string().min(1),
    kind: z.literal("advanced"),
    repoUrl: z.string().min(1),
    success: z.literal(true),
  }).strict(),
  z.object({
    error: z.string().min(1),
    kind: z.enum(["refused-not-fast-forward", "failed"]),
    message: z.string().min(1),
    repoUrl: z.string().min(1),
    success: z.literal(false),
  }).strict(),
]);

// Domain correlation is the shared vocabulary from
// @agent-vm/control-protocol-contracts (causationId, correlationId, requestId,
// runId, sessionKeyDigest, toolCallId, traceId).
export const WorkerControlRpcDomainCorrelationSchema = ControlCorrelationSchema;

export const WorkerControlRpcResponsePayloadSchema = z.object({
  activeOperationId: WorkerControlActiveOperationIdSchema.optional(),
  error: WorkerControlRpcErrorSchema.optional(),
  git: z.never().optional(),
  gitPullDefault: WorkerControlPullDefaultResultPayloadSchema.optional(),
  gitPush: WorkerControlGitPushResultPayloadSchema.optional(),
  responseToMessageId: z.string().uuid(),
  result: WorkerControlRpcResultSchema,
}).strict();

export const WorkerControlRpcCommandMessageSchema = z.discriminatedUnion("operation", [
  WorkerControlRpcDomainCorrelationSchema.extend({
    kind: z.literal("command"),
    operation: z.literal("control_ping"),
    payload: WorkerControlPingPayloadSchema,
  }).strict(),
  WorkerControlRpcDomainCorrelationSchema.extend({
    kind: z.literal("command"),
    operation: z.literal("git_push"),
    payload: WorkerControlGitPushPayloadSchema,
  }).strict(),
  WorkerControlRpcDomainCorrelationSchema.extend({
    kind: z.literal("command"),
    operation: z.literal("git_pull_default"),
    payload: WorkerControlGitPullDefaultPayloadSchema,
  }).strict(),
  WorkerControlRpcDomainCorrelationSchema.extend({
    kind: z.literal("command"),
    operation: z.literal("operation_cancel"),
    payload: WorkerControlOperationCancelPayloadSchema,
  }).strict(),
  WorkerControlRpcDomainCorrelationSchema.extend({
    kind: z.literal("command"),
    operation: z.literal("recovery_command"),
    payload: WorkerControlRecoveryCommandPayloadSchema,
  }).strict(),
]);

export const WorkerControlRpcEventMessageSchema = z.discriminatedUnion("operation", [
  WorkerControlRpcDomainCorrelationSchema.extend({
    kind: z.literal("event"),
    operation: z.literal("worker_capacity_snapshot"),
    payload: WorkerControlCapacitySnapshotPayloadSchema,
  }).strict(),
  WorkerControlRpcDomainCorrelationSchema.extend({
    kind: z.literal("event"),
    operation: z.literal("worker_runtime_status"),
    payload: WorkerControlRuntimeStatusPayloadSchema,
  }).strict(),
  WorkerControlRpcDomainCorrelationSchema.extend({
    kind: z.literal("event"),
    operation: z.literal("worker_runtime_observation"),
    payload: WorkerControlRuntimeObservationPayloadSchema,
  }).strict(),
]);

export const WorkerControlRpcCommandResultMessageSchema = WorkerControlRpcDomainCorrelationSchema.extend({
  kind: z.literal("command_result"),
  operation: WorkerControlRpcOperationSchema.exclude([
    "worker_capacity_snapshot",
    "worker_runtime_status",
    "worker_runtime_observation",
  ]),
  payload: WorkerControlRpcResponsePayloadSchema,
}).strict();

export const WorkerControlRpcMessageSchema = z.discriminatedUnion("kind", [
  WorkerControlRpcCommandMessageSchema,
  WorkerControlRpcEventMessageSchema,
  WorkerControlRpcCommandResultMessageSchema,
]);
```

`WorkerControlRpcMessageSchema` is the normative worker wire contract. The
`worker_runtime_observation` operation is event-only and reports task runtime
state that used to be inferred from the Worker HTTP callbacks; it does not
mutate task authority. The shared `WorkerControlRpcOperationSchema` must include
`worker_runtime_observation` alongside the operations already listed.

Worker operation matrix:

```text
operation                  initiator     authority owner   replay class
─────────────────────────  ────────────  ────────────────  ──────────────────
control_ping               either        controller        idempotent read

worker_capacity_snapshot   worker        controller        latest-wins

worker_runtime_status      worker        controller        latest-wins

worker_runtime_observation worker        controller        append-only
                                                         observation

git_push                   worker        controller        single-use critical

git_pull_default           worker        controller        single-use critical

operation_cancel           either        controller        controller-authorized
                                                         control

recovery_command           controller    controller        controller-authorized
                                                         control
```

Worker operation delivery policies are normative:

```text
operation                 delivery policy
────────────────────────  ──────────────────────────────────────────────────
control_ping              acked_idempotent
worker_capacity_snapshot  latest_wins
worker_runtime_status     latest_wins plus append-only operation row on failure
worker_runtime_observation append_only_observation
git_push                  single_use_critical unless expectedHead +
                          idempotencyKey define a stable terminal cache
git_pull_default          single_use_critical unless currentHead/currentBranch
                          preconditions and terminal cache are defined
operation_cancel          acked_idempotent
recovery_command          critical_idempotent with preconditions
```

Worker payloads are intents or observations. The worker must not send trusted
controller authority fields such as zone admin tokens, raw host paths,
credential refs, model secrets, or approval/custody proofs. Controller-owned
repository mutations such as `git_push` and `git_pull_default` must remain
single-use critical unless their domain plan defines stable idempotency keys,
dedupe windows, expected-head preconditions, and terminal-result caching.

## Git Access And Push Policy

Git access is split by direction so the GitHub credential never enters any
managed VM while the agent still gets normal read access and cannot damage a
repository. Reads and writes use different mechanisms because they have
different authorization needs.

```text
direction                 mechanism                     credential
────────────────────────  ────────────────────────────  ──────────────────────
clone / fetch / pull      Gondolin outbound SSH egress   host ssh-agent or host
(read from upstream)      (guest git -> host proxy)      key on the upstream
                                                        leg; never in the VM

push (write to upstream)  controller-mediated push       host githubToken/key;
                          (intent over control RPC,      controller owns the
                          controller runs git push)      push; never in the VM
```

Read path (Gondolin SSH egress) is normative:

```text
guest git                 the agent runs normal `git clone`, `git fetch`,
                          `git pull` against allowlisted upstream hosts.

host termination          Gondolin terminates the guest SSH flow in its
                          in-process host SSH server and opens the upstream
                          connection using a host ssh-agent or configured host
                          key. No credential is provisioned into the guest.

execPolicy                the managed VM spec must set an SSH egress execPolicy
                          that:
                            allows  git-upload-pack (read) to allowed upstream
                                    git hosts
                            denies  git-receive-pack (push) unconditionally
                            denies  non-git exec, interactive shells, and
                                    subsystems (Gondolin already denies the
                                    last two)
                          Because git-receive-pack is denied at the host
                          boundary, the agent has no push path except the
                          controller. The delivered lifecycle VM specs enforce
                          host scope plus git verb policy. The adapter also
                          supports a repo allowlist when a caller has a trusted
                          repo set at VM-spec construction time; that narrower
                          per-repo policy is not claimed for the current
                          zone-level gateway/worker lifecycle builders.

ownership                 openclaw-gateway and worker-gateway wire the SSH
                          egress config into the VM spec; gondolin-adapter
                          exposes the ssh egress + execPolicy surface. This is
                          the only sanctioned guest->upstream egress and is not
                          a control-plane path.
```

Write path (controller-mediated push) is normative. The control message is an
intent only; the commits reach the controller through the host-backed work
mount, never over the control socket (`forbidden_bulk` holds). The controller
owns the `git push` invocation and enforces this push policy host-side, where
the agent cannot bypass it:

```text
allowed
  fast-forward push to a non-protected branch that the controller constructs
  as an explicit `refs/heads/<branch>:refs/heads/<branch>` refspec.

refused
  push to the repository default branch (existing behavior).
  push to any configured protected branch or protected pattern.
  force or non-fast-forward push. The controller never passes `--force` or
  `--force-with-lease` and rejects a push that is not a fast-forward of the
  current remote ref.
  ref deletion. The controller never constructs a `:<branch>` delete refspec.
  push to non-branch refs such as tags or notes unless a later spec explicitly
  allows it.

expectedHead
  a fast-forward precondition, not authority and not a force enabler. The
  controller pushes only when the resulting update is a fast-forward from
  `expectedHead`; a mismatch is refused as not-fast-forward. `expectedHead`
  must never be translated into a `--force-with-lease` overwrite.
```

This policy applies to both control domains:

```text
worker_control   git_push and git_pull_default carry the intent; controller
                 runs the push/pull with the host token under this policy.

gateway_control
                 tool_portal_controller_host_action { actionId: zone_git_push }
                 carries the intent; controller runs the push under the same
                 policy. zone_git_push is not a model-visible tool.
```

Protected branches are controller-owned trusted configuration. The agent-facing
payload never selects which branch policy applies; it only names its own branch
and an optional `expectedHead`. The controller resolves default and protected
branch rules from trusted zone/repository state.

## Replay, Backpressure, And Cancellation

The shared replay, reconnect, delivery-class, and backpressure semantics are
defined in `2026-07-01-socketio-control-protocol-semantics.md`. This section
narrows those rules for gateway_control_rpc.

Gateway control RPC operations are classified before implementation:

```text
idempotent read
  control_ping, lease_get, lease_peek
  Can be retried while the same session/generation is current. Must not mutate
  lease liveness, approval state, credentials, or runtime records.

idempotent observation
  health_event, runtime_status
  Can be de-duplicated by messageId/correlation. Replayed stale observations
  may be retained as diagnostics but must not change readiness for a newer
  generation.

single-use mutation
  lease_create, lease_release, lease_use_start, lease_use_end
  Must bind to preconditions and stable operation/use ids. Duplicate delivery
  returns the existing terminal result or conflict; it does not create a second
  lease/use.

liveness mutation
  lease_renew, lease_use_heartbeat
  Must never be replayed after reconnect, stale generation, queue overflow, or
  session uncertainty in a way that extends lease/use liveness.

controller-authorized control
  operation_cancel, recovery_command
  Must target known active operation/session ids. It cannot become a generic
  guest command, file operation, provider RPC, or shell channel.
```

The session contract must include:

```text
one-use handshake credential
duplicate message rejection
monotonic sequence checks with a bounded replay window
stale generation rejection
use-id tombstones
lease/use precondition checks
bounded queues
heartbeat and cancellation priority under backpressure
disconnect classification
no lease liveness extension from a wedged socket
controller-authorized cancellation tied to active operation ids
exactly-once active-use finalization semantics
```

Observable failure outcomes:

```text
out-of-window replay or stale generation
  reject the message with stale_generation/rejected and do not mutate
  readiness, lease liveness, approval state, credentials, or recovery state.

sequence gap on a mutation or controller-authorized control operation
  close or mark the session stale before accepting later liveness mutations.

bounded queue overflow
  preserve cancellation and heartbeat handling until the session is marked
  stale; drop or coalesce only idempotent observations, never liveness
  mutations that would extend a lease/use after uncertainty.

disconnect during active use
  does not extend lease/use liveness. Controller recovery and tombstone rules
  decide whether the use expires, is finalized, or requires operator action.
```

The controller must classify timeout-before-SSH separately from Tool VM data
plane failure.

## Health And Operator Contract

The health model is layer-specific. These concepts must remain distinct:

```text
gateway_infrastructure
  VM lifecycle: stopped | starting | running | degraded | failed | owner_unsafe

openclaw_service_liveness
  controller can reach the OpenClaw service over ingress

openclaw_readiness
  OpenClaw application readiness, when exposed

plugin_readiness
  gateway control service or Tool Portal/OpenClaw plugin private readiness

gateway_control_session
  unknown | connecting | ready | reconnecting | stale | rejected |
  generation_mismatch | failed | closed

gateway_control_rpc
  per operation: ok | timeout | failed | rejected | cancelled | stale_generation

provider_runtime_health
  healthy | transitioning | unhealthy_recoverable | unhealthy_unrecoverable

tool_vm_lease_state
  none | idle | active | expired | not_applicable

tool_vm_data_plane
  ok | degraded | failed | unknown

selected_zone_readiness
  running | degraded | failed | owner_unsafe
```

Source-of-truth ownership is part of the contract:

```text
concept                         source of truth        gateway may report
──────────────────────────────  ─────────────────────  ───────────────────────
gateway_infrastructure          controller VM runtime  no direct mutation
openclaw_service_liveness       controller ingress     no direct mutation
openclaw_readiness              controller probe       readiness observation if
                                                       exposed by service
plugin_readiness                controller ingress     private service readiness
                                                       response only
gateway_control_session         controller session     close/error frames;
                                manager               controller classifies
gateway_control_rpc             controller RPC         request/response/event
                                dispatcher            results for this session
provider_runtime_health         controller status      sanitized observation
                                store                 from gateway runtime
tool_vm_lease_state             controller lease       lease/use intent only
                                manager
tool_vm_data_plane              gateway observation +  sanitized SSH/data-plane
                                controller record      result classification
selected_zone_readiness         controller reducer     no direct mutation
```

Health/status parity with the current raw HTTP routes is normative:

```text
current behavior / route                  post-cutover RPC and controller owner
────────────────────────────────────────  ────────────────────────────────────
gateway-service-health                    controller ingress observation;
                                          not gateway-published over RPC

gateway-control-link                      replaced by gateway_control_session
                                          and gateway_control_rpc state

controller-request diagnostics            gateway_control_rpc result rows with
                                          operation, attempt/maxAttempts,
                                          elapsedMs, statusCode/errorCode

lease-renew                               gateway_control_rpc lease_renew
                                          response plus health_event
                                          attribution when recorded

lease-heartbeat                           gateway_control_rpc
                                          lease_use_heartbeat response plus
                                          leaseId/useId attribution

tool-vm-ssh                               health_event with eventKind
                                          tool_vm_data_plane and operation
                                          command/file-bridge/finalize/probe

gateway-plugin-health                     health_event with plugin_readiness
                                          state; controller classifies

agent-channel-provider-health             health_event with channelProviderId,
                                          providerRuntimeHealth, and redacted
                                          safeDetails only

gateway-recovery                          controller-owned recovery event;
                                          gateway may not publish it as
                                          authority over RPC

openclaw-runtime-status findings gate     runtime_status event with findings[];
                                          controller status store owns freshness
                                          and failed-finding readiness gates
```

Recovery-trigger parity is normative. Today `gateway-vm-recovery-policy`
derives gateway recovery from consecutive `gateway-control-link` failures with
the reason `gateway-control-link-unhealthy`. After cutover that trigger is
replaced, not dropped:

```text
recovery trigger mapping
  gateway_control_session in {stale, failed}, or consecutive control RPC
  timeout/failure evidence, sustained for N consecutive controller evaluations
  within a bounded window, produces the recovery reason
  control-session-unhealthy. N and the window are chosen in planning; the
  mapping, the consecutive-evaluation semantics, and the replacement reason
  are spec-level. The same rule applies per domain, including worker_control.

recovery corroboration
  gateway/worker-reported health observations are advisory. A recovery
  decision requires corroboration from a controller-owned probe (ingress
  readiness/liveness) in the same window. Observations are rate- and
  budget-bounded per source so a single gateway cannot exhaust
  max-failed-recoveries or mask a controller-observed failure.
```

Legacy health vocabulary maps to the new model as follows:

```text
gateway-control-link
  legacy diagnostic for removed gateway-to-controller raw TCP. It must not be
  a readiness dependency after cutover.

lease-renew / lease-heartbeat
  gateway_control_rpc operation rows with lease/use ids, elapsedMs, and result.

lease-use-start
  first-class gateway_control_rpc operation row. Timeout before this operation
  completes is active-use-start-timeout-before-ssh.

tool-vm-ssh
  tool_vm_data_plane. It starts after active-use succeeds and remains separate
  from gateway_control_session.
```

`gateway_control_rpc: ok` does not imply `tool_vm_data_plane: ok`.

`tool_vm_data_plane: failed` does not imply `gateway_control_session: failed`.

### Failure Classes

```text
control-session-unavailable
control-session-auth-failed
control-session-generation-mismatch
control-session-stale
control-rpc-timeout-before-operation
control-rpc-rejected
active-use-start-timeout-before-ssh
stale-or-missing-lease
tool-vm-data-plane-failure
plugin-readiness-failed
provider-runtime-unhealthy-recoverable
provider-runtime-unhealthy-unrecoverable
recovery-blocked-by-secret-resolution
custody-boundary-violation
approval-required
approval-stale-or-replayed
```

Operator-visible evidence may include allowlisted correlation fields:

```text
sessionId
requestId
messageId
toolCallId
traceId
runId
sessionKeyDigest
leaseId
useId
generationId
elapsedMs
operation
result
errorClass
leaseRejectionReason
```

Correlation flows from the call surface upward: OpenClaw supplies runId,
sessionKeyDigest, and toolCallId; the worker supplies taskId and runId; tracing
supplies traceId. Every layer between the call surface and operator evidence
preserves these fields so an app-visible warning joins to the exact control RPC
row. Raw sessionKey never appears; only its digest does.

It must not expose session keys, tokens, SSH identity PEM, private route
credentials, raw credential refs, raw host paths, raw stdout/stderr, env values,
or hidden controller fields.

## Threat Model

Assets:

```text
controller lease authority
Tool VM SSH key material
gateway runtime records
VM generation identity
approval state
credential custody
zone admin operations
health/recovery state
model-visible tool inputs and outputs
operator diagnostics
```

Misuse cases:

```text
stale gateway VM reconnects and heartbeats a newer lease use
compromised gateway/plugin forges agentId, sessionKey, or workMountDir
model payload smuggles trusted control fields
old active-use start/end/cancel messages are replayed
public gateway route exposes private control RPC
backpressure blocks heartbeat or cancel while keeping leases alive
old raw TCP fallback silently bypasses generation binding
compromised gateway forges failing health/runtime observations to force
  repeated recovery until max-failed-recoveries suspends the zone, or forges
  healthy observations to mask a real fault
a second in-VM control client or session-frame logging captures a lease
  snapshot carrying Tool VM SSH identityPem
```

Required security behavior:

```text
controller recomputes trusted decisions
strict Zod v4 unknown-field rejection at every runtime boundary
hidden/control fields rejected if model-visible payloads carry them
session handshake is generation-bound and expires
duplicate/stale/replayed messages fail closed
public gateway credentials cannot open the control session
cancellation is controller-authorized
streaming is capped and never unbounded
telemetry hashes or redacts high-cardinality/sensitive values
gateway/worker health observations are advisory to recovery: corroborated by
  controller-owned probes and rate/budget-bounded per source
identityPem custody: control-session frames carrying a lease snapshot are
  never logged, traced, or exported; the key has a bounded in-memory lifetime
  on the gateway; it is delivered only on the authenticated,
  current-generation control session, which admits one accepted session at a
  time
```

## Non-Goals

This spec does not:

```text
replace Tool VM SSH for sandbox_ssh execution
tunnel SSH stdout/stderr over WebSocket
turn controller into an OpenClaw filesystem bridge
add a generic guest RPC API
add a generic host command API
make control-session tools model-visible
make OpenClaw a Tool Portal backend
put Gondolin/OpenClaw/SSH/controller runtime imports in Tool Portal core
ship credentialed runner execution in the gateway-control cutover slice
preserve old gateway-to-controller raw TCP control as fallback
ship a sidecar as the managed OpenClaw control service in this cutover
define exact implementation order or worker assignment
```

## Proof Expectations

Future plans must operationalize proof for these requirements:

```text
schema proof
  strict Zod v4 + JSON Schema contracts, unknown-field rejection, versioning,
  duplicate/stale/replay rejection, single shared envelope identity,
  operation-to-delivery binding, and sanitized results. envelope.kind and
  envelope.operation strictly equal the domain message kind/operation; both
  layers use the shared ControlMessageKindSchema strings; a mismatched pair
  fails closed.

architecture residue proof
  Tool Portal core imports no Gondolin/OpenClaw/SSH/controller runtime;
  managed OpenClaw exposes only tool_portal_*; no managed
  openclaw-mcp-portal-plugin identity remains; no direct zone_git_push model
  tool remains; gateway code no longer needs controller.vm.host:18800; Worker
  code no longer uses CONTROLLER_BASE_URL for controller tools.

VM spec proof
  managed gateway tcpHosts contain only tool-<slot>.vm.host:22 unless a later
  spec accepts another raw-TCP exception; Worker specs omit controller.vm.host;
  validation/boot fail closed for websocketBypass, websocketUpgrades raw
  passthrough regression, or collector raw tcpHosts.

controller/surface proof
  lease and active-use semantics preserve controller authority and move from
  VM HTTP callbacks to gateway_control_rpc; public/operator HTTP still serves
  controller and Worker task APIs; private ingress HTTP serves only service
  liveness/readiness and WebSocket upgrade.

runtime/operator proof
  real controller starts OpenClaw and Worker gateways, observes readiness
  through ingress, establishes both control sessions, proves OpenClaw control
  RPC plus Tool VM SSH, proves Worker-originated push/pull-default without raw
  controller TCP, and exposes session/RPC health separately from provider
  runtime and Tool VM data plane. A correlation id set at the call surface
  (traceId, runId, sessionKeyDigest, toolCallId) survives into the RPC row,
  health event, and operator evidence for a failing operation. Non-ok
  lease/use results render force_released, generation_stale, and absent as
  distinct operator evidence. Recovery decisions derive from the
  gateway_control_session mapping (control-session-unhealthy), no
  readiness/recovery path depends on gateway-control-link, and forged
  gateway health observations cannot trigger recovery beyond the per-source
  budget without controller-probe corroboration.

security/backpressure/reliability proof
  forged signature, duplicate nonce, stale generation, public gateway
  credential, replay, stale approval, hidden model control fields, queue
  overflow, unbounded reconnect buffering, and timing-order violations fail
  closed; an ingress-upgrade Socket.IO rig proves OpenClaw plugin handleUpgrade,
  flap handling during active use, no liveness extension after uncertainty, and
  Tool VM SSH after resync. Control-session frames carrying a lease snapshot
  with identityPem never appear in logs, traces, or exports, and only the
  single accepted current-generation session receives them.

git access proof
  the GitHub credential is never present in any managed VM; Gondolin SSH egress
  allows git-upload-pack (read) and denies git-receive-pack (push) at the host
  boundary and denies non-git SSH exec; controller-mediated push refuses the default branch, refuses
  configured protected branches, refuses force/non-fast-forward pushes, refuses
  ref deletion, and treats expectedHead as a fast-forward precondition only; no
  git pack data crosses the control socket.
```

## Slice Routes For Planning

These are separable plan routes, not task order:

```text
control-protocol-contract
  shared Socket.IO transport, JSON Schema/Zod contracts, handshake, replay,
  cancel, backpressure, and contract tests.
gateway-control-service-placement
  OpenClaw plugin-hosted private route, ingress shape, readiness,
  handleUpgrade support, and private auth.
controller-session-runtime
  connection manager, generation binding, health, reconnect, stale handling.
lease-control-rpc-parity
  lease/active-use RPC parity while removing gateway raw TCP callers.
managed-openclaw-hard-cutover
  remove controller.vm.host raw TCP, raw provider/collector passthrough, old
  MCP Portal plugin identity, stale docs/manuals, and stale tests.
operator-health-observability
  health taxonomy, readiness/recovery migration from gateway-control-link,
  logs/traces/metrics, and runtime parity.
tool-portal-backend-taxonomy
  backend-kind alignment, tool_portal_* hard cutover, forbidden import gates.
```

## Decisions Deferred Out Of This Spec

1. Host/Mac service bridge:
   future host-service streaming may reuse the controller RPC envelope under
   `controller_host_action`, but this spec does not introduce it as a gateway
   cutover deliverable.

2. Non-control raw TCP:
   this spec forbids non-SSH gateway raw TCP after cutover. `zone.websocketBypass`
   or rebased `websocketUpgrades` raw passthrough, and collector-mode
   observability become managed-mode validation/startup failures unless this
   spec's implementation supplies a non-raw-TCP replacement or a later explicit
   exception spec accepts the raw TCP path.

## Stop Conditions

Do not move to implementation planning if any of these remain unresolved in the
accepted spec:

```text
private route is reachable through public OpenClaw routes without separate
control credential
session credential and generation binding are unspecified
OpenClaw plugin handleUpgrade cannot host Socket.IO with private auth before 101
gateway-to-controller raw TCP fallback remains in managed runtime
zone.websocketBypass, websocketUpgrades raw passthrough regression, or
collector-mode observability can still create managed gateway raw tcpHosts
without an accepted replacement/exception spec
control messages are not strict Zod v4 schemas
model-visible payloads can carry controller control fields
cancellation, reconnect, replay, stale session, or backpressure behavior is
undefined
```
