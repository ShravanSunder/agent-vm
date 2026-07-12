import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ManagedVm } from '@agent-vm/managed-vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { computeFingerprintFromConfigPath } from '../build/gondolin-image-builder.js';
import { managedVmImageAssetFileNames } from '../build/gondolin-managed-vm-build-tooling.js';
import {
	readPreparedManagedVmImage,
	writePreparedManagedVmImage,
} from '../build/prepared-gondolin-image-cache.js';
import type { LoadedSystemConfig } from '../config/system-config.js';
import { createOpenClawProcessReliabilityFaultTargetRegistry } from '../controller/reliability/testing/openclaw-process-reliability-fault-target-registry.js';
import type { GatewayVmLifecycleAuthority } from '../controller/vm-ownership/gateway-vm-lifecycle-authority.js';
import type { StartGatewayZoneOptions } from '../gateway/gateway-zone-support.js';
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

const temporaryRoots: string[] = [];
const normalizedDockerContextTimestampMs = Date.UTC(2000, 0, 1, 0, 0, 0, 0);

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
			expect(path.resolve(project.systemConfig.runtimeDir)).toContain(
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
	it('forwards only the exact optional OpenClaw reliability target registry factory', async () => {
		const { startE2eControllerRuntime } = await import('./e2e-harness.js');
		const systemConfig = createMinimalOpenClawSystemConfig();
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected smoke system config to contain a zone.');
		}
		const gatewayIdentity = {
			bootId: 'gateway-boot-smoke',
			controllerEpoch: 'controller-epoch-smoke',
			gatewayEpochId: 'gateway-epoch-smoke',
			gatewayVmId: 'vm-smoke-test',
			generationId: 'gateway-generation-smoke',
			zoneId: zone.id,
		};
		const createReliabilityTargetRegistry = vi.fn(
			createOpenClawProcessReliabilityFaultTargetRegistry,
		);
		const harness = await startE2eControllerRuntime({
			createOpenClawProcessReliabilityFaultTargetRegistry: createReliabilityTargetRegistry,
			secrets: {
				AGENT_VM_TEST_OPENAI_API_KEY: 'test-service-account-token',
				OPENCLAW_GATEWAY_TOKEN: 'test-gateway-token',
			},
			startGatewayZone: async (options) => {
				options.onOpenClawProcessReliabilityFaultTarget?.({
					gateway: gatewayIdentity,
					processEpoch: 'process-epoch-smoke',
					reliabilityFaultActuator: {
						terminateOwnedProcess: vi.fn(async () => {
							throw new Error('harness forwarding test must not actuate a fault');
						}),
					},
				});
				return {
					image: { built: false, fingerprint: 'test', imageReference: '/tmp/image' },
					ingress: { host: '127.0.0.1', port: 18789 },
					processEpoch: 'process-epoch-smoke',
					processSpec: {
						bootstrapCommand: '',
						guestListenPort: 18789,
						healthCheck: { type: 'http', port: 18789, path: '/readyz' },
						logPath: '/tmp/gateway.log',
						startCommand: '',
					},
					terminateVm: async () => {},
					vm: createManagedVmStub(),
					vmOwnership: {
						...createExactVmOwnershipStub('vm-smoke-test'),
						gatewayIdentity,
					},
					zone,
				};
			},
			startHttpServer: async () => ({ close: async () => undefined }),
			startOptions: { systemConfig, zoneIds: [zone.id] },
		});

		try {
			expect(createReliabilityTargetRegistry).toHaveBeenCalledOnce();
		} finally {
			await harness.close();
		}
	});

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
				return {
					image: { built: false, fingerprint: 'test', imageReference: '/tmp/image' },
					ingress: { host: '127.0.0.1', port: 18789 },
					processSpec: {
						bootstrapCommand: '',
						guestListenPort: 18789,
						healthCheck: { type: 'http', port: 18789, path: '/readyz' },
						logPath: '/tmp/gateway.log',
						startCommand: '',
					},
					terminateVm: async () => {},
					vm: createManagedVmStub(),
					vmOwnership: createExactVmOwnershipStub('vm-smoke-test'),
					zone,
				};
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
					hostPath: process.cwd(),
					access: 'read-only',
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
					hostPath: process.cwd(),
					access: 'read-only',
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
			startGatewayZone: async () => ({
				image: { built: false, fingerprint: 'test', imageReference: '/tmp/image' },
				ingress: { host: '127.0.0.1', port: 18789 },
				processSpec: {
					bootstrapCommand: '',
					guestListenPort: 18789,
					healthCheck: { type: 'http', port: 18789, path: '/readyz' },
					logPath: '/tmp/gateway.log',
					startCommand: '',
				},
				terminateVm: async () => {},
				vm: createManagedVmStub(),
				vmOwnership: createExactVmOwnershipStub('vm-smoke-test'),
				zone,
			}),
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
			startGatewayZone: async () => ({
				image: { built: false, fingerprint: 'test', imageReference: '/tmp/image' },
				ingress: { host: '127.0.0.1', port: 18789 },
				processSpec: {
					bootstrapCommand: '',
					guestListenPort: 18789,
					healthCheck: { type: 'http', port: 18789, path: '/readyz' },
					logPath: '/tmp/gateway.log',
					startCommand: '',
				},
				terminateVm: async () => {},
				vm: createManagedVmStub(),
				vmOwnership: createExactVmOwnershipStub('vm-smoke-test'),
				zone,
			}),
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
		expect(dockerfile).toContain('"openclaw": "2026.6.8"');
		expect(dockerfile).toContain('"@openclaw/codex": "2026.6.8"');
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
		expect(dockerfile).toContain('"openclaw": "2026.6.8"');
		expect(dockerfile).toContain('"@openclaw/codex": "2026.6.8"');
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
				findReusableGatewayImageDirectory('/tmp/current-smoke', '/tmp/build-config.jsonc'),
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
		const fingerprint = await computeFingerprintFromConfigPath(gatewayBuildConfigPath);
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
			firstProject.systemConfig.cacheDir = path.join(smokeCacheRoot, 'worker');
			secondProject.systemConfig.cacheDir = path.join(smokeCacheRoot, 'worker');
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
		firstProject.systemConfig.cacheDir = path.join(smokeCacheRoot, 'worker');
		secondProject.systemConfig.cacheDir = path.join(smokeCacheRoot, 'worker');
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
		attachGatewayVm: () => gatewayIdentity,
		containPendingCreate: async () => {},
		destroyLive: async (destroyVm) => await destroyVm(),
		gatewayIdentity,
		gatewaySeed,
	};
}

function createMinimalOpenClawSystemConfig(projectRoot = '/tmp'): LoadedSystemConfig {
	return {
		cacheDir: path.join(projectRoot, 'cache'),
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
		runtimeDir: path.join(projectRoot, 'runtime'),
		schemaVersion: 1,
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
				agentSandboxSeeds: {},
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
					stateDir: path.join(projectRoot, 'state'),
					zoneFilesDir: path.join(projectRoot, 'zone-files'),
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
