import fs from 'node:fs';
import net from 'node:net';
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

async function findUnusedTcpPort(): Promise<number> {
	const server = net.createServer();
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			resolve();
		});
	});
	const address = server.address();
	await new Promise<void>((resolve, reject) => {
		server.close((error) => {
			if (error) {
				reject(error);
				return;
			}
			resolve();
		});
	});
	if (address === null || typeof address === 'string') {
		throw new Error('Failed to allocate an unused TCP port.');
	}
	return address.port;
}

function createRuntimeRecord(props: {
	readonly ingressPort: number;
	readonly qemuPid: number;
	readonly stateDirectory: string;
}): Promise<void> {
	return writeGatewayRuntimeRecord(props.stateDirectory, {
		configPath: '/deployments/claw/config/system.jsonc',
		controllerPort: 18800,
		createdAt: '2026-04-13T12:34:56.000Z',
		gatewayType: 'openclaw',
		guestListenPort: 18789,
		ingressPort: props.ingressPort,
		processIdentity: {
			command: 'qemu-system-aarch64 -m 4G',
			lstart: 'Fri May 22 10:00:00 2026',
		},
		projectNamespace: 'claw-tests-a1b2c3d4',
		qemuPid: props.qemuPid,
		schemaVersion: 1,
		sessionLabel: 'claw-tests-a1b2c3d4:shravan:gateway',
		vmId: `vm-${props.qemuPid}`,
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
		const ingressPort = await findUnusedTcpPort();
		await createRuntimeRecord({ ingressPort, qemuPid: deadPid, stateDirectory });

		await expect(
			cleanupOrphanedGatewayIfPresent({
				expectedConfigPath: '/deployments/claw/config/system.jsonc',
				expectedControllerPort: 18800,
				projectNamespace: 'claw-tests-a1b2c3d4',
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

	it('preserves a runtime record when the gateway port is free but the recorded pid is live and unrelated', async () => {
		const stateDirectory = createStateDirectory();
		const ingressPort = await findUnusedTcpPort();
		await createRuntimeRecord({ ingressPort, qemuPid: 1, stateDirectory });

		await expect(
			cleanupOrphanedGatewayIfPresent({
				expectedConfigPath: '/deployments/claw/config/system.jsonc',
				expectedControllerPort: 18800,
				projectNamespace: 'claw-tests-a1b2c3d4',
				stateDir: stateDirectory,
				zoneId: 'shravan',
			}),
		).rejects.toThrow(/process identity changed/u);

		await expect(loadGatewayRuntimeRecord(stateDirectory)).resolves.not.toBeNull();
	});

	it('is a no-op when no runtime record exists', async () => {
		const stateDirectory = createStateDirectory();

		await expect(
			cleanupOrphanedGatewayIfPresent({
				expectedConfigPath: '/deployments/claw/config/system.jsonc',
				expectedControllerPort: 18800,
				projectNamespace: 'claw-tests-a1b2c3d4',
				stateDir: stateDirectory,
				zoneId: 'shravan',
			}),
		).resolves.toEqual({
			cleanedUp: false,
			killedPid: null,
		});
	});

	it('throws and preserves malformed runtime records during offline cleanup', async () => {
		const stateDirectory = createStateDirectory();
		const runtimeRecordPath = path.join(stateDirectory, 'gateway-runtime.json');
		fs.mkdirSync(stateDirectory, { recursive: true });
		fs.writeFileSync(runtimeRecordPath, '{"createdAt":', 'utf8');

		await expect(
			cleanupOrphanedGatewayIfPresent({
				expectedConfigPath: '/deployments/claw/config/system.jsonc',
				expectedControllerPort: 18800,
				projectNamespace: 'claw-tests-a1b2c3d4',
				stateDir: stateDirectory,
				zoneId: 'shravan',
			}),
		).rejects.toThrow(/Malformed gateway runtime record/u);

		expect(fs.existsSync(runtimeRecordPath)).toBe(true);
	});
});
