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
    |-- 1. Resolve secrets
    |      createSecretResolver(systemConfig, createOpCliSecretResolver)
    |      Resolves 1Password service account token from configured source
    |      Builds composite resolver (1password | environment dispatch)
    |
    |-- 2. Create TCP pool
    |      createTcpPool({ basePort, size })
    |      Fixed array of port slots for tool VM SSH forwarding
    |
    |-- 3. Create zone runtime registry
    |      Builds one runtime per selected zone
    |      OpenClaw and Worker zones dispatch by gateway type
    |
    |-- 4. Create lease manager
    |      createLeaseManager({ tcpPool, createManagedVm, now })
    |      Wires VM creation and TCP slot bookkeeping into the lease lifecycle
    |
    |-- 5. Start idle reaper
    |      createIdleReaper({ ttlForLease })
    |      TTL comes from leaseIdleTtl exact/prefix scope policy
    |      Attached to a 60-second interval timer
    |      Runs one immediate reap pass before accepting requests
    |
    |-- 6. Start selected gateway zones
    |      startGatewayZone({ secretResolver, systemConfig, zoneId })
    |      Full orchestration: orphan cleanup, image build, VM boot, health check
    |
    |-- 7. Wire operations + task runner
    |      OpenClaw zones: zone runtime operations + stopController
    |      Worker zones:   worker task runtime + push/pull/close + stopController
    |
    |-- 8. Build Hono app
    |      createControllerService({ leaseManager, operations, workerTaskRunner })
    |      Mounts lease routes, zone operation routes, /health
    |
    |-- 9. Bind HTTP server
    |      startControllerHttpServer({ app, port: config.host.controllerPort })
    |
    v
  Returns ControllerRuntime { controllerPort, gateway?, close() }
```

### Shutdown Sequence

`close()` reverses startup in order:

```
  close()
    |-- 1. Clear reaper interval timer
    |-- 2. Release all leases (sequential to avoid TCP slot races)
    |-- 3. Stop gateway zone: vm.close() + delete runtime record
    |-- 4. Close HTTP server
    |-- If any lease release failed, throw after server close
```

The `stopController` operation (exposed via `POST /stop-controller`) follows the same sequence but triggers the HTTP server close on a 100ms delay so the response can flush before the socket drops.

---

## HTTP API Routes

All routes are served by Hono on the configured `host.controllerPort` (default 18800). Routes are registered across two modules.

### Core Routes (controller-http-routes.ts)

| Method | Path | Description | Response |
|--------|------|-------------|----------|
| `GET` | `/health` | Liveness probe | `{ ok, port }` |
| `POST` | `/lease` | Create a tool VM lease | Lease with SSH access details |
| `GET` | `/lease/:leaseId` | Keep a lease alive and return agent-facing SSH access | Lease with SSH identity PEM |
| `GET` | `/lease/:leaseId/peek` | Inspect a lease without extending its idle timer | Lease summary without SSH identity PEM |
| `GET` | `/leases` | List all active leases | Array of lease summaries |
| `DELETE` | `/lease/:leaseId` | Release a lease, destroy its VM | 204 No Content |

### Zone Operation Routes (controller-zone-operation-routes.ts)

Registered conditionally -- only when `operations` or `workerTaskRunner` is provided.

| Method | Path | Description | Availability |
|--------|------|-------------|-------------|
| `GET` | `/controller-status` | System config and zone health | OpenClaw |
| `GET` | `/zones/:zoneId/health` | Live gateway health probe using the zone's `GatewayHealthCheck` | OpenClaw |
| `GET` | `/zones/:zoneId/logs` | Gateway VM process logs | OpenClaw |
| `POST` | `/zones/:zoneId/credentials/refresh` | Re-resolve secrets, restart gateway | OpenClaw |
| `POST` | `/zones/:zoneId/destroy` | Stop gateway, release zone leases, purge state | OpenClaw |
| `POST` | `/zones/:zoneId/upgrade` | Rebuild image and restart gateway | OpenClaw |
| `POST` | `/zones/:zoneId/enable-ssh` | Enable SSH into gateway VM | OpenClaw |
| `POST` | `/zones/:zoneId/execute-command` | Run a shell command inside gateway VM; requires zone admin token when adminAccess is configured | OpenClaw |
| `POST` | `/zones/:zoneId/worker-tasks` | Submit a worker task (`requestTaskId`, prompt, repos, context) | Worker |
| `GET` | `/zones/:zoneId/tasks/:taskId` | Read worker task state snapshot | Worker |
| `POST` | `/zones/:zoneId/tasks/:taskId/close` | Request task cancellation | Worker |
| `POST` | `/zones/:zoneId/tasks/:taskId/push-branches` | Push task branches from the host | Worker |
| `POST` | `/zones/:zoneId/tasks/:taskId/pull-default` | Refresh a repo's default branch from the host | Worker |
| `POST` | `/stop-controller` | Graceful shutdown | Both |

Request bodies are validated with Zod schemas (`controller-request-schemas.ts`). Invalid payloads return 400 with structured `error` and `issues` fields.

`agent-vm controller ssh` intentionally exposes only an interactive SSH session.
It must reject `-- <remote command>` and `--print` so the CLI does not become an
unreviewed remote-command runner. Command execution inside a gateway VM is a
separate `/zones/:zoneId/execute-command` controller operation and is protected
by zone admin authorization when `adminAccess` is configured.

---

## Gateway Zone Orchestrator

`startGatewayZone()` in `gateway-zone-orchestrator.ts` is the boot sequence for any gateway VM. The controller calls it once at startup for OpenClaw zones, and once per task for Worker zones. The full 15-step sequence is documented in the [gateway zone orchestrator architecture](../architecture/overview.md#gateway-zone-orchestrator). Key points for controller integration:

- **Step 1 (orphan cleanup)** runs `gateway-recovery.ts`: loads a persisted `GatewayRuntimeRecord` from `stateDir`, checks PID liveness via `kill(pid, 0)`, verifies the command matches `/qemu-system|krun/`, then sends SIGTERM (2s grace) and SIGKILL (2s grace). Non-managed PIDs cause a hard error. Record deletion failures produce a warning but do not block startup.
- **Step 15 (runtime record write)** persists pid, vmId, and zoneId so orphan cleanup works on next startup if the controller crashes.
- The controller holds the returned `{ vm, ingress, processSpec }` for the lifetime of the zone and uses `vm.close()` + runtime record deletion during shutdown.

---

## Lease Manager

The lease manager (`lease-manager.ts`) creates, tracks, and releases tool VM leases. It is the bridge between the HTTP API and the Gondolin VM layer.

### Lease Lifecycle

```
  POST /lease { zoneId, scopeKey, profileId, agentWorkspaceDir, workMountDir }
    |
    v
  resolveLeaseWorkMountDir()
    |-- 1. Require OpenClaw gateway path under /zone/<child> or
    |      /home/openclaw/.openclaw/state/sandboxes/<child>
    |-- 2. Reject the allowed-root boundaries themselves as too broad
    |-- 3. Translate workMountDir to hostWorkMountDir under <stateDir>/sandboxes or <zoneFilesDir>
    |-- 4. realpath + containment check
    |-- 5. For agent:<agentId> sandbox work mounts, seed first-boot files
    |
    v
  createLease()
    |-- 1. Lock on (zoneId, scopeKey)
    |-- 2. Existing same-scope lease?
    |       |-- profile/hostWorkMountDir/agentWorkspace mismatch -> 409 conflict
    |       |-- VM live -> reuse lease
    |       |-- VM dead -> close/evict/release TCP slot
    |-- 3. tcpPool.allocate()          Claim next free slot
    |-- 4. selectToolVmProfileForLease()
    |       |-- agent:<agentId> -> zone.agentToolVmProfiles[agentId]
    |       |-- otherwise zone.defaultToolVmProfile
    |-- 5. createManagedVm(...)        Boot a tool VM with the slot's port
    |-- 5. vm.enableSsh({ port })      Start SSH listener, get access details
    |-- 6. Build Lease record          id = "{zoneId}-{scopeKey}-{timestamp}"
    |-- 7. Store in leases Map
    |
    |   On failure at step 2-3:
    |     vm.close() (if created) then tcpPool.release(slot)
    |
    v
  DELETE /lease/:leaseId
    |
    v
  releaseLease()
    |-- 1. vm.close()                  Destroy the tool VM
    |-- 2. leases.delete(leaseId)      Remove from tracking map
    |-- 3. tcpPool.release(slot)       Return slot to pool
```

Each lease holds: `id`, `zoneId`, `scopeKey`, `profileId`, `agentWorkspaceDir`,
`hostWorkMountDir`, `tcpSlot`, `vm` (ManagedVm handle), `sshAccess` (host, port,
identity file, user), `createdAt`, and `lastUsedAt`. The lease manager does not
clean work mount files on release; OpenClaw-selected lease work mounts are owned
by the caller that supplied `workMountDir`.

`workMountDir` is a gateway VM path, not a host path and not a `system.json`
field. It must name a concrete child path below `/zone` or
`/home/openclaw/.openclaw/state/sandboxes`; those roots are validation
boundaries and are rejected as mount targets. The controller resolves the
gateway path to `hostWorkMountDir` before handing it to the lease manager.
For the canonical name/location/storage vocabulary, see
[Lease Path Vocabulary](../architecture/storage-model.md#lease-path-vocabulary).

For OpenClaw `agent:<agentId>` scopes, the route resolves `profileId` from the
zone's Tool VM policy. `agentToolVmProfiles[agentId]` wins when present;
otherwise the lease uses `defaultToolVmProfile`. This lets one zone serve
multiple agents with different disposable Tool VM images.

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
scope-specific TTL. If `leaseIdleTtl` is omitted, the fallback remains 30
minutes for every lease.

```
  reapExpiredLeases()
    |-- Compute ttlForLease(lease) from scopeKey
    |-- Filter leases where (now - lastUsedAt) > ttl
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
| `getZoneLogs` | Executes `cat {logPath}` inside the gateway VM, returns stdout |
| `refreshZoneCredentials` | Re-resolves zone secrets via `resolveZoneSecrets()`, then restarts the gateway zone |
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
    |   1. vm.close()
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
