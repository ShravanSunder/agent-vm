# Controller Resilience and Gateway Health Monitoring -- Design Spec

## Problem Statement

The agent-vm controller manages a Gondolin QEMU micro-VM that runs a gateway process (OpenClaw or worker). Today, the controller has no ongoing awareness of the gateway's health after startup, no graceful shutdown on process signals, and no recovery from crashes on either side.

**Concrete failure modes:**

1. Gateway process crashes inside the VM -- the controller keeps routing ingress traffic to a dead endpoint. Users see failures but the controller reports healthy.
2. User hits Ctrl+C -- Node.js exits before `runtime.close()` runs. The QEMU VM persists as an orphan.
3. Controller is `kill -9`'d -- same orphan problem, but now on restart the controller fails with EADDRINUSE on the ingress port (18791) because the old QEMU process still holds it.
4. Gateway process hangs or enters a bad state -- no mechanism to restart it. The `processSpec.startCommand` only runs once during boot.

**Success criteria:** The controller detects gateway failure within 15 seconds, attempts recovery, shuts down cleanly on signals, and cleans up orphans on restart.

---

## Current Architecture (Relevant Parts)

```
Host (macOS)
+----------------------------------------------------+
|  Controller (Node.js / Hono)    :18800              |
|  +----------------------------------------------+  |
|  | controller-runtime.ts                        |  |
|  |   gateway: { vm, ingress, processSpec }      |  |
|  |   leaseManager (tool VMs)                    |  |
|  |   idleReaper (setInterval 60s)               |  |
|  +----------------------------------------------+  |
|                                                     |
|  Ingress proxy                  :18791              |
+----------------------------------------------------+
        |  (QEMU micro-VM, ~155ms cold boot)
        v
+----------------------------------------------------+
|  Guest VM                                           |
|  +----------------------------------------------+  |
|  | Gateway Process (OpenClaw)   :18789           |  |
|  | Health: HTTP GET /  on :18789                 |  |
|  | Logs: /tmp/openclaw.log                       |  |
|  +----------------------------------------------+  |
+----------------------------------------------------+
```

**Key observations from the code:**

- `waitForHealth()` in `gateway-zone-orchestrator.ts` is a recursive async function that polls up to 30 times with 500ms delay. It uses `managedVm.exec()` to run curl inside the VM. After startup succeeds, it is never called again.
- `GatewayProcessSpec` already has `healthCheck` (http or command) and `startCommand` -- everything needed for periodic health polling and restart.
- `createIdleReaper()` is a clean pattern: a factory that returns `{ reapExpiredLeases() }`, called by a `setInterval` timer created in `controller-runtime.ts`. The timer handle is stored and cleared on shutdown.
- The `ControllerRuntime.close()` method clears the reaper timer, releases all leases, closes the gateway VM, and closes the HTTP server. But nothing calls it on SIGTERM/SIGINT.
- `ManagedVm` exposes `exec()`, `close()`, and an `id` property. There is no `pid()` or `listAll()` -- the Gondolin SDK does not expose QEMU process handles to the adapter layer.
- The `sessionLabel` (e.g. `shravan-gateway`) is passed to `VM.create()`. This is the only identifying metadata available to match VMs across restarts.

---

## Design Options Explored

### A. Health Monitoring Strategy

#### Option A1: Periodic exec-based polling (reuse `waitForHealth` pattern)

Run the same health check command (`curl` for HTTP, arbitrary command for command-type) inside the VM at a fixed interval using `managedVm.exec()`.

- **Pro:** Reuses the existing `GatewayHealthCheck` type and `waitForHealth` logic exactly. No new abstractions. Tests the actual guest process, not just the QEMU process.
- **Pro:** The exec round-trip through Gondolin is fast (sub-100ms for a local curl) and the health check command is already defined in `GatewayProcessSpec`.
- **Con:** Requires the VM exec channel to be healthy. If Gondolin's exec pipe breaks, the health check fails even if the guest process is fine.
- **Cost:** One `managedVm.exec()` call every N seconds. Negligible CPU/memory.

#### Option A2: Monitor the QEMU process from the host

Use QEMU Monitor Protocol (QMP) or watch the host QEMU process status.

- **Pro:** Lower overhead than exec -- no guest interaction.
- **Con:** Only tells you the VM is alive, not that the gateway process inside it is healthy. A crashed OpenClaw process with a running QEMU is the primary failure mode we care about.
- **Con:** The Gondolin SDK does not expose QMP sockets or QEMU PIDs through its public API. We'd need to reach around the abstraction layer.
- **Verdict:** Rejected. The failure mode we need to detect is guest-process-level, not VM-level.

#### Option A3: Gateway pushes health to controller (heartbeat callback)

The gateway process inside the VM periodically POSTs to the controller's HTTP API.

- **Pro:** Push model -- no polling overhead.
- **Con:** Requires modifying the gateway process (OpenClaw) to add heartbeat reporting. OpenClaw is an external dependency we don't control.
- **Con:** Adds a network dependency (gateway must reach controller). Currently works via `controller.vm.host:18800` TCP host mapping, but adds coupling.
- **Verdict:** Rejected. Too invasive for the gateway side, and the exec-based approach is cheap enough.

**Decision: Option A1.** Periodic exec-based polling using the existing `GatewayHealthCheck` spec. Extract the health check logic from `waitForHealth` into a reusable `checkGatewayHealth` function, then build a periodic monitor on top of it.

### B. Failure Response Strategy

#### Option B1: Restart gateway process in-place

Re-run `processSpec.startCommand` inside the existing VM via `managedVm.exec()`.

- **Pro:** Fast (no VM reboot). The VM is already running; we just re-launch the process.
- **Pro:** Preserves VM state (filesystem, mounts, config). No need to re-run bootstrap.
- **Con:** If the VM itself is in a bad state (corrupt filesystem, wedged network), restarting the process won't help.
- **Cost:** Sub-second for the exec, then wait for health again.

#### Option B2: Destroy and recreate the entire VM

Call `vm.close()` then run the full `startGatewayZone()` flow.

- **Pro:** Clean slate -- handles VM-level corruption.
- **Con:** Slow (~2-5 seconds including image load and bootstrap). Overkill for the common case (process crash).
- **Con:** Complex to wire -- requires re-creating ingress, re-wiring the runtime reference.

#### Option B3: Tiered recovery (process restart -> full VM restart)

Try B1 first (N times with backoff). If it keeps failing, escalate to B2.

- **Pro:** Best of both worlds -- fast recovery for common case, full reset for persistent issues.
- **Con:** More complex state machine. The full VM restart (B2) requires careful coordination with leases, ingress, and the controller's reference to the gateway.

**Decision: Option B1 for now, with B3 as a future enhancement.** The common failure is a process crash inside a healthy VM. In-place restart with exponential backoff handles this. If the restart fails after N attempts, the monitor stops retrying and logs a critical error. Full VM restart (B2/B3) is deferred -- it requires rethinking how `controller-runtime.ts` holds the gateway reference, and that's a separate design concern.

### C. Signal Handling Strategy

#### Option C1: Signal handler in the CLI entrypoint

Add `process.on('SIGTERM', ...)` and `process.on('SIGINT', ...)` in the `controller start` command handler, calling `runtime.close()`.

- **Pro:** Simple, conventional. The CLI is where the process lifecycle is managed.
- **Pro:** `runtime.close()` already does the right thing (clear reaper, release leases, close VM, close HTTP server).
- **Con:** Need to handle re-entrancy (user hits Ctrl+C twice).
- **Con:** Need a timeout -- if `runtime.close()` hangs, force-exit.

#### Option C2: Signal handler inside `controller-runtime.ts`

The runtime registers its own signal handlers during startup.

- **Pro:** Encapsulated -- the runtime manages its own lifecycle.
- **Con:** Side-effectful. Signal handlers are global process state. A library registering global handlers is surprising and hard to test.
- **Verdict:** Rejected. Signal handling belongs in the entrypoint, not the library.

**Decision: Option C1.** The `controller start` command handler registers signal handlers. It holds a reference to the runtime and calls `runtime.close()` on SIGTERM/SIGINT. A 10-second timeout forces `process.exit(1)` if close hangs. Double-signal forces immediate exit.

### D. Orphan Cleanup Strategy

#### Option D1: PID file on the host

Write a PID file (e.g., `<stateDir>/controller.pid`) at startup. On next startup, read it, check if the process is still running, kill it.

- **Pro:** Solves EADDRINUSE. Simple to implement.
- **Con:** PID files are unreliable -- PID reuse means the stored PID might now belong to a different process.
- **Con:** Doesn't help with orphaned QEMU processes (we don't have the QEMU PID, the Gondolin SDK doesn't expose it).

#### Option D2: Lockfile with process validation

Write a lockfile containing both the controller PID and a startup timestamp. On startup, check if the PID is alive AND matches the expected process (by checking the command name).

- **Pro:** More reliable than bare PID file.
- **Con:** Still doesn't address the orphaned QEMU process.

#### Option D3: Port probe on startup

Before starting, check if port 18791 (ingress) and 18800 (controller) are already in use. If so, try to connect to the existing controller's stop endpoint. If that fails, kill the process holding the port.

- **Pro:** Directly solves the EADDRINUSE problem. Works regardless of PID file state.
- **Pro:** If an old controller is still running, sends it a clean stop signal first.
- **Con:** Requires finding the PID holding the port (via `lsof -i :18791`), which is platform-specific (macOS vs Linux).

#### Option D4: Gondolin session label matching

The Gondolin SDK receives a `sessionLabel` (e.g., `shravan-gateway`). If the SDK has a way to list or destroy sessions by label, we could clean up on startup. However, examining the code confirms the SDK does not expose any session listing or cleanup API.

- **Verdict:** Not available with current SDK.

**Decision: Option D3 (port probe) + Option D2 (lockfile).** On startup:

1. Write a lockfile with `{ pid, startedAt, controllerPort, ingressPort }` to `<cacheDir>/controller.lock`.
2. On startup, if the lockfile exists, try to reach the old controller's `/stop` endpoint.
3. If that fails, use `lsof -ti :<port>` to find and kill processes on the ingress and controller ports.
4. On clean shutdown, remove the lockfile.

This is pragmatic: the lockfile provides metadata for the common case, the port probe handles the crash case, and `lsof` is available on macOS (the only supported platform currently).

---

## Proposed Design

### New Files

| File                                                              | Responsibility                                       |
| ----------------------------------------------------------------- | ---------------------------------------------------- |
| `packages/agent-vm/src/controller/gateway-health-monitor.ts`      | Periodic health check + in-place restart logic       |
| `packages/agent-vm/src/controller/gateway-health-monitor.test.ts` | Tests for the monitor                                |
| `packages/agent-vm/src/controller/controller-lockfile.ts`         | Lockfile write/read/cleanup + port-based orphan kill |
| `packages/agent-vm/src/controller/controller-lockfile.test.ts`    | Tests for lockfile operations                        |

### Modified Files

| File                                                           | Change                                                                                                       |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `packages/agent-vm/src/controller/controller-runtime.ts`       | Wire health monitor (same pattern as idle reaper); wire lockfile; export health state                        |
| `packages/agent-vm/src/controller/controller-runtime-types.ts` | Add health monitor dependencies to `ControllerRuntimeDependencies`; add health status to `ControllerRuntime` |
| `packages/agent-vm/src/cli/commands/controller-definition.ts`  | Register SIGTERM/SIGINT handlers in `start` command                                                          |
| `packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts`   | Extract `checkGatewayHealth` as a standalone exported function (refactor `waitForHealth` to use it)          |

### Component: Gateway Health Monitor

```
createGatewayHealthMonitor(options) -> { checkHealth(), stop() }
```

**Behavior:**

- Runs a health check every `intervalMs` (default: 10,000ms = 10s)
- On failure, attempts to restart the gateway process via `exec(processSpec.startCommand)` inside the VM
- After restart, waits for health again (reuses `waitForHealth` with reduced maxAttempts)
- Restart attempts are naturally spaced by the polling interval (10s). No additional exponential backoff in v1 -- the fixed interval is sufficient since we cap at `maxConsecutiveFailures` (default: 5) anyway. Backoff can be added later if restart storms become a concern.
- After `maxConsecutiveFailures` (default: 5) consecutive failed restarts, stops retrying and transitions to `failed` state
- Exposes `runHealthCheck()` for on-demand checks (e.g., from the controller status endpoint) and `getStatus()` for synchronous status reads

**Interface:**

```typescript
interface GatewayHealthMonitorOptions {
	readonly checkHealth: () => Promise<GatewayHealthStatus>;
	readonly restartGatewayProcess: () => Promise<void>;
	readonly waitForHealthAfterRestart: () => Promise<void>;
	readonly onHealthChange?: (status: GatewayHealthStatus) => void;
	readonly intervalMs?: number; // default 10_000
	readonly maxConsecutiveFailures?: number; // default 5
}

type GatewayHealthStatus =
	| { readonly status: 'healthy' }
	| { readonly status: 'unhealthy'; readonly lastObservation: string }
	| { readonly status: 'failed'; readonly consecutiveFailures: number };

interface GatewayHealthMonitor {
	readonly getStatus: () => GatewayHealthStatus;
	readonly runHealthCheck: () => Promise<GatewayHealthStatus>;
	stop(): void;
}
```

**Why this shape:** The monitor is a pure logic unit with injected dependencies. It does not import `ManagedVm` or `GatewayProcessSpec` -- it receives `checkHealth` and `restartGatewayProcess` callbacks. This makes it trivially testable with fake timers and mock callbacks, following the same pattern as `createIdleReaper`.

### Component: Lockfile Manager

```
writeLockfile(path, data) -> void
readLockfile(path) -> data | undefined
removeLockfile(path) -> void
cleanupOrphanedProcesses(options) -> void
```

**Interface:**

```typescript
interface ControllerLockfileData {
	readonly pid: number;
	readonly startedAt: string; // ISO 8601
	readonly controllerPort: number;
	readonly ingressPort: number;
}

interface CleanupOrphanedProcessesOptions {
	readonly lockfilePath: string;
	readonly controllerPort: number;
	readonly ingressPort: number;
	readonly stopControllerUrl?: string; // e.g. http://127.0.0.1:18800/stop
}
```

**Cleanup sequence:**

1. Read lockfile. If present and PID is still alive, try HTTP POST to `stopControllerUrl`.
2. Wait up to 5 seconds for the old controller to shut down.
3. If ports are still occupied, run `lsof -ti :<port>` and `kill` the PIDs.
4. Remove stale lockfile.

### Component: Signal Handlers

In the `controller start` command handler:

```typescript
let shuttingDown = false;
const shutdown = async (): Promise<void> => {
	if (shuttingDown) {
		process.exit(1); // second signal = force exit
	}
	shuttingDown = true;
	const forceExitTimer = setTimeout(() => process.exit(1), 10_000);
	forceExitTimer.unref();
	try {
		await runtime.close();
	} finally {
		clearTimeout(forceExitTimer);
	}
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
```

**Why in the CLI, not the runtime:** Signal handling is a process-level concern. The runtime is a library that can be embedded in tests or other contexts. Global `process.on` belongs in the outermost shell.

---

## Tradeoffs Summary

| Decision                  | What we gain                                       | What we pay                                                      |
| ------------------------- | -------------------------------------------------- | ---------------------------------------------------------------- |
| Exec-based health polling | Direct guest-process health, reuses existing types | One exec per interval (~10s); fails if exec pipe breaks          |
| In-place process restart  | Sub-second recovery, preserves VM state            | Doesn't help if VM itself is broken                              |
| Signal handlers in CLI    | Clean shutdown on Ctrl+C/SIGTERM                   | CLI command handler grows ~15 lines                              |
| Port-probe orphan cleanup | Handles crash recovery without SDK support         | `lsof` is macOS-specific (acceptable -- only supported platform) |
| Lockfile                  | Fast path for clean shutdown detection             | Another file to manage; can become stale                         |

## What This Does NOT Cover (Deferred)

- **Full VM restart on persistent failure** -- requires rethinking how `controller-runtime.ts` holds and replaces the gateway reference, including re-wiring ingress. Separate design.
- **Multi-zone health monitoring** -- current controller only runs one zone. Health monitor is per-gateway, so it naturally extends when multi-zone is added.
- **Tool VM health monitoring** -- tool VMs are ephemeral (lease TTL). The idle reaper already handles cleanup. Health monitoring for tool VMs is a different concern.
- **Alerting/notifications** -- the monitor logs and exposes status via the controller API. External alerting (webhooks, desktop notifications) is deferred.
