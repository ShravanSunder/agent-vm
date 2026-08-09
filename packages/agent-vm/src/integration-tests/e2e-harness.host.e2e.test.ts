import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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
	readPreparedManagedVmImage,
	writePreparedManagedVmImage,
} from '../build/prepared-gondolin-image-cache.js';
import type { LoadedSystemConfig } from '../config/system-config.js';
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
	disableOpenClawMcpPortalPlugin,
	findReusableGatewayImageDirectory,
	prepareGatewayE2eProjectImages,
	prepareLocalWorkerPackageForGatewayImage,
	removeE2eLocalPackageTarballs,
	removeE2eDockerImagesForSystemConfig,
	removeE2eTempRoot,
	resolveLocalPackagePackArgs,
	scaffoldGatewayE2eProject,
	scaffoldOpenClawE2eProject,
	scaffoldWorkerE2eProject,
	seedGatewayImageCacheIfAvailable,
	shouldCleanupE2eDockerImages,
	shouldRunWorkerGatewayE2e,
	useLocalOpenClawGatewayImagePackages,
	useLocalOpenClawPluginGatewayImage,
	useLocalToolVmMcpPortalPackage,
} from './e2e-harness.js';
import {
	renderHermesManagedE2eConfiguration,
	scaffoldHermesE2eProject,
	useLocalHermesGatewayImagePackages,
} from './hermes-e2e-harness.js';

const temporaryRoots: string[] = [];
const normalizedDockerContextTimestampMs = Date.UTC(2000, 0, 1, 0, 0, 0, 0);
const testManagedGatewayBootContract = createManagedGatewayBootContract({
	bootEntry: 'openclaw-gateway',
	configurationInputPath: '/run/agent-vm/managed-gateway/framework-service.json',
	environmentInputPath: '/run/agent-vm/managed-gateway/framework.environment.sh',
	framework: 'openclaw',
	ingress: { guestPort: 18_789, kind: 'framework-http' },
	logIdentity: {
		guestPath: '/var/log/agent-vm/openclaw-service.log',
		serviceName: 'agent-vm-openclaw-test',
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
		clientKind: 'openclaw-managed-plugin',
		configuredAgentIds: ['smoke'],
		frameworkEpoch: 'openclaw-framework-smoke',
		frameworkKind: 'openclaw',
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
		frameworkEpoch: 'openclaw-framework-smoke',
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

describe('shouldRunWorkerGatewayE2e', () => {
	it('requires explicit opt-in even when credentials and commands are available', async () => {
		expect(
			await shouldRunWorkerGatewayE2e({
				architecture: 'aarch64',
				commandExists: () => true,
				env: { AGENT_VM_TEST_OPENAI_API_KEY: 'test-token' },
				resolveRequiredZigVersion: async () => '0.16.0',
				resolveZigVersion: async () => '0.16.0',
			}),
		).toBe(false);
	});

	it('requires a model credential when explicitly enabled', async () => {
		expect(
			await shouldRunWorkerGatewayE2e({
				architecture: 'aarch64',
				commandExists: () => true,
				env: { AGENT_VM_WORKER_E2E: '1' },
				resolveRequiredZigVersion: async () => '0.16.0',
				resolveZigVersion: async () => '0.16.0',
			}),
		).toBe(false);
	});

	it('requires QEMU and Docker when explicitly enabled', async () => {
		expect(
			await shouldRunWorkerGatewayE2e({
				architecture: 'aarch64',
				commandExists: (command) => command !== 'docker',
				env: {
					AGENT_VM_WORKER_E2E: '1',
					AGENT_VM_TEST_OPENAI_API_KEY: 'test-token',
				},
				resolveRequiredZigVersion: async () => '0.16.0',
				resolveZigVersion: async () => '0.16.0',
			}),
		).toBe(false);
	});

	it('requires a compatible Zig version when explicitly enabled', async () => {
		expect(
			await shouldRunWorkerGatewayE2e({
				architecture: 'aarch64',
				commandExists: () => true,
				env: {
					AGENT_VM_WORKER_E2E: '1',
					AGENT_VM_TEST_OPENAI_API_KEY: 'test-token',
				},
				resolveRequiredZigVersion: async () => '0.16.0',
				resolveZigVersion: async () => '0.15.2',
			}),
		).toBe(false);
	});

	it('allows the worker gateway smoke when opt-in, credentials, commands, and Zig are compatible', async () => {
		expect(
			await shouldRunWorkerGatewayE2e({
				architecture: 'aarch64',
				commandExists: () => true,
				env: {
					AGENT_VM_WORKER_E2E: '1',
					AGENT_VM_TEST_OPENAI_API_KEY: 'test-token',
				},
				resolveRequiredZigVersion: async () => '0.16.0',
				resolveZigVersion: async () => '0.16.0',
			}),
		).toBe(true);
	});
});

describe('scaffoldGatewayE2eProject', () => {
	it('uses a shared smoke cache root instead of rebuilding images under each temp project', async () => {
		const previousSmokeCacheRoot = process.env.AGENT_VM_E2E_CACHE_DIR;
		const temporaryRoot = await createTemporaryRoot('agent-vm-e2e-harness-');
		const smokeCacheRoot = path.join(temporaryRoot, 'shared-smoke-cache');
		process.env.AGENT_VM_E2E_CACHE_DIR = smokeCacheRoot;
		try {
			const openClawProject = await scaffoldOpenClawE2eProject({
				architecture: 'aarch64',
				prefix: 'openclaw-control-link-e2e-',
				zoneId: 'openclaw-smoke',
			});
			const workerProject = await scaffoldWorkerE2eProject({
				architecture: 'aarch64',
				prefix: 'worker-loop-e2e-',
				zoneId: 'worker-e2e',
			});
			temporaryRoots.push(openClawProject.tempRoot, workerProject.tempRoot);

			expect(openClawProject.systemConfig.cacheDir).toBe(path.join(smokeCacheRoot, 'openclaw'));
			expect(workerProject.systemConfig.cacheDir).toBe(path.join(smokeCacheRoot, 'worker'));
			expect(openClawProject.systemConfig.cacheDir).not.toContain(openClawProject.tempRoot);
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
		const openClawProject = await scaffoldOpenClawE2eProject({
			architecture: 'aarch64',
			prefix: 'openclaw-control-link-e2e-',
			zoneId: 'openclaw-smoke',
		});
		const workerProject = await scaffoldWorkerE2eProject({
			architecture: 'aarch64',
			prefix: 'worker-loop-e2e-',
			zoneId: 'worker-e2e',
		});
		temporaryRoots.push(openClawProject.tempRoot, workerProject.tempRoot);

		for (const project of [openClawProject, workerProject]) {
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

	it('dispatches through the typed OpenClaw gateway smoke project scaffold', async () => {
		const project = await scaffoldGatewayE2eProject({
			agents: ['smoke-agent'],
			architecture: 'aarch64',
			kind: 'openclaw',
			prefix: 'agent-vm-gateway-e2e-project-',
			zoneId: 'smoke-zone',
		});
		temporaryRoots.push(project.tempRoot);

		expect(project.zone.gateway.type).toBe('openclaw');
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

		await useLocalHermesGatewayImagePackages({
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
		const systemConfig = createMinimalOpenClawSystemConfig();
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected smoke system config to contain a zone.');
		}

		const harness = await startE2eControllerRuntime({
			secrets: {
				AGENT_VM_TEST_OPENAI_API_KEY: 'test-service-account-token',
				OPENCLAW_GATEWAY_TOKEN: 'test-gateway-token',
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
		const systemConfig = createMinimalOpenClawSystemConfig(temporaryRoot);
		const zone = systemConfig.zones[0];
		if (!zone || zone.gateway.type !== 'openclaw') {
			throw new Error('Expected smoke system config to contain an OpenClaw zone.');
		}

		const harness = await startE2eControllerRuntime({
			secrets: {
				AGENT_VM_TEST_OPENAI_API_KEY: 'test-service-account-token',
				OPENCLAW_GATEWAY_TOKEN: 'test-gateway-token',
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
		const systemConfig = createMinimalOpenClawSystemConfig(temporaryRoot);
		const zone = systemConfig.zones[0];
		if (!zone || zone.gateway.type !== 'openclaw') {
			throw new Error('Expected smoke system config to contain an OpenClaw zone.');
		}

		const harness = await startE2eControllerRuntime({
			secrets: {
				AGENT_VM_TEST_OPENAI_API_KEY: 'test-service-account-token',
				OPENCLAW_GATEWAY_TOKEN: 'test-gateway-token',
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

	it('removes OpenClaw control-link smoke temp roots', async () => {
		const temporaryRoot = await createTemporaryRoot('openclaw-control-link-e2e-');

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
		const systemConfig = createMinimalOpenClawSystemConfig(temporaryRoot);
		const gatewayProfile = systemConfig.imageProfiles.gateways.openclaw;
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

	it('writes a local OpenClaw gateway smoke Dockerfile without the old MCP Portal plugin identity', async () => {
		const temporaryRoot = await createTemporaryRoot('agent-vm-e2e-harness-');
		const repoRoot = path.join(temporaryRoot, 'repo');
		const systemConfig = createMinimalOpenClawSystemConfig();
		systemConfig.imageProfiles.gateways.openclaw = {
			type: 'openclaw',
			buildConfig: path.join(temporaryRoot, 'build-config.jsonc'),
			source: { kind: 'managedBase', base: 'openclaw-gateway' },
		};

		await createFakeAgentPortalSdkPackage(repoRoot);
		await createFakeConfigContractsPackage(repoRoot);
		await createFakeSecretsPackage(repoRoot);
		await createFakeGondolinVmAdapterPackage(repoRoot);
		await createFakeGatewayLifecyclePackage(repoRoot);
		await createFakeGatewayRuntimePackage(repoRoot);
		await createFakeManagedVmPackage(repoRoot);
		await createFakeControlProtocolContractsPackage(repoRoot);
		await createFakeControllerExecutionContractsPackage(repoRoot);
		await createFakeGatewayControlContractsPackage(repoRoot);
		await createFakeToolPortalPackage(repoRoot);
		await createFakePackageDist(repoRoot, 'openclaw-agent-vm-plugin', 'gondolin');
		await createFakePortalDist(repoRoot);

		await useLocalOpenClawGatewayImagePackages({
			profileName: 'openclaw',
			projectRoot: temporaryRoot,
			repoRoot,
			systemConfig,
		});

		const dockerfilePath = systemConfig.imageProfiles.gateways.openclaw.dockerfile;
		if (dockerfilePath === undefined) {
			throw new Error('Expected local OpenClaw gateway helper to set dockerfile path.');
		}
		expect(dockerfilePath).toBe(
			path.join(temporaryRoot, 'vm-images', 'gateways', 'openclaw-local-packages', 'Dockerfile'),
		);
		const dockerfile = await fs.readFile(dockerfilePath, 'utf8');
		expect(dockerfile).toContain(
			'COPY agent-vm-agent-portal-sdk-0.0.0-smoke.tgz /tmp/agent-vm-agent-portal-sdk-0.0.0-smoke.tgz',
		);
		expect(dockerfile).toContain(
			'COPY agent-vm-config-contracts-0.0.0-smoke.tgz /tmp/agent-vm-config-contracts-0.0.0-smoke.tgz',
		);
		expect(dockerfile).toContain(
			'COPY agent-vm-secret-management-0.0.0-smoke.tgz /tmp/agent-vm-secret-management-0.0.0-smoke.tgz',
		);
		expect(dockerfile).toContain(
			'COPY agent-vm-gondolin-vm-adapter-0.0.0-smoke.tgz /tmp/agent-vm-gondolin-vm-adapter-0.0.0-smoke.tgz',
		);
		expect(dockerfile).toContain(
			'COPY agent-vm-gateway-lifecycle-0.0.0-smoke.tgz /tmp/agent-vm-gateway-lifecycle-0.0.0-smoke.tgz',
		);
		expect(dockerfile).toContain(
			'COPY agent-vm-gateway-runtime-0.0.0-smoke.tgz /tmp/agent-vm-gateway-runtime-0.0.0-smoke.tgz',
		);
		expect(dockerfile).toContain(
			'COPY agent-vm-managed-vm-0.0.0-smoke.tgz /tmp/agent-vm-managed-vm-0.0.0-smoke.tgz',
		);
		expect(dockerfile).toContain(
			'COPY agent-vm-control-protocol-contracts-0.0.0-smoke.tgz /tmp/agent-vm-control-protocol-contracts-0.0.0-smoke.tgz',
		);
		expect(dockerfile).toContain(
			'COPY agent-vm-controller-execution-contracts-0.0.0-smoke.tgz /tmp/agent-vm-controller-execution-contracts-0.0.0-smoke.tgz',
		);
		expect(dockerfile).toContain(
			'COPY agent-vm-gateway-control-contracts-0.0.0-smoke.tgz /tmp/agent-vm-gateway-control-contracts-0.0.0-smoke.tgz',
		);
		expect(dockerfile).toContain(
			'COPY agent-vm-mcp-portal-0.0.0-smoke.tgz /tmp/agent-vm-mcp-portal-0.0.0-smoke.tgz',
		);
		expect(dockerfile).toContain(
			'COPY agent-vm-tool-portal-0.0.0-smoke.tgz /tmp/agent-vm-tool-portal-0.0.0-smoke.tgz',
		);
		expect(dockerfile).toContain(
			'COPY agent-vm-openclaw-agent-vm-plugin-0.0.0-smoke.tgz /tmp/agent-vm-openclaw-agent-vm-plugin-0.0.0-smoke.tgz',
		);
		expect(dockerfile).not.toContain('agent-vm-openclaw-mcp-portal-plugin-0.0.0-smoke.tgz');
		expect(dockerfile).toContain('pnpm install --prod --ignore-scripts');
		expect(dockerfile).toContain('@agent-vm/config-contracts');
		expect(dockerfile).toContain('@agent-vm/agent-portal-sdk');
		expect(dockerfile).toContain('file:/tmp/agent-vm-config-contracts-0.0.0-smoke.tgz');
		expect(dockerfile).toContain('@agent-vm/mcp-portal');
		expect(dockerfile).toContain('WORKDIR /opt/openclaw-runtime-packages');
		expect(dockerfile).toContain('"openclaw": "2026.7.1-2"');
		expect(dockerfile).toContain("openclaw plugins install 'npm:@openclaw/codex' --pin");
		expect(dockerfile).toContain('RUN pnpm install --prod --ignore-scripts');
		expect(dockerfile).toContain('"@openai/codex@');
		expect(dockerfile).not.toContain('RUN pnpm add -g "openclaw@');
		expect(dockerfile).not.toMatch(/pnpm add -g[^\n]*@agent-vm\/openclaw-agent-vm-plugin@/u);
		expect(dockerfile).not.toMatch(/pnpm add -g[^\n]*@agent-vm\/openclaw-mcp-portal-plugin@/u);
		expect(dockerfile).not.toMatch(/pnpm add -g[^\n]*@agent-vm\/mcp-portal@/u);
		expect(dockerfile).toContain('/usr/local/bin/openclaw');
		expect(dockerfile).toContain('package_root="/opt/agent-vm/local-packages/node_modules"');
		expect(dockerfile).toContain(
			'ln -sfn "$package_root/@agent-vm" "$global_package_root/@agent-vm"',
		);
		expect(dockerfile).toContain('/home/openclaw/.openclaw/extensions/gondolin');
		expect(dockerfile).not.toContain('/opt/agent-vm/e2e-openclaw-gondolin-extension');
		expect(dockerfile).not.toContain('/home/openclaw/.openclaw/extensions/mcp-portal');
		expect(dockerfile).not.toContain('portal-server.js');
		expect(dockerfile).not.toContain('/work/repo/packages/mcp-portal');
		expect(dockerfile).not.toMatch(/TOKEN|Authorization|\.npmrc|\.netrc|_authToken|Bearer/u);
		await expect(
			fs.stat(
				path.join(
					temporaryRoot,
					'vm-images',
					'gateways',
					'openclaw-local-packages',
					'agent-vm-openclaw-agent-vm-plugin-0.0.0-smoke.tgz',
				),
			),
		).resolves.toMatchObject({ mtimeMs: normalizedDockerContextTimestampMs });
		const toolVmDockerfilePath = systemConfig.imageProfiles.toolVms.tool?.dockerfile;
		if (toolVmDockerfilePath === undefined) {
			throw new Error('Expected local OpenClaw gateway helper to set Tool VM dockerfile path.');
		}
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
		expect(toolVmDockerfile).toContain('/opt/agent-vm/local-packages');
		expect(toolVmDockerfile).not.toContain('pnpm add -g');
		expect(toolVmDockerfile).not.toMatch(/TOKEN|Authorization|\.npmrc|\.netrc|_authToken|Bearer/u);
		await expect(
			fs.stat(
				path.join(
					temporaryRoot,
					'vm-images',
					'tool-vms',
					'tool-local-mcp-portal',
					'agent-vm-mcp-portal-0.0.0-smoke.tgz',
				),
			),
		).resolves.toMatchObject({ mtimeMs: normalizedDockerContextTimestampMs });
	});

	it('writes plugin-only OpenClaw smoke images without mutating Tool VM MCP Portal profiles', async () => {
		const temporaryRoot = await createTemporaryRoot('agent-vm-e2e-harness-');
		const repoRoot = path.join(temporaryRoot, 'repo');
		const systemConfig = createMinimalOpenClawSystemConfig();
		systemConfig.imageProfiles.gateways.openclaw = {
			type: 'openclaw',
			buildConfig: path.join(temporaryRoot, 'build-config.jsonc'),
			source: { kind: 'managedBase', base: 'openclaw-gateway' },
		};
		const originalToolVmProfile = { ...systemConfig.imageProfiles.toolVms.tool };

		await createFakeAgentPortalSdkPackage(repoRoot);
		await createFakeConfigContractsPackage(repoRoot);
		await createFakeSecretsPackage(repoRoot);
		await createFakeGondolinVmAdapterPackage(repoRoot);
		await createFakeGatewayLifecyclePackage(repoRoot);
		await createFakeGatewayRuntimePackage(repoRoot);
		await createFakeManagedVmPackage(repoRoot);
		await createFakeControlProtocolContractsPackage(repoRoot);
		await createFakeControllerExecutionContractsPackage(repoRoot);
		await createFakeGatewayControlContractsPackage(repoRoot);
		await createFakePortalDist(repoRoot);
		await createFakeToolPortalPackage(repoRoot);
		await createFakePackageDist(repoRoot, 'openclaw-agent-vm-plugin', 'gondolin');

		await useLocalOpenClawPluginGatewayImage({
			profileName: 'openclaw',
			projectRoot: temporaryRoot,
			repoRoot,
			systemConfig,
		});

		const dockerfilePath = systemConfig.imageProfiles.gateways.openclaw.dockerfile;
		if (dockerfilePath === undefined) {
			throw new Error('Expected plugin-only helper to set dockerfile path.');
		}
		const dockerfile = await fs.readFile(dockerfilePath, 'utf8');
		expect(dockerfile).toContain(
			'COPY agent-vm-agent-portal-sdk-0.0.0-smoke.tgz /tmp/agent-vm-agent-portal-sdk-0.0.0-smoke.tgz',
		);
		expect(dockerfile).toContain(
			'COPY agent-vm-config-contracts-0.0.0-smoke.tgz /tmp/agent-vm-config-contracts-0.0.0-smoke.tgz',
		);
		expect(dockerfile).toContain(
			'COPY agent-vm-control-protocol-contracts-0.0.0-smoke.tgz /tmp/agent-vm-control-protocol-contracts-0.0.0-smoke.tgz',
		);
		expect(dockerfile).toContain(
			'COPY agent-vm-gateway-lifecycle-0.0.0-smoke.tgz /tmp/agent-vm-gateway-lifecycle-0.0.0-smoke.tgz',
		);
		expect(dockerfile).toContain(
			'COPY agent-vm-gateway-runtime-0.0.0-smoke.tgz /tmp/agent-vm-gateway-runtime-0.0.0-smoke.tgz',
		);
		expect(dockerfile).toContain(
			'COPY agent-vm-openclaw-agent-vm-plugin-0.0.0-smoke.tgz /tmp/agent-vm-openclaw-agent-vm-plugin-0.0.0-smoke.tgz',
		);
		expect(dockerfile).toContain(
			'COPY agent-vm-gateway-control-contracts-0.0.0-smoke.tgz /tmp/agent-vm-gateway-control-contracts-0.0.0-smoke.tgz',
		);
		expect(dockerfile).toContain(
			'COPY agent-vm-mcp-portal-0.0.0-smoke.tgz /tmp/agent-vm-mcp-portal-0.0.0-smoke.tgz',
		);
		expect(dockerfile).toContain(
			'COPY agent-vm-tool-portal-0.0.0-smoke.tgz /tmp/agent-vm-tool-portal-0.0.0-smoke.tgz',
		);
		expect(dockerfile).toContain('WORKDIR /opt/openclaw-runtime-packages');
		expect(dockerfile).toContain('"openclaw": "2026.7.1-2"');
		expect(dockerfile).toContain("openclaw plugins install 'npm:@openclaw/codex' --pin");
		expect(dockerfile).toContain('RUN pnpm install --prod --ignore-scripts');
		expect(dockerfile).toContain('"@openai/codex@');
		expect(dockerfile).not.toContain('RUN pnpm add -g "openclaw@');
		expect(dockerfile).not.toMatch(/pnpm add -g[^\n]*@agent-vm\/openclaw-agent-vm-plugin@/u);
		expect(dockerfile).not.toMatch(/pnpm add -g[^\n]*@agent-vm\/openclaw-mcp-portal-plugin@/u);
		expect(dockerfile).not.toMatch(/pnpm add -g[^\n]*@agent-vm\/mcp-portal@/u);
		expect(dockerfile).toContain('/usr/local/bin/openclaw');
		expect(dockerfile).toContain(
			'ln -sfn "$package_root/@agent-vm" "$global_package_root/@agent-vm"',
		);
		expect(dockerfile).toContain('@agent-vm/control-protocol-contracts');
		expect(dockerfile).toContain('file:/tmp/agent-vm-control-protocol-contracts-0.0.0-smoke.tgz');
		expect(dockerfile).not.toContain('agent-vm-openclaw-mcp-portal-plugin-0.0.0-smoke.tgz');
		expect(systemConfig.imageProfiles.toolVms.tool).toEqual(originalToolVmProfile);
	});

	it('writes the e2e Tool VM proof plugin entrypoint only when requested explicitly', async () => {
		const temporaryRoot = await createTemporaryRoot('agent-vm-e2e-harness-');
		const repoRoot = path.join(temporaryRoot, 'repo');
		const systemConfig = createMinimalOpenClawSystemConfig();
		systemConfig.imageProfiles.gateways.openclaw = {
			type: 'openclaw',
			buildConfig: path.join(temporaryRoot, 'build-config.jsonc'),
			source: { kind: 'managedBase', base: 'openclaw-gateway' },
		};

		await createFakeAgentPortalSdkPackage(repoRoot);
		await createFakeConfigContractsPackage(repoRoot);
		await createFakeSecretsPackage(repoRoot);
		await createFakeGondolinVmAdapterPackage(repoRoot);
		await createFakeGatewayLifecyclePackage(repoRoot);
		await createFakeGatewayRuntimePackage(repoRoot);
		await createFakeManagedVmPackage(repoRoot);
		await createFakeControlProtocolContractsPackage(repoRoot);
		await createFakeControllerExecutionContractsPackage(repoRoot);
		await createFakeGatewayControlContractsPackage(repoRoot);
		await createFakePortalDist(repoRoot);
		await createFakeToolPortalPackage(repoRoot);
		await createFakePackageDist(repoRoot, 'openclaw-agent-vm-plugin', 'gondolin');

		await useLocalOpenClawPluginGatewayImage({
			enableToolVmWriteReadE2eRoute: true,
			profileName: 'openclaw',
			projectRoot: temporaryRoot,
			repoRoot,
			systemConfig,
		});

		const dockerfilePath = systemConfig.imageProfiles.gateways.openclaw.dockerfile;
		if (dockerfilePath === undefined) {
			throw new Error('Expected plugin-only helper to set dockerfile path.');
		}
		const dockerfile = await fs.readFile(dockerfilePath, 'utf8');
		expect(dockerfile).toContain('/opt/agent-vm/e2e-openclaw-gondolin-extension');
		expect(dockerfile).toContain('openclaw-agent-vm-plugin/dist/e2e.js');
		expect(dockerfile).toContain(
			'ln -sfn "$e2e_extension" /home/openclaw/.openclaw/extensions/gondolin',
		);
		expect(dockerfile).not.toMatch(/TOKEN|Authorization|\.npmrc|\.netrc|_authToken|Bearer/u);
	});

	it('writes local MCP Portal Tool VM smoke images only when requested explicitly', async () => {
		const temporaryRoot = await createTemporaryRoot('agent-vm-e2e-harness-');
		const repoRoot = path.join(temporaryRoot, 'repo');
		const systemConfig = createMinimalOpenClawSystemConfig();
		const originalGatewayProfile = { ...systemConfig.imageProfiles.gateways.openclaw };

		await createFakeAgentPortalSdkPackage(repoRoot);
		await createFakeSecretsPackage(repoRoot);
		await createFakePortalDist(repoRoot);

		await useLocalToolVmMcpPortalPackage({
			projectRoot: temporaryRoot,
			repoRoot,
			systemConfig,
		});

		expect(systemConfig.imageProfiles.gateways.openclaw).toEqual(originalGatewayProfile);
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
		expect(toolVmDockerfile).not.toContain('agent-vm-openclaw-agent-vm-plugin-0.0.0-smoke.tgz');
		expect(toolVmDockerfile).not.toContain('agent-vm-openclaw-mcp-portal-plugin-0.0.0-smoke.tgz');
		expect(toolVmDockerfile).not.toContain('pnpm add -g');
	});

	it('fails local package image setup before packing when declared package files are missing', async () => {
		const temporaryRoot = await createTemporaryRoot('agent-vm-e2e-harness-');
		const repoRoot = path.join(temporaryRoot, 'repo');
		const systemConfig = createMinimalOpenClawSystemConfig();
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

	it('removes MCP Portal plugin loading from OpenClaw smokes that do not exercise portal tools', async () => {
		const temporaryRoot = await createTemporaryRoot('agent-vm-e2e-harness-');
		const configPath = path.join(temporaryRoot, 'openclaw.json');
		await fs.writeFile(
			configPath,
			`${JSON.stringify(
				{
					plugins: {
						allow: ['gondolin', 'memory-core', 'mcp-portal'],
						entries: {
							gondolin: { enabled: true },
							'mcp-portal': { enabled: true },
						},
						load: {
							paths: [
								'/home/openclaw/.openclaw/extensions/gondolin',
								'/home/openclaw/.openclaw/extensions/mcp-portal',
							],
						},
					},
				},
				null,
				'\t',
			)}\n`,
			'utf8',
		);

		await disableOpenClawMcpPortalPlugin(configPath);

		const rewrittenConfig = await fs.readFile(configPath, 'utf8');
		expect(rewrittenConfig).toContain('/home/openclaw/.openclaw/extensions/gondolin');
		expect(rewrittenConfig).toContain('"gondolin"');
		expect(rewrittenConfig).not.toContain('/home/openclaw/.openclaw/extensions/mcp-portal');
		expect(rewrittenConfig).not.toContain('"mcp-portal"');
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
			frameworkBootEntry: 'openclaw-framework-service',
			kind: 'managed-gateway-exact-two-role',
		} satisfies ManagedGatewayImageBootProjection;
		const fingerprint = await computeFingerprintFromConfigPath(gatewayBuildConfigPath, {
			managedGatewayBoot,
		});
		const reusableImageDirectory = path.join(
			previousCacheDir,
			'gateway-images',
			'openclaw',
			fingerprint,
		);
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
				imageProfileName: 'openclaw',
				managedGatewayBoot,
			});
		} finally {
			if (previousSmokeCacheRoot === undefined) {
				delete process.env.AGENT_VM_E2E_CACHE_DIR;
			} else {
				process.env.AGENT_VM_E2E_CACHE_DIR = previousSmokeCacheRoot;
			}
		}

		const activeImageDirectory = path.join(
			activeCacheDir,
			'gateway-images',
			'openclaw',
			fingerprint,
		);
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
			const project = await scaffoldOpenClawE2eProject({
				architecture: 'aarch64',
				prefix: 'openclaw-local-tool-vm-packages-',
				zoneId: 'openclaw-local-tool-vm-packages',
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
							openclaw: [],
							pnpm: {},
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
				openclaw: [],
				pnpm: {},
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
			'gateway-images',
			'worker',
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

		const activeImageDirectory = path.join(
			project.systemConfig.cacheDir,
			'gateway-images',
			'worker',
			fingerprint,
		);
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
			await prepareGatewayE2eProjectImages({
				project: firstProject,
				runBuild: async ({ systemConfig }) => {
					buildConfigs.push(systemConfig);
					await Promise.all(
						Object.entries(systemConfig.imageProfiles.gateways).map(
							async ([profileName, profile]) => {
								const fingerprint = await computeFingerprintFromConfigPath(profile.buildConfig);
								const cacheDir = path.join(systemConfig.cacheDir, 'gateway-images', profileName);
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
									cacheDir,
									fingerprint,
									imagePath,
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
		}

		const secondGatewayProfile = secondProject.systemConfig.imageProfiles.gateways.worker;
		if (secondGatewayProfile === undefined) {
			throw new Error('Expected worker gateway image profile.');
		}
		const secondPreparedImage = await readPreparedManagedVmImage({
			buildConfigPath: secondGatewayProfile.buildConfig,
			cacheDir: path.join(secondProject.systemConfig.cacheDir, 'gateway-images', 'worker'),
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
					const cacheDir = path.join(systemConfig.cacheDir, 'gateway-images', 'worker');
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
						cacheDir,
						fingerprint,
						imagePath,
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
				cacheDir: path.join(secondProject.systemConfig.cacheDir, 'gateway-images', 'worker'),
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
		const openClawProject = await scaffoldOpenClawE2eProject({
			architecture: 'aarch64',
			prefix: 'openclaw-control-link-e2e-',
			zoneId: 'openclaw-e2e',
		});
		temporaryRoots.push(workerProject.tempRoot, openClawProject.tempRoot);
		for (const project of [workerProject, openClawProject]) {
			Object.assign(project.systemConfig, { cacheDir: smokeCacheRoot });
			project.systemConfig.imageProfiles.toolVms = {};
		}
		const workerProfile = workerProject.systemConfig.imageProfiles.gateways.worker;
		const openClawProfile = openClawProject.systemConfig.imageProfiles.gateways.openclaw;
		const workerZone = workerProject.systemConfig.zones[0];
		const openClawZone = openClawProject.systemConfig.zones[0];
		if (
			workerProfile === undefined ||
			openClawProfile === undefined ||
			workerZone === undefined ||
			openClawZone === undefined
		) {
			throw new Error('Expected Worker and OpenClaw e2e fixtures.');
		}
		workerProfile.buildConfig = sharedBuildConfigPath;
		workerProfile.dockerfile = sharedDockerfilePath;
		delete workerProfile.source;
		openClawProfile.buildConfig = sharedBuildConfigPath;
		openClawProfile.dockerfile = sharedDockerfilePath;
		delete openClawProfile.source;
		workerProject.systemConfig.imageProfiles.gateways = { shared: workerProfile };
		openClawProject.systemConfig.imageProfiles.gateways = { shared: openClawProfile };
		workerZone.gateway.imageProfile = 'shared';
		openClawZone.gateway.imageProfile = 'shared';
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
				profile.type === 'openclaw'
					? {
							frameworkBootEntry: 'openclaw-framework-service' as const,
							kind: 'managed-gateway-exact-two-role' as const,
						}
					: undefined;
			const fingerprint = await computeFingerprintFromConfigPath(
				profile.buildConfig,
				managedGatewayBoot === undefined ? {} : { managedGatewayBoot },
			);
			const cacheDir = path.join(systemConfig.cacheDir, 'gateway-images', 'shared');
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
				cacheDir,
				fingerprint,
				imagePath,
				...(managedGatewayBoot === undefined ? {} : { managedGatewayBoot }),
			});
		};

		await prepareGatewayE2eProjectImages({ project: workerProject, runBuild });
		await prepareGatewayE2eProjectImages({ project: openClawProject, runBuild });

		expect(builtGatewayTypes).toEqual(['worker', 'openclaw']);
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
									const cacheDir = path.join(systemConfig.cacheDir, 'gateway-images', profileName);
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
										cacheDir,
										fingerprint,
										imagePath,
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

function createMinimalOpenClawSystemConfig(projectRoot = '/tmp'): LoadedSystemConfig {
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
				openclaw: {
					type: 'openclaw',
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
					type: 'openclaw',
					controlAuth: {
						mode: 'token',
						secret: 'OPENCLAW_GATEWAY_TOKEN',
					},
					backupDir: path.join(projectRoot, 'backup'),
					config: path.join(projectRoot, 'config', 'openclaw.json'),
					cpus: 1,
					imageProfile: 'openclaw',
					memory: '1G',
					port: 18789,
					stateDir: path.join(projectRoot, 'smoke', 'state'),
					zoneFilesDir: path.join(projectRoot, 'smoke', 'zone-files'),
					zoneRuntimeDir: path.join(projectRoot, 'smoke', 'runtime'),
				},
				id: 'smoke',
				secrets: {
					OPENCLAW_GATEWAY_TOKEN: {
						audience: 'gateway',
						envVar: 'OPENCLAW_GATEWAY_TOKEN',
						injection: 'env',
						source: 'environment',
					},
				},
			},
		],
	};
}

async function createFakePackageDist(
	repoRoot: string,
	packageName: 'openclaw-agent-vm-plugin',
	pluginId: string,
): Promise<void> {
	const packageDir = path.join(repoRoot, 'packages', packageName);
	const distDir = path.join(packageDir, 'dist');
	await fs.mkdir(packageDir, { recursive: true });
	await fs.writeFile(
		path.join(packageDir, 'package.json'),
		`${JSON.stringify(
			{
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
	await fs.mkdir(distDir, { recursive: true });
	await fs.writeFile(
		path.join(distDir, 'openclaw.plugin.json'),
		`${JSON.stringify({ id: pluginId, name: pluginId })}\n`,
		'utf8',
	);
	await fs.writeFile(path.join(distDir, 'index.js'), 'export default {};\n', 'utf8');
	await fs.writeFile(path.join(distDir, 'e2e.js'), 'export default {};\n', 'utf8');
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

async function createFakeGondolinVmAdapterPackage(repoRoot: string): Promise<void> {
	const packageDir = path.join(repoRoot, 'packages', 'gondolin-vm-adapter');
	await fs.mkdir(path.join(packageDir, 'dist'), { recursive: true });
	await fs.writeFile(
		path.join(packageDir, 'package.json'),
		`${JSON.stringify(
			{
				dependencies: { '@agent-vm/secret-management': '0.0.0-smoke' },
				name: '@agent-vm/gondolin-vm-adapter',
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

async function createFakeGatewayLifecyclePackage(repoRoot: string): Promise<void> {
	const packageDir = path.join(repoRoot, 'packages', 'gateway-lifecycle');
	await fs.mkdir(path.join(packageDir, 'dist'), { recursive: true });
	await fs.writeFile(
		path.join(packageDir, 'package.json'),
		`${JSON.stringify(
			{
				dependencies: {
					'@agent-vm/managed-vm': '0.0.0-smoke',
					'@agent-vm/secret-management': '0.0.0-smoke',
				},
				name: '@agent-vm/gateway-lifecycle',
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

async function createFakeManagedVmPackage(repoRoot: string): Promise<void> {
	await createFakeSimplePackage(repoRoot, 'managed-vm');
}

async function createFakeGatewayRuntimePackage(repoRoot: string): Promise<void> {
	await createFakeSimplePackage(repoRoot, 'gateway-runtime');
}

async function createFakeControlProtocolContractsPackage(repoRoot: string): Promise<void> {
	await createFakeSimplePackage(repoRoot, 'control-protocol-contracts');
}

async function createFakeControllerExecutionContractsPackage(repoRoot: string): Promise<void> {
	await createFakeSimplePackage(repoRoot, 'controller-execution-contracts');
}

async function createFakeGatewayControlContractsPackage(repoRoot: string): Promise<void> {
	await createFakeSimplePackage(repoRoot, 'gateway-control-contracts', {
		'@agent-vm/control-protocol-contracts': '0.0.0-smoke',
	});
}

async function createFakeToolPortalPackage(repoRoot: string): Promise<void> {
	await createFakeSimplePackage(repoRoot, 'tool-portal', {
		'@agent-vm/agent-portal-sdk': '0.0.0-smoke',
		'@agent-vm/config-contracts': '0.0.0-smoke',
		'@agent-vm/controller-execution-contracts': '0.0.0-smoke',
		'@agent-vm/mcp-portal': '0.0.0-smoke',
	});
}
