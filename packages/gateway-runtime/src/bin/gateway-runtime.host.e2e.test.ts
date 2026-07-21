import {
	execFile as execFileCallback,
	spawn,
	type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
	GatewayRuntimeClient,
	type GatewayRuntimeAttachmentMetadata,
} from '@agent-vm/agent-portal-sdk/gateway-runtime-client';
import { managedToolPortalConfigSchema, mcpConfigSchema } from '@agent-vm/config-contracts';
import { deriveGatewayRuntimePortalSemanticSnapshot } from '@agent-vm/gateway-control-contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execFile = promisify(execFileCallback);
const LOCAL_PACKAGE_NAMES = [
	'agent-portal-sdk',
	'config-contracts',
	'control-protocol-contracts',
	'controller-execution-contracts',
	'gateway-control-contracts',
	'secret-management',
	'mcp-portal',
	'tool-portal',
	'gateway-runtime',
] as const;
const PROCESS_WAIT_MILLISECONDS = 30_000;

interface PackedGatewayRuntimeFixture {
	readonly binPath: string;
	readonly root: string;
	readonly runtimeBinSource: string;
	readonly runtimeLibrarySource: string;
	readonly runtimeLibraryTypes: string;
	readonly runtimeTarballSha256: string;
}

interface StartedGatewayRuntimeProcess {
	readonly child: ChildProcessWithoutNullStreams;
	readonly stderr: { value: string };
	readonly stdout: { value: string };
}

let fixture: PackedGatewayRuntimeFixture | undefined;
let startedProcess: StartedGatewayRuntimeProcess | undefined;

async function runCommand(command: string, arguments_: readonly string[]): Promise<void> {
	try {
		await execFile(command, arguments_, {
			cwd: process.cwd(),
			env: process.env,
			maxBuffer: 16 * 1024 * 1024,
			timeout: 120_000,
		});
	} catch (error: unknown) {
		const diagnostic =
			typeof error === 'object' &&
			error !== null &&
			'stderr' in error &&
			typeof error.stderr === 'string'
				? error.stderr
				: String(error);
		throw new Error(`Command ${command} failed: ${diagnostic}`, { cause: error });
	}
}

async function sha256File(filePath: string): Promise<string> {
	return createHash('sha256')
		.update(await readFile(filePath))
		.digest('hex');
}

async function preparePackedGatewayRuntimeFixture(): Promise<PackedGatewayRuntimeFixture> {
	const root = await mkdtemp(path.join(os.tmpdir(), 'gr-pack-'));
	const packDirectory = path.join(root, 'pack');
	const consumerDirectory = path.join(root, 'consumer');
	await Promise.all([mkdir(packDirectory), mkdir(consumerDirectory)]);

	await Promise.all(
		LOCAL_PACKAGE_NAMES.map(async (packageName) =>
			runCommand('pnpm', [
				'--dir',
				path.join(process.cwd(), 'packages', packageName),
				'pack',
				'--pack-destination',
				packDirectory,
				'--config.ignore-scripts=true',
			]),
		),
	);
	const tarballPaths = (await readdir(packDirectory))
		.filter((fileName) => fileName.endsWith('.tgz'))
		.map((fileName) => path.join(packDirectory, fileName));
	if (tarballPaths.length !== LOCAL_PACKAGE_NAMES.length) {
		throw new Error(
			`Expected ${String(LOCAL_PACKAGE_NAMES.length)} local package tarballs; found ${String(tarballPaths.length)}.`,
		);
	}
	const dependencies = Object.fromEntries(
		LOCAL_PACKAGE_NAMES.map((packageName) => {
			const tarballPath = tarballPaths.find((candidatePath) =>
				path.basename(candidatePath).startsWith(`agent-vm-${packageName}-`),
			);
			if (tarballPath === undefined) {
				throw new Error(`Packed tarball for @agent-vm/${packageName} was not found.`);
			}
			return [`@agent-vm/${packageName}`, `file:${tarballPath}`];
		}),
	);
	await writeFile(
		path.join(consumerDirectory, 'package.json'),
		JSON.stringify({
			dependencies,
			name: 'gateway-runtime-packed-host-fixture',
			pnpm: { overrides: dependencies },
			private: true,
			type: 'module',
		}),
		'utf8',
	);
	await runCommand('pnpm', [
		'--dir',
		consumerDirectory,
		'install',
		'--prefer-offline',
		'--config.ignore-scripts=true',
	]);
	const packageDirectory = path.join(
		consumerDirectory,
		'node_modules',
		'@agent-vm',
		'gateway-runtime',
	);
	const packageManifest = JSON.parse(
		await readFile(path.join(packageDirectory, 'package.json'), 'utf8'),
	) as { readonly bin?: Readonly<Record<string, string>> };
	const binRelativePath = packageManifest.bin?.['agent-vm-gateway-runtime'];
	if (binRelativePath === undefined) {
		throw new Error('Packed Gateway runtime manifest does not expose its service bin.');
	}
	const runtimeTarball = tarballPaths.find((tarballPath) =>
		path.basename(tarballPath).includes('gateway-runtime-'),
	);
	if (runtimeTarball === undefined) {
		throw new Error('Packed Gateway runtime tarball was not found.');
	}
	return {
		binPath: path.join(packageDirectory, binRelativePath),
		root,
		runtimeBinSource: await readFile(path.join(packageDirectory, binRelativePath), 'utf8'),
		runtimeLibrarySource: await readFile(path.join(packageDirectory, 'dist', 'index.js'), 'utf8'),
		runtimeLibraryTypes: await readFile(path.join(packageDirectory, 'dist', 'index.d.ts'), 'utf8'),
		runtimeTarballSha256: await sha256File(runtimeTarball),
	};
}

async function writeProtectedRuntimeConfig(root: string): Promise<{
	readonly attachment: GatewayRuntimeAttachmentMetadata;
	readonly configPath: string;
	readonly profileAssignmentRevision: string;
	readonly runtimeRoot: string;
}> {
	const runtimeRoot = path.join(root, 'run');
	await mkdir(runtimeRoot, { mode: 0o700 });
	const mcpConfigPath = path.join(runtimeRoot, 'mcp.config.json');
	const mcpConfig = mcpConfigSchema.parse({ providers: {}, schemaVersion: 1 });
	const toolPortalConfig = managedToolPortalConfigSchema.parse({
		agents: {
			'agent-a': { profile: 'profile-a' },
			'agent-b': { profile: 'profile-b' },
		},
		mode: 'managed',
		profiles: {
			'profile-a': { namespaces: {} },
			'profile-b': { namespaces: {} },
		},
		schemaVersion: 1,
	});
	const semanticSnapshot = deriveGatewayRuntimePortalSemanticSnapshot({
		agentProjections: [
			{
				agentId: 'agent-a',
				frameworkIdentity: { kind: 'hermes', profileName: 'agent-a-profile' },
				toolPortalProfileId: 'profile-a',
			},
			{
				agentId: 'agent-b',
				frameworkIdentity: { kind: 'hermes', profileName: 'agent-b-profile' },
				toolPortalProfileId: 'profile-b',
			},
		],
		mcpConfig,
		surfaceEligibilityByProfile: { 'profile-a': {}, 'profile-b': {} },
		toolPortalConfig,
	});
	await writeFile(mcpConfigPath, JSON.stringify(mcpConfig), {
		mode: 0o600,
	});
	const attachment = {
		attachmentGeneration: 1,
		clientKind: 'hermes-managed-plugin',
		configuredAgentIds: ['agent-a', 'agent-b'],
		frameworkEpoch: 'framework-epoch-packed',
		gatewayEpoch: 'gateway-epoch-packed',
		protocolVersion: 1,
		projectionCohortDigest: semanticSnapshot.projectionCohortDigest,
		runtimeEpoch: 'runtime-epoch-packed',
		schemaVersion: 1,
	} as const satisfies GatewayRuntimeAttachmentMetadata;
	const configPath = path.join(runtimeRoot, 'service.json');
	const { publicKey } = generateKeyPairSync('ed25519');
	await writeFile(
		configPath,
		JSON.stringify({
			artifactLimits: {
				maximumArtifactBytes: 1_024,
				maximumArtifactCount: 8,
				maximumLifetimeMs: 60_000,
				maximumTotalBytes: 8_192,
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
						'agent-a': 'agent-a-authority-key',
						'agent-b': 'agent-b-authority-key',
					},
					callerContextProofKey: 'caller-context-proof-key',
					verifierPublicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }),
				},
				identity: {
					bootId: 'boot-packed',
					controllerEpoch: 'controller-epoch-packed',
					generationId: 'generation-packed',
					peerId: 'peer-packed',
					processEpoch: 'process-epoch-packed',
					zoneId: 'zone-packed',
				},
				listen: { host: '127.0.0.1', port: 0 },
			},
			mcpConfigPath,
			observability: { kind: 'disabled' },
			runtimeRoot,
			schemaVersion: 1,
			semanticSnapshot,
			serviceIdentity: {
				processEpoch: 'process-epoch-packed',
				role: 'tool-portal',
				serviceId: 'tool-portal-packed',
			},
			toolPortalConfig,
		}),
		{ mode: 0o600 },
	);
	await Promise.all([chmod(configPath, 0o600), chmod(mcpConfigPath, 0o600)]);
	const agentProjection = semanticSnapshot.agentProjections['agent-a'];
	if (agentProjection === undefined) throw new Error('Missing packed agent-a projection.');
	return {
		attachment,
		configPath,
		profileAssignmentRevision: agentProjection.profileAssignmentRevision,
		runtimeRoot,
	};
}

function startGatewayRuntimeProcess(props: {
	readonly binPath: string;
	readonly configPath: string;
}): StartedGatewayRuntimeProcess {
	const stderr = { value: '' };
	const stdout = { value: '' };
	const child = spawn(props.binPath, ['--config', props.configPath], {
		env: process.env,
		stdio: ['pipe', 'pipe', 'pipe'],
	});
	child.stderr.setEncoding('utf8');
	child.stdout.setEncoding('utf8');
	child.stderr.on('data', (chunk: string) => {
		stderr.value += chunk;
	});
	child.stdout.on('data', (chunk: string) => {
		stdout.value += chunk;
	});
	return { child, stderr, stdout };
}

async function waitForJsonLine(props: {
	readonly process: StartedGatewayRuntimeProcess;
	readonly predicate: (value: Readonly<Record<string, unknown>>) => boolean;
}): Promise<Readonly<Record<string, unknown>>> {
	const parseMatchingLine = (): Readonly<Record<string, unknown>> | undefined => {
		for (const line of props.process.stdout.value.split('\n')) {
			if (line.length === 0) continue;
			const value = JSON.parse(line) as unknown;
			if (
				typeof value === 'object' &&
				value !== null &&
				!Array.isArray(value) &&
				props.predicate(value as Readonly<Record<string, unknown>>)
			) {
				return value as Readonly<Record<string, unknown>>;
			}
		}
		return undefined;
	};
	const immediate = parseMatchingLine();
	if (immediate !== undefined) return immediate;
	return await new Promise<Readonly<Record<string, unknown>>>((resolve, reject) => {
		const timeoutSignal = AbortSignal.timeout(PROCESS_WAIT_MILLISECONDS);
		const onTimeout = (): void => {
			cleanup();
			reject(
				new Error(
					`Packed Gateway runtime output timed out. stdout=${props.process.stdout.value} stderr=${props.process.stderr.value}`,
				),
			);
		};
		const cleanup = (): void => {
			timeoutSignal.removeEventListener('abort', onTimeout);
			props.process.child.stdout.off('data', onData);
			props.process.child.off('exit', onExit);
		};
		const onData = (): void => {
			const value = parseMatchingLine();
			if (value === undefined) return;
			cleanup();
			resolve(value);
		};
		const onExit = (): void => {
			cleanup();
			reject(
				new Error(
					`Packed Gateway runtime exited before expected output. stderr=${props.process.stderr.value}`,
				),
			);
		};
		props.process.child.stdout.on('data', onData);
		props.process.child.once('exit', onExit);
		timeoutSignal.addEventListener('abort', onTimeout, { once: true });
	});
}

async function stopStartedProcess(): Promise<void> {
	if (startedProcess === undefined || startedProcess.child.exitCode !== null) return;
	startedProcess.child.kill('SIGTERM');
	if (startedProcess.child.exitCode === null) {
		await once(startedProcess.child, 'exit', {
			signal: AbortSignal.timeout(PROCESS_WAIT_MILLISECONDS),
		});
	}
}

beforeAll(async () => {
	fixture = await preparePackedGatewayRuntimeFixture();
}, 180_000);

afterAll(async () => {
	await stopStartedProcess();
	if (fixture !== undefined) await rm(fixture.root, { force: true, recursive: true });
});

describe('packed Gateway runtime executable', () => {
	it('starts the manifest bin, serves the real SDK, and retires with protected evidence', async () => {
		if (fixture === undefined) throw new Error('Packed Gateway runtime fixture was not prepared.');
		// Arrange
		const runtime = await writeProtectedRuntimeConfig(fixture.root);
		startedProcess = startGatewayRuntimeProcess({
			binPath: fixture.binPath,
			configPath: runtime.configPath,
		});

		// Act
		const readiness = await waitForJsonLine({
			predicate: (value) => value['kind'] === 'tool-portal-role-readiness',
			process: startedProcess,
		});
		const socketPath = path.join(runtime.runtimeRoot, 'managed-plugin.sock');
		const client = new GatewayRuntimeClient({
			attachment: runtime.attachment,
			socketPath,
			startupRetryPolicy: { maxAttempts: 1 },
		});
		await client.connect();
		const listResult = await client.portal.list(
			{ requests: [{ id: 'packed-list', limit: 20, namespaces: [] }] },
			{
				trustedContext: {
					correlation: { sessionId: 'session-packed' },
					principal: {
						agentId: 'agent-a',
						frameworkIdentity: { kind: 'hermes', profileName: 'agent-a-profile' },
						profileAssignmentRevision: runtime.profileAssignmentRevision,
						toolPortalProfileId: 'profile-a',
					},
					requester: { authenticatedSubjectId: 'subject-a' },
				},
			},
		);
		await client.disconnect();

		const replacementClient = new GatewayRuntimeClient({
			attachment: runtime.attachment,
			socketPath,
			startupRetryPolicy: { maxAttempts: 1 },
		});
		await expect(replacementClient.connect()).rejects.toMatchObject({ code: 'retired-attachment' });
		await replacementClient.disconnect();
		startedProcess.child.kill('SIGTERM');
		const retirement = await waitForJsonLine({
			predicate: (value) => value['kind'] === 'retired',
			process: startedProcess,
		});
		if (startedProcess.child.exitCode === null) {
			await once(startedProcess.child, 'exit', {
				signal: AbortSignal.timeout(PROCESS_WAIT_MILLISECONDS),
			});
		}

		// Assert
		const finalReadinessEvidence = JSON.parse(
			await readFile(path.join(runtime.runtimeRoot, 'tool-portal.readiness.json'), 'utf8'),
		) as unknown;
		expect(fixture.runtimeTarballSha256).toMatch(/^[0-9a-f]{64}$/u);
		for (const packedProductionSource of [
			fixture.runtimeBinSource,
			fixture.runtimeLibrarySource,
			fixture.runtimeLibraryTypes,
		]) {
			expect(packedProductionSource).not.toContain('createGatewayRuntimeUnavailableApprovalPort');
			expect(packedProductionSource).not.toContain('createGatewayRuntimeUnavailableBackendPort');
			expect(packedProductionSource).not.toContain(
				'rejectUnavailableGatewayRuntimeSandboxDispatch',
			);
		}
		expect(fixture.runtimeBinSource).not.toContain("backendKind: 'controller_host_action'");
		expect(readiness).toMatchObject({
			controlEndpoint: {
				identity: { processEpoch: 'process-epoch-packed', zoneId: 'zone-packed' },
				listener: { host: '127.0.0.1' },
			},
			providerRevision: expect.stringMatching(/^provider:[a-f0-9]{64}$/u),
			semanticRevision: expect.stringMatching(/^portal-admission:[a-f0-9]{64}$/u),
			serviceIdentity: { role: 'tool-portal', serviceId: 'tool-portal-packed' },
			uds: {
				attachment: {
					expected: {
						clientKind: 'hermes-managed-plugin',
						configuredAgentIds: ['agent-a', 'agent-b'],
					},
					status: 'awaiting-attachment',
				},
				publication: { status: 'published' },
			},
		});
		expect(finalReadinessEvidence).toMatchObject({
			kind: 'tool-portal-role-readiness',
			uds: {
				attachment: { status: 'retired' },
				publication: { status: 'retired' },
			},
		});
		expect(listResult).toMatchObject({ ok: true });
		expect(retirement).toMatchObject({
			artifactEpochRetired: true,
			controlEndpointClosed: true,
			providerRuntimeClosed: true,
			uds: { socketRemoved: true },
		});
		expect(
			(await stat(path.join(runtime.runtimeRoot, 'tool-portal.readiness.json'))).mode & 0o777,
		).toBe(0o600);
		expect(
			(await stat(path.join(runtime.runtimeRoot, 'tool-portal.retirement.json'))).mode & 0o777,
		).toBe(0o600);
		expect(startedProcess.stderr.value).toBe('');
	});
});
