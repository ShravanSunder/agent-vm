import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
	GatewayRuntimeServiceConfigSchema,
	loadGatewayRuntimeServiceConfig,
	type GatewayRuntimeServiceConfig,
} from './gateway-runtime-service-config.js';

function validServiceConfig(runtimeRoot: string): GatewayRuntimeServiceConfig {
	return {
		artifactLimits: {
			maximumArtifactBytes: 1_024,
			maximumArtifactCount: 8,
			maximumLifetimeMs: 60_000,
			maximumTotalBytes: 8_192,
		},
		attachment: {
			attachmentGeneration: 1,
			clientKind: 'hermes-managed-plugin',
			configuredAgentIds: ['agent-a', 'agent-b'],
			frameworkEpoch: 'framework-epoch-1',
			gatewayEpoch: 'gateway-epoch-1',
			projectionCohortDigest:
				'projection-cohort:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			runtimeEpoch: 'runtime-epoch-1',
		},
		controlEndpoint: {
			authority: {
				callerContextAgentAuthorityKeys: {
					'agent-a': 'agent-a-authority-key',
					'agent-b': 'agent-b-authority-key',
				},
				callerContextProofKey: 'caller-context-proof-key',
				verifierPublicKeyPem: 'test-verifier-public-key',
			},
			identity: {
				bootId: 'boot-1',
				controllerEpoch: 'controller-epoch-1',
				generationId: 'generation-1',
				peerId: 'peer-1',
				processEpoch: 'process-epoch-1',
				zoneId: 'zone-a',
			},
			listen: { host: '127.0.0.1', port: 18790 },
		},
		gatewayRuntimeInputRevision: `gateway-runtime-input:${'a'.repeat(64)}`,
		mcpConfigPath: path.join(runtimeRoot, 'mcp.config.json'),
		observability: { kind: 'disabled' },
		runtimeRoot,
		schemaVersion: 1,
		semanticSnapshot: {
			activeRevision: 'semantic-1',
			agentProjections: {
				'agent-a': {
					agentId: 'agent-a',
					frameworkIdentity: { kind: 'hermes', profileName: 'agent-a-profile' },
					profileAssignmentRevision: 'profile-assignment-a-1',
					toolPortalNamespaces: [],
					toolPortalProfileId: 'profile-a',
				},
				'agent-b': {
					agentId: 'agent-b',
					frameworkIdentity: { kind: 'hermes', profileName: 'agent-b-profile' },
					profileAssignmentRevision: 'profile-assignment-b-1',
					toolPortalNamespaces: [],
					toolPortalProfileId: 'profile-b',
				},
			},
			bindingRevision: 'binding-1',
			catalogRevision: 'catalog-1',
			desiredRevision: 'semantic-1',
			profilePolicyRevision: 'policy-1',
			projectionCohortDigest:
				'projection-cohort:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			providerRevision: 'provider-1',
			schemaRevision: 'schema-1',
			schemaVersion: 1,
			surfaceEligibilityByProfile: {
				'profile-a': {},
				'profile-b': {},
			},
		},
		serviceIdentity: {
			processEpoch: 'process-epoch-1',
			role: 'tool-portal',
			serviceId: 'tool-portal-zone-a',
		},
		toolPortalConfig: {
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
		},
	} satisfies GatewayRuntimeServiceConfig;
}

describe('Gateway runtime immutable service config', () => {
	it('accepts one exact multi-agent framework/tool-portal/snapshot cohort', () => {
		// Arrange
		const runtimeRoot = path.join(os.tmpdir(), 'gateway-runtime-config-valid');

		// Act
		const parsedConfig = GatewayRuntimeServiceConfigSchema.parse(validServiceConfig(runtimeRoot));

		// Assert
		expect(parsedConfig.attachment.configuredAgentIds).toEqual(['agent-a', 'agent-b']);
		expect(parsedConfig.semanticSnapshot.activeRevision).toBe('semantic-1');
		expect(parsedConfig.serviceIdentity.role).toBe('tool-portal');
	});

	it('accepts only the exact bounded Tool Portal OTLP producer contract', () => {
		// Arrange
		const config = validServiceConfig(path.join(os.tmpdir(), 'gateway-runtime-config-otel'));
		config.observability = {
			admissionLimits: {
				maxExportBatchRecords: 64,
				maxQueuedRecordsPerSignal: 256,
				maxRecordBytes: 65_536,
			},
			endpoint: 'http://otel-collector.observability.vm.host:4318',
			flushIntervalMs: 1_000,
			kind: 'otlp-http',
			logs: true,
			metrics: true,
			sampleRate: 1,
			serviceName: 'agent-vm-tool-portal',
			sourcePolicy: { admitBaggage: false, captureContent: false },
			traces: true,
		};

		// Act
		const parsedConfig = GatewayRuntimeServiceConfigSchema.parse(config);

		// Assert
		expect(parsedConfig.observability).toEqual(config.observability);
	});

	it.each([
		{
			label: 'altered service identity',
			mutate: (observability: Record<string, unknown>): void => {
				observability.serviceName = 'agent-vm-hermes';
			},
		},
		{
			label: 'content capture',
			mutate: (observability: Record<string, unknown>): void => {
				observability.sourcePolicy = { admitBaggage: false, captureContent: true };
			},
		},
		{
			label: 'baggage admission',
			mutate: (observability: Record<string, unknown>): void => {
				observability.sourcePolicy = { admitBaggage: true, captureContent: false };
			},
		},
		{
			label: 'altered admission limits',
			mutate: (observability: Record<string, unknown>): void => {
				observability.admissionLimits = {
					maxExportBatchRecords: 65,
					maxQueuedRecordsPerSignal: 256,
					maxRecordBytes: 65_536,
				};
			},
		},
		{
			label: 'non-HTTP endpoint',
			mutate: (observability: Record<string, unknown>): void => {
				observability.endpoint = 'https://collector.example.test:4318';
			},
		},
		{
			label: 'credential-bearing endpoint',
			mutate: (observability: Record<string, unknown>): void => {
				observability.endpoint = 'http://token@collector.example.test:4318';
			},
		},
		{
			label: 'unknown producer field',
			mutate: (observability: Record<string, unknown>): void => {
				observability.baggage = 'forbidden';
			},
		},
	])('rejects $label in protected Tool Portal observability config', ({ mutate }) => {
		// Arrange
		const config = structuredClone(
			validServiceConfig(path.join(os.tmpdir(), 'gateway-runtime-config-otel-invalid')),
		);
		const observability: Record<string, unknown> = {
			admissionLimits: {
				maxExportBatchRecords: 64,
				maxQueuedRecordsPerSignal: 256,
				maxRecordBytes: 65_536,
			},
			endpoint: 'http://otel-collector.observability.vm.host:4318',
			flushIntervalMs: 1_000,
			kind: 'otlp-http',
			logs: true,
			metrics: true,
			sampleRate: 1,
			serviceName: 'agent-vm-tool-portal',
			sourcePolicy: { admitBaggage: false, captureContent: false },
			traces: true,
		};
		mutate(observability);

		// Act
		const result = GatewayRuntimeServiceConfigSchema.safeParse({
			...config,
			observability,
		});

		// Assert
		expect(result.success).toBe(false);
	});

	it('rejects the retired managed MCP projection listener field', () => {
		// Arrange
		const config = validServiceConfig(path.join(os.tmpdir(), 'gateway-runtime-config-required'));
		const configWithRetiredListener = {
			...config,
			managedMcpProjection: {
				kind: 'enabled',
				projectionConfig: {
					audience: 'gateway-zone-a-managed-mcp',
					credentialSet: {
						audience: 'gateway-zone-a-managed-mcp',
						credentials: [
							{
								bearerToken: 'retired-public-listener-token',
								principal: {
									agentId: 'agent-a',
									environmentScope: 'gateway-zone-a-runtime-epoch-1',
									frameworkKind: 'hermes',
									profileAssignmentRevision: 'profile-assignment-a-1',
									profileId: 'profile-a',
									workspaceId: 'workspace-agent-a',
								},
							},
						],
						version: 'retired-credential-version',
					},
					guestPort: 18_791,
					routePath: '/mcp',
				},
			},
		};

		// Act
		const result = GatewayRuntimeServiceConfigSchema.safeParse(configWithRetiredListener);

		// Assert
		expect(result.success).toBe(false);
	});

	it('rejects standalone Tool Portal configuration at the managed service boundary', () => {
		// Arrange
		const config = validServiceConfig(path.join(os.tmpdir(), 'gateway-runtime-config-mode'));
		const standaloneConfig = {
			...config,
			toolPortalConfig: {
				...config.toolPortalConfig,
				authentication: { agents: {} },
				drain: { timeoutMs: 1_000 },
				entrypoints: { stdio: { authentication: { agentId: 'agent-a' } } },
				mode: 'standalone',
			},
		};

		// Act
		const result = GatewayRuntimeServiceConfigSchema.safeParse(standaloneConfig);

		// Assert
		expect(result.success).toBe(false);
	});

	it.each([
		{
			label: 'duplicate configured agent',
			mutate: (config: GatewayRuntimeServiceConfig): void => {
				config.attachment.configuredAgentIds = ['agent-a', 'agent-a'];
			},
		},
		{
			label: 'profile mismatch',
			mutate: (config: GatewayRuntimeServiceConfig): void => {
				const agentConfig = config.toolPortalConfig.agents['agent-a'];
				if (agentConfig === undefined) throw new Error('Missing agent-a Tool Portal test config.');
				agentConfig.profile = 'profile-b';
			},
		},
		{
			label: 'agent-set mismatch',
			mutate: (config: GatewayRuntimeServiceConfig): void => {
				delete config.semanticSnapshot.agentProjections['agent-b'];
			},
		},
		{
			label: 'projection cohort digest mismatch',
			mutate: (config: GatewayRuntimeServiceConfig): void => {
				config.attachment.projectionCohortDigest =
					'projection-cohort:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
			},
		},
		{
			label: 'caller-context authority set mismatch',
			mutate: (config: GatewayRuntimeServiceConfig): void => {
				delete config.controlEndpoint.authority.callerContextAgentAuthorityKeys['agent-b'];
			},
		},
		{
			label: 'inactive semantic revision',
			mutate: (config: GatewayRuntimeServiceConfig): void => {
				config.semanticSnapshot.activeRevision = 'semantic-old';
			},
		},
	])('rejects $label before service construction', ({ mutate }) => {
		// Arrange
		const config = structuredClone(
			validServiceConfig(path.join(os.tmpdir(), 'gateway-runtime-config-invalid')),
		);
		mutate(config);

		// Act
		const result = GatewayRuntimeServiceConfigSchema.safeParse(config);

		// Assert
		expect(result.success).toBe(false);
	});

	it('loads only a user-owned regular file without group or other permissions', async () => {
		// Arrange
		const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'gateway-runtime-config-file-'));
		const configPath = path.join(temporaryRoot, 'runtime.json');
		try {
			await writeFile(configPath, JSON.stringify(validServiceConfig(temporaryRoot)), {
				mode: 0o600,
			});

			// Act
			const loadedConfig = await loadGatewayRuntimeServiceConfig(configPath);

			// Assert
			expect(loadedConfig.attachment.runtimeEpoch).toBe('runtime-epoch-1');
		} finally {
			await rm(temporaryRoot, { force: true, recursive: true });
		}
	});

	it('accepts the ephemeral listener sentinel when loading executable test input', async () => {
		// Arrange
		const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'gateway-runtime-config-port-'));
		const configPath = path.join(temporaryRoot, 'runtime.json');
		try {
			const config = validServiceConfig(temporaryRoot);
			config.controlEndpoint.listen = { host: '127.0.0.1', port: 0 };
			await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });

			// Act
			const loadedConfig = await loadGatewayRuntimeServiceConfig(configPath);

			// Assert
			expect(loadedConfig.controlEndpoint.listen).toEqual({ host: '127.0.0.1', port: 0 });
		} finally {
			await rm(temporaryRoot, { force: true, recursive: true });
		}
	});

	it('rejects an unassigned fixed control endpoint when loading executable input', async () => {
		// Arrange
		const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'gateway-runtime-config-port-'));
		const configPath = path.join(temporaryRoot, 'runtime.json');
		try {
			const config = validServiceConfig(temporaryRoot);
			config.controlEndpoint.listen = { host: '127.0.0.1', port: 18_791 };
			await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });

			// Act / Assert
			await expect(loadGatewayRuntimeServiceConfig(configPath)).rejects.toThrow();
		} finally {
			await rm(temporaryRoot, { force: true, recursive: true });
		}
	});

	it('rejects broad permissions and symlink config inputs', async () => {
		// Arrange
		const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'gateway-runtime-config-unsafe-'));
		const configPath = path.join(temporaryRoot, 'runtime.json');
		const symlinkPath = path.join(temporaryRoot, 'runtime-link.json');
		try {
			await writeFile(configPath, JSON.stringify(validServiceConfig(temporaryRoot)), {
				mode: 0o600,
			});
			await symlink(configPath, symlinkPath);

			// Act / Assert
			await chmod(configPath, 0o640);
			await expect(loadGatewayRuntimeServiceConfig(configPath)).rejects.toThrow(
				'group or other permissions',
			);
			await chmod(configPath, 0o600);
			await expect(loadGatewayRuntimeServiceConfig(symlinkPath)).rejects.toThrow(
				'regular non-symlink file',
			);
		} finally {
			await rm(temporaryRoot, { force: true, recursive: true });
		}
	});
});
