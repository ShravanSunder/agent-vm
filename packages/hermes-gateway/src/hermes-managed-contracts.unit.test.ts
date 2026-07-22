import type { GatewayZoneConfig } from '@agent-vm/gateway-lifecycle';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
	buildHermesFrameworkServiceBootMetadata,
	hermesLifecycle,
	HERMES_AGENT_DISTRIBUTION,
	renderHermesManagedImageRecipe,
} from './index.js';

const readFileMock = vi.hoisted(() => vi.fn());

vi.mock('node:fs/promises', async (importOriginal) => ({
	...(await importOriginal<typeof import('node:fs/promises')>()),
	readFile: readFileMock,
}));

function createHermesZone(toolPortalMaterial: unknown): GatewayZoneConfig {
	return {
		id: 'hermes-zone',
		gateway: {
			config: '/deployment/config/hermes.yaml',
			cpus: 2,
			memory: '4G',
			port: 8642,
			runtimeRootfsSize: '16G',
			ssh: { secretEnv: 'never' },
			stateDir: '/deployment/state/hermes',
			type: 'hermes',
		},
		runtimePluginConfigs: {
			gondolin: { toolPortal: toolPortalMaterial },
		},
		secrets: {
			API_SERVER_KEY: {
				audience: 'gateway',
				envVar: 'HERMES_API_SERVER_KEY',
				injection: 'env',
				source: 'environment',
			},
		},
		egressHosts: [],
	} as unknown as GatewayZoneConfig;
}

function createHermesAdapterMaterial(): Readonly<Record<string, unknown>> {
	return Object.freeze({
		agentProjections: Object.freeze({
			researcher: Object.freeze({
				agentId: 'researcher',
				frameworkIdentity: Object.freeze({ kind: 'hermes', profileName: 'researcher' }),
				profileAssignmentRevision: 'revision-researcher',
				toolPortalProfileId: 'profile-researcher',
			}),
		}),
		attachment: Object.freeze({
			attachmentGeneration: 1,
			clientKind: 'hermes-managed-plugin',
			configuredAgentIds: Object.freeze(['researcher']),
			frameworkEpoch: 'framework-epoch',
			gatewayEpoch: 'gateway-epoch',
			protocolVersion: 1,
			projectionCohortDigest: `projection-cohort:${'a'.repeat(64)}`,
			runtimeEpoch: 'runtime-epoch',
			schemaVersion: 1,
		}),
	});
}

describe('managed Hermes package contracts', () => {
	beforeEach(() => {
		readFileMock.mockReset();
		readFileMock.mockResolvedValue(`
plugins:
  enabled: [agent-vm-tool-portal]
  disabled: []
`);
	});

	it('wires host-authoritative profile preflight and preparation hooks', () => {
		expect(hermesLifecycle.preflightHostState).toBeTypeOf('function');
		expect(hermesLifecycle.prepareHostState).toBeTypeOf('function');
	});

	it('pins the researched Hermes Python distribution and source revision', () => {
		expect(HERMES_AGENT_DISTRIBUTION).toEqual({
			distributionName: 'hermes-agent',
			projectVersion: '0.18.2',
			pythonRequirement: '>=3.11,<3.14',
			sourceRepository: 'https://github.com/NousResearch/hermes-agent.git',
			sourceRevision: '9de9c25f620ff7f1ce0fd5457d596052d5159596',
		});
	});

	it('builds closed Hermes boot metadata without executable or supervisor authority', () => {
		const metadata = buildHermesFrameworkServiceBootMetadata(
			createHermesZone(createHermesAdapterMaterial()),
		);

		expect(metadata).toMatchObject({
			bootEntry: 'hermes-gateway',
			framework: 'hermes',
			role: 'framework-service',
		});
		expect(metadata).not.toHaveProperty('argv');
		expect(metadata).not.toHaveProperty('executable');
		expect(metadata).not.toHaveProperty('supervisor');
	});

	it('rejects OpenClaw lifecycle input instead of accepting cross-framework material', () => {
		const openClawZone = {
			...createHermesZone(createHermesAdapterMaterial()),
			gateway: {
				...createHermesZone(createHermesAdapterMaterial()).gateway,
				type: 'openclaw',
			},
		} as GatewayZoneConfig;

		expect(() => buildHermesFrameworkServiceBootMetadata(openClawZone)).toThrow(
			/Hermes lifecycle cannot build gateway type 'openclaw'/u,
		);
	});

	it('serializes the exact immutable controller material and managed environment', async () => {
		const material = createHermesAdapterMaterial();
		const zone = {
			...createHermesZone(material),
			runtimeEnvironment: {
				OTEL_RESOURCE_ATTRIBUTES:
					'dev.repo.hash=0123456789abcdef,dev.worktree.hash=fedcba9876543210',
			},
		} satisfies GatewayZoneConfig;

		const bootInputs = await hermesLifecycle.buildFrameworkServiceBootInputs({
			resolvedSecrets: { API_SERVER_KEY: 'test-only-key' },
			zone,
		});

		expect(bootInputs.configuration).toBe(material);
		expect(bootInputs).toMatchObject({
			kind: 'hermes-managed-scope',
			managedConfigurationSource: expect.stringContaining('agent-vm-tool-portal'),
		});
		expect(bootInputs.environment).toMatchObject({
			AGENT_VM_HERMES_MANAGED_CONFIG_PATH: '/run/agent-vm/managed-gateway/framework-service.json',
			API_SERVER_ENABLED: 'true',
			API_SERVER_KEY: 'test-only-key',
			GATEWAY_MULTIPLEX_PROFILES: 'true',
			HERMES_MANAGED_DIR: '/run/agent-vm/managed-gateway',
			HERMES_HOME: '/home/hermes/.hermes',
			OTEL_RESOURCE_ATTRIBUTES: 'dev.repo.hash=0123456789abcdef,dev.worktree.hash=fedcba9876543210',
		});
		expect(readFileMock).toHaveBeenCalledWith('/deployment/config/hermes.yaml', 'utf8');
	});

	it('mounts durable state directly at HERMES_HOME', () => {
		const requirements = hermesLifecycle.buildVmRequirements({
			controllerPort: 7777,
			gatewayCacheDir: '/deployment/cache/hermes',
			projectNamespace: 'deployment-a',
			resolvedSecrets: { API_SERVER_KEY: 'test-only-key' },
			runtimeDir: '/deployment/runtime',
			tcpPool: { basePort: 22_000, size: 2 },
			zone: createHermesZone(createHermesAdapterMaterial()),
		});

		expect(requirements.environment).not.toHaveProperty('API_SERVER_KEY');
		expect(requirements.environment).toMatchObject({
			HERMES_HOME: '/home/hermes/.hermes',
		});
		expect(requirements.mounts).toEqual({
			'/agent-vm/logs': {
				access: 'read-write',
				hostPath: '/deployment/runtime/zones/hermes-zone/logs',
				kind: 'host-directory',
			},
			'/home/hermes/.cache': {
				access: 'read-write',
				hostPath: '/deployment/cache/hermes',
				kind: 'host-directory',
			},
			'/home/hermes/.hermes': {
				access: 'read-write',
				hostPath: '/deployment/state/hermes',
				kind: 'host-directory',
			},
		});
		expect(requirements.mounts).not.toHaveProperty('/workspace');
		expect(requirements.tcpHosts).toEqual({
			'tool-0.vm.host:22': '127.0.0.1:22000',
			'tool-1.vm.host:22': '127.0.0.1:22001',
		});
	});

	it('rejects missing, malformed, and wrong-framework immutable input', async () => {
		await Promise.all(
			[
				undefined,
				{},
				{
					agentProjections: {},
					attachment: { clientKind: 'openclaw-managed-plugin' },
				},
			].map(async (toolPortalMaterial) => {
				await expect(
					hermesLifecycle.buildFrameworkServiceBootInputs({
						resolvedSecrets: { API_SERVER_KEY: 'test-only-key' },
						zone: createHermesZone(toolPortalMaterial),
					}),
				).rejects.toThrow(/Hermes|hermes-managed-plugin/u);
			}),
		);
	});

	it('renders the complete custom Hermes image recipe from explicit local artifacts', () => {
		const recipe = renderHermesManagedImageRecipe({
			artifactContext: {
				kind: 'local-artifact-context',
				gatewayRuntime: {
					executablePath:
						'/opt/agent-vm/local-packages/node_modules/@agent-vm/gateway-runtime/dist/bin/gateway-runtime.js',
					packageArchiveFiles: [
						'local-agent-vm/agent-vm-gateway-runtime-0.0.115.tgz',
						'local-agent-vm/agent-vm-tool-portal-0.0.115.tgz',
					],
					packageManifestFile: 'local-agent-vm/package.json',
				},
				pythonWheels: {
					agentPortalSdk: 'local-agent-vm/agent_vm_agent_portal_sdk-0.0.115-py3-none-any.whl',
					hermesAdapter: 'local-agent-vm/agent_vm_hermes_adapter-0.0.115-py3-none-any.whl',
				},
			},
			buildTarget: {
				architecture: 'x86_64',
				kind: 'gondolin-custom-dockerfile',
				ociImage: 'agent-vm-hermes:latest',
				rootfsSizeMb: 4096,
			},
		});

		expect(recipe.kind).toBe('hermes-managed-image-recipe');
		expect(recipe.installSpecifier).toBe('hermes-agent[messaging]==0.18.2');
		expect(recipe.frameworkBootEntry).toBe('hermes-gateway');
		expect(recipe.buildNetworkAccess).toEqual({
			aptPackages: 'public-debian-repositories',
			containerImages: ['node:24-slim', 'ghcr.io/astral-sh/uv:0.11.16'],
			kind: 'public-package-indexes-required',
			npmPackages: 'public-npm-registry',
			pythonPackages: 'public-python-package-index',
			pythonRuntime: 'public-python-build-standalone-download',
		});
		expect(recipe.buildConfig).toEqual({
			arch: 'x86_64',
			distro: 'alpine',
			alpine: {
				version: '3.23.0',
				kernelPackage: 'linux-virt',
				kernelImage: 'vmlinuz-virt',
				rootfsPackages: [],
				initramfsPackages: [],
			},
			oci: { image: 'agent-vm-hermes:latest', pullPolicy: 'never' },
			rootfs: { label: 'gondolin-root', sizeMb: 4096 },
		});
		expect(recipe.dockerfile).toContain('FROM node:24-slim');
		expect(recipe.dockerfile).toContain('COPY --from=ghcr.io/astral-sh/uv:0.11.16');
		expect(recipe.dockerfile).toContain('npm install -g pnpm@10.33.0');
		expect(recipe.dockerfile).toContain('uv python install 3.13');
		expect(recipe.dockerfile).toContain(
			'uv venv --python /usr/local/bin/python3 /opt/agent-vm/hermes-venv',
		);
		expect(recipe.dockerfile).toContain(
			'uv pip install --python /opt/agent-vm/hermes-venv/bin/python',
		);
		expect(recipe.dockerfile).not.toContain('uv pip install --python /usr/local/bin/python3');
		expect(recipe.dockerfile).toContain(
			'COPY local-agent-vm/agent_vm_agent_portal_sdk-0.0.115-py3-none-any.whl /tmp/agent_vm_agent_portal_sdk-0.0.115-py3-none-any.whl',
		);
		expect(recipe.dockerfile).toContain(
			'COPY local-agent-vm/agent_vm_hermes_adapter-0.0.115-py3-none-any.whl /tmp/agent_vm_hermes_adapter-0.0.115-py3-none-any.whl',
		);
		expect(recipe.dockerfile).toContain(
			'COPY local-agent-vm/package.json /opt/agent-vm/local-packages/package.json',
		);
		expect(recipe.dockerfile).toContain(
			'COPY local-agent-vm/agent-vm-gateway-runtime-0.0.115.tgz /opt/agent-vm/local-packages/agent-vm-gateway-runtime-0.0.115.tgz',
		);
		expect(recipe.dockerfile).toContain("'hermes-agent[messaging]==0.18.2'");
		expect(recipe.dockerfile).toContain('pnpm install --prod --ignore-scripts');
		expect(recipe.dockerfile).toContain('/usr/local/bin/agent-vm-hermes-gateway');
		expect(recipe.dockerfile).toContain(
			'gateway_runtime_bin="/opt/agent-vm/local-packages/node_modules/@agent-vm/gateway-runtime/dist/bin/gateway-runtime.js"',
		);
		expect(recipe.dockerfile).toContain(
			'ln -sfn "$gateway_runtime_bin" /usr/local/bin/agent-vm-gateway-runtime',
		);
		expect(recipe.dockerfile).not.toContain(
			'node_modules/.bin/agent-vm-gateway-runtime /usr/local/bin/agent-vm-gateway-runtime',
		);
		expect(recipe.dockerfile).not.toMatch(/CMD|ENTRYPOINT|systemd|launchd|s6|supervis/iu);
		expect(recipe.dockerfile).not.toMatch(
			/(?:ARG|ENV|RUN)\s+[^\n]*(?:TOKEN|SECRET|CREDENTIAL)|\.npmrc|\.docker\/config\.json|\.netrc|_authToken|_password|_secret/iu,
		);
		expect(JSON.stringify(recipe)).not.toMatch(/complete|missingRuntimeJoins/u);
	});

	it('rejects artifact paths that escape the caller-owned Docker context', () => {
		expect(() =>
			renderHermesManagedImageRecipe({
				artifactContext: {
					kind: 'local-artifact-context',
					gatewayRuntime: {
						executablePath:
							'/opt/agent-vm/local-packages/node_modules/@agent-vm/gateway-runtime/dist/bin/gateway-runtime.js',
						packageArchiveFiles: ['../gateway-runtime.tgz'],
						packageManifestFile: 'local-agent-vm/package.json',
					},
					pythonWheels: {
						agentPortalSdk: 'local-agent-vm/agent-portal-sdk.whl',
						hermesAdapter: 'local-agent-vm/hermes-adapter.whl',
					},
				},
				buildTarget: {
					architecture: 'aarch64',
					kind: 'gondolin-custom-dockerfile',
					ociImage: 'agent-vm-hermes:latest',
					rootfsSizeMb: 4096,
				},
			}),
		).toThrow(/relative Docker-context path/u);
	});
});
