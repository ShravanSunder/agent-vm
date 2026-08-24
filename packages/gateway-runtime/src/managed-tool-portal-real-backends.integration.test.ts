import { Buffer } from 'node:buffer';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	PortalArtifactReadRequestSchema,
	type PortalCallRequest,
	type PortalCallResult,
	type PortalDescribeResult,
	type PortalListResult,
	type PortalSearchResult,
} from '@agent-vm/agent-portal-sdk';
import type {
	GatewayRuntimeManagedToolPortalConfig,
	ToolPortalBackendKind,
} from '@agent-vm/config-contracts';
import {
	GatewayRuntimeApprovalAdmissionResultSchema,
	GatewayRuntimeApprovalArmDispatchResultSchema,
	GatewayRuntimeApprovalDispatchGrantSchema,
	GatewayRuntimeApprovalDispatchReservationSchema,
	deriveGatewayControlStablePrincipal,
	deriveGatewayRuntimeApprovalFingerprint,
	deriveGatewayRuntimeApprovalId,
	type GatewayRuntimeApprovalChallengeIntent,
	type GatewayRuntimeGatewayDispatchReservation,
	type GatewayRuntimePortalSemanticSnapshot,
	type GatewayRuntimeToolPortalDispatchAuthority,
} from '@agent-vm/gateway-control-contracts';
import type {
	ToolPortalApprovalPort,
	ToolPortalBackendCallOptions,
	ToolPortalBackendPort,
	ToolPortalInvocationOptions,
	ToolPortalCapabilityCore,
} from '@agent-vm/tool-portal';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { GatewayRuntimeArtifactCurrentAuthorityRegistry } from './artifacts/artifact-read-authority.js';
import {
	gatewayRuntimeArtifactStablePrincipalFromTrustedContext,
	type GatewayRuntimeArtifactAuthorization,
	type GatewayRuntimeArtifactStore,
} from './artifacts/artifact-store.js';
import { createGatewayRuntimeManagedToolPortalComposition } from './managed-tool-portal-composition.js';
import type {
	GatewayRuntimeArtifactProjectionOperations,
	GatewayRuntimePrivateUdsProjectionFactoryProps,
} from './tool-portal-projections.js';

const authorityContext = {
	controllerEpoch: 'controller-epoch-gate-c',
	frameworkEpoch: 'framework-epoch-gate-c',
	gatewayEpoch: 'gateway-epoch-gate-c',
	runtimeEpoch: 'runtime-epoch-gate-c',
	zoneId: 'zone-gate-c',
} as const;

const toolPortalConfig = {
	agents: { 'agent-gate-c': { profile: 'gate-c-profile' } },
	mode: 'managed',
	profiles: {
		'gate-c-profile': {
			namespaces: {
				controller: {
					discovery: {},
					backend: {
						kind: 'controller_execution',
						operations: {
							controller_host_probe: { kind: 'registered_action' },
							workspace_git_push: { kind: 'registered_action' },
							push_branch: { kind: 'registered_action' },
							protected_uds: { kind: 'registered_action' },
						},
					},
					calls: {
						requiresApproval: { allow: ['push_branch'], deny: [] },
						withoutApproval: { allow: [], deny: [] },
					},
					tools: { allow: ['push_branch'], deny: [] },
				},
				github: {
					discovery: {},
					backend: { kind: 'mcp_provider' },
					calls: {
						requiresApproval: { allow: [], deny: [] },
						withoutApproval: { allow: ['get_issue'], deny: [] },
					},
					tools: { allow: ['get_issue'], deny: [] },
				},
				sandbox: {
					discovery: {},
					backend: {
						kind: 'tool_vm_runner',
						operations: {
							exec: {
								description: 'Run the fixture command.',
								executable: '/usr/bin/true',
								kind: 'command.fixed',
								mandatoryArgvPrefix: [],
								workingDirectory: '.',
							},
						},
						profile: 'sandbox_ssh',
					},
					calls: {
						requiresApproval: { allow: ['exec'], deny: [] },
						withoutApproval: { allow: [], deny: [] },
					},
					tools: { allow: ['exec'], deny: [] },
				},
			},
		},
	},
	schemaVersion: 1,
} satisfies GatewayRuntimeManagedToolPortalConfig;

const semanticSnapshot = {
	activeRevision: 'semantic-gate-c-1',
	agentProjections: {
		'agent-gate-c': {
			agentId: 'agent-gate-c',
			frameworkIdentity: { agentId: 'agent-gate-c', kind: 'openclaw' },
			profileAssignmentRevision: 'profile-assignment-gate-c-1',
			toolPortalNamespaces: [
				{ namespace: 'controller' },
				{ namespace: 'github' },
				{ namespace: 'sandbox' },
			],
			toolPortalProfileId: 'gate-c-profile',
		},
	},
	bindingRevision: 'binding-gate-c-1',
	catalogRevision: 'catalog-gate-c-1',
	desiredRevision: 'semantic-gate-c-1',
	profilePolicyRevision: 'policy-gate-c-1',
	projectionCohortDigest:
		'projection-cohort:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
	providerRevision: 'provider-gate-c-1',
	schemaRevision: 'schema-gate-c-1',
	schemaVersion: 1,
	surfaceEligibilityByProfile: {
		'gate-c-profile': {
			controller: ['protected_uds'],
			github: ['protected_uds'],
			sandbox: ['protected_uds'],
		},
	},
} satisfies GatewayRuntimePortalSemanticSnapshot;

const trustedContext = {
	correlation: {
		runId: 'run-gate-c',
		sessionId: 'session-gate-c',
		toolCallId: 'tool-call-gate-c',
	},
	principal: {
		agentId: 'agent-gate-c',
		frameworkIdentity: { agentId: 'agent-gate-c', kind: 'openclaw' },
		profileAssignmentRevision: 'profile-assignment-gate-c-1',
		toolPortalProfileId: 'gate-c-profile',
	},
	requester: { authenticatedSubjectId: 'subject-gate-c' },
} as const;

interface ExpectedBackendPortFactoryRuntime {
	readonly artifactStore: GatewayRuntimeArtifactStore;
	readonly registerArtifactAuthority: GatewayRuntimeArtifactCurrentAuthorityRegistry['register'];
}

interface ExpectedBackendPortFactories {
	readonly controllerExecution: (
		runtime: ExpectedBackendPortFactoryRuntime,
	) => ToolPortalBackendPort<'controller_execution'>;
	readonly mcpProvider: (
		runtime: ExpectedBackendPortFactoryRuntime,
	) => ToolPortalBackendPort<'mcp_provider'>;
	readonly toolVmRunner: (
		runtime: ExpectedBackendPortFactoryRuntime,
	) => ToolPortalBackendPort<'tool_vm_runner'>;
}

interface CapturedPrivateUdsProjection {
	readonly artifactOperations: GatewayRuntimeArtifactProjectionOperations;
	readonly capabilityCore: ToolPortalCapabilityCore<'managed'>;
}

interface RecordedBackendCall {
	readonly backendKind: ToolPortalBackendKind;
	readonly dispatchAuthority: GatewayRuntimeToolPortalDispatchAuthority;
	readonly surfaceClass: ToolPortalInvocationOptions['surfaceClass'];
}

function createPrivateUdsProjection(
	props: GatewayRuntimePrivateUdsProjectionFactoryProps,
): CapturedPrivateUdsProjection {
	return { artifactOperations: props.artifactOperations, capabilityCore: props.capabilityCore };
}

function operationIdFromDispatchAuthority(
	authority: GatewayRuntimeToolPortalDispatchAuthority,
): string {
	switch (authority.kind) {
		case 'without-approval':
			return authority.operationId;
		case 'approval-grant':
			return authority.grant.operationId;
		case 'controller-approval-reservation':
			return authority.reservation.operationId;
	}
	const unreachableAuthority: never = authority;
	throw new Error(`Unsupported dispatch authority: ${String(unreachableAuthority)}`);
}

function fingerprintFromDispatchAuthority(
	authority: GatewayRuntimeToolPortalDispatchAuthority,
): string {
	switch (authority.kind) {
		case 'without-approval':
			return authority.fingerprint;
		case 'approval-grant':
			return authority.grant.fingerprint;
		case 'controller-approval-reservation':
			return authority.reservation.fingerprint;
	}
	const unreachableAuthority: never = authority;
	throw new Error(`Unsupported dispatch authority: ${String(unreachableAuthority)}`);
}

function createApprovalPort(): {
	readonly armedReservations: GatewayRuntimeGatewayDispatchReservation[];
	readonly port: ToolPortalApprovalPort;
	readonly reservedIntents: GatewayRuntimeApprovalChallengeIntent[];
} {
	const armedReservations: GatewayRuntimeGatewayDispatchReservation[] = [];
	const reservedIntents: GatewayRuntimeApprovalChallengeIntent[] = [];
	const stablePrincipal = deriveGatewayControlStablePrincipal({
		principal: trustedContext.principal,
	});
	return {
		armedReservations,
		port: {
			armDispatch: async ({ reservation }) => {
				armedReservations.push(reservation);
				return GatewayRuntimeApprovalArmDispatchResultSchema.parse({
					grant: GatewayRuntimeApprovalDispatchGrantSchema.parse({
						approvalId: reservation.approvalId,
						authorityContext: reservation.authorityContext,
						backendKind: reservation.backendKind,
						expiresAt: reservation.expiresAt,
						fingerprint: reservation.fingerprint,
						grantId: '30000000-0000-4000-8000-000000000003',
						operationId: reservation.operationId,
						stablePrincipal: reservation.stablePrincipal,
					}),
					kind: 'dispatch-armed',
				});
			},
			reserveDispatch: async ({ intent }) => {
				reservedIntents.push(intent);
				const fingerprint = deriveGatewayRuntimeApprovalFingerprint({
					authorityContext,
					intent,
				});
				return GatewayRuntimeApprovalAdmissionResultSchema.parse({
					kind: 'dispatch-reserved',
					reservation: GatewayRuntimeApprovalDispatchReservationSchema.parse({
						approvalId: deriveGatewayRuntimeApprovalId(fingerprint),
						authorityContext,
						backendKind: intent.backendKind,
						...(intent.backendKind === 'controller_execution'
							? { bindingRevision: intent.semanticRevisions.bindingRevision }
							: {}),
						expiresAt: '2026-07-13T21:00:00.000Z',
						fingerprint,
						operationId: intent.operationId,
						reservationId: '20000000-0000-4000-8000-000000000002',
						stablePrincipal,
					}),
				});
			},
		},
		reservedIntents,
	};
}

function createCatalogNeutralBackendPort<TBackendKind extends ToolPortalBackendKind>(
	backendKind: TBackendKind,
	call: ToolPortalBackendPort<TBackendKind>['call'],
): ToolPortalBackendPort<TBackendKind> {
	const emptyDescribeResult = { items: [], ok: true } satisfies PortalDescribeResult;
	const emptyListResult = { items: [], ok: true } satisfies PortalListResult;
	const emptySearchResult = { items: [], ok: true } satisfies PortalSearchResult;
	return {
		backendKind,
		call,
		describe: async () => emptyDescribeResult,
		list: async () => emptyListResult,
		search: async () => emptySearchResult,
	};
}

function createArtifactProducingBackendPort<TBackendKind extends ToolPortalBackendKind>(props: {
	readonly backendKind: TBackendKind;
	readonly calls: RecordedBackendCall[];
	readonly runtime: ExpectedBackendPortFactoryRuntime;
}): ToolPortalBackendPort<TBackendKind> {
	return createCatalogNeutralBackendPort(
		props.backendKind,
		async (
			request: PortalCallRequest,
			options: ToolPortalBackendCallOptions<TBackendKind>,
		): Promise<PortalCallResult> => {
			const items = await Promise.all(
				request.calls.map(async (call) => {
					props.calls.push({
						backendKind: props.backendKind,
						dispatchAuthority: options.dispatchAuthority,
						surfaceClass: options.surfaceClass,
					});
					const operationId = operationIdFromDispatchAuthority(options.dispatchAuthority);
					const authorization = {
						...gatewayRuntimeArtifactStablePrincipalFromTrustedContext(options.trustedContext),
						capability: { name: call.name, namespace: call.namespace },
						executionFingerprint: fingerprintFromDispatchAuthority(options.dispatchAuthority),
						operationId,
						owningGeneration: semanticSnapshot.activeRevision,
						surfaceClass: options.surfaceClass,
					} satisfies GatewayRuntimeArtifactAuthorization;
					expect(props.runtime.registerArtifactAuthority(authorization)).toEqual({
						kind: 'registered',
					});
					const artifactBytes = Buffer.from(
						`${props.backendKind}:${options.surfaceClass}:${call.name}`,
						'utf8',
					);
					const writeHandle = await props.runtime.artifactStore.beginWrite({
						authorization,
						lifetimeMs: 60_000,
						maximumBytes: artifactBytes.byteLength,
						mediaType: 'text/plain',
					});
					await writeHandle.write(artifactBytes);
					const reference = await writeHandle.commit();
					return {
						artifacts: [reference],
						id: call.id,
						operationId,
						outcome: {
							certainty: 'proven' as const,
							completion: 'succeeded' as const,
							kind: 'completed' as const,
							retryClass: 'forbidden' as const,
						},
						owningGeneration: semanticSnapshot.activeRevision,
						status: 'ok' as const,
						value: { backendKind: props.backendKind },
					};
				}),
			);
			return { items, ok: true };
		},
	);
}

async function readProducedArtifact(props: {
	readonly composition: {
		readonly privateUdsProjection: CapturedPrivateUdsProjection;
	};
	readonly result: PortalCallResult;
}): Promise<string> {
	const item = props.result.items[0];
	if (item?.status !== 'ok' || item.artifacts?.[0] === undefined) {
		throw new Error('Expected a successful backend result with one artifact.');
	}
	const publicRequest = PortalArtifactReadRequestSchema.parse({
		maxBytes: item.artifacts[0].byteLength,
		offsetBytes: 0,
		reference: item.artifacts[0],
	});
	const readResult = await props.composition.privateUdsProjection.artifactOperations.read({
		publicRequest,
		trustedContext,
	});
	return Buffer.from(readResult.contentBase64, 'base64').toString('utf8');
}

async function productionTypescriptSources(directoryPath: string): Promise<readonly string[]> {
	const entries = await readdir(directoryPath, { withFileTypes: true });
	const nestedSources = await Promise.all(
		entries.map(async (entry): Promise<readonly string[]> => {
			const entryPath = path.join(directoryPath, entry.name);
			if (entry.isDirectory()) return await productionTypescriptSources(entryPath);
			if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.includes('.test.'))
				return [];
			return [entryPath];
		}),
	);
	return nestedSources.flat();
}

describe('Gateway runtime managed Tool Portal real backend composition', () => {
	it('constructs each production backend port once against one service and artifact authority', async () => {
		// Arrange
		const sandboxRoot = await mkdtemp(path.join(tmpdir(), 'agent-vm-gate-c-real-backends-'));
		const approval = createApprovalPort();
		const backendCalls: RecordedBackendCall[] = [];
		const factoryRuntimes: ExpectedBackendPortFactoryRuntime[] = [];
		const backendPortFactories = {
			controllerExecution: (runtime) => {
				factoryRuntimes.push(runtime);
				return createArtifactProducingBackendPort({
					backendKind: 'controller_execution',
					calls: backendCalls,
					runtime,
				});
			},
			mcpProvider: (runtime) => {
				factoryRuntimes.push(runtime);
				return createArtifactProducingBackendPort({
					backendKind: 'mcp_provider',
					calls: backendCalls,
					runtime,
				});
			},
			toolVmRunner: (runtime) => {
				factoryRuntimes.push(runtime);
				return createArtifactProducingBackendPort({
					backendKind: 'tool_vm_runner',
					calls: backendCalls,
					runtime,
				});
			},
		} satisfies ExpectedBackendPortFactories;

		try {
			// Act
			const composition =
				await createGatewayRuntimeManagedToolPortalComposition<CapturedPrivateUdsProjection>({
					approvalPort: approval.port,
					artifactRuntime: {
						artifactsDirectoryPath: path.join(sandboxRoot, 'artifacts'),
						epochId: semanticSnapshot.activeRevision,
						limits: {
							maximumArtifactBytes: 4_096,
							maximumArtifactCount: 16,
							maximumLifetimeMs: 60_000,
							maximumTotalBytes: 32_768,
						},
						now: () => Date.parse('2026-07-13T20:00:00.000Z'),
					},
					authenticatedPrivateUdsOperationGroups: ['portal', 'artifact.read'],
					backendPortFactories,
					createPrivateUdsProjection,
					managedPluginAttachment: {
						clientKind: 'openclaw-managed-plugin',
						configuredAgentIds: [trustedContext.principal.agentId],
						projectionCohortDigest: semanticSnapshot.projectionCohortDigest,
					},
					semanticSnapshot,
					toolPortalConfig,
				});
			const invocations = [
				{ backendKind: 'tool_vm_runner', name: 'exec', namespace: 'sandbox' },
				{
					backendKind: 'controller_execution',
					name: 'push_branch',
					namespace: 'controller',
				},
			] as const;
			const results = await Promise.all(
				invocations.map(async (invocation) => ({
					invocation,
					result: await composition.privateUdsProjection.capabilityCore.call(
						{
							calls: [
								{
									arguments: { proof: 'gate-c' },
									id: `protected-uds-${invocation.backendKind}`,
									name: invocation.name,
									namespace: invocation.namespace,
								},
							],
						},
						{
							origin: { kind: 'managed', trustedContext },
							surfaceClass: 'protected_uds',
						},
					),
					surfaceClass: 'protected_uds' as const,
				})),
			);

			// Assert
			expect(composition.privateUdsProjection.capabilityCore).toBe(composition.capabilityCore);
			expect(factoryRuntimes).toHaveLength(3);
			expect(new Set(factoryRuntimes.map((runtime) => runtime.artifactStore)).size).toBe(1);
			expect(factoryRuntimes[0]?.artifactStore).toBe(composition.artifactStore);
			expect(backendCalls).toHaveLength(2);
			expect(approval.reservedIntents).toHaveLength(2);
			expect(approval.armedReservations).toHaveLength(1);
			expect(approval.armedReservations.map((reservation) => reservation.backendKind)).toEqual([
				'tool_vm_runner',
			]);
			const artifactReadbacks = await Promise.all(
				results.map(async (result) => ({
					backendKind: result.invocation.backendKind,
					content: await readProducedArtifact({
						composition,
						result: result.result,
					}),
					surfaceClass: result.surfaceClass,
				})),
			);

			for (const invocation of invocations) {
				const matchedResults = results.filter(
					(result) => result.invocation.backendKind === invocation.backendKind,
				);
				expect(matchedResults).toHaveLength(1);
				for (const matchedResult of matchedResults) {
					expect(matchedResult.result).toMatchObject({
						items: [
							{
								outcome: {
									certainty: 'proven',
									completion: 'succeeded',
									kind: 'completed',
									retryClass: 'forbidden',
								},
								status: 'ok',
								value: { backendKind: invocation.backendKind },
							},
						],
						ok: true,
					});
					const artifactReadback = artifactReadbacks.find(
						(readback) =>
							readback.backendKind === invocation.backendKind &&
							readback.surfaceClass === matchedResult.surfaceClass,
					);
					expect(artifactReadback?.content).toBe(
						`${invocation.backendKind}:${matchedResult.surfaceClass}:${invocation.name}`,
					);
				}
			}
			for (const backendCall of backendCalls) {
				const result = results.find(
					(candidate) =>
						candidate.surfaceClass === backendCall.surfaceClass &&
						candidate.invocation.backendKind === backendCall.backendKind,
				);
				const resultItem = result?.result.items[0];
				expect(resultItem?.status).toBe('ok');
				if (resultItem?.status === 'ok') {
					expect(resultItem.operationId).toBe(
						operationIdFromDispatchAuthority(backendCall.dispatchAuthority),
					);
				}
				expect(backendCall.dispatchAuthority.kind).toBe(
					backendCall.backendKind === 'controller_execution'
						? 'controller-approval-reservation'
						: 'approval-grant',
				);
			}
		} finally {
			await rm(sandboxRoot, { force: true, recursive: true });
		}
	});

	it('keeps Gateway runtime production sources independent from plugin and VM provider packages', async () => {
		// Arrange
		const sourceDirectoryPath = fileURLToPath(new URL('.', import.meta.url));
		const packageJsonPath = fileURLToPath(new URL('../package.json', import.meta.url));
		const packageJsonSchema = z
			.object({ dependencies: z.record(z.string(), z.string()).default({}) })
			.passthrough();

		// Act
		const sourcePaths = await productionTypescriptSources(sourceDirectoryPath);
		const sourceContents = await Promise.all(
			sourcePaths.map(async (sourcePath) => await readFile(sourcePath, 'utf8')),
		);
		const unparsedPackageJson: unknown = JSON.parse(await readFile(packageJsonPath, 'utf8'));
		const packageJson = packageJsonSchema.parse(unparsedPackageJson);

		// Assert
		expect(sourcePaths.length).toBeGreaterThan(0);
		for (const forbiddenDependency of [
			'@agent-vm/gondolin-vm-adapter',
			'@agent-vm/managed-vm',
			'@agent-vm/openclaw-agent-vm-plugin',
		]) {
			expect(packageJson.dependencies).not.toHaveProperty(forbiddenDependency);
			expect(sourceContents.some((source) => source.includes(`from '${forbiddenDependency}`))).toBe(
				false,
			);
			expect(sourceContents.some((source) => source.includes(`from "${forbiddenDependency}`))).toBe(
				false,
			);
		}
	});
});
