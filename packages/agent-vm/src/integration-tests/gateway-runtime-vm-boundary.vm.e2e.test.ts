import { describe, expect, it } from 'vitest';

import { shouldRunLiveVmE2e } from './live-vm-e2e-gates.js';
import { startManagedGatewayImageBootFixture } from './managed-gateway-image-boot-test-fixture.js';

const describeLiveVmIntegration = shouldRunLiveVmE2e() ? describe : describe.skip;
const gatewayRuntimeEvidencePrefix = 'GATEWAY_RUNTIME_VM_BOUNDARY_EVIDENCE=';

interface GatewayRuntimeVmBoundaryEvidence {
	readonly attachmentDecisions: {
		readonly current: 'accepted';
		readonly duplicate: 'duplicate-active-connection';
		readonly afterAttachmentLoss: 'retired-attachment';
	};
	readonly frameworkChildOwnershipAbsent: true;
	readonly packageBinPath: string;
	readonly packageEntrypoint: string;
	readonly processGroupId: number;
	readonly processUserId: number;
	readonly readinessRevision: string;
	readonly retirement: {
		readonly artifactEpochRetired: true;
		readonly controlEndpointClosed: true;
		readonly providerRuntimeClosed: true;
		readonly socketRemoved: true;
	};
	readonly runtimeRoot: string;
	readonly runtimeRootMode: number;
	readonly runtimeRootOwnerGroupId: number;
	readonly runtimeRootOwnerUserId: number;
	readonly socketAddress: string;
	readonly socketIsMounted: boolean;
	readonly socketIsUnixDomainSocket: boolean;
}

function isObjectRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseGatewayRuntimeVmBoundaryEvidence(stdout: string): GatewayRuntimeVmBoundaryEvidence {
	const evidenceLine = stdout
		.split('\n')
		.find((line) => line.startsWith(gatewayRuntimeEvidencePrefix));
	if (evidenceLine === undefined) {
		throw new Error(`Gateway runtime VM probe omitted evidence. stdout:\n${stdout}`);
	}
	const parsed: unknown = JSON.parse(evidenceLine.slice(gatewayRuntimeEvidencePrefix.length));
	if (
		!isObjectRecord(parsed) ||
		!isObjectRecord(parsed.attachmentDecisions) ||
		parsed.frameworkChildOwnershipAbsent !== true ||
		typeof parsed.packageBinPath !== 'string' ||
		typeof parsed.packageEntrypoint !== 'string' ||
		typeof parsed.processGroupId !== 'number' ||
		typeof parsed.processUserId !== 'number' ||
		typeof parsed.readinessRevision !== 'string' ||
		!isObjectRecord(parsed.retirement) ||
		typeof parsed.runtimeRoot !== 'string' ||
		typeof parsed.runtimeRootMode !== 'number' ||
		typeof parsed.runtimeRootOwnerGroupId !== 'number' ||
		typeof parsed.runtimeRootOwnerUserId !== 'number' ||
		typeof parsed.socketAddress !== 'string' ||
		typeof parsed.socketIsMounted !== 'boolean' ||
		typeof parsed.socketIsUnixDomainSocket !== 'boolean'
	) {
		throw new Error(`Gateway runtime VM probe returned malformed evidence: ${evidenceLine}`);
	}
	const attachmentDecisions = parsed.attachmentDecisions;
	if (
		attachmentDecisions.current !== 'accepted' ||
		attachmentDecisions.duplicate !== 'duplicate-active-connection' ||
		attachmentDecisions.afterAttachmentLoss !== 'retired-attachment'
	) {
		throw new Error(`Gateway runtime VM probe returned invalid contract evidence: ${evidenceLine}`);
	}
	if (
		parsed.retirement.artifactEpochRetired !== true ||
		parsed.retirement.controlEndpointClosed !== true ||
		parsed.retirement.providerRuntimeClosed !== true ||
		parsed.retirement.socketRemoved !== true
	) {
		throw new Error(
			`Gateway runtime VM probe returned invalid retirement evidence: ${evidenceLine}`,
		);
	}
	return parsed as unknown as GatewayRuntimeVmBoundaryEvidence;
}

function renderGatewayRuntimeGuestProbe(): string {
	return String.raw`
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { chmod, lstat, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const evidencePrefix = ${JSON.stringify(gatewayRuntimeEvidencePrefix)};
const serviceProcessWaitMilliseconds = 30_000;
const packageEntrypointUrl = import.meta.resolve('@agent-vm/gateway-runtime');
const packageEntrypoint = fileURLToPath(packageEntrypointUrl);
const gatewayRuntime = await import(packageEntrypointUrl);
const gatewayRuntimeClient = await import('@agent-vm/agent-portal-sdk/gateway-runtime-client');
const configContracts = await import('@agent-vm/config-contracts');
const gatewayControlContracts = await import('@agent-vm/gateway-control-contracts');
assert.equal(
	'createManagedFrameworkChildSupervisor' in gatewayRuntime,
	false,
	'packaged @agent-vm/gateway-runtime must not expose framework child ownership',
);
assert.equal(
	typeof gatewayRuntimeClient.GatewayRuntimeClient,
	'function',
	'packaged @agent-vm/agent-portal-sdk is missing GatewayRuntimeClient',
);

const processUserId = process.getuid?.();
const processGroupId = process.getgid?.();
assert.equal(typeof processUserId, 'number');
assert.equal(typeof processGroupId, 'number');
assert.equal(processUserId, 0, 'Gateway runtime VM proof must run as root.');
assert.equal(processGroupId, 0, 'Gateway runtime VM proof must run with the root group.');
assert.ok(
	packageEntrypoint.startsWith('/opt/agent-vm/local-packages/'),
	'Gateway runtime must load from the packaged image overlay.',
);
assert.ok(
	packageEntrypoint.endsWith('/gateway-runtime/dist/index.js'),
	'Gateway runtime must resolve its packaged ESM entrypoint.',
);

const packageDirectory = path.dirname(path.dirname(packageEntrypoint));
const packageManifest = JSON.parse(await readFile(path.join(packageDirectory, 'package.json'), 'utf8'));
const packageBinRelativePath = packageManifest.bin?.['agent-vm-gateway-runtime'];
assert.equal(typeof packageBinRelativePath, 'string');
const packageBinPath = path.join(packageDirectory, packageBinRelativePath);
assert.ok(packageBinPath.endsWith('/gateway-runtime/dist/bin/gateway-runtime.js'));

const runtimeRoot = '/run/agent-vm/gateway-runtime';
const socketAddress = path.join(runtimeRoot, 'managed-plugin.sock');
const forbiddenProjectionRoots = [
	'/work',
	'/workspace',
	'/zone',
	'/home/hermes/.hermes/state',
];
for (const forbiddenRoot of forbiddenProjectionRoots) {
	assert.equal(
		runtimeRoot === forbiddenRoot || runtimeRoot.startsWith(forbiddenRoot + '/'),
		false,
		'Gateway runtime root must not be projected into ' + forbiddenRoot,
	);
}

const runtimeRootStatus = await stat(runtimeRoot);
assert.equal(runtimeRootStatus.isDirectory(), true);
assert.equal(runtimeRootStatus.mode & 0o777, 0o700);
assert.equal(runtimeRootStatus.uid, processUserId);
assert.equal(runtimeRootStatus.gid, processGroupId);

const mcpConfigPath = path.join(runtimeRoot, 'mcp.config.json');
const serviceConfigPath = path.join(runtimeRoot, 'service.json');
const { publicKey: controllerVerifierPublicKey } = generateKeyPairSync('ed25519');
const mcpConfig = { providers: {}, schemaVersion: 1 };
const toolPortalConfig = {
	agents: {
		main: { profile: 'main-profile' },
		research: { profile: 'research-profile' },
	},
	mode: 'managed',
	profiles: {
		'main-profile': { namespaces: {} },
		'research-profile': { namespaces: {} },
	},
	schemaVersion: 1,
};
const semanticSnapshot = gatewayControlContracts.deriveGatewayRuntimePortalSemanticSnapshot({
	agentProjections: [
		{
			agentId: 'main',
			frameworkIdentity: { kind: 'hermes', profileName: 'main' },
			toolPortalNamespaces: [],
			toolPortalProfileId: 'main-profile',
		},
		{
			agentId: 'research',
			frameworkIdentity: { kind: 'hermes', profileName: 'research' },
			toolPortalNamespaces: [],
			toolPortalProfileId: 'research-profile',
		},
	],
	mcpConfig,
	surfaceEligibilityByProfile: { 'main-profile': {}, 'research-profile': {} },
	toolPortalConfig,
});
const gatewayRuntimeToolPortalConfig =
	configContracts.createGatewayRuntimeManagedToolPortalConfig(toolPortalConfig);
const attachment = {
	attachmentGeneration: 7,
	clientKind: 'hermes-managed-plugin',
	configuredAgentIds: ['main', 'research'],
	frameworkEpoch: 'framework-epoch-current',
	gatewayEpoch: 'gateway-epoch-current',
	projectionCohortDigest: semanticSnapshot.projectionCohortDigest,
	protocolVersion: 1,
	runtimeEpoch: 'runtime-epoch-current',
	schemaVersion: 1,
};
const mainProjection = semanticSnapshot.agentProjections.main;
assert.ok(mainProjection, 'Gateway runtime VM proof is missing the main projection.');
await writeFile(mcpConfigPath, JSON.stringify(mcpConfig), { mode: 0o600 });
await writeFile(serviceConfigPath, JSON.stringify({
	artifactLimits: {
		maximumArtifactBytes: 1024,
		maximumArtifactCount: 8,
		maximumLifetimeMs: 60000,
		maximumTotalBytes: 8192,
	},
	attachment: {
		attachmentGeneration: attachment.attachmentGeneration,
		clientKind: attachment.clientKind,
		configuredAgentIds: attachment.configuredAgentIds,
		frameworkEpoch: attachment.frameworkEpoch,
		gatewayEpoch: attachment.gatewayEpoch,
		projectionCohortDigest: attachment.projectionCohortDigest,
		runtimeEpoch: attachment.runtimeEpoch,
	},
	controlEndpoint: {
		authority: {
			callerContextAgentAuthorityKeys: {
				main: 'main-authority-key',
				research: 'research-authority-key',
			},
			callerContextProofKey: 'caller-context-proof-key',
			verifierPublicKeyPem: controllerVerifierPublicKey.export({ format: 'pem', type: 'spki' }).toString(),
		},
		identity: {
			bootId: 'boot-vm',
			controllerEpoch: 'controller-epoch-vm',
			generationId: 'generation-vm',
			peerId: 'peer-vm',
			processEpoch: 'process-epoch-vm',
			zoneId: 'zone-vm',
		},
		listen: { host: '127.0.0.1', port: 18790 },
	},
	gatewayRuntimeInputRevision: gatewayControlContracts.deriveGatewayRuntimeInputRevision({
		mcpConfig,
		toolPortalConfig: gatewayRuntimeToolPortalConfig,
	}),
	mcpConfigPath,
	observability: { kind: 'disabled' },
	runtimeRoot,
	schemaVersion: 1,
	semanticSnapshot,
	serviceIdentity: {
		processEpoch: 'process-epoch-vm',
		role: 'tool-portal',
		serviceId: 'tool-portal-vm',
	},
	toolPortalConfig: gatewayRuntimeToolPortalConfig,
}), { mode: 0o600 });
await Promise.all([chmod(mcpConfigPath, 0o600), chmod(serviceConfigPath, 0o600)]);

const serviceProcess = spawn(packageBinPath, ['--config', serviceConfigPath], {
	stdio: ['ignore', 'pipe', 'pipe'],
});
serviceProcess.stdout.setEncoding('utf8');
serviceProcess.stderr.setEncoding('utf8');
let serviceStdout = '';
let serviceStderr = '';
serviceProcess.stdout.on('data', (chunk) => { serviceStdout += chunk; });
serviceProcess.stderr.on('data', (chunk) => { serviceStderr += chunk; });

async function waitForServiceLine(kind) {
	const parse = () => serviceStdout
		.split('\n')
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line))
		.find((value) => value.kind === kind);
	const immediate = parse();
	if (immediate !== undefined) return immediate;
	return await new Promise((resolve, reject) => {
		const signal = AbortSignal.timeout(serviceProcessWaitMilliseconds);
		const cleanup = () => {
			signal.removeEventListener('abort', onAbort);
			serviceProcess.stdout.off('data', onData);
			serviceProcess.off('exit', onExit);
		};
		const onAbort = () => {
			cleanup();
			reject(new Error('Timed out waiting for Gateway runtime ' + kind + '. stderr: ' + serviceStderr));
		};
		const onData = () => {
			const value = parse();
			if (value === undefined) return;
			cleanup();
			resolve(value);
		};
		const onExit = () => {
			cleanup();
			reject(new Error('Gateway runtime exited before ' + kind + '. stderr: ' + serviceStderr));
		};
		signal.addEventListener('abort', onAbort, { once: true });
		serviceProcess.stdout.on('data', onData);
		serviceProcess.once('exit', onExit);
	});
}

let activeClient;
let duplicateClient;
let postLossClient;
let duplicateDecision;
let postLossDecision;
let readiness;
let retirement;
try {
	readiness = await waitForServiceLine('tool-portal-role-readiness');
	assert.equal(readiness.uds.publication.status, 'published');
	assert.equal(readiness.uds.attachment.status, 'awaiting-attachment');
	activeClient = new gatewayRuntimeClient.GatewayRuntimeClient({
		attachment,
		socketPath: socketAddress,
		startupRetryPolicy: { maxAttempts: 1 },
	});
	duplicateClient = new gatewayRuntimeClient.GatewayRuntimeClient({
		attachment,
		socketPath: socketAddress,
		startupRetryPolicy: { maxAttempts: 1 },
	});
	postLossClient = new gatewayRuntimeClient.GatewayRuntimeClient({
		attachment: { ...attachment, attachmentGeneration: 6 },
		socketPath: socketAddress,
		startupRetryPolicy: { maxAttempts: 1 },
	});
	await activeClient.connect();
	try {
		await duplicateClient.connect();
	} catch (error) {
		duplicateDecision = error?.code;
	}
	const listResult = await activeClient.portal.list(
		{ requests: [{ id: 'vm-list', limit: 20, namespaces: [] }] },
		{
			trustedContext: {
				correlation: { sessionId: 'session-vm' },
				principal: {
					agentId: 'main',
					frameworkIdentity: { kind: 'hermes', profileName: 'main' },
					profileAssignmentRevision: mainProjection.profileAssignmentRevision,
					toolPortalProfileId: 'main-profile',
				},
				requester: { authenticatedSubjectId: 'subject-vm' },
			},
		},
	);
	assert.equal(listResult.ok, true);
	assert.equal(duplicateDecision, 'duplicate-active-connection');
	const socketStatus = await lstat(socketAddress);
	assert.equal(socketStatus.isSocket(), true);
	assert.equal(socketStatus.mode & 0o777, 0o600);
	const mountPoints = (await readFile('/proc/self/mountinfo', 'utf8'))
		.trim()
		.split('\n')
		.map((line) => line.split(' ')[4]);
	assert.equal(
		mountPoints.includes(runtimeRoot) || mountPoints.includes(socketAddress),
		false,
		'Runtime root/socket must remain VM-rootfs-local, not mounted.',
	);
	await activeClient.disconnect();
	try {
		await postLossClient.connect();
	} catch (error) {
		postLossDecision = error?.code;
	}
	assert.equal(postLossDecision, 'retired-attachment');
	serviceProcess.kill('SIGTERM');
	retirement = await waitForServiceLine('retired');
	if (serviceProcess.exitCode === null) {
		await once(serviceProcess, 'exit', {
			signal: AbortSignal.timeout(serviceProcessWaitMilliseconds),
		});
	}
	assert.equal(serviceProcess.exitCode, 0);
	assert.equal(serviceStderr, '');
} finally {
	await Promise.allSettled([
		activeClient?.disconnect(),
		duplicateClient?.disconnect(),
		postLossClient?.disconnect(),
	]);
	if (serviceProcess.exitCode === null) serviceProcess.kill('SIGKILL');
}

process.stdout.write(
	evidencePrefix +
		JSON.stringify({
			attachmentDecisions: {
				current: 'accepted',
				duplicate: duplicateDecision,
				afterAttachmentLoss: postLossDecision,
			},
			frameworkChildOwnershipAbsent:
				!('createManagedFrameworkChildSupervisor' in gatewayRuntime),
			packageBinPath,
			packageEntrypoint,
			processGroupId,
			processUserId,
			readinessRevision: readiness.semanticRevision,
			retirement: {
				artifactEpochRetired: retirement.artifactEpochRetired,
				controlEndpointClosed: retirement.controlEndpointClosed,
				providerRuntimeClosed: retirement.providerRuntimeClosed,
				socketRemoved: retirement.uds.socketRemoved,
			},
			runtimeRoot,
			runtimeRootMode: runtimeRootStatus.mode & 0o777,
			runtimeRootOwnerGroupId: runtimeRootStatus.gid,
			runtimeRootOwnerUserId: runtimeRootStatus.uid,
			socketAddress,
			socketIsMounted: false,
			socketIsUnixDomainSocket: true,
		}) +
		'\n',
);
`;
}

describeLiveVmIntegration('live e2e: Gateway runtime stock-VM boundary', () => {
	it('launches the packed service as root and proves its real UDS lifecycle', async () => {
		// Arrange
		const fixture = await startManagedGatewayImageBootFixture({
			omittedInputFileName: 'tool-portal-service.json',
			sessionLabel: 'gateway-runtime-vm-boundary',
		});
		try {
			// Act
			const runtimeDirectorySetup = await fixture.vm.exec([
				'install',
				'-d',
				'-m',
				'0700',
				'/run/agent-vm/gateway-runtime',
			]);
			if (runtimeDirectorySetup.exitCode !== 0) {
				throw new Error(
					`Gateway runtime directory setup failed with exit ${String(runtimeDirectorySetup.exitCode)}.\nstdout:\n${runtimeDirectorySetup.stdout}\nstderr:\n${runtimeDirectorySetup.stderr}`,
				);
			}
			const guestProbeResult = await fixture.vm.exec(
				[
					'/bin/sh',
					'-c',
					'exec env PATH=/pnpm:/usr/local/bin:/usr/bin:/bin node --input-type=module',
				],
				{
					cwd: '/opt/agent-vm/local-packages',
					stdin: renderGatewayRuntimeGuestProbe(),
				},
			);

			// Assert
			if (guestProbeResult.exitCode !== 0) {
				throw new Error(
					`Gateway runtime stock-VM probe failed with exit ${String(guestProbeResult.exitCode)}.\nstdout:\n${guestProbeResult.stdout}\nstderr:\n${guestProbeResult.stderr}`,
				);
			}
			const evidence = parseGatewayRuntimeVmBoundaryEvidence(guestProbeResult.stdout);
			expect(evidence).toMatchObject({
				attachmentDecisions: {
					afterAttachmentLoss: 'retired-attachment',
					current: 'accepted',
					duplicate: 'duplicate-active-connection',
				},
				frameworkChildOwnershipAbsent: true,
				readinessRevision: expect.stringMatching(/^portal-admission:[a-f0-9]{64}$/u),
				retirement: {
					artifactEpochRetired: true,
					controlEndpointClosed: true,
					providerRuntimeClosed: true,
					socketRemoved: true,
				},
				runtimeRoot: '/run/agent-vm/gateway-runtime',
				runtimeRootMode: 0o700,
				socketAddress: '/run/agent-vm/gateway-runtime/managed-plugin.sock',
				socketIsMounted: false,
				socketIsUnixDomainSocket: true,
			});
			expect(evidence.processUserId).toBe(0);
			expect(evidence.processGroupId).toBe(0);
			expect(evidence.runtimeRootOwnerUserId).toBe(evidence.processUserId);
			expect(evidence.runtimeRootOwnerGroupId).toBe(evidence.processGroupId);
			expect(evidence.packageEntrypoint).toMatch(/^\/opt\/agent-vm\/local-packages\//u);
			expect(evidence.packageEntrypoint).toMatch(/\/gateway-runtime\/dist\/index\.js$/u);
			expect(evidence.packageBinPath).toMatch(
				/\/gateway-runtime\/dist\/bin\/gateway-runtime\.js$/u,
			);
		} finally {
			await fixture.close();
		}
	}, 900_000);
});
