import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ManagedVm } from '@agent-vm/managed-vm';
import { afterEach, describe, expect, it } from 'vitest';

import { imageArtifactFixtureFileContent } from '../../../../scripts/test-fixtures/image-artifact-fixture.js';
import { computeFingerprintFromConfigPath } from '../build/gondolin-image-builder.js';
import {
	managedVmImageAssetFileNames,
	type ManagedGatewayImageBootProjection,
} from '../build/gondolin-managed-vm-build-tooling.js';
import {
	generateManagedDockerfile,
	loadManagedImageOverlay,
	resolveManagedImageRelease,
	type GenerateManagedDockerfileResult,
} from '../build/managed-image-dockerfile.js';
import {
	configuredImageSelectionRecordPath,
	readPreparedManagedVmImage,
	writePreparedManagedVmImage,
} from '../build/prepared-gondolin-image-cache.js';
import {
	sharedImageCacheDirForSystemConfig,
	type LoadedSystemConfig,
} from '../config/system-config.js';
import type { GatewayVmLifecycleAuthority } from '../controller/vm-ownership/gateway-vm-lifecycle-authority.js';
import type {
	GatewayZoneDestroyResult,
	ManagedGatewayZoneStartResult,
	StartGatewayZoneOptions,
} from '../gateway/gateway-zone-support.js';
import { createManagedGatewayBootContract } from '../gateway/managed-gateway-boot-contract.js';
import {
	TEST_SSH_SERVER_HOST_KEY,
	createManagedExecProcessStub,
} from '../testing/managed-vm-test-helpers.js';
import {
	collectE2eDockerImageTags,
	findReusableGatewayImageDirectory,
	packLocalAgentVmPackageTarball,
	prepareGatewayE2eProjectImages,
	removeE2eDockerImagesForSystemConfig,
	removeE2eTempRoot,
	reserveE2eTcpPoolPortRange,
	resolveLocalPackagePackArgs,
	seedGatewayImageCacheIfAvailable,
	shouldCleanupE2eDockerImages,
	useLocalToolVmMcpPortalPackage,
} from './e2e-harness.js';
import { scaffoldHermesE2eProject } from './hermes-e2e-harness.js';

const temporaryRoots: string[] = [];

function e2eSelectionRecordPath(
	systemConfig: LoadedSystemConfig,
	family: 'gateway' | 'toolVm',
	profileName: string,
): string {
	return configuredImageSelectionRecordPath({
		deploymentGeneratedDir: path.join(systemConfig.storageRootDir, 'generated'),
		family,
		profileName,
	});
}

const testManagedGatewayBootContract = createManagedGatewayBootContract({
	bootEntry: 'hermes-gateway',
	configurationInputPath: '/run/agent-vm/managed-gateway/framework-service.json',
	environmentInputPath: '/run/agent-vm/managed-gateway/framework.environment.sh',
	framework: 'hermes',
	ingress: { guestPort: 18_789, kind: 'framework-http' },
	logIdentity: {
		guestPath: '/var/log/agent-vm/hermes-service.log',
		serviceName: 'agent-vm-hermes-test',
	},
	readiness: { guestPort: 18_789, kind: 'framework-http', path: '/readyz' },
	role: 'framework-service',
});

describe('Hermes E2E project cache and path invariants', () => {
	it('uses the shared E2E cache instead of a project-local image cache', async () => {
		const previousCacheRoot = process.env.AGENT_VM_E2E_CACHE_DIR;
		const sharedCacheRoot = await createTemporaryRoot('agent-vm-shared-e2e-cache-');
		process.env.AGENT_VM_E2E_CACHE_DIR = sharedCacheRoot;
		try {
			const project = await scaffoldHermesE2eProject({
				agents: ['main'],
				architecture: 'aarch64',
				prefix: 'hermes-cache-e2e-',
				zoneId: 'hermes-e2e',
			});
			temporaryRoots.push(project.tempRoot);
			expect(project.systemConfig.cacheDir).toBe(path.join(sharedCacheRoot, 'hermes'));
			expect(project.systemConfig.cacheDir).not.toContain(project.tempRoot);
		} finally {
			if (previousCacheRoot === undefined) {
				delete process.env.AGENT_VM_E2E_CACHE_DIR;
			} else {
				process.env.AGENT_VM_E2E_CACHE_DIR = previousCacheRoot;
			}
		}
	});

	it('keeps generated runtime and state paths inside the owned temp project', async () => {
		const project = await scaffoldHermesE2eProject({
			agents: ['main'],
			architecture: 'aarch64',
			prefix: 'hermes-owned-paths-e2e-',
			zoneId: 'hermes-e2e',
		});
		temporaryRoots.push(project.tempRoot);
		const zone = project.systemConfig.zones[0];
		if (zone === undefined) {
			throw new Error('Expected Hermes E2E zone.');
		}
		expect(path.resolve(project.systemConfig.storageRootDir)).toContain(
			path.resolve(project.tempRoot),
		);
		expect(path.resolve(zone.gateway.stateDir)).toContain(path.resolve(project.tempRoot));
		expect(path.resolve(zone.gateway.config)).toContain(path.resolve(project.tempRoot));
	});

	it('computes the same Hermes gateway image fingerprint for equivalent temp deployments', async () => {
		const firstProject = await scaffoldHermesE2eProject({
			agents: ['main'],
			architecture: 'aarch64',
			prefix: 'hermes-fingerprint-e2e-',
			zoneId: 'hermes-e2e',
		});
		const secondProject = await scaffoldHermesE2eProject({
			agents: ['main'],
			architecture: 'aarch64',
			prefix: 'hermes-fingerprint-e2e-',
			zoneId: 'hermes-e2e',
		});
		temporaryRoots.push(firstProject.tempRoot, secondProject.tempRoot);
		const firstProfile = firstProject.systemConfig.imageProfiles.gateways.hermes;
		const secondProfile = secondProject.systemConfig.imageProfiles.gateways.hermes;
		if (firstProfile === undefined || secondProfile === undefined) {
			throw new Error('Expected Hermes image profiles.');
		}
		const managedGatewayBoot = {
			frameworkBootEntry: 'hermes-framework-service',
			kind: 'managed-gateway-exact-two-role',
		} as const;
		await expect(
			computeFingerprintFromConfigPath(firstProfile.buildConfig, { managedGatewayBoot }),
		).resolves.toBe(
			await computeFingerprintFromConfigPath(secondProfile.buildConfig, { managedGatewayBoot }),
		);
	});
});
const testManagedGatewayExpectedCohort = {
	controlIdentity: {
		controllerEpoch: 'controller-epoch-smoke',
		generationId: 'gateway-generation-smoke',
		peerId: 'tool-portal-control:smoke',
		processEpoch: 'tool-portal-process-smoke',
	},
	fence: {
		controllerEpoch: 'controller-epoch-smoke',
		gatewayEpoch: 'gateway-generation-smoke',
		vmId: 'vm-smoke-test',
		zoneId: 'smoke',
	},
	frameworkIdentity: {
		attachmentGeneration: 1,
		clientKind: 'hermes-managed-plugin',
		configuredAgentIds: ['smoke'],
		frameworkEpoch: 'hermes-framework-smoke',
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
			guestPort: 18_789,
			kind: 'framework-root',
			prefix: '/',
			stripPrefix: false,
		},
	},
	providerRevision: 'provider-revision-smoke',
	requiredBackendRevision: 'required-backends-smoke',
	semanticRevision: 'semantic-revision-smoke',
	toolPortalIdentity: {
		processEpoch: 'tool-portal-process-smoke',
		role: 'tool-portal',
		runtimeEpoch: 'tool-portal-runtime-smoke',
		serviceId: 'tool-portal-service-smoke',
	},
	udsIdentity: {
		frameworkEpoch: 'hermes-framework-smoke',
		gatewayEpoch: 'gateway-generation-smoke',
		runtimeEpoch: 'tool-portal-runtime-smoke',
		socketPath: '/run/agent-vm/gateway-runtime/managed-plugin.sock',
	},
} satisfies ManagedGatewayZoneStartResult['expectedCohort'];

async function createTemporaryRoot(prefix: string): Promise<string> {
	const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	temporaryRoots.push(temporaryRoot);
	return temporaryRoot;
}

afterEach(async () => {
	await Promise.all(
		temporaryRoots.splice(0).map(async (temporaryRoot) => {
			await removeE2eTempRoot(temporaryRoot);
		}),
	);
});

describe('reserveE2eTcpPoolPortRange', () => {
	it('releases an unlisted owner sentinel without deleting its directory', async () => {
		const unlistedTempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'unlisted-hermes-e2e-'));
		const reusableTempRoot = await createTemporaryRoot('agent-vm-gateway-e2e-project-');
		try {
			const initialBasePort = await reserveE2eTcpPoolPortRange(4, unlistedTempRoot);
			await removeE2eTempRoot(unlistedTempRoot);
			await expect(fs.access(unlistedTempRoot)).resolves.toBeUndefined();

			const reusedBasePort = await reserveE2eTcpPoolPortRange(4, reusableTempRoot);
			expect(reusedBasePort).toBe(initialBasePort);
		} finally {
			await removeE2eTempRoot(reusableTempRoot);
			await fs.rm(unlistedTempRoot, { force: true, recursive: true });
		}
	});

	it('retains disjoint dedicated slots across E2E processes', async () => {
		const childTempRoot = await createTemporaryRoot('agent-vm-gateway-e2e-project-');
		const parentTempRoot = await createTemporaryRoot('agent-vm-gateway-e2e-project-');
		const maximumRangeTempRoot = await createTemporaryRoot('agent-vm-gateway-e2e-project-');
		const childSource = `
			import { removeE2eTempRoot, reserveE2eTcpPoolPortRange } from './packages/agent-vm/src/integration-tests/e2e-harness.ts';
			const ownerTempRoot = ${JSON.stringify(childTempRoot)};
			const basePort = await reserveE2eTcpPoolPortRange(4, ownerTempRoot);
			process.stdout.write(String(basePort) + '\\n');
			process.stdin.resume();
			await new Promise((resolve) => process.stdin.once('end', resolve));
			await removeE2eTempRoot(ownerTempRoot);
		`;
		const child = spawn(
			process.execPath,
			['--import', 'tsx', '--input-type=module', '--eval', childSource],
			{
				cwd: process.cwd(),
				stdio: ['pipe', 'pipe', 'pipe'],
			},
		);
		const childBasePortPromise = new Promise<number>((resolve, reject) => {
			let stdout = '';
			child.once('error', reject);
			child.once('exit', (exitCode) => {
				reject(new Error(`E2E TCP pool child exited before reporting a port: ${String(exitCode)}`));
			});
			child.stdout.on('data', (chunk: Buffer) => {
				stdout += chunk.toString('utf8');
				const newlineIndex = stdout.indexOf('\n');
				if (newlineIndex < 0) return;
				const firstLine = stdout.slice(0, newlineIndex).trim();
				if (firstLine !== undefined && /^\d+$/u.test(firstLine)) resolve(Number(firstLine));
			});
		});
		const childExitPromise = new Promise<void>((resolve, reject) => {
			child.once('error', reject);
			child.once('exit', (exitCode, signal) => {
				if (exitCode === 0) {
					resolve();
					return;
				}
				reject(
					new Error(
						`E2E TCP pool child exited unsuccessfully: code=${String(exitCode)} signal=${String(signal)}`,
					),
				);
			});
		});
		let childBasePort: number;
		try {
			childBasePort = await childBasePortPromise;
			const parentBasePort = await reserveE2eTcpPoolPortRange(4, parentTempRoot);
			const maximumRangeBasePort = await reserveE2eTcpPoolPortRange(256, maximumRangeTempRoot);

			expect(childBasePort).toBeGreaterThanOrEqual(30_001);
			expect(parentBasePort).not.toBe(childBasePort);
			expect(maximumRangeBasePort + 255).toBeLessThanOrEqual(45_000);
		} finally {
			child.stdin.end();
			await childExitPromise;
			await Promise.all([
				removeE2eTempRoot(parentTempRoot),
				removeE2eTempRoot(maximumRangeTempRoot),
			]);
		}
		const reusedTempRoot = await createTemporaryRoot('agent-vm-gateway-e2e-project-');
		const reusedBasePort = await reserveE2eTcpPoolPortRange(4, reusedTempRoot);
		expect(reusedBasePort).toBe(childBasePort);
		await removeE2eTempRoot(reusedTempRoot);
	});
});

describe('resolveLocalPackagePackArgs', () => {
	it('packs e2e overlay tarballs without running package prepack scripts', () => {
		expect(resolveLocalPackagePackArgs('/tmp/agent-vm-pack')).toEqual([
			'pack',
			'--pack-destination',
			'/tmp/agent-vm-pack',
			'--config.ignore-scripts=true',
		]);
	});

	it('reuses a producer tarball when generated dist output differs between jobs', async () => {
		const previousCacheRoot = process.env.AGENT_VM_E2E_CACHE_DIR;
		const temporaryRoot = await createTemporaryRoot('agent-vm-e2e-package-cache-');
		const repoRoot = path.join(temporaryRoot, 'repo');
		const packageDirectory = path.join(repoRoot, 'packages', 'fake-package');
		const generatedFilePath = path.join(packageDirectory, 'dist', 'index.js');
		const sourceFilePath = path.join(packageDirectory, 'src', 'index.ts');
		const extraGeneratedFilePath = path.join(packageDirectory, 'dist', 'extra.js');
		const rootBuildInputPath = path.join(repoRoot, 'tsconfig.base.json');
		await fs.mkdir(path.dirname(generatedFilePath), { recursive: true });
		await fs.mkdir(path.dirname(sourceFilePath), { recursive: true });
		await fs.writeFile(
			path.join(packageDirectory, 'package.json'),
			JSON.stringify({ name: 'fake-package', version: '1.0.0', files: ['dist', 'src'] }),
		);
		await fs.writeFile(sourceFilePath, 'export const value = 1;\n');
		await fs.writeFile(generatedFilePath, 'export const value = 1;\n');
		await fs.writeFile(path.join(repoRoot, 'package.json'), '{}\n');
		await fs.writeFile(path.join(repoRoot, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
		await fs.writeFile(path.join(repoRoot, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
		await fs.writeFile(path.join(repoRoot, '.node-version'), '24\n');
		await fs.writeFile(rootBuildInputPath, '{}\n');
		await fs.writeFile(path.join(repoRoot, 'tsconfig.json'), '{}\n');
		process.env.AGENT_VM_E2E_CACHE_DIR = path.join(temporaryRoot, 'cache');
		try {
			const firstTarballPath = await packLocalAgentVmPackageTarball({
				packageName: 'fake-package',
				repoRoot,
			});
			const firstTarball = await fs.readFile(firstTarballPath);
			await fs.appendFile(generatedFilePath, '\n// independent build output variation\n', 'utf8');
			const secondTarballPath = await packLocalAgentVmPackageTarball({
				packageName: 'fake-package',
				repoRoot,
			});
			expect(secondTarballPath).toBe(firstTarballPath);
			expect(await fs.readFile(secondTarballPath)).toEqual(firstTarball);

			await fs.writeFile(extraGeneratedFilePath, 'export const extra = true;\n');
			const layoutChangedTarballPath = await packLocalAgentVmPackageTarball({
				packageName: 'fake-package',
				repoRoot,
			});
			expect(layoutChangedTarballPath).toBe(firstTarballPath);

			await fs.appendFile(sourceFilePath, 'export const changed = true;\n', 'utf8');
			const sourceChangedTarballPath = await packLocalAgentVmPackageTarball({
				packageName: 'fake-package',
				repoRoot,
			});
			expect(sourceChangedTarballPath).not.toBe(firstTarballPath);

			await fs.appendFile(rootBuildInputPath, '{"compilerOptions":{}}\n', 'utf8');
			const buildInputChangedTarballPath = await packLocalAgentVmPackageTarball({
				packageName: 'fake-package',
				repoRoot,
			});
			expect(buildInputChangedTarballPath).not.toBe(layoutChangedTarballPath);
		} finally {
			if (previousCacheRoot === undefined) {
				delete process.env.AGENT_VM_E2E_CACHE_DIR;
			} else {
				process.env.AGENT_VM_E2E_CACHE_DIR = previousCacheRoot;
			}
		}
	});
});

describe('startE2eControllerRuntime', () => {
	it('preserves smoke Docker images by default so one suite can reuse the built cache', () => {
		expect(shouldCleanupE2eDockerImages({ env: {} })).toBe(false);
		expect(
			shouldCleanupE2eDockerImages({
				env: { AGENT_VM_E2E_CLEAN_IMAGES: '0' },
			}),
		).toBe(false);
	});

	it('only removes smoke Docker images when cleanup is requested explicitly', () => {
		expect(shouldCleanupE2eDockerImages({ cleanupImages: true })).toBe(true);
		expect(
			shouldCleanupE2eDockerImages({
				env: { AGENT_VM_E2E_CLEAN_IMAGES: '1' },
			}),
		).toBe(true);
	});

	it('passes TCP host and VFS mount overrides into the gateway zone startup dependency', async () => {
		const { startE2eControllerRuntime } = await import('./e2e-harness.js');
		const capturedGatewayStarts: StartGatewayZoneOptions[] = [];
		const systemConfig = createMinimalHermesSystemConfig();
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected smoke system config to contain a zone.');
		}

		const harness = await startE2eControllerRuntime({
			secrets: {
				AGENT_VM_TEST_OPENAI_API_KEY: 'test-service-account-token',
			},
			startGatewayZone: async (options) => {
				capturedGatewayStarts.push(options);
				return createManagedGatewayStartResultStub(zone);
			},
			startHttpServer: async () => ({
				close: async () => undefined,
			}),
			startOptions: {
				systemConfig,
				zoneIds: ['smoke'],
			},
			tcpHostsOverride: {
				'smoke-upstream.vm.host:48123': '127.0.0.1:48123',
			},
			vfsMountsOverride: {
				'/work/repo': {
					access: 'read-only',
					hostPath: process.cwd(),
					kind: 'host-directory',
				},
			},
		});

		try {
			expect(capturedGatewayStarts[0]?.tcpHostsOverride).toEqual({
				'smoke-upstream.vm.host:48123': '127.0.0.1:48123',
			});
			expect(capturedGatewayStarts[0]?.vfsMountsOverride).toEqual({
				'/work/repo': {
					access: 'read-only',
					hostPath: process.cwd(),
					kind: 'host-directory',
				},
			});
		} finally {
			await harness.close();
		}
	});

	it('removes owned smoke temp roots when the harness closes', async () => {
		const { startE2eControllerRuntime } = await import('./e2e-harness.js');
		const temporaryRoot = await createTemporaryRoot('agent-vm-e2e-harness-');
		const systemConfig = createMinimalHermesSystemConfig(temporaryRoot);
		const zone = systemConfig.zones[0];
		if (!zone || zone.gateway.type !== 'hermes') {
			throw new Error('Expected smoke system config to contain an Hermes zone.');
		}

		const harness = await startE2eControllerRuntime({
			secrets: {
				AGENT_VM_TEST_OPENAI_API_KEY: 'test-service-account-token',
			},
			startGatewayZone: async () => createManagedGatewayStartResultStub(zone),
			startHttpServer: async () => ({
				close: async () => undefined,
			}),
			startOptions: {
				systemConfig,
				zoneIds: ['smoke'],
			},
		});

		await harness.close();

		await expect(fs.access(temporaryRoot)).rejects.toThrow();
	});

	it('preserves an owned smoke temp root only when close requests it explicitly', async () => {
		const { startE2eControllerRuntime } = await import('./e2e-harness.js');
		const temporaryRoot = await createTemporaryRoot('agent-vm-e2e-harness-');
		const systemConfig = createMinimalHermesSystemConfig(temporaryRoot);
		const zone = systemConfig.zones[0];
		if (!zone || zone.gateway.type !== 'hermes') {
			throw new Error('Expected smoke system config to contain an Hermes zone.');
		}

		const harness = await startE2eControllerRuntime({
			secrets: {
				AGENT_VM_TEST_OPENAI_API_KEY: 'test-service-account-token',
			},
			startGatewayZone: async () => createManagedGatewayStartResultStub(zone),
			startHttpServer: async () => ({
				close: async () => undefined,
			}),
			startOptions: {
				systemConfig,
				zoneIds: ['smoke'],
			},
		});

		await harness.close({ preserveTempRoot: true });

		await expect(fs.access(temporaryRoot)).resolves.toBeUndefined();
	});

	it.each([
		'hermes-framework-observability-e2e-',
		'hermes-framework-otel-signals-disabled-e2e-',
		'hermes-tool-portal-orientation-e2e-',
	])('removes owned Hermes temp roots with prefix %s', async (prefix) => {
		const temporaryRoot = await createTemporaryRoot(prefix);

		await removeE2eTempRoot(temporaryRoot);

		await expect(fs.access(temporaryRoot)).rejects.toThrow();
	});

	it('does not remove unrelated temp roots through the smoke cleanup helper', async () => {
		const temporaryRoot = await createTemporaryRoot('agent-vm-not-smoke-');

		await removeE2eTempRoot(temporaryRoot);

		await expect(fs.access(temporaryRoot)).resolves.toBeUndefined();
	});

	it('removes Docker images declared by smoke build configs', async () => {
		const temporaryRoot = await createTemporaryRoot('agent-vm-e2e-harness-');
		const gatewayBuildConfigPath = path.join(temporaryRoot, 'gateway-build.jsonc');
		const toolBuildConfigPath = path.join(temporaryRoot, 'tool-build.jsonc');
		const systemConfig = createMinimalHermesSystemConfig(temporaryRoot);
		const gatewayProfile = systemConfig.imageProfiles.gateways.hermes;
		const toolVmProfile = systemConfig.imageProfiles.toolVms.tool;
		if (gatewayProfile === undefined || toolVmProfile === undefined) {
			throw new Error('Expected e2e test fixture to define gateway and Tool VM profiles.');
		}
		gatewayProfile.buildConfig = gatewayBuildConfigPath;
		toolVmProfile.buildConfig = toolBuildConfigPath;
		await fs.writeFile(
			gatewayBuildConfigPath,
			`${JSON.stringify({ oci: { image: 'agent-vm-gateway:latest' } })}\n`,
			'utf8',
		);
		await fs.writeFile(
			toolBuildConfigPath,
			`${JSON.stringify({ oci: { image: 'agent-vm-tool:latest' } })}\n`,
			'utf8',
		);
		const dockerCommands: string[][] = [];

		expect(await collectE2eDockerImageTags(systemConfig)).toEqual([
			'agent-vm-gateway:latest',
			'agent-vm-tool:latest',
		]);
		await removeE2eDockerImagesForSystemConfig(systemConfig, {
			runDockerCommand: async (args) => {
				dockerCommands.push([...args]);
			},
		});

		expect(dockerCommands).toEqual([
			['image', 'inspect', 'agent-vm-gateway:latest'],
			['image', 'rm', '--force', 'agent-vm-gateway:latest'],
			['image', 'inspect', 'agent-vm-tool:latest'],
			['image', 'rm', '--force', 'agent-vm-tool:latest'],
		]);
	});

	it('writes local MCP Portal Tool VM smoke images only when requested explicitly', async () => {
		const temporaryRoot = await createTemporaryRoot('agent-vm-e2e-harness-');
		const repoRoot = path.join(temporaryRoot, 'repo');
		const systemConfig = createMinimalHermesSystemConfig();
		const originalGatewayProfile = { ...systemConfig.imageProfiles.gateways.hermes };

		await createFakeAgentPortalSdkPackage(repoRoot);
		await createFakeSecretsPackage(repoRoot);
		await createFakePortalDist(repoRoot);
		const localAgentPortalSdkWheelPath = await createFakeAgentPortalSdkWheel(temporaryRoot);

		await useLocalToolVmMcpPortalPackage({
			localAgentPortalSdkWheelPath,
			projectRoot: temporaryRoot,
			repoRoot,
			systemConfig,
		});

		expect(systemConfig.imageProfiles.gateways.hermes).toEqual(originalGatewayProfile);
		const toolVmDockerfilePath = systemConfig.imageProfiles.toolVms.tool?.dockerfile;
		if (toolVmDockerfilePath === undefined) {
			throw new Error('Expected explicit Tool VM helper to set dockerfile path.');
		}
		expect(toolVmDockerfilePath).toBe(
			path.join(temporaryRoot, 'vm-images', 'tool-vms', 'tool-local-mcp-portal', 'Dockerfile'),
		);
		const toolVmDockerfile = await fs.readFile(toolVmDockerfilePath, 'utf8');
		expect(toolVmDockerfile).toContain(
			'COPY agent-vm-agent-portal-sdk-0.0.0-smoke.tgz /tmp/agent-vm-agent-portal-sdk-0.0.0-smoke.tgz',
		);
		expect(toolVmDockerfile).toContain(
			'COPY agent-vm-oauth-broker-contracts-0.0.0-smoke.tgz /tmp/agent-vm-oauth-broker-contracts-0.0.0-smoke.tgz',
		);
		expect(toolVmDockerfile).toContain(
			'COPY agent-vm-config-contracts-0.0.0-smoke.tgz /tmp/agent-vm-config-contracts-0.0.0-smoke.tgz',
		);
		expect(toolVmDockerfile).toContain(
			'COPY agent-vm-secret-management-0.0.0-smoke.tgz /tmp/agent-vm-secret-management-0.0.0-smoke.tgz',
		);
		expect(toolVmDockerfile).toContain(
			'COPY agent-vm-mcp-portal-0.0.0-smoke.tgz /tmp/agent-vm-mcp-portal-0.0.0-smoke.tgz',
		);
		expect(toolVmDockerfile).toContain(
			'COPY agent_vm_agent_portal_sdk-0.0.147-py3-none-any.whl /tmp/agent_vm_agent_portal_sdk-0.0.147-py3-none-any.whl',
		);
		expect(toolVmDockerfile).toContain(
			'uv pip install --python /opt/agent-vm-tools/bin/python /tmp/agent_vm_agent_portal_sdk-0.0.147-py3-none-any.whl',
		);
		expect(toolVmDockerfile).toContain('COPY agent-vm-tool-portal.md /agent-vm/tool-portal.md');
		expect(toolVmDockerfile).toContain(
			'COPY agent-vm-tool-vm-login-profile.sh /etc/profile.d/agent-vm-tools.sh',
		);
		expect(toolVmDockerfile).toContain('pnpm install --prod --ignore-scripts');
		expect(toolVmDockerfile).toContain(
			'/opt/agent-vm/local-packages/node_modules/@agent-vm/agent-portal-sdk/dist/cli/tool-portal.js /pnpm/tool-portal',
		);
		expect(toolVmDockerfile).not.toContain('node_modules/.bin/tool-portal /pnpm/tool-portal');
		expect(toolVmDockerfile).toContain('@agent-vm/config-contracts');
		expect(toolVmDockerfile).toContain('file:/tmp/agent-vm-config-contracts-0.0.0-smoke.tgz');
		expect(toolVmDockerfile).toContain('@agent-vm/oauth-broker-contracts');
		expect(toolVmDockerfile).toContain('file:/tmp/agent-vm-oauth-broker-contracts-0.0.0-smoke.tgz');
		expect(toolVmDockerfile).toContain('@agent-vm/mcp-portal');
		expect(toolVmDockerfile).toContain('file:/tmp/agent-vm-mcp-portal-0.0.0-smoke.tgz');
		expect(toolVmDockerfile).not.toContain('pnpm add -g');
	});

	it('fails local package image setup before packing when declared package files are missing', async () => {
		const temporaryRoot = await createTemporaryRoot('agent-vm-e2e-harness-');
		const repoRoot = path.join(temporaryRoot, 'repo');
		const systemConfig = createMinimalHermesSystemConfig();
		const packageDir = path.join(repoRoot, 'packages', 'mcp-portal');

		await createFakeAgentPortalSdkPackage(repoRoot);
		await createFakeConfigContractsPackage(repoRoot);
		await createFakeSecretsPackage(repoRoot);
		const localAgentPortalSdkWheelPath = await createFakeAgentPortalSdkWheel(temporaryRoot);
		await fs.mkdir(packageDir, { recursive: true });
		await fs.writeFile(
			path.join(packageDir, 'package.json'),
			`${JSON.stringify(
				{
					name: '@agent-vm/mcp-portal',
					version: '0.0.0-smoke',
					files: ['dist'],
				},
				null,
				'\t',
			)}\n`,
			'utf8',
		);

		await expect(
			useLocalToolVmMcpPortalPackage({
				localAgentPortalSdkWheelPath,
				projectRoot: temporaryRoot,
				repoRoot,
				systemConfig,
			}),
		).rejects.toThrow(/declares package file "dist" but it does not exist/u);
	});
});

describe('findReusableGatewayImageDirectory', () => {
	it('does not scan random system temp smoke directories unless an explicit cache root is configured', async () => {
		const previousSmokeCacheRoot = process.env.AGENT_VM_E2E_CACHE_DIR;
		delete process.env.AGENT_VM_E2E_CACHE_DIR;
		try {
			await expect(
				findReusableGatewayImageDirectory({
					currentProjectRoot: '/tmp/current-smoke',
					gatewayBuildConfigPath: '/tmp/build-config.jsonc',
				}),
			).resolves.toBeNull();
		} finally {
			if (previousSmokeCacheRoot === undefined) {
				delete process.env.AGENT_VM_E2E_CACHE_DIR;
			} else {
				process.env.AGENT_VM_E2E_CACHE_DIR = previousSmokeCacheRoot;
			}
		}
	});

	it('seeds the current profile-local gateway image cache from an explicit smoke cache root', async () => {
		const previousSmokeCacheRoot = process.env.AGENT_VM_E2E_CACHE_DIR;
		const temporaryRoot = await createTemporaryRoot('agent-vm-e2e-harness-');
		const smokeCacheRoot = path.join(temporaryRoot, 'shared-smoke-cache');
		const currentProjectRoot = path.join(temporaryRoot, 'current-smoke');
		const previousCacheDir = path.join(smokeCacheRoot, 'previous-run', 'cache');
		const activeCacheDir = path.join(smokeCacheRoot, 'active-run-cache');
		const gatewayBuildConfigPath = path.join(currentProjectRoot, 'build-config.jsonc');
		await fs.mkdir(path.dirname(gatewayBuildConfigPath), { recursive: true });
		await fs.writeFile(
			gatewayBuildConfigPath,
			`${JSON.stringify({ arch: 'x86_64', distro: 'alpine' })}\n`,
			'utf8',
		);
		const managedGatewayBoot = {
			frameworkBootEntry: 'hermes-framework-service',
			kind: 'managed-gateway-exact-two-role',
		} satisfies ManagedGatewayImageBootProjection;
		const fingerprint = await computeFingerprintFromConfigPath(gatewayBuildConfigPath, {
			managedGatewayBoot,
		});
		const reusableImageDirectory = path.join(previousCacheDir, 'vm-images', fingerprint);
		await fs.mkdir(reusableImageDirectory, { recursive: true });
		await Promise.all(
			managedVmImageAssetFileNames.map(async (fileName) => {
				await fs.writeFile(
					path.join(reusableImageDirectory, fileName),
					imageArtifactFixtureFileContent(fileName),
					'utf8',
				);
			}),
		);
		process.env.AGENT_VM_E2E_CACHE_DIR = smokeCacheRoot;
		try {
			await seedGatewayImageCacheIfAvailable({
				activeCacheDir,
				currentProjectRoot,
				gatewayBuildConfigPath,
				imageProfileName: 'hermes',
				managedGatewayBoot,
			});
		} finally {
			if (previousSmokeCacheRoot === undefined) {
				delete process.env.AGENT_VM_E2E_CACHE_DIR;
			} else {
				process.env.AGENT_VM_E2E_CACHE_DIR = previousSmokeCacheRoot;
			}
		}

		const activeImageDirectory = path.join(activeCacheDir, 'vm-images', fingerprint);
		await expect(
			fs.readFile(path.join(activeImageDirectory, 'manifest.json'), 'utf8'),
		).resolves.toBe(imageArtifactFixtureFileContent('manifest.json'));
	});
});

function createManagedVmStub(): ManagedVm {
	const managedVm: ManagedVm = {
		id: 'vm-smoke-test',
		close: async () => {},
		enableIngress: async () => ({ close: async () => {}, host: '127.0.0.1', port: 18789 }),
		enableSsh: async () => ({
			close: async () => {},
			command: 'ssh vm-smoke-test',
			serverHostKey: TEST_SSH_SERVER_HOST_KEY,
			host: '127.0.0.1',
			identityFile: '/tmp/vm-smoke-test-identity',
			port: 2222,
			user: 'root',
		}),
		exec: () => createManagedExecProcessStub(),
		configureIngressRoutes: () => undefined,
		getHostProcessId: () => null,
		start: async () => {},
	};
	return managedVm;
}

function createExactVmOwnershipStub(vmId: string): GatewayVmLifecycleAuthority {
	const gatewaySeed = {
		bootId: 'boot-smoke-test',
		controllerEpoch: 'controller-smoke-test',
		gatewayEpochId: 'gateway-epoch-smoke-test',
		generationId: 'generation-smoke-test',
		zoneId: 'smoke',
	};
	const gatewayIdentity = { ...gatewaySeed, gatewayVmId: vmId };
	return {
		abandonUnattachedGatewaySeedAfter: async (cleanupOwnedResources) => {
			await cleanupOwnedResources();
		},
		attachGatewayVm: () => gatewayIdentity,
		containPendingCreate: async () => {},
		destroyLive: async (destroyVm) => await destroyVm(),
		gatewayIdentity,
		gatewaySeed,
	};
}

function createManagedGatewayStartResultStub(
	zone: ManagedGatewayZoneStartResult['zone'],
): ManagedGatewayZoneStartResult {
	const vm = createManagedVmStub();
	const vmOwnership = createExactVmOwnershipStub(vm.id);
	const gatewayIdentity = vmOwnership.gatewayIdentity;
	if (gatewayIdentity === undefined) {
		throw new Error('Expected the smoke Gateway ownership fixture to be attached.');
	}
	let destroyGatewayInFlight: Promise<GatewayZoneDestroyResult> | undefined;
	return {
		bootContract: testManagedGatewayBootContract,
		destroyGateway: () => {
			destroyGatewayInFlight ??= vmOwnership
				.destroyLive(async () => await vm.close())
				.then(() => ({ kind: 'destroyed-clean' }) satisfies GatewayZoneDestroyResult);
			return destroyGatewayInFlight;
		},
		executionModel: 'managed-gateway',
		expectedCohort: testManagedGatewayExpectedCohort,
		gatewayIdentity,
		image: { built: false, fingerprint: 'test', imageReference: '/tmp/image' },
		ingress: { host: '127.0.0.1', port: 18789 },
		vm,
		zone,
	};
}

function createMinimalHermesSystemConfig(projectRoot = '/tmp'): LoadedSystemConfig {
	return {
		cacheDir: path.join(projectRoot, 'cache'),
		controllerRuntimeDir: path.join(projectRoot, 'controller-runtime'),
		controllerStateDir: path.join(projectRoot, 'controller-state'),
		host: {
			controllerPort: 18800,
			projectNamespace: 'smoke-tests',
			secretsProvider: {
				type: '1password',
				tokenSource: { type: 'env', envVar: 'AGENT_VM_TEST_OPENAI_API_KEY' },
			},
		},
		imageProfiles: {
			gateways: {
				hermes: {
					type: 'hermes',
					buildConfig: '/tmp/build-config.jsonc',
				},
			},
			toolVms: {
				tool: {
					type: 'toolVm',
					buildConfig: '/tmp/tool-build-config.jsonc',
				},
			},
		},
		schemaVersion: 2,
		storageRootDir: projectRoot,
		systemConfigPath: path.join(projectRoot, 'config', 'system.json'),
		tcpPool: { basePort: 19000, size: 4 },
		toolVmProfiles: {
			standard: {
				cpus: 1,
				imageProfile: 'tool',
				memory: '512M',
			},
		},
		zones: [
			{
				agentToolVmProfiles: {},
				agents: [{ id: 'smoke' }],
				defaultToolVmProfile: 'standard',
				egressHosts: [],
				gateway: {
					type: 'hermes',
					profileSecretProjectionsByAgent: { smoke: {} },
					profilesByAgent: { smoke: 'smoke' },
					backupDir: path.join(projectRoot, 'backup'),
					config: path.join(projectRoot, 'config', 'hermes.yaml'),
					cpus: 1,
					imageProfile: 'hermes',
					memory: '1G',
					port: 18789,
					stateDir: path.join(projectRoot, 'smoke', 'state'),
					zoneFilesDir: path.join(projectRoot, 'smoke', 'zone-files'),
					zoneRuntimeDir: path.join(projectRoot, 'smoke', 'runtime'),
				},
				id: 'smoke',
				secrets: {},
			},
		],
	};
}
async function createFakeSimplePackage(
	repoRoot: string,
	packageName: string,
	dependencies: Readonly<Record<string, string>> = {},
): Promise<void> {
	const packageDir = path.join(repoRoot, 'packages', packageName);
	await fs.mkdir(path.join(packageDir, 'dist'), { recursive: true });
	await fs.writeFile(
		path.join(packageDir, 'package.json'),
		`${JSON.stringify(
			{
				...(Object.keys(dependencies).length > 0 ? { dependencies } : {}),
				name: `@agent-vm/${packageName}`,
				version: '0.0.0-smoke',
				files: ['dist'],
				type: 'module',
			},
			null,
			'\t',
		)}\n`,
		'utf8',
	);
	await fs.writeFile(path.join(packageDir, 'dist', 'index.js'), 'export {};\n', 'utf8');
}

async function createFakeAgentPortalSdkPackage(repoRoot: string): Promise<void> {
	await createFakeSimplePackage(repoRoot, 'oauth-broker-contracts');
	await createFakeSimplePackage(repoRoot, 'agent-portal-sdk', {
		'@agent-vm/oauth-broker-contracts': '0.0.0-smoke',
	});
}

async function createFakeAgentPortalSdkWheel(projectRoot: string): Promise<string> {
	const wheelPath = path.join(projectRoot, 'agent_vm_agent_portal_sdk-0.0.147-py3-none-any.whl');
	await fs.writeFile(wheelPath, 'fake local Python SDK wheel\n', 'utf8');
	return wheelPath;
}

async function createFakePortalDist(repoRoot: string): Promise<void> {
	await createFakeAgentPortalSdkPackage(repoRoot);
	await createFakeConfigContractsPackage(repoRoot);
	await createFakeSecretsPackage(repoRoot);
	const packageDir = path.join(repoRoot, 'packages', 'mcp-portal');
	await fs.mkdir(packageDir, { recursive: true });
	await fs.writeFile(
		path.join(packageDir, 'package.json'),
		`${JSON.stringify(
			{
				dependencies: {
					'@agent-vm/agent-portal-sdk': '0.0.0-smoke',
					'@agent-vm/config-contracts': '0.0.0-smoke',
					'@agent-vm/secret-management': '0.0.0-smoke',
				},
				name: '@agent-vm/mcp-portal',
				version: '0.0.0-smoke',
				files: ['dist'],
			},
			null,
			'\t',
		)}\n`,
		'utf8',
	);
	const binDir = path.join(repoRoot, 'packages', 'mcp-portal', 'dist', 'bin');
	await fs.mkdir(binDir, { recursive: true });
	await fs.writeFile(
		path.join(repoRoot, 'packages', 'mcp-portal', 'dist', 'index.js'),
		'export {};\n',
		'utf8',
	);
	await fs.writeFile(path.join(binDir, 'mcp-portal.js'), 'console.log("portal");\n', 'utf8');
}

async function createFakeConfigContractsPackage(repoRoot: string): Promise<void> {
	const packageDir = path.join(repoRoot, 'packages', 'config-contracts');
	await fs.mkdir(path.join(packageDir, 'dist'), { recursive: true });
	await fs.writeFile(
		path.join(packageDir, 'package.json'),
		`${JSON.stringify(
			{
				name: '@agent-vm/config-contracts',
				version: '0.0.0-smoke',
				files: ['dist'],
			},
			null,
			'\t',
		)}\n`,
		'utf8',
	);
	await fs.writeFile(path.join(packageDir, 'dist', 'index.js'), 'export {};\n', 'utf8');
}

async function createFakeSecretsPackage(repoRoot: string): Promise<void> {
	const packageDir = path.join(repoRoot, 'packages', 'secret-management');
	await fs.mkdir(path.join(packageDir, 'dist'), { recursive: true });
	await fs.writeFile(
		path.join(packageDir, 'package.json'),
		`${JSON.stringify(
			{
				name: '@agent-vm/secret-management',
				version: '0.0.0-smoke',
				files: ['dist'],
			},
			null,
			'\t',
		)}\n`,
		'utf8',
	);
	await fs.writeFile(path.join(packageDir, 'dist', 'index.js'), 'export {};\n', 'utf8');
}
describe('managed Tool VM local package overlays', () => {
	it('preserves managed Tool VM overlays while replacing registry packages with local tarballs', async () => {
		const previousCacheRoot = process.env.AGENT_VM_E2E_CACHE_DIR;
		const previousLocalPackageMode = process.env.AGENT_VM_E2E_USE_LOCAL_TOOL_VM_PACKAGES;
		const temporaryRoot = await createTemporaryRoot('agent-vm-e2e-harness-');
		process.env.AGENT_VM_E2E_CACHE_DIR = path.join(temporaryRoot, 'shared-e2e-cache');
		process.env.AGENT_VM_E2E_USE_LOCAL_TOOL_VM_PACKAGES = '1';
		try {
			const project = await scaffoldHermesE2eProject({
				agents: ['main'],
				architecture: 'aarch64',
				prefix: 'hermes-local-tool-vm-packages-',
				zoneId: 'hermes-local-tool-vm-packages',
			});
			temporaryRoots.push(project.tempRoot);
			const managedToolVmProfile = project.systemConfig.imageProfiles.toolVms.default;
			if (managedToolVmProfile === undefined) {
				throw new Error('Expected the scaffold to define a managed default Tool VM profile.');
			}
			if (managedToolVmProfile.source === undefined) {
				throw new Error('Expected the scaffold Tool VM profile to use a managed source.');
			}
			const originalOverlayPath = managedToolVmProfile.source.overlay;
			if (originalOverlayPath === undefined) {
				throw new Error('Expected the scaffold Tool VM profile to define a managed overlay.');
			}
			const originalOverlayDirectory = path.dirname(originalOverlayPath);
			const originalOverlayAssetPath = path.join(
				originalOverlayDirectory,
				'managed-overlay',
				'marker.txt',
			);
			const prefixedCustomOverlayAssetPath = path.join(
				originalOverlayDirectory,
				'local-agent-vm',
				'agent-vm-custom-runtime.tgz',
			);
			await fs.mkdir(path.dirname(originalOverlayAssetPath), { recursive: true });
			await fs.mkdir(path.dirname(prefixedCustomOverlayAssetPath), { recursive: true });
			await fs.writeFile(originalOverlayAssetPath, 'managed-overlay-marker\n', 'utf8');
			await fs.writeFile(prefixedCustomOverlayAssetPath, 'custom-runtime-archive\n', 'utf8');
			await fs.writeFile(
				originalOverlayPath,
				`${JSON.stringify(
					{
						schemaVersion: 1,
						extraAptPackages: ['ripgrep'],
						packageOverrides: {
							npm: ['tsx@4.20.3'],
						},
						copy: [
							{
								from: 'managed-overlay/marker.txt',
								to: '/opt/agent-vm/managed-overlay-marker.txt',
							},
							{
								from: 'local-agent-vm/agent-vm-custom-runtime.tgz',
								to: '/opt/agent-vm/agent-vm-custom-runtime.tgz',
							},
						],
						runAfterBase: ['test -f /opt/agent-vm/managed-overlay-marker.txt'],
					},
					null,
					'\t',
				)}\n`,
				'utf8',
			);
			const sourceManagedDockerfilePath = path.join(
				project.tempRoot,
				'source-managed-tool-vm.Dockerfile',
			);
			await fs.writeFile(sourceManagedDockerfilePath, 'FROM scratch\n', 'utf8');
			managedToolVmProfile.dockerfile = sourceManagedDockerfilePath;
			const explicitDockerfilePath = path.join(project.tempRoot, 'explicit-tool-vm.Dockerfile');
			await fs.writeFile(explicitDockerfilePath, 'FROM scratch\n', 'utf8');
			project.systemConfig.imageProfiles.toolVms.explicit = {
				...managedToolVmProfile,
				dockerfile: explicitDockerfilePath,
				source: undefined,
			};
			const buildConfigs: LoadedSystemConfig[] = [];
			let generatedManagedDockerfile: GenerateManagedDockerfileResult | undefined;

			await prepareGatewayE2eProjectImages({
				project,
				runBuild: async ({ systemConfig }) => {
					buildConfigs.push(systemConfig);
					const toolVmProfile = systemConfig.imageProfiles.toolVms.default;
					if (toolVmProfile?.source === undefined) {
						throw new Error('Expected the localized Tool VM profile to retain its managed source.');
					}
					generatedManagedDockerfile = await generateManagedDockerfile({
						base: toolVmProfile.source.base,
						imageTargetFamily: 'toolVm',
						imageTargetName: 'default',
						managedImageRelease: await resolveManagedImageRelease(),
						outputDirectory: path.join(project.tempRoot, 'generated-tool-vm-proof'),
						...(toolVmProfile.source.overlay === undefined
							? {}
							: { overlayPath: toolVmProfile.source.overlay }),
					});
				},
			});
			await prepareGatewayE2eProjectImages({
				project,
				runBuild: async ({ systemConfig }) => {
					buildConfigs.push(systemConfig);
					const toolVmProfile = systemConfig.imageProfiles.toolVms.default;
					if (toolVmProfile?.source === undefined) {
						throw new Error('Expected repeated localization to retain the managed source.');
					}
					generatedManagedDockerfile = await generateManagedDockerfile({
						base: toolVmProfile.source.base,
						imageTargetFamily: 'toolVm',
						imageTargetName: 'default',
						managedImageRelease: await resolveManagedImageRelease(),
						outputDirectory: path.join(project.tempRoot, 'generated-tool-vm-proof'),
						...(toolVmProfile.source.overlay === undefined
							? {}
							: { overlayPath: toolVmProfile.source.overlay }),
					});
				},
			});

			const toolVmProfile = project.systemConfig.imageProfiles.toolVms.default;
			if (toolVmProfile?.source?.overlay === undefined) {
				throw new Error(
					'Expected the default Tool VM profile to retain a derived managed overlay.',
				);
			}
			if (generatedManagedDockerfile === undefined) {
				throw new Error('Expected the build seam to generate the managed Tool VM Dockerfile.');
			}
			const derivedOverlay = await loadManagedImageOverlay(toolVmProfile.source.overlay);
			const dockerfile = await fs.readFile(generatedManagedDockerfile.dockerfilePath, 'utf8');
			expect(buildConfigs).toEqual([project.systemConfig, project.systemConfig]);
			expect(toolVmProfile.dockerfile).toBe(sourceManagedDockerfilePath);
			expect(toolVmProfile.source.overlay).not.toBe(originalOverlayPath);
			expect(derivedOverlay.extraAptPackages).toEqual(['ripgrep']);
			expect(derivedOverlay.packageOverrides).toEqual({
				npm: ['tsx@4.20.3'],
			});
			expect(derivedOverlay.copy).toContainEqual({
				from: 'managed-overlay/marker.txt',
				to: '/opt/agent-vm/managed-overlay-marker.txt',
			});
			expect(derivedOverlay.copy).toContainEqual({
				from: 'local-agent-vm/agent-vm-custom-runtime.tgz',
				to: '/opt/agent-vm/agent-vm-custom-runtime.tgz',
			});
			expect(
				derivedOverlay.copy.filter((copyEntry) =>
					/^local-agent-vm\/agent-vm-(?:agent-portal-sdk|oauth-broker-contracts|config-contracts|secret-management|mcp-portal)-/u.test(
						copyEntry.from,
					),
				),
			).toHaveLength(5);
			expect(
				derivedOverlay.copy.filter((copyEntry) =>
					/^local-agent-vm\/agent_vm_agent_portal_sdk-[^/]+\.whl$/u.test(copyEntry.from),
				),
			).toHaveLength(1);
			expect(
				derivedOverlay.runAfterBase.filter((command) =>
					command.includes('/opt/agent-vm/local-packages/package.json'),
				),
			).toHaveLength(1);
			expect(derivedOverlay.runAfterBase).toContain(
				'test -f /opt/agent-vm/managed-overlay-marker.txt',
			);
			expect(
				await fs.readFile(
					path.join(path.dirname(toolVmProfile.source.overlay), 'managed-overlay', 'marker.txt'),
					'utf8',
				),
			).toBe('managed-overlay-marker\n');
			expect(
				await fs.readFile(
					path.join(
						path.dirname(toolVmProfile.source.overlay),
						'local-agent-vm',
						'agent-vm-custom-runtime.tgz',
					),
					'utf8',
				),
			).toBe('custom-runtime-archive\n');
			expect(dockerfile).toContain(
				'RUN apt-get update && apt-get install -y --no-install-recommends "ripgrep"',
			);
			expect(dockerfile).toContain(
				'COPY overlay/managed-overlay/marker.txt /opt/agent-vm/managed-overlay-marker.txt',
			);
			expect(dockerfile).toContain('RUN test -f /opt/agent-vm/managed-overlay-marker.txt');
			expect(dockerfile).toContain('RUN pnpm add -g --ignore-scripts "tsx@4.20.3"');
			expect(dockerfile).toMatch(
				/COPY overlay\/local-agent-vm\/agent-vm-mcp-portal-[^\s]+\.tgz \/tmp\/agent-vm-mcp-portal-[^\s]+\.tgz/u,
			);
			expect(dockerfile).toContain('file:/tmp/agent-vm-mcp-portal-');
			expect(dockerfile).toMatch(
				/RUN uv pip install --python \/opt\/agent-vm-tools\/bin\/python "\/tmp\/agent_vm_agent_portal_sdk-[^"]+\.whl"/u,
			);
			expect(dockerfile).toContain('COPY agent-vm-tool-portal.md /agent-vm/tool-portal.md');
			expect(dockerfile).not.toMatch(/pnpm add -g "@agent-vm\/mcp-portal@/u);
			expect(generatedManagedDockerfile.plan.mcpPortalPackage).toMatchObject({
				name: '@agent-vm/mcp-portal',
				source: 'local-overlay',
			});
			expect(project.systemConfig.imageProfiles.toolVms.explicit).toMatchObject({
				dockerfile: explicitDockerfilePath,
				source: undefined,
			});
		} finally {
			if (previousCacheRoot === undefined) {
				delete process.env.AGENT_VM_E2E_CACHE_DIR;
			} else {
				process.env.AGENT_VM_E2E_CACHE_DIR = previousCacheRoot;
			}
			if (previousLocalPackageMode === undefined) {
				delete process.env.AGENT_VM_E2E_USE_LOCAL_TOOL_VM_PACKAGES;
			} else {
				process.env.AGENT_VM_E2E_USE_LOCAL_TOOL_VM_PACKAGES = previousLocalPackageMode;
			}
		}
	});
});

describe('prepareGatewayE2eProjectImages preserved Hermes paths', () => {
	it('seeds reusable gateway images before running the build command once for the project', async () => {
		const previousSmokeCacheRoot = process.env.AGENT_VM_E2E_CACHE_DIR;
		const temporaryRoot = await createTemporaryRoot('agent-vm-e2e-harness-');
		const smokeCacheRoot = path.join(temporaryRoot, 'shared-smoke-cache');
		const project = await scaffoldHermesE2eProject({
			agents: ['main'],
			architecture: 'aarch64',
			prefix: 'hermes-loop-e2e-',
			zoneId: 'hermes-e2e',
		});
		temporaryRoots.push(project.tempRoot);
		const gatewayBuildConfigPath = project.systemConfig.imageProfiles.gateways.hermes?.buildConfig;
		if (gatewayBuildConfigPath === undefined) {
			throw new Error('Expected Hermes gateway image profile.');
		}
		const managedGatewayBoot = {
			frameworkBootEntry: 'hermes-framework-service',
			kind: 'managed-gateway-exact-two-role',
		} as const;
		const fingerprint = await computeFingerprintFromConfigPath(gatewayBuildConfigPath, {
			managedGatewayBoot,
		});
		const reusableImageDirectory = path.join(
			smokeCacheRoot,
			'previous-run',
			'cache',
			'vm-images',
			fingerprint,
		);
		await fs.mkdir(reusableImageDirectory, { recursive: true });
		await Promise.all(
			managedVmImageAssetFileNames.map(async (fileName) => {
				await fs.writeFile(
					path.join(reusableImageDirectory, fileName),
					imageArtifactFixtureFileContent(fileName),
					'utf8',
				);
			}),
		);
		const buildConfigs: LoadedSystemConfig[] = [];
		Object.assign(project.systemConfig, { cacheDir: path.join(smokeCacheRoot, 'hermes') });
		process.env.AGENT_VM_E2E_CACHE_DIR = smokeCacheRoot;
		try {
			await prepareGatewayE2eProjectImages({
				project,
				runBuild: async ({ systemConfig }) => {
					buildConfigs.push(systemConfig);
				},
			});
		} finally {
			if (previousSmokeCacheRoot === undefined) {
				delete process.env.AGENT_VM_E2E_CACHE_DIR;
			} else {
				process.env.AGENT_VM_E2E_CACHE_DIR = previousSmokeCacheRoot;
			}
		}

		const activeImageDirectory = path.join(project.systemConfig.cacheDir, 'vm-images', fingerprint);
		expect(buildConfigs).toEqual([project.systemConfig]);
		await expect(
			fs.readFile(path.join(activeImageDirectory, 'manifest.json'), 'utf8'),
		).resolves.toBe(imageArtifactFixtureFileContent('manifest.json'));
	});

	it('fails before image build when strict prepared-image reuse is required but absent', async () => {
		const previousSmokeCacheRoot = process.env.AGENT_VM_E2E_CACHE_DIR;
		const previousRequirePreparedImageCache = process.env.AGENT_VM_E2E_REQUIRE_PREPARED_IMAGE_CACHE;
		const temporaryRoot = await createTemporaryRoot('agent-vm-e2e-harness-');
		const smokeCacheRoot = path.join(temporaryRoot, 'shared-smoke-cache');
		const project = await scaffoldHermesE2eProject({
			agents: ['main'],
			architecture: 'aarch64',
			prefix: 'hermes-loop-e2e-',
			zoneId: 'hermes-e2e',
		});
		temporaryRoots.push(project.tempRoot);
		const gatewayProfile = project.systemConfig.imageProfiles.gateways.hermes;
		if (gatewayProfile === undefined) {
			throw new Error('Expected Hermes gateway image profile.');
		}
		const dockerfilePath = path.join(project.tempRoot, 'gateway.Dockerfile');
		await fs.writeFile(dockerfilePath, 'FROM scratch\n', 'utf8');
		gatewayProfile.dockerfile = dockerfilePath;
		delete gatewayProfile.source;
		process.env.AGENT_VM_E2E_CACHE_DIR = smokeCacheRoot;
		process.env.AGENT_VM_E2E_REQUIRE_PREPARED_IMAGE_CACHE = '1';
		let buildInvoked = false;
		try {
			await expect(
				prepareGatewayE2eProjectImages({
					imageFamilies: ['gateway'],
					project,
					runBuild: async () => {
						buildInvoked = true;
					},
				}),
			).rejects.toThrow(/strict prepared e2e image cache required/u);
			await expect(
				prepareGatewayE2eProjectImages({
					imageFamilies: [],
					project,
					runBuild: async () => {
						buildInvoked = true;
					},
				}),
			).rejects.toThrow(/strict prepared e2e image cache required/u);
		} finally {
			if (previousSmokeCacheRoot === undefined) {
				delete process.env.AGENT_VM_E2E_CACHE_DIR;
			} else {
				process.env.AGENT_VM_E2E_CACHE_DIR = previousSmokeCacheRoot;
			}
			if (previousRequirePreparedImageCache === undefined) {
				delete process.env.AGENT_VM_E2E_REQUIRE_PREPARED_IMAGE_CACHE;
			} else {
				process.env.AGENT_VM_E2E_REQUIRE_PREPARED_IMAGE_CACHE = previousRequirePreparedImageCache;
			}
		}
		expect(buildInvoked).toBe(false);
	});

	it('reuses a Tool VM-only manifest for equivalent managed-source images', async () => {
		const previousSmokeCacheRoot = process.env.AGENT_VM_E2E_CACHE_DIR;
		const previousRequirePreparedImageCache = process.env.AGENT_VM_E2E_REQUIRE_PREPARED_IMAGE_CACHE;
		const temporaryRoot = await createTemporaryRoot('agent-vm-e2e-harness-');
		const smokeCacheRoot = path.join(temporaryRoot, 'shared-smoke-cache');
		const firstProject = await scaffoldHermesE2eProject({
			agents: ['main'],
			architecture: 'aarch64',
			prefix: 'hermes-tool-vm-manifest-e2e-',
			zoneId: 'hermes-e2e',
		});
		const secondProject = await scaffoldHermesE2eProject({
			agents: ['main'],
			architecture: 'aarch64',
			prefix: 'hermes-tool-vm-manifest-e2e-',
			zoneId: 'hermes-e2e',
		});
		temporaryRoots.push(firstProject.tempRoot, secondProject.tempRoot);
		for (const project of [firstProject, secondProject]) {
			Object.assign(project.systemConfig, { cacheDir: path.join(smokeCacheRoot, 'tool-vm') });
			const gatewayProfile = project.systemConfig.imageProfiles.gateways.hermes;
			const toolVmProfile = project.systemConfig.imageProfiles.toolVms.default;
			if (gatewayProfile === undefined || toolVmProfile === undefined) {
				throw new Error('Expected Hermes Gateway and default Tool VM image profiles.');
			}
			toolVmProfile.source = { base: 'tool-vm', kind: 'managedBase' };
		}
		process.env.AGENT_VM_E2E_CACHE_DIR = smokeCacheRoot;
		delete process.env.AGENT_VM_E2E_REQUIRE_PREPARED_IMAGE_CACHE;
		const buildConfigs: LoadedSystemConfig[] = [];
		try {
			await prepareGatewayE2eProjectImages({
				imageFamilies: ['toolVm'],
				project: firstProject,
				runBuild: async ({ systemConfig }) => {
					buildConfigs.push(systemConfig);
					const toolVmProfile = systemConfig.imageProfiles.toolVms.default;
					if (toolVmProfile === undefined) {
						throw new Error('Expected default Tool VM image profile.');
					}
					const fingerprint = await computeFingerprintFromConfigPath(toolVmProfile.buildConfig);
					const cacheDir = sharedImageCacheDirForSystemConfig(systemConfig);
					const imagePath = path.join(cacheDir, fingerprint);
					await fs.mkdir(imagePath, { recursive: true });
					await Promise.all(
						managedVmImageAssetFileNames.map(
							async (fileName) =>
								await fs.writeFile(
									path.join(imagePath, fileName),
									imageArtifactFixtureFileContent(fileName),
									'utf8',
								),
						),
					);
					await writePreparedManagedVmImage({
						buildConfigPath: toolVmProfile.buildConfig,
						fingerprint,
						imagePath,
						selectionRecordPath: e2eSelectionRecordPath(systemConfig, 'toolVm', 'default'),
						sharedImageCacheDir: cacheDir,
					});
				},
			});
			await prepareGatewayE2eProjectImages({
				imageFamilies: ['gateway'],
				project: firstProject,
				runBuild: async ({ systemConfig }) => {
					buildConfigs.push(systemConfig);
					const gatewayProfile = systemConfig.imageProfiles.gateways.hermes;
					if (gatewayProfile === undefined) {
						throw new Error('Expected Hermes Gateway image profile.');
					}
					const managedGatewayBoot = {
						frameworkBootEntry: 'hermes-framework-service',
						kind: 'managed-gateway-exact-two-role',
					} as const;
					const fingerprint = await computeFingerprintFromConfigPath(gatewayProfile.buildConfig, {
						managedGatewayBoot,
					});
					const cacheDir = sharedImageCacheDirForSystemConfig(systemConfig);
					const imagePath = path.join(cacheDir, fingerprint);
					await fs.mkdir(imagePath, { recursive: true });
					await Promise.all(
						managedVmImageAssetFileNames.map(
							async (fileName) =>
								await fs.writeFile(
									path.join(imagePath, fileName),
									imageArtifactFixtureFileContent(fileName),
									'utf8',
								),
						),
					);
					await writePreparedManagedVmImage({
						buildConfigPath: gatewayProfile.buildConfig,
						fingerprint,
						imagePath,
						managedGatewayBoot,
						selectionRecordPath: e2eSelectionRecordPath(systemConfig, 'gateway', 'hermes'),
						sharedImageCacheDir: cacheDir,
					});
				},
			});
			process.env.AGENT_VM_E2E_REQUIRE_PREPARED_IMAGE_CACHE = '1';
			await prepareGatewayE2eProjectImages({
				project: secondProject,
				runBuild: async ({ systemConfig }) => {
					buildConfigs.push(systemConfig);
				},
			});
		} finally {
			if (previousSmokeCacheRoot === undefined) {
				delete process.env.AGENT_VM_E2E_CACHE_DIR;
			} else {
				process.env.AGENT_VM_E2E_CACHE_DIR = previousSmokeCacheRoot;
			}
			if (previousRequirePreparedImageCache === undefined) {
				delete process.env.AGENT_VM_E2E_REQUIRE_PREPARED_IMAGE_CACHE;
			} else {
				process.env.AGENT_VM_E2E_REQUIRE_PREPARED_IMAGE_CACHE = previousRequirePreparedImageCache;
			}
		}

		expect(buildConfigs).toEqual([firstProject.systemConfig, firstProject.systemConfig]);
		const secondGatewayProfile = secondProject.systemConfig.imageProfiles.gateways.hermes;
		const secondToolVmProfile = secondProject.systemConfig.imageProfiles.toolVms.default;
		if (secondGatewayProfile === undefined || secondToolVmProfile === undefined) {
			throw new Error('Expected Hermes Gateway and default Tool VM image profiles.');
		}
		await expect(
			readPreparedManagedVmImage({
				buildConfigPath: secondGatewayProfile.buildConfig,
				expectedManagedGatewayBoot: {
					kind: 'managed-gateway-exact-two-role',
					frameworkBootEntry: 'hermes-framework-service',
				},
				selectionRecordPath: e2eSelectionRecordPath(
					secondProject.systemConfig,
					'gateway',
					'hermes',
				),
				sharedImageCacheDir: sharedImageCacheDirForSystemConfig(secondProject.systemConfig),
			}),
		).resolves.toMatchObject({ built: false });
		await expect(
			readPreparedManagedVmImage({
				buildConfigPath: secondToolVmProfile.buildConfig,
				selectionRecordPath: e2eSelectionRecordPath(
					secondProject.systemConfig,
					'toolVm',
					'default',
				),
				sharedImageCacheDir: sharedImageCacheDirForSystemConfig(secondProject.systemConfig),
			}),
		).resolves.toMatchObject({ built: false });
	});
});
