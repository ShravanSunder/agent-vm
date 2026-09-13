import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { PortalCallRequest } from '@agent-vm/agent-portal-sdk';
import {
	compileOAuthPolicy,
	configuredGoogleOperationKey,
	controllerConfiguredCliInputSchema,
	encodeConfiguredCliPreparedImageIdentity,
	gatewayRuntimeManagedToolPortalConfigSchema,
	jsonValueSchema,
	resolveCompiledGoogleCommand,
	type EffectiveControllerEphemeralManagedVmConfiguredCliOperation,
} from '@agent-vm/config-contracts';
import {
	deriveGatewayControlStablePrincipal,
	GATEWAY_RUNTIME_APPROVAL_AUDIENCE,
	GatewayControlConfiguredCliControllerExecutionResultSchema,
	type GatewayRuntimeToolPortalDispatchAuthorityForBackendKind,
} from '@agent-vm/gateway-control-contracts';
import type { ManagedVm, ManagedVmCreateRequest } from '@agent-vm/managed-vm';
import {
	managedGoogleReadyPreflightSchema,
	oauthAccountIdSchema,
	oauthMaterialRevisionSchema,
	type ManagedGooglePreflightResult,
} from '@agent-vm/oauth-broker-contracts';
import { getGooglePolicyCatalog } from '@agent-vm/oauth-broker/google';
import {
	createManagedToolPortalCapabilityCore,
	type ToolPortalBackendPort,
} from '@agent-vm/tool-portal';
import { afterEach, describe, expect, it } from 'vitest';

import { createOAuthPolicyCompilerTestInput } from '../../../config-contracts/src/oauth-policy-compiler-test-fixture.js';
import {
	createRecordingBackendPort,
	semanticSnapshot,
	udsOptions,
} from '../../../tool-portal/src/tool-portal-service-test-fixture.js';
import { createManagedVmRuntimeComposition } from '../composition/gondolin-managed-vm-provider.js';
import { createControllerApprovalLedger } from '../controller/approval/controller-approval-ledger.js';
import { createCredentialedRuntimeManager } from '../controller/credentialed-runtime/credentialed-runtime-manager.js';
import { createControllerSharedStaging } from '../controller/files/controller-shared-staging.js';
import { createOperationFileRetentionBudget } from '../controller/files/operation-file-retention-budget.js';
import type { ConfiguredCliAuthorizedOperation } from '../controller/runner/configured-cli-authorization.js';
import { createConfiguredCliManagedVmExecutor } from '../controller/runner/configured-cli-managed-vm-executor.js';
import { readProcessIdentity } from '../shared/managed-vm-process.js';
import { shouldRunLiveVmE2e } from './live-vm-e2e-gates.js';
import {
	createPinnedGogPortalCall,
	createPinnedGogPortalSuccess,
	createPinnedGogSyntheticGoogleMediation,
	formatPinnedGogSyntheticDiagnostic,
	pinnedGogControllerDispatchIdentity,
	pinnedGogPublishedFileContents,
	pinnedGogRuntimeIdentity,
	preparePinnedGogRuntimeArtifact,
} from './pinned-gog-runtime-test-fixture.js';

const describePinnedGogRuntime = shouldRunLiveVmE2e() ? describe : describe.skip;
const {
	accessToken: syntheticAccessToken,
	accountId,
	authorityContext,
	authorizationId,
	credentialId,
	principal,
} = pinnedGogRuntimeIdentity;
const { zoneId } = authorityContext;

function call(
	id: string,
	argv: readonly string[],
	requestedAccountId = accountId,
): PortalCallRequest {
	return createPinnedGogPortalCall({ accountId: requestedAccountId, argv, id });
}

describePinnedGogRuntime('pinned Gog v0.38.1 through Portal and credentialed Managed VM', () => {
	const cleanup: (() => Promise<void>)[] = [];
	afterEach(async () => {
		// oxlint-disable-next-line no-await-in-loop -- runtime containment precedes temp-root deletion
		for (const close of cleanup.splice(0).toReversed()) await close();
	});

	it('runs admitted read, approved non-send mutation, denied escapes, and RealFS publication', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'pinned-gog-runtime-'));
		cleanup.push(async () => await rm(root, { force: true, recursive: true }));
		const artifact = await preparePinnedGogRuntimeArtifact(root);

		const catalog = getGooglePolicyCatalog();
		const compilerInput = createOAuthPolicyCompilerTestInput();
		const commands = [
			{ path: ['gmail', 'get'], flagRules: [] },
			{ path: ['gmail', 'drafts', 'create'], flagRules: [] },
			{ path: ['drive', 'download'], flagRules: [] },
		];
		const qualifiedHosts = [
			...new Set([
				...catalog.families.communications.allowedHosts,
				...catalog.families.documents.allowedHosts,
			]),
		];
		const compiled = compileOAuthPolicy({
			catalog,
			oauthConfig: {
				...compilerInput.oauthConfig,
				agents: {
					...compilerInput.oauthConfig.agents,
					ember: {
						applications: {
							...compilerInput.oauthConfig.agents.ember?.applications,
							'gmail-app': {
								ceiling: {
									kind: 'explicit',
									groupIds: ['gmail.read', 'gmail.write'],
								},
							},
							'workspace-app': {
								ceiling: { kind: 'explicit', groupIds: ['drive.all-files.read'] },
							},
						},
					},
					sun: {
						applications: {
							'gmail-app': {
								ceiling: {
									kind: 'explicit',
									groupIds: ['gmail.read', 'gmail.write'],
								},
							},
							'workspace-app': {
								ceiling: { kind: 'explicit', groupIds: ['drive.all-files.read'] },
							},
						},
					},
				},
			},
			toolPortalConfig: {
				...compilerInput.toolPortalConfig,
				agents: {
					...compilerInput.toolPortalConfig.agents,
					sun: {
						profile: 'shared',
						googlePolicyDefaults: {
							kind: 'explicit',
							applications: {
								'gmail-app': { gmail: { read: 'allow', write: 'ask' } },
								'workspace-app': { drive: { read: 'allow', write: 'deny' } },
							},
						},
					},
				},
				profiles: {
					shared: {
						...compilerInput.toolPortalConfig.profiles.shared,
						namespaces: {
							...compilerInput.toolPortalConfig.profiles.shared.namespaces,
							google: {
								...compilerInput.toolPortalConfig.profiles.shared.namespaces.google,
								tools: { allow: ['gog'] },
								backend: {
									...compilerInput.toolPortalConfig.profiles.shared.namespaces.google.backend,
									operations: {
										gog: {
											...compilerInput.toolPortalConfig.profiles.shared.namespaces.google.backend
												.operations.gog,
											commands,
											executablePath: '/opt/pinned-gog/gog',
											executionTarget: {
												...compilerInput.toolPortalConfig.profiles.shared.namespaces.google.backend
													.operations.gog.executionTarget,
												allowedHosts: qualifiedHosts,
											},
										},
									},
								},
							},
						},
					},
				},
			},
		});
		const commandSet =
			compiled.commandSetsByConfiguredOperation[
				configuredGoogleOperationKey('shared', 'google', 'gog')
			];
		if (commandSet === undefined) throw new Error('Expected compiled pinned Gog command set.');

		const operation: EffectiveControllerEphemeralManagedVmConfiguredCliOperation = {
			authorization: { kind: 'oauth_account' },
			calls: { source: 'managed_google_policy', deny: [] },
			commands,
			compiledGoogle: commandSet,
			deniedPatterns: [],
			executablePath: '/opt/pinned-gog/gog',
			executionTarget: {
				allowedHosts: qualifiedHosts,
				credentialProjection: {
					environment: { GOG_ACCESS_TOKEN: { kind: 'oauth_access_token' } },
					kind: 'http_mediation',
				},
				environment: { kind: 'empty' },
				guestCwd: '/agent-vm/gog-work',
				imageReference: encodeConfiguredCliPreparedImageIdentity({
					fingerprint: 'sha256:pinned-gog-alpine-base',
					imageReference: 'alpine-base:latest',
					schemaVersion: 1,
				}),
				kind: 'ephemeral_managed_vm',
			},
			kind: 'configured_cli',
			mandatoryArgvPrefix: [],
			output: {
				modelVisibleStderr: 'fixed_safe_summary',
				overflow: 'truncate',
				stderrMaxBytes: 4096,
				stdoutMaxBytes: 16_384,
			},
			safeHelp: 'Pinned Gog runtime proof.',
			stdin: { kind: 'none' },
			// Network CLI journey, not a five-second quick-command deadline test.
			timeout: { kind: 'open' },
		};

		const composition = createManagedVmRuntimeComposition();
		const observedRequests: string[] = [];
		const runtimeDiagnostics: string[] = [];
		const recordRuntimeDiagnostic = (stage: string, error: unknown): void => {
			if (runtimeDiagnostics.length >= 8) return;
			runtimeDiagnostics.push(
				`${stage}: ${formatPinnedGogSyntheticDiagnostic(error, syntheticAccessToken)}`,
			);
		};
		const onRequest = createPinnedGogSyntheticGoogleMediation({
			accessToken: syntheticAccessToken,
			observedRequests,
		});
		const managedVmFactory = {
			createManagedVm: async (request: ManagedVmCreateRequest): Promise<ManagedVm> => {
				let managedVm: ManagedVm;
				try {
					managedVm = await composition.managedVmFactory.createManagedVm({
						...request,
						mediation: { onRequest },
						mounts: {
							...request.mounts,
							'/opt/pinned-gog': {
								access: 'read-only',
								directory: composition.managedVmOwnedDirectories.openHostDirectory(
									artifact.directoryPath,
								),
								kind: 'owned-host-directory',
							},
						},
					});
				} catch (error: unknown) {
					recordRuntimeDiagnostic('create', error);
					throw error;
				}
				return {
					close: async () => await managedVm.close(),
					configureIngressRoutes: (routes) => managedVm.configureIngressRoutes(routes),
					enableIngress: async (options) => await managedVm.enableIngress(options),
					enableSsh: async (options) => await managedVm.enableSsh(options),
					exec: (command, options) => managedVm.exec(command, options),
					...(managedVm.finalizeMemoryMount === undefined
						? {}
						: {
								finalizeMemoryMount: async (finalizeRequest) =>
									await managedVm.finalizeMemoryMount?.(finalizeRequest),
							}),
					getHostProcessId: () => managedVm.getHostProcessId(),
					id: managedVm.id,
					start: async () => {
						try {
							await managedVm.start();
						} catch (error: unknown) {
							recordRuntimeDiagnostic('start', error);
							throw error;
						}
					},
				};
			},
		};
		const sharedStaging = createControllerSharedStaging({
			controllerEpoch: authorityContext.controllerEpoch,
			controllerRuntimeDir: path.join(root, 'runtime'),
			now: () => 1_000,
			retentionBudget: createOperationFileRetentionBudget(),
		});
		const stagingStore = await sharedStaging.getStore(zoneId, principal.agentId);
		const receiverHostRoot = await stagingStore.prepareReceiverRoot('receiver-leaf');
		const runtimeManager = createCredentialedRuntimeManager({
			controllerStateDir: path.join(root, 'state'),
			exactProcessTermination: composition.managedVmExactProcessTermination,
			managedVmFactory,
			readProcessIdentity,
			retentionBudget: createOperationFileRetentionBudget(),
			secretResolver: {
				resolve: async () => {
					throw new Error('Pinned Gog proof uses dynamic OAuth mediation only.');
				},
				resolveAll: async () => ({}),
			},
			sharedStaging: {
				getStore: async (requestedZoneId, requestedAgentId) =>
					await sharedStaging.getStore(requestedZoneId, requestedAgentId),
				ownedDirectories: composition.managedVmOwnedDirectories,
			},
		});
		cleanup.push(async () => await runtimeManager.closeZone(zoneId));

		let currentPolicyRevision = 1;
		const preflight = (request: {
			readonly agentId: string;
			readonly input: ReturnType<typeof controllerConfiguredCliInputSchema.parse>;
		}): ManagedGooglePreflightResult => {
			if (
				request.agentId !== principal.agentId ||
				!('accountId' in request.input) ||
				request.input.accountId !== accountId
			)
				return { kind: 'denied' };
			const classification = resolveCompiledGoogleCommand(commandSet, request.input.argv);
			if (classification.kind !== 'oauth') return { kind: 'denied' };
			const isCommunications = classification.operationId !== 'drive.download';
			return managedGoogleReadyPreflightSchema.parse({
				kind: 'ready',
				disposition: classification.operationId === 'gmail.drafts.create' ? 'ask' : 'allow',
				binding: {
					accountId,
					applicationId: isCommunications ? 'gmail-app' : 'workspace-app',
					authorizationId,
					authorizationMetadataRevision: 1,
					catalogVersion: catalog.catalogVersion,
					clientBindingRevision: 'pinned-gog-client',
					commandTableRevision: commandSet.revision,
					configRevision: 'pinned-gog-config',
					defaultsRevision: compiled.defaultsRevision,
					generation: 1,
					gmailWriteAllowed: classification.operationId === 'gmail.drafts.create',
					operationId: classification.operationId,
					overrideRevision: currentPolicyRevision,
				},
				display: {
					accountAlias: 'Synthetic mailbox',
					accountId,
					applicationLabel: isCommunications ? 'Google communications' : 'Google Drive',
					authorizationId,
					authorizationMetadataRevision: 1,
				},
			});
		};
		const executor = createConfiguredCliManagedVmExecutor({
			resolveGatewayIdentity: async () => ({
				controllerEpoch: authorityContext.controllerEpoch,
				gatewayEpoch: authorityContext.gatewayEpoch,
				parentGatewayVmId: 'pinned-gog-parent-gateway-vm',
				runtimeEpoch: authorityContext.runtimeEpoch,
			}),
			resolveOAuthRuntimeCredential: async (request) => ({
				accessToken: new TextEncoder().encode(syntheticAccessToken),
				accountId: request.accountId,
				allowedHosts:
					request.applicationId === 'gmail-app'
						? compiled.allowedHostsByApplication['gmail-app']
						: compiled.allowedHostsByApplication['workspace-app'],
				authorizationId,
				authorizationMetadataRevision: 1,
				credentialId,
				generation: 1,
				gmailNoSend: true,
				kind: 'ready',
				materialRevision: oauthMaterialRevisionSchema.parse(
					`sha256:${Buffer.alloc(32, 7).toString('base64url')}`,
				),
			}),
			runtimeManager,
			validateGooglePolicySnapshot: ({ expected }) =>
				expected.overrideRevision === currentPolicyRevision,
			validateOAuthRuntimeCredentialSnapshot: () => ({ kind: 'current' }),
		});

		const authorizationFor = (props: {
			readonly authority: GatewayRuntimeToolPortalDispatchAuthorityForBackendKind<'controller_execution'>;
			readonly managedGoogle: Extract<ManagedGooglePreflightResult, { kind: 'ready' }>;
			readonly operationId: string;
		}): ConfiguredCliAuthorizedOperation => ({
			credentialedRuntime: {
				agentId: principal.agentId,
				agentRuntimeRevision: 'sha256:pinned-gog-runtime',
				cohortRevision: semanticSnapshot.bindingRevision,
				namespaceId: 'google',
				operation,
				operationName: 'gog',
				profileId: principal.toolPortalProfileId,
				projection: { environmentName: 'GOG_ACCESS_TOKEN', kind: 'oauth_http_mediation' },
				zoneId,
			},
			evaluation: {
				authorityKind:
					props.authority.kind === 'without-approval'
						? 'without_approval'
						: 'controller_approval_reservation',
				bindingRevision: semanticSnapshot.bindingRevision,
				disposition:
					props.authority.kind === 'without-approval' ? 'without_approval' : 'requires_approval',
				fingerprint:
					props.authority.kind === 'without-approval'
						? props.authority.fingerprint
						: props.authority.kind === 'controller-approval-reservation'
							? props.authority.reservation.fingerprint
							: props.authority.grant.fingerprint,
				operationId: props.operationId,
				operationName: 'gog',
				targetKind: 'ephemeral_managed_vm',
			},
			managedGoogle: props.managedGoogle,
			operation,
		});
		let approvalAuthorityCurrent = true;
		const ledger = createControllerApprovalLedger({
			challengeTtlMs: 60_000,
			currentControllerEpoch: authorityContext.controllerEpoch,
			recordsTarget: {
				directoryPath: path.join(root, 'approvals'),
				kind: 'controller-approval-records',
				zoneId,
			},
			validateInputAuthority: async () => approvalAuthorityCurrent,
			validateIntent: () => approvalAuthorityCurrent,
		});
		const controllerExecution: ToolPortalBackendPort<'controller_execution'> = {
			...createRecordingBackendPort('controller_execution', 'google', { toolName: 'gog' }).port,
			call: async (request, options) => {
				const item = request.calls[0];
				if (item === undefined) throw new Error('Missing pinned Gog call.');
				const input = controllerConfiguredCliInputSchema.parse(item.arguments);
				const managedGoogle = preflight({ agentId: principal.agentId, input });
				if (managedGoogle.kind !== 'ready') throw new Error('Portal dispatched denied Gog call.');
				const operationId = pinnedGogControllerDispatchIdentity(
					options.dispatchAuthority,
				).operationId;
				const authorization = authorizationFor({
					authority: options.dispatchAuthority,
					managedGoogle,
					operationId,
				});
				let result: Awaited<ReturnType<typeof executor>>;
				try {
					result = await executor({
						authorization,
						input,
						operation,
						operationName: 'gog',
						publishFileResults: async ({ folder, assertCurrent }) =>
							await folder.publish({
								receiver: {
									leafGeneration: 'receiver-leaf',
									leaseId: 'receiver-lease',
									vmId: 'receiver-vm',
								},
								withPublicationAuthority: async (expose) => {
									assertCurrent();
									await expose();
								},
							}),
						reloadAuthorization: async () => authorization,
						stablePrincipal: deriveGatewayControlStablePrincipal({ principal }),
						zoneId,
					});
				} catch (error: unknown) {
					recordRuntimeDiagnostic('executor', error);
					throw error;
				}
				return createPinnedGogPortalSuccess({
					call: item,
					operationId,
					owningGeneration: semanticSnapshot.activeRevision,
					value: jsonValueSchema.parse(result),
				});
			},
		};
		const portalConfig = gatewayRuntimeManagedToolPortalConfigSchema.parse({
			agents: { sun: { profile: 'shared' } },
			mode: 'managed',
			profiles: {
				shared: {
					namespaces: {
						google: {
							backend: {
								kind: 'controller_execution',
								operations: {
									gog: {
										authorization: { kind: 'oauth_account' },
										calls: { deny: [], source: 'managed_google_policy' },
										commands,
										compiledGoogle: commandSet,
										deniedPatterns: [],
										kind: 'configured_cli',
										safeHelp: 'Pinned Gog runtime proof.',
										stdin: { kind: 'none' },
										targetKind: 'ephemeral_managed_vm',
										timeout: { kind: 'open' },
									},
								},
							},
							calls: { source: 'managed_google_policy' },
							discovery: { summary: 'Pinned Google CLI' },
							tools: { allow: ['gog'] },
						},
					},
				},
			},
			schemaVersion: 1,
		});
		const portal = createManagedToolPortalCapabilityCore({
			approvalPort: {
				armDispatch: async () => {
					throw new Error('Controller execution does not arm Gateway dispatch.');
				},
				reserveDispatch: async ({ intent }) =>
					await ledger.requestApproval({ authorityContext, intent }),
			},
			backendPorts: {
				controllerExecution,
				mcpProvider: createRecordingBackendPort('mcp_provider', 'unused').port,
				toolVmRunner: createRecordingBackendPort('tool_vm_runner', 'unused').port,
			},
			config: portalConfig,
			oauthAvailabilityPort: {
				preflight: async ({ request, trustedContext }) =>
					preflight({ agentId: trustedContext.principal.agentId, input: request.input }),
				resolve: async ({ request }) => ({
					items: request.requirements.map((requirement) => ({
						availability: { kind: 'unavailable' as const },
						requirement,
					})),
				}),
			},
			semanticSnapshot: {
				...semanticSnapshot,
				agentProjections: {
					sun: {
						...principal,
						toolPortalNamespaces: [{ namespace: 'google', summary: 'Pinned Google CLI' }],
					},
				},
				surfaceEligibilityByProfile: { shared: { google: ['protected_uds'] } },
			},
		});
		const invocationOptions = udsOptions({ principal });

		const read = await portal.call(
			call('read', ['gmail', 'get', 'message-1', '--format', 'full', '--json']),
			invocationOptions,
		);
		expect(
			read.items[0],
			`Pinned Gog read result: ${JSON.stringify(read.items[0])}; requests: ${JSON.stringify(observedRequests)}; runtime: ${JSON.stringify(runtimeDiagnostics)}`,
		).toMatchObject({ status: 'ok', value: { exitCode: 0 } });
		const readItem = read.items[0];
		if (readItem?.status !== 'ok') throw new Error('Pinned Gog read did not complete.');
		expect(JSON.stringify(readItem.value)).toContain('message-1');

		const mutationCall = call('mutation', [
			'gmail',
			'drafts',
			'create',
			'--subject',
			'Synthetic proof draft',
			'--body',
			'Synthetic body',
			'--json',
		]);
		const pendingMutation = await portal.call(mutationCall, invocationOptions);
		expect(pendingMutation.items[0]).toMatchObject({ status: 'approval_required' });
		const [pending] = await ledger.list();
		if (pending?.kind !== 'pending') throw new Error('Expected exact Gog mutation approval.');
		expect(
			await ledger.decide({
				approvalId: pending.challenge.approvalId,
				authorityContext,
				decision: 'approve',
				operator: {
					approverId: 'pinned-gog-test',
					audience: GATEWAY_RUNTIME_APPROVAL_AUDIENCE,
					provenance: 'managed-gateway',
					stablePrincipal: deriveGatewayControlStablePrincipal({ principal }),
				},
			}),
		).toMatchObject({ kind: 'recorded' });
		const mutationResult = await portal.call(mutationCall, invocationOptions);
		expect(
			mutationResult,
			`Pinned Gog mutation result: ${JSON.stringify(mutationResult)}; requests: ${JSON.stringify(observedRequests)}; runtime: ${JSON.stringify(runtimeDiagnostics)}`,
		).toMatchObject({
			items: [{ status: 'ok', value: { exitCode: 0 } }],
		});

		const requestsBeforeDeniedCalls = observedRequests.length;
		const deniedResults = await Promise.all(
			[
				call('send-denied', [
					'gmail',
					'send',
					'--to',
					'nobody@example.test',
					'--subject',
					'x',
					'--body',
					'x',
				]),
				call('api-denied', ['api', 'gmail.users.messages.send', '--json', '{}']),
				call('alias-flag-escape', ['mail', 'get', 'message-1', '--access-token', 'escape']),
				call(
					'wrong-account',
					['gmail', 'get', 'message-1'],
					oauthAccountIdSchema.parse('99999999-9999-4999-8999-999999999999'),
				),
			].map(async (denied) => await portal.call(denied, invocationOptions)),
		);
		for (const deniedResult of deniedResults) expect(deniedResult.items[0]?.status).toBe('error');
		await expect(
			portal.call(
				call('wrong-agent', ['gmail', 'get', 'message-1']),
				udsOptions({ principal: { ...principal, agentId: 'ember' } }),
			),
		).rejects.toThrow('Tool Portal agent "ember" is not configured.');
		expect(observedRequests).toHaveLength(requestsBeforeDeniedCalls);

		const staleCall = call('stale', [
			'gmail',
			'drafts',
			'create',
			'--subject',
			'Stale proof draft',
			'--body',
			'Stale body',
			'--json',
		]);
		expect((await portal.call(staleCall, invocationOptions)).items[0]?.status).toBe(
			'approval_required',
		);
		const stalePending = (await ledger.list()).find(
			(record) => record.kind === 'pending' && record.challenge.intent.call.id === 'stale',
		);
		if (stalePending?.kind !== 'pending') throw new Error('Expected stale approval candidate.');
		approvalAuthorityCurrent = false;
		currentPolicyRevision += 1;
		expect(
			await ledger.decide({
				approvalId: stalePending.challenge.approvalId,
				authorityContext,
				decision: 'approve',
				operator: {
					approverId: 'pinned-gog-test',
					audience: GATEWAY_RUNTIME_APPROVAL_AUDIENCE,
					provenance: 'managed-gateway',
					stablePrincipal: deriveGatewayControlStablePrincipal({ principal }),
				},
			}),
		).toEqual({ kind: 'rejected', reason: 'stale-authority' });
		approvalAuthorityCurrent = true;

		const fileResult = await portal.call(
			call('file', ['drive', 'download', 'file-1', '--out', './report.pdf', '--json']),
			invocationOptions,
		);
		expect(fileResult.items[0]).toMatchObject({
			status: 'ok',
			value: {
				exitCode: 0,
				operationFiles: {
					kind: 'available',
					files: [expect.objectContaining({ byteLength: pinnedGogPublishedFileContents.length })],
				},
			},
		});
		const fileItem = fileResult.items[0];
		if (fileItem?.status !== 'ok') throw new Error('Pinned Gog file call did not complete.');
		const fileValue = GatewayControlConfiguredCliControllerExecutionResultSchema.parse({
			kind: 'configured_cli',
			operationName: 'gog',
			result: fileItem.value,
		}).result;
		if (fileValue.operationFiles?.kind !== 'available')
			throw new Error('Missing pinned Gog file publication result.');
		const publishedPath = fileValue.operationFiles.files[0]?.path;
		if (publishedPath === undefined) throw new Error('Missing pinned Gog published path.');
		const relativePublishedPath = path.posix.relative('/agent-vm/files', publishedPath);
		await expect(
			readFile(path.join(receiverHostRoot, relativePublishedPath), 'utf8'),
		).resolves.toBe(pinnedGogPublishedFileContents);
		expect(observedRequests).toEqual(
			expect.arrayContaining([
				expect.stringContaining('GET gmail.googleapis.com/gmail/v1/users/me/messages/message-1'),
				expect.stringContaining('POST gmail.googleapis.com/gmail/v1/users/me/drafts'),
				expect.stringContaining('GET www.googleapis.com/drive/v3/files/file-1'),
			]),
		);
	});
});
