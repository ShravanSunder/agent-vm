# Tool VM Active-Use Lifecycle Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` or
> `superpowers:executing-plans` to implement this plan task-by-task. Use TDD for
> behavior changes. Do not commit unless the human explicitly asks for git write
> operations.

**Goal:** Prevent the controller idle reaper from destroying an OpenClaw Tool VM
while a command or filesystem bridge operation is actively using it, without
turning the controller into a command/data proxy.

**Non-goal:** This plan does not redesign Tool VM networking, replace SSH,
introduce controller-proxied stdout/stderr, or model every future worker /
credentialed-runner identity. It adds the minimal generic lifecycle primitive
needed to keep an existing Tool VM lease alive while it is in use.

## Problem Model

Tool VM leases are long-lived capabilities. Tool VM command execution is a
shorter active operation against one lease. The current controller only tracks
`Lease.lastUsedAt`; it does not distinguish an idle lease from a lease with an
SSH command currently running.

Current shape:

```text
OpenClaw gateway VM
  |
  | asks controller for a lease
  v
controller LeaseManager
  |
  | creates Tool VM, enables SSH, returns leaseId + SSH capability
  v
OpenClaw executes through SSH over Gondolin tcpHosts

idle reaper:
  if now - lease.lastUsedAt > effectiveIdleTtlMs:
    releaseLease()
    vm.close()
```

That is insufficient for long commands because `lastUsedAt` is only a lease
touch timestamp. If renewal is missed, stale, or tied to a plugin-local timer,
the controller can close a Tool VM even though the data plane still has an
active SSH operation.

The corrected model separates three lifecycles:

```text
Lease lifecycle
  requested -> ready -> idle/active -> released

Active-use lifecycle
  start -> heartbeat* -> end
             |
             +-> stale if heartbeat expires

Transport lifecycle
  gateway ssh client -> tcpHosts raw tunnel -> Tool VM sshd
```

The controller owns lease and active-use state. Gondolin carries the SSH data
plane. OpenClaw remains the gateway runtime that starts sandbox operations.

## Evidence

Current agent-vm lease state lives in
`packages/agent-vm/src/controller/leases/lease-manager.ts`:

- `Lease` stores `id`, `lastUsedAt`, `tcpSlot`, `vm`, `sshAccess`, and mount
  details.
- `keepLeaseAlive(leaseId)` only touches `lastUsedAt`.
- `releaseLease(leaseId)` calls `vm.close()`, deletes the lease, and releases
  the TCP slot.

Current controller lease HTTP routes include a semantic bug in
`packages/agent-vm/src/controller/http/controller-http-routes.ts`:

- `GET /lease/:leaseId` calls `keepLeaseAlive(...)`.
- That means a read-shaped HTTP method mutates `lastUsedAt`.
- This plan must fix that API shape. New mutation endpoints must use `POST` or
  `DELETE`, and read endpoints must be side-effect-free.

Current idle reaping lives in
`packages/agent-vm/src/controller/leases/idle-reaper.ts`:

- `reapExpiredLeases()` releases any lease where `lastUsedAt` is older than
  the configured TTL cutoff.
- It has no way to ask whether a command is currently active.

Current OpenClaw adapter seams live in
`packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-handle-factory.ts`:

- `buildExecSpec(...)` returns the SSH argv that OpenClaw will run.
- `finalizeExec(...)` currently only disposes the SSH session token.
- `runShellCommand(...)` directly invokes the remote SSH helper for filesystem
  bridge operations.

The managed OpenClaw runtime version is pinned by
`packages/agent-vm/managed-images.json` (`openClawVersion: "2026.5.7"`). The
local adapter already depends on this sandbox backend contract shape:

```ts
export type SandboxBackendExecSpec = {
	argv: string[];
	env: NodeJS.ProcessEnv;
	stdinMode: "pipe-open" | "pipe-closed";
	finalizeToken?: unknown;
};

export type SandboxBackendHandle = {
	buildExecSpec(params: {
		command: string;
		workdir?: string;
		env: Record<string, string>;
		usePty: boolean;
	}): Promise<SandboxBackendExecSpec>;
	finalizeExec?: (params: {
		status: "completed" | "failed";
		exitCode: number | null;
		timedOut: boolean;
		token?: unknown;
	}) => Promise<void>;
	runShellCommand(params: SandboxBackendCommandParams): Promise<SandboxBackendCommandResult>;
};
```

OpenClaw's packed runtime calls `buildExecSpec`, spawns the returned argv through
its process supervisor, then calls `finalizeExec` after `managedRun.wait()`
resolves. This is the correct seam for protecting a Tool VM lease during
sandbox execution. Generic OpenClaw `before_tool_call` / `after_tool_call` hooks
are useful for audit and correlation, but they are not the precise Tool VM
lease-use lifecycle.

Gondolin mapped TCP is not the lifecycle source of truth. Its `tcp.hosts`
mapping is a raw tunnel path for guest-to-host TCP. HTTP/TLS hooks do not apply
to mapped TCP, and public Gondolin SDK does not expose per-tcpHosts stream
lifecycle hooks that agent-vm can rely on here.

## Design

Add a controller-owned active-use record for existing leases.

```ts
export interface ToolVmActiveUse {
	readonly useId: string;
	readonly leaseId: string;
	readonly startedAt: number;
	readonly lastHeartbeatAt: number;
	readonly expiresAt: number;
	readonly correlation?: ToolVmActiveUseCorrelation;
}

export interface ToolVmActiveUseCorrelation {
	readonly agentId?: string;
	readonly sessionId?: string;
	readonly sessionKey?: string;
	readonly toolCallId?: string;
	readonly toolName?: string;
}
```

`useId` is opaque and caller-generated using UUIDv7. It is not a composite ID
and not an OpenClaw `toolCallId`. Runtime-specific IDs are optional correlation
fields for logs, diagnostics, and tests.

Correlation field meanings:

- `agentId`: OpenClaw-provided agent identity, when available.
- `sessionId`: OpenClaw runtime/session identifier, when available.
- `sessionKey`: agent-vm lease scope/cache key. This is not necessarily the same
  value as `sessionId`.
- `toolCallId`: OpenClaw tool-call identifier, when available.
- `toolName`: human-readable OpenClaw tool name, when available.

Client-issued UUIDv7 gives idempotent retry behavior on flaky gateway-to-
controller links:

```text
client creates useId = uuidv7()
client POSTs start-use
response is lost
client retries same useId
controller sees existing active use and returns the same active-use state
```

Controller validation rules:

- `useId` must be a syntactically valid UUIDv7.
- `(leaseId, useId)` is unique.
- A duplicate start for an active `(leaseId, useId)` is idempotent and returns
  the existing active-use state.
- Ended use IDs are tombstoned for a bounded retry window; a duplicate start for
  a tombstoned use returns 409 so cleanup retries cannot accidentally resurrect
  a use.
- The controller never trusts `useId` for authorization. The caller must already
  hold a valid `leaseId`.

## Lease API Shape

Fix the existing mutating `GET /lease/:leaseId` route as part of this plan.

Target lease routes:

```text
POST   /lease                         create or reuse lease
GET    /lease/:leaseId/peek            read-only lease snapshot
GET    /leases                         read-only lease list; unchanged
POST   /lease/:leaseId/renew           renew idle lease timestamp
DELETE /lease/:leaseId                 release lease

POST   /lease/:leaseId/uses            start active use
POST   /lease/:leaseId/uses/:useId/heartbeat
DELETE /lease/:leaseId/uses/:useId     end active use
```

Rules:

- No `GET` route mutates lease state.
- This is a hard cutover. Existing `GET /lease/:leaseId` keepalive behavior is
  removed. If the route remains, it is a read-only snapshot alias and must not
  call `keepLeaseAlive`.
- Old OpenClaw plugin builds that still use `GET /lease/:leaseId` for renewal
  will no longer renew leases and can let cached Tool VM leases expire. Ship the
  plugin renew change and controller API change together.
- The OpenClaw plugin migrates from `GET /lease/:leaseId` to
  `POST /lease/:leaseId/renew` for cached-handle lease renewal.
- Active-use heartbeat is not lease renewal. Heartbeat renews a specific use and
  may touch the lease timestamp as a side effect of known active work.
- `POST /lease/:leaseId/renew` is lease-level idle keepalive for a quiet cached
  handle. `POST /lease/:leaseId/uses/:useId/heartbeat` is operation-level
  keepalive for work that is currently in progress. They are intentionally not
  interchangeable.

## Lease Creation TTL

Lease creation should accept an optional requested idle TTL. The requester knows
whether a lease is for a short one-off sandbox call, a normal warm Tool VM, or a
long interactive session.

Extend the create request:

```ts
interface ControllerLeaseCreateRequest {
	readonly agentWorkspaceDir: string;
	readonly idleTtlMs?: number;
	readonly profileId: string;
	readonly scopeKey: string;
	readonly workMountDir: string;
	readonly zoneId: string;
}
```

Controller behavior:

```text
if idleTtlMs is provided:
  validate min/max
  store effectiveIdleTtlMs on the lease
else:
  effectiveIdleTtlMs = ttlForLeaseScope(scopeKey)
```

The effective value belongs on the `Lease` record. The idle reaper should read
`lease.effectiveIdleTtlMs`, not recompute the value on every pass. This makes
the lease's lifetime contract stable after creation.

Reuse rule:

```text
POST /lease may reuse an existing live same-scope lease.

If the request omits idleTtlMs:
  reuse the existing lease and keep its original effectiveIdleTtlMs.

If the request includes idleTtlMs and it equals the existing effectiveIdleTtlMs:
  reuse the existing lease.

If the request includes idleTtlMs and it differs from the existing
effectiveIdleTtlMs:
  return 409 LeaseScopeConflictError.
```

Do not mutate a live lease's idle TTL during reuse. A lease's TTL is part of the
capability contract created with that lease.

Implementation seam: extend
`packages/agent-vm/src/controller/leases/lease-manager.ts`
`assertReusableScopeLease(...)` to compare the existing lease's
`effectiveIdleTtlMs` against a caller-provided requested TTL. It already checks
profile, host mount, guest workdir, zone git mount, and agent workspace; TTL
belongs in the same reusable-scope equality check. Mismatch must throw
`LeaseScopeConflictError`.

The config home should stay with the existing lease idle policy:

```ts
interface LeaseIdleTtlPolicy {
	readonly defaultMs: number;
	readonly maxRequestedMs: number;
	readonly minRequestedMs: number;
	readonly byScopeKind: Partial<Readonly<Record<LeaseScopeKind, number>>>;
	readonly byScopePrefix: Readonly<Record<string, number>>;
}
```

`byScopeKind` and `byScopePrefix` remain defaults when the caller does not
request an explicit `idleTtlMs`. `minRequestedMs` / `maxRequestedMs` bound
caller-requested values.

Active-use timeout is separate policy:

```ts
interface ToolVmUsePolicy {
	readonly endedUseTombstoneTtlMs: number;
	readonly heartbeatAfterMs: number;
	readonly heartbeatStaleMs: number;
}
```

Validate `ToolVmUsePolicy` at controller startup:

```text
heartbeatAfterMs > 0
heartbeatStaleMs >= heartbeatAfterMs * 3
endedUseTombstoneTtlMs > 0
```

The 3x heartbeat ratio gives one missed heartbeat plus retry jitter before a
use is marked abandoned. Without that invariant, a bad config can make every
active command stale before its first retry.

Do not collapse this into idle TTL:

```text
effectiveIdleTtlMs     lease with zero active uses
heartbeatStaleMs       individual active use without heartbeat
heartbeatAfterMs       client heartbeat cadence returned by controller
endedUseTombstoneTtlMs retry window for duplicate start/end idempotency
```

The active-use API is lease-local:

```text
POST   /lease/:leaseId/uses
POST   /lease/:leaseId/uses/:useId/heartbeat
DELETE /lease/:leaseId/uses/:useId
```

Request / response shape:

```ts
interface StartActiveUseRequest {
	readonly correlation?: ToolVmActiveUseCorrelation;
	readonly useId: string;
}

interface StartActiveUseResponse {
	readonly expiresAt: number;
	readonly heartbeatAfterMs: number;
	readonly useId: string;
}

interface HeartbeatActiveUseResponse {
	readonly expiresAt: number;
	readonly heartbeatAfterMs: number;
}

interface EndActiveUseRequest {
	readonly outcome: "completed" | "failed" | "cancelled" | "timed-out" | "abandoned";
}
```

Controller behavior:

```text
startActiveUse(leaseId, useId)
  - 404 if lease does not exist
  - validate useId is UUIDv7
  - create active use, or return existing active use for idempotent retry
  - set lastHeartbeatAt = now
  - set expiresAt = now + heartbeatStaleMs
  - touch lease.lastUsedAt
  - return heartbeat cadence

heartbeatActiveUse(leaseId, useId)
  - 404 if lease/use does not exist
  - update lastHeartbeatAt and expiresAt
  - touch lease.lastUsedAt

endActiveUse(leaseId, useId)
  - remove active use if present
  - tombstone ended useId until now + endedUseTombstoneTtlMs
  - touch lease.lastUsedAt
  - HTTP DELETE is idempotent for an existing lease:
      active use -> 204
      tombstoned use -> 204
      unknown use -> 204
  - unknown lease still returns 404
```

Tombstones gate duplicate `startActiveUse` retries after cleanup. They do not
drive `DELETE` behavior. `DELETE` remains idempotent for any `useId` on an
existing lease; tombstoned and unknown use IDs both return 204.

Touching `lease.lastUsedAt` on start, heartbeat, and end is intentional. While a
use is active, `activeUseCount > 0` protects the lease from idle reaping. After
the last use ends, the fresh `lastUsedAt` gives the cached Tool VM a full idle
TTL grace window for the next command.

Idle reaper behavior:

```text
for each lease:
  if activeUseCount(lease.id) > 0:
    skip
  else if lease.lastUsedAt < now - lease.effectiveIdleTtlMs:
    releaseLease(lease.id)
```

Active-use reaper behavior:

```text
for each active use:
  if use.expiresAt < now:
    mark abandoned and remove it

for each ended-use tombstone:
  if tombstone.expiresAt < now:
    remove tombstone

normal idle reaper can release the lease later once no active uses remain
```

Full reaper decision table:

```text
lease state                                 controller action
────────────────────────────────────────    ─────────────────────────────
has uses, all heartbeats fresh              keep lease
has uses, some stale                        mark stale uses abandoned
has uses, zero fresh after stale removal    if idle-expired, reap lease;
                                            otherwise keep lease
no uses, not idle-expired                   keep lease
no uses, idle-expired                       reap lease
force release requested                     close VM, drop active uses and
                                            tombstones, release TCP slot
```

The controller still terminates Tool VMs through Gondolin only when the lease is
idle and expired, or when a caller explicitly releases the lease.

Do not add periodic one-shot VM liveness probes to force-reap active leases in
v1. The current `isLeaseVmLive()` helper uses `vm.exec('true')` and treats any
thrown error as dead; using that during active-use reaping could kill a healthy
VM during a transient exec failure. Keep liveness probing limited to the
existing create/reuse path (`createLease` reuse-vs-evict) until there is a
stronger Gondolin liveness contract with retries/backoff.

## Runtime Flow

```text
OpenClaw tool call begins
      |
      v
OpenClaw sandbox backend buildExecSpec()
      |
      | POST /lease/:leaseId/uses
      | start heartbeat timer
      v
OpenClaw process supervisor runs returned SSH argv
      |
      | gateway VM -> tool-N.vm.host:22 -> Tool VM sshd
      | controller is not in stdout/stderr data path
      v
OpenClaw sandbox backend finalizeExec()
      |
      | stop heartbeat timer
      | DELETE /lease/:leaseId/uses/:useId
      v
lease becomes idle again
```

Filesystem bridge operations use the same primitive:

```text
runShellCommand() / fs bridge helper
  start active use
  heartbeat while promise is pending
  end active use in finally
```

Implementation detail: the fs bridge path must wrap the lease-context
`runRemoteShellScript` passed into `createFsBridgeBuilder`, not only the public
`runShellCommand()` method. In the current plugin, fs bridge operations are
constructed from the bound remote shell helper before the handle is returned.
Wrapping only `runShellCommand()` leaves `readFile`, `writeFile`, `mkdirp`,
`remove`, `rename`, and `stat` unprotected.

Generic OpenClaw tool hooks can attach correlation:

```text
before_tool_call:
  record toolCallId/toolName/session for adapter-local correlation

buildExecSpec:
  start active use with any known correlation

after_tool_call:
  audit result/duration; does not own lease safety
```

If correlation is unavailable at `buildExecSpec`, active-use still works. The
controller only needs `leaseId` and `useId` to prevent premature VM shutdown.

## Package Boundary

Do not bury active-use semantics inside the OpenClaw plugin. The controller API,
request/response types, UUIDv7 policy, and heartbeat helper are generic Tool VM
lease concepts. OpenClaw is a caller.

Preferred v1 location:

```text
packages/gateway-interface/src/tool-vm-active-use.ts
```

Responsibilities:

```text
ToolVmActiveUseCorrelation type
StartActiveUseRequest / Response types
HeartbeatActiveUseResponse type
ActiveUseHandle helper:
  start
  heartbeat timer
  end in cleanup
  idempotent disposal
```

OpenClaw-specific code remains in:

```text
packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-handle-factory.ts
```

That file adapts OpenClaw's `buildExecSpec`, `finalizeExec`, `runShellCommand`,
and fs bridge helper into the generic active-use helper. It should not define
the lifecycle model itself.

## Failure Cases

### buildExecSpec succeeds, command runs for 10 hours

The adapter has a `useId` and heartbeat timer. Heartbeats keep
`expiresAt` moving forward. Idle reaper skips the lease because active-use count
is nonzero.

### buildExecSpec throws before startActiveUse

No active use exists. The lease remains idle and follows normal TTL behavior.

### startActiveUse succeeds, then OpenClaw spawn fails

`finalizeExec` may not run if OpenClaw never reaches the managed run wait path.
The heartbeat timer may also never start if failure happens between active-use
start and token installation. Active-use expiry handles this: the use becomes
abandoned, then the lease returns to idle.

### finalizeExec is not called

The heartbeat eventually stops or never happens. Active-use expiry removes the
use. The idle reaper may later release the lease.

### gateway VM or OpenClaw process crashes

The controller receives no further heartbeats. Active uses expire. Leases return
to idle and are eventually reaped.

### controller crashes

Current lease state is in memory, so active-use state is also in memory for v1.
On controller restart, existing Tool VM cleanup follows the existing runtime
orphan/lease recovery behavior. This plan does not add durable active-use state.

### DELETE use races with heartbeat

End wins. The selected HTTP contract is no-op/idempotent `DELETE` for any
`useId` on an existing lease, so repeated cleanup returns 204. Heartbeat after
end should return 404 because the use is no longer active.

### Duplicate START arrives after END

This is why tombstones exist.

```text
1. client starts useId U
2. command completes
3. client ends useId U
4. a delayed retry of the original START for U arrives
```

Without a tombstone, the controller sees no active use and could create a new
active use for U. That resurrected use can keep the Tool VM active until
`heartbeatStaleMs` expires. With a tombstone, the delayed START returns 409 and
cannot resurrect completed work.

The tombstone is bounded by `endedUseTombstoneTtlMs` so long-lived warm leases
do not accumulate one remembered use ID forever.

### Explicit lease release while active use exists

`DELETE /lease/:leaseId` remains an operator/runtime command and may release the
lease. For accidental release, prefer returning HTTP 409 unless the caller sets
`force=true`. This preserves the current explicit-release power while making
accidental active release visible.

Force-release contract:

```text
releaseLease(leaseId, { force?: boolean })

force false / omitted:
  if activeUseCount > 0, refuse with active-lease conflict

force true:
  close VM, remove lease, remove active uses and tombstones, release TCP slot
```

Internal callers that intentionally tear down runtime state must pass force:

```text
startControllerRuntime releaseAllLeases / close path
createStopControllerOperation lease release loop
zone destroy / runtime stop operations
openclaw sandbox-backend-manager removeRuntime
SmokeHarnessRuntime.close and smoke-test afterAll cleanup paths
```

The idle reaper must not pass force. It should release only idle leases with
zero active uses.

## Task 1: Lease API Contract Tests First

- [ ] Add tests in `packages/agent-vm/src/controller/http/controller-http-routes.test.ts`
  proving:
  - `GET /lease/:leaseId` no longer mutates `lastUsedAt`.
  - `GET /leases` remains read-only and unchanged.
  - `POST /lease/:leaseId/renew` replaces the mutating keepalive route.
  - `POST /lease` accepts optional `idleTtlMs`.
  - requested `idleTtlMs` is stored as `effectiveIdleTtlMs` on the lease.
  - requested `idleTtlMs` below `minRequestedMs` or above `maxRequestedMs`
    returns 400.
  - when `idleTtlMs` is omitted, scope policy supplies the default.

Run:

```bash
pnpm vitest run --config vitest.config.ts packages/agent-vm/src/controller/http/controller-http-routes.test.ts --testNamePattern "lease.*renew|idleTtl|GET /lease"
```

Expected before implementation: FAIL.

## Task 2: Controller Active-Use Unit Tests

- [ ] Add tests in `packages/agent-vm/src/controller/leases/lease-manager.test.ts`
  for:
  - `startActiveUse()` accepts a client-issued UUIDv7 `useId`, sets expiry, and
    touches `lastUsedAt`.
  - `startActiveUse()` rejects non-UUIDv7 ids.
  - UUID validation is version-specific: UUIDv4-shaped values are rejected even
    if they are syntactically valid UUIDs.
  - duplicate start with the same active `(leaseId, useId)` is idempotent.
  - duplicate start with a tombstoned ended `(leaseId, useId)` returns conflict.
  - ended-use tombstones expire after `endedUseTombstoneTtlMs`.
  - `heartbeatActiveUse()` extends expiry and touches `lastUsedAt`.
  - `endActiveUse()` removes the active use and is HTTP-idempotent.
  - active uses are scoped to the lease id; wrong lease/use pairs do not mutate
    state.
  - `releaseLease()` without force refuses active leases.
  - forced `releaseLease()` closes the VM and removes active uses.
  - reused leases keep their original `effectiveIdleTtlMs`.
  - reuse with a mismatched requested `idleTtlMs` returns conflict.
  - `assertReusableScopeLease(...)` rejects effective TTL mismatches.

Run:

```bash
pnpm vitest run --config vitest.config.ts packages/agent-vm/src/controller/leases/lease-manager.test.ts --testNamePattern "active use|active-use|release"
```

Expected before implementation: FAIL.

## Task 3: Active-Use Reaper Tests

- [ ] Add `packages/agent-vm/src/controller/leases/active-use-reaper.test.ts`
  proving:
  - stale active uses are removed after `expiresAt`.
  - non-stale active uses remain.
  - expired ended-use tombstones are removed.
  - mixed stale/fresh uses leave the lease active.
  - all-stale uses can make the lease idle again.
  - all-stale uses on a lease that is not idle-expired are removed, and the
    lease remains alive.
  - removing a stale active use does not close the VM directly.
  - a lease with stale use removed can be released by the normal idle reaper
    later.

Run:

```bash
pnpm vitest run --config vitest.config.ts packages/agent-vm/src/controller/leases/active-use-reaper.test.ts
```

Expected before implementation: FAIL.

## Task 4: Idle Reaper Tests

- [ ] Update `packages/agent-vm/src/controller/leases/idle-reaper.test.ts` so
  `getLeases()` exposes active-use count, or inject an `isLeaseActive(leaseId)`
  callback.
- [ ] Prove idle reaper skips expired leases with active uses.
- [ ] Prove idle reaper keeps leases with no active uses when the lease is not
  idle-expired.
- [ ] Prove idle reaper still releases expired leases with no active uses.
- [ ] Prove idle reaper uses `lease.effectiveIdleTtlMs`, not a recomputed
  policy value.

Run:

```bash
pnpm vitest run --config vitest.config.ts packages/agent-vm/src/controller/leases/idle-reaper.test.ts
```

Expected before implementation: FAIL.

## Task 5: Controller Active-Use HTTP API Tests

- [ ] Add schemas in
  `packages/agent-vm/src/controller/http/controller-request-schemas.ts`.
- [ ] Add response schema/types near the existing lease response types.
- [ ] Add route tests in
  `packages/agent-vm/src/controller/http/controller-http-routes.test.ts` for:
  - start active use success.
  - duplicate start with same active UUIDv7 is idempotent.
  - start with malformed or non-v7 UUID returns 400.
  - heartbeat success via `POST /lease/:leaseId/uses/:useId/heartbeat`.
  - end success.
  - unknown lease returns 404.
  - malformed correlation returns 400.
  - repeated DELETE for the same use returns 204.
  - DELETE for an unknown use on an existing lease returns 204.
  - DELETE for an unknown lease returns 404.
  - release active lease returns 409 unless force is explicitly supported and
    requested.
  - `DELETE /lease/:leaseId?force=true` releases an active lease and clears
    active uses.

Run:

```bash
pnpm vitest run --config vitest.config.ts packages/agent-vm/src/controller/http/controller-http-routes.test.ts --testNamePattern "active use|active-use|lease release"
```

Expected before implementation: FAIL.

## Task 6: Controller Implementation

- [ ] Extend `LeaseManager` with:
  - `startActiveUse(leaseId, useId, options)`
  - `heartbeatActiveUse(leaseId, useId)`
  - `endActiveUse(leaseId, useId, outcome)`
  - `getActiveUseCount(leaseId)`
  - `reapExpiredActiveUses()`
- [ ] Keep active uses in memory.
- [ ] Add the `uuid` package to `packages/gateway-interface` and expose
  `createToolVmActiveUseId()` / `isToolVmActiveUseId(value)`. Use `v7()` for
  client-issued IDs, and validate with a UUIDv7-specific check
  (`validate(value) && version(value) === 7`). The controller should reuse this
  validator rather than accepting `crypto.randomUUID()` UUIDv4 values.
- [ ] Add `useHeartbeatStaleMs` and `useHeartbeatAfterMs` constants or config
  values. Start conservative:
  - heartbeat cadence: 30 seconds
  - heartbeat stale timeout: 2 minutes
- [ ] Validate active-use policy with `heartbeatStaleMs >= heartbeatAfterMs * 3`.
- [ ] Add bounded `endedUseTombstoneTtlMs`. Start conservative:
  - tombstone retention: 10 minutes
- [ ] Extend lease creation with optional `idleTtlMs`, validate it against
  `LeaseIdleTtlPolicy`, and store `effectiveIdleTtlMs` on `Lease`.
- [ ] Treat requested `idleTtlMs` mismatch on reused same-scope leases as a
  conflict by extending `assertReusableScopeLease(...)`.
- [ ] Wire active-use reaping into controller runtime alongside the idle reaper.
  It may share the same 60-second interval in v1.
- [ ] Update idle reaper input so active leases are skipped.
- [ ] Replace the mutating `GET /lease/:leaseId` keepalive path with
  `POST /lease/:leaseId/renew`.
- [ ] Update all intentional teardown paths to force release:
  - `startControllerRuntime` release-all / close path.
  - `createStopControllerOperation` lease release loop.
  - zone destroy / runtime stop operations.
  - `packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-manager.ts`
    `removeRuntime`.
  - smoke/integration harness cleanup.

## Task 7: OpenClaw Lease Client Tests

- [ ] Update
  `packages/openclaw-agent-vm-plugin/src/controller-lease-client.test.ts` for:
  - `renewLease()` uses `POST /lease/:leaseId/renew`, not `GET /lease/:leaseId`.
  - `startActiveUse()`
  - `heartbeatActiveUse()`
  - `endActiveUse()`
  - client generates UUIDv7 `useId`.
  - duplicate start retry sends the same UUIDv7.
  - idempotent cleanup behavior when end is repeated.
  - response shape validation.

Run:

```bash
pnpm vitest run --config vitest.config.ts packages/openclaw-agent-vm-plugin/src/controller-lease-client.test.ts --testNamePattern "active use|active-use"
```

Expected before implementation: FAIL.

## Task 8: Generic Gateway-Side Active-Use Helper

- [ ] Add a small helper in
  `packages/gateway-interface/src/tool-vm-active-use.ts`.
- [ ] Responsibilities:
  - export active-use request/response/correlation types.
  - generate caller-issued UUIDv7 use IDs.
  - start active use.
  - start heartbeat timer.
  - stop heartbeat timer.
  - end active use in cleanup.
  - tolerate cleanup 404s.
  - expose `dispose()` / `end()` for finalize tokens.
- [ ] Tests:
  - heartbeat starts after active use is created.
  - heartbeat stops on end.
  - `end()` is idempotent.
  - heartbeat failure is logged and does not crash the OpenClaw process.
  - cleanup attempts still happen after heartbeat failure.

Run:

```bash
pnpm vitest run --config vitest.config.ts packages/gateway-interface/src/tool-vm-active-use.test.ts
```

Expected before implementation: FAIL.

## Task 9: OpenClaw Backend Integration

- [ ] Update `sandbox-backend-handle-factory.ts`:
  - `buildExecSpec()` starts an active use before returning SSH argv.
  - the returned `finalizeToken` includes both the current SSH dispose token and
    the active-use handle.
  - `finalizeExec()` disposes SSH and ends active use.
  - `runShellCommand()` wraps the remote shell command in active-use start/end.
  - the `runRemoteShellScript` passed into `createFsBridgeBuilder` is wrapped
    so fs bridge operations also hold active use open.
- [ ] Keep the existing controller lease request/reuse behavior.
- [ ] Do not move stdout/stderr through the controller.
- [ ] Do not make OpenClaw generic tool hooks required for lease safety.
- [ ] Optional: attach known correlation fields when they are available from the
  adapter boundary.

Tests:

- [ ] `sandbox-backend-factory.test.ts`
  - build starts active use.
  - finalize ends active use.
  - finalize still disposes SSH if active-use end fails.
  - active-use end still runs if SSH dispose fails.
  - runShellCommand wraps start/end.
  - fs bridge operations wrap start/end through the lease-context
    `runRemoteShellScript`.
  - cleanup is idempotent.

Run:

```bash
pnpm vitest run --config vitest.config.ts packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.test.ts --testNamePattern "active use|finalizeExec|runShellCommand"
```

Expected before implementation: FAIL.

## Task 10: Documentation

- [ ] Update `docs/architecture/openclaw-gateway.md`:
  - explain lease lifecycle vs active-use lifecycle.
  - explain controller control plane vs gateway-to-Tool-VM data plane.
  - explain why `toolCallId` is correlation, not the active-use id.
  - define `sessionId` vs `sessionKey` if both are included in correlation.
  - explain why no `GET` route mutates lease state.
  - explain caller-requested `idleTtlMs` on lease creation.
- [ ] Update `docs/subsystems/controller.md`:
  - document active-use API routes.
  - document `POST /lease/:leaseId/renew`.
  - document that `GET /leases` remains a read-only list endpoint.
  - document that heartbeat is per-active-use and renew is per-lease.
  - document idle reaper skip rule.
  - document active-use reaper.
- [ ] Update generated manual text only if operators need to know the behavior.
  Do not add operational noise if the behavior is fully internal.

## Task 11: Integration / Smoke Tests

- [ ] Add a unit-level fake-clock test that simulates a command longer than the
  lease idle TTL:
  - lease is expired by timestamp.
  - active use exists and heartbeats.
  - idle reaper does not release.
  - active use ends.
  - idle reaper later releases.

- [ ] Add or extend an OpenClaw smoke test only if local Gondolin startup is
  reliable in this worktree:
  - boot OpenClaw gateway.
  - request Tool VM lease.
  - run a long SSH-backed command whose duration exceeds a very short test TTL.
  - prove the Tool VM remains reachable during the command.
  - prove it is reaped after active use ends and TTL expires.

Preferred first smoke target:

```bash
pnpm vitest run --config vitest.smoke.config.ts packages/agent-vm/src/integration-tests/openclaw-tool-vm-transport.smoke.test.ts
```

If the smoke is gated by local QEMU/Gondolin readiness, report that as an
environment blocker and keep the unit/integration active-use tests as the
required default gate.

## Quality Gates

Run targeted gates during implementation, then the broad repo gates before
claiming done:

The controller API change and OpenClaw plugin renewal change must ship together
as one hard cutover. Do not merge a controller that removes mutating
`GET /lease/:leaseId` while the plugin still depends on that route for lease
renewal.

```bash
pnpm fmt:check
pnpm lint
pnpm lint:types
pnpm typecheck
pnpm test:unit
pnpm test:integration
pnpm test:smoke
pnpm check
git diff --check
```

## Review Checklist

Reviewers should challenge these points:

- Does the plan keep the controller out of stdout/stderr and file data paths?
- Is `ToolVmActiveUse` minimal enough, or does it smuggle in unnecessary agent
  and worker modeling?
- Does idle reaping skip active leases without allowing leaked active uses to
  keep VMs forever?
- Does active-use expiry recover from OpenClaw/plugin/gateway failure?
- Are OpenClaw generic tool hooks treated as correlation/audit only, not as the
  lease safety primitive?
- Does every route and helper remain useful to a future non-OpenClaw caller
  that already has a Tool VM lease id?
- Are release races handled explicitly, especially active lease release and
  cleanup 404s?
