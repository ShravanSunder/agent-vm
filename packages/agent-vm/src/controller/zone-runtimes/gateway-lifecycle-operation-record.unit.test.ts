import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
	appendGatewayLifecycleOperationRecord,
	readGatewayLifecycleOperationRecords,
	readLatestGatewayLifecycleOperationRecord,
	resolveGatewayLifecycleOperationLogPath,
	type GatewayLifecycleOperationRecord,
} from './gateway-lifecycle-operation-record.js';

describe('gateway lifecycle operation records', () => {
	it('appends operation records under the zone runtime log directory', async () => {
		await using tempDir = await createTemporaryDirectory();
		const record = createOperationRecord({
			kind: 'start-requested',
			operationId: 'op-start',
			operationTrigger: 'operator-start',
			observedAtMs: 100,
		});

		await appendGatewayLifecycleOperationRecord({
			record,
			runtimeDir: tempDir.path,
			zoneId: 'sunfam',
		});

		const logPath = resolveGatewayLifecycleOperationLogPath({
			runtimeDir: tempDir.path,
			zoneId: 'sunfam',
		});
		expect(logPath).toBe(
			path.join(tempDir.path, 'zones', 'sunfam', 'gateway-lifecycle', 'events.jsonl'),
		);
		expect(await readFile(logPath, 'utf8')).toBe(`${JSON.stringify(record)}\n`);
	});

	it('reads the latest operation record from append order', async () => {
		await using tempDir = await createTemporaryDirectory();
		const firstRecord = createOperationRecord({
			kind: 'restart-requested',
			operationId: 'op-restart',
			operationTrigger: 'auto-recovery',
			observedAtMs: 100,
		});
		const secondRecord = createOperationRecord({
			errorCode: 'secret-resolution-failed',
			errorMessage: 'Failed to resolve zone secrets.',
			kind: 'operation-failed',
			operationId: 'op-restart',
			operationTrigger: 'auto-recovery',
			observedAtMs: 200,
		});

		await appendGatewayLifecycleOperationRecord({
			record: firstRecord,
			runtimeDir: tempDir.path,
			zoneId: 'sunfam',
		});
		await appendGatewayLifecycleOperationRecord({
			record: secondRecord,
			runtimeDir: tempDir.path,
			zoneId: 'sunfam',
		});

		await expect(
			readGatewayLifecycleOperationRecords({ runtimeDir: tempDir.path, zoneId: 'sunfam' }),
		).resolves.toEqual([firstRecord, secondRecord]);
		await expect(
			readLatestGatewayLifecycleOperationRecord({ runtimeDir: tempDir.path, zoneId: 'sunfam' }),
		).resolves.toEqual(secondRecord);
	});

	it.each(['hermes', 'openclaw'] as const)(
		'round-trips $gatewayType lifecycle records',
		async (gatewayType) => {
			await using tempDir = await createTemporaryDirectory();
			const record = createOperationRecord({
				gatewayType,
				kind: 'start-requested',
				operationId: `op-${gatewayType}`,
				operationTrigger: 'controller-start',
				observedAtMs: 100,
			});

			await appendGatewayLifecycleOperationRecord({
				record,
				runtimeDir: tempDir.path,
				zoneId: 'sunfam',
			});

			await expect(
				readLatestGatewayLifecycleOperationRecord({
					runtimeDir: tempDir.path,
					zoneId: 'sunfam',
				}),
			).resolves.toEqual(record);
		},
	);

	it('ignores a corrupt latest line while preserving the previous valid latest record', async () => {
		await using tempDir = await createTemporaryDirectory();
		const validRecord = createOperationRecord({
			kind: 'runtime-record-written',
			operationId: 'op-start',
			operationTrigger: 'controller-start',
			observedAtMs: 100,
		});
		const logPath = resolveGatewayLifecycleOperationLogPath({
			runtimeDir: tempDir.path,
			zoneId: 'sunfam',
		});

		await appendGatewayLifecycleOperationRecord({
			record: validRecord,
			runtimeDir: tempDir.path,
			zoneId: 'sunfam',
		});
		await writeFile(logPath, `${JSON.stringify(validRecord)}\n{"kind":`, 'utf8');

		await expect(
			readLatestGatewayLifecycleOperationRecord({ runtimeDir: tempDir.path, zoneId: 'sunfam' }),
		).resolves.toEqual(validRecord);
	});

	it('throws for corrupt non-latest lines because the historical evidence is ambiguous', async () => {
		await using tempDir = await createTemporaryDirectory();
		const validRecord = createOperationRecord({
			kind: 'operation-finished',
			operationId: 'op-start',
			operationTrigger: 'operator-start',
			observedAtMs: 200,
		});
		const logPath = resolveGatewayLifecycleOperationLogPath({
			runtimeDir: tempDir.path,
			zoneId: 'sunfam',
		});

		await appendGatewayLifecycleOperationRecord({
			record: validRecord,
			runtimeDir: tempDir.path,
			zoneId: 'sunfam',
		});
		await writeFile(logPath, `{"kind":\n${JSON.stringify(validRecord)}\n`, 'utf8');

		await expect(
			readGatewayLifecycleOperationRecords({ runtimeDir: tempDir.path, zoneId: 'sunfam' }),
		).rejects.toThrow('Corrupt gateway lifecycle operation record at line 1');
	});
});

function createOperationRecord(
	overrides: Pick<
		GatewayLifecycleOperationRecord,
		'kind' | 'observedAtMs' | 'operationId' | 'operationTrigger'
	> &
		Partial<GatewayLifecycleOperationRecord>,
): GatewayLifecycleOperationRecord {
	return {
		controllerPid: 12345,
		controllerStartedAt: '2026-06-07T14:00:00.000Z',
		currentGateway: {
			hostPid: 5678,
			vmId: 'gateway-vm-current',
		},
		gatewayType: 'openclaw',
		previousGateway: {
			hostPid: 4567,
			vmId: 'gateway-vm-previous',
		},
		zoneId: 'sunfam',
		...overrides,
	};
}

async function createTemporaryDirectory(): Promise<AsyncDisposable & { readonly path: string }> {
	const temporaryDirectoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-lifecycle-'));
	return {
		path: temporaryDirectoryPath,
		[Symbol.asyncDispose]: async (): Promise<void> => {
			await rm(temporaryDirectoryPath, { force: true, recursive: true });
		},
	};
}
