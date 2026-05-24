import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ManagedVm, ManagedVmInstance } from '@agent-vm/gondolin-adapter';
import { afterEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import {
	createManagedExecProcessStub,
	createManagedVmFsStub,
} from '../testing/managed-vm-test-helpers.js';
import {
	buildGatewayRuntimeRecord,
	deleteGatewayRuntimeRecord,
	gatewayRuntimeRecordSchema,
	loadGatewayRuntimeRecord,
	loadGatewayRuntimeRecordResult,
	type GatewayRuntimeRecord,
	writeGatewayRuntimeRecord,
} from './gateway-runtime-record.js';

const createdDirectories: string[] = [];

afterEach(async () => {
	const directoriesToDelete = createdDirectories.splice(0);
	await Promise.all(
		directoriesToDelete.map(async (directoryPath) => {
			await rm(directoryPath, { force: true, recursive: true });
		}),
	);
});

async function createStateDirectory(): Promise<string> {
	const directoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-runtime-record-'));
	createdDirectories.push(directoryPath);
	return directoryPath;
}

function createVmInstanceStub(hostPid: number): ManagedVmInstance {
	return {
		close: async () => {},
		enableIngress: async () => ({ host: '127.0.0.1', port: 18_791 }),
		enableSsh: async () => ({
			command: 'ssh ...',
			host: '127.0.0.1',
			identityFile: '/tmp/key',
			port: 19_000,
			user: 'sandbox',
		}),
		exec: () => createManagedExecProcessStub(),
		fs: createManagedVmFsStub(),
		getHostPid: () => hostPid,
		id: 'gateway-vm-123',
		setIngressRoutes: () => {},
	};
}

function createManagedVmStub(options: {
	readonly hostPid: number;
	readonly id: string;
}): ManagedVm {
	return {
		close: async () => {},
		enableIngress: async () => ({ host: '127.0.0.1', port: 18_791 }),
		enableSsh: async () => ({ host: '127.0.0.1', port: 19_000 }),
		exec: () => createManagedExecProcessStub(),
		fs: createManagedVmFsStub(),
		getHostPid: () => options.hostPid,
		getVmInstance: () => createVmInstanceStub(options.hostPid),
		id: options.id,
		setIngressRoutes: () => {},
	};
}

function buildSampleRecord(overrides: Partial<GatewayRuntimeRecord> = {}): GatewayRuntimeRecord {
	return {
		configPath: '/deployments/claw/config/system.jsonc',
		controllerPort: 18_800,
		createdAt: '2026-04-13T12:34:56.000Z',
		gatewayType: 'openclaw',
		guestListenPort: 18_789,
		ingressPort: 18_791,
		processIdentity: {
			command: 'qemu-system-x86_64 -m 4G -smp 4',
			lstart: 'Fri May 22 10:00:00 2026',
		},
		projectNamespace: 'claw-tests-a1b2c3d4',
		qemuPid: 4242,
		schemaVersion: 1,
		sessionLabel: 'claw-tests-a1b2c3d4:shravan:gateway',
		vmId: 'vm-session-123',
		zoneId: 'shravan',
		...overrides,
	};
}

describe('gateway runtime record', () => {
	it('rejects pre-cutover gateway runtime records without schemaVersion', () => {
		const { schemaVersion: _schemaVersion, ...recordWithoutSchemaVersion } = buildSampleRecord();

		expect(() => gatewayRuntimeRecordSchema.parse(recordWithoutSchemaVersion)).toThrow(ZodError);
	});

	it('rejects unsupported quarantine-era gateway runtime record fields', () => {
		expect(() =>
			gatewayRuntimeRecordSchema.parse({
				...buildSampleRecord(),
				scopeKey: 'agent:beta',
			}),
		).toThrow(ZodError);
	});

	it('requires process identity for current gateway runtime records', () => {
		const { processIdentity: _processIdentity, ...recordWithoutProcessIdentity } =
			buildSampleRecord();

		expect(() => gatewayRuntimeRecordSchema.parse(recordWithoutProcessIdentity)).toThrow(ZodError);
	});

	it('writes and loads a gateway runtime record from zone state', async () => {
		const stateDirectory = await createStateDirectory();
		const record = buildSampleRecord();

		await writeGatewayRuntimeRecord(stateDirectory, record);

		await expect(loadGatewayRuntimeRecord(stateDirectory)).resolves.toEqual(record);
		expect((await stat(path.join(stateDirectory, 'gateway-runtime.json'))).mode & 0o777).toBe(
			0o600,
		);
	});

	it('load returns null when the gateway runtime record is missing', async () => {
		const stateDirectory = await createStateDirectory();

		await expect(loadGatewayRuntimeRecord(stateDirectory)).resolves.toBeNull();
	});

	it('load result reports parse errors without mutating malformed files', async () => {
		const stateDirectory = await createStateDirectory();
		await writeFile(path.join(stateDirectory, 'gateway-runtime.json'), '{not-json');

		const result = await loadGatewayRuntimeRecordResult(stateDirectory);

		expect(result).toMatchObject({
			kind: 'parse-error',
			path: path.join(stateDirectory, 'gateway-runtime.json'),
		});
		expect(await readFile(path.join(stateDirectory, 'gateway-runtime.json'), 'utf8')).toBe(
			'{not-json',
		);
	});

	it('load throws parse errors for callers that request a direct record', async () => {
		const stateDirectory = await createStateDirectory();
		await writeFile(path.join(stateDirectory, 'gateway-runtime.json'), '{}\n');

		await expect(loadGatewayRuntimeRecord(stateDirectory)).rejects.toThrow(ZodError);
	});

	it('deletes a persisted gateway runtime record', async () => {
		const stateDirectory = await createStateDirectory();
		await writeGatewayRuntimeRecord(stateDirectory, buildSampleRecord());

		await deleteGatewayRuntimeRecord(stateDirectory);

		await expect(loadGatewayRuntimeRecord(stateDirectory)).resolves.toBeNull();
	});

	it('rejects invalid runtime records on write before touching disk', async () => {
		const stateDirectory = await createStateDirectory();
		const invalidRecord = {
			...buildSampleRecord(),
			createdAt: 'not-a-datetime',
		};

		await expect(writeGatewayRuntimeRecord(stateDirectory, invalidRecord)).rejects.toThrow(
			ZodError,
		);

		expect(await readdir(stateDirectory)).toEqual([]);
	});

	it('builds a runtime record from the live gateway runtime and captures the QEMU pid', async () => {
		const stubIdentity = {
			command: 'qemu-system-x86_64 -m 4G -smp 4',
			lstart: 'Fri May 22 10:00:00 2026',
		};

		const record = await buildGatewayRuntimeRecord({
			controllerPort: 18_800,
			gatewayType: 'openclaw',
			ingressPort: 18_791,
			managedVm: createManagedVmStub({ hostPid: 28_282, id: 'gateway-vm-123' }),
			processSpec: {
				bootstrapCommand: 'bootstrap-openclaw',
				guestListenPort: 18_789,
				healthCheck: { path: '/', port: 18_789, type: 'http' },
				logPath: '/tmp/openclaw.log',
				startCommand: 'start-openclaw',
			},
			projectNamespace: 'claw-tests-a1b2c3d4',
			readProcessIdentity: async () => stubIdentity,
			systemConfigPath: '/deployments/claw/config/system.jsonc',
			zoneId: 'shravan',
		});

		expect(record).toMatchObject({
			configPath: '/deployments/claw/config/system.jsonc',
			controllerPort: 18_800,
			gatewayType: 'openclaw',
			guestListenPort: 18_789,
			ingressPort: 18_791,
			processIdentity: stubIdentity,
			projectNamespace: 'claw-tests-a1b2c3d4',
			qemuPid: 28_282,
			schemaVersion: 1,
			sessionLabel: 'claw-tests-a1b2c3d4:shravan:gateway',
			vmId: 'gateway-vm-123',
			zoneId: 'shravan',
		});
		expect(record.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
	});

	it('buildGatewayRuntimeRecord throws when ps cannot resolve process identity', async () => {
		await expect(
			buildGatewayRuntimeRecord({
				controllerPort: 18_800,
				gatewayType: 'openclaw',
				ingressPort: 18_791,
				managedVm: createManagedVmStub({ hostPid: 28_282, id: 'gateway-vm-123' }),
				processSpec: {
					bootstrapCommand: 'bootstrap-openclaw',
					guestListenPort: 18_789,
					healthCheck: { path: '/', port: 18_789, type: 'http' },
					logPath: '/tmp/openclaw.log',
					startCommand: 'start-openclaw',
				},
				projectNamespace: 'claw-tests-a1b2c3d4',
				readProcessIdentity: async () => null,
				systemConfigPath: '/deployments/claw/config/system.jsonc',
				zoneId: 'shravan',
			}),
		).rejects.toThrow("Failed to capture process identity for gateway VM 'gateway-vm-123'");
	});

	it('buildGatewayRuntimeRecord throws when Gondolin does not expose an active host PID', async () => {
		const managedVm = {
			...createManagedVmStub({ hostPid: 28_282, id: 'gateway-vm-123' }),
			getHostPid: () => null,
		} satisfies ManagedVm;

		await expect(
			buildGatewayRuntimeRecord({
				controllerPort: 18_800,
				gatewayType: 'openclaw',
				ingressPort: 18_791,
				managedVm,
				processSpec: {
					bootstrapCommand: 'bootstrap-openclaw',
					guestListenPort: 18_789,
					healthCheck: { path: '/', port: 18_789, type: 'http' },
					logPath: '/tmp/openclaw.log',
					startCommand: 'start-openclaw',
				},
				projectNamespace: 'claw-tests-a1b2c3d4',
				systemConfigPath: '/deployments/claw/config/system.jsonc',
				zoneId: 'shravan',
			}),
		).rejects.toThrow(/does not expose an active host pid/u);
	});

	it('buildGatewayRuntimeRecord throws when Gondolin exposes an invalid host PID', async () => {
		const managedVm = {
			...createManagedVmStub({ hostPid: 28_282, id: 'gateway-vm-123' }),
			getHostPid: () => 0,
		} satisfies ManagedVm;

		await expect(
			buildGatewayRuntimeRecord({
				controllerPort: 18_800,
				gatewayType: 'openclaw',
				ingressPort: 18_791,
				managedVm,
				processSpec: {
					bootstrapCommand: 'bootstrap-openclaw',
					guestListenPort: 18_789,
					healthCheck: { path: '/', port: 18_789, type: 'http' },
					logPath: '/tmp/openclaw.log',
					startCommand: 'start-openclaw',
				},
				projectNamespace: 'claw-tests-a1b2c3d4',
				systemConfigPath: '/deployments/claw/config/system.jsonc',
				zoneId: 'shravan',
			}),
		).rejects.toThrow(/invalid host pid/u);
	});
});
