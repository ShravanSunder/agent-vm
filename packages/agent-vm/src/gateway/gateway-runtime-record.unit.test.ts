import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ManagedGatewayBootContract } from '@agent-vm/gateway-lifecycle';
import type { ManagedVm, ManagedVmImageBuildResult } from '@agent-vm/managed-vm';
import { afterEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import type { ControllerManagedGatewayRuntimeRecordTarget } from '../controller/durable-state/controller-state-record-paths.js';
import type { ManagedVmProcessTarget } from '../shared/controller-managed-vm-termination.js';
import {
	TEST_SSH_SERVER_HOST_KEY,
	createManagedExecProcessStub,
} from '../testing/managed-vm-test-helpers.js';
import type { GatewayExpectedAdmissionCohort } from './gateway-aggregate-admission-state.js';
import {
	buildManagedGatewayRuntimeRecord,
	deleteManagedGatewayRuntimeRecord,
	loadManagedGatewayRuntimeRecord,
	loadManagedGatewayRuntimeRecordResult,
	managedGatewayRuntimeRecordSchema,
	type ManagedGatewayRuntimeRecord,
	writeManagedGatewayRuntimeRecord,
} from './gateway-runtime-record.js';

const createdDirectories: string[] = [];
const gatewayIdentity = {
	bootId: 'boot-a',
	controllerEpoch: 'controller-epoch-a',
	gatewayEpochId: 'gateway-ownership-epoch-a',
	gatewayVmId: 'gateway-vm-123',
	generationId: 'gateway-generation-a',
	zoneId: 'shravan',
} as const;
const expectedCohort = {
	controlIdentity: {
		controllerEpoch: gatewayIdentity.controllerEpoch,
		generationId: gatewayIdentity.generationId,
		peerId: 'tool-portal-control',
		processEpoch: 'tool-portal-process-a',
	},
	fence: {
		controllerEpoch: gatewayIdentity.controllerEpoch,
		gatewayEpoch: gatewayIdentity.generationId,
		vmId: gatewayIdentity.gatewayVmId,
		zoneId: gatewayIdentity.zoneId,
	},
	frameworkIdentity: {
		attachmentGeneration: 1,
		clientKind: 'hermes-managed-plugin',
		configuredAgentIds: ['agent-a', 'agent-b'],
		frameworkEpoch: 'framework-epoch-a',
		frameworkKind: 'hermes',
		projectionCohortDigest:
			'projection-cohort:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
	},
	ingressIntent: {
		controlRoute: {
			audience: 'gateway-control',
			guestPort: 18_790,
			kind: 'tool-portal-control',
			prefix: '/_agent-vm/control',
			stripPrefix: true,
		},
		frameworkRootRoute: {
			guestPort: 18_789,
			kind: 'framework-root',
			prefix: '/',
			stripPrefix: true,
		},
	},
	providerRevision: 'provider-revision-a',
	requiredBackendRevision: 'required-backends-a',
	semanticRevision: 'semantic-revision-a',
	toolPortalIdentity: {
		processEpoch: 'tool-portal-process-a',
		role: 'tool-portal',
		runtimeEpoch: 'runtime-epoch-a',
		serviceId: 'tool-portal-service-a',
	},
	udsIdentity: {
		frameworkEpoch: 'framework-epoch-a',
		gatewayEpoch: gatewayIdentity.generationId,
		runtimeEpoch: 'runtime-epoch-a',
		socketPath: '/run/agent-vm/gateway-runtime/managed-plugin.sock',
	},
} as const satisfies GatewayExpectedAdmissionCohort;
const bootContract = {
	contractVersion: 1,
	frameworkService: {
		bootEntry: 'hermes-gateway',
		configurationInputPath: '/run/agent-vm/managed-gateway/framework-service.json',
		environmentInputPath: '/run/agent-vm/managed-gateway/framework.environment.sh',
		framework: 'hermes',
		ingress: { guestPort: 18_789, kind: 'framework-http' },
		logIdentity: {
			guestPath: '/var/log/agent-vm/hermes-gateway.log',
			serviceName: 'hermes-gateway',
		},
		readiness: { guestPort: 18_789, kind: 'framework-http', path: '/readyz' },
		role: 'framework-service',
	},
	kind: 'managed-gateway-exact-two-role',
	toolPortalService: {
		bootEntry: 'agent-vm-gateway-runtime',
		configurationInputPath: '/run/agent-vm/managed-gateway/tool-portal-service.json',
		environmentInputPath: '/run/agent-vm/managed-gateway/tool-portal.environment.sh',
		logIdentity: {
			guestPath: '/var/log/agent-vm/tool-portal-service.log',
			serviceName: 'agent-vm-tool-portal',
		},
		readiness: {
			evidencePath: '/run/agent-vm/gateway-runtime/tool-portal.readiness.json',
			kind: 'tool-portal-evidence',
			socketPath: '/run/agent-vm/gateway-runtime/managed-plugin.sock',
		},
		role: 'tool-portal-service',
	},
} as const satisfies ManagedGatewayBootContract;
const image = {
	built: true,
	fingerprint: 'gateway-image-fingerprint-a',
	imageReference: 'gateway-image-reference-a',
} as const satisfies ManagedVmImageBuildResult;
const processIdentity = {
	command: 'qemu-system-x86_64 -m 4G -smp 4',
	lstart: 'Fri May 22 10:00:00 2026',
} as const;
const processTarget = {
	hostPid: 4242,
	processIdentity,
	vmId: gatewayIdentity.gatewayVmId,
} as const satisfies ManagedVmProcessTarget;
const appliedIngressRoutes = [
	expectedCohort.ingressIntent.controlRoute,
	expectedCohort.ingressIntent.frameworkRootRoute,
] as const;

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

function createRuntimeRecordTarget(
	stateDirectory: string,
	zoneId: string = gatewayIdentity.zoneId,
): ControllerManagedGatewayRuntimeRecordTarget {
	return {
		filePath: path.join(stateDirectory, 'controller-records', 'managed-gateway-record.json'),
		kind: 'controller-managed-gateway-runtime-record',
		zoneId,
	};
}

function createManagedVmStub(options: {
	readonly hostPid: number;
	readonly id: string;
}): ManagedVm {
	return {
		close: async () => {},
		enableIngress: async () => ({ close: async () => {}, host: '127.0.0.1', port: 18_791 }),
		enableSsh: async () => ({
			close: async () => {},
			command: 'ssh -i /tmp/key sandbox@127.0.0.1 -p 19000',
			identityFile: '/tmp/key',
			serverHostKey: TEST_SSH_SERVER_HOST_KEY,
			host: '127.0.0.1',
			port: 19_000,
			user: 'sandbox',
		}),
		exec: () => createManagedExecProcessStub(),
		getHostProcessId: () => options.hostPid,
		id: options.id,
		configureIngressRoutes: () => {},
		start: async () => {},
	};
}

function buildSampleRecord(
	overrides: Partial<ManagedGatewayRuntimeRecord> = {},
): ManagedGatewayRuntimeRecord {
	return {
		appliedIngressRoutes,
		bootContract,
		configPath: '/deployments/claw/config/system.jsonc',
		controllerPort: 18_800,
		createdAt: '2026-04-13T12:34:56.000Z',
		expectedCohort,
		gateway: gatewayIdentity,
		image,
		ingressPort: 18_791,
		processIdentity,
		processTarget,
		projectNamespace: 'agent-vm-tests-a1b2c3d4',
		qemuPid: 4242,
		runtimeKind: 'managed-gateway',
		schemaVersion: 4,
		sessionLabel: 'agent-vm-tests-a1b2c3d4:shravan:gateway',
		vmId: gatewayIdentity.gatewayVmId,
		zoneId: 'shravan',
		...overrides,
	};
}

describe('managed Gateway runtime record', () => {
	it('accepts only strict schema-v4 managed Gateway records', () => {
		expect(managedGatewayRuntimeRecordSchema.parse(buildSampleRecord())).toEqual(
			buildSampleRecord(),
		);
		for (const schemaVersion of [1, 2, 3, 5]) {
			expect(() =>
				managedGatewayRuntimeRecordSchema.parse({ ...buildSampleRecord(), schemaVersion }),
			).toThrow(ZodError);
		}
		expect(() =>
			managedGatewayRuntimeRecordSchema.parse({
				...buildSampleRecord(),
				gatewayType: 'openclaw',
			}),
		).toThrow(ZodError);
		expect(() =>
			managedGatewayRuntimeRecordSchema.parse({
				...buildSampleRecord(),
				guestListenPort: 18_789,
			}),
		).toThrow(ZodError);
		expect(() =>
			managedGatewayRuntimeRecordSchema.parse({
				...buildSampleRecord(),
				processSpec: { startCommand: 'openclaw gateway' },
			}),
		).toThrow(ZodError);
	});

	it('requires the complete strict expected admission cohort', () => {
		const { udsIdentity: _udsIdentity, ...incompleteCohort } = expectedCohort;
		expect(() =>
			managedGatewayRuntimeRecordSchema.parse({
				...buildSampleRecord(),
				expectedCohort: incompleteCohort,
			}),
		).toThrow(ZodError);
		expect(() =>
			managedGatewayRuntimeRecordSchema.parse({
				...buildSampleRecord(),
				expectedCohort: { ...expectedCohort, launchCommand: 'openclaw gateway' },
			}),
		).toThrow(ZodError);
	});

	it('rejects every stale Gateway, VM, zone, and control cross-identity', () => {
		const mismatchedRecords: readonly unknown[] = [
			buildSampleRecord({ vmId: 'different-vm' }),
			buildSampleRecord({ zoneId: 'different-zone' }),
			buildSampleRecord({
				expectedCohort: {
					...expectedCohort,
					fence: { ...expectedCohort.fence, controllerEpoch: 'stale-controller' },
				},
			}),
			buildSampleRecord({
				expectedCohort: {
					...expectedCohort,
					controlIdentity: { ...expectedCohort.controlIdentity, generationId: 'stale-generation' },
				},
			}),
			buildSampleRecord({
				expectedCohort: {
					...expectedCohort,
					udsIdentity: { ...expectedCohort.udsIdentity, gatewayEpoch: 'stale-gateway' },
				},
			}),
		];

		for (const mismatchedRecord of mismatchedRecords) {
			expect(() => managedGatewayRuntimeRecordSchema.parse(mismatchedRecord)).toThrow(ZodError);
		}
	});

	it('rejects stale Tool Portal runtime, process, and framework epochs', () => {
		const mismatchedCohorts: readonly GatewayExpectedAdmissionCohort[] = [
			{
				...expectedCohort,
				controlIdentity: { ...expectedCohort.controlIdentity, processEpoch: 'stale-process' },
			},
			{
				...expectedCohort,
				udsIdentity: { ...expectedCohort.udsIdentity, runtimeEpoch: 'stale-runtime' },
			},
			{
				...expectedCohort,
				udsIdentity: { ...expectedCohort.udsIdentity, frameworkEpoch: 'stale-framework' },
			},
		];

		for (const mismatchedCohort of mismatchedCohorts) {
			expect(() =>
				managedGatewayRuntimeRecordSchema.parse({
					...buildSampleRecord(),
					expectedCohort: mismatchedCohort,
				}),
			).toThrow(ZodError);
		}
	});

	it('rejects duplicate configured agents', () => {
		expect(() =>
			managedGatewayRuntimeRecordSchema.parse({
				...buildSampleRecord(),
				expectedCohort: {
					...expectedCohort,
					frameworkIdentity: {
						...expectedCohort.frameworkIdentity,
						configuredAgentIds: ['agent-a', 'agent-a'],
					},
				},
			}),
		).toThrow(ZodError);
	});

	it('rejects mismatched exact VM process containment evidence', () => {
		for (const processTargetOverride of [
			{ ...processTarget, hostPid: 4243 },
			{
				...processTarget,
				processIdentity: { ...processIdentity, lstart: 'Sat May 23 10:00:00 2026' },
			},
			{ ...processTarget, vmId: 'different-vm' },
		] satisfies readonly ManagedVmProcessTarget[]) {
			expect(() =>
				managedGatewayRuntimeRecordSchema.parse({
					...buildSampleRecord(),
					processTarget: processTargetOverride,
				}),
			).toThrow(ZodError);
		}
	});

	it('rejects a mismatched framework ingress port', () => {
		expect(() =>
			managedGatewayRuntimeRecordSchema.parse({
				...buildSampleRecord(),
				bootContract: {
					...bootContract,
					frameworkService: {
						...bootContract.frameworkService,
						ingress: { ...bootContract.frameworkService.ingress, guestPort: 18_788 },
						readiness: { ...bootContract.frameworkService.readiness, guestPort: 18_788 },
					},
				},
			}),
		).toThrow(ZodError);
	});

	it('rejects incomplete, duplicate, or unexpected applied ingress inventories', () => {
		for (const routes of [
			[expectedCohort.ingressIntent.controlRoute],
			[...appliedIngressRoutes, expectedCohort.ingressIntent.frameworkRootRoute],
			[
				...appliedIngressRoutes,
				{
					guestPort: 18_790,
					kind: 'framework-root',
					prefix: '/unexpected',
					stripPrefix: false,
				},
			],
		] as const) {
			expect(() =>
				managedGatewayRuntimeRecordSchema.parse({
					...buildSampleRecord(),
					appliedIngressRoutes: routes,
				}),
			).toThrow(ZodError);
		}
	});

	it('rejects malformed image identity and forbidden launch authority', () => {
		for (const record of [
			{ ...buildSampleRecord(), image: { ...image, fingerprint: '' } },
			{ ...buildSampleRecord(), image: { ...image, imageReference: `unsafe\0reference` } },
			{ ...buildSampleRecord(), launchCommand: 'hermes gateway' },
			{ ...buildSampleRecord(), nativeHandle: { pid: 42 } },
		]) {
			expect(() => managedGatewayRuntimeRecordSchema.parse(record)).toThrow(ZodError);
		}
	});

	it('writes and loads exact mode-0600 containment evidence', async () => {
		const stateDirectory = await createStateDirectory();
		const runtimeRecordTarget = createRuntimeRecordTarget(stateDirectory);
		const record = buildSampleRecord();

		await writeManagedGatewayRuntimeRecord(runtimeRecordTarget, record);

		await expect(loadManagedGatewayRuntimeRecord(runtimeRecordTarget)).resolves.toEqual(record);
		expect((await stat(runtimeRecordTarget.filePath)).mode & 0o777).toBe(0o600);
		expect(await readdir(stateDirectory)).toEqual(['controller-records']);
		expect(await readdir(path.dirname(runtimeRecordTarget.filePath))).toEqual([
			'managed-gateway-record.json',
		]);
	});

	it('returns missing and preserves malformed or legacy records as parse errors', async () => {
		const missingStateDirectory = await createStateDirectory();
		const missingTarget = createRuntimeRecordTarget(missingStateDirectory);
		await expect(loadManagedGatewayRuntimeRecord(missingTarget)).resolves.toBeNull();
		await expect(loadManagedGatewayRuntimeRecordResult(missingTarget)).resolves.toMatchObject({
			kind: 'missing',
			path: missingTarget.filePath,
		});

		const malformedStateDirectory = await createStateDirectory();
		const malformedTarget = createRuntimeRecordTarget(malformedStateDirectory);
		await mkdir(path.dirname(malformedTarget.filePath), { recursive: true });
		await writeFile(malformedTarget.filePath, '{not-json');
		const malformedResult = await loadManagedGatewayRuntimeRecordResult(malformedTarget);
		expect(malformedResult).toMatchObject({ kind: 'parse-error' });
		expect(await readFile(malformedTarget.filePath, 'utf8')).toBe('{not-json');

		const legacyStateDirectory = await createStateDirectory();
		const legacyTarget = createRuntimeRecordTarget(legacyStateDirectory);
		await mkdir(path.dirname(legacyTarget.filePath), { recursive: true });
		await writeFile(
			legacyTarget.filePath,
			`${JSON.stringify({ ...buildSampleRecord(), schemaVersion: 2 })}\n`,
		);
		await expect(loadManagedGatewayRuntimeRecord(legacyTarget)).rejects.toThrow(ZodError);
		expect(await readdir(path.dirname(legacyTarget.filePath))).toEqual([
			'managed-gateway-record.json',
		]);
	});

	it('rejects a valid record bound to a different controller zone on read and write', async () => {
		const readStateDirectory = await createStateDirectory();
		const crossZoneReadTarget = createRuntimeRecordTarget(readStateDirectory, 'other-zone');
		await mkdir(path.dirname(crossZoneReadTarget.filePath), { recursive: true });
		await writeFile(crossZoneReadTarget.filePath, `${JSON.stringify(buildSampleRecord())}\n`);

		await expect(loadManagedGatewayRuntimeRecordResult(crossZoneReadTarget)).resolves.toMatchObject(
			{
				kind: 'parse-error',
			},
		);
		await expect(loadManagedGatewayRuntimeRecord(crossZoneReadTarget)).rejects.toThrow(
			/target zone/u,
		);

		const writeStateDirectory = await createStateDirectory();
		const crossZoneWriteTarget = createRuntimeRecordTarget(writeStateDirectory, 'other-zone');
		await expect(
			writeManagedGatewayRuntimeRecord(crossZoneWriteTarget, buildSampleRecord()),
		).rejects.toThrow(/target zone/u);
		expect(await readdir(writeStateDirectory)).toEqual([]);
	});

	it('deletes a persisted managed Gateway record', async () => {
		const stateDirectory = await createStateDirectory();
		const runtimeRecordTarget = createRuntimeRecordTarget(stateDirectory);
		await writeManagedGatewayRuntimeRecord(runtimeRecordTarget, buildSampleRecord());

		await deleteManagedGatewayRuntimeRecord(runtimeRecordTarget);

		await expect(loadManagedGatewayRuntimeRecord(runtimeRecordTarget)).resolves.toBeNull();
	});

	it('rejects invalid records on write before touching disk', async () => {
		const stateDirectory = await createStateDirectory();
		const runtimeRecordTarget = createRuntimeRecordTarget(stateDirectory);

		await expect(
			writeManagedGatewayRuntimeRecord(runtimeRecordTarget, {
				...buildSampleRecord(),
				createdAt: 'not-a-datetime',
			}),
		).rejects.toThrow(ZodError);
		expect(await readdir(stateDirectory)).toEqual([]);
	});

	it('builds managed containment evidence without framework launch authority', async () => {
		const liveProcessIdentity = {
			command: 'qemu-system-x86_64 -m 4G -smp 4',
			lstart: 'Fri May 22 10:00:00 2026',
		};
		const liveProcessTarget = {
			hostPid: 28_282,
			processIdentity: liveProcessIdentity,
			vmId: gatewayIdentity.gatewayVmId,
		} as const satisfies ManagedVmProcessTarget;

		const record = await buildManagedGatewayRuntimeRecord({
			appliedIngressRoutes,
			bootContract,
			controllerPort: 18_800,
			expectedCohort,
			gatewayIdentity,
			ingressPort: 18_791,
			image,
			managedVm: createManagedVmStub({ hostPid: 28_282, id: gatewayIdentity.gatewayVmId }),
			processTarget: liveProcessTarget,
			projectNamespace: 'agent-vm-tests-a1b2c3d4',
			readProcessIdentity: async () => liveProcessIdentity,
			systemConfigPath: '/deployments/claw/config/system.jsonc',
			zoneId: gatewayIdentity.zoneId,
		});

		expect(record).toMatchObject({
			appliedIngressRoutes,
			bootContract,
			expectedCohort,
			gateway: gatewayIdentity,
			image,
			ingressPort: 18_791,
			processIdentity: liveProcessIdentity,
			processTarget: liveProcessTarget,
			qemuPid: 28_282,
			runtimeKind: 'managed-gateway',
			schemaVersion: 4,
		});
		expect(record).not.toHaveProperty('gatewayType');
		expect(record).not.toHaveProperty('guestListenPort');
		expect(record).not.toHaveProperty('processSpec');
	});

	it('builds containment evidence before ingress exists', async () => {
		const liveProcessTarget = {
			hostPid: 28_282,
			processIdentity,
			vmId: gatewayIdentity.gatewayVmId,
		} as const satisfies ManagedVmProcessTarget;
		const record = await buildManagedGatewayRuntimeRecord({
			appliedIngressRoutes,
			bootContract,
			controllerPort: 18_800,
			expectedCohort,
			gatewayIdentity,
			image,
			managedVm: createManagedVmStub({ hostPid: 28_282, id: gatewayIdentity.gatewayVmId }),
			processTarget: liveProcessTarget,
			projectNamespace: 'agent-vm-tests-a1b2c3d4',
			readProcessIdentity: async () => processIdentity,
			systemConfigPath: '/deployments/claw/config/system.jsonc',
			zoneId: gatewayIdentity.zoneId,
		});

		expect(record).not.toHaveProperty('ingressPort');
		expect(managedGatewayRuntimeRecordSchema.parse(record)).toEqual(record);
	});

	it('refuses to build without exact live QEMU process evidence', async () => {
		const buildOptions = {
			appliedIngressRoutes,
			bootContract,
			controllerPort: 18_800,
			expectedCohort,
			gatewayIdentity,
			image,
			managedVm: createManagedVmStub({ hostPid: 28_282, id: gatewayIdentity.gatewayVmId }),
			processTarget: {
				hostPid: 28_282,
				processIdentity,
				vmId: gatewayIdentity.gatewayVmId,
			},
			projectNamespace: 'agent-vm-tests-a1b2c3d4',
			systemConfigPath: '/deployments/claw/config/system.jsonc',
			zoneId: gatewayIdentity.zoneId,
		} as const;

		await expect(
			buildManagedGatewayRuntimeRecord({
				...buildOptions,
				readProcessIdentity: async () => null,
			}),
		).rejects.toThrow('Failed to capture process identity');
		await expect(
			buildManagedGatewayRuntimeRecord({
				...buildOptions,
				managedVm: {
					...buildOptions.managedVm,
					getHostProcessId: () => null,
				},
			}),
		).rejects.toThrow('does not expose an active host process id');
	});
});
