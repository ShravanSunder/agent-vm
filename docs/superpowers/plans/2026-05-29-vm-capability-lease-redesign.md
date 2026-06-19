# VM Capability Lease Redesign Implementation Plan

Status: design / requires execution. Supersedes `docs/superpowers/plans/2026-05-22-credentialed-runner-v1.md` once this plan completes. Anchored against `origin/master` at the time of writing: post `#127` (Tool VM mediated placeholders over SSH) and post `#123` (gateway VM lease recovery).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a credentialed-runner specialization of `VmCapabilityLease<TTransport>` and a separate controller-owned runner lease manager that reuses the shipped gateway VM auto-recovery state machine, calls Gondolin native `vm.exec` / `vm.fs` through the widened adapter, and harmonizes runtime records, idle reap, and zone-runtime restart with the already-shipped Tool VM SSH lease.

**Architecture:** A new `RunnerCapLease extends VmCapabilityLease<'gondolin-rpc'>` lives alongside `ToolVmSshLease extends VmSshLease<'ssh-sandbox'>` in `@agent-vm/gateway-interface`. A separate `runner-lease-manager.ts` in `@agent-vm/agent-vm` owns the controller-side lifecycle: identity is `zoneId + profileId + providerId`, per-key lock serializes state transitions, liveness uses `vm.exec('true', { signal })` with a 5-second timeout, and runtime records persist under `<stateDir>/runner-leases/<recordId>.json`. A thin wrapper around the shipped gateway recovery tracker (`createGatewayVmRecoveryTracker`) drives runner backend evict-and-recreate decisions; the existing `OpenClawZoneRuntime.releaseZoneLeases` is widened to release runner leases for the zone on gateway restart. The runner lease is never exposed to the agent or the gateway VM; only the controller acquires and uses it.

**Tech Stack:** TypeScript 5.x, pnpm workspaces, Vitest, Zod, `@earendil-works/gondolin`, `@agent-vm/gateway-interface`, `@agent-vm/gondolin-adapter`, `@agent-vm/agent-vm`, `uuid` v7.

---

## Status And Scope

### What this plan replaces

This plan replaces `docs/superpowers/plans/2026-05-22-credentialed-runner-v1.md`. That file was written before the Gondolin adapter widening, gateway VM auto-recovery, and Tool VM mediated placeholders landed. Delete it as the final task of this plan only after the new plan is fully executed.

### What this plan does NOT design

These adjacent subsystems are explicitly out of scope; this plan is the lease substrate they sit on top of.

- **Credentialed tool catalog plugin.** Native OpenClaw tool registration, schema-driven argv builders, per-call schema validation, item-level approval, helper artifact generation, and tool discovery are a separate follow-up plan that consumes this lease layer. References to "the catalog plan" below refer to that future plan.
- **Credential state encryption.** Age identity resolution from 1Password, the on-disk encrypted state directory at `<stateDir>/credential-runner/profiles/<profile>/<provider>/realfs.age`, the maintainer-path setup commands, and the controller decrypt-on-mount / re-encrypt-on-release flow are a separate "credential state" plan. This plan accepts a `credentialMountSpec` as opaque input.
- **MCP Portal coexistence.** How credentialed tools and portal tools share the agent surface, share approval flows, or share catalog discovery is orthogonal. The runner lease has no MCP Portal dependency.
- **Runner VM image build.** The `vm-images/credentialed-tool-vm/` recipe, the bundled CLIs (`gogcli`, `ntn`, `linear`), and the runner image's hardening are consumed via a `RunnerVmProfile` config field, not designed here.

### What this plan DOES design

- `RunnerCapLease`, `RunnerLeasePeek`, and `RunnerLeaseId` types in `@agent-vm/gateway-interface`.
- `RunnerLeaseCompatibilityConflictError` and `RunnerBackendSuspendedError` typed errors.
- `RunnerCredentialMountSpec` envelope and `sourceFingerprint` derivation.
- `runner-lease-manager.ts` controller-side lifecycle (separate file from `lease-manager.ts`).
- `runner-vm-runtime-record.ts` durable record + crash-recovery semantics.
- `runner-vm-recovery.ts` startup cleanup (proves ownership host-side; no SSH, no VM internal).
- `runner-vm-recovery-tracker.ts` reuse of `createGatewayVmRecoveryTracker` for the runner backend.
- `system-config.ts` `credentialRunner` zone block.
- `OpenClawZoneRuntime.releaseZoneLeases` widening to release runner leases on zone restart.
- Storage contract for runner lease records (NOT credential state).
- Documentation updates in `docs/architecture/storage-model.md`, `docs/architecture/overview.md`, `docs/subsystems/controller.md`.

---

## Foundations — Shipped Primitives

Every contract below is anchored against current `origin/master`. The plan assumes these exports and behaviors are stable.

### VmCapabilityLease taxonomy (gateway-interface)

- `packages/gateway-interface/src/vm-capability-lease.ts:8-16` — `VmCapabilityLease<TTransport>` envelope (`leaseId`, `transport`).
- `packages/gateway-interface/src/vm-capability-lease.ts:18-31` — `VmSshEndpoint`, `VmSshPublicEndpoint`, `VmSshLease<TTransport>`.
- `packages/gateway-interface/src/tool-vm-lease.ts:11-17` — `ToolVmSshLease extends VmSshLease<'ssh-sandbox'>`.
- `packages/gateway-interface/src/tool-vm-lease-id.ts` — opaque branded UUIDv7 with `createToolVmLeaseId`, `isToolVmLeaseId`, `parseToolVmLeaseId`.

### Tool VM lease manager (reference behavior)

- `packages/agent-vm/src/controller/leases/lease-manager.ts:30-54` — `Lease` interface (identity is `zoneId + agentId`).
- `packages/agent-vm/src/controller/leases/lease-manager.ts:155-200` — `assertCompatibleAgentLeaseRequest` enforces compatibility on reuse.
- `packages/agent-vm/src/controller/leases/lease-manager.ts:208-225` — `isLeaseVmLive` uses `vm.exec('true', { signal })` with 5s timeout.
- `packages/agent-vm/src/controller/leases/lease-manager.ts` — `withAgentLeaseLock` keyed on `${zoneId}\0${agentId}` serializes create/renew/release/reap per agent.

### Widened Gondolin adapter

- `packages/gondolin-adapter/src/vm-adapter.ts:38-46` — `MANAGED_VM_DEFAULT_INGRESS_OPTIONS` (websockets on, no buffering, 512 MiB cap, 120s timeouts).
- `packages/gondolin-adapter/src/vm-adapter.ts:44-49` — `ManagedExecInput`, `ManagedExecOptions`, `ManagedExecProcess`, `ManagedExecResult`, `ManagedVmFs` aliases.
- `packages/gondolin-adapter/src/vm-adapter.ts:124-134` — `ManagedVm` with `fs: ManagedVmFs` and array-form `exec(input, options)`.
- Hard rule: `vm.fs` for VFS-mounted paths streams while exec is active; `vm.fs` for guest rootfs paths waits for exec idle. Runner artifact paths MUST live in VFS mounts.

### Gateway VM recovery state machine

- `packages/agent-vm/src/controller/health/gateway-vm-recovery-policy.ts:14-21` — `GatewayVmAutoRecoveryPolicy`.
- `packages/agent-vm/src/controller/health/gateway-vm-recovery-policy.ts:43-58` — `GatewayVmRecoveryDecision` (`none` | `restart` | `suspended`).
- `packages/agent-vm/src/controller/health/gateway-vm-recovery-policy.ts` — `createGatewayVmRecoveryTracker` is pure and does not bind to "gateway"; the decision ladder applies to any per-key VM backend.

### Zone runtime + restart contract

- `packages/agent-vm/src/controller/zone-runtimes/openclaw-zone-runtime.ts:120-145` — `releaseZoneLeases(zoneId)` with `force: true`; failures collected, not thrown.
- `packages/agent-vm/src/controller/zone-runtimes/openclaw-zone-runtime.ts:215-245` — `restart()` returns `leaseReleaseFailureCount`.
- Implication: gateway VM restart drops every lease in the zone. Runner leases must be released too (Task 14) so the next acquire cold-starts cleanly.

### Tool VM mediated env bootstrap (informational, not used by runner)

- `packages/agent-vm/src/tool-vm/tool-vm-lifecycle.ts:35-39` — bootstrap paths (`/etc/profile.d/agent-vm-mediated-env.sh`, `/etc/environment`, `/etc/ssh/sshd_config`).
- `packages/agent-vm/src/tool-vm/tool-vm-lifecycle.ts:40` — env name pattern `^[A-Za-z_][A-Za-z0-9_]*$`.
- `packages/agent-vm/src/tool-vm/tool-vm-lifecycle.ts:41` — reserved env names `{BASH_ENV, NODE_OPTIONS}`.
- `packages/agent-vm/src/tool-vm/tool-vm-lifecycle.ts:67-78` — value charset `[A-Za-z0-9_./:@%+=,-]`.

The runner backend uses Gondolin `tcpHosts` substitution directly (no SSH listener inside runner VM), so the SSH bootstrap script is not run. Mediated placeholders flow to the runner via `vm.exec` env, validated against the same name/value charsets at the manager boundary.

---

## Mental Model

```
VmCapabilityLease<TTransport>          gateway-interface envelope
        ▲
        │
        ├── VmSshLease<TTransport>     adds VmSshEndpoint
        │      ▲
        │      │
        │      └── ToolVmSshLease<'ssh-sandbox'>      shipped
        │           identity: zoneId + agentId
        │           caller: OpenClaw plugin via SSH
        │
        └── RunnerCapLease<'gondolin-rpc'>            this plan
             identity: zoneId + profileId + providerId
             caller: controller in-process via vm.exec / vm.fs
             no SSH, no agent-visible API, no plugin cache
```

Two specializations, two transport tags, two reasons-to-change:

- `ToolVmSshLease` exists because the OpenClaw plugin needs a shell-like SSH context per agent. Lifecycle is driven by plugin HTTP requests against the controller.
- `RunnerCapLease` exists because the controller needs a credential-bound exec context per `(profile, provider)`. Lifecycle is driven by controller-internal call sites; the agent never sees a lease handle.

Shared substrate:

- per-key lock pattern serialising state transitions
- runtime record on disk under `<stateDir>/<kind>-leases/<recordId>.json`
- liveness via `vm.exec('true', { signal })` with bounded timeout
- recovery state machine via `createGatewayVmRecoveryTracker`
- zone-scoped restart releases every lease in the zone, both kinds

---

## Identity And Compatibility Matrix

| Lease type           | Identity tuple                      | Reason the identity tuple has those components                                        |
| -------------------- | ----------------------------------- | ------------------------------------------------------------------------------------- |
| `ToolVmSshLease`     | `zoneId + agentId`                  | Agent owns a long-lived shell-like context inside Tool VM; one VM per agent per zone. |
| `RunnerCapLease`     | `zoneId + profileId + providerId`   | Credential state is `stateScope: 'profile-provider'`; one runner serves one pair.     |

Compatibility constraints for `RunnerCapLease` (enforced at acquire-time; mismatch throws a typed `RunnerLeaseCompatibilityConflictError`):

- `profileId` (identity component, must match for reuse)
- `providerId` (identity component, must match for reuse)
- `effectiveIdleTtlMs` — when explicitly requested
- `credentialMountSpec.sourceFingerprint` — derived hash of the credential source path + age recipient id; rotation forces a fresh runner

`credentialMountSpec.sourceFingerprint` is a controller-derived string. It is NOT the secret and NOT the encrypted state. It guards against a runner continuing to mount stale `/cred` after an operator rotated state.

---

## Lifecycle Contracts

### acquireRunnerLease

1. Acquire per-key lock keyed on `${zoneId}\0${profileId}\0${providerId}`.
2. If a live lease exists for the identity tuple:
   - If expired (`lastUsedAt + effectiveIdleTtlMs < now` AND `activeExecCount === 0`) → `evictLease` and fall through to fresh create.
   - Else: enforce compatibility; on mismatch throw `RunnerLeaseCompatibilityConflictError`. Liveness-probe via `vm.exec('true', { signal })` with 5s timeout. On success `touchLease` and return; on failure `evictLease` and fall through.
3. Allocate a runner-pool slot (separate `TcpPool` instance from Tool VM, configurable `basePort` and `size` in `system.json`).
4. `createManagedVm` with the configured runner image profile and the `credentialMountSpec.vfsMounts` as VFS mounts. The runner VM does NOT enable SSH.
5. Generate `RunnerLeaseId` (UUIDv7) and a separate `runtimeRecordId` (randomUUID).
6. Persist runtime record under `<stateDir>/runner-leases/<recordId>.json` before returning. On persistence failure: delete in-memory lease, close VM, rethrow.

### renewRunnerLease (internal validity gate)

Unlike Tool VM, the runner has no public HTTP renew route. `renewRunnerLease` is called by the in-process executor before submitting a typed exec to ensure the cached handle is still valid.

1. Per-key lock.
2. Missing lease → `{ kind: 'not-found', reason: 'missing' }`.
3. Idle-expired → `evictLease` → `{ kind: 'not-found', reason: 'expired' }`.
4. Liveness probe fails → `evictLease` → `{ kind: 'not-found', reason: 'dead' }`.
5. Else `touchLease` → `{ kind: 'renewed', lease }`.

### releaseRunnerLease

1. Per-key lock.
2. If `activeExecCount > 0` and `force` is not set: throw `RunnerExecConflictError`.
3. `vm.close()` → on success: release pool slot, delete runtime record.
4. On close failure: quarantine pool slot, preserve runtime record for next-startup cleanup.

### reapDeadIdleRunnerLeases

1. Iterate every live lease.
2. Per-key lock per lease.
3. Skip if `activeExecCount > 0`.
4. Liveness probe; if dead, `evictLease`.

### Active exec tracking

`RunnerLease` tracks `activeExecCount` (analog of Tool VM `activeUseCount`). `startRunnerExec(leaseId)` increments; `endRunnerExec(leaseId)` decrements. An active exec extends idle expiry but does NOT prove liveness. Concurrent execs against the same runner are serialized at the executor layer (separate plan) because credential state mutation is single-writer.

---

## Runner VFS And Credential State Interaction

This plan owns the lease + mount-spec envelope. The credential state plan provides the mount spec.

```ts
interface RunnerCredentialMountSpec {
  readonly sourceFingerprint: string;          // derived hash; not a secret
  readonly vfsMounts: readonly RunnerVfsMount[];
}

interface RunnerVfsMount {
  readonly guestPath: '/cred' | '/in' | '/cwd' | '/out';
  readonly provider: 'realfs' | 'memory' | 'readonly';
  readonly hostPath?: string;                  // required when provider === 'realfs' | 'readonly'
}
```

Mount kinds (all VFS-backed, NEVER guest rootfs):

- `/cred` — `RealFSProvider` against controller-decrypted state. Read-write so the CLI can rotate refresh tokens; controller re-encrypts on release (state plan).
- `/in` — `ReadonlyProvider` against controller-staged inputs.
- `/cwd` — `MemoryProvider`, empty per call.
- `/out` — `MemoryProvider` or controller-owned `RealFSProvider`; private until validation.

The lease manager treats the mount spec as a verbatim VFS mount list passed to `createManagedVm`. Mount construction (provider selection, host path resolution, decryption) lives in the state plan. This boundary keeps lease lifecycle independent of credential rotation timing.

---

## Recovery Harmonization

The shipped `createGatewayVmRecoveryTracker` is pure and does not bind to "gateway." We reuse it for runner backends with three call-site differences:

1. **Observation source.** A runner backend monitor calls `vm.exec('true', { signal })` with bounded timeout against each live runner lease at a configurable interval. There is no `/readyz` HTTP probe (runners have no HTTP listener) and no control link (runners are stateless from the controller's perspective).
2. **Recovery action.** Unlike gateway, a failed runner is NOT restarted in place. The decision `restart` becomes an "evict-and-cold-start-on-next-acquire" hint published as a health event. The next `acquireRunnerLease` call cold-starts.
3. **Suspended state.** When the tracker emits `suspended` for an identity tuple, `acquireRunnerLease` throws `RunnerBackendSuspendedError` until `failedRecoveryResetMs` elapses.

The tracker itself is unchanged. The reused decision shape `GatewayVmRecoveryDecision` is acceptable naming friction; renaming would require touching the shipped recovery policy file and is not justified.

Default `credentialRunner.recovery` policy:

```jsonc
{
  "enabled": true,
  "consecutiveFailureThreshold": 3,
  "cooldownMs": 60000,
  "failedRecoveryResetMs": 600000,
  "maxConsecutiveFailedRecoveries": 5,
  "restartTimeoutMs": 30000
}
```

---

## Restart And Reaping Semantics

| Event                                          | Tool VM SSH lease                  | Runner cap lease                                  |
| ---------------------------------------------- | ---------------------------------- | ------------------------------------------------- |
| gateway VM auto-recovery restart for zone Z    | released with `force: true`        | released with `force: true`                       |
| idle TTL expiry, no active exec/use            | reaped                             | reaped                                            |
| dead VM detected by liveness probe             | evicted                            | evicted                                           |
| controller stop (graceful)                     | released cleanly                   | released cleanly                                  |
| controller crash + restart                     | recovered via runtime record       | recovered via runtime record                     |
| credential state rotated (fingerprint change)  | not applicable                     | compatibility mismatch → 409, agent retries       |

Gateway restart wipes runner leases for the same zone via the widened `OpenClawZoneRuntime.releaseZoneLeases`. To make this work, that function must release both Tool VM and runner leases — see Task 14.

---

## Storage Contract

```
<stateDir>/
  tool-leases/<recordId>.json         shipped — Tool VM SSH lease record
  runner-leases/<recordId>.json       new — runner cap lease record
  credential-runner/profiles/...       separate plan — encrypted credential state
```

`runner-leases/<recordId>.json` schema (minimal — only fields that prove ownership and enable cleanup):

```ts
interface RunnerVmRuntimeRecord {
  readonly recordId: string;             // UUID, matches filename
  readonly leaseId: RunnerLeaseId;       // UUIDv7
  readonly zoneId: string;
  readonly profileId: string;
  readonly providerId: string;
  readonly vmId: string;
  readonly qemuPid: number;
  readonly poolSlot: number;
  readonly fences: {
    readonly controllerPort: number;
    readonly projectNamespace: string;
    readonly systemConfigPath: string;
  };
  readonly processIdentity: ProcessIdentity;  // imported from shared/managed-vm-process
  readonly createdAt: string;            // ISO string
}
```

Backup inclusion: NO. Runtime records are crash-recovery breadcrumbs only. Encrypted credential state IS backed up (separate plan).

---

## Security Invariants

1. The agent cannot acquire a runner lease directly. All acquisitions originate from controller-internal call sites bound to a trusted profile resolution from `ctx.agentId`.
2. The agent cannot select `profileId` or `providerId` as free-form arguments. Profile binding is config-driven and resolved by the catalog plan; this lease layer rejects untrusted identity-tuple input by accepting only `string` typed values validated against a `[a-z0-9][a-z0-9_-]{0,63}` pattern.
3. The runner lease is not exposed via any HTTP route in this plan.
4. Runner VMs run with no SSH listener and no agent-supplied shell surface. The controller calls only `ManagedVm.exec(argv: readonly string[], options)` and `ManagedVm.fs`.
5. The `credentialMountSpec.vfsMounts` source paths must be controller-validated against a configured allowed-root list before mounting; absolute paths supplied via untrusted config are rejected.
6. Runtime records persist only IDs, process identity, and pool slot. They NEVER persist credential paths, encryption keys, mount source content, or `sourceFingerprint` values.
7. Idle reap is bounded by the per-slot probe timeout (5 s). A slow probe cannot block the reap loop indefinitely.
8. The pool used for runner SSH-equivalent listener ports is a SEPARATE `TcpPool` instance from the Tool VM pool; ports MUST NOT overlap. Validation lives in config (Task 13).

---

## Non-Goals

- Do not design the typed catalog, schema-driven argv builder, or item-level approval. Those are in the catalog plan.
- Do not design credential state encryption, age identity resolution, or maintainer commands. Those are in the credential state plan.
- Do not expose runner leases via any controller HTTP route in this plan. If a diagnostics route is needed later, add it then.
- Do not unify `lease-manager.ts` and `runner-lease-manager.ts`. They stay separate files. A small per-key lock helper MAY be extracted if duplication is heavy (Task 7 step 3 evaluates), but extraction is not required.
- Do not migrate existing Tool VM SSH lease records, request shapes, or response shapes. The hard cutover (commit `9f8b29a`) is complete; this plan adds alongside.
- Do not implement a runner executor or in-process call site for credentialed tools. This plan ships the lease layer; the catalog plan ships the executor.

---

## File Structure

### Create

- `packages/gateway-interface/src/runner-lease-id.ts` — branded UUIDv7 type and helpers.
- `packages/gateway-interface/src/runner-lease-id.test.ts`
- `packages/gateway-interface/src/runner-lease.ts` — `RunnerCapLease`, `RunnerLeasePeek`, type guards.
- `packages/gateway-interface/src/runner-lease.test.ts`
- `packages/gateway-interface/src/runner-backend-errors.ts` — `RunnerLeaseCompatibilityConflictError`, `RunnerBackendSuspendedError`, `RunnerExecConflictError`.
- `packages/gateway-interface/src/runner-backend-errors.test.ts`
- `packages/agent-vm/src/controller/leases/runner-credential-mount-spec.ts`
- `packages/agent-vm/src/controller/leases/runner-credential-mount-spec.test.ts`
- `packages/agent-vm/src/controller/leases/runner-vm-runtime-record.ts`
- `packages/agent-vm/src/controller/leases/runner-vm-runtime-record.test.ts`
- `packages/agent-vm/src/controller/leases/runner-lease-manager.ts`
- `packages/agent-vm/src/controller/leases/runner-lease-manager.test.ts`
- `packages/agent-vm/src/controller/leases/runner-vm-recovery.ts`
- `packages/agent-vm/src/controller/leases/runner-vm-recovery.test.ts`
- `packages/agent-vm/src/controller/leases/runner-vm-recovery-tracker.ts`
- `packages/agent-vm/src/controller/leases/runner-vm-recovery-tracker.test.ts`

### Modify

- `packages/gateway-interface/src/index.ts` — export new types and errors.
- `packages/agent-vm/src/config/system-config.ts` — add `credentialRunner` zone block (pool, recovery, profile-binding stub).
- `packages/agent-vm/src/config/system-config.test.ts`
- `packages/agent-vm/src/controller/controller-runtime.ts` — instantiate `runner-lease-manager`, recovery tracker, and runner recovery startup hook; pass runner manager to `OpenClawZoneRuntime`.
- `packages/agent-vm/src/controller/controller-runtime.test.ts`
- `packages/agent-vm/src/controller/zone-runtimes/openclaw-zone-runtime.ts` — widen `releaseZoneLeases` to release runner leases too.
- `packages/agent-vm/src/controller/zone-runtimes/openclaw-zone-runtime.test.ts`
- `docs/architecture/storage-model.md` — add `runner-leases/` directory and document the boundary with encrypted credential state.
- `docs/subsystems/controller.md` — document the controller-internal runner lease manager.
- `docs/architecture/overview.md` — reference the runner capability lease in the lease-shapes diagram.

### Delete (final task)

- `docs/superpowers/plans/2026-05-22-credentialed-runner-v1.md` (Task 15, only after the rest of the plan is executed and CI passes).

### Not touched

- `packages/openclaw-agent-vm-plugin/*` — the runner lease is controller-internal; OpenClaw plugin still talks only Tool VM SSH lease.
- `packages/gondolin-adapter/src/vm-adapter.ts` — adapter widening is already shipped.
- `packages/openclaw-mcp-portal-plugin/*` — MCP Portal coexistence is a separate plan.

---

## Task 1: Define RunnerLeaseId opaque type

**Files:**
- Create: `packages/gateway-interface/src/runner-lease-id.ts`
- Test: `packages/gateway-interface/src/runner-lease-id.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway-interface/src/runner-lease-id.test.ts
import { describe, expect, it } from 'vitest';

import {
	createRunnerLeaseId,
	isRunnerLeaseId,
	parseRunnerLeaseId,
} from './runner-lease-id.js';

describe('RunnerLeaseId', () => {
	it('createRunnerLeaseId returns a UUIDv7 string', () => {
		const id = createRunnerLeaseId();
		expect(typeof id).toBe('string');
		expect(isRunnerLeaseId(id)).toBe(true);
	});

	it('isRunnerLeaseId rejects non-UUIDv7 strings', () => {
		expect(isRunnerLeaseId('not-a-uuid')).toBe(false);
		expect(isRunnerLeaseId('00000000-0000-4000-8000-000000000000')).toBe(false);
	});

	it('parseRunnerLeaseId throws on invalid input', () => {
		expect(() => parseRunnerLeaseId('not-a-uuid')).toThrow(TypeError);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/gateway-interface/src/runner-lease-id.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement RunnerLeaseId**

```ts
// packages/gateway-interface/src/runner-lease-id.ts
import { v7 as uuidv7, validate as validateUuid, version as uuidVersion } from 'uuid';

declare const runnerLeaseIdBrand: unique symbol;

export type RunnerLeaseId = string & {
	readonly [runnerLeaseIdBrand]: true;
};

export function createRunnerLeaseId(): RunnerLeaseId {
	return parseRunnerLeaseId(uuidv7());
}

export function isRunnerLeaseId(value: unknown): value is RunnerLeaseId {
	return typeof value === 'string' && validateUuid(value) && uuidVersion(value) === 7;
}

export function parseRunnerLeaseId(value: unknown): RunnerLeaseId {
	if (isRunnerLeaseId(value)) {
		return value;
	}
	throw new TypeError('Runner lease id must be an opaque UUIDv7 string.');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/gateway-interface/src/runner-lease-id.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway-interface/src/runner-lease-id.ts packages/gateway-interface/src/runner-lease-id.test.ts
git commit -m "feat(gateway-interface): add opaque RunnerLeaseId UUIDv7 type"
```

---

## Task 2: Define RunnerCapLease and RunnerLeasePeek

**Files:**
- Create: `packages/gateway-interface/src/runner-lease.ts`
- Test: `packages/gateway-interface/src/runner-lease.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway-interface/src/runner-lease.test.ts
import { describe, expect, it } from 'vitest';

import { createRunnerLeaseId } from './runner-lease-id.js';
import {
	isRunnerCapLease,
	isRunnerLeasePeek,
	type RunnerCapLease,
	type RunnerLeasePeek,
} from './runner-lease.js';

describe('RunnerCapLease', () => {
	const baseLease = {
		idleTtlMs: 300_000,
		leaseId: createRunnerLeaseId(),
		profileId: 'personal',
		providerId: 'google',
		transport: 'gondolin-rpc' as const,
		zoneId: 'shravan-claw',
	};

	it('accepts a valid runner cap lease', () => {
		const lease: RunnerCapLease = baseLease;
		expect(isRunnerCapLease(lease)).toBe(true);
	});

	it('rejects scopeKey-shaped objects', () => {
		expect(isRunnerCapLease({ ...baseLease, scopeKey: 'agent:foo' })).toBe(false);
	});

	it('rejects mismatched transport', () => {
		expect(isRunnerCapLease({ ...baseLease, transport: 'ssh-sandbox' })).toBe(false);
	});

	it('accepts a valid runner lease peek', () => {
		const peek: RunnerLeasePeek = {
			...baseLease,
			createdAt: 1_700_000_000_000,
			lastUsedAt: 1_700_000_500_000,
		};
		expect(isRunnerLeasePeek(peek)).toBe(true);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/gateway-interface/src/runner-lease.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement RunnerCapLease and RunnerLeasePeek**

```ts
// packages/gateway-interface/src/runner-lease.ts
import { isRunnerLeaseId, type RunnerLeaseId } from './runner-lease-id.js';
import {
	isVmCapabilityLease,
	type VmCapabilityLease,
} from './vm-capability-lease.js';

export interface RunnerCapLease extends VmCapabilityLease<'gondolin-rpc'> {
	readonly idleTtlMs: number;
	readonly leaseId: RunnerLeaseId;
	readonly profileId: string;
	readonly providerId: string;
	readonly zoneId: string;
}

export interface RunnerLeasePeek extends VmCapabilityLease<'gondolin-rpc'> {
	readonly createdAt: number;
	readonly idleTtlMs: number;
	readonly lastUsedAt: number;
	readonly leaseId: RunnerLeaseId;
	readonly profileId: string;
	readonly providerId: string;
	readonly zoneId: string;
}

const deprecatedScopeKeyPropertyName = ['scope', 'Key'].join('');

function objectValue(value: unknown): object | undefined {
	return typeof value === 'object' && value !== null ? value : undefined;
}

export function isRunnerCapLease(value: unknown): value is RunnerCapLease {
	const record = objectValue(value);
	return (
		isVmCapabilityLease(record, 'gondolin-rpc') &&
		isRunnerLeaseId(Reflect.get(record, 'leaseId')) &&
		typeof Reflect.get(record, 'idleTtlMs') === 'number' &&
		typeof Reflect.get(record, 'profileId') === 'string' &&
		typeof Reflect.get(record, 'providerId') === 'string' &&
		typeof Reflect.get(record, 'zoneId') === 'string' &&
		!Reflect.has(record, deprecatedScopeKeyPropertyName)
	);
}

export function isRunnerLeasePeek(value: unknown): value is RunnerLeasePeek {
	const record = objectValue(value);
	return (
		isVmCapabilityLease(record, 'gondolin-rpc') &&
		isRunnerLeaseId(Reflect.get(record, 'leaseId')) &&
		typeof Reflect.get(record, 'createdAt') === 'number' &&
		typeof Reflect.get(record, 'idleTtlMs') === 'number' &&
		typeof Reflect.get(record, 'lastUsedAt') === 'number' &&
		typeof Reflect.get(record, 'profileId') === 'string' &&
		typeof Reflect.get(record, 'providerId') === 'string' &&
		typeof Reflect.get(record, 'zoneId') === 'string' &&
		!Reflect.has(record, deprecatedScopeKeyPropertyName)
	);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/gateway-interface/src/runner-lease.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway-interface/src/runner-lease.ts packages/gateway-interface/src/runner-lease.test.ts
git commit -m "feat(gateway-interface): add RunnerCapLease and RunnerLeasePeek types"
```

---

## Task 3: Define runner backend typed errors

**Files:**
- Create: `packages/gateway-interface/src/runner-backend-errors.ts`
- Test: `packages/gateway-interface/src/runner-backend-errors.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway-interface/src/runner-backend-errors.test.ts
import { describe, expect, it } from 'vitest';

import {
	RunnerBackendSuspendedError,
	RunnerExecConflictError,
	RunnerLeaseCompatibilityConflictError,
} from './runner-backend-errors.js';

describe('runner-backend-errors', () => {
	it('RunnerLeaseCompatibilityConflictError carries mismatched fields', () => {
		const error = new RunnerLeaseCompatibilityConflictError(
			'mismatch',
			['profileId', 'credentialMountSpec.sourceFingerprint'],
		);
		expect(error.name).toBe('RunnerLeaseCompatibilityConflictError');
		expect(error.mismatchedFields).toEqual([
			'profileId',
			'credentialMountSpec.sourceFingerprint',
		]);
	});

	it('RunnerBackendSuspendedError reports the suspension window', () => {
		const error = new RunnerBackendSuspendedError({
			consecutiveFailedRecoveries: 5,
			profileId: 'personal',
			providerId: 'google',
			retryAfterMs: 600_000,
			zoneId: 'shravan-claw',
		});
		expect(error.retryAfterMs).toBe(600_000);
		expect(error.message).toContain('suspended');
	});

	it('RunnerExecConflictError marks active execs', () => {
		const error = new RunnerExecConflictError('lease busy');
		expect(error.name).toBe('RunnerExecConflictError');
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/gateway-interface/src/runner-backend-errors.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the errors**

```ts
// packages/gateway-interface/src/runner-backend-errors.ts
export class RunnerLeaseCompatibilityConflictError extends Error {
	public constructor(
		message: string,
		public readonly mismatchedFields: readonly string[],
	) {
		super(message);
		this.name = 'RunnerLeaseCompatibilityConflictError';
	}
}

export interface RunnerBackendSuspendedErrorOptions {
	readonly consecutiveFailedRecoveries: number;
	readonly profileId: string;
	readonly providerId: string;
	readonly retryAfterMs: number;
	readonly zoneId: string;
}

export class RunnerBackendSuspendedError extends Error {
	public readonly consecutiveFailedRecoveries: number;
	public readonly profileId: string;
	public readonly providerId: string;
	public readonly retryAfterMs: number;
	public readonly zoneId: string;

	public constructor(options: RunnerBackendSuspendedErrorOptions) {
		super(
			`Runner backend for zone '${options.zoneId}' profile '${options.profileId}' provider '${options.providerId}' is suspended after ${String(options.consecutiveFailedRecoveries)} failed recoveries; retry after ${String(options.retryAfterMs)}ms.`,
		);
		this.name = 'RunnerBackendSuspendedError';
		this.consecutiveFailedRecoveries = options.consecutiveFailedRecoveries;
		this.profileId = options.profileId;
		this.providerId = options.providerId;
		this.retryAfterMs = options.retryAfterMs;
		this.zoneId = options.zoneId;
	}
}

export class RunnerExecConflictError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = 'RunnerExecConflictError';
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/gateway-interface/src/runner-backend-errors.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway-interface/src/runner-backend-errors.ts packages/gateway-interface/src/runner-backend-errors.test.ts
git commit -m "feat(gateway-interface): add runner backend typed errors"
```

---

## Task 4: Export new types from gateway-interface

**Files:**
- Modify: `packages/gateway-interface/src/index.ts`

- [ ] **Step 1: Add exports**

Append to `packages/gateway-interface/src/index.ts` (sorted alphabetically within sections per repo convention):

```ts
export {
	createRunnerLeaseId,
	isRunnerLeaseId,
	parseRunnerLeaseId,
	type RunnerLeaseId,
} from './runner-lease-id.js';

export {
	isRunnerCapLease,
	isRunnerLeasePeek,
	type RunnerCapLease,
	type RunnerLeasePeek,
} from './runner-lease.js';

export {
	RunnerBackendSuspendedError,
	RunnerExecConflictError,
	RunnerLeaseCompatibilityConflictError,
	type RunnerBackendSuspendedErrorOptions,
} from './runner-backend-errors.js';
```

- [ ] **Step 2: Verify the package builds**

Run: `pnpm --filter @agent-vm/gateway-interface build`
Expected: Build succeeds with no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/gateway-interface/src/index.ts
git commit -m "feat(gateway-interface): export runner cap lease types and errors"
```

---

## Task 5: Define RunnerCredentialMountSpec and source fingerprint

**Files:**
- Create: `packages/agent-vm/src/controller/leases/runner-credential-mount-spec.ts`
- Test: `packages/agent-vm/src/controller/leases/runner-credential-mount-spec.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/agent-vm/src/controller/leases/runner-credential-mount-spec.test.ts
import { describe, expect, it } from 'vitest';

import {
	deriveRunnerCredentialSourceFingerprint,
	mountSpecsHaveSameFingerprint,
	type RunnerCredentialMountSpec,
} from './runner-credential-mount-spec.js';

describe('RunnerCredentialMountSpec', () => {
	it('derives a stable fingerprint from source and recipient', () => {
		const fingerprint = deriveRunnerCredentialSourceFingerprint({
			ageRecipientId: 'age1exampleRecipient',
			sourcePath: '/var/lib/agent-vm/credential-runner/profiles/personal/google',
		});
		expect(fingerprint).toMatch(/^[a-f0-9]{16}$/u);
		expect(fingerprint).toBe(
			deriveRunnerCredentialSourceFingerprint({
				ageRecipientId: 'age1exampleRecipient',
				sourcePath: '/var/lib/agent-vm/credential-runner/profiles/personal/google',
			}),
		);
	});

	it('rotates the fingerprint on path change', () => {
		const a = deriveRunnerCredentialSourceFingerprint({
			ageRecipientId: 'age1abc',
			sourcePath: '/path/a',
		});
		const b = deriveRunnerCredentialSourceFingerprint({
			ageRecipientId: 'age1abc',
			sourcePath: '/path/b',
		});
		expect(a).not.toBe(b);
	});

	it('mountSpecsHaveSameFingerprint compares only fingerprint', () => {
		const left: RunnerCredentialMountSpec = {
			sourceFingerprint: 'abcd1234abcd1234',
			vfsMounts: [],
		};
		const right: RunnerCredentialMountSpec = {
			sourceFingerprint: 'abcd1234abcd1234',
			vfsMounts: [{ guestPath: '/cred', provider: 'realfs', hostPath: '/x' }],
		};
		expect(mountSpecsHaveSameFingerprint(left, right)).toBe(true);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/agent-vm/src/controller/leases/runner-credential-mount-spec.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the type and fingerprint derivation**

```ts
// packages/agent-vm/src/controller/leases/runner-credential-mount-spec.ts
import { createHash } from 'node:crypto';

export type RunnerVfsProvider = 'memory' | 'readonly' | 'realfs';

export interface RunnerVfsMount {
	readonly guestPath: '/cred' | '/cwd' | '/in' | '/out';
	readonly hostPath?: string;
	readonly provider: RunnerVfsProvider;
}

export interface RunnerCredentialMountSpec {
	readonly sourceFingerprint: string;
	readonly vfsMounts: readonly RunnerVfsMount[];
}

export interface DeriveRunnerCredentialSourceFingerprintProps {
	readonly ageRecipientId: string;
	readonly sourcePath: string;
}

export function deriveRunnerCredentialSourceFingerprint(
	props: DeriveRunnerCredentialSourceFingerprintProps,
): string {
	const hash = createHash('sha256');
	hash.update(props.ageRecipientId);
	hash.update('\0');
	hash.update(props.sourcePath);
	return hash.digest('hex').slice(0, 16);
}

export function mountSpecsHaveSameFingerprint(
	left: RunnerCredentialMountSpec,
	right: RunnerCredentialMountSpec,
): boolean {
	return left.sourceFingerprint === right.sourceFingerprint;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/agent-vm/src/controller/leases/runner-credential-mount-spec.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/agent-vm/src/controller/leases/runner-credential-mount-spec.ts packages/agent-vm/src/controller/leases/runner-credential-mount-spec.test.ts
git commit -m "feat(agent-vm): add RunnerCredentialMountSpec with source fingerprint"
```

---

## Task 6: Define runner VM runtime record schema and IO

**Files:**
- Create: `packages/agent-vm/src/controller/leases/runner-vm-runtime-record.ts`
- Test: `packages/agent-vm/src/controller/leases/runner-vm-runtime-record.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/agent-vm/src/controller/leases/runner-vm-runtime-record.test.ts
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { createRunnerLeaseId } from '@agent-vm/gateway-interface';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
	buildRunnerVmRuntimeRecord,
	deleteRunnerVmRuntimeRecord,
	parseRunnerVmRuntimeRecord,
	writeRunnerVmRuntimeRecord,
} from './runner-vm-runtime-record.js';

const sampleProcessIdentity = {
	command: '/usr/bin/qemu-system-x86_64',
	lstart: 'Fri May 29 10:00:00 2026',
	pid: 12345,
};

describe('runner-vm-runtime-record', () => {
	let stateDir: string;

	beforeEach(async () => {
		stateDir = await mkdtemp(path.join(tmpdir(), 'runner-lease-state-'));
	});

	afterEach(async () => {
		await rm(stateDir, { force: true, recursive: true });
	});

	it('builds a record with all required fields', async () => {
		const record = await buildRunnerVmRuntimeRecord({
			controllerPort: 18800,
			leaseId: createRunnerLeaseId(),
			poolSlot: 0,
			processIdentity: sampleProcessIdentity,
			profileId: 'personal',
			projectNamespace: 'agent-vm',
			providerId: 'google',
			qemuPid: 12345,
			recordId: '11111111-1111-4111-8111-111111111111',
			systemConfigPath: '/etc/agent-vm/system.json',
			vmId: 'vm-runner-0',
			zoneId: 'shravan-claw',
		});
		expect(record.recordId).toBe('11111111-1111-4111-8111-111111111111');
		expect(record.fences.controllerPort).toBe(18800);
	});

	it('writes and re-reads a record', async () => {
		const record = await buildRunnerVmRuntimeRecord({
			controllerPort: 18800,
			leaseId: createRunnerLeaseId(),
			poolSlot: 0,
			processIdentity: sampleProcessIdentity,
			profileId: 'personal',
			projectNamespace: 'agent-vm',
			providerId: 'google',
			qemuPid: 12345,
			recordId: '11111111-1111-4111-8111-111111111111',
			systemConfigPath: '/etc/agent-vm/system.json',
			vmId: 'vm-runner-0',
			zoneId: 'shravan-claw',
		});
		await writeRunnerVmRuntimeRecord(stateDir, record);
		const onDisk = await readFile(
			path.join(stateDir, 'runner-leases', `${record.recordId}.json`),
			'utf8',
		);
		const parsed = parseRunnerVmRuntimeRecord(JSON.parse(onDisk));
		expect(parsed.leaseId).toBe(record.leaseId);
	});

	it('parseRunnerVmRuntimeRecord rejects deprecated scopeKey', () => {
		expect(() =>
			parseRunnerVmRuntimeRecord({
				createdAt: new Date().toISOString(),
				fences: {
					controllerPort: 18800,
					projectNamespace: 'agent-vm',
					systemConfigPath: '/etc/agent-vm/system.json',
				},
				leaseId: createRunnerLeaseId(),
				poolSlot: 0,
				processIdentity: sampleProcessIdentity,
				profileId: 'personal',
				providerId: 'google',
				qemuPid: 12345,
				recordId: '11111111-1111-4111-8111-111111111111',
				scopeKey: 'agent:foo',
				vmId: 'vm-runner-0',
				zoneId: 'shravan-claw',
			}),
		).toThrow();
	});

	it('deletes a record by id', async () => {
		const record = await buildRunnerVmRuntimeRecord({
			controllerPort: 18800,
			leaseId: createRunnerLeaseId(),
			poolSlot: 0,
			processIdentity: sampleProcessIdentity,
			profileId: 'personal',
			projectNamespace: 'agent-vm',
			providerId: 'google',
			qemuPid: 12345,
			recordId: '11111111-1111-4111-8111-111111111111',
			systemConfigPath: '/etc/agent-vm/system.json',
			vmId: 'vm-runner-0',
			zoneId: 'shravan-claw',
		});
		await writeRunnerVmRuntimeRecord(stateDir, record);
		await deleteRunnerVmRuntimeRecord(stateDir, record.recordId);
		await expect(
			readFile(
				path.join(stateDir, 'runner-leases', `${record.recordId}.json`),
				'utf8',
			),
		).rejects.toThrow();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/agent-vm/src/controller/leases/runner-vm-runtime-record.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement schema and IO**

```ts
// packages/agent-vm/src/controller/leases/runner-vm-runtime-record.ts
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { isRunnerLeaseId, type RunnerLeaseId } from '@agent-vm/gateway-interface';
import { z } from 'zod';

import type { ProcessIdentity } from '../../shared/managed-vm-process.js';

const runnerLeasesDirectoryName = 'runner-leases';

const processIdentitySchema = z
	.object({
		command: z.string(),
		lstart: z.string(),
		pid: z.number().int().nonnegative(),
	})
	.strict();

const fencesSchema = z
	.object({
		controllerPort: z.number().int().positive(),
		projectNamespace: z.string().min(1),
		systemConfigPath: z.string().min(1),
	})
	.strict();

const runnerLeaseIdSchema = z.custom<RunnerLeaseId>(isRunnerLeaseId, {
	message: 'leaseId must be a UUIDv7 RunnerLeaseId.',
});

const runnerVmRuntimeRecordSchema = z
	.object({
		createdAt: z.string().min(1),
		fences: fencesSchema,
		leaseId: runnerLeaseIdSchema,
		poolSlot: z.number().int().nonnegative(),
		processIdentity: processIdentitySchema,
		profileId: z.string().min(1),
		providerId: z.string().min(1),
		qemuPid: z.number().int().nonnegative(),
		recordId: z.string().uuid(),
		vmId: z.string().min(1),
		zoneId: z.string().min(1),
	})
	.strict();

export type RunnerVmRuntimeRecord = z.infer<typeof runnerVmRuntimeRecordSchema>;

export interface BuildRunnerVmRuntimeRecordProps {
	readonly controllerPort: number;
	readonly leaseId: RunnerLeaseId;
	readonly poolSlot: number;
	readonly processIdentity: ProcessIdentity;
	readonly profileId: string;
	readonly projectNamespace: string;
	readonly providerId: string;
	readonly qemuPid: number;
	readonly recordId: string;
	readonly systemConfigPath: string;
	readonly vmId: string;
	readonly zoneId: string;
}

export async function buildRunnerVmRuntimeRecord(
	props: BuildRunnerVmRuntimeRecordProps,
): Promise<RunnerVmRuntimeRecord> {
	const record = {
		createdAt: new Date().toISOString(),
		fences: {
			controllerPort: props.controllerPort,
			projectNamespace: props.projectNamespace,
			systemConfigPath: props.systemConfigPath,
		},
		leaseId: props.leaseId,
		poolSlot: props.poolSlot,
		processIdentity: props.processIdentity,
		profileId: props.profileId,
		providerId: props.providerId,
		qemuPid: props.qemuPid,
		recordId: props.recordId,
		vmId: props.vmId,
		zoneId: props.zoneId,
	} satisfies RunnerVmRuntimeRecord;
	return runnerVmRuntimeRecordSchema.parse(record);
}

export function parseRunnerVmRuntimeRecord(value: unknown): RunnerVmRuntimeRecord {
	return runnerVmRuntimeRecordSchema.parse(value);
}

export async function writeRunnerVmRuntimeRecord(
	stateDir: string,
	record: RunnerVmRuntimeRecord,
): Promise<void> {
	const directoryPath = path.join(stateDir, runnerLeasesDirectoryName);
	await mkdir(directoryPath, { recursive: true });
	const filePath = path.join(directoryPath, `${record.recordId}.json`);
	const temporaryFilePath = `${filePath}.${String(process.pid)}.tmp`;
	await writeFile(temporaryFilePath, JSON.stringify(record), { mode: 0o600 });
	const { rename } = await import('node:fs/promises');
	await rename(temporaryFilePath, filePath);
}

export async function deleteRunnerVmRuntimeRecord(
	stateDir: string,
	recordId: string,
): Promise<void> {
	const filePath = path.join(stateDir, runnerLeasesDirectoryName, `${recordId}.json`);
	await rm(filePath, { force: true });
}

export function runnerLeasesDirectoryFor(stateDir: string): string {
	return path.join(stateDir, runnerLeasesDirectoryName);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/agent-vm/src/controller/leases/runner-vm-runtime-record.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/agent-vm/src/controller/leases/runner-vm-runtime-record.ts packages/agent-vm/src/controller/leases/runner-vm-runtime-record.test.ts
git commit -m "feat(agent-vm): add runner VM runtime record schema and IO"
```

---

## Task 7: Runner lease manager skeleton, types, and per-key lock

**Files:**
- Create: `packages/agent-vm/src/controller/leases/runner-lease-manager.ts`
- Test: `packages/agent-vm/src/controller/leases/runner-lease-manager.test.ts`

- [ ] **Step 1: Write the failing test for lock serialization**

```ts
// packages/agent-vm/src/controller/leases/runner-lease-manager.test.ts
import { describe, expect, it } from 'vitest';

import { createRunnerLeaseManagerForTests } from './runner-lease-manager.test-utils.js';

describe('runner-lease-manager / per-key lock', () => {
	it('serializes acquireRunnerLease for the same (zone, profile, provider) tuple', async () => {
		const { manager, instrument } = createRunnerLeaseManagerForTests();
		instrument.simulateCreateManagedVmLatencyMs(50);
		const startA = Date.now();
		const [resultA, resultB] = await Promise.all([
			manager.acquireRunnerLease({
				credentialMountSpec: instrument.mountSpec(),
				profile: instrument.profile(),
				profileId: 'personal',
				providerId: 'google',
				zoneId: 'shravan-claw',
			}),
			manager.acquireRunnerLease({
				credentialMountSpec: instrument.mountSpec(),
				profile: instrument.profile(),
				profileId: 'personal',
				providerId: 'google',
				zoneId: 'shravan-claw',
			}),
		]);
		const elapsed = Date.now() - startA;
		// Both acquires share the lock; the second one reuses the first lease via liveness probe.
		expect(resultA.leaseId).toBe(resultB.leaseId);
		expect(elapsed).toBeGreaterThanOrEqual(50);
	});

	it('allows concurrent acquires across different keys', async () => {
		const { manager, instrument } = createRunnerLeaseManagerForTests();
		instrument.simulateCreateManagedVmLatencyMs(100);
		const start = Date.now();
		const [a, b] = await Promise.all([
			manager.acquireRunnerLease({
				credentialMountSpec: instrument.mountSpec(),
				profile: instrument.profile(),
				profileId: 'personal',
				providerId: 'google',
				zoneId: 'shravan-claw',
			}),
			manager.acquireRunnerLease({
				credentialMountSpec: instrument.mountSpec(),
				profile: instrument.profile(),
				profileId: 'work',
				providerId: 'notion',
				zoneId: 'shravan-claw',
			}),
		]);
		const elapsed = Date.now() - start;
		expect(a.leaseId).not.toBe(b.leaseId);
		// Parallel paths complete in ~100ms, not 200ms.
		expect(elapsed).toBeLessThan(180);
	});
});
```

- [ ] **Step 2: Create the test utility**

```ts
// packages/agent-vm/src/controller/leases/runner-lease-manager.test-utils.ts
import type { ManagedVm } from '@agent-vm/gondolin-adapter';

import type { RunnerCredentialMountSpec } from './runner-credential-mount-spec.js';
import {
	createRunnerLeaseManager,
	type RunnerLeaseManager,
	type RunnerVmProfile,
} from './runner-lease-manager.js';

export interface RunnerLeaseManagerInstrument {
	mountSpec(): RunnerCredentialMountSpec;
	profile(): RunnerVmProfile;
	simulateCreateManagedVmLatencyMs(ms: number): void;
}

export function createRunnerLeaseManagerForTests(): {
	readonly instrument: RunnerLeaseManagerInstrument;
	readonly manager: RunnerLeaseManager;
} {
	let createLatencyMs = 0;
	let nowMs = 1_700_000_000_000;

	const createManagedVm = async (): Promise<ManagedVm> => {
		if (createLatencyMs > 0) {
			await new Promise((resolve) => setTimeout(resolve, createLatencyMs));
		}
		const closed = { value: false };
		return {
			fs: {} as ManagedVm['fs'],
			id: `vm-${Math.random().toString(36).slice(2, 10)}`,
			exec: async () => ({ exitCode: 0, stderr: '', stdout: '' }),
			enableSsh: async () => {
				throw new Error('runner VM must not enable SSH');
			},
			enableIngress: async () => {
				throw new Error('runner VM must not enable ingress');
			},
			getHostPid: () => 12345,
			getVmInstance: () => ({}) as ManagedVm['getVmInstance'] extends () => infer T ? T : never,
			setIngressRoutes: () => {},
			close: async () => {
				closed.value = true;
			},
		} as unknown as ManagedVm;
	};

	const allocatedSlots = new Set<number>();
	let nextSlot = 0;

	const manager = createRunnerLeaseManager({
		controllerPort: 18800,
		createManagedVm,
		now: () => nowMs,
		projectNamespace: 'agent-vm-test',
		readProcessIdentity: () => ({
			command: '/usr/bin/qemu-system-x86_64',
			lstart: 'Fri May 29 10:00:00 2026',
			pid: 12345,
		}),
		stateDirFor: () => '/tmp/runner-lease-manager-test',
		systemConfigPath: '/etc/agent-vm/system.json',
		tcpPool: {
			allocate: () => {
				const slot = nextSlot++;
				allocatedSlots.add(slot);
				return slot;
			},
			portForSlot: (slot) => 20_000 + slot,
			quarantine: () => {},
			release: (slot) => {
				allocatedSlots.delete(slot);
			},
		},
	});

	return {
		instrument: {
			mountSpec: () => ({
				sourceFingerprint: 'abcd1234abcd1234',
				vfsMounts: [{ guestPath: '/cwd', provider: 'memory' }],
			}),
			profile: () => ({
				cpus: 1,
				imageProfile: 'credentialed-tool-vm',
				memory: '512Mi',
			}),
			simulateCreateManagedVmLatencyMs: (ms) => {
				createLatencyMs = ms;
			},
		},
		manager,
	};
}
```

- [ ] **Step 3: Implement the manager skeleton**

```ts
// packages/agent-vm/src/controller/leases/runner-lease-manager.ts
import { randomUUID } from 'node:crypto';

import {
	createRunnerLeaseId,
	RunnerExecConflictError,
	RunnerLeaseCompatibilityConflictError,
	type RunnerLeaseId,
} from '@agent-vm/gateway-interface';
import type { ManagedVm } from '@agent-vm/gondolin-adapter';

import type { readProcessIdentity as defaultReadProcessIdentity } from '../../shared/managed-vm-process.js';
import {
	mountSpecsHaveSameFingerprint,
	type RunnerCredentialMountSpec,
} from './runner-credential-mount-spec.js';
import {
	buildRunnerVmRuntimeRecord,
	deleteRunnerVmRuntimeRecord,
	writeRunnerVmRuntimeRecord,
} from './runner-vm-runtime-record.js';
import type { TcpPool } from './tcp-pool.js';

export interface RunnerVmProfile {
	readonly cpus: number;
	readonly imageProfile: string;
	readonly memory: string;
}

export interface RunnerLease {
	readonly activeExecCount: number;
	readonly createdAt: number;
	readonly credentialMountSpec: RunnerCredentialMountSpec;
	readonly effectiveIdleTtlMs: number;
	readonly id: RunnerLeaseId;
	readonly lastUsedAt: number;
	readonly profileId: string;
	readonly providerId: string;
	readonly runtimeRecordId: string;
	readonly tcpSlot: number;
	readonly vm: ManagedVm;
	readonly zoneId: string;
}

export interface RunnerLeaseRenewal {
	readonly kind: 'not-found' | 'renewed';
	readonly lease?: RunnerLease;
	readonly reason?: 'dead' | 'expired' | 'missing';
}

export interface RunnerLeaseManager {
	acquireRunnerLease(options: {
		readonly credentialMountSpec: RunnerCredentialMountSpec;
		readonly effectiveIdleTtlMs?: number;
		readonly profile: RunnerVmProfile;
		readonly profileId: string;
		readonly providerId: string;
		readonly zoneId: string;
	}): Promise<RunnerLease>;
	endRunnerExec(leaseId: RunnerLeaseId): void;
	listLeases(): readonly RunnerLease[];
	reapDeadIdleLeases(): Promise<void>;
	releaseLease(
		leaseId: RunnerLeaseId,
		options?: { readonly force?: boolean },
	): Promise<void>;
	renewLease(leaseId: RunnerLeaseId): Promise<RunnerLeaseRenewal>;
	startRunnerExec(leaseId: RunnerLeaseId): void;
}

export interface CreateRunnerLeaseManagerOptions {
	readonly controllerPort: number;
	readonly createManagedVm: (leaseOptions: {
		readonly credentialMountSpec: RunnerCredentialMountSpec;
		readonly profile: RunnerVmProfile;
		readonly profileId: string;
		readonly providerId: string;
		readonly tcpSlot: number;
		readonly zoneId: string;
	}) => Promise<ManagedVm>;
	readonly defaultIdleTtlMs?: number;
	readonly deleteRunnerVmRuntimeRecord?: typeof deleteRunnerVmRuntimeRecord;
	readonly liveProbeTimeoutMs?: number;
	readonly now: () => number;
	readonly projectNamespace: string;
	readonly readProcessIdentity?: typeof defaultReadProcessIdentity;
	readonly stateDirFor: (zoneId: string) => string;
	readonly systemConfigPath: string;
	readonly tcpPool: TcpPool;
	readonly writeRunnerVmRuntimeRecord?: typeof writeRunnerVmRuntimeRecord;
}

const defaultIdleTtlMsConst = 5 * 60 * 1000;
const defaultLiveProbeTimeoutMsConst = 5_000;

function runnerLeaseIndexKey(props: {
	readonly profileId: string;
	readonly providerId: string;
	readonly zoneId: string;
}): string {
	return `${props.zoneId}\0${props.profileId}\0${props.providerId}`;
}

function formatRunnerLeaseManagerError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function writeRunnerLeaseManagerWarning(message: string): void {
	process.stderr.write(`[runner-lease-manager] ${message}\n`);
}

function assertCompatibleRunnerLeaseRequest(
	existingLease: RunnerLease,
	requested: {
		readonly credentialMountSpec: RunnerCredentialMountSpec;
		readonly effectiveIdleTtlMs?: number;
	},
): void {
	const mismatchedFields: string[] = [];
	if (
		requested.effectiveIdleTtlMs !== undefined &&
		existingLease.effectiveIdleTtlMs !== requested.effectiveIdleTtlMs
	) {
		mismatchedFields.push('effectiveIdleTtlMs');
	}
	if (
		!mountSpecsHaveSameFingerprint(
			existingLease.credentialMountSpec,
			requested.credentialMountSpec,
		)
	) {
		mismatchedFields.push('credentialMountSpec.sourceFingerprint');
	}
	if (mismatchedFields.length > 0) {
		throw new RunnerLeaseCompatibilityConflictError(
			`existing runner lease for profile '${existingLease.profileId}' provider '${existingLease.providerId}' is not compatible; mismatched fields: ${mismatchedFields.join(', ')}`,
			mismatchedFields,
		);
	}
}

async function isLeaseVmLive(
	lease: RunnerLease,
	timeoutMs: number,
): Promise<boolean> {
	const abortController = new AbortController();
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	try {
		const timeoutResult = new Promise<false>((resolve) => {
			timeoutHandle = setTimeout(() => {
				abortController.abort();
				resolve(false);
			}, timeoutMs);
		});
		const probeResult = await Promise.race([
			lease.vm.exec('true', { signal: abortController.signal }),
			timeoutResult,
		]);
		return probeResult !== false && probeResult.exitCode === 0;
	} catch (error) {
		writeRunnerLeaseManagerWarning(
			`liveness probe failed for lease '${lease.id}': ${formatRunnerLeaseManagerError(error)}`,
		);
		return false;
	} finally {
		if (timeoutHandle !== undefined) {
			clearTimeout(timeoutHandle);
		}
	}
}

export function createRunnerLeaseManager(
	options: CreateRunnerLeaseManagerOptions,
): RunnerLeaseManager {
	const leases = new Map<RunnerLeaseId, RunnerLease>();
	const leaseIdsByKey = new Map<string, RunnerLeaseId>();
	const keyLocks = new Map<string, Promise<void>>();
	const writeRuntimeRecord =
		options.writeRunnerVmRuntimeRecord ?? writeRunnerVmRuntimeRecord;
	const deleteRuntimeRecord =
		options.deleteRunnerVmRuntimeRecord ?? deleteRunnerVmRuntimeRecord;
	const defaultIdleTtlMs = options.defaultIdleTtlMs ?? defaultIdleTtlMsConst;
	const liveProbeTimeoutMs =
		options.liveProbeTimeoutMs ?? defaultLiveProbeTimeoutMsConst;

	function storeLease(lease: RunnerLease): void {
		leases.set(lease.id, lease);
		leaseIdsByKey.set(runnerLeaseIndexKey(lease), lease.id);
	}

	function deleteLeaseFromIndex(lease: RunnerLease): void {
		leases.delete(lease.id);
		const indexKey = runnerLeaseIndexKey(lease);
		if (leaseIdsByKey.get(indexKey) === lease.id) {
			leaseIdsByKey.delete(indexKey);
		}
	}

	function findLeaseForKey(props: {
		readonly profileId: string;
		readonly providerId: string;
		readonly zoneId: string;
	}): RunnerLease | undefined {
		const leaseId = leaseIdsByKey.get(runnerLeaseIndexKey(props));
		return leaseId ? leases.get(leaseId) : undefined;
	}

	function touchLease(lease: RunnerLease): RunnerLease {
		const touched: RunnerLease = { ...lease, lastUsedAt: options.now() };
		storeLease(touched);
		return touched;
	}

	function isLeaseIdleExpired(lease: RunnerLease): boolean {
		return lease.lastUsedAt + lease.effectiveIdleTtlMs < options.now();
	}

	function isLeaseExpired(lease: RunnerLease): boolean {
		return isLeaseIdleExpired(lease) && lease.activeExecCount === 0;
	}

	async function withKeyLock<TValue>(
		key: string,
		fn: () => Promise<TValue>,
	): Promise<TValue> {
		const previousLock = keyLocks.get(key) ?? Promise.resolve();
		let releaseCurrentLock: (() => void) | undefined;
		const currentLock = new Promise<void>((resolve) => {
			releaseCurrentLock = resolve;
		});
		keyLocks.set(key, currentLock);
		await previousLock.catch(() => {});
		try {
			return await fn();
		} finally {
			releaseCurrentLock?.();
			if (keyLocks.get(key) === currentLock) {
				keyLocks.delete(key);
			}
		}
	}

	async function evictLease(lease: RunnerLease): Promise<void> {
		deleteLeaseFromIndex(lease);
		let closeSucceeded = true;
		try {
			await lease.vm.close();
		} catch (error) {
			closeSucceeded = false;
			writeRunnerLeaseManagerWarning(
				`failed to close evicted lease '${lease.id}': ${formatRunnerLeaseManagerError(error)}. Quarantining pool slot ${String(lease.tcpSlot)}.`,
			);
		}
		if (closeSucceeded) {
			options.tcpPool.release(lease.tcpSlot);
			try {
				await deleteRuntimeRecord(
					options.stateDirFor(lease.zoneId),
					lease.runtimeRecordId,
				);
			} catch (deleteError) {
				writeRunnerLeaseManagerWarning(
					`failed to delete runtime record for evicted lease '${lease.id}': ${formatRunnerLeaseManagerError(deleteError)}`,
				);
			}
		} else {
			options.tcpPool.quarantine(lease.tcpSlot);
		}
	}

	return {
		async acquireRunnerLease(acquireOptions) {
			const key = runnerLeaseIndexKey(acquireOptions);
			return await withKeyLock(key, async () => {
				const existing = findLeaseForKey(acquireOptions);
				if (existing) {
					if (isLeaseExpired(existing)) {
						await evictLease(existing);
					} else {
						assertCompatibleRunnerLeaseRequest(existing, acquireOptions);
						if (await isLeaseVmLive(existing, liveProbeTimeoutMs)) {
							return touchLease(existing);
						}
						await evictLease(existing);
					}
				}
				const tcpSlot = options.tcpPool.allocate();
				let vmCreatedButNotClosed = false;
				try {
					const vm = await options.createManagedVm({
						credentialMountSpec: acquireOptions.credentialMountSpec,
						profile: acquireOptions.profile,
						profileId: acquireOptions.profileId,
						providerId: acquireOptions.providerId,
						tcpSlot,
						zoneId: acquireOptions.zoneId,
					});
					vmCreatedButNotClosed = true;
					const createdAt = options.now();
					const runtimeRecordId = randomUUID();
					const leaseId = createRunnerLeaseId();
					const lease: RunnerLease = {
						activeExecCount: 0,
						createdAt,
						credentialMountSpec: acquireOptions.credentialMountSpec,
						effectiveIdleTtlMs:
							acquireOptions.effectiveIdleTtlMs ?? defaultIdleTtlMs,
						id: leaseId,
						lastUsedAt: createdAt,
						profileId: acquireOptions.profileId,
						providerId: acquireOptions.providerId,
						runtimeRecordId,
						tcpSlot,
						vm,
						zoneId: acquireOptions.zoneId,
					};
					storeLease(lease);
					try {
						await writeRuntimeRecord(
							options.stateDirFor(lease.zoneId),
							await buildRunnerVmRuntimeRecord({
								controllerPort: options.controllerPort,
								leaseId: lease.id,
								poolSlot: lease.tcpSlot,
								processIdentity:
									options.readProcessIdentity?.({
										hostPid: vm.getHostPid() ?? 0,
									}) ?? {
										command: '(unknown)',
										lstart: '(unknown)',
										pid: vm.getHostPid() ?? 0,
									},
								profileId: lease.profileId,
								projectNamespace: options.projectNamespace,
								providerId: lease.providerId,
								qemuPid: vm.getHostPid() ?? 0,
								recordId: runtimeRecordId,
								systemConfigPath: options.systemConfigPath,
								vmId: vm.id,
								zoneId: lease.zoneId,
							}),
						);
					} catch (writeError) {
						deleteLeaseFromIndex(lease);
						throw writeError;
					}
					vmCreatedButNotClosed = false;
					return lease;
				} catch (error) {
					if (vmCreatedButNotClosed) {
						options.tcpPool.quarantine(tcpSlot);
					} else {
						options.tcpPool.release(tcpSlot);
					}
					throw error;
				}
			});
		},
		endRunnerExec(leaseId) {
			const lease = leases.get(leaseId);
			if (!lease) {
				return;
			}
			storeLease({
				...lease,
				activeExecCount: Math.max(0, lease.activeExecCount - 1),
				lastUsedAt: options.now(),
			});
		},
		listLeases() {
			return [...leases.values()];
		},
		async reapDeadIdleLeases() {
			for (const lease of leases.values()) {
				// oxlint-disable-next-line eslint/no-await-in-loop -- per-key lock serializes eviction with acquire/renew/release
				await withKeyLock(runnerLeaseIndexKey(lease), async () => {
					const current = leases.get(lease.id);
					if (!current || current.activeExecCount > 0) {
						return;
					}
					if (!(await isLeaseVmLive(current, liveProbeTimeoutMs))) {
						await evictLease(current);
					}
				});
			}
		},
		async releaseLease(leaseId, releaseOptions) {
			const lease = leases.get(leaseId);
			if (!lease) {
				return;
			}
			await withKeyLock(runnerLeaseIndexKey(lease), async () => {
				const current = leases.get(leaseId);
				if (!current) {
					return;
				}
				if (releaseOptions?.force !== true && current.activeExecCount > 0) {
					throw new RunnerExecConflictError(
						`Runner lease '${leaseId}' has ${String(current.activeExecCount)} active execs.`,
					);
				}
				await evictLease(current);
			});
		},
		async renewLease(leaseId) {
			const lease = leases.get(leaseId);
			if (!lease) {
				return { kind: 'not-found', reason: 'missing' };
			}
			return await withKeyLock(runnerLeaseIndexKey(lease), async () => {
				const current = leases.get(leaseId);
				if (!current) {
					return { kind: 'not-found', reason: 'missing' };
				}
				if (isLeaseExpired(current)) {
					await evictLease(current);
					return { kind: 'not-found', reason: 'expired' };
				}
				if (!(await isLeaseVmLive(current, liveProbeTimeoutMs))) {
					await evictLease(current);
					return { kind: 'not-found', reason: 'dead' };
				}
				return { kind: 'renewed', lease: touchLease(current) };
			});
		},
		startRunnerExec(leaseId) {
			const lease = leases.get(leaseId);
			if (!lease) {
				return;
			}
			storeLease({
				...lease,
				activeExecCount: lease.activeExecCount + 1,
				lastUsedAt: options.now(),
			});
		},
	};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/agent-vm/src/controller/leases/runner-lease-manager.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/agent-vm/src/controller/leases/runner-lease-manager.ts packages/agent-vm/src/controller/leases/runner-lease-manager.test.ts packages/agent-vm/src/controller/leases/runner-lease-manager.test-utils.ts
git commit -m "feat(agent-vm): add runner lease manager with per-key lock and acquire flow"
```

---

## Task 8: Compatibility conflict and liveness eviction tests

**Files:**
- Modify: `packages/agent-vm/src/controller/leases/runner-lease-manager.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `runner-lease-manager.test.ts`:

```ts
describe('runner-lease-manager / compatibility and liveness', () => {
	it('throws RunnerLeaseCompatibilityConflictError on fingerprint mismatch', async () => {
		const { manager, instrument } = createRunnerLeaseManagerForTests();
		await manager.acquireRunnerLease({
			credentialMountSpec: instrument.mountSpec(),
			profile: instrument.profile(),
			profileId: 'personal',
			providerId: 'google',
			zoneId: 'shravan-claw',
		});
		await expect(
			manager.acquireRunnerLease({
				credentialMountSpec: {
					sourceFingerprint: 'deadbeefdeadbeef',
					vfsMounts: [{ guestPath: '/cwd', provider: 'memory' }],
				},
				profile: instrument.profile(),
				profileId: 'personal',
				providerId: 'google',
				zoneId: 'shravan-claw',
			}),
		).rejects.toThrow(/RunnerLeaseCompatibilityConflictError|mismatched fields/u);
	});

	it('evicts a dead lease and cold-starts a fresh one', async () => {
		const { manager, instrument } = createRunnerLeaseManagerForTests();
		const first = await manager.acquireRunnerLease({
			credentialMountSpec: instrument.mountSpec(),
			profile: instrument.profile(),
			profileId: 'personal',
			providerId: 'google',
			zoneId: 'shravan-claw',
		});
		instrument.makeNextProbeFail();
		const second = await manager.acquireRunnerLease({
			credentialMountSpec: instrument.mountSpec(),
			profile: instrument.profile(),
			profileId: 'personal',
			providerId: 'google',
			zoneId: 'shravan-claw',
		});
		expect(first.leaseId).not.toBe(second.leaseId);
	});
});
```

- [ ] **Step 2: Extend the test utility to support failing probes**

Add to `runner-lease-manager.test-utils.ts`:

```ts
let failNextProbe = false;
const createManagedVm = async (): Promise<ManagedVm> => {
	if (createLatencyMs > 0) {
		await new Promise((resolve) => setTimeout(resolve, createLatencyMs));
	}
	return {
		fs: {} as ManagedVm['fs'],
		id: `vm-${Math.random().toString(36).slice(2, 10)}`,
		exec: async () => {
			if (failNextProbe) {
				failNextProbe = false;
				return { exitCode: 1, stderr: 'probe-failed', stdout: '' };
			}
			return { exitCode: 0, stderr: '', stdout: '' };
		},
		// ... rest unchanged
	} as unknown as ManagedVm;
};

// Expose:
instrument.makeNextProbeFail = (): void => {
	failNextProbe = true;
};
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `pnpm vitest run packages/agent-vm/src/controller/leases/runner-lease-manager.test.ts`
Expected: PASS (4 tests total).

- [ ] **Step 4: Commit**

```bash
git add packages/agent-vm/src/controller/leases/runner-lease-manager.test.ts packages/agent-vm/src/controller/leases/runner-lease-manager.test-utils.ts
git commit -m "test(agent-vm): cover runner lease compatibility and liveness eviction"
```

---

## Task 9: Renew, release, and reap tests

**Files:**
- Modify: `packages/agent-vm/src/controller/leases/runner-lease-manager.test.ts`

- [ ] **Step 1: Write the failing tests**

Append:

```ts
describe('runner-lease-manager / renew, release, reap', () => {
	it('renewLease returns kind: missing for unknown id', async () => {
		const { manager } = createRunnerLeaseManagerForTests();
		const result = await manager.renewLease(
			'00000000-0000-7000-8000-000000000000' as never,
		);
		expect(result).toEqual({ kind: 'not-found', reason: 'missing' });
	});

	it('renewLease evicts expired leases and reports reason: expired', async () => {
		const { manager, instrument } = createRunnerLeaseManagerForTests();
		const lease = await manager.acquireRunnerLease({
			credentialMountSpec: instrument.mountSpec(),
			profile: instrument.profile(),
			profileId: 'personal',
			providerId: 'google',
			zoneId: 'shravan-claw',
		});
		instrument.advanceTime(6 * 60 * 1000);
		const result = await manager.renewLease(lease.id);
		expect(result).toEqual({ kind: 'not-found', reason: 'expired' });
	});

	it('releaseLease throws when active execs exist without force', async () => {
		const { manager, instrument } = createRunnerLeaseManagerForTests();
		const lease = await manager.acquireRunnerLease({
			credentialMountSpec: instrument.mountSpec(),
			profile: instrument.profile(),
			profileId: 'personal',
			providerId: 'google',
			zoneId: 'shravan-claw',
		});
		manager.startRunnerExec(lease.id);
		await expect(manager.releaseLease(lease.id)).rejects.toThrow(
			/active execs/iu,
		);
		await manager.releaseLease(lease.id, { force: true });
	});

	it('reapDeadIdleLeases evicts only dead idle leases', async () => {
		const { manager, instrument } = createRunnerLeaseManagerForTests();
		const a = await manager.acquireRunnerLease({
			credentialMountSpec: instrument.mountSpec(),
			profile: instrument.profile(),
			profileId: 'a',
			providerId: 'p',
			zoneId: 'z',
		});
		const b = await manager.acquireRunnerLease({
			credentialMountSpec: instrument.mountSpec(),
			profile: instrument.profile(),
			profileId: 'b',
			providerId: 'p',
			zoneId: 'z',
		});
		manager.startRunnerExec(b.id);
		instrument.makeAllProbesFail();
		await manager.reapDeadIdleLeases();
		const remaining = manager.listLeases();
		expect(remaining.map((lease) => lease.id)).toEqual([b.id]);
	});
});
```

- [ ] **Step 2: Extend test util for time advance and global probe failure**

Add to `runner-lease-manager.test-utils.ts`:

```ts
let allProbesFail = false;
// inside exec: replace failNextProbe check with:
exec: async () => {
	if (allProbesFail) {
		return { exitCode: 1, stderr: 'all-probes-fail', stdout: '' };
	}
	if (failNextProbe) {
		failNextProbe = false;
		return { exitCode: 1, stderr: 'probe-failed', stdout: '' };
	}
	return { exitCode: 0, stderr: '', stdout: '' };
},

// Expose:
instrument.advanceTime = (ms: number): void => {
	nowMs += ms;
};
instrument.makeAllProbesFail = (): void => {
	allProbesFail = true;
};
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `pnpm vitest run packages/agent-vm/src/controller/leases/runner-lease-manager.test.ts`
Expected: PASS (8 tests total).

- [ ] **Step 4: Commit**

```bash
git add packages/agent-vm/src/controller/leases/runner-lease-manager.test.ts packages/agent-vm/src/controller/leases/runner-lease-manager.test-utils.ts
git commit -m "test(agent-vm): cover runner lease renew, release, and reap flows"
```

---

## Task 10: Runner VM recovery tracker wrapper

**Files:**
- Create: `packages/agent-vm/src/controller/leases/runner-vm-recovery-tracker.ts`
- Test: `packages/agent-vm/src/controller/leases/runner-vm-recovery-tracker.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/agent-vm/src/controller/leases/runner-vm-recovery-tracker.test.ts
import { describe, expect, it } from 'vitest';

import {
	createRunnerVmRecoveryTracker,
	type RunnerBackendKey,
} from './runner-vm-recovery-tracker.js';

const sampleKey: RunnerBackendKey = {
	profileId: 'personal',
	providerId: 'google',
	zoneId: 'shravan-claw',
};

describe('createRunnerVmRecoveryTracker', () => {
	it('returns evict-and-cold-start after consecutive failures', () => {
		const tracker = createRunnerVmRecoveryTracker({
			policy: {
				consecutiveFailureThreshold: 3,
				cooldownMs: 60_000,
				enabled: true,
				failedRecoveryResetMs: 600_000,
				maxConsecutiveFailedRecoveries: 5,
				restartTimeoutMs: 30_000,
			},
		});
		let lastDecision;
		for (let attempt = 0; attempt < 3; attempt++) {
			lastDecision = tracker.recordRunnerBackendProbe({
				key: sampleKey,
				observedAtMs: 1_000 + attempt * 100,
				result: 'failed',
			});
		}
		expect(lastDecision?.kind).toBe('restart');
	});

	it('suspends after max failed recoveries', () => {
		const tracker = createRunnerVmRecoveryTracker({
			policy: {
				consecutiveFailureThreshold: 1,
				cooldownMs: 0,
				enabled: true,
				failedRecoveryResetMs: 600_000,
				maxConsecutiveFailedRecoveries: 2,
				restartTimeoutMs: 30_000,
			},
		});
		for (let attempt = 0; attempt < 2; attempt++) {
			tracker.markRecoveryStarted({ key: sampleKey, observedAtMs: attempt * 1000 });
			tracker.markRecoveryFinished({
				key: sampleKey,
				observedAtMs: attempt * 1000,
				result: 'failed',
			});
		}
		const decision = tracker.recordRunnerBackendProbe({
			key: sampleKey,
			observedAtMs: 2_000,
			result: 'failed',
		});
		expect(decision.kind).toBe('suspended');
	});
});
```

- [ ] **Step 2: Implement the wrapper**

```ts
// packages/agent-vm/src/controller/leases/runner-vm-recovery-tracker.ts
import {
	createGatewayVmRecoveryTracker,
	type GatewayVmAutoRecoveryPolicy,
	type GatewayVmRecoveryDecision,
	type GatewayVmRecoveryObservationResult,
} from '../health/gateway-vm-recovery-policy.js';

export interface RunnerBackendKey {
	readonly profileId: string;
	readonly providerId: string;
	readonly zoneId: string;
}

export interface RunnerBackendProbeObservation {
	readonly key: RunnerBackendKey;
	readonly observedAtMs: number;
	readonly result: GatewayVmRecoveryObservationResult;
}

export interface RunnerBackendLifecycleEvent {
	readonly key: RunnerBackendKey;
	readonly observedAtMs: number;
	readonly result?: 'failed' | 'ok' | undefined;
}

export interface RunnerVmRecoveryTracker {
	markRecoveryFinished(event: RunnerBackendLifecycleEvent): void;
	markRecoveryStarted(event: RunnerBackendLifecycleEvent): void;
	recordRunnerBackendProbe(
		observation: RunnerBackendProbeObservation,
	): GatewayVmRecoveryDecision;
}

function backendZoneKey(key: RunnerBackendKey): string {
	return `runner:${key.zoneId}\0${key.profileId}\0${key.providerId}`;
}

export function createRunnerVmRecoveryTracker(options: {
	readonly policy: GatewayVmAutoRecoveryPolicy;
}): RunnerVmRecoveryTracker {
	const tracker = createGatewayVmRecoveryTracker({ policy: options.policy });
	return {
		markRecoveryFinished(event) {
			tracker.markRecoveryFinished({
				observedAtMs: event.observedAtMs,
				...(event.result === undefined ? {} : { result: event.result }),
				zoneId: backendZoneKey(event.key),
			});
		},
		markRecoveryStarted(event) {
			tracker.markRecoveryStarted({
				observedAtMs: event.observedAtMs,
				zoneId: backendZoneKey(event.key),
			});
		},
		recordRunnerBackendProbe(observation) {
			return tracker.recordGatewayServiceProbe({
				observedAtMs: observation.observedAtMs,
				result: observation.result,
				zoneId: backendZoneKey(observation.key),
			});
		},
	};
}
```

- [ ] **Step 3: Run test to verify it passes**

Run: `pnpm vitest run packages/agent-vm/src/controller/leases/runner-vm-recovery-tracker.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 4: Commit**

```bash
git add packages/agent-vm/src/controller/leases/runner-vm-recovery-tracker.ts packages/agent-vm/src/controller/leases/runner-vm-recovery-tracker.test.ts
git commit -m "feat(agent-vm): add runner VM recovery tracker reusing gateway state machine"
```

---

## Task 11: Runner VM startup recovery

**Files:**
- Create: `packages/agent-vm/src/controller/leases/runner-vm-recovery.ts`
- Test: `packages/agent-vm/src/controller/leases/runner-vm-recovery.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/agent-vm/src/controller/leases/runner-vm-recovery.test.ts
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { createRunnerLeaseId } from '@agent-vm/gateway-interface';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	buildRunnerVmRuntimeRecord,
	writeRunnerVmRuntimeRecord,
} from './runner-vm-runtime-record.js';
import { reapStaleRunnerVmRuntimeRecords } from './runner-vm-recovery.js';

describe('runner-vm-recovery', () => {
	let stateDir: string;

	beforeEach(async () => {
		stateDir = await mkdtemp(path.join(tmpdir(), 'runner-recovery-'));
	});

	afterEach(async () => {
		await rm(stateDir, { force: true, recursive: true });
	});

	it('deletes records whose qemu pid is gone', async () => {
		const record = await buildRunnerVmRuntimeRecord({
			controllerPort: 18800,
			leaseId: createRunnerLeaseId(),
			poolSlot: 0,
			processIdentity: {
				command: '/usr/bin/qemu-system-x86_64',
				lstart: 'Fri May 29 10:00:00 2026',
				pid: 12345,
			},
			profileId: 'personal',
			projectNamespace: 'agent-vm',
			providerId: 'google',
			qemuPid: 12345,
			recordId: '11111111-1111-4111-8111-111111111111',
			systemConfigPath: '/etc/agent-vm/system.json',
			vmId: 'vm-runner-0',
			zoneId: 'shravan-claw',
		});
		await writeRunnerVmRuntimeRecord(stateDir, record);
		await reapStaleRunnerVmRuntimeRecords({
			controllerPort: 18800,
			projectNamespace: 'agent-vm',
			readProcessIdentity: vi.fn().mockResolvedValue(undefined),
			signalProcessKill: vi.fn(),
			stateDir,
			systemConfigPath: '/etc/agent-vm/system.json',
		});
		const remaining = await readdir(
			path.join(stateDir, 'runner-leases'),
		).catch(() => []);
		expect(remaining).toEqual([]);
	});

	it('keeps records whose pid still owns the qemu process', async () => {
		const record = await buildRunnerVmRuntimeRecord({
			controllerPort: 18800,
			leaseId: createRunnerLeaseId(),
			poolSlot: 0,
			processIdentity: {
				command: '/usr/bin/qemu-system-x86_64',
				lstart: 'Fri May 29 10:00:00 2026',
				pid: 12345,
			},
			profileId: 'personal',
			projectNamespace: 'agent-vm',
			providerId: 'google',
			qemuPid: 12345,
			recordId: '22222222-2222-4222-8222-222222222222',
			systemConfigPath: '/etc/agent-vm/system.json',
			vmId: 'vm-runner-0',
			zoneId: 'shravan-claw',
		});
		await writeRunnerVmRuntimeRecord(stateDir, record);
		await reapStaleRunnerVmRuntimeRecords({
			controllerPort: 18800,
			projectNamespace: 'agent-vm',
			readProcessIdentity: vi.fn().mockResolvedValue({
				command: '/usr/bin/qemu-system-x86_64',
				lstart: 'Fri May 29 10:00:00 2026',
				pid: 12345,
			}),
			signalProcessKill: vi.fn(),
			stateDir,
			systemConfigPath: '/etc/agent-vm/system.json',
		});
		const remaining = await readdir(
			path.join(stateDir, 'runner-leases'),
		);
		expect(remaining).toEqual([`${record.recordId}.json`]);
	});
});
```

- [ ] **Step 2: Implement startup cleanup**

```ts
// packages/agent-vm/src/controller/leases/runner-vm-recovery.ts
import { readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

import type { ProcessIdentity } from '../../shared/managed-vm-process.js';
import {
	parseRunnerVmRuntimeRecord,
	runnerLeasesDirectoryFor,
} from './runner-vm-runtime-record.js';

export interface ReapStaleRunnerVmRuntimeRecordsProps {
	readonly controllerPort: number;
	readonly projectNamespace: string;
	readonly readProcessIdentity: (props: {
		readonly hostPid: number;
	}) => Promise<ProcessIdentity | undefined>;
	readonly signalProcessKill: (pid: number) => void;
	readonly stateDir: string;
	readonly systemConfigPath: string;
}

function writeRunnerVmRecoveryWarning(message: string): void {
	process.stderr.write(`[runner-vm-recovery] ${message}\n`);
}

export async function reapStaleRunnerVmRuntimeRecords(
	props: ReapStaleRunnerVmRuntimeRecordsProps,
): Promise<void> {
	const directoryPath = runnerLeasesDirectoryFor(props.stateDir);
	let entries: string[];
	try {
		entries = await readdir(directoryPath);
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.endsWith('.json')) {
			continue;
		}
		const filePath = path.join(directoryPath, entry);
		// oxlint-disable-next-line eslint/no-await-in-loop -- per-record cleanup is sequential by design
		const rawContents = await readFile(filePath, 'utf8').catch(
			() => undefined,
		);
		if (rawContents === undefined) {
			continue;
		}
		let record;
		try {
			record = parseRunnerVmRuntimeRecord(JSON.parse(rawContents));
		} catch (error) {
			writeRunnerVmRecoveryWarning(
				`skipping unparseable record '${entry}': ${error instanceof Error ? error.message : String(error)}`,
			);
			continue;
		}
		if (
			record.fences.controllerPort !== props.controllerPort ||
			record.fences.projectNamespace !== props.projectNamespace ||
			record.fences.systemConfigPath !== props.systemConfigPath
		) {
			writeRunnerVmRecoveryWarning(
				`skipping foreign record '${entry}': fence mismatch`,
			);
			continue;
		}
		// oxlint-disable-next-line eslint/no-await-in-loop -- sequential by design
		const liveIdentity = await props.readProcessIdentity({
			hostPid: record.qemuPid,
		});
		const stillOwned =
			liveIdentity !== undefined &&
			liveIdentity.pid === record.processIdentity.pid &&
			liveIdentity.lstart === record.processIdentity.lstart &&
			liveIdentity.command === record.processIdentity.command;
		if (stillOwned) {
			continue;
		}
		if (liveIdentity !== undefined) {
			// PID exists but is not our process; do not signal.
			writeRunnerVmRecoveryWarning(
				`record '${entry}' pid ${String(record.qemuPid)} is owned by a different process; leaving record`,
			);
			continue;
		}
		// oxlint-disable-next-line eslint/no-await-in-loop -- sequential by design
		await rm(filePath, { force: true });
	}
}
```

- [ ] **Step 3: Run test to verify it passes**

Run: `pnpm vitest run packages/agent-vm/src/controller/leases/runner-vm-recovery.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 4: Commit**

```bash
git add packages/agent-vm/src/controller/leases/runner-vm-recovery.ts packages/agent-vm/src/controller/leases/runner-vm-recovery.test.ts
git commit -m "feat(agent-vm): add runner VM startup recovery"
```

---

## Task 12: System config — credentialRunner block

**Files:**
- Modify: `packages/agent-vm/src/config/system-config.ts`
- Modify: `packages/agent-vm/src/config/system-config.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `system-config.test.ts`:

```ts
describe('system-config / credentialRunner', () => {
	it('accepts a credentialRunner block with pool and recovery', () => {
		const result = systemConfigSchema.parse({
			...minimalSystemConfigInput(),
			zones: [
				{
					...minimalOpenClawZoneInput(),
					credentialRunner: {
						pool: { basePort: 21000, size: 8 },
						recovery: {
							enabled: true,
							consecutiveFailureThreshold: 3,
							cooldownMs: 60_000,
							failedRecoveryResetMs: 600_000,
							maxConsecutiveFailedRecoveries: 5,
							restartTimeoutMs: 30_000,
						},
					},
				},
			],
		});
		expect(result.zones[0]?.credentialRunner?.pool.size).toBe(8);
	});

	it('rejects credentialRunner pool overlapping the Tool VM pool', () => {
		expect(() =>
			systemConfigSchema.parse({
				...minimalSystemConfigInput(),
				zones: [
					{
						...minimalOpenClawZoneInput({ toolVmPool: { basePort: 19000, size: 16 } }),
						credentialRunner: {
							pool: { basePort: 19010, size: 4 },
						},
					},
				],
			}),
		).toThrow(/credentialRunner.*pool.*overlap/iu);
	});
});
```

- [ ] **Step 2: Implement the schema and overlap validation**

In `system-config.ts`, add (next to existing zone schemas):

```ts
const credentialRunnerPoolSchema = z
	.object({
		basePort: z.number().int().min(1024).max(65535),
		size: z.number().int().positive().max(256),
	})
	.strict();

const credentialRunnerRecoverySchema = z
	.object({
		consecutiveFailureThreshold: z.number().int().positive().default(3),
		cooldownMs: z.number().int().positive().default(60_000),
		enabled: z.boolean().default(true),
		failedRecoveryResetMs: z.number().int().positive().default(600_000),
		maxConsecutiveFailedRecoveries: z.number().int().positive().default(5),
		restartTimeoutMs: z.number().int().positive().default(30_000),
	})
	.strict();

const credentialRunnerSchema = z
	.object({
		pool: credentialRunnerPoolSchema,
		recovery: credentialRunnerRecoverySchema.default({
			consecutiveFailureThreshold: 3,
			cooldownMs: 60_000,
			enabled: true,
			failedRecoveryResetMs: 600_000,
			maxConsecutiveFailedRecoveries: 5,
			restartTimeoutMs: 30_000,
		}),
	})
	.strict();

// Inside the OpenClaw zone schema, add:
// credentialRunner: credentialRunnerSchema.optional(),

// In zone refine block (existing or new):
.refine(
	(zone) => {
		const credentialRunner = zone.credentialRunner;
		if (!credentialRunner) {
			return true;
		}
		const toolVmPool = zone.toolVmPool;
		if (!toolVmPool) {
			return true;
		}
		const credentialFirst = credentialRunner.pool.basePort;
		const credentialLastExclusive = credentialFirst + credentialRunner.pool.size;
		const toolFirst = toolVmPool.basePort;
		const toolLastExclusive = toolFirst + toolVmPool.size;
		return (
			credentialLastExclusive <= toolFirst || credentialFirst >= toolLastExclusive
		);
	},
	{
		message:
			'zones[].credentialRunner.pool overlaps zones[].toolVmPool. Choose non-overlapping port ranges.',
		path: ['credentialRunner', 'pool'],
	},
);
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `pnpm vitest run packages/agent-vm/src/config/system-config.test.ts`
Expected: PASS for the two new tests.

- [ ] **Step 4: Commit**

```bash
git add packages/agent-vm/src/config/system-config.ts packages/agent-vm/src/config/system-config.test.ts
git commit -m "feat(agent-vm): add credentialRunner zone config with pool and recovery"
```

---

## Task 13: Controller-runtime wiring

**Files:**
- Modify: `packages/agent-vm/src/controller/controller-runtime.ts`
- Modify: `packages/agent-vm/src/controller/controller-runtime.test.ts`

- [ ] **Step 1: Write the failing test for startup ordering**

Add to `controller-runtime.test.ts`:

```ts
it('runs runner runtime recovery alongside Tool VM recovery before opening lease routes', async () => {
	const events: string[] = [];
	const runtime = await startControllerRuntime(createRuntimeOptions(), {
		startHttpServer: async () => {
			events.push('http');
			return { close: vi.fn(async () => {}) };
		},
		startGatewayZone: vi.fn(async () => {
			events.push('zone');
			return createGatewayZoneStartResult();
		}),
		reapStaleRunnerVmRuntimeRecords: vi.fn(async () => {
			events.push('runner-recovery');
		}),
	});
	await runtime.close();
	expect(events).toEqual(['http', 'runner-recovery', 'zone']);
});
```

- [ ] **Step 2: Wire the runner lease manager and recovery in controller-runtime.ts**

In `controller-runtime.ts`:

```ts
import { createRunnerLeaseManager, type RunnerLeaseManager } from './leases/runner-lease-manager.js';
import { createRunnerVmRecoveryTracker } from './leases/runner-vm-recovery-tracker.js';
import { reapStaleRunnerVmRuntimeRecords } from './leases/runner-vm-recovery.js';

// After tcpPool construction, add a second pool for runners (per zone with credentialRunner config):
const runnerTcpPoolByZone = new Map<string, TcpPool>();
for (const zone of options.systemConfig.zones) {
	if (!isOpenClawZone(zone)) continue;
	const credentialRunner = zone.credentialRunner;
	if (!credentialRunner) continue;
	runnerTcpPoolByZone.set(zone.id, createTcpPool({
		basePort: credentialRunner.pool.basePort,
		size: credentialRunner.pool.size,
	}));
}

const runnerLeaseManagersByZone = new Map<string, RunnerLeaseManager>();
for (const [zoneId, pool] of runnerTcpPoolByZone.entries()) {
	runnerLeaseManagersByZone.set(zoneId, createRunnerLeaseManager({
		controllerPort: options.systemConfig.host.controllerPort,
		createManagedVm: createRunnerManagedVm(zoneId, options),
		now,
		projectNamespace: options.systemConfig.host.projectNamespace,
		stateDirFor: () => stateDirForZone(zoneId, options),
		systemConfigPath: options.systemConfigPath,
		tcpPool: pool,
	}));
}

// Before startGatewayZone calls, run runner recovery in parallel:
const runnerRecoveryPromises: Promise<void>[] = [];
for (const [zoneId] of runnerTcpPoolByZone.entries()) {
	runnerRecoveryPromises.push(
		(dependencies.reapStaleRunnerVmRuntimeRecords ?? reapStaleRunnerVmRuntimeRecords)({
			controllerPort: options.systemConfig.host.controllerPort,
			projectNamespace: options.systemConfig.host.projectNamespace,
			readProcessIdentity: readProcessIdentityDefault,
			signalProcessKill: defaultSignalProcessKill,
			stateDir: stateDirForZone(zoneId, options),
			systemConfigPath: options.systemConfigPath,
		}),
	);
}
await Promise.all(runnerRecoveryPromises);
```

- [ ] **Step 3: Run test to verify it passes**

Run: `pnpm vitest run packages/agent-vm/src/controller/controller-runtime.test.ts`
Expected: PASS for the new test.

- [ ] **Step 4: Commit**

```bash
git add packages/agent-vm/src/controller/controller-runtime.ts packages/agent-vm/src/controller/controller-runtime.test.ts
git commit -m "feat(agent-vm): wire runner lease manager and startup recovery into controller runtime"
```

---

## Task 14: OpenClawZoneRuntime — release runner leases on restart

**Files:**
- Modify: `packages/agent-vm/src/controller/zone-runtimes/openclaw-zone-runtime.ts`
- Modify: `packages/agent-vm/src/controller/zone-runtimes/openclaw-zone-runtime.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('releaseZoneLeases releases runner leases for the zone with force', async () => {
	const releasedToolVmLeases: string[] = [];
	const releasedRunnerLeases: string[] = [];
	const runtime = createOpenClawZoneRuntime({
		...baseOptions,
		leaseManager: {
			listLeases: () => [
				{ id: 'tool-1', zoneId: 'shravan-claw' } as never,
				{ id: 'tool-2', zoneId: 'other-zone' } as never,
			],
			releaseLease: async (id) => {
				releasedToolVmLeases.push(id);
			},
		},
		runnerLeaseManager: {
			listLeases: () => [
				{ id: 'runner-1' as never, zoneId: 'shravan-claw' } as never,
				{ id: 'runner-2' as never, zoneId: 'other-zone' } as never,
			],
			releaseLease: async (id: never) => {
				releasedRunnerLeases.push(id as string);
			},
		},
	});
	await runtime.restart();
	expect(releasedToolVmLeases).toEqual(['tool-1']);
	expect(releasedRunnerLeases).toEqual(['runner-1']);
});
```

- [ ] **Step 2: Widen `CreateOpenClawZoneRuntimeOptions` and `releaseZoneLeases`**

In `openclaw-zone-runtime.ts`:

```ts
import type { RunnerLeaseManager } from '../leases/runner-lease-manager.js';

export interface CreateOpenClawZoneRuntimeOptions {
	// ... existing fields ...
	readonly runnerLeaseManager?: Pick<RunnerLeaseManager, 'listLeases' | 'releaseLease'>;
}

const releaseZoneLeases = async (
	zoneId: string,
): Promise<{ readonly failedLeaseIds: readonly string[] }> => {
	const toolVmLeases = options.leaseManager
		.listLeases()
		.filter((lease) => lease.zoneId === zoneId);
	const runnerLeases = options.runnerLeaseManager
		? options.runnerLeaseManager
				.listLeases()
				.filter((lease) => lease.zoneId === zoneId)
		: [];
	const releaseResults = await Promise.allSettled([
		...toolVmLeases.map(
			async (lease) =>
				await options.leaseManager.releaseLease(lease.id, { force: true }),
		),
		...runnerLeases.map(
			async (lease) =>
				await options.runnerLeaseManager?.releaseLease(lease.id, { force: true }),
		),
	]);
	const allLeases = [...toolVmLeases, ...runnerLeases];
	const failedLeaseIds: string[] = [];
	for (const [index, result] of releaseResults.entries()) {
		if (result.status === 'fulfilled') continue;
		const leaseId = allLeases[index]?.id ?? `(unknown lease at index ${String(index)})`;
		failedLeaseIds.push(String(leaseId));
		writeOpenClawZoneRuntimeLog(
			`lease '${String(leaseId)}' release failed while restarting zone '${zoneId}': ${formatUnknownError(result.reason)}`,
		);
	}
	return { failedLeaseIds };
};
```

- [ ] **Step 3: Run test to verify it passes**

Run: `pnpm vitest run packages/agent-vm/src/controller/zone-runtimes/openclaw-zone-runtime.test.ts`
Expected: PASS for the new test.

- [ ] **Step 4: Commit**

```bash
git add packages/agent-vm/src/controller/zone-runtimes/openclaw-zone-runtime.ts packages/agent-vm/src/controller/zone-runtimes/openclaw-zone-runtime.test.ts
git commit -m "feat(agent-vm): release runner leases on OpenClaw zone restart"
```

---

## Task 15: Documentation updates and remove superseded plan

**Files:**
- Modify: `docs/architecture/storage-model.md`
- Modify: `docs/subsystems/controller.md`
- Modify: `docs/architecture/overview.md`
- Delete: `docs/superpowers/plans/2026-05-22-credentialed-runner-v1.md`

- [ ] **Step 1: Update storage-model.md**

In the directory layout section, add under `<stateDir>/`:

```
runner-leases/<recordId>.json    Runner cap lease runtime records
                                 (UUID filename; backup: excluded)
credential-runner/profiles/...   Encrypted credential state (separate
                                 plan; backup: included)
```

In the lease records section, add:

> Runner lease records mirror Tool VM lease records in shape and backup
> policy: UUIDv7 lease ids live inside the record body, while filenames
> are independent `randomUUID()` values. Encrypted credential state at
> `credential-runner/profiles/<profile>/<provider>/realfs.age` is owned
> by the credential state plan, not the lease manager.

- [ ] **Step 2: Update controller.md**

Add a new section after the Tool VM lease section:

```markdown
## Runner Lease Manager

The controller hosts a second lease manager for credentialed runner
backends. It lives at `packages/agent-vm/src/controller/leases/
runner-lease-manager.ts` and is keyed by `zoneId + profileId +
providerId`. Calls happen in-process; the runner lease is never
exposed via HTTP. On zone restart the manager's leases are released
alongside Tool VM leases.
```

- [ ] **Step 3: Update overview.md**

Add `RunnerCapLease<'gondolin-rpc'>` to the lease-shapes diagram next
to `ToolVmSshLease<'ssh-sandbox'>`, mirroring the mental-model diagram
in this plan.

- [ ] **Step 4: Delete the superseded plan**

```bash
git rm docs/superpowers/plans/2026-05-22-credentialed-runner-v1.md
```

- [ ] **Step 5: Run the broad quality gate**

Run: `pnpm check`
Expected: PASS — formatting, linting, typecheck, and full unit + integration suites.

- [ ] **Step 6: Commit**

```bash
git add docs/architecture/storage-model.md docs/subsystems/controller.md docs/architecture/overview.md
git commit -m "docs: document runner cap lease manager and storage layout"
```

---

## Self-Review

Before treating this plan as ready to execute:

1. **Spec coverage.** Every section of "What this plan DOES design" maps to at least one task:
   - Types + errors (Tasks 1, 2, 3, 4)
   - Mount spec + fingerprint (Task 5)
   - Runtime record + IO (Task 6)
   - Manager (Tasks 7, 8, 9)
   - Recovery tracker (Task 10)
   - Startup recovery (Task 11)
   - Config (Task 12)
   - Controller wiring (Task 13)
   - Zone runtime restart contract (Task 14)
   - Docs (Task 15)
2. **Placeholder scan.** No "TBD", "implement later", or generic "add error handling" steps remain.
3. **Type consistency.** `RunnerLeaseId`, `RunnerCapLease`, `RunnerCredentialMountSpec`, and `RunnerLeaseManager` use the same names across tasks. The shipped `GatewayVmAutoRecoveryPolicy` type is reused verbatim; the runner recovery tracker re-uses it without renaming.
4. **Boundary discipline.** Catalog plan, credential state plan, and MCP Portal coexistence are NOT touched by any task.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-29-vm-capability-lease-redesign.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration. Uses `superpowers:subagent-driven-development`.
2. **Inline Execution** — execute tasks in this session with checkpoints. Uses `superpowers:executing-plans`.

Which approach?
