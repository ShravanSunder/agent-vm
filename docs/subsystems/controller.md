# Controller Subsystem

[Overview](../README.md) > [Architecture](../architecture/overview.md) > Controller

Deep dive into the controller runtime: startup lifecycle, HTTP API surface, lease management, gateway orchestration, worker task execution, and graceful shutdown. The controller is the host-side process that owns all VM lifecycles and never executes untrusted code.

---

## Runtime Lifecycle

`startControllerRuntime()` is the single entry point. It assembles every subsystem, wires dependencies via closures, and returns a `ControllerRuntime` handle with a `close()` method for teardown.

### Startup Sequence

```
  startControllerRuntime(options, dependencies)
    |
    |-- 1. Acquire the deployment ownership lock
    |      Holds runtimeDir/vm-ownership/controller-ownership.lock
    |      for the controller's complete lifetime
    |
    |-- 2. Resolve secrets
    |      createSecretResolver(systemConfig, createOpCliSecretResolver)
    |      Resolves 1Password service account token from configured source
    |      Builds composite resolver (1password | environment dispatch)
    |
    |-- 3. Create TCP pool
    |      createTcpPool({ basePort, size })
    |      Fixed array of port slots for tool VM SSH forwarding
    |
    |-- 4. Reconcile recorded VM cleanup evidence
    |      Validate schema-v2 deployment, Gateway-parent, VM, pid, and process identity
    |      Destroy recorded old Tool VM children before their Gateway
    |      Refuse malformed/mismatched/unproven evidence; adopt nothing
    |
    |-- 5. Create zone runtime registry
    |      Builds one runtime per selected zone
    |      OpenClaw and Worker zones dispatch by gateway type
    |
    |-- 6. Create lease manager
    |      createLeaseManager({ tcpPool, createManagedVm, now })
    |      Injects a narrow Tool VM creation closure and TCP slot bookkeeping
    |
    |-- 7. Start idle reaper
    |      createIdleReaper({ ttlForLease })
    |      TTL comes from the single leaseIdleTtl policy
    |      Attached to a 60-second interval timer
    |      Runs one immediate reap pass before accepting requests
    |
    |-- 8. Start selected gateway zones
    |      startGatewayZone({ secretResolver, systemConfig, zoneId })
    |      Image build, Gateway epoch admission, VM boot, runtime record, health check
    |
    |-- 9. Wire operations + task runner
    |      OpenClaw zones: zone runtime operations + stopController
    |      Worker zones:   worker task runtime + push/pull/close + stopController
    |
    |-- 10. Build Hono app
    |      createControllerService({ leaseManager, operations, workerTaskRunner })
    |      Mounts lease routes, zone operation routes, /health
    |
    |-- 11. Bind HTTP server
    |      startControllerHttpServer({ app, port: config.host.controllerPort })
    |
    v
  Returns ControllerRuntime { controllerPort, gateway?, close() }
```

### Shutdown Sequence

`close()` reverses startup in order:

```
  close()
    |-- 1. Mark runtime stopping
    |-- 2. Clear reaper interval timer
    |-- 3. Stop the gateway-service health monitor and await an in-flight tick
    |-- 4. Seal each Gateway epoch and stop admitting Tool VM children
    |-- 5. Exact-destroy Tool VM children, then exact-destroy their Gateway
    |-- 6. Close HTTP server and flush controller evidence
    |-- 7. Release the deployment ownership lock last
    |-- If any disposition is incomplete, preserve owner-unsafe evidence and fail
```

The `stopController` operation (exposed via `POST /stop-controller`) follows the same sequence but triggers the HTTP server close on a 100ms delay so the response can flush before the socket drops.

Offline cleanup is the broken-controller path. `agent-vm controller cleanup --config <system-config> --zone <zone>` first acquires the same deployment-wide ownership lock held for the controller's full lifetime, then refuses to run while the configured controller health endpoint is reachable. `--force` skips only that advisory health probe; it never bypasses the ownership lock or exact-evidence validation. The lock is mutual exclusion, not destruction evidence.

Cleanup reads schema-v2 Tool records from `<stateDir>/tool-leases/<recordId>.json` before the zone's `<stateDir>/gateway-runtime.json`. Each record must match the canonical config path, controller port, project namespace, zone, session label, full Gateway parent identity, VM id, pid, and process command/start identity as applicable. Cleanup revalidates the live process and endpoint before signaling, deletes records only after the recorded process and relevant endpoint are absent, and never adopts an old VM. Old, malformed, mismatched, or otherwise unproven evidence fails closed and remains for operator diagnosis. This is the supported replacement for deployment-local broad `pkill -f qemu-system-*` commands.

Gateway subtree destruction runs at most four child dispositions concurrently.
When the bounded subtree attempt aborts or any exact child disposition remains
unproven, queued children do not start, the Gateway is not closed, and a
successor Gateway is refused until recorded cleanup evidence is resolved.

---

## HTTP API Routes

All routes are served by Hono on the configured `host.controllerPort` (default 18800). Routes are registered across two modules.

### Core Routes (controller-http-routes.ts)

| Method | Path | Description | Response |
|--------|------|-------------|----------|
| `GET` | `/health` | Liveness probe | `{ ok, port }` |
| `GET` | `/zones/:zoneId/health-snapshot` | Read the current in-memory zone health snapshot | Discriminated snapshot body |

### Zone Operation Routes (controller-zone-operation-routes.ts)

Registered conditionally -- only when `operations` or `workerTaskRunner` is provided.

| Method | Path | Description | Availability |
|--------|------|-------------|-------------|
| `GET` | `/controller-status` | System config and zone health | OpenClaw |
| `GET` | `/zones/:zoneId/health` | Live gateway health probe using the zone's `GatewayHealthCheck` | OpenClaw |
| `GET` | `/zones/:zoneId/service-health` | Live gateway service liveness probe using the zone's `serviceHealthCheck` when configured | OpenClaw |
| `GET` | `/zones/:zoneId/logs` | Gateway VM process logs | OpenClaw |
| `POST` | `/zones/:zoneId/credentials/refresh` | Re-resolve secrets, restart gateway | OpenClaw |
| `POST` | `/zones/:zoneId/destroy` | Stop gateway, release zone leases, purge state | OpenClaw |
| `POST` | `/zones/:zoneId/upgrade` | Rebuild image and restart gateway | OpenClaw |
| `POST` | `/zones/:zoneId/enable-ssh` | Enable SSH into gateway VM | OpenClaw |
| `POST` | `/zones/:zoneId/execute-command` | Run a shell command inside gateway VM; requires zone admin token when adminAccess is configured | OpenClaw |
| `POST` | `/zones/:zoneId/worker-tasks` | Submit a worker task (`requestTaskId`, prompt, repos, context) | Worker |
| `GET` | `/zones/:zoneId/tasks/:taskId` | Read worker task state snapshot | Worker |
| `POST` | `/zones/:zoneId/tasks/:taskId/close` | Request task cancellation | Worker |
| `POST` | `/stop-controller` | Graceful shutdown | Both |

Request bodies are validated with Zod schemas (`controller-request-schemas.ts`). Invalid payloads return 400 with structured `error` and `issues` fields.

`agent-vm controller ssh` intentionally exposes only an interactive SSH session.
It must reject `-- <remote command>` and `--print` so the CLI does not become an
unreviewed remote-command runner. Command execution inside a gateway VM is a
separate `/zones/:zoneId/execute-command` controller operation and is protected
by zone admin authorization when `adminAccess` is configured.

---

## Health Model

The agent-vm controller is global, but operational health is zone-scoped.
Operators debug the boundary that is sick for a specific zone: gateway VM,
gateway-service process, gateway-to-controller control link, lease routes,
Tool VM SSH, or worker controller-tool requests.

`GET /health` is only the global agent-vm controller liveness endpoint. It does
not emit a zone-scoped `controller-runtime` event because it has no zone
context.

Health snapshots and the bounded event history are in-memory controller state
for fast live reads. Accepted health and recovery events are also appended to
`<runtimeDir>/controller-health/events.jsonl` as diagnostic evidence. That
durable JSONL log is not backup state and is not authority for ownership,
destruction, adoption, or slot reuse. The controller owns lifecycle decisions;
schema-v2 runtime records plus revalidated process and endpoint identity are
durable cleanup evidence after a crash. Telemetry cannot substitute for that
evidence.

Operators can read the same zone-scoped health evidence through the CLI:
`agent-vm controller health --config <system-config> --zone <zone>` runs the
configured live readiness probe,
`agent-vm controller service-health --config <system-config> --zone <zone>` runs
the live gateway-service liveness probe, and
`agent-vm controller health-snapshot --config <system-config> --zone <zone>`
returns the current in-memory health snapshot.

```text
agent-vm controller
  |-- probes gateway-service through the zone runtime health check
  |     -> gateway-service-health
  |
controller -> gateway VM private ingress
  |-- Socket.IO control session
  |     -> gateway-control-session
  |-- gateway_control_rpc health_event
  |     -> agent-channel-provider-health
  |-- gateway_control_rpc lease_renew
  |     -> lease-renew
  |-- gateway_control_rpc lease_use_heartbeat
  |     -> lease-heartbeat
  |
Tool VM SSH guard
  |-- command, file-bridge, finalize, probe
        -> tool-vm-ssh
  |
automatic gateway VM restart
  |-- repeated gateway-service or control-session failures
        -> gateway-recovery
```

`lease-heartbeat` is the user-facing name for the active-use heartbeat sent over
`gateway_control_rpc`. It keeps an in-flight Tool VM use alive and touches the
lease when successful. `lease-renew` keeps an idle cached lease alive before
reuse. Both can extend lease state, but they diagnose different paths:
heartbeat means "an active operation still exists"; renew means "a cached lease
can be reused."

Bounded controller communication is operation-specific, not globally
aggressive. Health probes use short timeouts and no retry. Git push/pull and
lease-create operations use longer timeouts because normal work can legitimately
take longer. Unsafe mutations are not retried without an idempotency proof.

For OpenClaw zones, the controller can automatically recover from repeated
host-side gateway-service, control-session, or policy-enabled generic
channel-provider degradation. Dead control while Gateway service remains live
first requests bounded same-Gateway OpenClaw process recovery, replacing the
process and disposable control session while preserving the Gateway VM and
healthy Tool VMs. Gateway VM restart is outward escalation after process
recovery is exhausted or Gateway service/lifecycle evidence requires
replacement. The default Gateway-recovery budget has a 61 minute per-zone
cooldown and a 10 minute recovery deadline.
Generic channel-provider health has its own policy: `unhealthy-recoverable`
degrades readiness/status by default and feeds recovery only when
`restartGatewayOnRecoverable` is explicitly enabled, `transitioning` is observed
until its timeout, and `unhealthy-unrecoverable` is surfaced without restart by
default.

Gateway recovery action selection comes from the internal Gateway lifecycle
state after the same-Gateway process-recovery boundary has escalated. A running
or degraded Gateway is restarted. A stopped or cold-start-eligible failed
Gateway is cold-started after current ownership checks prove the old runtime
record and ingress port are safe. An owner-unsafe or ambiguous failed runtime
requires operator action. Failed or timed-out recovery attempts are recorded as
failed `gateway-recovery` events and do not freeze the monitor loop. After 3
consecutive failed automatic recoveries, the controller records
`gateway-recovery-suspended` and stops automatic recovery for that zone until
the 24 hour failed-recovery reset window expires.

Secret resolution failures are operation blockers, not inferred outage causes.
When a start, restart, credentials refresh, or cold-start fails with
`secret-resolution-failed`, status should surface it as the current recovery
blocker unless durable lifecycle evidence proves that operation was the first
outage transition.
Use `agent-vm controller credentials check --zone <zone>` to verify the same
gateway-zone secret resolution path without contacting the controller or
refreshing/restarting the gateway. Use `credentials refresh` only when the
operator intentionally wants the controller to refresh credentials and restart
the zone runtime.

---

## Gateway Zone Orchestrator

`startGatewayZone()` in `gateway-zone-orchestrator.ts` is the boot sequence for any gateway VM. The controller calls it once at startup for OpenClaw zones, and once per task for Worker zones. The full 15-step sequence is documented in the [gateway zone orchestrator architecture](../architecture/overview.md#gateway-zone-orchestrator). Key points for controller integration:

- Before a fresh OpenClaw tree is published, controller recovery adopts nothing: it validates v2 Tool and Gateway records, destroys verified old Tool runners before their Gateway parent, and refuses a successor when identity or endpoint absence is unproven.
- Gateway startup allocates an epoch seed before stock VM construction, attaches the returned VM id, starts the VM, captures pid/process identity, and persists `<stateDir>/gateway-runtime.json` before publishing the runtime. The ingress port is added when available.
- The controller holds the returned live VM handle for the zone lifetime. Normal teardown fences admission, destroys Tool children, terminates the exact recorded Gateway process, observes runner absence, calls stock `VM.close()`, verifies endpoint absence, and only then deletes the runtime record.
- Gateway-to-Tool command and file bytes stay on direct SSH. Socket.IO carries bounded control; health events and telemetry are not lifecycle authority.

---

## Lease Manager

The lease manager (`lease-manager.ts`) creates, tracks, and releases Tool VM
leases. In managed gateway mode it is driven by gateway-control RPC handlers,
not by VM-facing public HTTP lease routes.

### Lease Lifecycle

```
  gateway_control_rpc lease_create { callerContextId, profileId, agentWorkspaceDir, workMountDir, idleTtlMs? }
    |
    v
  resolveLeaseWorkMountDir()
    |-- 1. Require OpenClaw gateway path under /zone/<child> or
    |      /home/openclaw/.openclaw/state/sandboxes/<child>
    |-- 2. Reject the allowed-root boundaries themselves as too broad
    |-- 3. Translate workMountDir to hostWorkMountDir under <stateDir>/sandboxes or <zoneFilesDir>
    |-- 4. realpath + containment check
    |-- 5. For agent sandbox work mounts, seed first-boot files by agentId
    |
    v
  createLease()
    |-- 1. Lock on (zoneId, agentId)
    |-- 2. Existing same-agent lease?
    |       |-- profile/hostWorkMountDir/agentWorkspace mismatch -> 409 conflict
    |       |-- VM live -> reuse lease
    |       |-- VM dead -> close/evict/release TCP slot
    |-- 3. tcpPool.allocate()          Claim next free slot
    |-- 4. selectToolVmProfileForAgent()
    |       |-- zone.agentToolVmProfiles[agentId]
    |       |-- otherwise zone.defaultToolVmProfile
    |-- 5. Begin provisional Tool membership under the exact Gateway epoch
    |-- 6. createManagedVm(...)        Construct an unstarted ManagedVm via the injected factory
    |-- 7. Attach vm.id, vm.start(), capture pid + process-start identity
    |-- 8. Persist <stateDir>/tool-leases/<recordId>.json (schema v2)
    |-- 9. vm.enableSsh({ port })      Start SSH listener, validate exact server identity
    |-- 10. Commit membership + lease  Publish current lease only after durable evidence
    |
    |   On failure:
    |     exact-terminate a recorded runner; otherwise close only an unstarted/absent runner
    |     preserve evidence and quarantine the slot when identity/absence is unproven
    |
    v
  gateway_control_rpc lease_release
    |
    v
  releaseLease()
    |-- 1. Reject when active uses exist unless force=true
    |-- 2. Close SSH and terminate the exact recorded process
    |-- 3. Observe Gondolin runner + Tool SSH endpoint absent; stock VM.close()
    |-- 4. Delete runtime record and mark membership destroyed
    |-- 5. tcpPool.release(slot)       Return slot only after absence proof
```

Each lease holds: `id`, `zoneId`, `agentId`, `profileId`, `agentWorkspaceDir`,
`hostWorkMountDir`, `tcpSlot`, `vm` (ManagedVm handle), `sshAccess` (host, port,
client identity file, user, exact Ed25519 server identity), `createdAt`,
`lastUsedAt`, and `effectiveIdleTtlMs`. The
lease manager does not clean work mount files on release; OpenClaw-selected
lease work mounts are owned by the caller that supplied `workMountDir`.

Operator-visible lease counts are exposed through controller status and health
snapshot diagnostics. Managed gateway leases are otherwise created, renewed,
and released through the gateway control session. In-flight work uses active-use
start, heartbeat, and end messages; those active uses prevent idle reaping while
the command or file-bridge operation is still running. Use ids are caller-issued
UUIDv7 values so retries can be idempotent without another round-trip. Ended
uses leave short tombstones so a duplicate
start after a completed use is rejected instead of resurrecting old work.

Stale cached handles do not reacquire by calling normal `lease_create`.
`gateway_control_rpc lease_reacquire` is the controller-owned replacement path:
the plugin supplies stale evidence for the old lease id, and the controller
checks bounded old-lease authority plus the current caller context before
returning a replacement lease. Missing or mismatched authority returns a typed
denial such as `lease_authority_absent`, `caller_context_absent`,
`caller_context_session_mismatch`, or `ownership_denied`. The old lease id is
kept only as correlation evidence for the tombstone window. It must not be used
for later active-use, heartbeat, SSH, file, exec, or finalize work.

`workMountDir` is a gateway VM path, not a host path and not a `system.json`
field. It must name a concrete child path below `/zone` or
`/home/openclaw/.openclaw/state/sandboxes`; those roots are validation
boundaries and are rejected as mount targets. The controller resolves the
gateway path to `hostWorkMountDir` before handing it to the lease manager.
For the canonical name/location/storage vocabulary, see
[Lease Path Vocabulary](../architecture/storage-model.md#lease-path-vocabulary).

For OpenClaw leases, the route resolves `profileId` from the request `agentId`
and the zone's Tool VM policy. During the Socket.IO control-plane hard cutover,
managed OpenClaw zones may declare multiple trusted agents. The active policy is
`agentToolVmProfiles[agentId]` when present, otherwise the zone fallback
`defaultToolVmProfile`. Caller context must still be controller-vetted before a
Tool VM lease is issued: undeclared agents, mismatched session keys, and
cross-agent workspace/work-mount provenance fail closed.

### TCP Pool

`tcp-pool.ts` manages a fixed-size array of port slots. Each slot maps to `127.0.0.1:{basePort + slot}` on the host and appears as `tool-{slot}.vm.host:22` inside the gateway VM via Gondolin's synthetic DNS.

```
  Slot 0  ->  127.0.0.1:19000  ->  tool-0.vm.host:22
  Slot 1  ->  127.0.0.1:19001  ->  tool-1.vm.host:22
  ...
  Slot N  ->  127.0.0.1:{basePort+N}
```

Operations: `allocate()` returns the lowest free slot (throws if pool exhausted), `release(slot)` returns it, `portForSlot(slot)` computes the host port, `getAllMappings()` returns the full slot-to-address map for allocated slots.

### Idle Reaper

`idle-reaper.ts` prevents orphaned tool VMs from leaking resources. It runs on
a 60-second interval and releases any lease whose `lastUsedAt` exceeds its
effective idle TTL and has no active uses. If `leaseIdleTtl` is omitted, the
fallback remains 100
minutes for every lease.

```
  reapExpiredLeases()
    |-- Skip leases with activeUseCount > 0
    |-- Filter leases where (now - lastUsedAt) > effectiveIdleTtlMs
    |-- For each expired: releaseLease(leaseId)
    |   Sequential to avoid TCP slot allocation races
```

The reaper runs one immediate pass at the end of controller startup, before the first interval tick.

---

## Operations

`createControllerRuntimeOperations()` builds operations over a zone runtime
registry. Each route resolves the requested `zoneId`, checks that the operation
matches the zone gateway type, and returns typed HTTP errors for missing,
failed, or wrong-type zones.

| Operation | What It Does |
|-----------|-------------|
| `getStatus` | Calls `buildControllerStatus(systemConfig)` -- returns system configuration summary |
| `getZoneLogs` | Reads the OpenClaw gateway boot log and latest runtime log from `/agent-vm/logs` inside the gateway VM |
| `refreshZoneCredentials` | Builds a fresh resolver, preflights all gateway startup secret dependencies, then restarts the gateway zone with the preflighted resolver |
| `destroyZone` | Releases all zone leases (sequential), stops the gateway VM, optionally purges state |
| `upgradeZone` | Rebuilds the gateway image (no-op currently), then restarts the gateway zone |
| `enableSshForZone` | Calls `vm.enableSsh()` on the gateway VM |
| `execInZone` | Runs an arbitrary command inside the gateway VM via `vm.exec()` after zone admin authorization when configured |
| `stopController` | Clears reaper timer, releases all leases, stops gateway, closes HTTP server |

The `stopController` operation is available in both OpenClaw and Agent Worker Gateways. All other operations are OpenClaw-only.

---

## Worker Task Runner

Worker-mode zones do not start a gateway at boot. Instead, each task gets an ephemeral per-task VM. The `worker-task-runner.ts` module manages the full lifecycle.

### Task Phases

```
  runWorkerTask(options)
    |
    |== PRE-START (preStartGateway) ==========================
    |   1. Generate taskId (crypto.randomUUID)
    |   2. Create task state and non-backup task runtime roots
    |   3. Copy local worker tarball if AGENT_VM_WORKER_TARBALL_PATH set
    |   4. Create RealFS gitdirs under runtimeDir in parallel
    |      - Derive repo IDs from repo URLs, deduplicate
    |   5. Read .agent-vm/config.jsonc or .agent-vm/config.json from primary repo
    |   6. Deep-merge zone gateway config + project config
    |   7. Validate merged config against workerConfigSchema
    |   8. Write effective-worker.json to task state
    |   9. Resolve typed repo resources from each repo's
    |      .agent-vm/repo-resources.ts contract
    |  10. Start only selected repo-local Compose providers
    |  11. Register task in ActiveTaskRegistry
    |
    |== BOOT (startGatewayZone with zoneOverride) ============
    |   Mount task state at /state and task gitdirs at /gitdirs;
    |   keep /work/repos as VM-local rootfs/COW work-area storage
    |   Full orchestration: orphan cleanup, image, VM, bootstrap,
    |   start, health check, ingress
    |
    |== SUBMIT ================================================
    |   POST http://{vm}:{port}/tasks
    |   Body: { requestTaskId, prompt, repos, context }
    |
    |== POLL ==================================================
    |   GET http://{vm}:{port}/tasks/{taskId}
    |   Every 1 second until status is completed | failed | closed
    |   3 consecutive poll failures -> abort
    |   30-minute timeout (configurable via timeoutMs)
    |
    |== TEARDOWN (always runs in finally block) ===============
    |   1. Stop the prepared Worker runtime through controller-managed exact VM termination
    |   2. Stop selected repo resource Compose providers
    |   3. Check gitdirs for dirty/unpushed work
    |   4. Push, export recovery artifact, or discard before cleanup
    |   5. Deregister task from ActiveTaskRegistry
    |
    v
  Returns { taskId, finalState, taskRoot }
```

### Push Branches

`git-push-operations.ts` handles post-task branch pushing from the host (Zone 1), so the GitHub token never enters any VM. The `pushBranchesForTask()` function:

1. Validates every branch name starts with the task's `branchPrefix`.
2. Validates every repo URL is registered for the active task and appears at most once in the request.
3. Pushes branches for distinct repos concurrently. A single repo can have only one branch push per request because operations share one `.git` directory.
4. Pushes each branch using a token-authenticated HTTPS URL, refreshes the remote branch ref, and returns branch state.
5. Token values are scrubbed from error messages before surfacing.

PR creation is not part of `pushBranchesForTask()`. After the controller reports a successful push, the worker uses `gh pr create`; GitHub HTTP traffic is mediated by the controller proxy.

### Active Task Registry

`ActiveTaskRegistry` is an in-memory map keyed by `zoneId`. Each zone can have at most one active task at a time. Methods: `register(task)` (throws if zone already has a different task), `get(zoneId, taskId)`, `clear(zoneId, taskId)`.

---

## Dependency Injection Pattern

The controller uses a consistent function-and-closure pattern for dependency injection. No DI container, no decorators, no class hierarchies.

**Factory functions** accept an `options` object for configuration and a `dependencies` object for injectable collaborators:

```
  createLeaseManager(options: {
    tcpPool: TcpPool;
    createManagedVm: (...) => Promise<ManagedVm>;
    now: () => number;
  }): LeaseManager
```

Application startup constructs the stock Gondolin `ManagedVmProvider` once in
`composition/gondolin-managed-vm-provider.ts`. The aggregate provider never
enters controller domains. Runtime wiring injects only its neutral
`ManagedVmFactory`, image capability, and owned-directory capability where each
is needed; the lease manager receives the still narrower Tool VM creation
closure shown above.

**Runtime-level wiring** happens in `startControllerRuntime()`, which closes over all subsystems. Its `ControllerRuntimeDependencies` interface carries 11 optional overrides (`createSecretResolver`, `startGatewayZone`, `startHttpServer`, `createManagedToolVm`, `runWorkerTask`, `now`, `setIntervalImpl`, `clearIntervalImpl`, `deleteGatewayRuntimeRecord`, `onWorkerTaskPrepared`, `onWorkerTaskFinished`). Production defaults are imported at module scope and used when the corresponding dependency is absent. Every subsystem (`gateway-recovery.ts`, `gateway-zone-orchestrator.ts`, `idle-reaper.ts`, `worker-task-runner.ts`) follows this same pattern -- tests override individual collaborators without mocking internals.

---

## Source Files

All paths relative to `packages/agent-vm/src/controller/`.

| File | Responsibility |
|------|----------------|
| `controller-runtime.ts` | Top-level startup, shutdown, subsystem wiring |
| `controller-runtime-types.ts` | `ControllerRuntime`, `ControllerRuntimeDependencies`, `StartControllerRuntimeOptions` |
| `controller-runtime-operations.ts` | OpenClaw zone operations (destroy, upgrade, logs, credentials, exec, SSH) |
| `controller-runtime-support.ts` | Secret resolver factory, GitHub token resolution, zone lookup |
| `http/controller-http-routes.ts` | Hono app: lease routes + health, `createControllerService` |
| `http/controller-zone-operation-routes.ts` | Hono route registration for zone operations + worker tasks |
| `http/controller-http-route-support.ts` | `ControllerRouteOperations` type, lease serialization |
| `http/controller-request-schemas.ts` | Zod schemas for all request payloads |
| `http/controller-http-server.ts` | HTTP server binding (Hono serve) |
| `leases/lease-manager.ts` | Lease CRUD, VM creation, cleanup |
| `leases/tcp-pool.ts` | Fixed-size TCP port slot allocator |
| `leases/idle-reaper.ts` | TTL-based lease expiration |
| `worker-task-runner.ts` | Per-task VM lifecycle: pre-start, boot, submit, poll, teardown |
| `active-task-registry.ts` | In-memory map of active worker tasks by zone |
| `git-push-operations.ts` | Host-side git push with token scrubbing |
| `composite-secret-resolver.ts` | Dispatches by `SecretRef.source` to 1Password or env resolver |

Gateway-side files referenced by the controller (relative to `src/gateway/`): `gateway-zone-orchestrator.ts` (boot sequence), `gateway-recovery.ts` (orphan cleanup), `gateway-runtime-record.ts` (crash recovery persistence), `credential-manager.ts` (zone secret resolution).
