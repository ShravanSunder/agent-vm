import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { JsonValue, PortalCallRequest, PortalCallResult } from '@agent-vm/agent-portal-sdk';
import {
	compileOAuthPolicy,
	configuredGoogleOperationKey,
	controllerConfiguredCliInputSchema,
	createGatewayRuntimeManagedToolPortalConfig,
	jsonValueSchema,
	oauthConfigSchema,
} from '@agent-vm/config-contracts';
import {
	deriveGatewayControlControllerExecutionRpcWindow,
	deriveGatewayControlStablePrincipal,
	GatewayRuntimeApprovalFingerprintSchema,
	GatewayControlConfiguredCliControllerExecutionResultSchema,
	type GatewayControlToolPortalControllerExecutionPayload,
} from '@agent-vm/gateway-control-contracts';
import type {
	ManagedVm,
	ManagedVmCreateRequest,
	ManagedVmExecOptions,
	ManagedVmExecProcess,
	ManagedVmExecResult,
} from '@agent-vm/managed-vm';
import { createOwnedHostDirectoryController } from '@agent-vm/managed-vm';
import {
	oauthApplicationIdSchema,
	oauthPermissionSelectionsSchema,
} from '@agent-vm/oauth-broker-contracts';
import {
	createGoogleOAuthAdapter,
	createGoogleOAuthBrokerService,
	getGooglePolicyCatalog,
} from '@agent-vm/oauth-broker/google';
import {
	createManagedToolPortalCapabilityCore,
	type ToolPortalBackendPort,
} from '@agent-vm/tool-portal';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createOAuthPolicyCompilerTestInput } from '../../../../config-contracts/src/oauth-policy-compiler-test-fixture.js';
import {
	createBrokerFacadeFixture,
	prepareBrokerConsent,
} from '../../../../oauth-broker/src/google/google-broker-facade-test-fixture.js';
import {
	clientCredentials,
	wrappingKey,
} from '../../../../oauth-broker/src/oauth-catalog-test-fixture.js';
import {
	createRecordingBackendPort,
	udsOptions,
} from '../../../../tool-portal/src/tool-portal-service-test-fixture.js';
import type { LoadedSystemConfig } from '../../config/system-config.js';
import { writeGatewayRuntimePortalAdmissionFile } from '../../gateway/gateway-runtime-portal-admission-file.js';
import { materializeGatewayRuntimePortalAdmission } from '../../gateway/gateway-runtime-portal-admission-material.js';
import { writeMcpPortalEffectiveConfig } from '../../gateway/mcp-portal-effective-config.js';
import { authorizeGatewayControlControllerExecution } from '../control-session/gateway-control-controller-execution-authorization.js';
import { createCredentialedRuntimeManager } from '../credentialed-runtime/credentialed-runtime-manager.js';
import { createControllerCredentialedRuntimeRegistryPublisher } from '../credentialed-runtime/credentialed-runtime-registry.js';
import { createControllerSharedStaging } from '../files/controller-shared-staging.js';
import { withCurrentToolVmWorkFiles } from '../files/current-tool-vm-work-files.js';
import { createOperationFileRetentionBudget } from '../files/operation-file-retention-budget.js';
import { createConfiguredCliManagedVmExecutor } from '../runner/configured-cli-managed-vm-executor.js';
import { prepareGogRealFsLeaseFixture } from './gog-realfs-authority.integration-test-fixture.js';
import { createGooglePermissionPolicyService } from './google-permission-policy-service.js';

const zoneId = 'test-zone';
const agentId = 'sun';
const principal = {
	agentId,
	frameworkIdentity: { kind: 'hermes', profileName: agentId },
	profileAssignmentRevision: 'assignment-sun',
	toolPortalProfileId: 'shared',
} as const;

function successfulCallItem(props: {
	readonly call: PortalCallRequest['calls'][number];
	readonly owningGeneration: string;
	readonly operationId: string;
	readonly value: JsonValue;
}): PortalCallResult['items'][number] {
	return {
		id: props.call.id,
		operationId: props.operationId,
		outcome: {
			certainty: 'proven',
			completion: 'succeeded',
			kind: 'completed',
			retryClass: 'forbidden',
		},
		owningGeneration: props.owningGeneration,
		status: 'ok',
		value: props.value,
	};
}

describe('Gog account policy to RealFS file journey', () => {
	const cleanup: (() => Promise<void>)[] = [];
	afterEach(async () => {
		// oxlint-disable-next-line no-await-in-loop -- runtime containment must finish before its state root is removed
		for (const close of cleanup.splice(0).toReversed()) await close();
	});

	it('returns a usable published path and refuses stale publication independently of stdout hints', async () => {
		// Arrange: Google/VM implementations and private transport framing are substituted.
		const root = await mkdtemp(path.join(tmpdir(), 'gog-realfs-journey-'));
		const brokerFixture = await createBrokerFacadeFixture({ includeDocuments: true });
		cleanup.push(async () => {
			await brokerFixture.broker.close();
			brokerFixture.catalog.close();
			await rm(root, { force: true, recursive: true });
		});
		const consent = await prepareBrokerConsent(
			brokerFixture,
			{
				actionId: 'oauth_authorization.begin',
				applicationId: oauthApplicationIdSchema.parse('workspace-app'),
			},
			oauthPermissionSelectionsSchema.parse({ 'workspace-app': ['drive.all-files.read'] }),
		);
		const callback = await brokerFixture.exchangeRedirect(consent.redirect);
		if (callback.kind !== 'confirmation') throw new Error('Expected workspace confirmation.');
		const enrolled = await brokerFixture.confirm(callback.confirmation, 'Drive files');
		if (enrolled.kind !== 'completed') throw new Error('Expected workspace enrollment.');
		const runtimeBroker = createGoogleOAuthBrokerService({
			catalog: brokerFixture.catalog,
			config: brokerFixture.config,
			configRevision: 'config-1',
			isAdmissionOpen: () => true,
			now: () => 1_000,
			clientCredentialsByApplication: {
				'gmail-app': clientCredentials,
				'workspace-app': clientCredentials,
				'youtube-app': clientCredentials,
			},
			clientBindingRevisionsByApplication: {
				'gmail-app': 'client-binding-1',
				'workspace-app': 'client-binding-2',
				'youtube-app': 'client-binding-3',
			},
			allowedHostsByApplication: {
				'gmail-app': ['gmail.googleapis.com'],
				'workspace-app': [...getGooglePolicyCatalog().families.documents.allowedHosts],
				'youtube-app': ['youtube.googleapis.com'],
			},
			googleAdapter: createGoogleOAuthAdapter({
				now: () => 1_000,
				fetchImpl: async () => {
					throw new Error('The fresh synthetic token must not contact Google.');
				},
			}),
			keyEncryptionKey: wrappingKey,
			keyEncryptionKeyVersion: 1,
			offeredGroupIdsByAgentApplication: {
				[agentId]: { 'workspace-app': ['drive.all-files.read'] },
			},
			operationIdsByAgent: { [agentId]: ['drive.download'] },
			recommendationSelectionsByAgent: {
				[agentId]: oauthPermissionSelectionsSchema.parse({
					'workspace-app': ['drive.all-files.read'],
				}),
			},
			readAccountActivity: () => ({
				kind: 'ready',
				disposition: 'allow',
				overrideRevision: 1,
				defaultsRevision: 'defaults-1',
			}),
			containAuthorizationMaterial: async () => 'contained',
		});
		const compilerInput = createOAuthPolicyCompilerTestInput();
		const catalog = getGooglePolicyCatalog();
		const commands = [{ path: ['drive', 'download'], flagRules: [] }];
		compilerInput.toolPortalConfig.profiles.shared.namespaces.google.backend.operations.gog.commands =
			commands;
		compilerInput.toolPortalConfig.profiles.shared.namespaces.google.backend.operations.gog.executionTarget.allowedHosts =
			[...catalog.families.documents.allowedHosts];
		const compilerToolPortalConfig = {
			...compilerInput.toolPortalConfig,
			agents: {
				...compilerInput.toolPortalConfig.agents,
				[agentId]: {
					profile: 'shared',
					googlePolicyDefaults: {
						kind: 'explicit',
						applications: {
							'workspace-app': { drive: { read: 'allow', write: 'deny' } },
						},
					},
				},
				ember: {
					profile: 'shared',
					googlePolicyDefaults: {
						kind: 'explicit',
						applications: {
							'workspace-app': { drive: { read: 'allow', write: 'deny' } },
						},
					},
				},
			},
			profiles: {
				...compilerInput.toolPortalConfig.profiles,
				shared: {
					...compilerInput.toolPortalConfig.profiles.shared,
					namespaces: {
						...compilerInput.toolPortalConfig.profiles.shared.namespaces,
						google: {
							...compilerInput.toolPortalConfig.profiles.shared.namespaces.google,
							tools: { allow: ['gog'] },
						},
					},
				},
			},
		};
		const oauthConfig = oauthConfigSchema.parse({
			...compilerInput.oauthConfig,
			agents: {
				...compilerInput.oauthConfig.agents,
				[agentId]: {
					applications: {
						'workspace-app': {
							ceiling: { kind: 'explicit', groupIds: ['drive.all-files.read'] },
						},
					},
				},
				ember: {
					applications: {
						'workspace-app': {
							ceiling: { kind: 'explicit', groupIds: ['drive.all-files.read'] },
						},
					},
				},
			},
		});
		const compiled = compileOAuthPolicy({
			catalog,
			oauthConfig,
			toolPortalConfig: compilerToolPortalConfig,
		});
		brokerFixture.catalog.activatePolicyDefaults({
			zoneId,
			defaultsRevision: compiled.defaultsRevision,
			snapshot: compiled.defaultsSnapshot,
		});
		const policyService = createGooglePermissionPolicyService({
			catalog: brokerFixture.catalog,
			compiled,
			configRevision: 'config-realfs',
			clientBindingRevisionsByApplication: {
				'gmail-app': 'client-binding-1',
				'workspace-app': 'client-binding-2',
				'youtube-app': 'client-binding-3',
			},
			keyEncryptionKey: wrappingKey,
			keyEncryptionKeyVersion: 1,
			verifySession: async (identity) => ({ kind: 'verified', identity }),
			containPolicyMaterial: async () => 'contained',
			isAdmissionOpen: () => true,
		});
		const commandSet =
			compiled.commandSetsByConfiguredOperation[
				configuredGoogleOperationKey('shared', 'google', 'gog')
			];
		if (commandSet === undefined) throw new Error('Expected compiled Gog command set.');
		const retentionBudget = createOperationFileRetentionBudget();
		const sharedStaging = createControllerSharedStaging({
			controllerRuntimeDir: path.join(root, 'runtime'),
			controllerEpoch: 'controller-realfs',
			retentionBudget,
			now: () => 1_000,
		});
		const configDir = path.join(root, 'gateway-config');
		await mkdir(configDir, { recursive: true });
		await Promise.all([
			writeFile(
				path.join(configDir, 'mcp.config.jsonc'),
				`${JSON.stringify({ providers: {}, schemaVersion: 1 }, null, '\t')}\n`,
				'utf8',
			),
			writeFile(
				path.join(configDir, 'oauth.config.jsonc'),
				`${JSON.stringify(oauthConfig, null, '\t')}\n`,
				'utf8',
			),
			writeFile(
				path.join(configDir, 'tool-portal.config.jsonc'),
				`${JSON.stringify(compilerToolPortalConfig, null, '\t')}\n`,
				'utf8',
			),
		]);
		const effectiveHostConfigDir = path.join(
			root,
			'cache',
			'gateways',
			zoneId,
			'tool-portal-effective',
		);
		const effectivePlan = await writeMcpPortalEffectiveConfig({
			approvalAccessConfigured: true,
			authoredConfigDir: configDir,
			declaredAgentIds: [agentId, 'ember'],
			effectiveHostConfigDir,
			managedVmImages: {
				prepareImage: async () => ({
					built: false,
					fingerprint: 'sha256:gog-realfs-image',
					imageReference: '/images/gog-realfs',
				}),
			},
			secretResolver: {
				resolve: async () => {
					throw new Error('Gog RealFS authorization must not resolve static secrets.');
				},
				resolveAll: async () => ({}),
			},
			workspaceGitPushAgentEligibility: { eligibleAgentIds: [] },
			zoneId,
		});
		const portalConfig = createGatewayRuntimeManagedToolPortalConfig(
			effectivePlan.effectiveToolPortalConfig,
		);
		const portalAdmission = materializeGatewayRuntimePortalAdmission({
			agentProjections: [
				{
					agentId,
					frameworkIdentity: principal.frameworkIdentity,
					toolPortalProfileId: principal.toolPortalProfileId,
				},
				{
					agentId: 'ember',
					frameworkIdentity: { kind: 'hermes', profileName: 'ember' },
					toolPortalProfileId: 'shared',
				},
			],
			effectivePlan,
			surfaceEligibilityByProfile: { shared: { google: ['protected_uds'] } },
		});
		const runtimePrincipal = portalAdmission.semanticSnapshot.agentProjections[agentId];
		if (runtimePrincipal === undefined) throw new Error('Missing compiled Sun principal.');
		const invocationPrincipal = {
			agentId: runtimePrincipal.agentId,
			frameworkIdentity: runtimePrincipal.frameworkIdentity,
			profileAssignmentRevision: runtimePrincipal.profileAssignmentRevision,
			toolPortalProfileId: runtimePrincipal.toolPortalProfileId,
		};
		await writeGatewayRuntimePortalAdmissionFile({
			directoryPath: effectiveHostConfigDir,
			material: portalAdmission,
		});
		const systemConfig = {
			storageRootDir: root,
			cacheDir: path.join(root, 'cache'),
			controllerStateDir: path.join(root, 'controller-state'),
			controllerRuntimeDir: path.join(root, 'runtime'),
			controller: {
				health: {
					controlSessionDeathGraceMs: 600_000,
					enabled: true,
					eventHistoryLimit: 500,
					gatewayServiceAutoRestart: {
						channelProviderHealth: {
							consecutiveFailureThreshold: 3,
							enabled: true,
							restartGatewayOnRecoverable: true,
							restartGatewayOnUnrecoverable: false,
							transitioningTimeoutMs: 120_000,
						},
						cooldownMs: 3_660_000,
						consecutiveFailureThreshold: 10,
						enabled: true,
						failedRecoveryResetMs: 86_400_000,
						maxConsecutiveFailedRecoveries: 3,
						restartTimeoutMs: 600_000,
					},
					gatewayServiceIntervalMs: 10_000,
					staleAfterMs: 30_000,
				},
			},
			host: { controllerPort: 18_800, projectNamespace: 'gog-realfs-journey' },
			imageProfiles: {
				gateways: {
					hermes: {
						buildConfig: './vm-images/gateways/hermes/build-config.json',
						type: 'hermes',
					},
				},
				toolVms: {
					default: {
						buildConfig: './vm-images/tool-vms/default/build-config.json',
						type: 'toolVm',
					},
				},
			},
			schemaVersion: 2,
			systemConfigPath: path.join(root, 'config', 'system.jsonc'),
			tcpPool: { basePort: 19_000, size: 2 },
			toolVmProfiles: {},
			zones: [
				{
					agents: [{ id: agentId }, { id: 'ember' }],
					approvalAccess: {
						approvers: [{ approverId: 'gog-realfs', kind: 'managed_gateway' }],
						audience: 'agent-vm-controller-approval',
					},
					egressHosts: [],
					gateway: {
						config: path.join(root, 'config', 'hermes.yaml'),
						cpus: 2,
						imageProfile: 'hermes',
						memory: '2G',
						port: 18_791,
						profileSecretProjectionsByAgent: { [agentId]: {} },
						profilesByAgent: { [agentId]: agentId },
						stateDir: path.join(root, 'gateway-state'),
						type: 'hermes',
						zoneFilesDir: path.join(root, 'zone-files'),
						zoneRuntimeDir: path.join(root, 'gateway-runtime'),
					},
					id: zoneId,
					secrets: {},
					toolPortal: {
						configDir,
						surfaceEligibilityByProfile: {
							shared: { google: ['protected_uds'] },
						},
					},
				},
			],
		} satisfies LoadedSystemConfig;
		const credentialedRuntimeRegistryPublisher =
			createControllerCredentialedRuntimeRegistryPublisher();
		credentialedRuntimeRegistryPublisher.activate(
			effectivePlan.credentialedRuntimeRegistrySnapshot,
		);
		let commandCount = 0;
		let hostProcessId: number | null = null;
		const managedVmFactory = {
			createManagedVm: vi.fn(async (request: ManagedVmCreateRequest): Promise<ManagedVm> => {
				const producerMount = request.mounts?.['/agent-vm/gog-work'];
				if (producerMount?.kind !== 'owned-host-directory')
					throw new Error('Missing Gog RealFS mount.');
				const producerDirectory = producerMount.directory.consume();
				const exec = (
					_argv: readonly string[],
					options: ManagedVmExecOptions = {},
				): ManagedVmExecProcess => {
					commandCount += 1;
					const resultPromise = (async (): Promise<ManagedVmExecResult> => {
						if (options.cwd === undefined) throw new Error('Expected private operation cwd.');
						const relativeCwd = path.posix.relative('/agent-vm/gog-work', options.cwd);
						const bytes = new TextEncoder().encode('ordinary-file-bytes-from-gog');
						await writeFile(
							path.join(producerDirectory.identity.canonicalPath, relativeCwd, 'report.pdf'),
							bytes,
						);
						await symlink(
							'report.pdf',
							path.join(
								producerDirectory.identity.canonicalPath,
								relativeCwd,
								'unsupported-sibling',
							),
						);
						return {
							exitCode: 1,
							json: (): never => {
								throw new Error('The journey must not parse stdout as authority.');
							},
							lines: () => ['{"path":"misleading-stdout-only.pdf"}'],
							ok: true,
							stderr: '',
							stderrBuffer: Buffer.alloc(0),
							stdout: '{"path":"misleading-stdout-only.pdf"}',
							stdoutBuffer: Buffer.from('{"path":"misleading-stdout-only.pdf"}'),
							toString: () => '{"path":"misleading-stdout-only.pdf"}',
						};
					})();
					return Object.assign(resultPromise, {
						[Symbol.asyncIterator]: async function* () {},
						end: () => {},
						lines: async function* () {},
						output: async function* () {},
						resize: () => {},
						result: resultPromise,
						write: () => {},
					});
				};
				return {
					close: async () => {
						producerDirectory.close();
						hostProcessId = null;
					},
					exec,
					fileTransfer: { createDirectory: async () => {}, writeFileStream: async () => {} },
					finalizeMemoryMount: async () => {},
					getHostProcessId: () => hostProcessId,
					id: 'credentialed-gog-vm',
					start: async () => {
						hostProcessId = 42_000;
					},
				} as unknown as ManagedVm;
			}),
		};
		const runtimeManager = createCredentialedRuntimeManager({
			retentionBudget,
			sharedStaging: {
				getStore: async (requestedZoneId, requestedAgentId) =>
					await sharedStaging.getStore(requestedZoneId, requestedAgentId),
				ownedDirectories: {
					openHostDirectory: (hostPath) =>
						createOwnedHostDirectoryController({
							identity: { canonicalPath: hostPath, device: 1, inode: 1 },
							onClose: () => {},
						}),
				},
			},
			controllerStateDir: path.join(root, 'state'),
			exactProcessTermination: {
				terminateRecordedHostProcess: async () => {
					hostProcessId = null;
					return { hostProcessId: 42_000, kind: 'terminated' };
				},
			},
			managedVmFactory,
			now: () => 1_000,
			readProcessIdentity: async () => ({ command: 'fake-qemu', lstart: 'fake-start' }),
			secretResolver: { resolve: vi.fn(), resolveAll: vi.fn(async () => ({})) },
			sleep: async () => {},
		});
		cleanup.push(async () => await runtimeManager.closeZone(zoneId));
		const leaseFixture = await prepareGogRealFsLeaseFixture({
			principal: invocationPrincipal,
			root,
			sharedStaging,
			zoneId,
		});
		cleanup.push(leaseFixture.close);
		const startActiveUse = vi.spyOn(leaseFixture.leaseManager, 'startActiveUse');
		const endActiveUse = vi.spyOn(leaseFixture.leaseManager, 'endActiveUse');
		let controllerAuthorizationRejectionCount = 0;
		let forgeControllerAuthority = false;
		let useStaleLeaseBinding = false;
		const execute = createConfiguredCliManagedVmExecutor({
			resolveGatewayIdentity: async () => ({
				controllerEpoch: 'controller-realfs',
				gatewayEpoch: 'gateway-realfs',
				parentGatewayVmId: 'gateway-vm-realfs',
				runtimeEpoch: 'runtime-realfs',
			}),
			resolveOAuthRuntimeCredential: async (request) =>
				await runtimeBroker.resolveRuntimeCredential(request),
			validateOAuthRuntimeCredentialSnapshot: (request) =>
				runtimeBroker.validateRuntimeCredentialSnapshot(request),
			validateGooglePolicySnapshot: ({ request, expected }) =>
				policyService.readCurrentPolicyForDispatch({ request, expected }),
			runtimeManager,
		});
		const acceptedSession = {
			bootId: 'gateway-realfs-boot',
			controllerEpoch: 'controller-realfs',
			peerId: 'gateway-realfs-peer',
			zoneId,
		};
		const callerContext = {
			agentId,
			bootId: acceptedSession.bootId,
			callerContextId: '11111111-1111-4111-8111-111111111111',
			connectionId: '22222222-2222-4222-8222-222222222222',
			controllerEpoch: acceptedSession.controllerEpoch,
			peerId: acceptedSession.peerId,
			principal: invocationPrincipal,
			purpose: 'tool_portal_controller_execution' as const,
			sessionId: '33333333-3333-4333-8333-333333333333',
			stablePrincipal: deriveGatewayControlStablePrincipal({ principal: invocationPrincipal }),
			zoneId,
		};
		const recordingControllerExecution = createRecordingBackendPort(
			'controller_execution',
			'google',
			{ toolName: 'gog' },
		);
		const controllerExecution: ToolPortalBackendPort<'controller_execution'> = {
			...recordingControllerExecution.port,
			call: async (request, options) => {
				const call = request.calls[0];
				if (call === undefined) throw new Error('Missing configured CLI call.');
				if (options.dispatchAuthority.kind !== 'without-approval')
					throw new Error('Expected compiled direct Google read authority.');
				const operationId = options.dispatchAuthority.operationId;
				const input = controllerConfiguredCliInputSchema.parse(call.arguments);
				const payload = {
					authority: {
						bindingRevision: options.dispatchAuthority.bindingRevision,
						fingerprint: forgeControllerAuthority
							? GatewayRuntimeApprovalFingerprintSchema.parse(`sha256:${'b'.repeat(64)}`)
							: options.dispatchAuthority.fingerprint,
						kind: 'without_approval' as const,
						operationId,
					},
					callerContext: { callerContextId: callerContext.callerContextId },
					capability: { name: 'gog', namespace: 'google' },
					correlation: { capability: { name: 'gog', namespace: 'google' } },
					input,
					invocation: {
						callId: call.id,
						surfaceClass: 'protected_uds' as const,
						trustedContext: { principal: invocationPrincipal },
					},
					kind: 'configured_cli' as const,
					operationName: 'gog',
				} satisfies GatewayControlToolPortalControllerExecutionPayload;
				const authorize = async (): Promise<
					Awaited<ReturnType<typeof authorizeGatewayControlControllerExecution>>
				> =>
					await authorizeGatewayControlControllerExecution({
						callerContext,
						credentialedRuntimeRegistryPublisher,
						createdAtMs: 1_000,
						expiresAtMs: deriveGatewayControlControllerExecutionRpcWindow({
							input,
							nowMs: 1_000,
							targetKind: 'ephemeral_managed_vm',
							timeoutKind: 'quick',
						}).expiresAtMs,
						payload,
						resolveManagedGoogleInvocation: (googleRequest) =>
							policyService.resolveManagedGoogleInvocation(googleRequest),
						session: acceptedSession,
						systemConfig,
					});
				const authorized = await authorize();
				if (!authorized.authorized || authorized.configuredCli === undefined) {
					controllerAuthorizationRejectionCount += 1;
					throw new Error(
						`Controller authorization rejected: ${
							authorized.authorized ? 'missing-operation' : authorized.errorClass
						}`,
					);
				}
				const authorization = authorized.configuredCli;
				const result = await execute({
					authorization,
					input,
					operation: authorization.operation,
					operationName: 'gog',
					publishFileResults: async ({ folder, assertCurrent }) =>
						await withCurrentToolVmWorkFiles({
							agentId,
							authority: leaseFixture.authority,
							executionProof: {
								operationPayloadDigest: 'gog-realfs-payload',
								processEpoch: 'gog-realfs-process',
								semanticOperationId: operationId,
								sessionAttachmentGeneration: 1,
							},
							...(useStaleLeaseBinding
								? {
										expectedBinding: {
											...leaseFixture.receiver,
											leafGeneration: 'stale-leaf',
										},
									}
								: {}),
							leaseManager: leaseFixture.leaseManager,
							program: 'gog-realfs-publication',
							signal: new AbortController().signal,
							use: async (destination) =>
								await folder.publish({
									receiver: destination.binding,
									withPublicationAuthority: async (expose) => {
										assertCurrent();
										if (!destination.authorityIsCurrent())
											throw new Error('Lease authority changed before publication.');
										await expose();
									},
								}),
						}),
					reloadAuthorization: async () => {
						const current = await authorize();
						if (!current.authorized || current.configuredCli === undefined)
							throw new Error('Controller authorization changed.');
						return current.configuredCli;
					},
					stablePrincipal: callerContext.stablePrincipal,
					zoneId,
				});
				return {
					items: [
						successfulCallItem({
							call,
							operationId,
							owningGeneration: portalAdmission.semanticSnapshot.activeRevision,
							value: jsonValueSchema.parse(result),
						}),
					],
					ok: true,
				};
			},
		};
		const portal = createManagedToolPortalCapabilityCore({
			config: portalConfig,
			semanticSnapshot: portalAdmission.semanticSnapshot,
			approvalPort: {
				reserveDispatch: async () => {
					throw new Error('The compiled read policy should not ask.');
				},
				armDispatch: async () => {
					throw new Error('The compiled read policy should not ask.');
				},
			},
			oauthAvailabilityPort: {
				resolve: async ({ request }) => ({
					items: request.requirements.map((requirement) => ({
						requirement,
						availability: policyService.resolveOperationAvailability({ agentId, requirement }),
					})),
				}),
				preflight: async ({ request }) =>
					policyService.resolveManagedGoogleInvocation({
						agentId,
						profileId: 'shared',
						namespaceId: request.capability.namespace,
						operationName: request.capability.name,
						input: request.input,
					}),
			},
			backendPorts: {
				controllerExecution,
				mcpProvider: createRecordingBackendPort('mcp_provider', 'unused').port,
				toolVmRunner: createRecordingBackendPort('tool_vm_runner', 'unused').port,
			},
		});
		const call = (id: string): PortalCallRequest => ({
			calls: [
				{
					id,
					namespace: 'google',
					name: 'gog',
					arguments: {
						accountId: enrolled.accountId,
						argv: [
							'drive',
							'download',
							'document-id',
							'--out',
							'./report.input',
							'--format',
							'pdf',
							'--json',
						],
						reason: 'Export a document for the next tool.',
					},
				},
			],
		});

		// Act: publish once, fence a stale receiver, then reject forged controller authority.
		const published = await portal.call(
			call('published-call'),
			udsOptions({ principal: invocationPrincipal }),
		);
		useStaleLeaseBinding = true;
		const stale = await portal.call(
			call('stale-publication-call'),
			udsOptions({ principal: invocationPrincipal }),
		);
		useStaleLeaseBinding = false;
		forgeControllerAuthority = true;
		const forged = await portal.call(
			call('forged-authority-call'),
			udsOptions({ principal: invocationPrincipal }),
		);

		// Assert: trust the returned RealFS path, not the deliberately misleading stdout JSON.
		if (published.items[0]?.status !== 'ok') throw new Error(JSON.stringify(published));
		const firstValue = GatewayControlConfiguredCliControllerExecutionResultSchema.parse({
			kind: 'configured_cli',
			operationName: 'gog',
			result: published.items[0].value,
		}).result;
		expect(firstValue).toMatchObject({
			exitCode: 1,
			operationFiles: {
				kind: 'available',
				files: [expect.objectContaining({ byteLength: 28 })],
				failedFiles: [
					expect.objectContaining({
						relativePath: 'unsupported-sibling',
						reason: 'invalid-path',
					}),
				],
			},
		});
		if (firstValue.operationFiles?.kind !== 'available')
			throw new Error('Expected published operation files.');
		const publishedFile = firstValue.operationFiles.files[0];
		if (publishedFile === undefined) throw new Error('Expected returned file path.');
		const returnedPath = publishedFile.path;
		expect(returnedPath).not.toContain('misleading-stdout-only.pdf');
		const receiverRelativePath = path.posix.relative('/agent-vm/files', returnedPath);
		await expect(
			readFile(path.join(leaseFixture.receiverHostRoot, receiverRelativePath), 'utf8'),
		).resolves.toBe('ordinary-file-bytes-from-gog');
		if (stale.items[0]?.status !== 'ok') throw new Error(JSON.stringify(stale));
		expect(stale.items[0].value).toMatchObject({
			exitCode: 1,
			operationFiles: { kind: 'unavailable', reason: 'file-result-failed' },
		});
		expect(forged.items[0]?.status).toBe('error');
		expect(controllerAuthorizationRejectionCount).toBe(1);
		expect(startActiveUse).toHaveBeenCalledTimes(1);
		expect(endActiveUse).toHaveBeenCalledTimes(1);
		expect(commandCount).toBe(2);
		expect(await readdir(leaseFixture.receiverHostRoot)).toHaveLength(1);
	});
});
