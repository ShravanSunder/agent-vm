import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { cleanupOrphanedGatewayIfPresent } from '../gateway/gateway-recovery.js';
import {
	loadGatewayRuntimeRecord,
	writeGatewayRuntimeRecord,
} from '../gateway/gateway-runtime-record.js';

const createdDirectories: string[] = [];

afterEach(() => {
	for (const directoryPath of createdDirectories.splice(0)) {
		fs.rmSync(directoryPath, { recursive: true, force: true });
	}
});

function createStateDirectory(): string {
	const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-vm-orphan-recovery-'));
	createdDirectories.push(temporaryDirectory);
	return temporaryDirectory;
}

function createRuntimeRecord(stateDirectory: string, qemuPid: number): Promise<void> {
	return writeGatewayRuntimeRecord(stateDirectory, {
		createdAt: '2026-04-13T12:34:56.000Z',
		gatewayType: 'openclaw',
		guestListenPort: 18789,
		ingressPort: 18791,
		projectNamespace: 'claw-tests-a1b2c3d4',
		qemuPid,
		sessionLabel: 'claw-tests-a1b2c3d4:shravan:gateway',
		vmId: `vm-${qemuPid}`,
		zoneId: 'shravan',
	});
}

function findDefinitelyDeadPid(): number {
	for (let candidatePid = 99999; candidatePid < 1_100_000; candidatePid += 1) {
		try {
			process.kill(candidatePid, 0);
		} catch (error) {
			if (
				typeof error === 'object' &&
				error !== null &&
				'code' in error &&
				error.code === 'ESRCH'
			) {
				return candidatePid;
			}
		}
	}

	throw new Error('Failed to find a dead PID for the orphan recovery integration test.');
}

describe('integration: orphan recovery', () => {
	it('removes a stale runtime record when the recorded pid is already dead', async () => {
		const stateDirectory = createStateDirectory();
		const deadPid = findDefinitelyDeadPid();
		await createRuntimeRecord(stateDirectory, deadPid);

		await expect(
			cleanupOrphanedGatewayIfPresent({
				stateDir: stateDirectory,
				zoneId: 'shravan',
			}),
		).resolves.toEqual({
			cleanedUp: true,
			killedPid: null,
		});

		await expect(loadGatewayRuntimeRecord(stateDirectory)).resolves.toBeNull();
		expect(fs.existsSync(path.join(stateDirectory, 'gateway-runtime.json'))).toBe(false);
	});

	it('refuses to touch a live non-gateway process and leaves the record in place', async () => {
		const stateDirectory = createStateDirectory();
		await createRuntimeRecord(stateDirectory, 1);

		await expect(
			cleanupOrphanedGatewayIfPresent({
				stateDir: stateDirectory,
				zoneId: 'shravan',
			}),
		).rejects.toThrow(/unexpected live process/u);

		const runtimeRecord = await loadGatewayRuntimeRecord(stateDirectory);
		expect(runtimeRecord?.qemuPid).toBe(1);
	});

	it('is a no-op when no runtime record exists', async () => {
		const stateDirectory = createStateDirectory();

		await expect(
			cleanupOrphanedGatewayIfPresent({
				stateDir: stateDirectory,
				zoneId: 'shravan',
			}),
		).resolves.toEqual({
			cleanedUp: false,
			killedPid: null,
		});
	});

	it('quarantines malformed runtime records during cleanup', async () => {
		const stateDirectory = createStateDirectory();
		const runtimeRecordPath = path.join(stateDirectory, 'gateway-runtime.json');
		fs.mkdirSync(stateDirectory, { recursive: true });
		fs.writeFileSync(runtimeRecordPath, '{"createdAt":', 'utf8');

		await expect(
			cleanupOrphanedGatewayIfPresent({
				stateDir: stateDirectory,
				zoneId: 'shravan',
			}),
		).resolves.toEqual({
			cleanedUp: false,
			killedPid: null,
		});

		expect(fs.existsSync(runtimeRecordPath)).toBe(false);
		expect(
			fs
				.readdirSync(stateDirectory)
				.some((entryName) => entryName.startsWith('gateway-runtime.invalid.')),
		).toBe(true);
	});
});
