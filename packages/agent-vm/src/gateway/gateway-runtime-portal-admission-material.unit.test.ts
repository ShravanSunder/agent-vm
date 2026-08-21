import {
	mcpConfigSchema,
	toolPortalConfigSchema,
	type McpConfig,
	type McpProvider,
	type ToolPortalNamespacePolicy,
	type ToolPortalSandboxSshBackendBinding,
	type ToolPortalConfig,
	type ToolPortalProfileDefinition,
} from '@agent-vm/config-contracts';
import {
	GatewayRuntimePortalAdmissionMaterialSchema,
	type GatewayRuntimePortalSemanticSnapshot,
	type ManagedAgentProjection,
	type ManagedFrameworkAgentProjectionInput,
} from '@agent-vm/gateway-control-contracts';
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
	materializeGatewayRuntimePortalAdmission,
	type MaterializeGatewayRuntimePortalAdmissionProps,
} from './gateway-runtime-portal-admission-material.js';
import type { McpPortalEffectiveConfigPlan } from './mcp-portal-effective-config.js';

type GatewayRuntimeAdmissionConfigPlan = Pick<
	McpPortalEffectiveConfigPlan,
	'effectiveMcpConfig' | 'effectiveToolPortalConfig'
>;

interface ExpectedMaterializationProps {
	readonly agentProjections: readonly ManagedFrameworkAgentProjectionInput[];
	readonly effectivePlan: GatewayRuntimeAdmissionConfigPlan;
	readonly surfaceEligibilityByProfile: GatewayRuntimePortalSemanticSnapshot['surfaceEligibilityByProfile'];
}

const githubToolSelector = {
	allow: ['issues.get', 'issues.list'],
	deny: ['issues.archive', 'issues.delete'],
} as const;
const githubCallPolicy = {
	requiresApproval: { allow: ['issues.delete', 'issues.update'], deny: [] },
	withoutApproval: { allow: ['issues.get', 'issues.list'], deny: [] },
} as const;
const filesystemToolSelector = {
	allow: ['files.read', 'files.stat'],
	deny: ['files.delete', 'files.write'],
} as const;
const filesystemCallPolicy = {
	requiresApproval: { allow: ['files.delete', 'files.write'], deny: [] },
	withoutApproval: { allow: ['files.read', 'files.stat'], deny: [] },
} as const;

function createGatewayRuntimeAdmissionConfigPlan(): GatewayRuntimeAdmissionConfigPlan {
	return {
		effectiveMcpConfig: mcpConfigSchema.parse({
			providers: {
				github: {
					kind: 'mcp',
					namespace: 'github',
					transport: {
						kind: 'streamable-http',
						requiredEgressHosts: ['api.github.com', 'uploads.github.com'],
						url: 'https://api.github.com/mcp',
					},
				},
				filesystem: {
					kind: 'mcp',
					namespace: 'filesystem',
					transport: {
						args: ['--root', '/work'],
						command: 'filesystem-mcp-server',
						kind: 'stdio',
						networkAccess: 'declared',
						requiredEgressHosts: ['packages.example.com', 'registry.example.com'],
					},
				},
			},
			schemaVersion: 1,
		}),
		effectiveToolPortalConfig: toolPortalConfigSchema.parse({
			agents: {
				'agent-a': { profile: 'code-builder' },
				'agent-b': { profile: 'code-reviewer' },
			},
			mode: 'managed',
			profiles: {
				'code-builder': {
					namespaces: {
						github: {
							backend: { kind: 'mcp_provider' },
							calls: githubCallPolicy,
							tools: githubToolSelector,
						},
						filesystem: {
							backend: { kind: 'mcp_provider' },
							calls: filesystemCallPolicy,
							tools: filesystemToolSelector,
						},
					},
				},
				'code-reviewer': {
					namespaces: {
						github: {
							backend: { kind: 'mcp_provider' },
							calls: githubCallPolicy,
							tools: githubToolSelector,
						},
						filesystem: {
							backend: { kind: 'mcp_provider' },
							calls: filesystemCallPolicy,
							tools: filesystemToolSelector,
						},
					},
				},
			},
			schemaVersion: 1,
		}),
	};
}

function createMaterializationProps(): MaterializeGatewayRuntimePortalAdmissionProps {
	return {
		agentProjections: [
			{
				agentId: 'agent-a',
				frameworkIdentity: { agentId: 'agent-a', kind: 'openclaw' },
				toolPortalProfileId: 'code-builder',
			},
			{
				agentId: 'agent-b',
				frameworkIdentity: { agentId: 'agent-b', kind: 'openclaw' },
				toolPortalProfileId: 'code-reviewer',
			},
		],
		effectivePlan: createGatewayRuntimeAdmissionConfigPlan(),
		surfaceEligibilityByProfile: {
			'code-builder': {
				filesystem: ['mcp', 'protected_uds'],
				github: ['mcp', 'protected_uds'],
			},
			'code-reviewer': {
				filesystem: ['mcp', 'protected_uds'],
				github: ['mcp', 'protected_uds'],
			},
		},
	};
}

function requireMcpProvider(config: McpConfig, providerId: 'filesystem' | 'github'): McpProvider {
	const provider = config.providers[providerId];
	if (provider === undefined) {
		throw new Error(`Expected MCP provider "${providerId}" in test config.`);
	}
	return provider;
}

function requireToolPortalProfile(
	config: ToolPortalConfig,
	profileId: 'code-builder' | 'code-reviewer',
): ToolPortalProfileDefinition {
	const profile = config.profiles[profileId];
	if (profile === undefined) {
		throw new Error(`Expected Tool Portal profile "${profileId}" in test config.`);
	}
	return profile;
}

function requireToolPortalNamespace(
	profile: ToolPortalProfileDefinition,
	namespaceId: 'filesystem' | 'github',
): ToolPortalNamespacePolicy {
	const namespacePolicy = profile.namespaces[namespaceId];
	if (namespacePolicy === undefined) {
		throw new Error(`Expected Tool Portal namespace "${namespaceId}" in test config.`);
	}
	return namespacePolicy;
}

function requireAgentProjection(
	snapshot: GatewayRuntimePortalSemanticSnapshot,
	agentId: 'agent-a' | 'agent-b',
): ManagedAgentProjection {
	const projection = snapshot.agentProjections[agentId];
	if (projection === undefined) {
		throw new Error(`Expected Gateway Runtime projection for "${agentId}".`);
	}
	return projection;
}

const sandboxRunnerOperations = {
	'issues.archive': {
		description: 'Archive one configured issue.',
		executable: '/usr/bin/true',
		kind: 'command.fixed',
		mandatoryArgvPrefix: ['archive', 'issue'],
		workingDirectory: '.',
	},
	'issues.delete': {
		description: 'Delete one configured issue.',
		executable: '/usr/bin/true',
		kind: 'command.fixed',
		mandatoryArgvPrefix: ['delete', 'issue'],
		workingDirectory: '.',
	},
	'issues.get': {
		description: 'Read one configured issue.',
		kind: 'filesystem.read',
	},
	'issues.list': {
		description: 'List configured issues.',
		kind: 'filesystem.read',
	},
	'issues.update': {
		description: 'Update one configured issue.',
		executable: '/usr/bin/true',
		kind: 'command.fixed',
		mandatoryArgvPrefix: ['update', 'issue'],
		workingDirectory: '.',
	},
} as const satisfies ToolPortalSandboxSshBackendBinding['operations'];

function withCodeBuilderGithubRunner(
	props: MaterializeGatewayRuntimePortalAdmissionProps,
	operations: ToolPortalSandboxSshBackendBinding['operations'],
): MaterializeGatewayRuntimePortalAdmissionProps {
	const codeBuilderProfile = requireToolPortalProfile(
		props.effectivePlan.effectiveToolPortalConfig,
		'code-builder',
	);
	const githubNamespace = requireToolPortalNamespace(codeBuilderProfile, 'github');
	return {
		...props,
		effectivePlan: {
			...props.effectivePlan,
			effectiveToolPortalConfig: toolPortalConfigSchema.parse({
				...props.effectivePlan.effectiveToolPortalConfig,
				profiles: {
					...props.effectivePlan.effectiveToolPortalConfig.profiles,
					'code-builder': {
						...codeBuilderProfile,
						namespaces: {
							...codeBuilderProfile.namespaces,
							github: {
								...githubNamespace,
								backend: {
									kind: 'tool_vm_runner',
									operations,
									profile: 'sandbox_ssh',
								},
							},
						},
					},
				},
			}),
		},
	};
}

describe('Gateway runtime portal admission materialization', () => {
	it('materializes one deterministic controller-authored semantic snapshot from parsed configs', () => {
		// Arrange
		const props = createMaterializationProps();

		// Act
		const firstMaterialization = materializeGatewayRuntimePortalAdmission(props);
		const secondMaterialization = materializeGatewayRuntimePortalAdmission(props);
		const parsedAdmission = GatewayRuntimePortalAdmissionMaterialSchema.parse(firstMaterialization);
		const semanticSnapshot = firstMaterialization.semanticSnapshot;
		const agentProjection = requireAgentProjection(semanticSnapshot, 'agent-a');

		// Assert
		expect(secondMaterialization).toEqual(firstMaterialization);
		expect(parsedAdmission).toEqual(firstMaterialization);
		expect(parsedAdmission).not.toHaveProperty('effectivePortalConfig');
		expect(firstMaterialization).toEqual({
			effectiveMcpConfig: props.effectivePlan.effectiveMcpConfig,
			effectiveToolPortalConfig: props.effectivePlan.effectiveToolPortalConfig,
			semanticSnapshot: {
				activeRevision: semanticSnapshot.activeRevision,
				agentProjections: {
					'agent-a': {
						agentId: 'agent-a',
						frameworkIdentity: { agentId: 'agent-a', kind: 'openclaw' },
						profileAssignmentRevision: agentProjection.profileAssignmentRevision,
						toolPortalNamespaceNames: ['filesystem', 'github'],
						toolPortalProfileId: 'code-builder',
					},
					'agent-b': {
						agentId: 'agent-b',
						frameworkIdentity: { agentId: 'agent-b', kind: 'openclaw' },
						profileAssignmentRevision: requireAgentProjection(semanticSnapshot, 'agent-b')
							.profileAssignmentRevision,
						toolPortalNamespaceNames: ['filesystem', 'github'],
						toolPortalProfileId: 'code-reviewer',
					},
				},
				bindingRevision: semanticSnapshot.bindingRevision,
				catalogRevision: semanticSnapshot.catalogRevision,
				desiredRevision: semanticSnapshot.desiredRevision,
				profilePolicyRevision: semanticSnapshot.profilePolicyRevision,
				projectionCohortDigest: semanticSnapshot.projectionCohortDigest,
				providerRevision: semanticSnapshot.providerRevision,
				schemaRevision: semanticSnapshot.schemaRevision,
				schemaVersion: 1,
				surfaceEligibilityByProfile: props.surfaceEligibilityByProfile,
			},
		});
		expect(firstMaterialization.semanticSnapshot.activeRevision).toBe(
			firstMaterialization.semanticSnapshot.desiredRevision,
		);
		expect(Object.keys(firstMaterialization).toSorted()).toEqual([
			'effectiveMcpConfig',
			'effectiveToolPortalConfig',
			'semanticSnapshot',
		]);
	});

	it('projects the sorted protected Tool Portal namespace names for every profile', () => {
		// Arrange
		const props = createMaterializationProps();

		// Act
		const materialization = materializeGatewayRuntimePortalAdmission(props);
		const builderProjection = requireAgentProjection(materialization.semanticSnapshot, 'agent-a');
		const reviewerProjection = requireAgentProjection(materialization.semanticSnapshot, 'agent-b');

		// Assert
		expect(builderProjection.toolPortalNamespaceNames).toEqual(['filesystem', 'github']);
		expect(reviewerProjection.toolPortalNamespaceNames).toEqual(['filesystem', 'github']);
	});

	it('derives admitted namespace names from the protected_uds eligibility intersection', () => {
		// Arrange
		const props = createMaterializationProps();
		const changedSurfaceProps: MaterializeGatewayRuntimePortalAdmissionProps = {
			...props,
			surfaceEligibilityByProfile: {
				...props.surfaceEligibilityByProfile,
				'code-builder': {
					filesystem: ['protected_uds'],
					github: ['mcp'],
				},
			},
		};

		// Act
		const materialization = materializeGatewayRuntimePortalAdmission(changedSurfaceProps);
		const builderProjection = requireAgentProjection(materialization.semanticSnapshot, 'agent-a');

		// Assert
		expect(builderProjection.toolPortalNamespaceNames).toEqual(['filesystem']);
	});

	it('derives admitted namespace names in Unicode code-point order', () => {
		// Arrange
		const privateUseNamespace = '\uE000';
		const supplementaryNamespace = '\u{10000}';
		const props = createMaterializationProps();
		const codeBuilderProfile = requireToolPortalProfile(
			props.effectivePlan.effectiveToolPortalConfig,
			'code-builder',
		);
		const githubNamespace = requireToolPortalNamespace(codeBuilderProfile, 'github');
		const effectiveToolPortalConfig = toolPortalConfigSchema.parse({
			...props.effectivePlan.effectiveToolPortalConfig,
			profiles: {
				...props.effectivePlan.effectiveToolPortalConfig.profiles,
				'code-builder': {
					...codeBuilderProfile,
					namespaces: {
						[privateUseNamespace]: githubNamespace,
						[supplementaryNamespace]: githubNamespace,
					},
				},
			},
		});
		const codePointProps: MaterializeGatewayRuntimePortalAdmissionProps = {
			...props,
			effectivePlan: {
				...props.effectivePlan,
				effectiveToolPortalConfig,
			},
			surfaceEligibilityByProfile: {
				...props.surfaceEligibilityByProfile,
				'code-builder': {
					[privateUseNamespace]: ['protected_uds'],
					[supplementaryNamespace]: ['protected_uds'],
				},
			},
		};

		// Act
		const materialization = materializeGatewayRuntimePortalAdmission(codePointProps);
		const builderProjection = requireAgentProjection(materialization.semanticSnapshot, 'agent-a');

		// Assert
		expect(builderProjection.toolPortalNamespaceNames).toEqual([
			privateUseNamespace,
			supplementaryNamespace,
		]);
	});

	it('rejects the retired managed MCP field at the strict admission boundary', () => {
		// Arrange
		const materialization = materializeGatewayRuntimePortalAdmission(createMaterializationProps());

		// Act
		const parseResult = GatewayRuntimePortalAdmissionMaterialSchema.safeParse({
			...materialization,
			managedMcp: { kind: 'disabled' },
		});

		// Assert
		expect(parseResult.success).toBe(false);
		if (parseResult.success) {
			throw new Error('Expected strict admission parsing to reject managedMcp.');
		}
		expect(parseResult.error.issues).toContainEqual(
			expect.objectContaining({
				code: 'unrecognized_keys',
				keys: ['managedMcp'],
				path: [],
			}),
		);
	});

	it('rejects the removed effectivePortalConfig field at the strict admission boundary', () => {
		// Arrange
		const materialization = materializeGatewayRuntimePortalAdmission(createMaterializationProps());

		// Act
		const parseResult = GatewayRuntimePortalAdmissionMaterialSchema.safeParse({
			...materialization,
			effectivePortalConfig: { schemaVersion: 1 },
		});

		// Assert
		expect(parseResult.success).toBe(false);
		if (parseResult.success) {
			throw new Error('Expected strict admission parsing to reject effectivePortalConfig.');
		}
		expect(parseResult.error.issues).toContainEqual(
			expect.objectContaining({
				code: 'unrecognized_keys',
				keys: ['effectivePortalConfig'],
				path: [],
			}),
		);
	});

	it('accepts only effective MCP and Tool Portal config inputs for managed admission', () => {
		// Arrange / Act / Assert
		expectTypeOf<MaterializeGatewayRuntimePortalAdmissionProps>().toEqualTypeOf<ExpectedMaterializationProps>();
	});

	it.each([
		[
			'missing agent',
			(projections: readonly ManagedFrameworkAgentProjectionInput[]) => projections.slice(0, 1),
		],
		[
			'extra agent',
			(projections: readonly ManagedFrameworkAgentProjectionInput[]) => [
				...projections,
				{
					agentId: 'agent-c',
					frameworkIdentity: { agentId: 'agent-c', kind: 'openclaw' as const },
					toolPortalProfileId: 'code-builder',
				},
			],
		],
	] as const)('rejects a projection cohort with an %s', (_caseName, changeProjections) => {
		// Arrange
		const baselineProps = createMaterializationProps();
		const props = {
			...baselineProps,
			agentProjections: changeProjections(baselineProps.agentProjections),
		};

		// Act / Assert
		expect(() => materializeGatewayRuntimePortalAdmission(props)).toThrow(
			'Managed Agent Projection agent ids must exactly match configured Tool Portal agent ids.',
		);
	});

	it('keeps every semantic revision stable when record keys and set-like arrays are reordered', () => {
		// Arrange
		const baselineProps = createMaterializationProps();
		const baselineMcpConfig = baselineProps.effectivePlan.effectiveMcpConfig;
		const baselineToolPortalConfig = baselineProps.effectivePlan.effectiveToolPortalConfig;
		const filesystemProvider = requireMcpProvider(baselineMcpConfig, 'filesystem');
		const githubProvider = requireMcpProvider(baselineMcpConfig, 'github');
		const codeBuilderProfile = requireToolPortalProfile(baselineToolPortalConfig, 'code-builder');
		const codeReviewerProfile = requireToolPortalProfile(baselineToolPortalConfig, 'code-reviewer');
		const codeBuilderFilesystemNamespace = requireToolPortalNamespace(
			codeBuilderProfile,
			'filesystem',
		);
		const codeBuilderGithubNamespace = requireToolPortalNamespace(codeBuilderProfile, 'github');
		const codeReviewerFilesystemNamespace = requireToolPortalNamespace(
			codeReviewerProfile,
			'filesystem',
		);
		const codeReviewerGithubNamespace = requireToolPortalNamespace(codeReviewerProfile, 'github');
		const reorderedProps: MaterializeGatewayRuntimePortalAdmissionProps = {
			...baselineProps,
			effectivePlan: {
				...baselineProps.effectivePlan,
				effectiveMcpConfig: mcpConfigSchema.parse({
					...baselineMcpConfig,
					providers: {
						filesystem: {
							...filesystemProvider,
							transport: {
								...filesystemProvider.transport,
								requiredEgressHosts: ['registry.example.com', 'packages.example.com'],
							},
						},
						github: {
							...githubProvider,
							transport: {
								...githubProvider.transport,
								requiredEgressHosts: ['uploads.github.com', 'api.github.com'],
							},
						},
					},
				}),
				effectiveToolPortalConfig: toolPortalConfigSchema.parse({
					...baselineToolPortalConfig,
					profiles: {
						'code-reviewer': {
							namespaces: {
								filesystem: {
									...codeReviewerFilesystemNamespace,
									calls: {
										requiresApproval: {
											allow: ['files.write', 'files.delete'],
											deny: [],
										},
										withoutApproval: {
											allow: ['files.stat', 'files.read'],
											deny: [],
										},
									},
									tools: {
										allow: ['files.stat', 'files.read'],
										deny: ['files.write', 'files.delete'],
									},
								},
								github: codeReviewerGithubNamespace,
							},
						},
						'code-builder': {
							namespaces: {
								filesystem: codeBuilderFilesystemNamespace,
								github: {
									...codeBuilderGithubNamespace,
									calls: {
										requiresApproval: {
											allow: ['issues.update', 'issues.delete'],
											deny: [],
										},
										withoutApproval: {
											allow: ['issues.list', 'issues.get'],
											deny: [],
										},
									},
									tools: {
										allow: ['issues.list', 'issues.get'],
										deny: ['issues.delete', 'issues.archive'],
									},
								},
							},
						},
					},
				}),
			},
			surfaceEligibilityByProfile: {
				'code-reviewer': {
					github: ['protected_uds', 'mcp'],
					filesystem: ['protected_uds', 'mcp'],
				},
				'code-builder': {
					github: ['protected_uds', 'mcp'],
					filesystem: ['protected_uds', 'mcp'],
				},
			},
		};

		// Act
		const baselineSnapshot =
			materializeGatewayRuntimePortalAdmission(baselineProps).semanticSnapshot;
		const reorderedSnapshot =
			materializeGatewayRuntimePortalAdmission(reorderedProps).semanticSnapshot;

		// Assert
		expect(reorderedSnapshot.activeRevision).toBe(baselineSnapshot.activeRevision);
		expect(reorderedSnapshot.bindingRevision).toBe(baselineSnapshot.bindingRevision);
		expect(reorderedSnapshot.catalogRevision).toBe(baselineSnapshot.catalogRevision);
		expect(reorderedSnapshot.desiredRevision).toBe(baselineSnapshot.desiredRevision);
		expect(reorderedSnapshot.profilePolicyRevision).toBe(baselineSnapshot.profilePolicyRevision);
		expect(reorderedSnapshot.providerRevision).toBe(baselineSnapshot.providerRevision);
		expect(reorderedSnapshot.schemaRevision).toBe(baselineSnapshot.schemaRevision);
		expect(reorderedSnapshot.agentProjections).toEqual(baselineSnapshot.agentProjections);
	});

	it('treats stdio argv order as provider and catalog semantics', () => {
		// Arrange
		const baselineProps = createMaterializationProps();
		const filesystemProvider = requireMcpProvider(
			baselineProps.effectivePlan.effectiveMcpConfig,
			'filesystem',
		);
		if (filesystemProvider.transport.kind !== 'stdio') {
			throw new Error('Expected filesystem test provider to use stdio transport.');
		}
		const reorderedArgvProps: MaterializeGatewayRuntimePortalAdmissionProps = {
			...baselineProps,
			effectivePlan: {
				...baselineProps.effectivePlan,
				effectiveMcpConfig: mcpConfigSchema.parse({
					...baselineProps.effectivePlan.effectiveMcpConfig,
					providers: {
						...baselineProps.effectivePlan.effectiveMcpConfig.providers,
						filesystem: {
							...filesystemProvider,
							transport: {
								...filesystemProvider.transport,
								args: ['/work', '--root'],
							},
						},
					},
				}),
			},
		};

		// Act
		const baselineSnapshot =
			materializeGatewayRuntimePortalAdmission(baselineProps).semanticSnapshot;
		const reorderedArgvSnapshot =
			materializeGatewayRuntimePortalAdmission(reorderedArgvProps).semanticSnapshot;

		// Assert
		expect(reorderedArgvSnapshot.providerRevision).not.toBe(baselineSnapshot.providerRevision);
		expect(reorderedArgvSnapshot.catalogRevision).not.toBe(baselineSnapshot.catalogRevision);
		expect(reorderedArgvSnapshot.desiredRevision).not.toBe(baselineSnapshot.desiredRevision);
		expect(reorderedArgvSnapshot.activeRevision).toBe(reorderedArgvSnapshot.desiredRevision);
		expect(reorderedArgvSnapshot.profilePolicyRevision).toBe(
			baselineSnapshot.profilePolicyRevision,
		);
		expect(reorderedArgvSnapshot.bindingRevision).toBe(baselineSnapshot.bindingRevision);
		expect(reorderedArgvSnapshot.schemaRevision).toBe(baselineSnapshot.schemaRevision);
		expect(reorderedArgvSnapshot.agentProjections).toEqual(baselineSnapshot.agentProjections);
	});

	it('partitions backend kind changes into binding and desired revisions only', () => {
		// Arrange
		const baselineProps = createMaterializationProps();
		const codeBuilderProfile = requireToolPortalProfile(
			baselineProps.effectivePlan.effectiveToolPortalConfig,
			'code-builder',
		);
		const githubNamespace = requireToolPortalNamespace(codeBuilderProfile, 'github');
		const changedBackendProps: MaterializeGatewayRuntimePortalAdmissionProps = {
			...baselineProps,
			effectivePlan: {
				...baselineProps.effectivePlan,
				effectiveToolPortalConfig: toolPortalConfigSchema.parse({
					...baselineProps.effectivePlan.effectiveToolPortalConfig,
					profiles: {
						...baselineProps.effectivePlan.effectiveToolPortalConfig.profiles,
						'code-builder': {
							...codeBuilderProfile,
							namespaces: {
								...codeBuilderProfile.namespaces,
								github: {
									...githubNamespace,
									backend: {
										kind: 'controller_execution',
										operations: {
											'issues.archive': { kind: 'registered_action' },
											'issues.delete': { kind: 'registered_action' },
											'issues.get': { kind: 'registered_action' },
											'issues.list': { kind: 'registered_action' },
											'issues.update': { kind: 'registered_action' },
										},
									},
								},
							},
						},
					},
				}),
			},
		};

		// Act
		const baselineSnapshot =
			materializeGatewayRuntimePortalAdmission(baselineProps).semanticSnapshot;
		const changedBackendSnapshot =
			materializeGatewayRuntimePortalAdmission(changedBackendProps).semanticSnapshot;

		// Assert
		expect(changedBackendSnapshot.bindingRevision).not.toBe(baselineSnapshot.bindingRevision);
		expect(changedBackendSnapshot.desiredRevision).not.toBe(baselineSnapshot.desiredRevision);
		expect(changedBackendSnapshot.activeRevision).toBe(changedBackendSnapshot.desiredRevision);
		expect(changedBackendSnapshot.providerRevision).toBe(baselineSnapshot.providerRevision);
		expect(changedBackendSnapshot.catalogRevision).toBe(baselineSnapshot.catalogRevision);
		expect(changedBackendSnapshot.profilePolicyRevision).toBe(
			baselineSnapshot.profilePolicyRevision,
		);
		expect(changedBackendSnapshot.schemaRevision).toBe(baselineSnapshot.schemaRevision);
		expect(changedBackendSnapshot.agentProjections).toEqual(baselineSnapshot.agentProjections);
	});

	it('partitions sandbox runner presentation, operation, and command authority revisions', () => {
		// Arrange
		const baselineProps = withCodeBuilderGithubRunner(
			createMaterializationProps(),
			sandboxRunnerOperations,
		);
		const changedDescriptionProps = withCodeBuilderGithubRunner(createMaterializationProps(), {
			...sandboxRunnerOperations,
			'issues.get': {
				...sandboxRunnerOperations['issues.get'],
				description: 'Read one configured issue with bounded output.',
			},
		});
		const changedOperationProps = withCodeBuilderGithubRunner(createMaterializationProps(), {
			...sandboxRunnerOperations,
			'issues.get': {
				description: sandboxRunnerOperations['issues.get'].description,
				kind: 'filesystem.write',
			},
		});
		const changedCommandPrefixProps = withCodeBuilderGithubRunner(createMaterializationProps(), {
			...sandboxRunnerOperations,
			'issues.update': {
				...sandboxRunnerOperations['issues.update'],
				mandatoryArgvPrefix: ['issue', 'update'],
			},
		});
		const reorderedProps = withCodeBuilderGithubRunner(createMaterializationProps(), {
			'issues.update': sandboxRunnerOperations['issues.update'],
			'issues.list': sandboxRunnerOperations['issues.list'],
			'issues.get': sandboxRunnerOperations['issues.get'],
			'issues.delete': sandboxRunnerOperations['issues.delete'],
			'issues.archive': sandboxRunnerOperations['issues.archive'],
		});

		// Act
		const baseline = materializeGatewayRuntimePortalAdmission(baselineProps).semanticSnapshot;
		const changedDescription =
			materializeGatewayRuntimePortalAdmission(changedDescriptionProps).semanticSnapshot;
		const changedOperation =
			materializeGatewayRuntimePortalAdmission(changedOperationProps).semanticSnapshot;
		const changedCommandPrefix =
			materializeGatewayRuntimePortalAdmission(changedCommandPrefixProps).semanticSnapshot;
		const reordered = materializeGatewayRuntimePortalAdmission(reorderedProps).semanticSnapshot;

		// Assert
		expect(changedDescription.catalogRevision).not.toBe(baseline.catalogRevision);
		expect(changedDescription.bindingRevision).toBe(baseline.bindingRevision);
		expect(changedDescription.desiredRevision).not.toBe(baseline.desiredRevision);

		expect(changedOperation.catalogRevision).not.toBe(baseline.catalogRevision);
		expect(changedOperation.bindingRevision).not.toBe(baseline.bindingRevision);
		expect(changedOperation.desiredRevision).not.toBe(baseline.desiredRevision);

		expect(changedCommandPrefix.catalogRevision).toBe(baseline.catalogRevision);
		expect(changedCommandPrefix.bindingRevision).not.toBe(baseline.bindingRevision);
		expect(changedCommandPrefix.desiredRevision).not.toBe(baseline.desiredRevision);

		expect(reordered.catalogRevision).toBe(baseline.catalogRevision);
		expect(reordered.bindingRevision).toBe(baseline.bindingRevision);
		expect(reordered.desiredRevision).toBe(baseline.desiredRevision);
	});

	it('partitions call policy changes into profile-policy and desired revisions only', () => {
		// Arrange
		const baselineProps = createMaterializationProps();
		const codeBuilderProfile = requireToolPortalProfile(
			baselineProps.effectivePlan.effectiveToolPortalConfig,
			'code-builder',
		);
		const githubNamespace = requireToolPortalNamespace(codeBuilderProfile, 'github');
		const changedCallPolicyProps: MaterializeGatewayRuntimePortalAdmissionProps = {
			...baselineProps,
			effectivePlan: {
				...baselineProps.effectivePlan,
				effectiveToolPortalConfig: toolPortalConfigSchema.parse({
					...baselineProps.effectivePlan.effectiveToolPortalConfig,
					profiles: {
						...baselineProps.effectivePlan.effectiveToolPortalConfig.profiles,
						'code-builder': {
							...codeBuilderProfile,
							namespaces: {
								...codeBuilderProfile.namespaces,
								github: {
									...githubNamespace,
									calls: {
										...githubNamespace.calls,
										requiresApproval: {
											allow: ['issues.update'],
											deny: [],
										},
									},
								},
							},
						},
					},
				}),
			},
		};

		// Act
		const baselineSnapshot =
			materializeGatewayRuntimePortalAdmission(baselineProps).semanticSnapshot;
		const changedCallPolicySnapshot =
			materializeGatewayRuntimePortalAdmission(changedCallPolicyProps).semanticSnapshot;

		// Assert
		expect(changedCallPolicySnapshot.profilePolicyRevision).not.toBe(
			baselineSnapshot.profilePolicyRevision,
		);
		expect(changedCallPolicySnapshot.desiredRevision).not.toBe(baselineSnapshot.desiredRevision);
		expect(changedCallPolicySnapshot.activeRevision).toBe(
			changedCallPolicySnapshot.desiredRevision,
		);
		expect(changedCallPolicySnapshot.providerRevision).toBe(baselineSnapshot.providerRevision);
		expect(changedCallPolicySnapshot.catalogRevision).toBe(baselineSnapshot.catalogRevision);
		expect(changedCallPolicySnapshot.bindingRevision).toBe(baselineSnapshot.bindingRevision);
		expect(changedCallPolicySnapshot.schemaRevision).toBe(baselineSnapshot.schemaRevision);
		expect(changedCallPolicySnapshot.agentProjections).toEqual(baselineSnapshot.agentProjections);
	});

	it('partitions tool policy changes into catalog, profile-policy, and desired revisions', () => {
		// Arrange
		const baselineProps = createMaterializationProps();
		const codeBuilderProfile = requireToolPortalProfile(
			baselineProps.effectivePlan.effectiveToolPortalConfig,
			'code-builder',
		);
		const githubNamespace = requireToolPortalNamespace(codeBuilderProfile, 'github');
		const changedToolPolicyProps: MaterializeGatewayRuntimePortalAdmissionProps = {
			...baselineProps,
			effectivePlan: {
				...baselineProps.effectivePlan,
				effectiveToolPortalConfig: toolPortalConfigSchema.parse({
					...baselineProps.effectivePlan.effectiveToolPortalConfig,
					profiles: {
						...baselineProps.effectivePlan.effectiveToolPortalConfig.profiles,
						'code-builder': {
							...codeBuilderProfile,
							namespaces: {
								...codeBuilderProfile.namespaces,
								github: {
									...githubNamespace,
									tools: {
										allow: ['issues.get'],
										deny: ['issues.archive', 'issues.delete'],
									},
								},
							},
						},
					},
				}),
			},
		};

		// Act
		const baselineSnapshot =
			materializeGatewayRuntimePortalAdmission(baselineProps).semanticSnapshot;
		const changedToolPolicySnapshot =
			materializeGatewayRuntimePortalAdmission(changedToolPolicyProps).semanticSnapshot;

		// Assert
		expect(changedToolPolicySnapshot.catalogRevision).not.toBe(baselineSnapshot.catalogRevision);
		expect(changedToolPolicySnapshot.profilePolicyRevision).not.toBe(
			baselineSnapshot.profilePolicyRevision,
		);
		expect(changedToolPolicySnapshot.desiredRevision).not.toBe(baselineSnapshot.desiredRevision);
		expect(changedToolPolicySnapshot.activeRevision).toBe(
			changedToolPolicySnapshot.desiredRevision,
		);
		expect(changedToolPolicySnapshot.providerRevision).toBe(baselineSnapshot.providerRevision);
		expect(changedToolPolicySnapshot.bindingRevision).toBe(baselineSnapshot.bindingRevision);
		expect(changedToolPolicySnapshot.schemaRevision).toBe(baselineSnapshot.schemaRevision);
		expect(changedToolPolicySnapshot.agentProjections).toEqual(baselineSnapshot.agentProjections);
	});

	it('partitions surface eligibility changes into profile-policy and desired revisions only', () => {
		// Arrange
		const baselineProps = createMaterializationProps();
		const changedSurfaceProps: MaterializeGatewayRuntimePortalAdmissionProps = {
			...baselineProps,
			surfaceEligibilityByProfile: {
				...baselineProps.surfaceEligibilityByProfile,
				'code-builder': {
					...baselineProps.surfaceEligibilityByProfile['code-builder'],
					github: ['protected_uds'],
				},
			},
		};

		// Act
		const baselineSnapshot =
			materializeGatewayRuntimePortalAdmission(baselineProps).semanticSnapshot;
		const changedSurfaceSnapshot =
			materializeGatewayRuntimePortalAdmission(changedSurfaceProps).semanticSnapshot;

		// Assert
		expect(changedSurfaceSnapshot.profilePolicyRevision).not.toBe(
			baselineSnapshot.profilePolicyRevision,
		);
		expect(changedSurfaceSnapshot.desiredRevision).not.toBe(baselineSnapshot.desiredRevision);
		expect(changedSurfaceSnapshot.activeRevision).toBe(changedSurfaceSnapshot.desiredRevision);
		expect(changedSurfaceSnapshot.providerRevision).toBe(baselineSnapshot.providerRevision);
		expect(changedSurfaceSnapshot.catalogRevision).toBe(baselineSnapshot.catalogRevision);
		expect(changedSurfaceSnapshot.bindingRevision).toBe(baselineSnapshot.bindingRevision);
		expect(changedSurfaceSnapshot.schemaRevision).toBe(baselineSnapshot.schemaRevision);
		expect(changedSurfaceSnapshot.agentProjections).toEqual(baselineSnapshot.agentProjections);
	});

	it('partitions an agent profile assignment into that assignment and desired revisions only', () => {
		// Arrange
		const baselineProps = createMaterializationProps();
		const changedProfileProps: MaterializeGatewayRuntimePortalAdmissionProps = {
			...baselineProps,
			agentProjections: baselineProps.agentProjections.map((projection) =>
				projection.agentId === 'agent-a'
					? { ...projection, toolPortalProfileId: 'code-reviewer' }
					: projection,
			),
			effectivePlan: {
				...baselineProps.effectivePlan,
				effectiveToolPortalConfig: toolPortalConfigSchema.parse({
					...baselineProps.effectivePlan.effectiveToolPortalConfig,
					agents: {
						...baselineProps.effectivePlan.effectiveToolPortalConfig.agents,
						'agent-a': { profile: 'code-reviewer' },
					},
				}),
			},
		};

		// Act
		const baselineSnapshot =
			materializeGatewayRuntimePortalAdmission(baselineProps).semanticSnapshot;
		const changedProfileSnapshot =
			materializeGatewayRuntimePortalAdmission(changedProfileProps).semanticSnapshot;
		const baselineAgentProjection = requireAgentProjection(baselineSnapshot, 'agent-a');
		const changedAgentProjection = requireAgentProjection(changedProfileSnapshot, 'agent-a');

		// Assert
		expect(changedAgentProjection.toolPortalProfileId).toBe('code-reviewer');
		expect(changedAgentProjection.profileAssignmentRevision).not.toBe(
			baselineAgentProjection.profileAssignmentRevision,
		);
		expect(changedProfileSnapshot.desiredRevision).not.toBe(baselineSnapshot.desiredRevision);
		expect(changedProfileSnapshot.activeRevision).toBe(changedProfileSnapshot.desiredRevision);
		expect(changedProfileSnapshot.providerRevision).toBe(baselineSnapshot.providerRevision);
		expect(changedProfileSnapshot.catalogRevision).toBe(baselineSnapshot.catalogRevision);
		expect(changedProfileSnapshot.profilePolicyRevision).toBe(
			baselineSnapshot.profilePolicyRevision,
		);
		expect(changedProfileSnapshot.bindingRevision).toBe(baselineSnapshot.bindingRevision);
		expect(changedProfileSnapshot.schemaRevision).toBe(baselineSnapshot.schemaRevision);
	});

	it('partitions a framework assignment into assignment and desired revisions only', () => {
		// Arrange
		const baselineProps = createMaterializationProps();
		const changedFrameworkProps: MaterializeGatewayRuntimePortalAdmissionProps = {
			...baselineProps,
			agentProjections: baselineProps.agentProjections.map((projection) => ({
				...projection,
				frameworkIdentity: {
					kind: 'hermes',
					profileName: `${projection.agentId}-profile`,
				},
			})),
		};

		// Act
		const baselineSnapshot =
			materializeGatewayRuntimePortalAdmission(baselineProps).semanticSnapshot;
		const changedFrameworkSnapshot =
			materializeGatewayRuntimePortalAdmission(changedFrameworkProps).semanticSnapshot;
		const baselineAgentProjection = requireAgentProjection(baselineSnapshot, 'agent-a');
		const changedAgentProjection = requireAgentProjection(changedFrameworkSnapshot, 'agent-a');

		// Assert
		expect(changedAgentProjection.frameworkIdentity.kind).toBe('hermes');
		expect(changedAgentProjection.profileAssignmentRevision).not.toBe(
			baselineAgentProjection.profileAssignmentRevision,
		);
		expect(changedFrameworkSnapshot.desiredRevision).not.toBe(baselineSnapshot.desiredRevision);
		expect(changedFrameworkSnapshot.activeRevision).toBe(changedFrameworkSnapshot.desiredRevision);
		expect(changedFrameworkSnapshot.providerRevision).toBe(baselineSnapshot.providerRevision);
		expect(changedFrameworkSnapshot.catalogRevision).toBe(baselineSnapshot.catalogRevision);
		expect(changedFrameworkSnapshot.profilePolicyRevision).toBe(
			baselineSnapshot.profilePolicyRevision,
		);
		expect(changedFrameworkSnapshot.bindingRevision).toBe(baselineSnapshot.bindingRevision);
		expect(changedFrameworkSnapshot.schemaRevision).toBe(baselineSnapshot.schemaRevision);
	});
});
