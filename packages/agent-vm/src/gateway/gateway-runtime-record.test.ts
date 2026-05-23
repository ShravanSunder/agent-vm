import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ManagedVm, ManagedVmInstance } from '@agent-vm/gondolin-adapter';
import { afterEach, describe, expect, it } from 'vitest';

import {
	createManagedExecProcessStub,
	createManagedVmFsStub,
} from '../testing/managed-vm-test-helpers.js';
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

function createVmInstanceStub(): ManagedVmInstance {
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
		exec: () => createManagedExecProcessStub(),
		fs: createManagedVmFsStub(),
		getHostPid: () => 28282,
		id: 'gateway-vm-123',
		setIngressRoutes: () => {},
	};
}

describe('gateway runtime record', () => {
	it('writes and loads a gateway runtime record from zone state', async () => {
		const stateDirectory = createStateDirectory();

		await writeGatewayRuntimeRecord(stateDirectory, {
			configPath: '/deployments/claw/config/system.jsonc',
			controllerPort: 18800,
			createdAt: '2026-04-13T12:34:56.000Z',
			gatewayType: 'openclaw',
			guestListenPort: 18789,
			ingressPort: 18791,
			projectNamespace: 'claw-tests-a1b2c3d4',
			qemuPid: 4242,
			sessionLabel: 'claw-tests-a1b2c3d4:shravan:gateway',
			vmId: 'vm-session-123',
			zoneId: 'shravan',
		});

		await expect(loadGatewayRuntimeRecord(stateDirectory)).resolves.toEqual({
			configPath: '/deployments/claw/config/system.jsonc',
			controllerPort: 18800,
			createdAt: '2026-04-13T12:34:56.000Z',
			gatewayType: 'openclaw',
			guestListenPort: 18789,
			ingressPort: 18791,
			projectNamespace: 'claw-tests-a1b2c3d4',
			qemuPid: 4242,
			sessionLabel: 'claw-tests-a1b2c3d4:shravan:gateway',
			vmId: 'vm-session-123',
			zoneId: 'shravan',
		});
		expect(fs.statSync(path.join(stateDirectory, 'gateway-runtime.json')).mode & 0o777).toBe(0o600);
	});

	it('deletes a persisted gateway runtime record', async () => {
		const stateDirectory = createStateDirectory();

		await writeGatewayRuntimeRecord(stateDirectory, {
			configPath: '/deployments/claw/config/system.jsonc',
			controllerPort: 18800,
			createdAt: '2026-04-13T12:34:56.000Z',
			gatewayType: 'openclaw',
			guestListenPort: 18789,
			ingressPort: 18791,
			projectNamespace: 'claw-tests-a1b2c3d4',
			qemuPid: 4242,
			sessionLabel: 'claw-tests-a1b2c3d4:shravan:gateway',
			vmId: 'vm-session-123',
			zoneId: 'shravan',
		});

		await deleteGatewayRuntimeRecord(stateDirectory);

		await expect(loadGatewayRuntimeRecord(stateDirectory)).resolves.toBeNull();
	});

	it('normalizes legacy runtime records with current config metadata on load', async () => {
		const stateDirectory = createStateDirectory();
		const runtimeRecordPath = path.join(stateDirectory, 'gateway-runtime.json');
		await fs.promises.mkdir(stateDirectory, { recursive: true });
		await fs.promises.writeFile(
			runtimeRecordPath,
			`${JSON.stringify({
				createdAt: '2026-04-13T12:34:56.000Z',
				gatewayType: 'openclaw',
				guestListenPort: 18789,
				ingressPort: 18791,
				projectNamespace: 'claw-tests-a1b2c3d4',
				qemuPid: 4242,
				sessionLabel: 'claw-tests-a1b2c3d4:shravan:gateway',
				vmId: 'vm-session-123',
				zoneId: 'shravan',
			})}\n`,
			'utf8',
		);

		await expect(
			loadGatewayRuntimeRecord(stateDirectory, {
				legacyRecordDefaults: {
					configPath: '/deployments/claw/config/system.jsonc',
					controllerPort: 18800,
				},
			}),
		).resolves.toEqual({
			configPath: '/deployments/claw/config/system.jsonc',
			controllerPort: 18800,
			createdAt: '2026-04-13T12:34:56.000Z',
			gatewayType: 'openclaw',
			guestListenPort: 18789,
			ingressPort: 18791,
			projectNamespace: 'claw-tests-a1b2c3d4',
			qemuPid: 4242,
			sessionLabel: 'claw-tests-a1b2c3d4:shravan:gateway',
			vmId: 'vm-session-123',
			zoneId: 'shravan',
		});
		expect(fs.existsSync(runtimeRecordPath)).toBe(true);
	});

	it('throws for valid legacy runtime records when current config metadata is missing', async () => {
		const stateDirectory = createStateDirectory();
		const runtimeRecordPath = path.join(stateDirectory, 'gateway-runtime.json');
		await fs.promises.mkdir(stateDirectory, { recursive: true });
		await fs.promises.writeFile(
			runtimeRecordPath,
			`${JSON.stringify({
				createdAt: '2026-04-13T12:34:56.000Z',
				gatewayType: 'openclaw',
				guestListenPort: 18789,
				ingressPort: 18791,
				projectNamespace: 'claw-tests-a1b2c3d4',
				qemuPid: 4242,
				sessionLabel: 'claw-tests-a1b2c3d4:shravan:gateway',
				vmId: 'vm-session-123',
				zoneId: 'shravan',
			})}\n`,
			'utf8',
		);

		await expect(loadGatewayRuntimeRecord(stateDirectory)).rejects.toThrow(/legacy format/u);
		expect(fs.existsSync(runtimeRecordPath)).toBe(true);
		expect(
			fs
				.readdirSync(stateDirectory)
				.some((entryName) => entryName.startsWith('gateway-runtime.invalid.')),
		).toBe(false);
	});

	it('rejects invalid runtime records on write before touching disk', async () => {
		const stateDirectory = createStateDirectory();

		await expect(
			writeGatewayRuntimeRecord(stateDirectory, {
				configPath: '/deployments/claw/config/system.jsonc',
				controllerPort: 18800,
				createdAt: 'not-a-datetime',
				gatewayType: 'openclaw',
				guestListenPort: 18789,
				ingressPort: 18791,
				projectNamespace: 'claw-tests-a1b2c3d4',
				qemuPid: 4242,
				sessionLabel: 'claw-tests-a1b2c3d4:shravan:gateway',
				vmId: 'vm-session-123',
				zoneId: 'shravan',
			} as never),
		).rejects.toThrow();

		expect(fs.existsSync(path.join(stateDirectory, 'gateway-runtime.json'))).toBe(false);
	});

	it('quarantines malformed JSON records on load', async () => {
		const stateDirectory = createStateDirectory();
		const runtimeRecordPath = path.join(stateDirectory, 'gateway-runtime.json');
		await fs.promises.mkdir(stateDirectory, { recursive: true });
		await fs.promises.writeFile(runtimeRecordPath, '{"createdAt":', 'utf8');

		await expect(loadGatewayRuntimeRecord(stateDirectory)).resolves.toBeNull();
		expect(fs.existsSync(runtimeRecordPath)).toBe(false);
		expect(
			fs
				.readdirSync(stateDirectory)
				.some((entryName) => entryName.startsWith('gateway-runtime.invalid.')),
		).toBe(true);
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
			exec: () => createManagedExecProcessStub(),
			fs: createManagedVmFsStub(),
			getHostPid: () => 28282,
			getVmInstance: () => createVmInstanceStub(),
			id: 'gateway-vm-123',
			setIngressRoutes: () => {},
		} satisfies ManagedVm;

		expect(
			buildGatewayRuntimeRecord({
				controllerPort: 18800,
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
				systemConfigPath: '/deployments/claw/config/system.jsonc',
				zoneId: 'shravan',
			}),
		).toEqual({
			configPath: '/deployments/claw/config/system.jsonc',
			controllerPort: 18800,
			createdAt: expect.any(String),
			gatewayType: 'openclaw',
			guestListenPort: 18789,
			ingressPort: 18791,
			projectNamespace: 'claw-tests-a1b2c3d4',
			qemuPid: 28282,
			sessionLabel: 'claw-tests-a1b2c3d4:shravan:gateway',
			vmId: 'gateway-vm-123',
			zoneId: 'shravan',
		});
	});

	it('throws when Gondolin does not expose an active host PID', () => {
		const managedVm = {
			close: async () => {},
			enableIngress: async () => ({ host: '127.0.0.1', port: 18791 }),
			enableSsh: async () => ({ host: '127.0.0.1', port: 19000 }),
			exec: () => createManagedExecProcessStub(),
			fs: createManagedVmFsStub(),
			getHostPid: () => null,
			getVmInstance: () => createVmInstanceStub(),
			id: 'gateway-vm-123',
			setIngressRoutes: () => {},
		} satisfies ManagedVm;

		expect(() =>
			buildGatewayRuntimeRecord({
				controllerPort: 18800,
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
				systemConfigPath: '/deployments/claw/config/system.jsonc',
				zoneId: 'shravan',
			}),
		).toThrow(/does not expose an active host pid/u);
	});

	it('throws when the Managed VM wrapper is missing getHostPid', () => {
		const managedVm = {
			close: async () => {},
			enableIngress: async () => ({ host: '127.0.0.1', port: 18791 }),
			enableSsh: async () => ({ host: '127.0.0.1', port: 19000 }),
			exec: () => createManagedExecProcessStub(),
			fs: createManagedVmFsStub(),
			getVmInstance: () => createVmInstanceStub(),
			id: 'gateway-vm-123',
			setIngressRoutes: () => {},
		} as unknown as ManagedVm;

		expect(() =>
			buildGatewayRuntimeRecord({
				controllerPort: 18800,
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
				systemConfigPath: '/deployments/claw/config/system.jsonc',
				zoneId: 'shravan',
			}),
		).toThrow(/missing getHostPid/u);
	});

	it('throws when Gondolin exposes an invalid host PID', () => {
		const managedVm = {
			close: async () => {},
			enableIngress: async () => ({ host: '127.0.0.1', port: 18791 }),
			enableSsh: async () => ({ host: '127.0.0.1', port: 19000 }),
			exec: () => createManagedExecProcessStub(),
			fs: createManagedVmFsStub(),
			getHostPid: () => 0,
			getVmInstance: () => createVmInstanceStub(),
			id: 'gateway-vm-123',
			setIngressRoutes: () => {},
		} satisfies ManagedVm;

		expect(() =>
			buildGatewayRuntimeRecord({
				controllerPort: 18800,
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
				systemConfigPath: '/deployments/claw/config/system.jsonc',
				zoneId: 'shravan',
			}),
		).toThrow(/invalid host pid/u);
	});
});
