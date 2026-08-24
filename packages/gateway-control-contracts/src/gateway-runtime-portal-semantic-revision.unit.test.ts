import {
	effectiveManagedToolPortalConfigSchema,
	mcpConfigSchema,
	type EffectiveManagedToolPortalConfig,
	type McpConfig,
} from '@agent-vm/config-contracts';
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
	ManagedAgentProjectionSchema,
	type GatewayRuntimePortalSemanticSnapshot,
} from './gateway-runtime-portal-context.js';
import {
	assertGatewayRuntimePortalSemanticSnapshotMatchesInputs,
	deriveManagedAgentProjection,
	deriveGatewayRuntimePortalSemanticSnapshot,
	type ManagedAgentProjectionInput,
} from './gateway-runtime-portal-semantic-revision.js';

function createMcpConfig(): McpConfig {
	return mcpConfigSchema.parse({
		providers: {
			github: {
				kind: 'mcp',
				namespace: 'github',
				transport: {
					kind: 'streamable-http',
					requiredEgressHosts: ['api.github.com'],
					url: 'https://api.github.com/mcp',
				},
			},
		},
		schemaVersion: 1,
	});
}

function createToolPortalConfig(): EffectiveManagedToolPortalConfig {
	return effectiveManagedToolPortalConfigSchema.parse({
		agents: { builder: { profile: 'builder-profile' } },
		mode: 'managed',
		profiles: {
			'builder-profile': {
				namespaces: {
					sandbox: {
						discovery: {},
						backend: {
							kind: 'tool_vm_runner',
							operations: {
								exec: {
									description: 'Run the protected command.',
									executable: '/usr/bin/git',
									kind: 'command.fixed',
									mandatoryArgvPrefix: ['status'],
									workingDirectory: '.',
								},
							},
							profile: 'sandbox_ssh',
						},
						calls: {
							requiresApproval: { allow: [], deny: [] },
							withoutApproval: { allow: ['exec'], deny: [] },
						},
						tools: { allow: ['exec'], deny: [] },
					},
				},
			},
		},
		schemaVersion: 1,
	});
}

function createConfiguredCliToolPortalConfig(): EffectiveManagedToolPortalConfig {
	return effectiveManagedToolPortalConfigSchema.parse({
		agents: { builder: { profile: 'builder-profile' } },
		mode: 'managed',
		profiles: {
			'builder-profile': {
				namespaces: {
					sandbox: {
						backend: {
							kind: 'controller_execution',
							operations: {
								gog: {
									calls: {
										deny: [
											{
												flags: [
													{ names: ['--force', '-f'] },
													{ names: ['--format'], values: ['json', 'text'] },
												],
												path: ['drive', 'delete'],
											},
										],
										requiresApproval: [
											{
												flags: [{ names: ['--permanent'] }],
												path: ['drive', 'delete'],
											},
										],
										withoutApproval: 'remaining_admitted',
									},
									commands: [{ flagRules: [], path: ['drive', 'delete'] }],
									deniedPatterns: [],
									executablePath: '/usr/bin/gog',
									executionTarget: {
										cwd: '/var/empty',
										environment: { kind: 'empty' },
										kind: 'controller_host',
									},
									kind: 'configured_cli',
									mandatoryArgvPrefix: [],
									output: {
										modelVisibleStderr: 'none',
										overflow: 'fail',
										stderrMaxBytes: 1_024,
										stdoutMaxBytes: 1_024,
									},
									safeHelp: 'Run gog with exact argv.',
									stdin: { kind: 'none' },
									timeout: { kind: 'quick' },
								},
							},
						},
						calls: {
							requiresApproval: { allow: [], deny: [] },
							withoutApproval: { allow: ['gog'], deny: [] },
						},
						discovery: {},
						tools: { allow: ['gog'], deny: [] },
					},
				},
			},
		},
		schemaVersion: 1,
	});
}

function deriveFixtureSnapshot(props: {
	readonly mcpConfig: McpConfig;
	readonly toolPortalConfig: EffectiveManagedToolPortalConfig;
}): GatewayRuntimePortalSemanticSnapshot {
	return deriveGatewayRuntimePortalSemanticSnapshot({
		agentProjections: [
			{
				agentId: 'builder',
				frameworkIdentity: { agentId: 'builder', kind: 'openclaw' },
				toolPortalNamespaces: [{ namespace: 'sandbox' }],
				toolPortalProfileId: 'builder-profile',
			},
		],
		mcpConfig: props.mcpConfig,
		surfaceEligibilityByProfile: {
			'builder-profile': { sandbox: ['protected_uds'] },
		},
		toolPortalConfig: props.toolPortalConfig,
	});
}

describe('Gateway Runtime portal semantic revision', () => {
	it('derives assignment revisions only from the stable projection identity fields', () => {
		// Arrange
		const baselineInput: ManagedAgentProjectionInput = {
			agentId: 'builder',
			frameworkIdentity: { agentId: 'builder', kind: 'openclaw' as const },
			toolPortalNamespaces: [],
			toolPortalProfileId: 'builder-profile',
		};
		const baselineProjection = deriveManagedAgentProjection(baselineInput);

		// Act / Assert
		for (const changedProjection of [
			{ ...baselineInput, agentId: 'renamed' },
			{
				...baselineInput,
				frameworkIdentity: { agentId: 'renamed', kind: 'openclaw' as const },
			},
			{ ...baselineInput, toolPortalProfileId: 'reviewer-profile' },
		]) {
			const revision = deriveManagedAgentProjection(changedProjection).profileAssignmentRevision;
			expect(revision).not.toBe(baselineProjection.profileAssignmentRevision);
		}
		expect(Object.keys(baselineProjection).toSorted()).toEqual([
			'agentId',
			'frameworkIdentity',
			'profileAssignmentRevision',
			'toolPortalNamespaces',
			'toolPortalProfileId',
		]);
		expectTypeOf<ManagedAgentProjectionInput>().not.toHaveProperty('selfRoot');
		expectTypeOf<ManagedAgentProjectionInput>().not.toHaveProperty('workRoot');
	});

	it('accepts sorted unique namespace names and rejects malformed projection names', () => {
		// Arrange
		const validProjection = {
			agentId: 'builder',
			frameworkIdentity: { agentId: 'builder', kind: 'openclaw' as const },
			profileAssignmentRevision: 'profile-assignment-a',
			toolPortalNamespaces: [{ namespace: 'filesystem' }, { namespace: 'github' }],
			toolPortalProfileId: 'profile-a',
		};

		// Act / Assert
		expect(ManagedAgentProjectionSchema.safeParse(validProjection).success).toBe(true);
		for (const malformedProjection of [
			{
				...validProjection,
				toolPortalNamespaces: [{ namespace: 'filesystem' }, { namespace: 'filesystem' }],
			},
			{
				...validProjection,
				toolPortalNamespaces: [{ namespace: 'github' }, { namespace: 'filesystem' }],
			},
		]) {
			expect(ManagedAgentProjectionSchema.safeParse(malformedProjection).success).toBe(false);
			expect(() => deriveManagedAgentProjection(malformedProjection)).toThrow('must be');
		}
		const { toolPortalNamespaces: _names, ...missingNamesProjection } = validProjection;
		expect(ManagedAgentProjectionSchema.safeParse(missingNamesProjection).success).toBe(false);
	});

	it('derives namespace names in Unicode code-point order and rejects reverse order', () => {
		// Arrange
		const privateUseNamespace = '\uE000';
		const supplementaryNamespace = '\u{10000}';
		const validProjection: ManagedAgentProjectionInput = {
			agentId: 'builder',
			frameworkIdentity: { agentId: 'builder', kind: 'openclaw' },
			toolPortalNamespaces: [
				{ namespace: privateUseNamespace },
				{ namespace: supplementaryNamespace },
			],
			toolPortalProfileId: 'builder-profile',
		};

		// Act
		const derivedProjection = deriveManagedAgentProjection(validProjection);

		// Assert
		expect(derivedProjection.toolPortalNamespaces).toEqual([
			{ namespace: privateUseNamespace },
			{ namespace: supplementaryNamespace },
		]);
		expect(() =>
			deriveManagedAgentProjection({
				...validProjection,
				toolPortalNamespaces: [
					{ namespace: supplementaryNamespace },
					{ namespace: privateUseNamespace },
				],
			}),
		).toThrow('must be sorted');
	});

	it('includes admitted namespace names in assignment and cohort revisions', () => {
		// Arrange
		const mcpConfig = createMcpConfig();
		const toolPortalConfig = effectiveManagedToolPortalConfigSchema.parse({
			...createToolPortalConfig(),
			agents: { builder: { profile: 'builder-profile' } },
		});
		const baselineProjection = {
			agentId: 'builder',
			frameworkIdentity: { agentId: 'builder', kind: 'openclaw' as const },
			toolPortalNamespaces: [{ namespace: 'sandbox' }],
			toolPortalProfileId: 'builder-profile',
		};
		const derive = (
			toolPortalNamespaces: ManagedAgentProjectionInput['toolPortalNamespaces'],
			surfaceEligibilityByProfile: GatewayRuntimePortalSemanticSnapshot['surfaceEligibilityByProfile'],
		): GatewayRuntimePortalSemanticSnapshot =>
			deriveGatewayRuntimePortalSemanticSnapshot({
				agentProjections: [{ ...baselineProjection, toolPortalNamespaces }],
				mcpConfig,
				surfaceEligibilityByProfile,
				toolPortalConfig,
			});

		// Act
		const baseline = derive([{ namespace: 'sandbox' }], {
			'builder-profile': { sandbox: ['protected_uds'] },
		});
		const changed = derive([], { 'builder-profile': {} });

		// Assert
		const baselineAgentProjection = baseline.agentProjections.builder;
		const changedAgentProjection = changed.agentProjections.builder;
		if (baselineAgentProjection === undefined || changedAgentProjection === undefined) {
			throw new Error('Expected builder projection revisions for both namespace sets.');
		}
		expect(changedAgentProjection.profileAssignmentRevision).not.toBe(
			baselineAgentProjection.profileAssignmentRevision,
		);
		expect(changed.projectionCohortDigest).not.toBe(baseline.projectionCohortDigest);
	});

	it('rejects namespace names that do not match the protected_uds eligibility intersection', () => {
		// Arrange
		const mcpConfig = createMcpConfig();
		const toolPortalConfig = createToolPortalConfig();

		// Act / Assert
		expect(() =>
			deriveGatewayRuntimePortalSemanticSnapshot({
				agentProjections: [
					{
						agentId: 'builder',
						frameworkIdentity: { agentId: 'builder', kind: 'openclaw' },
						toolPortalNamespaces: [],
						toolPortalProfileId: 'builder-profile',
					},
				],
				mcpConfig,
				surfaceEligibilityByProfile: {
					'builder-profile': { sandbox: ['protected_uds'] },
				},
				toolPortalConfig,
			}),
		).toThrow('must exactly match');
	});

	it.each([
		['selfRoot', '/zone/agents/builder/self'],
		['workRoot', '/zone/agents/builder/work'],
	] as const)('rejects legacy %s path authority instead of hashing it', (field, value) => {
		// Arrange
		const stableInput: ManagedAgentProjectionInput = {
			agentId: 'builder',
			frameworkIdentity: { agentId: 'builder', kind: 'openclaw' },
			toolPortalNamespaces: [],
			toolPortalProfileId: 'builder-profile',
		};
		const legacyPathInput = { ...stableInput, [field]: value };

		// Act / Assert
		expect(() => deriveManagedAgentProjection(legacyPathInput)).toThrow('Unrecognized key');
	});

	it('derives one deterministic cohort digest from the exact sorted complete projection set', () => {
		// Arrange
		const mcpConfig = createMcpConfig();
		const toolPortalConfig = effectiveManagedToolPortalConfigSchema.parse({
			...createToolPortalConfig(),
			agents: {
				builder: { profile: 'builder-profile' },
				reviewer: { profile: 'builder-profile' },
			},
		});
		const projections: readonly ManagedAgentProjectionInput[] = [
			{
				agentId: 'builder',
				frameworkIdentity: { kind: 'hermes' as const, profileName: 'builder' },
				toolPortalNamespaces: [{ namespace: 'sandbox' }],
				toolPortalProfileId: 'builder-profile',
			},
			{
				agentId: 'reviewer',
				frameworkIdentity: { kind: 'hermes' as const, profileName: 'reviewer' },
				toolPortalNamespaces: [{ namespace: 'sandbox' }],
				toolPortalProfileId: 'builder-profile',
			},
		];
		const derive = (
			agentProjections: readonly ManagedAgentProjectionInput[],
		): GatewayRuntimePortalSemanticSnapshot =>
			deriveGatewayRuntimePortalSemanticSnapshot({
				agentProjections,
				mcpConfig,
				surfaceEligibilityByProfile: {
					'builder-profile': { sandbox: ['protected_uds'] },
				},
				toolPortalConfig,
			});

		// Act
		const baseline = derive(projections);
		const reordered = derive(projections.toReversed());
		const builderProjection = projections[0];
		const reviewerProjection = projections[1];
		if (builderProjection === undefined || reviewerProjection === undefined) {
			throw new Error('Expected the complete two-agent projection cohort fixture.');
		}
		const changed = derive([
			builderProjection,
			{
				...reviewerProjection,
				frameworkIdentity: { kind: 'hermes', profileName: 'reviewer-next' },
			},
		]);

		// Assert
		expect(reordered.projectionCohortDigest).toBe(baseline.projectionCohortDigest);
		expect(changed.projectionCohortDigest).not.toBe(baseline.projectionCohortDigest);
		expect(baseline.projectionCohortDigest).toMatch(/^projection-cohort:[a-f0-9]{64}$/u);
	});

	it('rejects duplicate identities, mixed framework kinds, and config set drift', () => {
		// Arrange
		const mcpConfig = createMcpConfig();
		const toolPortalConfig = effectiveManagedToolPortalConfigSchema.parse({
			...createToolPortalConfig(),
			agents: {
				builder: { profile: 'builder-profile' },
				reviewer: { profile: 'builder-profile' },
			},
		});
		const builderProjection: ManagedAgentProjectionInput = {
			agentId: 'builder',
			frameworkIdentity: { agentId: 'builder', kind: 'openclaw' as const },
			toolPortalNamespaces: [{ namespace: 'sandbox' }],
			toolPortalProfileId: 'builder-profile',
		};
		const derive = (
			agentProjections: readonly ManagedAgentProjectionInput[],
		): GatewayRuntimePortalSemanticSnapshot =>
			deriveGatewayRuntimePortalSemanticSnapshot({
				agentProjections,
				mcpConfig,
				surfaceEligibilityByProfile: {
					'builder-profile': { sandbox: ['protected_uds'] },
				},
				toolPortalConfig,
			});

		// Act / Assert
		expect(() => derive([builderProjection])).toThrow('exactly match');
		expect(() => derive([builderProjection, builderProjection])).toThrow('agent ids');
		expect(() =>
			derive([builderProjection, { ...builderProjection, agentId: 'reviewer' }]),
		).toThrow('framework identities');
		expect(() =>
			derive([
				builderProjection,
				{
					...builderProjection,
					agentId: 'reviewer',
					frameworkIdentity: { kind: 'hermes', profileName: 'reviewer' },
				},
			]),
		).toThrow('framework kind');
	});

	it('rejects a stale projection revision even when the protected configs still match', () => {
		// Arrange
		const mcpConfig = createMcpConfig();
		const toolPortalConfig = createToolPortalConfig();
		const semanticSnapshot = deriveFixtureSnapshot({ mcpConfig, toolPortalConfig });
		const projection = semanticSnapshot.agentProjections.builder;
		if (projection === undefined) throw new Error('Missing builder projection.');
		const staleSnapshot: GatewayRuntimePortalSemanticSnapshot = {
			...semanticSnapshot,
			agentProjections: {
				...semanticSnapshot.agentProjections,
				builder: { ...projection, profileAssignmentRevision: 'profile-assignment:stale' },
			},
		};

		// Act / Assert
		expect(() =>
			assertGatewayRuntimePortalSemanticSnapshotMatchesInputs({
				mcpConfig,
				semanticSnapshot: staleSnapshot,
				toolPortalConfig,
			}),
		).toThrow('semantic snapshot does not match');
	});
	it('derives and verifies one exact protected input cohort', () => {
		// Arrange
		const mcpConfig = createMcpConfig();
		const toolPortalConfig = createToolPortalConfig();
		const semanticSnapshot = deriveFixtureSnapshot({ mcpConfig, toolPortalConfig });

		// Act / Assert
		expect(() =>
			assertGatewayRuntimePortalSemanticSnapshotMatchesInputs({
				mcpConfig,
				semanticSnapshot,
				toolPortalConfig,
			}),
		).not.toThrow();
		expect(semanticSnapshot.activeRevision).toBe(semanticSnapshot.desiredRevision);
		expect(semanticSnapshot.bindingRevision).toMatch(/^binding:[a-f0-9]{64}$/u);
	});

	it('rejects stale revisions after protected command authority changes', () => {
		// Arrange
		const mcpConfig = createMcpConfig();
		const toolPortalConfig = createToolPortalConfig();
		const semanticSnapshot = deriveFixtureSnapshot({ mcpConfig, toolPortalConfig });
		const changedToolPortalConfig = structuredClone(toolPortalConfig);
		const sandboxNamespace =
			changedToolPortalConfig.profiles['builder-profile']?.namespaces.sandbox;
		const command =
			sandboxNamespace?.backend.kind === 'tool_vm_runner'
				? sandboxNamespace.backend.operations.exec
				: undefined;
		if (command?.kind !== 'command.fixed') throw new Error('Missing command fixture.');
		command.executable = '/usr/bin/false';

		// Act / Assert
		expect(() =>
			assertGatewayRuntimePortalSemanticSnapshotMatchesInputs({
				mcpConfig,
				semanticSnapshot,
				toolPortalConfig: changedToolPortalConfig,
			}),
		).toThrow('semantic snapshot does not match');
	});

	it('keeps configured CLI invocation revisions stable under semantic array reordering', () => {
		const mcpConfig = createMcpConfig();
		const toolPortalConfig = createConfiguredCliToolPortalConfig();
		const baseline = deriveFixtureSnapshot({ mcpConfig, toolPortalConfig });
		const reorderedConfig = structuredClone(toolPortalConfig);
		const namespace = reorderedConfig.profiles['builder-profile']?.namespaces.sandbox;
		const operation =
			namespace?.backend.kind === 'controller_execution'
				? namespace.backend.operations.gog
				: undefined;
		if (operation?.kind !== 'configured_cli') throw new Error('Missing configured CLI fixture.');
		const denyMatcher = operation.calls.deny[0];
		if (denyMatcher === undefined) throw new Error('Missing deny matcher fixture.');
		operation.calls.deny = [
			{
				...denyMatcher,
				flags: denyMatcher.flags.toReversed().map((predicate) => ({
					...predicate,
					names: predicate.names.toReversed(),
					...(predicate.values === undefined ? {} : { values: predicate.values.toReversed() }),
				})),
			},
		];
		const reordered = deriveFixtureSnapshot({ mcpConfig, toolPortalConfig: reorderedConfig });

		expect(reordered.bindingRevision).toBe(baseline.bindingRevision);
		expect(reordered.activeRevision).toBe(baseline.activeRevision);
	});

	it.each(['path', 'name', 'value', 'bucket'] as const)(
		'changes configured CLI freshness after a material %s mutation',
		(mutation) => {
			const mcpConfig = createMcpConfig();
			const toolPortalConfig = createConfiguredCliToolPortalConfig();
			const baseline = deriveFixtureSnapshot({ mcpConfig, toolPortalConfig });
			const changedConfig = structuredClone(toolPortalConfig);
			const namespace = changedConfig.profiles['builder-profile']?.namespaces.sandbox;
			const operation =
				namespace?.backend.kind === 'controller_execution'
					? namespace.backend.operations.gog
					: undefined;
			if (operation?.kind !== 'configured_cli') throw new Error('Missing configured CLI fixture.');
			const matcher = operation.calls.deny[0];
			const predicate = matcher?.flags[1];
			if (matcher === undefined || predicate?.values === undefined) {
				throw new Error('Missing matcher mutation fixture.');
			}
			switch (mutation) {
				case 'path':
					matcher.path = ['drive', 'remove'];
					break;
				case 'name':
					predicate.names = ['--output'];
					break;
				case 'value':
					predicate.values = ['yaml'];
					break;
				case 'bucket':
					operation.calls.requiresApproval.push(matcher);
					operation.calls.deny = [];
					break;
			}
			const changed = deriveFixtureSnapshot({ mcpConfig, toolPortalConfig: changedConfig });

			expect(changed.bindingRevision).not.toBe(baseline.bindingRevision);
			expect(changed.activeRevision).not.toBe(baseline.activeRevision);
		},
	);

	it('rejects stale revisions after protected MCP provider material changes', () => {
		// Arrange
		const mcpConfig = createMcpConfig();
		const toolPortalConfig = createToolPortalConfig();
		const semanticSnapshot = deriveFixtureSnapshot({ mcpConfig, toolPortalConfig });
		const changedMcpConfig = structuredClone(mcpConfig);
		const provider = changedMcpConfig.providers.github;
		if (provider?.transport.kind !== 'streamable-http') {
			throw new Error('Missing HTTP MCP provider fixture.');
		}
		provider.transport.url = 'https://changed.example.com/mcp';

		// Act / Assert
		expect(() =>
			assertGatewayRuntimePortalSemanticSnapshotMatchesInputs({
				mcpConfig: changedMcpConfig,
				semanticSnapshot,
				toolPortalConfig,
			}),
		).toThrow('semantic snapshot does not match');
	});
});
