# Gateway VM Auto Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically recover OpenClaw gateway-service death or a persistently broken gateway-to-controller control link by restarting the gateway VM after 10 consecutive failed observations, with a 61-minute per-zone automatic restart cooldown and verifiable old/new VM identity.

**Architecture:** Keep health observation and recovery policy separate. The existing gateway-service health monitor records host-observed `/readyz` probe events and also evaluates the latest gateway-to-controller `gateway-control-link` event. A new pure recovery tracker turns repeated failed observations into a restart decision, and the controller runtime wires that decision to the existing OpenClaw zone runtime restart primitive. The restart is considered successful only if the new gateway VM identity differs from the old one and the replacement gateway-service becomes healthy.

**Tech Stack:** TypeScript, Node 24, Vitest, Zod system config schema, agent-vm controller runtime, Gondolin managed VM runtime records, OpenClaw gateway health checks.

---

## Requirements

- Default automatic gateway VM recovery is enabled when controller health is enabled.
- Default failure threshold is 10 consecutive failed observations for either gateway-service health or gateway-to-controller control-link health.
- Default automatic restart cooldown is 61 minutes per zone.
- A single successful gateway-service probe resets the consecutive failure count.
- A single fresh successful gateway-control-link event resets the control-link failure count.
- Missing gateway-control-link history by itself does not trigger recovery. Control-link recovery starts counting only after the controller has observed at least one control-link event for that zone.
- A recovery attempt is single-flight per zone.
- A recovery attempt has a bounded deadline. Default: 10 minutes.
- Automatic restart cooldown applies to automatic restart attempts, successful or failed, to prevent restart storms.
- Automatic restart cooldown is measured from the last automatic restart attempt. A later healthy probe resets consecutive failures, but it does not reset the 61-minute restart-attempt cooldown.
- Provider-only failures such as Discord `403` / websocket `1006` do not trigger gateway VM restart unless they also make gateway-service health or gateway-control-link health fail repeatedly.
- Tool VM lease or SSH failures do not trigger gateway VM restart; those stay in lease recovery.
- Restart must release/stale old zone Tool VM leases because the gateway VM and OpenClaw process state changed.
- Restart success must prove a real VM replacement using old/new VM identity: `vmId`, `hostPid`, and `bootedAt`. Auto-recovery is only valid when the old zone snapshot is already `running` and has a gateway identity; it must not silently become a cold-start path for stopped or failed zones.
- Recovery must emit typed health events so beta and later Victoria-style monitoring can see recovery attempts.
- Tests must cover unit policy, runtime integration, and a gated live OpenClaw/Gondolin smoke that kills the gateway-service and proves a new VM boots.

## File Structure

### `packages/gateway-interface/src/health/agent-vm-health.ts`

Owns shared typed health event contracts. Add a `gateway-recovery` event kind and `gateway-recovery-failed` issue kind.

### `packages/gateway-interface/src/health/agent-vm-health.test.ts`

Unit coverage for `gateway-recovery` validation, bucketing, and failed snapshot derivation.

### `packages/agent-vm/src/config/system-config.ts`

Owns `controller.health` schema and defaults. Add `gatewayServiceAutoRestart` config with defaults:

```ts
{
	enabled: true,
	consecutiveFailureThreshold: 10,
	cooldownMs: 61 * 60 * 1000,
	restartTimeoutMs: 10 * 60 * 1000,
}
```

### `packages/agent-vm/src/config/system-config.test.ts`

Unit coverage for defaults, overrides, and non-positive recovery settings.

### `packages/agent-vm/src/controller/health/gateway-vm-recovery-policy.ts`

New pure module. Tracks consecutive gateway-service failures, consecutive gateway-control-link failures, cooldown, and in-flight recovery state. It has no runtime side effects.

### `packages/agent-vm/src/controller/health/gateway-vm-recovery-policy.test.ts`

Unit coverage for 10-in-a-row threshold, OK reset, control-link stale/failure counting, cooldown, and single-flight behavior.

### `packages/agent-vm/src/controller/health/gateway-service-health-monitor.ts`

Extend existing monitor to call the recovery tracker after each gateway-service probe and after each control-link observation derived from the health event store. Invoke a controller-provided recovery callback only when the tracker returns a restart decision.

### `packages/agent-vm/src/controller/health/gateway-service-health-monitor.test.ts`

Unit coverage that the monitor records health every tick, does not restart before 10 failures, restarts once at the 10th gateway-service failure, restarts once at the 10th degraded control-link observation, records recovery events, and honors cooldown.

### `packages/agent-vm/src/controller/zone-runtimes/openclaw-zone-runtime.ts`

Make `restart()` release target-zone Tool VM leases before replacing the gateway VM. Existing manual restart callers keep using the same method.

### `packages/agent-vm/src/controller/zone-runtimes/zone-runtime-types.ts`

Expose enough runtime snapshot identity for recovery verification through the existing `getSnapshot()` result. Do not add a second restart API unless implementation proves the current snapshot is insufficient.

### `packages/agent-vm/src/controller/zone-runtimes/zone-runtime-registry.test.ts`

Unit coverage that OpenClaw runtime restart force-releases only leases for the restarted zone.

### `packages/agent-vm/src/controller/controller-runtime.ts`

Wire controller health config into the gateway-service health monitor and provide the recovery callback. The callback snapshots old identity, calls `registry.getOpenClawRuntime(zoneId).restart()`, snapshots new identity, verifies replacement, records a `gateway-recovery` event, and logs the recovery outcome.

### `packages/agent-vm/src/controller/controller-runtime.test.ts`

Integration-style unit coverage using fake managed VMs: repeated failed `/readyz` probes and repeated stale gateway-control-link observations can each trigger one real runtime restart, old/new identity differs, leases are released, and cooldown blocks a second automatic restart.

### `packages/agent-vm/src/integration-tests/live-openclaw-control-link.smoke.test.ts`

Add a gated live smoke case that kills the OpenClaw gateway-service inside a real Gondolin gateway VM, waits for automatic recovery, and asserts a new VM id / host pid is observed.

### Docs

Update:

- `docs/subsystems/controller.md`
- `docs/architecture/openclaw-gateway.md`
- `docs/reference/configuration/system-json.md`
- `packages/agent-vm/src/cli/manual-templates.ts`
- `packages/agent-vm/src/cli/manual-templates.test.ts`

Document the exact recovery rule: 10 consecutive failed gateway-service probes or 10 consecutive degraded gateway-control-link observations, 10-minute recovery deadline, 61-minute automatic restart cooldown, and no VM reboot for provider-only churn alone.

---

## Task 1: Shared Gateway Recovery Health Event

**Files:**
- Modify: `packages/gateway-interface/src/health/agent-vm-health.ts`
- Modify: `packages/gateway-interface/src/health/agent-vm-health.test.ts`

- [ ] **Step 1: Write failing tests for the new health event**

Add these tests to `packages/gateway-interface/src/health/agent-vm-health.test.ts`:

```ts
it('accepts gateway recovery health events', () => {
	const event = {
		action: 'gateway-vm-restart',
		cooldownMs: 3_660_000,
		consecutiveFailures: 10,
		elapsedMs: 45_000,
		kind: 'gateway-recovery',
		newBootedAt: '2026-05-27T13:01:00.000Z',
		newHostPid: 2222,
		newVmId: 'new-gateway-vm',
		observedAtMs: 1_000,
		oldBootedAt: '2026-05-27T12:00:00.000Z',
		oldHostPid: 1111,
		oldVmId: 'old-gateway-vm',
		reason: 'gateway-service-unhealthy',
		result: 'ok',
		zoneId: 'sunfam',
	} satisfies AgentVmHealthEvent;

	expect(isAgentVmHealthEvent(event)).toBe(true);
	expect(healthEventBucketKey(event)).toBe('sunfam:gateway-recovery:gateway-vm-restart');
});

it('surfaces failed gateway recovery as a zone health issue', () => {
	const event = {
		action: 'gateway-vm-restart',
		cooldownMs: 3_660_000,
		consecutiveFailures: 10,
		elapsedMs: 45_000,
		errorCode: 'restart-verification-failed',
		kind: 'gateway-recovery',
		observedAtMs: 1_000,
		oldBootedAt: '2026-05-27T12:00:00.000Z',
		oldHostPid: 1111,
		oldVmId: 'old-gateway-vm',
		reason: 'gateway-service-unhealthy',
		result: 'failed',
		zoneId: 'sunfam',
	} satisfies AgentVmHealthEvent;

	const snapshot = deriveZoneHealthSnapshot([event], {
		nowMs: 2_000,
		staleAfterMs: 30_000,
		zoneId: 'sunfam',
	});

	expect(snapshot.kind).toBe('failed');
	if (snapshot.kind !== 'failed') {
		throw new Error('Expected failed snapshot.');
	}
	expect(snapshot.issues[0]?.kind).toBe('gateway-recovery-failed');
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
pnpm vitest run packages/gateway-interface/src/health/agent-vm-health.test.ts
```

Expected: FAIL because `gateway-recovery` and `gateway-recovery-failed` are not part of the contract.

- [ ] **Step 3: Implement the shared event contract**

In `packages/gateway-interface/src/health/agent-vm-health.ts`, add the new event kind:

```ts
export const agentVmHealthEventKinds = [
	'gateway-service-health',
	'gateway-control-link',
	'controller-request',
	'lease-renew',
	'lease-heartbeat',
	'tool-vm-ssh',
	'gateway-plugin-health',
	'gateway-recovery',
] as const;
```

Add the recovery event branch to `AgentVmHealthEvent`:

```ts
| (AgentVmHealthEventBase & {
		readonly action: 'gateway-vm-restart';
		readonly consecutiveFailures: number;
		readonly cooldownMs: number;
		readonly elapsedMs: number;
		readonly errorCode?: string | undefined;
		readonly kind: 'gateway-recovery';
		readonly newBootedAt?: string | undefined;
		readonly newHostPid?: number | undefined;
		readonly newVmId?: string | undefined;
		readonly oldBootedAt?: string | undefined;
		readonly oldHostPid?: number | undefined;
		readonly oldVmId?: string | undefined;
		readonly reason: 'gateway-control-link-unhealthy' | 'gateway-service-unhealthy';
	  })
```

Add `gateway-recovery-failed` to `zoneHealthIssueKinds`:

```ts
export const zoneHealthIssueKinds = [
	'gateway-service-unhealthy',
	'gateway-control-link-unhealthy',
	'controller-request-failing',
	'lease-heartbeat-failing',
	'lease-renew-failing',
	'tool-vm-ssh-failing',
	'gateway-plugin-unhealthy',
	'gateway-recovery-failed',
	'health-event-stale',
] as const;
```

Add the runtime guard case:

```ts
case 'gateway-recovery':
	return (
		value.action === 'gateway-vm-restart' &&
		Number.isInteger(value.consecutiveFailures) &&
		value.consecutiveFailures > 0 &&
		isNonNegativeFiniteNumber(value.cooldownMs) &&
		isNonNegativeFiniteNumber(value.elapsedMs) &&
		optionalString(value.errorCode) &&
		optionalString(value.newBootedAt) &&
		(value.newHostPid === undefined || Number.isInteger(value.newHostPid)) &&
		optionalString(value.newVmId) &&
		optionalString(value.oldBootedAt) &&
		(value.oldHostPid === undefined || Number.isInteger(value.oldHostPid)) &&
		optionalString(value.oldVmId) &&
		(value.reason === 'gateway-service-unhealthy' ||
			value.reason === 'gateway-control-link-unhealthy')
	);
```

Add the bucket key case:

```ts
case 'gateway-recovery':
	return `${event.zoneId}:${event.kind}:${event.action}`;
```

Add the issue mapping case:

```ts
case 'gateway-recovery':
	return 'gateway-recovery-failed';
```

- [ ] **Step 4: Run tests and verify they pass**

Run:

```bash
pnpm vitest run packages/gateway-interface/src/health/agent-vm-health.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add packages/gateway-interface/src/health/agent-vm-health.ts packages/gateway-interface/src/health/agent-vm-health.test.ts
git commit -m "feat: add gateway recovery health event"
```

---

## Task 2: Controller Health Recovery Config

**Files:**
- Modify: `packages/agent-vm/src/config/system-config.ts`
- Modify: `packages/agent-vm/src/config/system-config.test.ts`
- Modify: `docs/reference/configuration/system-json.md`

- [ ] **Step 1: Write failing config tests**

Update the default expectation in `packages/agent-vm/src/config/system-config.test.ts`:

```ts
expect(resolveControllerHealthConfig(loadedConfig)).toEqual({
	enabled: true,
	eventHistoryLimit: 500,
	gatewayControlLinkBackoffCeilingMs: 120_000,
	gatewayControlLinkIntervalMs: 10_000,
	gatewayServiceAutoRestart: {
		cooldownMs: 61 * 60 * 1000,
		consecutiveFailureThreshold: 10,
		enabled: true,
		restartTimeoutMs: 10 * 60 * 1000,
	},
	gatewayServiceIntervalMs: 10_000,
	staleAfterMs: 30_000,
});
```

Update the overrides test input:

```ts
config.controller = {
	health: {
		enabled: false,
		eventHistoryLimit: 25,
		gatewayControlLinkBackoffCeilingMs: 90_000,
		gatewayControlLinkIntervalMs: 15_000,
		gatewayServiceAutoRestart: {
			cooldownMs: 7_200_000,
			consecutiveFailureThreshold: 8,
			enabled: false,
			restartTimeoutMs: 480_000,
		},
		gatewayServiceIntervalMs: 20_000,
		staleAfterMs: 45_000,
	},
};
```

Update the overrides expectation:

```ts
expect(resolveControllerHealthConfig(loadedConfig)).toEqual({
	enabled: false,
	eventHistoryLimit: 25,
	gatewayControlLinkBackoffCeilingMs: 90_000,
	gatewayControlLinkIntervalMs: 15_000,
	gatewayServiceAutoRestart: {
		cooldownMs: 7_200_000,
		consecutiveFailureThreshold: 8,
		enabled: false,
		restartTimeoutMs: 480_000,
	},
	gatewayServiceIntervalMs: 20_000,
	staleAfterMs: 45_000,
});
```

Add a non-positive nested setting test:

```ts
test('rejects non-positive gateway service auto restart settings', async () => {
	const config = createValidSystemConfigInput();
	config.controller = {
		health: {
			gatewayServiceAutoRestart: {
				cooldownMs: 0,
				consecutiveFailureThreshold: 10,
				enabled: true,
				restartTimeoutMs: 10 * 60 * 1000,
			},
		},
	};
	const configPath = await writeSystemConfigForTest(
		'agent-vm-system-config-gateway-service-auto-restart-non-positive-',
		config,
	);

	await expect(loadSystemConfig(configPath)).rejects.toThrow(/cooldownMs/u);
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
pnpm vitest run packages/agent-vm/src/config/system-config.test.ts -t "controller health"
```

Expected: FAIL with `Unrecognized key(s): 'gatewayServiceAutoRestart'` because `controller.health` is strict and the nested recovery object is not part of the schema yet.

- [ ] **Step 3: Implement schema and defaults**

In `packages/agent-vm/src/config/system-config.ts`, add:

```ts
const defaultGatewayServiceAutoRestartConfig = {
	cooldownMs: 61 * 60 * 1000,
	consecutiveFailureThreshold: 10,
	enabled: true,
	restartTimeoutMs: 10 * 60 * 1000,
} as const;
```

Add this schema before `controllerHealthSchema`:

```ts
const gatewayServiceAutoRestartSchema = z
	.object({
		cooldownMs: z
			.number()
			.int()
			.positive()
			.default(defaultGatewayServiceAutoRestartConfig.cooldownMs),
		consecutiveFailureThreshold: z
			.number()
			.int()
			.positive()
			.default(defaultGatewayServiceAutoRestartConfig.consecutiveFailureThreshold),
		enabled: z.boolean().default(defaultGatewayServiceAutoRestartConfig.enabled),
		restartTimeoutMs: z
			.number()
			.int()
			.positive()
			.default(defaultGatewayServiceAutoRestartConfig.restartTimeoutMs),
	})
	.strict();
```

Add the field to `defaultControllerHealthConfig`:

```ts
gatewayServiceAutoRestart: defaultGatewayServiceAutoRestartConfig,
```

Add the field to `controllerHealthSchema`:

```ts
gatewayServiceAutoRestart: gatewayServiceAutoRestartSchema.default(
	defaultGatewayServiceAutoRestartConfig,
),
```

- [ ] **Step 4: Document config keys**

In `docs/reference/configuration/system-json.md`, add rows beside the existing controller health table:

```md
| `gatewayServiceAutoRestart.enabled` | `true` | Enables automatic gateway VM restart after repeated gateway-service or gateway-control-link health failures. |
| `gatewayServiceAutoRestart.consecutiveFailureThreshold` | `10` | Number of consecutive failed gateway-service probes or degraded gateway-control-link observations required before the zone becomes a restart candidate. A successful observation resets its own count. |
| `gatewayServiceAutoRestart.cooldownMs` | `3660000` | Minimum interval between automatic gateway VM restart attempts for the same zone. Manual restart paths are separate. |
| `gatewayServiceAutoRestart.restartTimeoutMs` | `600000` | Maximum time the controller waits for one automatic gateway VM restart attempt before recording a failed `gateway-recovery` event and allowing the monitor to continue. |
```

- [ ] **Step 5: Run tests and verify they pass**

Run:

```bash
pnpm vitest run packages/agent-vm/src/config/system-config.test.ts -t "controller health"
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add packages/agent-vm/src/config/system-config.ts packages/agent-vm/src/config/system-config.test.ts docs/reference/configuration/system-json.md
git commit -m "feat: configure gateway service auto restart"
```

---

## Task 3: Pure Gateway VM Recovery Policy

**Files:**
- Create: `packages/agent-vm/src/controller/health/gateway-vm-recovery-policy.ts`
- Create: `packages/agent-vm/src/controller/health/gateway-vm-recovery-policy.test.ts`

- [ ] **Step 1: Write failing policy tests**

Create `packages/agent-vm/src/controller/health/gateway-vm-recovery-policy.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { createGatewayVmRecoveryTracker } from './gateway-vm-recovery-policy.js';

const policy = {
	cooldownMs: 61 * 60 * 1000,
	consecutiveFailureThreshold: 10,
	enabled: true,
	restartTimeoutMs: 10 * 60 * 1000,
} as const;

describe('createGatewayVmRecoveryTracker', () => {
	it('waits for 10 consecutive failures before returning a restart decision', () => {
		const tracker = createGatewayVmRecoveryTracker({ policy });

		for (let index = 1; index <= 9; index += 1) {
			expect(
				tracker.recordGatewayServiceProbe({
					observedAtMs: index * 10_000,
					result: 'failed',
					zoneId: 'sunfam',
				}),
			).toEqual({ kind: 'none', consecutiveFailures: index });
		}

		expect(
			tracker.recordGatewayServiceProbe({
				observedAtMs: 100_000,
				result: 'failed',
				zoneId: 'sunfam',
			}),
		).toEqual({
			consecutiveFailures: 10,
			kind: 'restart',
			reason: 'gateway-service-unhealthy',
			zoneId: 'sunfam',
		});
	});

	it('resets consecutive failures after an ok probe', () => {
		const tracker = createGatewayVmRecoveryTracker({ policy });

		tracker.recordGatewayServiceProbe({ observedAtMs: 10_000, result: 'failed', zoneId: 'sunfam' });
		tracker.recordGatewayServiceProbe({ observedAtMs: 20_000, result: 'failed', zoneId: 'sunfam' });
		expect(
			tracker.recordGatewayServiceProbe({ observedAtMs: 30_000, result: 'ok', zoneId: 'sunfam' }),
		).toEqual({ consecutiveFailures: 0, kind: 'none' });
		expect(
			tracker.recordGatewayServiceProbe({ observedAtMs: 40_000, result: 'failed', zoneId: 'sunfam' }),
		).toEqual({ consecutiveFailures: 1, kind: 'none' });
	});

	it('waits for 10 degraded gateway-control-link observations before returning a restart decision', () => {
		const tracker = createGatewayVmRecoveryTracker({ policy });

		expect(
			tracker.recordGatewayControlLinkObservation({
				observedAtMs: 10_000,
				result: 'unobserved',
				zoneId: 'sunfam',
			}),
		).toEqual({ consecutiveFailures: 0, kind: 'none', reason: 'unobserved' });

		tracker.recordGatewayControlLinkObservation({
			observedAtMs: 20_000,
			result: 'ok',
			zoneId: 'sunfam',
		});

		for (let index = 1; index <= 9; index += 1) {
			expect(
				tracker.recordGatewayControlLinkObservation({
					observedAtMs: 20_000 + index * 10_000,
					result: 'stale',
					zoneId: 'sunfam',
				}),
			).toEqual({ consecutiveFailures: index, kind: 'none' });
		}

		expect(
			tracker.recordGatewayControlLinkObservation({
				observedAtMs: 120_000,
				result: 'stale',
				zoneId: 'sunfam',
			}),
		).toEqual({
			consecutiveFailures: 10,
			kind: 'restart',
			reason: 'gateway-control-link-unhealthy',
			zoneId: 'sunfam',
		});
	});

	it('blocks automatic restart decisions during cooldown', () => {
		const tracker = createGatewayVmRecoveryTracker({ policy });

		for (let index = 1; index <= 10; index += 1) {
			tracker.recordGatewayServiceProbe({
				observedAtMs: index * 10_000,
				result: 'failed',
				zoneId: 'sunfam',
			});
		}
		tracker.markRecoveryStarted({ observedAtMs: 100_000, zoneId: 'sunfam' });
		tracker.markRecoveryFinished({ observedAtMs: 130_000, result: 'failed', zoneId: 'sunfam' });

		expect(
			tracker.recordGatewayServiceProbe({
				observedAtMs: 140_000,
				result: 'failed',
				zoneId: 'sunfam',
			}),
		).toEqual({ consecutiveFailures: 11, kind: 'none', reason: 'cooldown' });
	});

	it('allows another automatic restart after the 61 minute cooldown expires', () => {
		const tracker = createGatewayVmRecoveryTracker({ policy });

		for (let index = 1; index <= 10; index += 1) {
			tracker.recordGatewayServiceProbe({
				observedAtMs: index * 10_000,
				result: 'failed',
				zoneId: 'sunfam',
			});
		}
		tracker.markRecoveryStarted({ observedAtMs: 100_000, zoneId: 'sunfam' });
		tracker.markRecoveryFinished({ observedAtMs: 130_000, result: 'failed', zoneId: 'sunfam' });

		expect(
			tracker.recordGatewayServiceProbe({
				observedAtMs: 100_000 + policy.cooldownMs + 1,
				result: 'failed',
				zoneId: 'sunfam',
			}),
		).toMatchObject({ kind: 'restart', zoneId: 'sunfam' });
	});

	it('does not reset automatic restart cooldown after a healthy interlude', () => {
		const tracker = createGatewayVmRecoveryTracker({ policy });

		for (let index = 1; index <= 10; index += 1) {
			tracker.recordGatewayServiceProbe({
				observedAtMs: index * 10_000,
				result: 'failed',
				zoneId: 'sunfam',
			});
		}
		tracker.markRecoveryStarted({ observedAtMs: 100_000, zoneId: 'sunfam' });
		tracker.markRecoveryFinished({ observedAtMs: 130_000, result: 'ok', zoneId: 'sunfam' });
		tracker.recordGatewayServiceProbe({ observedAtMs: 30 * 60 * 1000, result: 'ok', zoneId: 'sunfam' });

		for (let index = 1; index <= 9; index += 1) {
			expect(
				tracker.recordGatewayServiceProbe({
					observedAtMs: 31 * 60 * 1000 + index,
					result: 'failed',
					zoneId: 'sunfam',
				}),
			).toMatchObject({ kind: 'none' });
		}

		expect(
			tracker.recordGatewayServiceProbe({
				observedAtMs: 31 * 60 * 1000 + 10,
				result: 'failed',
				zoneId: 'sunfam',
			}),
		).toEqual({ consecutiveFailures: 10, kind: 'none', reason: 'cooldown' });
	});

	it('does not return overlapping restart decisions while recovery is in flight', () => {
		const tracker = createGatewayVmRecoveryTracker({ policy });

		for (let index = 1; index <= 10; index += 1) {
			tracker.recordGatewayServiceProbe({
				observedAtMs: index * 10_000,
				result: 'failed',
				zoneId: 'sunfam',
			});
		}
		tracker.markRecoveryStarted({ observedAtMs: 100_000, zoneId: 'sunfam' });

		expect(
			tracker.recordGatewayServiceProbe({
				observedAtMs: 110_000,
				result: 'failed',
				zoneId: 'sunfam',
			}),
		).toEqual({ consecutiveFailures: 11, kind: 'none', reason: 'in-flight' });
	});
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
pnpm vitest run packages/agent-vm/src/controller/health/gateway-vm-recovery-policy.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the pure tracker**

Create `packages/agent-vm/src/controller/health/gateway-vm-recovery-policy.ts`:

```ts
export interface GatewayVmAutoRecoveryPolicy {
	readonly cooldownMs: number;
	readonly consecutiveFailureThreshold: number;
	readonly enabled: boolean;
	readonly restartTimeoutMs: number;
}

export type GatewayVmRecoveryReason =
	| 'gateway-control-link-unhealthy'
	| 'gateway-service-unhealthy';

export type GatewayVmRecoveryDecision =
	| {
			readonly consecutiveFailures: number;
			readonly kind: 'none';
			readonly reason?: 'cooldown' | 'disabled' | 'in-flight' | 'unobserved' | undefined;
	  }
	| {
			readonly consecutiveFailures: number;
			readonly kind: 'restart';
			readonly reason: GatewayVmRecoveryReason;
			readonly zoneId: string;
	  };

interface GatewayVmRecoveryZoneState {
	readonly gatewayControlLinkConsecutiveFailures: number;
	readonly gatewayServiceConsecutiveFailures: number;
	readonly recoveryInFlight: boolean;
	readonly lastRecoveryAttemptAtMs?: number | undefined;
}

export interface GatewayVmRecoveryTracker {
	markRecoveryFinished(options: {
		readonly observedAtMs: number;
		readonly result: 'failed' | 'ok';
		readonly zoneId: string;
	}): void;
	markRecoveryStarted(options: { readonly observedAtMs: number; readonly zoneId: string }): void;
	recordGatewayServiceProbe(options: {
		readonly observedAtMs: number;
		readonly result: 'failed' | 'ok';
		readonly zoneId: string;
	}): GatewayVmRecoveryDecision;
	recordGatewayControlLinkObservation(options: {
		readonly observedAtMs: number;
		readonly result: 'failed' | 'ok' | 'stale' | 'unobserved';
		readonly zoneId: string;
	}): GatewayVmRecoveryDecision;
}

export function createGatewayVmRecoveryTracker(options: {
	readonly policy: GatewayVmAutoRecoveryPolicy;
}): GatewayVmRecoveryTracker {
	const stateByZone = new Map<string, GatewayVmRecoveryZoneState>();

	const readState = (zoneId: string): GatewayVmRecoveryZoneState =>
		stateByZone.get(zoneId) ?? {
			gatewayControlLinkConsecutiveFailures: 0,
			gatewayServiceConsecutiveFailures: 0,
			recoveryInFlight: false,
		};

	const writeState = (zoneId: string, state: GatewayVmRecoveryZoneState): void => {
		stateByZone.set(zoneId, state);
	};

	const decisionForFailures = (optionsForDecision: {
		readonly consecutiveFailures: number;
		readonly observedAtMs: number;
		readonly reason: GatewayVmRecoveryReason;
		readonly state: GatewayVmRecoveryZoneState;
		readonly zoneId: string;
	}): GatewayVmRecoveryDecision => {
		if (!options.policy.enabled) {
			return {
				consecutiveFailures: optionsForDecision.consecutiveFailures,
				kind: 'none',
				reason: 'disabled',
			};
		}
		if (optionsForDecision.state.recoveryInFlight) {
			return {
				consecutiveFailures: optionsForDecision.consecutiveFailures,
				kind: 'none',
				reason: 'in-flight',
			};
		}
		if (optionsForDecision.consecutiveFailures < options.policy.consecutiveFailureThreshold) {
			return { consecutiveFailures: optionsForDecision.consecutiveFailures, kind: 'none' };
		}
		if (
			optionsForDecision.state.lastRecoveryAttemptAtMs !== undefined &&
			optionsForDecision.observedAtMs - optionsForDecision.state.lastRecoveryAttemptAtMs <
				options.policy.cooldownMs
		) {
			return {
				consecutiveFailures: optionsForDecision.consecutiveFailures,
				kind: 'none',
				reason: 'cooldown',
			};
		}
		return {
			consecutiveFailures: optionsForDecision.consecutiveFailures,
			kind: 'restart',
			reason: optionsForDecision.reason,
			zoneId: optionsForDecision.zoneId,
		};
	};

	return {
		markRecoveryFinished(recoveryResult): void {
			const current = readState(recoveryResult.zoneId);
			writeState(recoveryResult.zoneId, {
				gatewayControlLinkConsecutiveFailures:
					recoveryResult.result === 'ok' ? 0 : current.gatewayControlLinkConsecutiveFailures,
				gatewayServiceConsecutiveFailures:
					recoveryResult.result === 'ok' ? 0 : current.gatewayServiceConsecutiveFailures,
				lastRecoveryAttemptAtMs: current.lastRecoveryAttemptAtMs,
				recoveryInFlight: false,
			});
		},
		markRecoveryStarted(recoveryStart): void {
			const current = readState(recoveryStart.zoneId);
			writeState(recoveryStart.zoneId, {
				...current,
				lastRecoveryAttemptAtMs: recoveryStart.observedAtMs,
				recoveryInFlight: true,
			});
		},
		recordGatewayServiceProbe(probe): GatewayVmRecoveryDecision {
			const current = readState(probe.zoneId);
			if (probe.result === 'ok') {
				writeState(probe.zoneId, {
					...current,
					gatewayServiceConsecutiveFailures: 0,
					lastRecoveryAttemptAtMs: current.lastRecoveryAttemptAtMs,
					recoveryInFlight: current.recoveryInFlight,
				});
				return { consecutiveFailures: 0, kind: 'none' };
			}

			const nextConsecutiveFailures = current.gatewayServiceConsecutiveFailures + 1;
			const nextState = {
				...current,
				gatewayServiceConsecutiveFailures: nextConsecutiveFailures,
			};
			writeState(probe.zoneId, nextState);
			return decisionForFailures({
				consecutiveFailures: nextConsecutiveFailures,
				observedAtMs: probe.observedAtMs,
				reason: 'gateway-service-unhealthy',
				state: current,
				zoneId: probe.zoneId,
			});
		},
		recordGatewayControlLinkObservation(observation): GatewayVmRecoveryDecision {
			const current = readState(observation.zoneId);
			if (observation.result === 'unobserved') {
				return { consecutiveFailures: 0, kind: 'none', reason: 'unobserved' };
			}
			if (observation.result === 'ok') {
				writeState(observation.zoneId, {
					...current,
					gatewayControlLinkConsecutiveFailures: 0,
				});
				return { consecutiveFailures: 0, kind: 'none' };
			}

			const nextConsecutiveFailures = current.gatewayControlLinkConsecutiveFailures + 1;
			const nextState = {
				...current,
				gatewayControlLinkConsecutiveFailures: nextConsecutiveFailures,
			};
			writeState(observation.zoneId, nextState);
			return decisionForFailures({
				consecutiveFailures: nextConsecutiveFailures,
				observedAtMs: observation.observedAtMs,
				reason: 'gateway-control-link-unhealthy',
				state: current,
				zoneId: observation.zoneId,
			});
		},
	};
}
```

- [ ] **Step 4: Run tests and verify they pass**

Run:

```bash
pnpm vitest run packages/agent-vm/src/controller/health/gateway-vm-recovery-policy.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add packages/agent-vm/src/controller/health/gateway-vm-recovery-policy.ts packages/agent-vm/src/controller/health/gateway-vm-recovery-policy.test.ts
git commit -m "feat: add gateway vm recovery policy"
```

---

## Task 4: Release Zone Tool VM Leases On Gateway VM Restart

**Files:**
- Modify: `packages/agent-vm/src/controller/zone-runtimes/openclaw-zone-runtime.ts`
- Modify: `packages/agent-vm/src/controller/zone-runtimes/zone-runtime-registry.test.ts`

- [ ] **Step 1: Write failing lease release test**

Add this test inside `describe('createOpenClawZoneRuntime', ...)` in `packages/agent-vm/src/controller/zone-runtimes/zone-runtime-registry.test.ts`:

If `Lease` and `LeaseManager` are not already imported in this test file, add them to the existing imports from `../leases/lease-manager.js`:

```ts
import type { Lease, LeaseManager } from '../leases/lease-manager.js';
```

Use the existing `createManagedVmFsStub()` helper from this test file for the fake `ManagedVm.fs` field.

```ts
it('force releases only target-zone Tool VM leases before restarting an OpenClaw gateway VM', async () => {
	const releaseLease = vi.fn(async () => {});
	const close = vi.fn(async () => {});
	const startResults = ['first-vm', 'second-vm'];
	const leases = [
		{ id: 'sunfam-lease-1', zoneId: 'shravan' },
		{ id: 'other-lease-1', zoneId: 'other' },
	] as Pick<Lease, 'id' | 'zoneId'>[];
	const leaseManager = {
		listLeases: () => leases as readonly Lease[],
		releaseLease,
	} satisfies Pick<LeaseManager, 'listLeases' | 'releaseLease'>;
	const runtime = createOpenClawZoneRuntime({
		deleteGatewayRuntimeRecord: vi.fn(async () => {}),
		leaseManager,
		now: () => Date.parse('2026-05-27T10:00:00.000Z'),
		restartGatewayZone: async () => {
			const vmId = startResults.shift();
			if (!vmId) {
				throw new Error('unexpected extra start');
			}
			return {
				image: { built: false, fingerprint: 'fingerprint', imagePath: '/tmp/image' },
				ingress: { host: '127.0.0.1', port: 18791 },
				processSpec: {
					bootstrapCommand: 'bootstrap',
					guestListenPort: 18789,
					healthCheck: { type: 'http', port: 18789, path: '/readyz' },
					logPath: '/agent-vm/logs/gateway-boot-latest.log',
					startCommand: 'start',
				},
					vm: {
						close,
						enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
						enableSsh: vi.fn(async () => ({
							command: 'ssh root@127.0.0.1',
							host: '127.0.0.1',
							port: 22,
						})),
						exec: vi.fn(async () => ({ exitCode: 0, stderr: '', stdout: '200' })),
						fs: createManagedVmFsStub(),
						getVmInstance: vi.fn(),
						getHostPid: () => 12_345,
						id: vmId,
						setIngressRoutes: vi.fn(),
					},
				zone: openClawZone,
			};
		},
		secretResolver: { resolve: async () => '', resolveAll: async () => ({}) },
		systemConfig: loadedSystemConfig,
		zone: getOpenClawZone(),
	});

	await runtime.start();
	await runtime.restart();

	expect(releaseLease).toHaveBeenCalledExactlyOnceWith('sunfam-lease-1', { force: true });
	expect(close).toHaveBeenCalledOnce();
	expect(runtime.getSnapshot()).toMatchObject({
		gateway: { vm: { id: 'second-vm' } },
		lifecycleState: 'running',
	});
});
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```bash
pnpm vitest run packages/agent-vm/src/controller/zone-runtimes/zone-runtime-registry.test.ts -t "force releases only target-zone"
```

Expected: FAIL because `restart()` does not release zone leases.

- [ ] **Step 3: Implement lease release inside restart**

In `packages/agent-vm/src/controller/zone-runtimes/openclaw-zone-runtime.ts`, add:

```ts
const releaseZoneLeases = async (): Promise<void> => {
	const releaseResults = await Promise.allSettled(
		options.leaseManager.listLeases().map(async (lease) => {
			if (lease.zoneId !== options.zone.id) {
				return;
			}
			await options.leaseManager.releaseLease(lease.id, { force: true });
		}),
	);
	for (const releaseResult of releaseResults) {
		if (releaseResult.status === 'rejected') {
			writeOpenClawZoneRuntimeLog(
				`lease release before gateway VM restart failed for zone '${options.zone.id}': ${formatUnknownError(releaseResult.reason)}`,
			);
		}
	}
};
```

Replace the destroy lease release block with:

```ts
releaseZoneLeases: async () => await releaseZoneLeases(),
```

Update `restart()`:

```ts
const restart = async (): Promise<void> => {
	await releaseZoneLeases();
	await stop();
	await start();
};
```

- [ ] **Step 4: Run test and verify it passes**

Run:

```bash
pnpm vitest run packages/agent-vm/src/controller/zone-runtimes/zone-runtime-registry.test.ts -t "force releases only target-zone"
```

Expected: PASS.

- [ ] **Step 5: Run existing OpenClaw runtime tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/controller/zone-runtimes/zone-runtime-registry.test.ts -t "createOpenClawZoneRuntime"
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add packages/agent-vm/src/controller/zone-runtimes/openclaw-zone-runtime.ts packages/agent-vm/src/controller/zone-runtimes/zone-runtime-registry.test.ts
git commit -m "fix: release zone leases on gateway restart"
```

---

## Task 5: Wire Recovery Into Gateway Service Health Monitor

**Files:**
- Modify: `packages/agent-vm/src/controller/health/gateway-service-health-monitor.ts`
- Modify: `packages/agent-vm/src/controller/health/gateway-service-health-monitor.test.ts`

- [ ] **Step 1: Write failing monitor tests**

Add tests to `packages/agent-vm/src/controller/health/gateway-service-health-monitor.test.ts`:

```ts
it('restarts a gateway VM after 10 consecutive failed gateway service probes', async () => {
	let nowMs = 0;
	const healthEventStore = new HealthEventStore({
		eventHistoryLimit: 20,
		staleAfterMs: 30_000,
	});
	const recoverGatewayVm = vi.fn(async () => ({
		elapsedMs: 45_000,
		newBootedAt: '2026-05-27T13:01:00.000Z',
		newHostPid: 2222,
		newVmId: 'new-gateway-vm',
		oldBootedAt: '2026-05-27T12:00:00.000Z',
		oldHostPid: 1111,
		oldVmId: 'old-gateway-vm',
		result: 'ok' as const,
	}));
	const monitor = createGatewayServiceHealthMonitor({
		gatewayServiceAutoRestart: {
			cooldownMs: 61 * 60 * 1000,
			consecutiveFailureThreshold: 10,
			enabled: true,
			restartTimeoutMs: 10 * 60 * 1000,
		},
		healthEventStore,
		intervalMs: 10_000,
		staleAfterMs: 30_000,
		now: () => nowMs,
		probeZoneHealth: vi.fn(async () => ({
			ok: false,
			path: '/readyz',
			port: 18789,
			statusCode: 502,
			zoneId: 'sunfam',
		})),
		recoverGatewayVm,
		zoneIds: ['sunfam'],
	});

	for (let index = 1; index <= 9; index += 1) {
		nowMs = index * 10_000;
		await monitor.tick();
	}
	expect(recoverGatewayVm).not.toHaveBeenCalled();

	nowMs = 100_000;
	await monitor.tick();

	expect(recoverGatewayVm).toHaveBeenCalledExactlyOnceWith({
		consecutiveFailures: 10,
		reason: 'gateway-service-unhealthy',
		zoneId: 'sunfam',
	});
	expect(healthEventStore.listLatestEventsForZone('sunfam')).toContainEqual(
		expect.objectContaining({
			kind: 'gateway-recovery',
			newVmId: 'new-gateway-vm',
			oldVmId: 'old-gateway-vm',
			result: 'ok',
			zoneId: 'sunfam',
		}),
	);
});

it('restarts a gateway VM after 10 consecutive stale gateway control-link observations', async () => {
	let nowMs = 0;
	const healthEventStore = new HealthEventStore({
		eventHistoryLimit: 20,
		staleAfterMs: 30_000,
	});
	healthEventStore.record({
		controllerHost: 'controller.vm.host',
		controllerPort: 18800,
		elapsedMs: 1,
		kind: 'gateway-control-link',
		observedAtMs: 1_000,
		operation: 'controller-health',
		path: '/health',
		result: 'ok',
		zoneId: 'sunfam',
	});
	const recoverGatewayVm = vi.fn(async () => ({
		elapsedMs: 45_000,
		newBootedAt: '2026-05-27T13:01:00.000Z',
		newHostPid: 2222,
		newVmId: 'new-gateway-vm',
		oldBootedAt: '2026-05-27T12:00:00.000Z',
		oldHostPid: 1111,
		oldVmId: 'old-gateway-vm',
		result: 'ok' as const,
	}));
	const monitor = createGatewayServiceHealthMonitor({
		gatewayServiceAutoRestart: {
			cooldownMs: 61 * 60 * 1000,
			consecutiveFailureThreshold: 10,
			enabled: true,
			restartTimeoutMs: 10 * 60 * 1000,
		},
		healthEventStore,
		intervalMs: 10_000,
		staleAfterMs: 30_000,
		now: () => nowMs,
		probeZoneHealth: vi.fn(async () => ({
			ok: true,
			path: '/readyz',
			port: 18789,
			statusCode: 200,
			zoneId: 'sunfam',
		})),
		recoverGatewayVm,
		zoneIds: ['sunfam'],
	});

	for (let index = 1; index <= 9; index += 1) {
		nowMs = 40_000 + index * 10_000;
		await monitor.tick();
	}
	expect(recoverGatewayVm).not.toHaveBeenCalled();

	nowMs = 140_000;
	await monitor.tick();

	expect(recoverGatewayVm).toHaveBeenCalledExactlyOnceWith({
		consecutiveFailures: 10,
		reason: 'gateway-control-link-unhealthy',
		zoneId: 'sunfam',
	});
});

it('does not auto restart again inside the 61 minute cooldown', async () => {
	let nowMs = 0;
	const recoverGatewayVm = vi.fn(async () => ({ elapsedMs: 1, result: 'failed' as const }));
	const monitor = createGatewayServiceHealthMonitor({
		gatewayServiceAutoRestart: {
			cooldownMs: 61 * 60 * 1000,
			consecutiveFailureThreshold: 10,
			enabled: true,
			restartTimeoutMs: 10 * 60 * 1000,
		},
		healthEventStore: new HealthEventStore({ eventHistoryLimit: 20, staleAfterMs: 30_000 }),
		intervalMs: 10_000,
		staleAfterMs: 30_000,
		now: () => nowMs,
		probeZoneHealth: vi.fn(async () => ({
			ok: false,
			path: '/readyz',
			port: 18789,
			statusCode: 502,
			zoneId: 'sunfam',
		})),
		recoverGatewayVm,
		zoneIds: ['sunfam'],
	});

	for (let index = 1; index <= 13; index += 1) {
		nowMs = index * 10_000;
		await monitor.tick();
	}

	expect(recoverGatewayVm).toHaveBeenCalledOnce();
});

it('records a failed gateway recovery event when restart exceeds the configured deadline', async () => {
	let nowMs = 0;
	const timeoutCallbacks: (() => void)[] = [];
	const healthEventStore = new HealthEventStore({ eventHistoryLimit: 20, staleAfterMs: 30_000 });
	const recoverGatewayVm = vi.fn(
		async () =>
			await new Promise<never>(() => {
				// This intentionally never resolves; the monitor deadline must release the tick.
			}),
	);
	const monitor = createGatewayServiceHealthMonitor({
		clearTimeoutImpl: vi.fn(),
		gatewayServiceAutoRestart: {
			cooldownMs: 61 * 60 * 1000,
			consecutiveFailureThreshold: 10,
			enabled: true,
			restartTimeoutMs: 5_000,
		},
		healthEventStore,
		intervalMs: 10_000,
		staleAfterMs: 30_000,
		now: () => nowMs,
		probeZoneHealth: vi.fn(async () => ({
			ok: false,
			path: '/readyz',
			port: 18789,
			statusCode: 502,
			zoneId: 'sunfam',
		})),
		recoverGatewayVm,
		setTimeoutImpl: (callback) => {
			timeoutCallbacks.push(callback);
			return { unref: vi.fn() } as unknown as NodeJS.Timeout;
		},
		zoneIds: ['sunfam'],
	});

	for (let index = 1; index <= 9; index += 1) {
		nowMs = index * 10_000;
		await monitor.tick();
	}
	nowMs = 100_000;
	const tickPromise = monitor.tick();
	nowMs = 105_000;
	timeoutCallbacks[0]?.();
	await tickPromise;

	expect(healthEventStore.listLatestEventsForZone('sunfam')).toContainEqual(
		expect.objectContaining({
			errorCode: 'recovery-timeout',
			kind: 'gateway-recovery',
			result: 'failed',
			zoneId: 'sunfam',
		}),
	);
});

it('awaits an in-flight recovery tick when the monitor stops', async () => {
	let resolveRecovery: (() => void) | undefined;
	const recoverGatewayVm = vi.fn(
		async () =>
			await new Promise<{ readonly elapsedMs: number; readonly result: 'ok' }>((resolve) => {
				resolveRecovery = () => resolve({ elapsedMs: 1, result: 'ok' });
			}),
	);
	const monitor = createGatewayServiceHealthMonitor({
		clearIntervalImpl: vi.fn(),
		gatewayServiceAutoRestart: {
			cooldownMs: 61 * 60 * 1000,
			consecutiveFailureThreshold: 1,
			enabled: true,
			restartTimeoutMs: 10 * 60 * 1000,
		},
		healthEventStore: new HealthEventStore({ eventHistoryLimit: 20, staleAfterMs: 30_000 }),
		intervalMs: 10_000,
		staleAfterMs: 30_000,
		now: () => 10_000,
		probeZoneHealth: vi.fn(async () => ({
			ok: false,
			path: '/readyz',
			port: 18789,
			statusCode: 502,
			zoneId: 'sunfam',
		})),
		recoverGatewayVm,
		setIntervalImpl: () => ({ unref: vi.fn() }) as unknown as NodeJS.Timeout,
		zoneIds: ['sunfam'],
	});

	monitor.start();
	const tickPromise = monitor.tick();
	const stopPromise = monitor.stop();
	expect(recoverGatewayVm).toHaveBeenCalledOnce();
	resolveRecovery?.();
	await tickPromise;
	await stopPromise;
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
pnpm vitest run packages/agent-vm/src/controller/health/gateway-service-health-monitor.test.ts
```

Expected: FAIL because the monitor has no recovery options.

- [ ] **Step 3: Extend monitor options and recovery result types**

In `packages/agent-vm/src/controller/health/gateway-service-health-monitor.ts`, import the tracker:

```ts
import type { AgentVmHealthEvent } from '@agent-vm/gateway-interface';

import {
	createGatewayVmRecoveryTracker,
	type GatewayVmAutoRecoveryPolicy,
	type GatewayVmRecoveryReason,
} from './gateway-vm-recovery-policy.js';
```

Add interfaces:

```ts
export interface GatewayServiceHealthMonitor {
	start(): void;
	stop(): Promise<void>;
	tick(): Promise<void>;
}

export interface GatewayVmRecoveryRequest {
	readonly consecutiveFailures: number;
	readonly reason: GatewayVmRecoveryReason;
	readonly zoneId: string;
}

export type GatewayVmRecoveryResult =
	| {
			readonly elapsedMs: number;
			readonly newBootedAt?: string | undefined;
			readonly newHostPid?: number | undefined;
			readonly newVmId?: string | undefined;
			readonly oldBootedAt?: string | undefined;
			readonly oldHostPid?: number | undefined;
			readonly oldVmId?: string | undefined;
			readonly result: 'ok';
	  }
	| {
			readonly elapsedMs: number;
			readonly errorCode?: string | undefined;
			readonly oldBootedAt?: string | undefined;
			readonly oldHostPid?: number | undefined;
			readonly oldVmId?: string | undefined;
			readonly result: 'failed';
	  };
```

Add options:

```ts
readonly clearTimeoutImpl?: (timer: NodeJS.Timeout) => void;
readonly gatewayServiceAutoRestart?: GatewayVmAutoRecoveryPolicy | undefined;
readonly recoverGatewayVm?: (request: GatewayVmRecoveryRequest) => Promise<GatewayVmRecoveryResult>;
readonly setTimeoutImpl?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
readonly staleAfterMs: number;
```

Update the existing "stops the scheduled monitor timer" test to be `async` and `await monitor.stop()` because `stop()` now drains any in-flight tick before returning.

- [ ] **Step 4: Implement recovery decision handling**

Inside `createGatewayServiceHealthMonitor`, create:

```ts
const clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout;
const setTimeoutImpl = options.setTimeoutImpl ?? setTimeout;
const defaultRecoveryPolicy = {
	cooldownMs: 61 * 60 * 1000,
	consecutiveFailureThreshold: 10,
	enabled: false,
	restartTimeoutMs: 10 * 60 * 1000,
} as const satisfies GatewayVmAutoRecoveryPolicy;
const recoveryTracker = createGatewayVmRecoveryTracker({
	policy: options.gatewayServiceAutoRestart ?? defaultRecoveryPolicy,
});
let stopped = false;

const classifyGatewayControlLinkObservation = (optionsForObservation: {
	readonly nowMs: number;
	readonly zoneId: string;
}): 'failed' | 'ok' | 'stale' | 'unobserved' => {
	const controlLinkEvent = options.healthEventStore
		.listLatestEventsForZone(optionsForObservation.zoneId)
		.find((event): event is AgentVmHealthEvent & { readonly kind: 'gateway-control-link' } =>
			event.kind === 'gateway-control-link'
		);
	if (!controlLinkEvent) {
		return 'unobserved';
	}
	if (optionsForObservation.nowMs - controlLinkEvent.observedAtMs > options.staleAfterMs) {
		return 'stale';
	}
	return controlLinkEvent.result === 'ok' ? 'ok' : 'failed';
};
```

After each gateway-service probe event is recorded, call a local helper:

```ts
const runRecoveryWithDeadline = async (
	request: GatewayVmRecoveryRequest,
): Promise<GatewayVmRecoveryResult> => {
	if (!options.recoverGatewayVm) {
		return {
			elapsedMs: 0,
			errorCode: 'recovery-callback-unconfigured',
			result: 'failed',
		};
	}
	const timeoutMs = options.gatewayServiceAutoRestart?.restartTimeoutMs ?? defaultRecoveryPolicy.restartTimeoutMs;
	let timeout: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			options.recoverGatewayVm(request),
			new Promise<GatewayVmRecoveryResult>((resolve) => {
				const startedAtMs = options.now();
				timeout = setTimeoutImpl(() => {
					resolve({
						elapsedMs: options.now() - startedAtMs,
						errorCode: 'recovery-timeout',
						result: 'failed',
					});
				}, timeoutMs);
				timeout.unref?.();
			}),
		]);
	} finally {
		if (timeout) {
			clearTimeoutImpl(timeout);
		}
	}
};

const maybeRecoverGatewayVm = async (optionsForRecovery: {
	readonly observedAtMs: number;
	readonly probeResult: 'failed' | 'ok';
	readonly recoveryReason: GatewayVmRecoveryReason;
	readonly zoneId: string;
}): Promise<void> => {
	const decision =
		optionsForRecovery.recoveryReason === 'gateway-service-unhealthy'
			? recoveryTracker.recordGatewayServiceProbe({
					observedAtMs: optionsForRecovery.observedAtMs,
					result: optionsForRecovery.probeResult,
					zoneId: optionsForRecovery.zoneId,
				})
			: recoveryTracker.recordGatewayControlLinkObservation({
					observedAtMs: optionsForRecovery.observedAtMs,
					result:
						optionsForRecovery.probeResult === 'ok'
							? classifyGatewayControlLinkObservation({
									nowMs: optionsForRecovery.observedAtMs,
									zoneId: optionsForRecovery.zoneId,
								})
							: 'unobserved',
					zoneId: optionsForRecovery.zoneId,
				});
	if (decision.kind !== 'restart') {
		return;
	}
	if (!options.recoverGatewayVm || stopped) {
		writeGatewayServiceHealthMonitorLog(
			`recovery requested for zone '${decision.zoneId}' but recovery is unavailable or monitor is stopped`,
		);
		return;
	}
	recoveryTracker.markRecoveryStarted({
		observedAtMs: optionsForRecovery.observedAtMs,
		zoneId: decision.zoneId,
	});
	const result = await runRecoveryWithDeadline({
		consecutiveFailures: decision.consecutiveFailures,
		reason: decision.reason,
		zoneId: decision.zoneId,
	});
	const observedAtMs = options.now();
	recoveryTracker.markRecoveryFinished({
		observedAtMs,
		result: result.result,
		zoneId: decision.zoneId,
	});
	const recoveryEvent = {
		action: 'gateway-vm-restart',
		consecutiveFailures: decision.consecutiveFailures,
		cooldownMs: options.gatewayServiceAutoRestart?.cooldownMs ?? defaultRecoveryPolicy.cooldownMs,
		elapsedMs: result.elapsedMs,
		...(result.result === 'failed' && result.errorCode ? { errorCode: result.errorCode } : {}),
		kind: 'gateway-recovery',
		...(result.result === 'ok' && result.newBootedAt ? { newBootedAt: result.newBootedAt } : {}),
		...(result.result === 'ok' && result.newHostPid ? { newHostPid: result.newHostPid } : {}),
		...(result.result === 'ok' && result.newVmId ? { newVmId: result.newVmId } : {}),
		...(result.oldBootedAt ? { oldBootedAt: result.oldBootedAt } : {}),
		...(result.oldHostPid ? { oldHostPid: result.oldHostPid } : {}),
		...(result.oldVmId ? { oldVmId: result.oldVmId } : {}),
		observedAtMs,
		reason: decision.reason,
		result: result.result,
		zoneId: decision.zoneId,
	} satisfies AgentVmHealthEvent;
	options.healthEventStore.record(recoveryEvent);
};
```

For successful gateway-service probe calls, call the helper first with `recoveryReason: 'gateway-service-unhealthy'` and `probeResult: result.ok ? 'ok' : 'failed'`. If `result.ok` is true, call it a second time with `recoveryReason: 'gateway-control-link-unhealthy'` and `probeResult: 'ok'` so the monitor can classify the latest control-link event as `ok`, `failed`, `stale`, or `unobserved`. In the gateway-service catch branch, call only the gateway-service recovery path with `probeResult: 'failed'`; do not double-count control-link degradation while the host-observed gateway-service probe itself is failing.

Update `stop()` so it clears the interval, marks `stopped = true`, and then awaits `runningTick` if one exists before returning. This prevents controller shutdown from racing an already-started recovery tick. The 10-minute recovery deadline above bounds the wait.

- [ ] **Step 5: Run tests and verify they pass**

Run:

```bash
pnpm vitest run packages/agent-vm/src/controller/health/gateway-service-health-monitor.test.ts packages/agent-vm/src/controller/health/gateway-vm-recovery-policy.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add packages/agent-vm/src/controller/health/gateway-service-health-monitor.ts packages/agent-vm/src/controller/health/gateway-service-health-monitor.test.ts
git commit -m "feat: recover failed gateway service health"
```

---

## Task 6: Controller Runtime Recovery Wiring And VM Identity Verification

**Files:**
- Modify: `packages/agent-vm/src/controller/controller-runtime.ts`
- Modify: `packages/agent-vm/src/controller/controller-runtime.test.ts`

- [ ] **Step 1: Write failing controller runtime test**

Add a test in `packages/agent-vm/src/controller/controller-runtime.test.ts` that configures `gatewayServiceAutoRestart.consecutiveFailureThreshold` to `10`, uses a captured health-monitor interval, and returns a new fake VM identity on the second start:

```ts
it('auto restarts an OpenClaw gateway VM after 10 failed gateway service health probes', async () => {
	let nowMs = Date.parse('2026-05-27T12:00:00.000Z');
	const timers: { readonly callback: () => void | Promise<void>; readonly delayMs: number }[] = [];
	const gatewayStarts: { readonly hostPid: number; readonly vmId: string }[] = [];
	const startGatewayZone = vi.fn(async () => {
		const startIndex = gatewayStarts.length + 1;
		const hostPid = 20_000 + startIndex;
		const vmId = `gateway-vm-${startIndex}`;
		gatewayStarts.push({ hostPid, vmId });
		return {
			image: { built: false, fingerprint: 'fingerprint', imagePath: '/tmp/image' },
			ingress: { host: '127.0.0.1', port: 18791 },
			processSpec: {
				bootstrapCommand: 'bootstrap',
				guestListenPort: 18789,
				healthCheck: { type: 'http', port: 18789, path: '/readyz' },
				logPath: '/agent-vm/logs/gateway-boot-latest.log',
				startCommand: 'start',
			},
			vm: {
				close: vi.fn(async () => {}),
				enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
				enableSsh: vi.fn(async () => ({
					command: 'ssh root@127.0.0.1',
					host: '127.0.0.1',
					port: 22,
				})),
				exec: vi.fn(async () => ({ exitCode: 0, stderr: '', stdout: '502' })),
				fs: createManagedVmFsStub(),
				getVmInstance: vi.fn(),
				getHostPid: () => hostPid,
				id: vmId,
				setIngressRoutes: vi.fn(),
			},
			zone: systemConfig.zones[0],
		};
	});
	const runtime = await startControllerRuntime(
		{
			systemConfig: {
				...systemConfig,
				controller: {
					health: {
						...systemConfig.controller.health,
						gatewayServiceAutoRestart: {
							cooldownMs: 61 * 60 * 1000,
							consecutiveFailureThreshold: 10,
							enabled: true,
							restartTimeoutMs: 10 * 60 * 1000,
						},
						gatewayServiceIntervalMs: 10_000,
					},
				},
			},
			zoneIds: ['shravan'],
		},
		{
			configureHostNetworkDefaults: () => ({
				autoSelectFamily: false,
				dnsResultOrder: 'ipv4first',
			}),
			createSecretResolver: async () => ({ resolve: async () => '', resolveAll: async () => ({}) }),
			now: () => nowMs,
			setIntervalImpl: (callback, delayMs) => {
				const timer = { unref: vi.fn() } as unknown as NodeJS.Timeout;
				timers.push({ callback, delayMs });
				return timer;
			},
			startGatewayZone,
			startHttpServer: async () => ({ close: async () => {} }),
		},
	);
	const gatewayHealthTimer = timers.find((timer) => timer.delayMs === 10_000);
	if (!gatewayHealthTimer) {
		throw new Error('Expected gateway service health timer.');
	}

	for (let index = 1; index <= 10; index += 1) {
		nowMs += 10_000;
		await gatewayHealthTimer.callback();
	}

	expect(startGatewayZone).toHaveBeenCalledTimes(2);
	expect(gatewayStarts).toEqual([
		{ hostPid: 20_001, vmId: 'gateway-vm-1' },
		{ hostPid: 20_002, vmId: 'gateway-vm-2' },
	]);
	await runtime.close();
});
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```bash
pnpm vitest run packages/agent-vm/src/controller/controller-runtime.test.ts -t "auto restarts an OpenClaw gateway VM"
```

Expected: FAIL because the runtime does not pass recovery options to the monitor.

- [ ] **Step 3: Implement recovery callback in controller runtime**

In `packages/agent-vm/src/controller/controller-runtime.ts`, add a helper near the gateway health monitor creation:

```ts
const recoverGatewayVm = async (request: {
	readonly consecutiveFailures: number;
	readonly reason: 'gateway-control-link-unhealthy' | 'gateway-service-unhealthy';
	readonly zoneId: string;
}): Promise<{
	readonly elapsedMs: number;
	readonly errorCode?: string | undefined;
	readonly newBootedAt?: string | undefined;
	readonly newHostPid?: number | undefined;
	readonly newVmId?: string | undefined;
	readonly oldBootedAt?: string | undefined;
	readonly oldHostPid?: number | undefined;
	readonly oldVmId?: string | undefined;
	readonly result: 'failed' | 'ok';
}> => {
	const startedAtMs = now();
	if (runtimeReadiness.get() === 'stopping') {
		return {
			elapsedMs: 0,
			errorCode: 'controller-stopping',
			result: 'failed',
		};
	}
	const runtime = registry.getOpenClawRuntime(request.zoneId);
	const oldSnapshot = runtime.getSnapshot();
	if (oldSnapshot.lifecycleState !== 'running' || !oldSnapshot.gateway) {
		return {
			elapsedMs: now() - startedAtMs,
			errorCode:
				oldSnapshot.lifecycleState === 'running'
					? 'old-gateway-identity-missing'
					: 'old-gateway-not-running',
			...(oldSnapshot.bootedAt ? { oldBootedAt: oldSnapshot.bootedAt } : {}),
			result: 'failed',
		};
	}
	const oldGateway = oldSnapshot.gateway;
	try {
		await runtime.restart();
		const newSnapshot = runtime.getSnapshot();
		const newGateway = newSnapshot.lifecycleState === 'running' ? newSnapshot.gateway : undefined;
		const oldVmId = oldGateway.vm.id;
		const newVmId = newGateway?.vm.id;
		const oldHostPid = oldGateway.vm.hostPid;
		const newHostPid = newGateway?.vm.hostPid;
		if (!newGateway || oldVmId === newVmId) {
			return {
				elapsedMs: now() - startedAtMs,
				errorCode: 'restart-verification-failed',
				...(oldSnapshot.bootedAt ? { oldBootedAt: oldSnapshot.bootedAt } : {}),
				...(oldHostPid ? { oldHostPid } : {}),
				...(oldVmId ? { oldVmId } : {}),
				result: 'failed',
			};
		}
		return {
			elapsedMs: now() - startedAtMs,
			...(newSnapshot.bootedAt ? { newBootedAt: newSnapshot.bootedAt } : {}),
			...(newHostPid ? { newHostPid } : {}),
			...(newVmId ? { newVmId } : {}),
			...(oldSnapshot.bootedAt ? { oldBootedAt: oldSnapshot.bootedAt } : {}),
			...(oldHostPid ? { oldHostPid } : {}),
			...(oldVmId ? { oldVmId } : {}),
			result: 'ok',
		};
	} catch (error) {
		writeControllerRuntimeLog(
			`Gateway VM recovery failed for zone '${request.zoneId}': ${formatUnknownError(error)}`,
		);
		return {
			elapsedMs: now() - startedAtMs,
			errorCode: 'restart-threw',
			...(oldSnapshot.bootedAt ? { oldBootedAt: oldSnapshot.bootedAt } : {}),
			...(oldGateway.vm.hostPid ? { oldHostPid: oldGateway.vm.hostPid } : {}),
			oldVmId: oldGateway.vm.id,
			result: 'failed',
		};
	}
};
```

Pass recovery options into `createGatewayServiceHealthMonitor`:

```ts
gatewayServiceAutoRestart: controllerHealthConfig.gatewayServiceAutoRestart,
recoverGatewayVm,
staleAfterMs: controllerHealthConfig.staleAfterMs,
```

Update runtime shutdown to await the monitor drain before stopping zones:

```ts
await gatewayServiceHealthMonitor?.stop();
await registry.stopAllZones();
```

Do not leave this as a fire-and-forget `stop()` call. The monitor owns recovery single-flight state; shutdown must wait for any already-running tick so a recovery cannot start a replacement VM while `registry.stopAllZones()` is tearing the old runtime down.

- [ ] **Step 4: Run controller runtime test and verify it passes**

Run:

```bash
pnpm vitest run packages/agent-vm/src/controller/controller-runtime.test.ts -t "auto restarts an OpenClaw gateway VM"
```

Expected: PASS.

- [ ] **Step 5: Add cooldown assertion to the same test file**

Extend the test from Step 1 by adding this block after the first `startGatewayZone` call-count assertion:

```ts
for (let index = 11; index <= 13; index += 1) {
	nowMs += 10_000;
	await gatewayHealthTimer.callback();
}
expect(startGatewayZone).toHaveBeenCalledTimes(2);
```

- [ ] **Step 6: Run controller runtime tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/controller/controller-runtime.test.ts -t "gateway VM"
```

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```bash
git add packages/agent-vm/src/controller/controller-runtime.ts packages/agent-vm/src/controller/controller-runtime.test.ts
git commit -m "feat: auto restart unhealthy gateway vms"
```

---

## Task 7: Live OpenClaw/Gondolin Recovery Smoke

**Files:**
- Modify: `packages/agent-vm/src/integration-tests/live-openclaw-control-link.smoke.test.ts`

- [ ] **Step 1: Write failing live smoke test**

In the existing smoke harness, keep the existing `gatewayVm = result.vm` capture because later smoke helpers still use it. Add this parallel array beside it:

```ts
const gatewayStarts: {
	readonly hostPid: number | null;
	readonly vmId: string;
}[] = [];
```

Inside the existing `startGatewayZone` override, push:

```ts
gatewayVm = result.vm;
gatewayStarts.push({
	hostPid: result.vm.getHostPid(),
	vmId: result.vm.id,
});
```

Add this smoke test after the existing health event test:

```ts
it('auto restarts the gateway VM when OpenClaw gateway-service dies', async () => {
	if (gatewayVm === undefined || harness === undefined) {
		throw new Error('Expected OpenClaw control-link smoke harness to be initialized.');
	}
	const firstStart = gatewayStarts.at(-1);
	if (!firstStart) {
		throw new Error('Expected initial gateway start identity.');
	}

	await gatewayVm.exec("pkill -f 'openclaw gateway --port 18789' || true");

	const recoveryEvent = await waitForHealthEvent({
		controllerUrl: harness.controllerUrl,
		describeEvent: 'gateway-recovery ok',
		matches: (event) => event.kind === 'gateway-recovery' && event.result === 'ok',
		timeoutMs: 180_000,
	});

	const latestStart = gatewayStarts.at(-1);
	if (!latestStart) {
		throw new Error('Expected replacement gateway start identity.');
	}
	expect(recoveryEvent).toMatchObject({
		action: 'gateway-vm-restart',
		kind: 'gateway-recovery',
		reason: 'gateway-service-unhealthy',
		result: 'ok',
	});
	expect(latestStart.vmId).not.toBe(firstStart.vmId);
	if (firstStart.hostPid !== null && latestStart.hostPid !== null) {
		expect(latestStart.hostPid).not.toBe(firstStart.hostPid);
	}
});
```

For this smoke only, set fast recovery config in the local smoke system config:

```ts
gatewayServiceAutoRestart: {
	cooldownMs: 61_000,
	consecutiveFailureThreshold: 2,
	enabled: true,
	restartTimeoutMs: 120_000,
},
gatewayServiceIntervalMs: 1_000,
```

- [ ] **Step 2: Run smoke test and verify it fails before implementation**

Run:

```bash
AGENT_VM_OPENCLAW_SMOKE=1 mise exec -- pnpm vitest run packages/agent-vm/src/integration-tests/live-openclaw-control-link.smoke.test.ts -t "auto restarts the gateway VM"
```

Expected before Tasks 1-6 are implemented: FAIL because no `gateway-recovery` event is emitted and no automatic restart occurs.

- [ ] **Step 3: Run smoke test after implementation**

Run:

```bash
AGENT_VM_OPENCLAW_SMOKE=1 mise exec -- pnpm vitest run packages/agent-vm/src/integration-tests/live-openclaw-control-link.smoke.test.ts -t "auto restarts the gateway VM"
```

Expected after Tasks 1-6: PASS, with at least two gateway starts and different old/new VM identity.

- [ ] **Step 4: Commit**

Run:

```bash
git add packages/agent-vm/src/integration-tests/live-openclaw-control-link.smoke.test.ts
git commit -m "test: smoke gateway vm auto recovery"
```

---

## Task 8: Documentation And Generated Manuals

**Files:**
- Modify: `docs/subsystems/controller.md`
- Modify: `docs/architecture/openclaw-gateway.md`
- Modify: `packages/agent-vm/src/cli/manual-templates.ts`
- Modify: `packages/agent-vm/src/cli/manual-templates.test.ts`

- [ ] **Step 1: Document the recovery rule**

In `docs/subsystems/controller.md`, add a short section near the health monitor description:

```md
### Gateway VM Auto Recovery

The controller treats `gateway-service-health` as the host-observed signal for
the gateway-service process inside the gateway VM. It treats
`gateway-control-link` as the gateway-observed signal that the gateway VM can
reach the host controller through `controller.vm.host:18800`. When automatic
recovery is enabled, either 10 consecutive failed gateway-service probes or 10
consecutive degraded gateway-control-link observations make the zone a recovery
candidate. The controller then restarts the gateway VM, releases zone Tool VM
leases, and records a `gateway-recovery` health event with old and new VM
identity.

Automatic gateway VM restart is rate-limited per zone. The default cooldown is
61 minutes between automatic restart attempts. Provider-only failures such as
Discord websocket reconnect churn do not trigger gateway VM restart unless the
gateway-service itself becomes unhealthy or the gateway-to-controller control
link becomes repeatedly stale or failed.

Gateway VM restart force-releases Tool VM leases for the zone. Any active Tool
VM operation in that zone is interrupted and must be retried by the caller; this
is intentional because the gateway VM process state that owned the operation is
gone or no longer trusted.
```

- [ ] **Step 2: Document OpenClaw boundary**

In `docs/architecture/openclaw-gateway.md`, add:

```md
OpenClaw provider health is not the same boundary as gateway-service or
gateway-control-link health. Discord reconnect churn is handled by OpenClaw's
provider monitor. The agent-vm controller only restarts the gateway VM when the
gateway-service health check fails repeatedly or when the gateway VM's
controller control link is repeatedly stale or failed. Missing control-link
history during startup is not enough to restart a VM; the controller must have
observed at least one control-link event for the zone first.

`/readyz` should remain healthy during ordinary Discord reconnect churn. If a
Discord 403 or websocket 1006 reconnect cycle makes `/readyz` fail for 10
consecutive host-side probes, that is no longer provider-only churn; it is a
gateway-service health failure and falls under VM recovery.
```

- [ ] **Step 3: Update manual template**

In `packages/agent-vm/src/cli/manual-templates.ts`, add concise operational guidance to `docs/manual/operations.md` output:

```md
Gateway VM auto recovery defaults to 10 consecutive failed gateway-service
probes or 10 consecutive degraded gateway-control-link observations, plus a
61-minute automatic restart cooldown per zone. A successful probe or fresh
successful control-link event resets its own failure count. This recovery is
for dead gateway-service, broken gateway-to-controller control link, or gateway
VM failures, not Discord provider reconnect churn by itself.
```

- [ ] **Step 4: Update manual tests**

In `packages/agent-vm/src/cli/manual-templates.test.ts`, assert the generated operations manual contains:

```ts
const operationsManual = files.find((file) => file.relativePath.endsWith('operations.md'))?.content;
expect(operationsManual).toBeDefined();
expect(operationsManual).toContain('10 consecutive failed gateway-service probes');
expect(operationsManual).toContain('10 consecutive degraded gateway-control-link observations');
expect(operationsManual).toContain('61-minute automatic restart cooldown');
expect(operationsManual).toContain('not Discord provider reconnect churn');
```

- [ ] **Step 5: Run docs/manual tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/cli/manual-templates.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add docs/subsystems/controller.md docs/architecture/openclaw-gateway.md packages/agent-vm/src/cli/manual-templates.ts packages/agent-vm/src/cli/manual-templates.test.ts
git commit -m "docs: document gateway vm auto recovery"
```

---

## Task 9: Verification Ladder

**Files:**
- No source edits.

- [ ] **Step 1: Run focused unit tests**

Run:

```bash
pnpm vitest run \
  packages/gateway-interface/src/health/agent-vm-health.test.ts \
  packages/agent-vm/src/config/system-config.test.ts \
  packages/agent-vm/src/controller/health/gateway-vm-recovery-policy.test.ts \
  packages/agent-vm/src/controller/health/gateway-service-health-monitor.test.ts \
  packages/agent-vm/src/controller/zone-runtimes/zone-runtime-registry.test.ts \
  packages/agent-vm/src/controller/controller-runtime.test.ts \
  packages/agent-vm/src/cli/manual-templates.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run package type and lint checks**

Run:

```bash
pnpm check
```

Expected: PASS.

- [ ] **Step 3: Run the gated live smoke when local QEMU/Docker/Zig are available**

Run:

```bash
AGENT_VM_OPENCLAW_SMOKE=1 mise exec -- pnpm vitest run packages/agent-vm/src/integration-tests/live-openclaw-control-link.smoke.test.ts -t "auto restarts the gateway VM"
```

Expected: PASS. Evidence must include a `gateway-recovery` event and different old/new VM identity.

- [ ] **Step 4: Run full smoke suite if the machine has the required live dependencies**

Run:

```bash
AGENT_VM_OPENCLAW_SMOKE=1 mise exec -- pnpm test:smoke
```

Expected: PASS for enabled live smokes; skipped tests must be reported as skipped, not counted as evidence.

- [ ] **Step 5: Final commit if verification changes were needed**

If any test-only fixes were made after Task 8, commit them:

```bash
git add packages docs
git commit -m "test: verify gateway vm auto recovery"
```

---

## Self-Review

### Spec Coverage

- 10 consecutive gateway-service failures: Task 2 defaults, Task 3 policy, Task 5 monitor, Task 6 runtime, Task 7 live smoke.
- 10 consecutive gateway-control-link degraded observations: Task 2 defaults, Task 3 policy, Task 5 monitor, Task 8 docs.
- 61-minute cooldown: Task 2 defaults, Task 3 cooldown tests, Task 5 cooldown monitor test, Task 6 runtime cooldown test.
- 10-minute recovery deadline: Task 2 defaults, Task 5 timeout test, Task 6 shutdown drain guidance.
- Real VM restart proof: Task 6 old/new identity verification, Task 7 live smoke old/new VM id and host pid.
- Lease cleanup on restart: Task 4.
- No reboot for Discord/provider-only churn: Requirements and Task 8 docs.
- Typed monitoring evidence: Task 1 shared `gateway-recovery` event and Task 5 event emission.
- Pyramid coverage: unit tests in Tasks 1-6, docs/manual tests in Task 8, gated live OpenClaw/Gondolin smoke in Task 7.

### Placeholder Scan

The implementation tasks name exact files, commands, expected failures, expected passes, and concrete code snippets. The plan contains no banned placeholder markers or empty test bodies.

### Type Consistency

The plan uses these names consistently:

- `gatewayServiceAutoRestart`
- `consecutiveFailureThreshold`
- `cooldownMs`
- `GatewayVmAutoRecoveryPolicy`
- `GatewayVmRecoveryTracker`
- `gateway-recovery`
- `gateway-control-link-unhealthy`
- `gateway-service-unhealthy`
- `gateway-recovery-failed`

### Scope Boundary

This plan implements recovery for two gateway-VM-scoped infrastructure failures: dead gateway-service detected by host-side gateway-service health probes, and a repeatedly stale or failed gateway-to-controller control link after at least one control-link event was observed for the zone. It does not implement automatic VM reboot for Discord provider reconnect churn, single Tool VM lease failures, or model provider timeouts unless those failures also make gateway-service health or gateway-control-link health fail repeatedly.
