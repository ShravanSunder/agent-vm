import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { AgentVmHealthEvent } from '@agent-vm/gateway-interface';
import { afterEach, describe, expect, it } from 'vitest';

import { appendDurableHealthEvent, readDurableHealthEvents } from './durable-health-event-log.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(async (directory) => {
			await rm(directory, { force: true, recursive: true });
		}),
	);
});

describe('durable health event log', () => {
	it('appends health events as valid JSONL under the controller health log directory', async () => {
		const runtimeDir = await createTemporaryDirectory();
		const event = gatewayRecoveryEvent({ result: 'ok' });

		await appendDurableHealthEvent({
			controllerPid: 46_529,
			controllerPort: 18_800,
			event,
			runtimeDir,
		});

		const logText = await readFile(
			path.join(runtimeDir, 'controller-health', 'events.jsonl'),
			'utf8',
		);
		const records = logText
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line) as unknown);

		expect(records).toEqual([
			expect.objectContaining({
				body: event,
				controllerPid: 46_529,
				controllerPort: 18_800,
				eventKind: 'gateway-recovery',
				observedAtMs: 1_780_000_000_000,
				zoneId: 'sunfam',
			}),
		]);
	});

	it('reads durable events so current recovery blockers can be reconstructed separately from older operation evidence', async () => {
		const runtimeDir = await createTemporaryDirectory();
		await appendDurableHealthEvent({
			controllerPid: 46_529,
			controllerPort: 18_800,
			event: gatewayRecoveryEvent({ errorCode: 'secret-resolution-failed', result: 'failed' }),
			operationId: 'op-refresh',
			runtimeDir,
		});
		await appendDurableHealthEvent({
			controllerPid: 46_529,
			controllerPort: 18_800,
			event: gatewayRecoveryEvent({
				errorCode: 'old-gateway-not-running',
				observedAtMs: 1_780_000_001_000,
				result: 'failed',
			}),
			operationId: 'op-recovery',
			runtimeDir,
		});

		const records = await readDurableHealthEvents({ runtimeDir });

		expect(records.map((record) => record.operationId)).toEqual(['op-refresh', 'op-recovery']);
		expect(records.at(-1)).toMatchObject({
			body: { errorCode: 'old-gateway-not-running' },
			operationId: 'op-recovery',
		});
	});

	it('promotes recovery event operationId to the durable record join key', async () => {
		const runtimeDir = await createTemporaryDirectory();
		const event = gatewayRecoveryEvent({ operationId: 'op-from-event', result: 'ok' });

		await appendDurableHealthEvent({
			controllerPid: 46_529,
			controllerPort: 18_800,
			event,
			runtimeDir,
		});

		const [record] = await readDurableHealthEvents({ runtimeDir });

		expect(record).toMatchObject({
			body: { operationId: 'op-from-event' },
			operationId: 'op-from-event',
		});
	});

	it('returns an empty list when the durable health log has not been created yet', async () => {
		const runtimeDir = await createTemporaryDirectory();

		await expect(readDurableHealthEvents({ runtimeDir })).resolves.toEqual([]);
	});
});

async function createTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), 'agent-vm-durable-health-'));
	temporaryDirectories.push(directory);
	return directory;
}

function gatewayRecoveryEvent(
	overrides:
		| { readonly operationId?: string | undefined; readonly result: 'ok' }
		| {
				readonly errorCode: string;
				readonly observedAtMs?: number | undefined;
				readonly operationId?: string | undefined;
				readonly result: 'failed';
		  },
): AgentVmHealthEvent {
	const base = {
		action: 'gateway-vm-cold-start',
		consecutiveFailures: 1,
		cooldownMs: 3_660_000,
		elapsedMs: 250,
		kind: 'gateway-recovery',
		observedAtMs:
			'observedAtMs' in overrides
				? (overrides.observedAtMs ?? 1_780_000_000_000)
				: 1_780_000_000_000,
		...(overrides.operationId === undefined ? {} : { operationId: overrides.operationId }),
		reason: 'gateway-service-unhealthy',
		zoneId: 'sunfam',
	} as const;
	if (overrides.result === 'ok') {
		return {
			...base,
			leaseReleaseFailureCount: 0,
			newBootedAt: '2026-06-07T00:00:00.000Z',
			newHostPid: 46_000,
			newVmId: 'gateway-vm-new',
			result: 'ok',
		};
	}
	return {
		...base,
		errorCode: overrides.errorCode,
		result: 'failed',
	};
}
