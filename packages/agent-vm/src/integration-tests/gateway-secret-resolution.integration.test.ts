import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { GatewayLifecycle } from '@agent-vm/gateway-lifecycle';
import type {
	ManagedVmCreateRequest,
	ManagedVmFactory,
	ManagedVmImageCapability,
} from '@agent-vm/managed-vm';
import type { SecretRef, SecretResolver } from '@agent-vm/secret-management';
import { describe, expect, it, vi } from 'vitest';

import { createLoadedSystemConfig } from '../config/system-config.js';
import { createSecretResolverFromSystemConfig } from '../controller/controller-runtime-support.js';
import {
	createControllerStateRoot,
	resolveControllerGatewayStateRoot,
} from '../controller/durable-state/controller-state-paths.js';
import { resolveControllerGatewayRecordTargets } from '../controller/durable-state/controller-state-record-paths.js';
import type { GatewayVmLifecycleAuthority } from '../controller/vm-ownership/gateway-vm-lifecycle-authority.js';
import { resolveZoneSecrets } from '../gateway/credential-manager.js';
import { loadGatewayLifecycle } from '../gateway/gateway-lifecycle-loader.js';
import {
	startGatewayZone,
	type GatewayManagerDependencies,
} from '../gateway/gateway-zone-orchestrator.js';

const capturedManagedVmCreation = new Error('captured managed VM creation');

function createExactVmOwnershipStub(options: {
	readonly bootId: string;
	readonly controllerEpoch: string;
	readonly generationId: string;
	readonly zoneId: string;
}): GatewayVmLifecycleAuthority {
	const gatewaySeed = {
		...options,
		gatewayEpochId: 'gateway-secret-resolution',
	};
	let gatewayIdentity: GatewayVmLifecycleAuthority['gatewayIdentity'];
	return {
		abandonUnattachedGatewaySeedAfter: async (cleanupOwnedResources) => {
			await cleanupOwnedResources();
		},
		attachGatewayVm: (gatewayVmId) => {
			gatewayIdentity = { ...gatewaySeed, gatewayVmId };
			return gatewayIdentity;
		},
		containPendingCreate: async ({ closeLateCreatedVm, pendingCreate }) => {
			await closeLateCreatedVm(await pendingCreate);
		},
		destroyLive: async (destroyGatewayVm) => await destroyGatewayVm(),
		get gatewayIdentity() {
			return gatewayIdentity;
		},
		gatewaySeed,
	};
}

describe('managed Hermes secret resolution', () => {
	it('batches startup 1Password refs through the production resolver and preserves audience boundaries', async () => {
		const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'gateway-secret-resolution-'));
		const gatewayConfigPath = path.join(tempRoot, 'config', 'hermes', 'config.yaml');
		const toolPortalConfigDir = path.join(tempRoot, 'config', 'tool-portal');
		await mkdir(path.dirname(gatewayConfigPath), { recursive: true });
		await mkdir(toolPortalConfigDir, { recursive: true });
		await writeFile(
			gatewayConfigPath,
			'plugins:\n  enabled:\n    - agent-vm-tool-portal\n  disabled: []\n',
			'utf8',
		);
		await writeFile(
			path.join(toolPortalConfigDir, 'mcp.config.jsonc'),
			JSON.stringify({ providers: {}, schemaVersion: 1 }),
			'utf8',
		);
		await writeFile(
			path.join(toolPortalConfigDir, 'tool-portal.config.jsonc'),
			JSON.stringify({
				agents: { main: { profile: 'default' } },
				mode: 'managed',
				profiles: { default: { namespaces: {} } },
				schemaVersion: 1,
			}),
			'utf8',
		);

		const systemConfig = createLoadedSystemConfig(
			{
				schemaVersion: 2,
				host: {
					controllerPort: 18_800,
					projectNamespace: 'gateway-secret-resolution',
					secretsProvider: {
						type: '1password',
						tokenSource: { envVar: 'OP_SERVICE_ACCOUNT_TOKEN', type: 'env' },
					},
				},
				imageProfiles: {
					gateways: {
						hermes: {
							buildConfig: path.join(tempRoot, 'hermes-image.json'),
							type: 'hermes',
						},
					},
					toolVms: {
						default: {
							buildConfig: path.join(tempRoot, 'tool-vm-image.json'),
							type: 'toolVm',
						},
					},
				},
				storageRootDir: path.join(tempRoot, 'storage'),
				tcpPool: { basePort: 19_000, size: 4 },
				toolVmProfiles: {
					standard: { cpus: 1, imageProfile: 'default', memory: '1G' },
				},
				zones: [
					{
						agents: [{ id: 'main' }],
						agentToolVmProfiles: {},
						defaultToolVmProfile: 'standard',
						egressHosts: [
							{ audience: 'gateway', host: 'api.perplexity.ai' },
							{ audience: 'tool-vm', host: 'api.example.test' },
						],
						gateway: {
							config: gatewayConfigPath,
							cpus: 1,
							imageProfile: 'hermes',
							memory: '1G',
							port: 18_791,
							profileSecretProjectionsByAgent: {
								main: {
									API_SERVER_KEY: 'API_SERVER_KEY_MAIN',
									DISCORD_BOT_TOKEN: 'DISCORD_BOT_TOKEN_MAIN',
									PERPLEXITY_API_KEY: 'PERPLEXITY_API_KEY',
								},
							},
							profilesByAgent: { main: 'main' },
							type: 'hermes',
						},
						id: 'secret-smoke',
						secrets: {
							API_SERVER_KEY: {
								audience: 'gateway',
								injection: 'env',
								source: 'config',
								value: 'test-root-api-server-key',
							},
							API_SERVER_KEY_MAIN: {
								audience: 'gateway',
								envVar: 'SECRET_SMOKE_ENV_ONLY_TOKEN',
								injection: 'env',
								source: 'environment',
							},
							PERPLEXITY_API_KEY: {
								audience: 'gateway',
								hosts: ['api.perplexity.ai'],
								injection: 'http-mediation',
								ref: 'op://agent-vm/secret-smoke-perplexity/credential',
								source: '1password',
							},
							DISCORD_BOT_TOKEN_MAIN: {
								audience: 'gateway',
								injection: 'env',
								ref: 'op://agent-vm/secret-smoke-gateway/password',
								source: '1password',
							},
							TOOL_VM_HTTP_TOKEN: {
								agentAccess: 'all',
								audience: 'tool-vm',
								hosts: ['api.example.test'],
								injection: 'http-mediation',
								ref: 'op://agent-vm/secret-smoke-tool-vm/credential',
								source: '1password',
							},
						},
						toolPortal: {
							configDir: toolPortalConfigDir,
							surfaceEligibilityByProfile: { default: {} },
						},
					},
				],
			},
			{ systemConfigPath: path.join(tempRoot, 'config', 'system.jsonc') },
		);
		const innerResolve = vi.fn(async () => {
			throw new Error('single-secret resolution must not be used');
		});
		const innerResolveAll = vi.fn(async (refs: Record<string, SecretRef>) =>
			Object.fromEntries(Object.keys(refs).map((name) => [name, `resolved:${name}`])),
		);
		const innerResolver: SecretResolver = {
			resolve: innerResolve,
			resolveAll: innerResolveAll,
		};
		const createInnerResolver = vi.fn(
			async ({ serviceAccountToken }: { readonly serviceAccountToken: string }) => {
				expect(serviceAccountToken).toBe('service-token');
				return innerResolver;
			},
		);
		const secretResolver = await createSecretResolverFromSystemConfig(
			systemConfig,
			createInnerResolver,
			async () => 'service-token',
		);
		const previousEnvironmentToken = process.env.SECRET_SMOKE_ENV_ONLY_TOKEN;
		process.env.SECRET_SMOKE_ENV_ONLY_TOKEN = 'env-only-token';
		let capturedCreateRequest: ManagedVmCreateRequest | undefined;
		let capturedStartupSecrets: Record<string, string> | undefined;
		const hermesLifecycle = loadGatewayLifecycle('hermes');
		const managedVmFactory = {
			createManagedVm: vi.fn(async (request: ManagedVmCreateRequest) => {
				capturedCreateRequest = request;
				throw capturedManagedVmCreation;
			}),
		} satisfies ManagedVmFactory;
		const managedVmImages = {
			prepareImage: vi.fn(async () => ({
				built: false,
				fingerprint: 'gateway-secret-resolution',
				imageReference: path.join(tempRoot, 'image'),
			})),
		} satisfies ManagedVmImageCapability;
		const gatewayStateRoot = resolveControllerGatewayStateRoot({
			controllerStateRoot: createControllerStateRoot({
				controllerStateDirectoryPath: systemConfig.controllerStateDir,
			}),
			zoneId: 'secret-smoke',
		});

		try {
			await expect(
				startGatewayZone(
					{
						controlSession: { controllerEpoch: 'controller-secret-resolution' },
						createVmOwnership: async ({ controlIdentity, zoneId }) => {
							if (controlIdentity === undefined) {
								throw new Error('Expected managed Gateway control identity.');
							}
							return createExactVmOwnershipStub({
								bootId: controlIdentity.bootId,
								controllerEpoch: 'controller-secret-resolution',
								generationId: controlIdentity.generationId,
								zoneId,
							});
						},
						observabilityStartupCheck: 'skip',
						runtimeRecordTarget: resolveControllerGatewayRecordTargets({ gatewayStateRoot })
							.managedGatewayRuntimeRecord,
						secretResolver,
						systemConfig,
						zoneId: 'secret-smoke',
					},
					{
						gatewayRuntimeArtifactLimits: {
							maximumArtifactBytes: 1_024 * 1_024,
							maximumArtifactCount: 32,
							maximumLifetimeMs: 5 * 60 * 1_000,
							maximumTotalBytes: 8 * 1_024 * 1_024,
						},
						loadGatewayLifecycle: () =>
							({
								...hermesLifecycle,
								buildVmRequirements: (options) => {
									capturedStartupSecrets = { ...options.resolvedSecrets };
									return hermesLifecycle.buildVmRequirements(options);
								},
								preflightHostState: async () => {},
								prepareHostState: async () => {},
							}) satisfies GatewayLifecycle,
						managedVmExactProcessTermination: {
							terminateRecordedHostProcess: async ({ identity }) => ({
								hostProcessId: identity.hostProcessId,
								kind: 'already-absent',
							}),
						},
						managedVmFactory,
						managedVmImages,
					} satisfies GatewayManagerDependencies,
				),
			).rejects.toBe(capturedManagedVmCreation);

			expect(createInnerResolver).toHaveBeenCalledOnce();
			expect(innerResolve).not.toHaveBeenCalled();
			expect(innerResolveAll).toHaveBeenCalledOnce();
			expect(innerResolveAll).toHaveBeenCalledWith({
				DISCORD_BOT_TOKEN_MAIN: {
					ref: 'op://agent-vm/secret-smoke-gateway/password',
					source: '1password',
				},
				PERPLEXITY_API_KEY: {
					ref: 'op://agent-vm/secret-smoke-perplexity/credential',
					source: '1password',
				},
			});
			expect(capturedStartupSecrets).toEqual({
				API_SERVER_KEY: 'test-root-api-server-key',
				API_SERVER_KEY_MAIN: 'env-only-token',
				DISCORD_BOT_TOKEN_MAIN: 'resolved:DISCORD_BOT_TOKEN_MAIN',
				PERPLEXITY_API_KEY: 'resolved:PERPLEXITY_API_KEY',
			});
			expect(capturedCreateRequest).toBeDefined();
			expect(capturedCreateRequest?.mediatedSecrets).toMatchObject([
				{
					allowedHosts: ['api.perplexity.ai'],
					environmentVariable: 'PERPLEXITY_API_KEY',
					value: 'resolved:PERPLEXITY_API_KEY',
				},
			]);
			expect(capturedCreateRequest?.environment).not.toHaveProperty('PERPLEXITY_API_KEY');
			expect(Object.values(capturedCreateRequest?.environment ?? {})).not.toContain(
				'resolved:PERPLEXITY_API_KEY',
			);
			expect(capturedCreateRequest?.imageReference).not.toContain('resolved:');

			await expect(
				resolveZoneSecrets({
					audience: 'tool-vm',
					injection: 'http-mediation',
					secretNames: new Set(['TOOL_VM_HTTP_TOKEN']),
					secretResolver,
					systemConfig,
					zoneId: 'secret-smoke',
				}),
			).resolves.toEqual({ TOOL_VM_HTTP_TOKEN: 'resolved:TOOL_VM_HTTP_TOKEN' });
			expect(innerResolveAll).toHaveBeenCalledTimes(2);
			expect(innerResolveAll).toHaveBeenLastCalledWith({
				TOOL_VM_HTTP_TOKEN: {
					ref: 'op://agent-vm/secret-smoke-tool-vm/credential',
					source: '1password',
				},
			});
		} finally {
			if (previousEnvironmentToken === undefined) {
				delete process.env.SECRET_SMOKE_ENV_ONLY_TOKEN;
			} else {
				process.env.SECRET_SMOKE_ENV_ONLY_TOKEN = previousEnvironmentToken;
			}
			await rm(tempRoot, { force: true, recursive: true });
		}
	});
});
