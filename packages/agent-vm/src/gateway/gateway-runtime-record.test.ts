import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ManagedVm, ManagedVmInstance } from '@shravansunder/agent-vm-gondolin-core';
import { afterEach, describe, expect, it } from 'vitest';

import {
	buildGatewayRuntimeRecord,
	deleteGatewayRuntimeRecord,
	loadGatewayRuntimeRecord,
	writeGatewayRuntimeRecord,
} from './gateway-runtime-record.js';

const createdDirectories: string[] = [];

afterEach(() => {
	for (const directoryPath of createdDirectories.splice(0)) {
		fs.rmSync(directoryPath, { force: true, recursive: true });
	}
});

function createStateDirectory(): string {
	const directoryPath = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-vm-runtime-record-'));
	createdDirectories.push(directoryPath);
	return directoryPath;
}

function createVmInstanceStub(pid: number): ManagedVmInstance {
	return {
		close: async () => {},
		enableIngress: async () => ({ host: '127.0.0.1', port: 18791 }),
		enableSsh: async () => ({
			command: 'ssh ...',
			host: '127.0.0.1',
			identityFile: '/tmp/key',
			port: 19000,
			user: 'sandbox',
		}),
		exec: async () => ({ exitCode: 0, stderr: '', stdout: '' }),
		id: 'gateway-vm-123',
		server: {
			controller: {
				child: {
					pid,
				},
			},
		},
		setIngressRoutes: () => {},
	} as ManagedVmInstance;
}

describe('gateway runtime record', () => {
	it('writes and loads a gateway runtime record from zone state', async () => {
		const stateDirectory = createStateDirectory();

		await writeGatewayRuntimeRecord(stateDirectory, {
			createdAt: '2026-04-13T12:34:56.000Z',
			gatewayType: 'openclaw',
			guestListenPort: 18789,
			ingressPort: 18791,
			projectNamespace: 'claw-tests-a1b2c3d4',
			qemuPid: 4242,
			sessionId: 'vm-session-123',
			sessionLabel: 'claw-tests-a1b2c3d4:shravan:gateway',
			vmId: 'vm-session-123',
			zoneId: 'shravan',
		});

		await expect(loadGatewayRuntimeRecord(stateDirectory)).resolves.toEqual({
			createdAt: '2026-04-13T12:34:56.000Z',
			gatewayType: 'openclaw',
			guestListenPort: 18789,
			ingressPort: 18791,
			projectNamespace: 'claw-tests-a1b2c3d4',
			qemuPid: 4242,
			sessionId: 'vm-session-123',
			sessionLabel: 'claw-tests-a1b2c3d4:shravan:gateway',
			vmId: 'vm-session-123',
			zoneId: 'shravan',
		});
	});

	it('deletes a persisted gateway runtime record', async () => {
		const stateDirectory = createStateDirectory();

		await writeGatewayRuntimeRecord(stateDirectory, {
			createdAt: '2026-04-13T12:34:56.000Z',
			gatewayType: 'openclaw',
			guestListenPort: 18789,
			ingressPort: 18791,
			projectNamespace: 'claw-tests-a1b2c3d4',
			qemuPid: 4242,
			sessionId: 'vm-session-123',
			sessionLabel: 'claw-tests-a1b2c3d4:shravan:gateway',
			vmId: 'vm-session-123',
			zoneId: 'shravan',
		});

		await deleteGatewayRuntimeRecord(stateDirectory);

		await expect(loadGatewayRuntimeRecord(stateDirectory)).resolves.toBeNull();
	});

	it('treats malformed records as stale state and removes them', async () => {
		const stateDirectory = createStateDirectory();
		const runtimeRecordPath = path.join(stateDirectory, 'gateway-runtime.json');
		const logMessages: string[] = [];
		await fs.promises.mkdir(stateDirectory, { recursive: true });
		await fs.promises.writeFile(
			runtimeRecordPath,
			JSON.stringify({
				createdAt: '2026-04-13T12:34:56.000Z',
				projectNamespace: 'claw-tests-a1b2c3d4',
				zoneId: 'shravan',
			}),
			'utf8',
		);

		await expect(
			loadGatewayRuntimeRecord(stateDirectory, {
				log: (message) => {
					logMessages.push(message);
				},
			}),
		).resolves.toBeNull();
		expect(fs.existsSync(runtimeRecordPath)).toBe(false);
		expect(
			fs
				.readdirSync(stateDirectory)
				.some((entryName) => entryName.startsWith('gateway-runtime.invalid.')),
		).toBe(true);
		expect(logMessages[0]).toMatch(/Quarantined malformed gateway runtime record/u);
	});

	it('builds a runtime record from the live gateway runtime and captures the QEMU pid', () => {
		const managedVm = {
			close: async () => {},
			enableIngress: async () => ({ host: '127.0.0.1', port: 18791 }),
			enableSsh: async () => ({ host: '127.0.0.1', port: 19000 }),
			exec: async () => ({ exitCode: 0, stderr: '', stdout: '' }),
			getVmInstance: () => createVmInstanceStub(28282),
			id: 'gateway-vm-123',
			setIngressRoutes: () => {},
		} satisfies ManagedVm;

		expect(
			buildGatewayRuntimeRecord({
				gatewayType: 'openclaw',
				ingressPort: 18791,
				managedVm,
				processSpec: {
					bootstrapCommand: 'bootstrap-openclaw',
					guestListenPort: 18789,
					healthCheck: { path: '/', port: 18789, type: 'http' },
					logPath: '/tmp/openclaw.log',
					startCommand: 'start-openclaw',
				},
				projectNamespace: 'claw-tests-a1b2c3d4',
				zoneId: 'shravan',
			}),
		).toEqual({
			createdAt: expect.any(String),
			gatewayType: 'openclaw',
			guestListenPort: 18789,
			ingressPort: 18791,
			projectNamespace: 'claw-tests-a1b2c3d4',
			qemuPid: 28282,
			sessionId: 'gateway-vm-123',
			sessionLabel: 'claw-tests-a1b2c3d4:shravan:gateway',
			vmId: 'gateway-vm-123',
			zoneId: 'shravan',
		});
	});
});
