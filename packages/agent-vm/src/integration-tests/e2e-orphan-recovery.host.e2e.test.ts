import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createManagedVmRuntimeComposition } from '../composition/gondolin-managed-vm-provider.js';
import {
	createControllerStateRoot,
	resolveControllerGatewayStateRoot,
} from '../controller/durable-state/controller-state-paths.js';
import {
	resolveControllerGatewayRecordTargets,
	type ControllerGatewayRecordTargets,
	type ControllerManagedGatewayRuntimeRecordTarget,
} from '../controller/durable-state/controller-state-record-paths.js';
import type { GatewayEpochIdentity } from '../controller/vm-ownership/vm-ownership-contracts.js';
import { cleanupRecordedGatewayRuntime } from '../gateway/gateway-recovery.js';
import {
	loadManagedGatewayRuntimeRecord,
	type ManagedGatewayRuntimeRecord,
	writeManagedGatewayRuntimeRecord,
} from '../gateway/gateway-runtime-record.js';
import { createManagedGatewayBootContract } from '../gateway/managed-gateway-boot-contract.js';

const createdDirectories: string[] = [];
const zoneId = 'shravan';
const managedVmRuntimeComposition = createManagedVmRuntimeComposition();

const testManagedGatewayBootContract = createManagedGatewayBootContract({
	bootEntry: 'hermes-gateway',
	configurationInputPath: '/run/agent-vm/managed-gateway/framework-service.json',
	environmentInputPath: '/run/agent-vm/managed-gateway/framework.environment.sh',
	framework: 'hermes',
	ingress: { guestPort: 8642, kind: 'framework-http' },
	logIdentity: {
		guestPath: '/var/log/agent-vm/hermes-service.log',
		serviceName: 'agent-vm-hermes-test',
	},
	readiness: { guestPort: 8642, kind: 'framework-http', path: '/health' },
	role: 'framework-service',
});

const testManagedGatewayImage = {
	built: false,
	fingerprint: 'orphan-recovery-test-image',
	imageReference: 'hermes-gateway:test',
};

afterEach(() => {
	for (const directoryPath of createdDirectories.splice(0)) {
		fs.rmSync(directoryPath, { recursive: true, force: true });
	}
});

function createControllerStateDirectory(): string {
	const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-vm-orphan-recovery-'));
	createdDirectories.push(temporaryDirectory);
	return temporaryDirectory;
}

function createFixtureControllerRecordTargets(): ControllerGatewayRecordTargets {
	const controllerStateDirectoryPath = createControllerStateDirectory();
	return resolveControllerGatewayRecordTargets({
		gatewayStateRoot: resolveControllerGatewayStateRoot({
			controllerStateRoot: createControllerStateRoot({ controllerStateDirectoryPath }),
			zoneId,
		}),
	});
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

function createManagedGatewayExpectedCohort(
	gatewayIdentity: GatewayEpochIdentity,
): ManagedGatewayRuntimeRecord['expectedCohort'] {
	const identitySuffix = `${gatewayIdentity.zoneId}:${gatewayIdentity.generationId}`;
	const frameworkEpoch = `hermes-framework:${gatewayIdentity.bootId}`;
	const processEpoch = `tool-portal-process:${gatewayIdentity.bootId}`;
	const runtimeEpoch = `tool-portal-runtime:${gatewayIdentity.generationId}`;
	return {
		controlIdentity: {
			controllerEpoch: gatewayIdentity.controllerEpoch,
			generationId: gatewayIdentity.generationId,
			peerId: `tool-portal-control:${gatewayIdentity.zoneId}`,
			processEpoch,
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
			configuredAgentIds: ['shravan'],
			frameworkEpoch,
			frameworkKind: 'hermes',
			projectionCohortDigest:
				'projection-cohort:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
		},
		ingressIntent: {
			controlRoute: {
				audience: 'gateway-control',
				guestPort: 18_790,
				kind: 'tool-portal-control',
				prefix: '/__agent-vm',
				stripPrefix: false,
			},
			frameworkRootRoute: {
				guestPort: 8642,
				kind: 'framework-root',
				prefix: '/',
				stripPrefix: true,
			},
		},
		providerRevision: `provider:${identitySuffix}`,
		requiredBackendRevision: `required-backends:${identitySuffix}`,
		semanticRevision: `semantic:${identitySuffix}`,
		toolPortalIdentity: {
			processEpoch,
			role: 'tool-portal',
			runtimeEpoch,
			serviceId: `tool-portal-service:${identitySuffix}`,
		},
		udsIdentity: {
			frameworkEpoch,
			gatewayEpoch: gatewayIdentity.generationId,
			runtimeEpoch,
			socketPath: '/run/agent-vm/gateway-runtime/managed-plugin.sock',
		},
	};
}

function createRuntimeRecord(props: {
	readonly ingressPort: number;
	readonly qemuPid: number;
	readonly runtimeRecordTarget: ControllerManagedGatewayRuntimeRecordTarget;
}): Promise<void> {
	const gatewayIdentity = {
		bootId: 'boot-a',
		controllerEpoch: 'controller-epoch-a',
		gatewayEpochId: 'gateway-epoch-a',
		gatewayVmId: `vm-${props.qemuPid}`,
		generationId: 'generation-a',
		zoneId: 'shravan',
	} satisfies GatewayEpochIdentity;
	const expectedCohort = createManagedGatewayExpectedCohort(gatewayIdentity);
	const processIdentity = {
		command: 'qemu-system-aarch64 -m 4G',
		lstart: 'Fri May 22 10:00:00 2026',
	};
	return writeManagedGatewayRuntimeRecord(props.runtimeRecordTarget, {
		appliedIngressRoutes: [
			{ ...expectedCohort.ingressIntent.controlRoute, guestPort: 18_790 },
			expectedCohort.ingressIntent.frameworkRootRoute,
		],
		bootContract: testManagedGatewayBootContract,
		configPath: '/deployments/hermes/config/system.jsonc',
		controllerPort: 18800,
		createdAt: '2026-04-13T12:34:56.000Z',
		expectedCohort,
		gateway: gatewayIdentity,
		image: testManagedGatewayImage,
		ingressPort: props.ingressPort,
		processIdentity,
		processTarget: {
			hostPid: props.qemuPid,
			processIdentity,
			vmId: gatewayIdentity.gatewayVmId,
		},
		projectNamespace: 'agent-vm-tests-a1b2c3d4',
		qemuPid: props.qemuPid,
		runtimeKind: 'managed-gateway',
		schemaVersion: 4,
		sessionLabel: 'agent-vm-tests-a1b2c3d4:shravan:gateway',
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
		const controllerRecordTargets = createFixtureControllerRecordTargets();
		const deadPid = findDefinitelyDeadPid();
		const ingressPort = await findUnusedTcpPort();
		await createRuntimeRecord({
			ingressPort,
			qemuPid: deadPid,
			runtimeRecordTarget: controllerRecordTargets.managedGatewayRuntimeRecord,
		});

		await expect(
			cleanupRecordedGatewayRuntime(
				{
					expectedConfigPath: '/deployments/hermes/config/system.jsonc',
					expectedControllerPort: 18800,
					projectNamespace: 'agent-vm-tests-a1b2c3d4',
					runtimeRecordTarget: controllerRecordTargets.managedGatewayRuntimeRecord,
					zoneId,
				},
				{
					exactProcessTermination: managedVmRuntimeComposition.managedVmExactProcessTermination,
				},
			),
		).resolves.toEqual({
			cleanedUp: true,
			killedPid: null,
		});

		await expect(
			loadManagedGatewayRuntimeRecord(controllerRecordTargets.managedGatewayRuntimeRecord),
		).resolves.toBeNull();
		expect(fs.existsSync(controllerRecordTargets.managedGatewayRuntimeRecord.filePath)).toBe(false);
	});

	it('removes a stale record without signaling when the recorded pid was reused by an unrelated process', async () => {
		const controllerRecordTargets = createFixtureControllerRecordTargets();
		const ingressPort = await findUnusedTcpPort();
		await createRuntimeRecord({
			ingressPort,
			qemuPid: 1,
			runtimeRecordTarget: controllerRecordTargets.managedGatewayRuntimeRecord,
		});

		await expect(
			cleanupRecordedGatewayRuntime(
				{
					expectedConfigPath: '/deployments/hermes/config/system.jsonc',
					expectedControllerPort: 18800,
					projectNamespace: 'agent-vm-tests-a1b2c3d4',
					runtimeRecordTarget: controllerRecordTargets.managedGatewayRuntimeRecord,
					zoneId,
				},
				{
					exactProcessTermination: managedVmRuntimeComposition.managedVmExactProcessTermination,
				},
			),
		).resolves.toEqual({
			cleanedUp: true,
			killedPid: null,
		});

		await expect(
			loadManagedGatewayRuntimeRecord(controllerRecordTargets.managedGatewayRuntimeRecord),
		).resolves.toBeNull();
	});

	it('is a no-op when no runtime record exists', async () => {
		const controllerRecordTargets = createFixtureControllerRecordTargets();

		await expect(
			cleanupRecordedGatewayRuntime(
				{
					expectedConfigPath: '/deployments/hermes/config/system.jsonc',
					expectedControllerPort: 18800,
					projectNamespace: 'agent-vm-tests-a1b2c3d4',
					runtimeRecordTarget: controllerRecordTargets.managedGatewayRuntimeRecord,
					zoneId,
				},
				{
					exactProcessTermination: managedVmRuntimeComposition.managedVmExactProcessTermination,
				},
			),
		).resolves.toEqual({
			cleanedUp: false,
			killedPid: null,
		});
	});

	it('throws and preserves malformed runtime records during offline cleanup', async () => {
		const controllerRecordTargets = createFixtureControllerRecordTargets();
		const runtimeRecordPath = controllerRecordTargets.managedGatewayRuntimeRecord.filePath;
		fs.mkdirSync(path.dirname(runtimeRecordPath), { recursive: true });
		fs.writeFileSync(runtimeRecordPath, '{"createdAt":', 'utf8');

		await expect(
			cleanupRecordedGatewayRuntime(
				{
					expectedConfigPath: '/deployments/hermes/config/system.jsonc',
					expectedControllerPort: 18800,
					projectNamespace: 'agent-vm-tests-a1b2c3d4',
					runtimeRecordTarget: controllerRecordTargets.managedGatewayRuntimeRecord,
					zoneId,
				},
				{
					exactProcessTermination: managedVmRuntimeComposition.managedVmExactProcessTermination,
				},
			),
		).rejects.toThrow(/Malformed gateway runtime record/u);

		expect(fs.existsSync(runtimeRecordPath)).toBe(true);
	});
});
