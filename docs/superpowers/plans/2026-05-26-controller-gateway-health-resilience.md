# Controller Gateway Health Resilience

Date: 2026-05-26
Branch: `fix/controller-gateway-health-resilience`
Worktree: `agent-vm.fix-controller-gateway-health-resilience`

This plan hardens the communication paths between the agent-vm controller,
gateway VMs, gateway services, OpenClaw plugins, and Tool VMs. The immediate
failure class is a controller HTTP call from inside the gateway VM hanging long
enough to block an agent tool call. The broader goal is a generic health model
that tells operators which boundary is sick and gives each boundary a bounded
recovery path.

## Grounded Current State

The following facts are from the current repository and are load-bearing for the
design.

### Controller APIs

Primary controller routes live in:

`packages/agent-vm/src/controller/http/controller-http-routes.ts`

They include:

- `GET /health`
- `POST /lease`
- `GET /lease/:leaseId/peek`
- `GET /lease/:leaseId`
- `POST /lease/:leaseId/renew`
- `GET /leases`
- `DELETE /lease/:leaseId`
- `POST /lease/:leaseId/uses`
- `POST /lease/:leaseId/uses/:useId/heartbeat`
- `DELETE /lease/:leaseId/uses/:useId`
- `POST /zones/:zoneId/openclaw-runtime-status`

Zone operation routes live in:

`packages/agent-vm/src/controller/http/controller-zone-operation-routes.ts`

Relevant routes include:

- `GET /controller-status`
- `GET /zones/:zoneId/status`
- `GET /zones/:zoneId/health`
- `GET /zones/:zoneId/zone-git/status`
- `POST /zones/:zoneId/zone-git/push`
- `POST /zones/:zoneId/worker-tasks`
- `GET /zones/:zoneId/tasks/:taskId`
- `POST /zones/:zoneId/tasks/:taskId/close`
- `POST /zones/:zoneId/tasks/:taskId/push-branches`
- `POST /zones/:zoneId/tasks/:taskId/pull-default`
- `POST /zones/:zoneId/execute-command`

### Current Control Links

`packages/gateway-interface/src/audience.ts` exports
`controllerVmHost = "controller.vm.host"`.

`packages/worker-gateway/src/worker-lifecycle.ts` injects:

```ts
CONTROLLER_BASE_URL: "http://controller.vm.host:18800"
```

and maps the in-VM host to the controller:

```ts
tcpHosts: {
	"controller.vm.host:18800": `127.0.0.1:${options.controllerPort}`,
}
```

`packages/openclaw-gateway/src/openclaw-lifecycle.ts` maps:

```ts
"controller.vm.host:18800" -> "127.0.0.1:<controllerPort>"
"tool-<slot>.vm.host:22"   -> "127.0.0.1:<toolVmSshPort>"
```

These are two separate raw TCP mappings:

```text
Gateway VM -> controller
  controller.vm.host:18800
    -> Gondolin tcpHosts
    -> host 127.0.0.1:<controllerPort>

Gateway VM -> Tool VM SSH
  tool-<slot>.vm.host:22
    -> Gondolin tcpHosts
    -> host 127.0.0.1:<toolVmSshPort>
```

### Existing Gateway Service Probe

`packages/agent-vm/src/gateway/gateway-health-check.ts` runs a host/controller
side HTTP probe into the gateway service:

```text
curl --max-time 2 http://127.0.0.1:<healthCheck.port><healthCheck.path>
```

`packages/agent-vm/src/controller/zone-runtimes/openclaw-zone-runtime.ts`
uses this in `getZoneHealth()`.

This proves the controller can reach the long-running gateway service through
the host-side Gondolin path. It does not prove that the gateway VM can reach the
controller.

### Lease Liveness Semantics

`packages/agent-vm/src/controller/leases/lease-manager.ts` already has the
correct core invariant:

```ts
isLeaseExpired(lease) =
	isLeaseIdleExpired(lease) && activeUseCountForLease(lease.id) === 0
```

`heartbeatActiveUse(...)` updates the active use expiry and touches the lease.
`renewLease(...)` also touches the lease after probing Tool VM liveness.
`packages/agent-vm/src/controller/leases/lease-manager.test.ts` already proves
lease-heartbeat behavior prevents idle lease expiry.

User-facing health language must call
`POST /lease/:leaseId/uses/:useId/heartbeat` a `lease-heartbeat`. The route
name and internal method can stay as implementation details for this plan.

### Known Gaps

OpenClaw plugin controller calls in
`packages/openclaw-agent-vm-plugin/src/controller-lease-client.ts` currently
need the TDD slice from the sibling branch ported into this worktree:

- bounded fetch wrapper
- AbortSignal timeout reaching `fetch`
- retryable transient failure handling
- success body draining for future-proofing
- direct `fetchImpl` isolated to one request-policy module

`packages/openclaw-agent-vm-plugin/src/zone-git-tool.ts` also performs direct
controller `fetch` for `/zones/:zoneId/zone-git/push` and must move onto the
same bounded controller request path.

`packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.ts` has its
own `publishRuntimeStatusWithRetry(...)`. That becomes a call into the shared
request policy. There should not be two retry implementations for controller
communication.

`packages/openclaw-agent-vm-plugin/src/gondolin-plugin-config.ts` already
requires `controllerUrl` and `zoneId`; no config schema precursor is needed for
the OpenClaw plugin monitor.

## Vocabulary

Use these terms in code, docs, and manuals.

```text
agent-vm controller
  Host-side agent-vm controller process. Code and docs should use the full
  phrase at cross-component boundaries so it is not confused with OpenClaw or
  gateway-service internals.

gateway-vm
  Long-running VM that hosts a gateway service.

gateway-service
  Generic service inside a gateway VM. OpenClaw is one implementation.

gateway-control-link
  Gateway VM -> agent-vm controller HTTP path through controller.vm.host:18800.

gateway-service-health
  Controller/host -> gateway-service probe using the gateway's configured
  service health endpoint.

lease-renew
  Agent-vm controller request that refreshes a lease and probes Tool VM VM-level
  liveness.

lease-heartbeat
  Agent-vm controller request for an active lease operation. It extends the active
  operation and touches the lease. It is named `lease-heartbeat` in user-facing
  docs.

tool-vm-ssh
  Gateway VM -> Tool VM SSH path through Gondolin tcpHosts.

health event
  One typed observation at one boundary. The system is "health"; individual
  records are events or observations in user-facing docs.
```

Important lease distinction:

```text
lease-heartbeat ok + lease-renew ok
  Controller link works, active operation stays alive, Tool VM probe works.

lease-heartbeat ok + lease-renew failed with ssh/probe failure
  Controller link works, active operation can report, Tool VM VM-level
  liveness is broken.

lease-heartbeat timeout + lease-renew timeout
  Gateway VM -> controller control link is likely broken or the controller is
  not accepting/answering requests.

lease-heartbeat ok + lease-renew expired
  Treat as a bug/race to investigate. Successful lease-heartbeats should touch
  lease idle state while the active operation exists.
```

Controller health scope:

```text
GET /health
  Global agent-vm controller liveness endpoint. It answers "is the agent-vm
  controller process alive?" It does not emit a zone-scoped health event by
  itself because the route has no zone context.

gateway-control-link
  Zone-scoped event emitted by gateway VM code after it calls GET /health
  through controller.vm.host:18800. This answers "can this zone's gateway VM
  reach the agent-vm controller?"

No `controller-runtime` event exists in this slice. The global controller
process is checked through `GET /health`; zone-scoped health starts at the
zone boundary that observed the fact.
```

## Architecture

```text
                       controller process
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  Health event store + reducer                                        │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │  latest typed events per zone/boundary                       │    │
│  │  derived zone health state                                   │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                 ▲                         ▲                          │
│                 │                         │                          │
│  controller-observed events       posted gateway events              │
│  lease routes, zone probes        /zones/:zoneId/health-events       │
│                 │                         │                          │
│                 │                         │                          │
│  ┌──────────────┴──────────────┐          │                          │
│  │ gateway-service monitor     │          │                          │
│  │ controller -> gateway svc   │          │                          │
│  └──────────────┬──────────────┘          │                          │
│                 │                         │                          │
└─────────────────┼─────────────────────────┼──────────────────────────┘
                  │                         │
                  │ host/Gondolin path      │ gateway-control-link
                  ▼                         │
        ┌───────────────────┐               │
        │    gateway VM     │───────────────┘
        │                   │
        │ gateway service   │
        │ OpenClaw plugin   │
        └─────────┬─────────┘
                  │
                  │ tool-vm-ssh via tcpHosts
                  ▼
        ┌───────────────────┐
        │      Tool VM      │
        │ /workspace /work  │
        └───────────────────┘
```

The controller owns health aggregation and state decisions. Gateway packages
produce VM/process specs and probe mechanics. Plugins emit low-rate health
events and use bounded controller communication. The OpenClaw plugin remains an
implementation of a generic gateway-service contract.

## Package Ownership

```text
packages/gateway-interface
  Owns shared health event types, controller request policy contracts,
  controller request operation names, result discriminators, and pure health
  state reduction. It owns contracts, not runtime fetch implementation.

packages/agent-vm
  Owns the controller health event store, HTTP routes, zone health snapshots,
  controller-side gateway-service monitor, config schema, and generated manuals.

packages/gondolin-adapter
  Owns VM/tcpHosts mechanics only. It should not know OpenClaw, leases, or
  health-state semantics.

packages/openclaw-gateway
  Supplies OpenClaw gateway VM process specs and health-check metadata.

packages/worker-gateway
  Supplies Agent Worker gateway VM process specs and health-check metadata.

packages/openclaw-agent-vm-plugin
  Owns the OpenClaw runtime implementation of bounded controller requests from
  inside the gateway VM, low-rate gateway control-link monitoring,
  lease-heartbeat calls through existing lease routes, and Tool VM SSH operation
  reporting.

packages/agent-vm-worker
  Owns the Agent Worker runtime implementation of bounded controller requests.
  It should import shared policy names/contracts from gateway-interface or keep
  a documented adapter that proves the same policy surface; it must not import
  from openclaw-agent-vm-plugin.
```

## Shared Types

Add:

`packages/gateway-interface/src/health/agent-vm-health.ts`

Export it from:

`packages/gateway-interface/src/index.ts`

Core shape:

```ts
import type { GatewayType } from "../gateway-runtime-contract.js";

export const agentVmHealthEventKinds = [
	"gateway-service-health",
	"gateway-control-link",
	"controller-request",
	"lease-renew",
	"lease-heartbeat",
	"tool-vm-ssh",
	"gateway-plugin-health",
] as const;

export type AgentVmHealthEventKind = typeof agentVmHealthEventKinds[number];

export const gatewayInternalControllerRequestOperations = [
	"controller-health",
	"health-event-publish",
	"openclaw-runtime-status",
	"zone-git-push",
	"lease-create",
	"lease-get",
	"lease-peek",
	"lease-list",
	"lease-renew",
	"lease-release",
	"lease-use-start",
	"lease-heartbeat",
	"lease-use-end",
] as const;

export type GatewayInternalControllerRequestOperation =
	typeof gatewayInternalControllerRequestOperations[number];

export const workerInternalControllerRequestOperations = [
	"worker-push-branches",
	"worker-pull-default",
] as const;

export type WorkerInternalControllerRequestOperation =
	typeof workerInternalControllerRequestOperations[number];

export type ControllerRequestPolicyOperation =
	| GatewayInternalControllerRequestOperation
	| WorkerInternalControllerRequestOperation;

export const genericControllerRequestEventOperations = [
	"controller-health",
	"health-event-publish",
	"openclaw-runtime-status",
	"zone-git-push",
	"lease-create",
	"lease-get",
	"lease-peek",
	"lease-list",
	"lease-release",
	"lease-use-start",
	"lease-use-end",
	"worker-push-branches",
	"worker-pull-default",
] as const;

export type GenericControllerRequestEventOperation =
	typeof genericControllerRequestEventOperations[number];

export const externalControllerRoutes = [
	"GET /controller-status",
	"GET /zones/:zoneId/status",
	"GET /zones/:zoneId/health",
	"GET /zones/:zoneId/zone-git/status",
	"GET /zones/:zoneId/logs",
	"POST /zones/:zoneId/credentials/refresh",
	"POST /zones/:zoneId/destroy",
	"POST /zones/:zoneId/upgrade",
	"GET /zones/:zoneId/tasks/:taskId",
	"POST /zones/:zoneId/worker-tasks",
	"POST /zones/:zoneId/tasks/:taskId/close",
	"POST /zones/:zoneId/enable-ssh",
	"POST /zones/:zoneId/execute-command",
	"POST /stop-controller",
] as const;

export type ExternalControllerRoute = typeof externalControllerRoutes[number];

export const agentVmHealthResultKinds = [
	"ok",
	"failed",
	"timeout",
	"stale",
] as const;

export type AgentVmHealthResultKind =
	typeof agentVmHealthResultKinds[number];

export interface AgentVmHealthEventBase {
	readonly observedAtMs: number;
	readonly result: AgentVmHealthResultKind;
	readonly zoneId: string;
}

export type AgentVmHealthEvent =
	| (AgentVmHealthEventBase & {
			readonly kind: "gateway-service-health";
			readonly path: string;
			readonly port: number;
			readonly statusCode?: number;
	  })
	| (AgentVmHealthEventBase & {
			readonly kind: "gateway-control-link";
			readonly controllerHost: "controller.vm.host";
			readonly controllerPort: 18800;
			readonly elapsedMs: number;
			readonly operation: "controller-health";
			readonly path: "/health";
	  })
	| (AgentVmHealthEventBase & {
			readonly kind: "controller-request";
			readonly elapsedMs: number;
			readonly operation: GenericControllerRequestEventOperation;
			readonly attempt: number;
			readonly maxAttempts: number;
			readonly statusCode?: number;
			readonly errorCode?: string;
	  })
	| (AgentVmHealthEventBase & {
			readonly kind: "lease-renew";
			readonly agentId: string;
			readonly leaseId: string;
			readonly elapsedMs: number;
			readonly errorCode?: string;
	  })
	| (AgentVmHealthEventBase & {
			readonly kind: "lease-heartbeat";
			readonly agentId: string;
			readonly leaseId: string;
			readonly useId: string;
			readonly elapsedMs: number;
			readonly errorCode?: string;
	  })
	| (AgentVmHealthEventBase & {
			readonly kind: "tool-vm-ssh";
			readonly agentId: string;
			readonly leaseId: string;
			readonly operation: "command" | "file-bridge" | "finalize" | "probe";
			readonly elapsedMs: number;
			readonly errorCode?: string;
	  })
	| (AgentVmHealthEventBase & {
			readonly kind: "gateway-plugin-health";
			readonly gatewayService: GatewayType;
			readonly state: "starting" | "ready" | "stopping" | "failed";
	  });
```

`gatewayInternalControllerRequestOperations` and
`workerInternalControllerRequestOperations` are in-VM request surfaces that must
use bounded policies. `externalControllerRoutes` is an inventory of
CLI/operator/admin/controller-host routes that are not called from in-VM agent
code and are not policy-bound by this plan. If gateway or worker code starts
calling one of those routes from inside a VM, it must first move into the
internal operation union.

`controller-request` events intentionally exclude `lease-renew` and
`lease-heartbeat`. Those routes have richer typed health events recorded by the
controller, so recording both would double-count the same operation.

Add explicit state-machine types in the same file or a sibling file:

```ts
export const zoneHealthStateKinds = [
	"unknown",
	"ok",
	"stale",
	"failed",
] as const;

export type ZoneHealthStateKind = typeof zoneHealthStateKinds[number];

export const zoneHealthIssueKinds = [
	"gateway-service-unhealthy",
	"gateway-control-link-unhealthy",
	"controller-request-failing",
	"lease-heartbeat-failing",
	"lease-renew-failing",
	"tool-vm-ssh-failing",
	"health-event-stale",
] as const;

export type ZoneHealthIssueKind = typeof zoneHealthIssueKinds[number];

export interface ZoneHealthIssue {
	readonly kind: ZoneHealthIssueKind;
	readonly message: string;
	readonly sinceMs: number;
	readonly latestEvent: AgentVmHealthEvent;
}

export type ZoneHealthSnapshot =
	| {
			readonly kind: "unknown";
			readonly zoneId: string;
			readonly reason: "no-events";
	  }
	| {
			readonly kind: "ok";
			readonly zoneId: string;
			readonly latestEvents: readonly AgentVmHealthEvent[];
	}
	| {
			readonly kind: "stale" | "failed";
			readonly zoneId: string;
			readonly issues: readonly ZoneHealthIssue[];
			readonly latestEvents: readonly AgentVmHealthEvent[];
	  };
```

The reducer is pure:

```ts
export interface DeriveZoneHealthSnapshotOptions {
	readonly nowMs: number;
	readonly staleAfterMs: number;
	readonly zoneId: string;
}

export function deriveZoneHealthSnapshot(
	events: readonly AgentVmHealthEvent[],
	options: DeriveZoneHealthSnapshotOptions,
): ZoneHealthSnapshot;
```

## Controller Request Policy

Add shared policy contracts and per-operation defaults in:

`packages/gateway-interface/src/health/controller-request-policy.ts`

Runtime-specific wrappers live next to the code that performs `fetch`:

- OpenClaw plugin wrapper:
  `packages/openclaw-agent-vm-plugin/src/controller-request-policy.ts`
- Agent Worker wrapper:
  `packages/agent-vm-worker/src/work-phase/controller-tools/controller-request-policy.ts`

The shared contract owns operation names and default policy values. The runtime
wrappers own AbortController wiring, fetch calls, body draining, and local
logging because those behaviors depend on runtime context.

Each wrapper owns:

- `AbortController` timeout per attempt
- retryable HTTP statuses before returning a response
- retryable transport errors
- response body draining for operations that do not parse the body
- per-operation event publication hook
- no unbounded controller `fetch`

Policy table:

```ts
export interface ControllerRequestPolicy {
	readonly maxAttempts: number;
	readonly retryBaseDelayMs: number;
	readonly timeoutMs: number;
	readonly retryStatuses: readonly number[];
	readonly idempotency: "read" | "safe-mutation" | "unsafe-mutation";
	readonly retryEnabled: boolean;
}

export const controllerRequestPolicies = {
	"controller-health": {
		maxAttempts: 1,
		retryBaseDelayMs: 0,
		timeoutMs: 3_000,
		retryStatuses: [],
		idempotency: "read",
		retryEnabled: false,
	},
	"health-event-publish": {
		maxAttempts: 1,
		retryBaseDelayMs: 0,
		timeoutMs: 3_000,
		retryStatuses: [],
		idempotency: "safe-mutation",
		retryEnabled: false,
	},
	"openclaw-runtime-status": {
		maxAttempts: 30,
		retryBaseDelayMs: 1_000,
		timeoutMs: 3_000,
		retryStatuses: [429, 503, 504],
		idempotency: "safe-mutation",
		retryEnabled: true,
	},
	"zone-git-push": {
		maxAttempts: 1,
		retryBaseDelayMs: 0,
		timeoutMs: 120_000,
		retryStatuses: [],
		idempotency: "unsafe-mutation",
		retryEnabled: false,
	},
	"lease-create": {
		maxAttempts: 1,
		retryBaseDelayMs: 0,
		timeoutMs: 180_000,
		retryStatuses: [],
		idempotency: "unsafe-mutation",
		retryEnabled: false,
	},
	"lease-get": {
		maxAttempts: 2,
		retryBaseDelayMs: 250,
		timeoutMs: 5_000,
		retryStatuses: [503, 504],
		idempotency: "read",
		retryEnabled: true,
	},
	"lease-peek": {
		maxAttempts: 2,
		retryBaseDelayMs: 250,
		timeoutMs: 5_000,
		retryStatuses: [503, 504],
		idempotency: "read",
		retryEnabled: true,
	},
	"lease-list": {
		maxAttempts: 2,
		retryBaseDelayMs: 250,
		timeoutMs: 5_000,
		retryStatuses: [503, 504],
		idempotency: "read",
		retryEnabled: true,
	},
	"lease-renew": {
		maxAttempts: 3,
		retryBaseDelayMs: 250,
		timeoutMs: 10_000,
		retryStatuses: [429, 503, 504],
		idempotency: "safe-mutation",
		retryEnabled: true,
	},
	"lease-release": {
		maxAttempts: 2,
		retryBaseDelayMs: 250,
		timeoutMs: 5_000,
		retryStatuses: [503, 504],
		idempotency: "safe-mutation",
		retryEnabled: true,
	},
	"lease-use-start": {
		maxAttempts: 2,
		retryBaseDelayMs: 250,
		timeoutMs: 10_000,
		retryStatuses: [429, 503, 504],
		idempotency: "safe-mutation",
		retryEnabled: true,
	},
	"lease-heartbeat": {
		maxAttempts: 2,
		retryBaseDelayMs: 250,
		timeoutMs: 5_000,
		retryStatuses: [429, 503, 504],
		idempotency: "safe-mutation",
		retryEnabled: true,
	},
	"lease-use-end": {
		maxAttempts: 2,
		retryBaseDelayMs: 250,
		timeoutMs: 5_000,
		retryStatuses: [503, 504],
		idempotency: "safe-mutation",
		retryEnabled: true,
	},
	"worker-push-branches": {
		maxAttempts: 1,
		retryBaseDelayMs: 0,
		timeoutMs: 120_000,
		retryStatuses: [],
		idempotency: "unsafe-mutation",
		retryEnabled: false,
	},
	"worker-pull-default": {
		maxAttempts: 1,
		retryBaseDelayMs: 0,
		timeoutMs: 120_000,
		retryStatuses: [],
		idempotency: "unsafe-mutation",
		retryEnabled: false,
	},
} satisfies Record<ControllerRequestPolicyOperation, ControllerRequestPolicy>;
```

Do not retry unsafe mutations unless a later implementation introduces explicit
idempotency keys and tests that prove duplicate requests are harmless.

`lease-use-start` is safe to retry only because the request already carries a
client-generated UUIDv7 `useId` and the controller returns the existing active
use for the same `(leaseId, useId)` while rejecting an ended tombstone. Task 4
keeps this contract pinned in controller tests, including the lost-response case
where the first request succeeds server-side and the retry reuses the same
`useId`.

## Implementation Tasks

### Task 1: Add Shared Health Event Types

Files:

- `packages/gateway-interface/src/health/agent-vm-health.ts`
- `packages/gateway-interface/src/health/agent-vm-health.test.ts`
- `packages/gateway-interface/src/health/controller-request-policy.ts`
- `packages/gateway-interface/src/health/controller-request-policy.test.ts`
- `packages/gateway-interface/src/index.ts`

Red tests:

```bash
pnpm vitest run \
  packages/gateway-interface/src/health/agent-vm-health.test.ts \
  packages/gateway-interface/src/health/controller-request-policy.test.ts
```

Test cases:

- every `AgentVmHealthEvent` branch validates through a type guard
- an unknown `kind` is rejected
- `deriveZoneHealthSnapshot([])` returns `{ kind: "unknown" }`
- fresh all-ok required boundaries produce `{ kind: "ok" }`
- failed gateway-service event produces `gateway-service-unhealthy`
- stale latest event produces `health-event-stale`
- failed lease-heartbeat and failed lease-renew produce different issue kinds
- generic `controller-request` rejects `lease-renew` and `lease-heartbeat`
- `gateway-plugin-health.gatewayService` accepts every `GatewayType`
- `observedAtMs` is required and ISO `observedAt` is rejected by the type guard
- external controller routes are inventoried but absent from policy operations
- `controllerRequestPolicies` covers every internal policy operation

Implementation:

- add `as const` operation/result/state arrays
- add `as const` external route inventory
- add controller request policy contracts and defaults
- add discriminated union types
- add `isAgentVmHealthEvent(value: unknown): value is AgentVmHealthEvent`
- add pure reducer

Green command:

```bash
pnpm vitest run \
  packages/gateway-interface/src/health/agent-vm-health.test.ts \
  packages/gateway-interface/src/health/controller-request-policy.test.ts
```

### Task 2: Port Bounded Controller Request Policy

Files:

- `packages/openclaw-agent-vm-plugin/src/controller-request-policy.ts`
- `packages/openclaw-agent-vm-plugin/src/controller-request-policy.test.ts`
- `packages/openclaw-agent-vm-plugin/src/controller-lease-client.ts`
- `packages/openclaw-agent-vm-plugin/src/controller-lease-client.test.ts`
- `packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.ts`
- `packages/openclaw-agent-vm-plugin/src/zone-git-tool.ts`
- `packages/openclaw-agent-vm-plugin/src/zone-git-tool.test.ts`
- `packages/agent-vm-worker/src/work-phase/controller-tools/controller-request-policy.ts`
- `packages/agent-vm-worker/src/work-phase/controller-tools/controller-request-policy.test.ts`
- `packages/agent-vm-worker/src/work-phase/controller-tools/controller-tool-support.ts`
- `packages/agent-vm-worker/src/work-phase/controller-tools/controller-tools.test.ts`

Red tests:

```bash
pnpm vitest run \
  packages/openclaw-agent-vm-plugin/src/controller-request-policy.test.ts \
  packages/openclaw-agent-vm-plugin/src/controller-lease-client.test.ts \
  packages/openclaw-agent-vm-plugin/src/zone-git-tool.test.ts \
  packages/agent-vm-worker/src/work-phase/controller-tools/controller-request-policy.test.ts \
  packages/agent-vm-worker/src/work-phase/controller-tools/controller-tools.test.ts
```

Test cases:

- a hung `lease-heartbeat` receives an `AbortSignal` and aborts at timeout
- `fetch` throwing transient `fetch failed` retries within `maxAttempts`
- HTTP 503 retries before returning success
- HTTP 400 does not retry
- unsafe `lease-create` does not retry on HTTP 503
- `publishOpenClawRuntimeStatus` success body is consumed
- `releaseLease` and `endActiveUse` drain success responses for future-proofing
- `zone-git-push` uses the bounded wrapper and carries an AbortSignal
- no direct controller `fetchImpl` remains outside `controller-request-policy.ts`
- worker `git-push` and `git-pull-default` use shared worker policy operations
- worker controller-tool transport failures emit or return classified failures

Implementation notes:

- `fetchControllerWithPolicy` inspects response status before returning
- retryable statuses are policy-driven
- each attempt creates its own timeout signal
- timeout errors are classified separately from HTTP errors
- caller-owned parsing remains caller-owned
- operations that ignore the body call `drainControllerResponseBody(response)`
- `openclaw-plugin-registration.ts` replaces `publishRuntimeStatusWithRetry`
  internals with the policy operation `openclaw-runtime-status`
- agent-vm-worker keeps its wrapper in its own package and imports only shared
  operation names/policy defaults from `@agent-vm/gateway-interface`
- worker health events are emitted for `worker-push-branches` and
  `worker-pull-default` only; `worker-task-create` and `worker-task-close` are
  controller-host/external routes and remain outside this policy table

Green command:

```bash
pnpm vitest run \
  packages/openclaw-agent-vm-plugin/src/controller-request-policy.test.ts \
  packages/openclaw-agent-vm-plugin/src/controller-lease-client.test.ts \
  packages/openclaw-agent-vm-plugin/src/zone-git-tool.test.ts \
  packages/agent-vm-worker/src/work-phase/controller-tools/controller-request-policy.test.ts \
  packages/agent-vm-worker/src/work-phase/controller-tools/controller-tools.test.ts
```

### Task 3: Add Controller Health Event Store And Routes

Files:

- `packages/agent-vm/src/controller/health/health-event-store.ts`
- `packages/agent-vm/src/controller/health/health-event-store.test.ts`
- `packages/agent-vm/src/controller/http/controller-health-event-routes.ts`
- `packages/agent-vm/src/controller/http/controller-health-event-routes.test.ts`
- `packages/agent-vm/src/controller/http/controller-http-routes.ts`
- `packages/agent-vm/src/controller/http/controller-zone-operation-routes.ts`
- `packages/agent-vm/src/controller/controller-runtime-types.ts`
- `packages/agent-vm/src/controller/controller-runtime.ts`

Routes:

```text
POST /zones/:zoneId/health-events
GET  /zones/:zoneId/health-snapshot
```

Route behavior:

- `POST /zones/:zoneId/health-events` accepts one `AgentVmHealthEvent`
- route rejects mismatched body `zoneId`
- route rejects unknown event shape
- route records event and returns `{ ok: true }`
- `GET /zones/:zoneId/health-snapshot` always returns 200 when the controller
  can derive a snapshot
- body carries `kind: "ok" | "stale" | "failed" | "unknown"`
- reserve 5xx for route/store failures

Red tests:

```bash
pnpm vitest run \
  packages/agent-vm/src/controller/health/health-event-store.test.ts \
  packages/agent-vm/src/controller/http/controller-health-event-routes.test.ts
```

Test cases:

- store keeps latest events by `(zoneId, kind, discriminator)`
- store bounds retained event history
- snapshot derives through gateway-interface reducer
- invalid event returns HTTP 400
- mismatched zone returns HTTP 400
- unhealthy snapshot still returns HTTP 200 with failed body

Green command:

```bash
pnpm vitest run \
  packages/agent-vm/src/controller/health/health-event-store.test.ts \
  packages/agent-vm/src/controller/http/controller-health-event-routes.test.ts
```

### Task 4: Record Controller-Observed Health Events

Files:

- `packages/agent-vm/src/controller/http/controller-http-routes.ts`
- `packages/agent-vm/src/controller/http/controller-http-routes.test.ts`
- `packages/agent-vm/src/controller/leases/lease-manager.test.ts`

Record events when the controller itself observes a boundary:

- `POST /lease/:leaseId/renew` emits `lease-renew`
- `POST /lease/:leaseId/uses/:useId/heartbeat` emits `lease-heartbeat`
- failed lease renew/heartbeat emits failed health event before returning error
- global `GET /health` remains a liveness endpoint and does not emit a
  zone-scoped health event

Add or preserve lease invariant tests:

- lease-heartbeat touches lease idle state
- lease-heartbeat prevents idle expiry
- expired active use cannot be hidden by a stale heartbeat
- lease-renew Tool VM probe failure is distinct from controller link failure
- repeating `lease-use-start` with the same active client-generated UUIDv7
  `useId` returns the same active use, proving lost-response retry safety
- repeating `lease-use-start` with a tombstoned `useId` still returns conflict
- global `GET /health` does not write a health event without zone context

Red command:

```bash
pnpm vitest run \
  packages/agent-vm/src/controller/http/controller-http-routes.test.ts \
  packages/agent-vm/src/controller/leases/lease-manager.test.ts
```

Green command:

```bash
pnpm vitest run \
  packages/agent-vm/src/controller/http/controller-http-routes.test.ts \
  packages/agent-vm/src/controller/leases/lease-manager.test.ts
```

### Task 5: Add Controller-Side Gateway Service Monitor

Files:

- `packages/agent-vm/src/controller/health/gateway-service-health-monitor.ts`
- `packages/agent-vm/src/controller/health/gateway-service-health-monitor.test.ts`
- `packages/agent-vm/src/controller/zone-runtimes/openclaw-zone-runtime.ts`
- `packages/agent-vm/src/controller/zone-runtimes/worker-zone-runtime.ts`
- `packages/agent-vm/src/controller/controller-runtime.ts`
- `packages/agent-vm/src/gateway/gateway-health-check.ts`

Behavior:

- controller periodically probes each running zone's gateway service using the
  existing `runGatewayHealthCheck` path
- each result records `gateway-service-health`
- the monitor has a bounded interval and does not block controller shutdown
- on probe failure, the event is recorded locally in the controller
- the existing `GET /zones/:zoneId/health` route remains as an on-demand live
  probe and also records the latest event

Red tests:

```bash
pnpm vitest run \
  packages/agent-vm/src/controller/health/gateway-service-health-monitor.test.ts \
  packages/agent-vm/src/controller/zone-runtimes/openclaw-zone-runtime.test.ts
```

Test cases:

- ok service probe records ok event
- failed service probe records failed event
- monitor `stop()` prevents later ticks
- on-demand `/zones/:zoneId/health` records an event

Green command:

```bash
pnpm vitest run \
  packages/agent-vm/src/controller/health/gateway-service-health-monitor.test.ts \
  packages/agent-vm/src/controller/zone-runtimes/openclaw-zone-runtime.test.ts
```

### Task 6: Add Gateway-Control-Link Monitor In OpenClaw Plugin

Files:

- `packages/openclaw-agent-vm-plugin/src/gateway-control-link-monitor.ts`
- `packages/openclaw-agent-vm-plugin/src/gateway-control-link-monitor.test.ts`
- `packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.ts`
- `packages/openclaw-agent-vm-plugin/src/gondolin-plugin-config.ts`
- `packages/openclaw-gateway/src/openclaw-lifecycle.ts`
- `packages/openclaw-gateway/src/openclaw-lifecycle.test.ts`

Behavior:

- monitor runs inside the gateway VM
- it calls `GET /health` through the bounded operation `controller-health`
- it publishes low-rate `gateway-control-link` health events through
  `POST /zones/:zoneId/health-events`
- `openclaw-lifecycle.ts` passes controller health config into the generated
  Gondolin plugin config so the in-VM monitor receives interval/backoff settings
- it never emits a controller request per lease heartbeat
- if publishing fails, it logs to local stderr with operation, elapsedMs, and
  error code
- consecutive failure count resets only after an ok controller-health response
- fetch failure and publish failure have distinct log messages
- consecutive failures back off the next monitor tick up to the configured
  ceiling
- timer is `unref()`ed

Red tests:

```bash
pnpm vitest run packages/openclaw-agent-vm-plugin/src/gateway-control-link-monitor.test.ts
```

Test cases:

- ok controller health publishes ok event
- HTTP 503 controller health increments consecutive failure count
- network timeout publishes or logs failed event
- publish failure logs locally and does not throw out of the timer
- failure count resets only on `response.ok`
- repeated failure schedules the next tick using backoff cadence, not the base
  interval
- OpenClaw lifecycle test proves the health config is present in the plugin
  config passed into the gateway VM
- timer stop prevents later ticks

Green command:

```bash
pnpm vitest run packages/openclaw-agent-vm-plugin/src/gateway-control-link-monitor.test.ts
```

### Task 7: Report Tool VM SSH Health Without Extra Traffic

Files:

- `packages/openclaw-agent-vm-plugin/src/sandbox-backend/tool-vm-ssh-operation-guard.ts`
- `packages/openclaw-agent-vm-plugin/src/sandbox-backend/tool-vm-ssh-operation-guard.test.ts`
- `packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-handle-factory.ts`

Behavior:

- existing SSH guard emits `tool-vm-ssh` health events for real operations
- do not add a new periodic SSH poll in this task
- operation discriminator values are exactly:
  - `command`
  - `file-bridge`
  - `finalize`
  - `probe`
- stale lease invalidation remains the recovery behavior for SSH failure

Red tests:

```bash
pnpm vitest run packages/openclaw-agent-vm-plugin/src/sandbox-backend/tool-vm-ssh-operation-guard.test.ts
```

Test cases:

- successful command operation emits ok `tool-vm-ssh`
- failed command operation emits failed `tool-vm-ssh`
- probe operation uses `operation: "probe"`
- health event publish failure does not mask the original SSH error

Green command:

```bash
pnpm vitest run packages/openclaw-agent-vm-plugin/src/sandbox-backend/tool-vm-ssh-operation-guard.test.ts
```

### Task 8: Configuration

Files:

- `packages/agent-vm/src/config/system-config.ts`
- `packages/agent-vm/src/config/system-config.test.ts`
- `packages/openclaw-gateway/src/openclaw-lifecycle.ts`
- `packages/openclaw-gateway/src/openclaw-lifecycle.test.ts`
- `docs/reference/configuration/system-json.md`

Add config under controller runtime health:

```jsonc
{
	"controller": {
		"health": {
				"enabled": true,
				"gatewayServiceIntervalMs": 10000,
				"gatewayControlLinkIntervalMs": 10000,
				"gatewayControlLinkBackoffCeilingMs": 120000,
				"staleAfterMs": 30000,
				"eventHistoryLimit": 500
		}
	}
}
```

Defaults:

- enabled: `true`
- gatewayServiceIntervalMs: `10_000`
- gatewayControlLinkIntervalMs: `10_000`
- gatewayControlLinkBackoffCeilingMs: `120_000`
- staleAfterMs: `30_000`
- eventHistoryLimit: `500`

Red tests:

```bash
pnpm vitest run packages/agent-vm/src/config/system-config.test.ts
```

Test cases:

- defaults are applied
- invalid negative intervals are rejected
- disabling health disables periodic monitors but keeps routes available
- staleAfterMs must be greater than zero
- gatewayControlLinkBackoffCeilingMs must be at least gatewayControlLinkIntervalMs
- OpenClaw lifecycle threads controller health config into the generated
  Gondolin plugin config for the gateway VM

Green command:

```bash
pnpm vitest run packages/agent-vm/src/config/system-config.test.ts
```

### Task 9: Documentation And Manuals

Files:

- `AGENTS.md`
- `docs/architecture/overview.md`
- `docs/architecture/agent-worker-gateway.md`
- `docs/architecture/openclaw-gateway.md`
- `docs/subsystems/controller.md`
- `docs/subsystems/gondolin-vm-layer.md`
- `docs/subsystems/worker-task-pipeline.md`
- `docs/reference/configuration/system-json.md`
- `packages/agent-vm/src/cli/manual-templates.ts`
- `packages/agent-vm/src/cli/manual-templates.test.ts`

Docs content:

- explain controller, gateway VM, gateway-service, Tool VM boundaries
- explain that OpenClaw is one gateway-service implementation
- explain the two `tcpHosts` paths separately:
  - gateway VM -> controller
  - gateway VM -> Tool VM SSH
- explain `lease-heartbeat` and avoid the old internal label
- explain that `lease-heartbeat` and `lease-renew` both keep lease state alive
  when successful, but diagnose different boundaries
- explain health events and zone health snapshots
- explain what is in memory and lost on controller restart
- explain config knobs and defaults
- explain that OpenClaw application heartbeat is intentionally outside this
  infrastructure health model; if it is tracked later, it belongs in a
  domain-specific OpenClaw activity model, not gateway health
- explain worker gateway controller-tool request policies for
  `worker-push-branches` and `worker-pull-default`
- explain that gateway VM stderr/local logs are the only evidence when a broken
  gateway-control-link prevents failed health events from reaching the controller
- explain that smoke means live VM/e2e only; fake I/O tests are unit or
  integration tests

AGENTS.md should only add progressive-disclosure pointers, for example:

```md
For gateway health, control-link, lease-heartbeat, Tool VM SSH, and Gondolin
tcpHosts debugging, read docs/subsystems/controller.md,
docs/subsystems/gondolin-vm-layer.md, and
docs/architecture/openclaw-gateway.md before changing runtime behavior.
```

Red tests:

```bash
pnpm vitest run packages/agent-vm/src/cli/manual-templates.test.ts
```

Green command:

```bash
pnpm vitest run packages/agent-vm/src/cli/manual-templates.test.ts
```

### Task 10: Integration And E2E Verification

Automated unit/integration gates:

```bash
pnpm fmt:check
pnpm lint
pnpm lint:types
pnpm typecheck
pnpm test:unit
pnpm test:integration
pnpm check
```

Live smoke gates:

```bash
mise exec -- pnpm test:smoke
AGENT_VM_GONDOLIN_SMOKE=1 mise exec -- pnpm test:smoke
AGENT_VM_OPENCLAW_SMOKE=1 mise exec -- pnpm test:smoke
AGENT_VM_OPENCLAW_SMOKE=1 mise exec -- pnpm vitest run --config vitest.smoke.config.ts packages/agent-vm/src/integration-tests/openclaw-subagent-lease.smoke.test.ts
AGENT_VM_OPENCLAW_SMOKE=1 mise exec -- pnpm vitest run --config vitest.smoke.config.ts packages/agent-vm/src/integration-tests/live-openclaw-control-link.smoke.test.ts
```

Add:

`packages/agent-vm/src/integration-tests/live-openclaw-control-link.smoke.test.ts`

The live smoke suite must include:

- controller boots
- gateway VM boots
- gateway-service health is ok
- gateway VM can call controller `/health`
- OpenClaw plugin can create or reuse a Tool VM lease
- `lease-heartbeat` reaches controller with AbortSignal-backed timeout
- Tool VM SSH command works
- same-agent subagent spawn works with `/workspace` cwd
- concurrent same-agent subagent spawn is exercised and results are reported
- health snapshot shows recent gateway-service and gateway-control-link events

`live-openclaw-control-link.smoke.test.ts` assertions:

- boot a real OpenClaw smoke zone through the existing smoke harness
- poll `/zones/:zoneId/health-snapshot` until a fresh
  `gateway-control-link` event appears
- run a Tool VM command that starts a lease operation and produces a fresh
  `lease-heartbeat` or `lease-renew` event
- simulate a bounded controller request timeout using the same in-VM request
  wrapper against an unroutable controller URL, without stopping the real
  controller process
- assert the timeout returns in policy time, not OS TCP timeout time
- assert the failed publish path logs locally when the controller URL is
  unreachable

Manual beta smoke, before release:

```text
1. Install the exact built package set into beta using the repo-approved
   tarball or package update path.
2. Verify installed package source and version.
3. Start beta.
4. Send a normal text message and confirm reply.
5. Send an image/media message and confirm gateway does not crash.
6. Spawn one subagent and confirm it can read /workspace.
7. Spawn three same-agent subagents concurrently and record pass/fail output.
8. Run a Tool VM shell command from the parent agent.
9. Query /zones/<zoneId>/health-snapshot and capture the body.
10. Check logs for timeout classification, not unbounded hangs.
```

Manual smoke evidence belongs in:

`docs/wip/debugging/`

Use a date-prefixed file and include:

- package version or tarball path
- git commit
- zone id
- commands run
- health snapshot JSON
- log excerpts for failures
- pass/fail result for subagent and media tests

## Definition Of Done

All of these must be true before this branch is called ready:

- all controller communication from inside gateway services has an AbortSignal
- no direct OpenClaw plugin controller `fetch` remains outside the bounded
  request-policy module
- retryable HTTP statuses are handled in the shared wrapper
- unsafe mutations are not retried without idempotency keys
- lease-heartbeat is the user-facing term in docs and manuals
- lease-heartbeat and lease-renew are documented as separate health events that
  both keep lease state alive when successful
- controller records controller-observed lease health events
- controller periodically records gateway-service-health
- gateway VM periodically records or logs gateway-control-link health
- OpenClaw lifecycle passes health interval/backoff config into the gateway VM
  plugin config
- worker controller-tool requests for push/pull use shared bounded policy
  operations or a documented equivalent adapter
- gateway-control-link failure backoff is implemented and tested
- Tool VM SSH operation guard reports health without adding a new poller
- health event types use `as const` arrays and discriminated unions
- zone health snapshots use a discriminated union state machine
- AGENTS.md links to the detailed docs instead of copying the architecture
- generated manuals are updated and tested
- unit, integration, check, Gondolin smoke, and OpenClaw smoke commands have
  current output
- beta manual smoke includes text, image/media, Tool VM command, single
  subagent, concurrent subagents, and health snapshot evidence

## Review Request For Adversarial Agent

Ask the reviewer to focus on:

- whether every controller communication path from gateway code is actually
  bounded with AbortSignal
- whether the health model creates too much control-link traffic during a
  control-link failure
- whether `lease-heartbeat` and `lease-renew` semantics match
  `lease-manager.ts`
- whether unsafe controller mutations are retried anywhere
- whether the generic gateway-service boundary leaks OpenClaw-specific names
- whether the state machine can distinguish controller-link failure from Tool VM
  SSH failure
- whether docs and manuals teach the same model as the code
- whether the smoke plan is truly live/e2e and not mislabeled unit or
  integration coverage
