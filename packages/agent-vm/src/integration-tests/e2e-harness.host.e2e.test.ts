import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { ManagedVm } from '@agent-vm/managed-vm';
import { afterEach, describe, expect, it } from 'vitest';

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
	deploymentGeneratedDirForStorageRoot,
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
	prepareLocalWorkerPackageForGatewayImage,
	removeE2eLocalPackageTarballs,
	removeE2eDockerImagesForSystemConfig,
	removeE2eTempRoot,
	resolveLocalPackagePackArgs,
	scaffoldWorkerE2eProject,
	seedGatewayImageCacheIfAvailable,
	shouldCleanupE2eDockerImages,
	useLocalToolVmMcpPortalPackage,
} from './e2e-harness.js';
import {
	renderHermesManagedE2eConfiguration,
	scaffoldHermesE2eProject,
	materializeLocalHermesGatewayImagePackages,
} from './hermes-e2e-harness.js';

const temporaryRoots: string[] = [];

function e2eSelectionRecordPath(
	systemConfig: LoadedSystemConfig,
	family: 'gateway' | 'toolVm',
	profileName: string,
): string {
	return configuredImageSelectionRecordPath({
		deploymentGeneratedDir: deploymentGeneratedDirForStorageRoot(systemConfig.storageRootDir),
		family,
		profileName,
	});
}
const execFileAsync = promisify(execFile);
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
			await fs.rm(temporaryRoot, { force: true, recursive: true });
		}),
	);
});

describe('scaffoldGatewayE2eProject', () => {
	it('uses a shared smoke cache root instead of rebuilding images under each temp project', async () => {
		const previousSmokeCacheRoot = process.env.AGENT_VM_E2E_CACHE_DIR;
		const temporaryRoot = await createTemporaryRoot('agent-vm-e2e-harness-');
		const smokeCacheRoot = path.join(temporaryRoot, 'shared-smoke-cache');
		process.env.AGENT_VM_E2E_CACHE_DIR = smokeCacheRoot;
		try {
			const hermesProject = await scaffoldHermesE2eProject({
				agents: ['main'],
				architecture: 'aarch64',
				prefix: 'agent-vm-gateway-e2e-project-',
				zoneId: 'hermes-smoke',
			});
			const workerProject = await scaffoldWorkerE2eProject({
				architecture: 'aarch64',
				prefix: 'worker-loop-e2e-',
				zoneId: 'worker-e2e',
			});
			temporaryRoots.push(hermesProject.tempRoot, workerProject.tempRoot);

			expect(hermesProject.systemConfig.cacheDir).toBe(path.join(smokeCacheRoot, 'hermes'));
			expect(workerProject.systemConfig.cacheDir).toBe(path.join(smokeCacheRoot, 'worker'));
			expect(hermesProject.systemConfig.cacheDir).not.toContain(hermesProject.tempRoot);
			expect(workerProject.systemConfig.cacheDir).not.toContain(workerProject.tempRoot);
		} finally {
			if (previousSmokeCacheRoot === undefined) {
				delete process.env.AGENT_VM_E2E_CACHE_DIR;
			} else {
				process.env.AGENT_VM_E2E_CACHE_DIR = previousSmokeCacheRoot;
			}
		}
	});

	it('keeps generated e2e runtime and state paths inside owned temp project roots', async () => {
		const hermesProject = await scaffoldHermesE2eProject({
			agents: ['main'],
			architecture: 'aarch64',
			prefix: 'agent-vm-gateway-e2e-project-',
			zoneId: 'hermes-smoke',
		});
		const workerProject = await scaffoldWorkerE2eProject({
			architecture: 'aarch64',
			prefix: 'worker-loop-e2e-',
			zoneId: 'worker-e2e',
		});
		temporaryRoots.push(hermesProject.tempRoot, workerProject.tempRoot);

		for (const project of [hermesProject, workerProject]) {
			expect(path.resolve(project.systemConfig.storageRootDir)).toContain(
				path.resolve(project.tempRoot),
			);
			for (const zone of project.systemConfig.zones) {
				expect(path.resolve(zone.gateway.stateDir)).toContain(path.resolve(project.tempRoot));
				expect(path.resolve(zone.gateway.config)).toContain(path.resolve(project.tempRoot));
			}
		}
	});

	it('computes the same gateway image fingerprint for equivalent temp deployments', async () => {
		const firstProject = await scaffoldWorkerE2eProject({
			architecture: 'aarch64',
			prefix: 'worker-loop-e2e-',
			zoneId: 'worker-e2e',
		});
		const secondProject = await scaffoldWorkerE2eProject({
			architecture: 'aarch64',
			prefix: 'worker-loop-e2e-',
			zoneId: 'worker-e2e',
		});
		temporaryRoots.push(firstProject.tempRoot, secondProject.tempRoot);
		const firstBuildConfigPath = path.join(
			firstProject.tempRoot,
			'vm-images',
			'gateways',
			'worker',
			'build-config.jsonc',
		);
		const secondBuildConfigPath = path.join(
			secondProject.tempRoot,
			'vm-images',
			'gateways',
			'worker',
			'build-config.jsonc',
		);

		const firstFingerprint = await computeFingerprintFromConfigPath(firstBuildConfigPath);
		const secondFingerprint = await computeFingerprintFromConfigPath(secondBuildConfigPath);

		expect(firstProject.tempRoot).not.toBe(secondProject.tempRoot);
		expect(firstFingerprint).toBe(secondFingerprint);
	});

	it('dispatches through the typed Hermes gateway smoke project scaffold', async () => {
		const project = await scaffoldHermesE2eProject({
			agents: ['smoke-agent'],
			architecture: 'aarch64',
			prefix: 'agent-vm-gateway-e2e-project-',
			zoneId: 'smoke-zone',
		});
		temporaryRoots.push(project.tempRoot);

		expect(project.zone.gateway.type).toBe('hermes');
		expect(project.systemConfig.zones[0]?.agents).toEqual([{ id: 'smoke-agent' }]);
	});

	it('materializes the local Hermes image overlay into a newly scaffolded Docker context', async () => {
		const project = await scaffoldHermesE2eProject({
			agents: ['main', 'beta'],
			architecture: 'aarch64',
			prefix: 'hermes-managed-base-environment-e2e-',
			zoneId: 'hermes-smoke',
		});
		temporaryRoots.push(project.tempRoot);
		expect(Object.keys(project.systemConfig.imageProfiles.gateways)).toEqual(['hermes']);
		const gatewayProfile = project.systemConfig.imageProfiles.gateways.hermes;
		if (gatewayProfile === undefined) {
			throw new Error('Expected the Hermes E2E image profile.');
		}
		const localArtifactDirectory = path.join(
			path.dirname(gatewayProfile.buildConfig),
			'local-agent-vm',
		);
		await expect(fs.access(localArtifactDirectory)).rejects.toThrow();

		await materializeLocalHermesGatewayImagePackages({
			architecture: 'aarch64',
			profileName: project.zone.gateway.imageProfile,
			projectRoot: project.tempRoot,
			repoRoot: process.cwd(),
			systemConfig: project.systemConfig,
		});

		const localArtifactFileNames = await fs.readdir(localArtifactDirectory);
		expect(localArtifactFileNames).toContain('package.json');
		expect(localArtifactFileNames.some((fileName) => fileName.endsWith('.tgz'))).toBe(true);
		expect(
			localArtifactFileNames.some(
				(fileName) => fileName.startsWith('agent_vm_hermes_adapter-') && fileName.endsWith('.whl'),
			),
		).toBe(true);
		await expect(
			fs.readFile(path.join(path.dirname(gatewayProfile.buildConfig), 'Dockerfile'), 'utf8'),
		).resolves.toContain('agent_vm_hermes_adapter');
	});

	it('renders safe shared Hermes policy for the managed environment E2E', () => {
		const configuration = renderHermesManagedE2eConfiguration({
			contextLength: 65_536,
			fakeModelHost: 'model.vm.host',
			fakeModelName: 'hermes-e2e',
		});

		expect(configuration).toContain('    - agent-vm-tool-portal');
		expect(configuration).toContain('  context_length: 65536');
		expect(configuration).toContain(
			'fallback_providers:\n  - provider: custom:hermes-e2e\n    model: hermes-e2e',
		);
		expect(configuration).toContain('provider_routing:\n  order:\n    - hermes-e2e');
		expect(configuration).not.toContain('api_key:');
		expect(configuration).not.toContain('webhook');
		expect(configuration).not.toContain('multiplex_profiles');
		expect(configuration).not.toContain('preserve_existing');
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

		await useLocalToolVmMcpPortalPackage({
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
			'COPY agent-vm-config-contracts-0.0.0-smoke.tgz /tmp/agent-vm-config-contracts-0.0.0-smoke.tgz',
		);
		expect(toolVmDockerfile).toContain(
			'COPY agent-vm-secret-management-0.0.0-smoke.tgz /tmp/agent-vm-secret-management-0.0.0-smoke.tgz',
		);
		expect(toolVmDockerfile).toContain(
			'COPY agent-vm-mcp-portal-0.0.0-smoke.tgz /tmp/agent-vm-mcp-portal-0.0.0-smoke.tgz',
		);
		expect(toolVmDockerfile).toContain('pnpm install --prod --ignore-scripts');
		expect(toolVmDockerfile).toContain('@agent-vm/config-contracts');
		expect(toolVmDockerfile).toContain('file:/tmp/agent-vm-config-contracts-0.0.0-smoke.tgz');
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
				await fs.writeFile(path.join(reusableImageDirectory, fileName), `${fileName}\n`, 'utf8');
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
		).resolves.toBe('manifest.json\n');
	});
});

describe('prepareGatewayE2eProjectImages', () => {
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
					/^local-agent-vm\/agent-vm-(?:agent-portal-sdk|config-contracts|secret-management|mcp-portal)-/u.test(
						copyEntry.from,
					),
				),
			).toHaveLength(4);
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

	it('seeds reusable gateway images before running the build command once for the project', async () => {
		const previousSmokeCacheRoot = process.env.AGENT_VM_E2E_CACHE_DIR;
		const temporaryRoot = await createTemporaryRoot('agent-vm-e2e-harness-');
		const smokeCacheRoot = path.join(temporaryRoot, 'shared-smoke-cache');
		const project = await scaffoldWorkerE2eProject({
			architecture: 'aarch64',
			prefix: 'worker-loop-e2e-',
			zoneId: 'worker-e2e',
		});
		temporaryRoots.push(project.tempRoot);
		const gatewayBuildConfigPath = project.systemConfig.imageProfiles.gateways.worker?.buildConfig;
		if (gatewayBuildConfigPath === undefined) {
			throw new Error('Expected worker gateway image profile.');
		}
		const fingerprint = await computeFingerprintFromConfigPath(gatewayBuildConfigPath);
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
				await fs.writeFile(path.join(reusableImageDirectory, fileName), `${fileName}\n`, 'utf8');
			}),
		);
		const buildConfigs: LoadedSystemConfig[] = [];
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
		).resolves.toBe('manifest.json\n');
	});

	it('materializes prepared records from the e2e manifest for an equivalent temp deployment', async () => {
		const temporaryRoot = await createTemporaryRoot('agent-vm-e2e-harness-');
		const smokeCacheRoot = path.join(temporaryRoot, 'shared-smoke-cache');
		const firstProject = await scaffoldWorkerE2eProject({
			architecture: 'aarch64',
			prefix: 'worker-loop-e2e-',
			zoneId: 'worker-e2e',
		});
		const secondProject = await scaffoldWorkerE2eProject({
			architecture: 'aarch64',
			prefix: 'worker-loop-e2e-',
			zoneId: 'worker-e2e',
		});
		temporaryRoots.push(firstProject.tempRoot, secondProject.tempRoot);
		const previousSmokeCacheRoot = process.env.AGENT_VM_E2E_CACHE_DIR;
		const previousRequirePreparedImageCache = process.env.AGENT_VM_E2E_REQUIRE_PREPARED_IMAGE_CACHE;
		process.env.AGENT_VM_E2E_CACHE_DIR = smokeCacheRoot;
		const buildConfigs: LoadedSystemConfig[] = [];
		try {
			Object.assign(firstProject.systemConfig, { cacheDir: path.join(smokeCacheRoot, 'worker') });
			Object.assign(secondProject.systemConfig, { cacheDir: path.join(smokeCacheRoot, 'worker') });
			await Promise.all(
				[firstProject, secondProject].map(async (project) => {
					const gatewayProfile = project.systemConfig.imageProfiles.gateways.worker;
					if (gatewayProfile === undefined) {
						throw new Error('Expected worker gateway image profile.');
					}
					const dockerContextDirectory = path.join(project.tempRoot, 'docker-context', 'worker');
					await fs.mkdir(dockerContextDirectory, { recursive: true });
					await fs.writeFile(
						path.join(dockerContextDirectory, 'Dockerfile'),
						'FROM scratch\n',
						'utf8',
					);
					gatewayProfile.dockerfile = path.join(dockerContextDirectory, 'Dockerfile');
					delete gatewayProfile.source;
				}),
			);
			delete process.env.AGENT_VM_E2E_REQUIRE_PREPARED_IMAGE_CACHE;
			await prepareGatewayE2eProjectImages({
				project: firstProject,
				runBuild: async ({ systemConfig }) => {
					buildConfigs.push(systemConfig);
					await Promise.all(
						Object.entries(systemConfig.imageProfiles.gateways).map(
							async ([profileName, profile]) => {
								const fingerprint = await computeFingerprintFromConfigPath(profile.buildConfig);
								const cacheDir = sharedImageCacheDirForSystemConfig(systemConfig);
								const imagePath = path.join(cacheDir, fingerprint);
								await fs.mkdir(imagePath, { recursive: true });
								await Promise.all(
									managedVmImageAssetFileNames.map(
										async (fileName) =>
											await fs.writeFile(path.join(imagePath, fileName), `${fileName}\n`, 'utf8'),
									),
								);
								await writePreparedManagedVmImage({
									buildConfigPath: profile.buildConfig,
									fingerprint,
									imagePath,
									selectionRecordPath: e2eSelectionRecordPath(systemConfig, 'gateway', profileName),
									sharedImageCacheDir: cacheDir,
								});
							},
						),
					);
				},
			});
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

		const secondGatewayProfile = secondProject.systemConfig.imageProfiles.gateways.worker;
		if (secondGatewayProfile === undefined) {
			throw new Error('Expected worker gateway image profile.');
		}
		const secondPreparedImage = await readPreparedManagedVmImage({
			buildConfigPath: secondGatewayProfile.buildConfig,
			selectionRecordPath: e2eSelectionRecordPath(secondProject.systemConfig, 'gateway', 'worker'),
			sharedImageCacheDir: sharedImageCacheDirForSystemConfig(secondProject.systemConfig),
		});

		expect(buildConfigs).toEqual([firstProject.systemConfig]);
		expect(secondPreparedImage?.built).toBe(false);
		expect(secondPreparedImage?.fingerprint).toBe(
			await computeFingerprintFromConfigPath(secondGatewayProfile.buildConfig),
		);
	});

	it('fails before image build when strict prepared-image reuse is required but absent', async () => {
		const previousSmokeCacheRoot = process.env.AGENT_VM_E2E_CACHE_DIR;
		const previousRequirePreparedImageCache = process.env.AGENT_VM_E2E_REQUIRE_PREPARED_IMAGE_CACHE;
		const temporaryRoot = await createTemporaryRoot('agent-vm-e2e-harness-');
		const smokeCacheRoot = path.join(temporaryRoot, 'shared-smoke-cache');
		const project = await scaffoldWorkerE2eProject({
			architecture: 'aarch64',
			prefix: 'worker-loop-e2e-',
			zoneId: 'worker-e2e',
		});
		temporaryRoots.push(project.tempRoot);
		const gatewayProfile = project.systemConfig.imageProfiles.gateways.worker;
		if (gatewayProfile === undefined) {
			throw new Error('Expected Worker gateway image profile.');
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

	it('reuses a gateway-only manifest for equivalent managed-source Worker images', async () => {
		const previousSmokeCacheRoot = process.env.AGENT_VM_E2E_CACHE_DIR;
		const previousRequirePreparedImageCache = process.env.AGENT_VM_E2E_REQUIRE_PREPARED_IMAGE_CACHE;
		const temporaryRoot = await createTemporaryRoot('agent-vm-e2e-harness-');
		const smokeCacheRoot = path.join(temporaryRoot, 'shared-smoke-cache');
		const firstProject = await scaffoldWorkerE2eProject({
			architecture: 'aarch64',
			prefix: 'worker-loop-e2e-',
			zoneId: 'worker-e2e',
		});
		const secondProject = await scaffoldWorkerE2eProject({
			architecture: 'aarch64',
			prefix: 'worker-loop-e2e-',
			zoneId: 'worker-e2e',
		});
		temporaryRoots.push(firstProject.tempRoot, secondProject.tempRoot);
		for (const project of [firstProject, secondProject]) {
			Object.assign(project.systemConfig, { cacheDir: path.join(smokeCacheRoot, 'worker') });
			const gatewayProfile = project.systemConfig.imageProfiles.gateways.worker;
			if (gatewayProfile === undefined) {
				throw new Error('Expected worker gateway image profile.');
			}
			gatewayProfile.source = { base: 'worker-gateway', kind: 'managedBase' };
		}
		process.env.AGENT_VM_E2E_CACHE_DIR = smokeCacheRoot;
		delete process.env.AGENT_VM_E2E_REQUIRE_PREPARED_IMAGE_CACHE;
		const buildConfigs: LoadedSystemConfig[] = [];
		try {
			await prepareGatewayE2eProjectImages({
				imageFamilies: ['gateway'],
				project: firstProject,
				runBuild: async ({ systemConfig }) => {
					buildConfigs.push(systemConfig);
					const gatewayProfile = systemConfig.imageProfiles.gateways.worker;
					if (gatewayProfile === undefined) {
						throw new Error('Expected worker gateway image profile.');
					}
					const fingerprint = await computeFingerprintFromConfigPath(gatewayProfile.buildConfig);
					const cacheDir = sharedImageCacheDirForSystemConfig(systemConfig);
					const imagePath = path.join(cacheDir, fingerprint);
					await fs.mkdir(imagePath, { recursive: true });
					await Promise.all(
						managedVmImageAssetFileNames.map(
							async (fileName) =>
								await fs.writeFile(
									path.join(imagePath, fileName),
									fileName + String.fromCharCode(10),
									'utf8',
								),
						),
					);
					await writePreparedManagedVmImage({
						buildConfigPath: gatewayProfile.buildConfig,
						fingerprint,
						imagePath,
						selectionRecordPath: e2eSelectionRecordPath(systemConfig, 'gateway', 'worker'),
						sharedImageCacheDir: cacheDir,
					});
				},
			});
			process.env.AGENT_VM_E2E_REQUIRE_PREPARED_IMAGE_CACHE = '1';
			await prepareGatewayE2eProjectImages({
				imageFamilies: ['gateway'],
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

		expect(buildConfigs).toEqual([firstProject.systemConfig]);
		const secondGatewayProfile = secondProject.systemConfig.imageProfiles.gateways.worker;
		if (secondGatewayProfile === undefined) {
			throw new Error('Expected worker gateway image profile.');
		}
		await expect(
			readPreparedManagedVmImage({
				buildConfigPath: secondGatewayProfile.buildConfig,
				selectionRecordPath: e2eSelectionRecordPath(
					secondProject.systemConfig,
					'gateway',
					'worker',
				),
				sharedImageCacheDir: sharedImageCacheDirForSystemConfig(secondProject.systemConfig),
			}),
		).resolves.toMatchObject({ built: false });
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
									fileName + String.fromCharCode(10),
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
									fileName + String.fromCharCode(10),
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

	it('does not reuse a prepared Worker image when the expected managed Gateway boot projection changes', async () => {
		const temporaryRoot = await createTemporaryRoot('agent-vm-e2e-harness-');
		const smokeCacheRoot = path.join(temporaryRoot, 'shared-smoke-cache');
		const sharedBuildConfigPath = path.join(temporaryRoot, 'shared-build-config.jsonc');
		const sharedDockerContextDirectory = path.join(temporaryRoot, 'shared-docker-context');
		const sharedDockerfilePath = path.join(sharedDockerContextDirectory, 'Dockerfile');
		await fs.mkdir(sharedDockerContextDirectory, { recursive: true });
		await fs.writeFile(
			sharedBuildConfigPath,
			`${JSON.stringify({
				alpine: {
					kernelImage: 'vmlinuz-virt',
					kernelPackage: 'linux-virt',
					rootfsPackages: [],
					version: '3.23.0',
				},
				arch: 'aarch64',
				distro: 'alpine',
				rootfs: { label: 'gondolin-root', sizeMb: 2_048 },
			})}\n`,
			'utf8',
		);
		await fs.writeFile(sharedDockerfilePath, 'FROM scratch\n', 'utf8');
		const workerProject = await scaffoldWorkerE2eProject({
			architecture: 'aarch64',
			prefix: 'worker-loop-e2e-',
			zoneId: 'worker-e2e',
		});
		const hermesProject = await scaffoldHermesE2eProject({
			agents: ['main'],
			architecture: 'aarch64',
			prefix: 'agent-vm-gateway-e2e-project-',
			zoneId: 'hermes-e2e',
		});
		temporaryRoots.push(workerProject.tempRoot, hermesProject.tempRoot);
		for (const project of [workerProject, hermesProject]) {
			Object.assign(project.systemConfig, { cacheDir: smokeCacheRoot });
			project.systemConfig.imageProfiles.toolVms = {};
		}
		const workerProfile = workerProject.systemConfig.imageProfiles.gateways.worker;
		const hermesProfile = hermesProject.systemConfig.imageProfiles.gateways.hermes;
		const workerZone = workerProject.systemConfig.zones[0];
		const hermesZone = hermesProject.systemConfig.zones[0];
		if (
			workerProfile === undefined ||
			hermesProfile === undefined ||
			workerZone === undefined ||
			hermesZone === undefined
		) {
			throw new Error('Expected Worker and Hermes e2e fixtures.');
		}
		workerProfile.buildConfig = sharedBuildConfigPath;
		workerProfile.dockerfile = sharedDockerfilePath;
		delete workerProfile.source;
		hermesProfile.buildConfig = sharedBuildConfigPath;
		hermesProfile.dockerfile = sharedDockerfilePath;
		delete hermesProfile.source;
		workerProject.systemConfig.imageProfiles.gateways = { shared: workerProfile };
		hermesProject.systemConfig.imageProfiles.gateways = { shared: hermesProfile };
		workerZone.gateway.imageProfile = 'shared';
		hermesZone.gateway.imageProfile = 'shared';
		const builtGatewayTypes: string[] = [];
		const runBuild = async ({
			systemConfig,
		}: {
			readonly systemConfig: LoadedSystemConfig;
		}): Promise<void> => {
			const profile = systemConfig.imageProfiles.gateways.shared;
			if (profile === undefined) throw new Error('Expected shared gateway profile.');
			builtGatewayTypes.push(profile.type);
			const managedGatewayBoot =
				profile.type === 'hermes'
					? {
							frameworkBootEntry: 'hermes-framework-service' as const,
							kind: 'managed-gateway-exact-two-role' as const,
						}
					: undefined;
			const fingerprint = await computeFingerprintFromConfigPath(
				profile.buildConfig,
				managedGatewayBoot === undefined ? {} : { managedGatewayBoot },
			);
			const cacheDir = sharedImageCacheDirForSystemConfig(systemConfig);
			const imagePath = path.join(cacheDir, fingerprint);
			await fs.mkdir(imagePath, { recursive: true });
			await Promise.all(
				managedVmImageAssetFileNames.map(
					async (fileName) =>
						await fs.writeFile(path.join(imagePath, fileName), `${fileName}\n`, 'utf8'),
				),
			);
			await writePreparedManagedVmImage({
				buildConfigPath: profile.buildConfig,
				fingerprint,
				imagePath,
				...(managedGatewayBoot === undefined ? {} : { managedGatewayBoot }),
				selectionRecordPath: e2eSelectionRecordPath(systemConfig, 'gateway', 'shared'),
				sharedImageCacheDir: cacheDir,
			});
		};

		await prepareGatewayE2eProjectImages({ project: workerProject, runBuild });
		await prepareGatewayE2eProjectImages({ project: hermesProject, runBuild });

		expect(builtGatewayTypes).toEqual(['worker', 'hermes']);
	});

	it('does not materialize managed-source profiles from the e2e manifest', async () => {
		const temporaryRoot = await createTemporaryRoot('agent-vm-e2e-harness-');
		const smokeCacheRoot = path.join(temporaryRoot, 'shared-smoke-cache');
		const firstProject = await scaffoldWorkerE2eProject({
			architecture: 'aarch64',
			prefix: 'worker-loop-e2e-',
			zoneId: 'worker-e2e',
		});
		const secondProject = await scaffoldWorkerE2eProject({
			architecture: 'aarch64',
			prefix: 'worker-loop-e2e-',
			zoneId: 'worker-e2e',
		});
		temporaryRoots.push(firstProject.tempRoot, secondProject.tempRoot);
		Object.assign(firstProject.systemConfig, { cacheDir: path.join(smokeCacheRoot, 'worker') });
		Object.assign(secondProject.systemConfig, { cacheDir: path.join(smokeCacheRoot, 'worker') });
		for (const project of [firstProject, secondProject]) {
			const gatewayProfile = project.systemConfig.imageProfiles.gateways.worker;
			if (gatewayProfile === undefined) {
				throw new Error('Expected worker gateway image profile.');
			}
			gatewayProfile.source = { base: 'worker-gateway', kind: 'managedBase' };
		}
		const previousSmokeCacheRoot = process.env.AGENT_VM_E2E_CACHE_DIR;
		process.env.AGENT_VM_E2E_CACHE_DIR = smokeCacheRoot;
		const buildConfigs: LoadedSystemConfig[] = [];
		try {
			for (const project of [firstProject, secondProject]) {
				// oxlint-disable-next-line no-await-in-loop -- the second call must observe the first call's manifest output.
				await prepareGatewayE2eProjectImages({
					project,
					runBuild: async ({ systemConfig }) => {
						buildConfigs.push(systemConfig);
						await Promise.all(
							Object.entries(systemConfig.imageProfiles.gateways).map(
								async ([profileName, profile]) => {
									const fingerprint = await computeFingerprintFromConfigPath(profile.buildConfig);
									const cacheDir = sharedImageCacheDirForSystemConfig(systemConfig);
									const imagePath = path.join(cacheDir, fingerprint);
									await fs.mkdir(imagePath, { recursive: true });
									await Promise.all(
										managedVmImageAssetFileNames.map(
											async (fileName) =>
												await fs.writeFile(path.join(imagePath, fileName), `${fileName}\n`, 'utf8'),
										),
									);
									await writePreparedManagedVmImage({
										buildConfigPath: profile.buildConfig,
										fingerprint,
										imagePath,
										selectionRecordPath: e2eSelectionRecordPath(
											systemConfig,
											'gateway',
											profileName,
										),
										sharedImageCacheDir: cacheDir,
									});
								},
							),
						);
					},
				});
			}
		} finally {
			if (previousSmokeCacheRoot === undefined) {
				delete process.env.AGENT_VM_E2E_CACHE_DIR;
			} else {
				process.env.AGENT_VM_E2E_CACHE_DIR = previousSmokeCacheRoot;
			}
		}

		expect(buildConfigs).toEqual([firstProject.systemConfig, secondProject.systemConfig]);
	});
});

describe('prepareLocalWorkerPackageForGatewayImage', () => {
	it('canonicalizes independently generated workspace package archives', async () => {
		const previousSmokeCacheRoot = process.env.AGENT_VM_E2E_CACHE_DIR;
		const temporaryRoot = await createTemporaryRoot('agent-vm-package-archive-');
		const firstCacheRoot = path.join(temporaryRoot, 'first-cache');
		const secondCacheRoot = path.join(temporaryRoot, 'second-cache');
		let firstTarballPath = '';
		let secondTarballPath = '';
		try {
			process.env.AGENT_VM_E2E_CACHE_DIR = firstCacheRoot;
			firstTarballPath = await packLocalAgentVmPackageTarball({
				packageName: 'gateway-runtime',
				repoRoot: process.cwd(),
			});
			process.env.AGENT_VM_E2E_CACHE_DIR = secondCacheRoot;
			secondTarballPath = await packLocalAgentVmPackageTarball({
				packageName: 'gateway-runtime',
				repoRoot: process.cwd(),
			});
		} finally {
			if (previousSmokeCacheRoot === undefined) {
				delete process.env.AGENT_VM_E2E_CACHE_DIR;
			} else {
				process.env.AGENT_VM_E2E_CACHE_DIR = previousSmokeCacheRoot;
			}
		}

		expect(await fs.readFile(firstTarballPath)).toEqual(await fs.readFile(secondTarballPath));
	});

	it('preserves conditional export ordering while canonicalizing package dependencies', async () => {
		const previousSmokeCacheRoot = process.env.AGENT_VM_E2E_CACHE_DIR;
		const temporaryRoot = await createTemporaryRoot('agent-vm-package-exports-');
		process.env.AGENT_VM_E2E_CACHE_DIR = path.join(temporaryRoot, 'e2e-cache');
		try {
			const tarballPath = await packLocalAgentVmPackageTarball({
				packageName: 'agent-vm',
				repoRoot: process.cwd(),
			});
			const { stdout } = await execFileAsync(
				'tar',
				['-xOzf', tarballPath, 'package/package.json'],
				{ encoding: 'utf8' },
			);
			const packedManifest = JSON.parse(stdout) as { readonly exports: unknown };
			const sourceManifest = JSON.parse(
				await fs.readFile(path.join(process.cwd(), 'packages', 'agent-vm', 'package.json'), 'utf8'),
			) as { readonly exports: unknown };
			expect(JSON.stringify(packedManifest.exports)).toBe(JSON.stringify(sourceManifest.exports));
		} finally {
			if (previousSmokeCacheRoot === undefined) {
				delete process.env.AGENT_VM_E2E_CACHE_DIR;
			} else {
				process.env.AGENT_VM_E2E_CACHE_DIR = previousSmokeCacheRoot;
			}
		}
	});

	it('caches the local worker package outside the repo and reuses the generated tarball path', async () => {
		const previousSmokeCacheRoot = process.env.AGENT_VM_E2E_CACHE_DIR;
		const temporaryRoot = await createTemporaryRoot('agent-vm-worker-pack-');
		const smokeCacheRoot = path.join(temporaryRoot, 'e2e-cache');
		const workerPackageDir = path.join(temporaryRoot, 'packages', 'agent-vm-worker');
		await fs.mkdir(workerPackageDir, { recursive: true });
		await fs.writeFile(
			path.join(workerPackageDir, 'package.json'),
			JSON.stringify(
				{
					name: '@agent-vm/fake-worker-pack-fixture',
					version: '0.0.0',
					files: ['index.js'],
				},
				null,
				2,
			),
		);
		await fs.writeFile(path.join(workerPackageDir, 'index.js'), 'export {};\n');

		process.env.AGENT_VM_E2E_CACHE_DIR = smokeCacheRoot;
		let tarballPath = '';
		let secondTarballPath = '';
		try {
			tarballPath = await prepareLocalWorkerPackageForGatewayImage(temporaryRoot);
			secondTarballPath = await prepareLocalWorkerPackageForGatewayImage(temporaryRoot);
		} finally {
			if (previousSmokeCacheRoot === undefined) {
				delete process.env.AGENT_VM_E2E_CACHE_DIR;
			} else {
				process.env.AGENT_VM_E2E_CACHE_DIR = previousSmokeCacheRoot;
			}
		}
		const repoLocalTmp = path.join(temporaryRoot, 'tmp');
		const packedFiles = await fs.readdir(path.dirname(tarballPath));

		expect(secondTarballPath).toBe(tarballPath);
		expect(path.resolve(tarballPath).startsWith(path.resolve(repoLocalTmp))).toBe(false);
		expect(path.resolve(tarballPath).startsWith(path.resolve(smokeCacheRoot))).toBe(true);
		await expect(fs.access(repoLocalTmp)).rejects.toMatchObject({ code: 'ENOENT' });
		expect(path.basename(tarballPath)).toBe('agent-vm-fake-worker-pack-fixture-0.0.0.tgz');
		expect(packedFiles).toEqual(['agent-vm-fake-worker-pack-fixture-0.0.0.tgz']);

		await removeE2eLocalPackageTarballs([tarballPath]);
		await expect(fs.access(tarballPath)).resolves.toBeUndefined();
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
	await createFakeSimplePackage(repoRoot, 'agent-portal-sdk');
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
