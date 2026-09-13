import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import type { PortalCallRequest } from '@agent-vm/agent-portal-sdk';
import {
	compileOAuthPolicy,
	controllerConfiguredCliInputSchema,
	configuredGoogleOperationKey,
	gatewayRuntimeManagedToolPortalConfigSchema,
} from '@agent-vm/config-contracts';
import {
	deriveGatewayControlStablePrincipal,
	GATEWAY_RUNTIME_APPROVAL_AUDIENCE,
} from '@agent-vm/gateway-control-contracts';
import {
	googleAccountPolicySnapshotSchema,
	oauthAccountIdSchema,
	oauthApplicationIdSchema,
	type ManagedGooglePreflightResult,
} from '@agent-vm/oauth-broker-contracts';
import { createManagedToolPortalCapabilityCore } from '@agent-vm/tool-portal';
import { afterEach, describe, expect, it } from 'vitest';

import { createOAuthPolicyCompilerTestInput } from '../../../../config-contracts/src/oauth-policy-compiler-test-fixture.js';
import {
	createBrokerFacadeFixture,
	facadeIdentity,
} from '../../../../oauth-broker/src/google/google-broker-facade-test-fixture.js';
import { wrappingKey } from '../../../../oauth-broker/src/oauth-catalog-test-fixture.js';
import {
	createRecordingBackendPort,
	semanticSnapshot,
	udsOptions,
} from '../../../../tool-portal/src/tool-portal-service-test-fixture.js';
import { createControllerApprovalLedger } from '../approval/controller-approval-ledger.js';
import { inspectGogFileInputs } from '../files/gog-file-input-preflight.js';
import { validateGoogleApprovalIntent } from './google-approval-intent-validation.js';
import { createGooglePermissionPolicyService } from './google-permission-policy-service.js';
import { resolveManagedGoogleFilePreflight } from './managed-google-file-preflight.js';

const authorityContext = {
	controllerEpoch: 'controller-1',
	frameworkEpoch: 'framework-1',
	gatewayEpoch: 'gateway-1',
	runtimeEpoch: 'runtime-1',
	zoneId: 'test-zone',
};
function trustedContext(agentId: string): NonNullable<Parameters<typeof udsOptions>[0]> {
	return {
		principal: {
			agentId,
			frameworkIdentity: { kind: 'hermes', profileName: agentId },
			profileAssignmentRevision: `assignment-${agentId}`,
			toolPortalProfileId: 'shared',
		},
	};
}

function googleSearchCall(accountId: string): PortalCallRequest {
	return {
		calls: [
			{
				id: 'search-call',
				namespace: 'google',
				name: 'gog',
				arguments: { accountId, argv: ['gmail', 'search', 'unread'], reason: 'Read inbox' },
			},
		],
	};
}

describe('real broker, account policy, Portal preflight and durable approvals', () => {
	const cleanup: (() => Promise<void>)[] = [];
	afterEach(async () => {
		await Promise.all(cleanup.splice(0).map(async (close) => await close()));
	});

	async function arrange(
		refreshOnResolve = false,
		fileInput = false,
	): Promise<{
		readonly fileSource: { bytes: Uint8Array; vmId: string };
		readonly accountId: ReturnType<typeof oauthAccountIdSchema.parse>;
		readonly brokerFixture: Awaited<ReturnType<typeof createBrokerFacadeFixture>>;
		readonly refreshes: { count: number };
		readonly core: ReturnType<typeof createManagedToolPortalCapabilityCore>;
		readonly ledger: ReturnType<typeof createControllerApprovalLedger>;
		readonly execution: ReturnType<typeof createRecordingBackendPort<'controller_execution'>>;
		readonly policyService: ReturnType<typeof createGooglePermissionPolicyService>;
		readonly hooks: {
			afterPreflight?: () => Promise<void>;
			transformPreflight?: (result: ManagedGooglePreflightResult) => ManagedGooglePreflightResult;
		};
	}> {
		const refreshes = { count: 0 };
		const fixture = await createBrokerFacadeFixture({
			transformAdapter: (adapter) => ({
				...adapter,
				exchangeAuthorizationCode: async (request) => {
					const result = await adapter.exchangeAuthorizationCode(request);
					return refreshOnResolve && result.kind === 'authorized'
						? {
								...result,
								authorization: { ...result.authorization, accessTokenExpiresAtMs: 1001 },
							}
						: result;
				},
				refreshAuthorization: async (request) => {
					refreshes.count += 1;
					return {
						kind: 'refreshed',
						accessToken: 'synthetic-refreshed-access',
						accessTokenExpiresAtMs: 3_601_000,
						grantedScopes: request.currentGrantedScopes,
					};
				},
			}),
		});
		const approvalRoot = await mkdtemp(path.join(tmpdir(), 'google-portal-policy-'));
		cleanup.push(async () => {
			await fixture.broker.close();
			fixture.catalog.close();
			await rm(approvalRoot, { recursive: true, force: true });
		});
		const sun = await fixture.enroll('sun');
		const ember = await fixture.enroll('ember');
		expect(ember.accountId).toBe(sun.accountId);
		const compilerInput = createOAuthPolicyCompilerTestInput();
		const compiled = compileOAuthPolicy({
			...compilerInput,
			catalog: {
				...compilerInput.catalog,
				operations: compilerInput.catalog.operations.map((descriptor) =>
					fileInput && descriptor.operationId === 'gmail.search'
						? { ...descriptor, positionals: { minimum: 1, maximum: 1, fileInputs: [0] } }
						: descriptor,
				),
			},
		});
		fixture.catalog.activatePolicyDefaults({
			zoneId: authorityContext.zoneId,
			defaultsRevision: compiled.defaultsRevision,
			snapshot: compiled.defaultsSnapshot,
		});
		const policyService = createGooglePermissionPolicyService({
			catalog: fixture.catalog,
			compiled,
			configRevision: 'config-1',
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
		const fileSource = { bytes: new Uint8Array([0, 255, 13, 128]), vmId: 'source-vm' };
		const resolvePreflight = async (
			request: Parameters<typeof policyService.resolveManagedGoogleInvocation>[0],
		): Promise<ManagedGooglePreflightResult> =>
			await resolveManagedGoogleFilePreflight({
				compiled,
				request,
				resolvePolicy: (policyRequest) =>
					policyService.resolveManagedGoogleInvocation(policyRequest),
				readFileInputs: async (paths) =>
					await inspectGogFileInputs({
						binding: {
							leaseId: 'source-lease',
							leafGeneration: 'source-leaf',
							vmId: fileSource.vmId,
						},
						paths,
						files: {
							read: async function* () {
								yield fileSource.bytes;
							},
						},
						signal: new AbortController().signal,
					}),
			});
		const ledger = createControllerApprovalLedger({
			validateInputAuthority: async (intent) =>
				intent.managedGoogle?.fileInputs === undefined ||
				isDeepStrictEqual(
					await resolvePreflight({
						agentId: intent.trustedContext.principal.agentId,
						profileId: 'shared',
						namespaceId: intent.call.namespace,
						operationName: intent.call.name,
						input: controllerConfiguredCliInputSchema.parse(intent.call.arguments),
					}),
					intent.managedGoogle,
				),
			challengeTtlMs: 60_000,
			currentControllerEpoch: authorityContext.controllerEpoch,
			recordsTarget: {
				kind: 'controller-approval-records',
				directoryPath: approvalRoot,
				zoneId: authorityContext.zoneId,
			},
			validateIntent: (intent) =>
				validateGoogleApprovalIntent({
					intent,
					zoneId: authorityContext.zoneId,
					runtime: {
						zoneId: authorityContext.zoneId,
						compiledOAuthPolicy: compiled,
						policyService,
					},
				}),
		});
		const commandSet =
			compiled.commandSetsByConfiguredOperation[
				configuredGoogleOperationKey('shared', 'google', 'gog')
			];
		const config = gatewayRuntimeManagedToolPortalConfigSchema.parse({
			mode: 'managed',
			schemaVersion: 1,
			agents: { sun: { profile: 'shared' }, ember: { profile: 'shared' } },
			profiles: {
				shared: {
					namespaces: {
						google: {
							calls: { source: 'managed_google_policy' },
							tools: { allow: ['gog'] },
							discovery: { summary: 'Google accounts' },
							backend: {
								kind: 'controller_execution',
								operations: {
									gog: {
										kind: 'configured_cli',
										authorization: { kind: 'oauth_account' },
										targetKind: 'ephemeral_managed_vm',
										compiledGoogle: commandSet,
										calls: { source: 'managed_google_policy', deny: [] },
										commands: [{ path: ['gmail', 'search'], flagRules: [] }],
										deniedPatterns: [],
										stdin: { kind: 'none' },
										timeout: { kind: 'quick' },
										safeHelp: 'Search Gmail.',
									},
								},
							},
						},
					},
				},
			},
		});
		const execution = createRecordingBackendPort('controller_execution', 'google', {
			toolName: 'gog',
		});
		const hooks: {
			afterPreflight?: () => Promise<void>;
			transformPreflight?: (result: ManagedGooglePreflightResult) => ManagedGooglePreflightResult;
		} = {};
		const core = createManagedToolPortalCapabilityCore({
			config,
			semanticSnapshot: {
				...semanticSnapshot,
				agentProjections: Object.fromEntries(
					['sun', 'ember'].map((agentId) => {
						const context = trustedContext(agentId);
						if (context === undefined) throw new Error('Missing context.');
						return [
							agentId,
							{
								...context.principal,
								toolPortalNamespaces: [{ namespace: 'google', summary: 'Google accounts' }],
							},
						];
					}),
				),
				surfaceEligibilityByProfile: { shared: { google: ['protected_uds'] } },
			},
			approvalPort: {
				reserveDispatch: async ({ intent }) =>
					await ledger.requestApproval({ authorityContext, intent }),
				armDispatch: async () => {
					throw new Error('Controller execution arms at the host, not in Portal.');
				},
			},
			oauthAvailabilityPort: {
				resolve: async ({ request, trustedContext: context }) => ({
					items: request.requirements.map((requirement) => ({
						requirement,
						availability: policyService.resolveOperationAvailability({
							agentId: context.principal.agentId,
							requirement,
						}),
					})),
				}),
				preflight: async ({ request, trustedContext: context }) => {
					const result = await resolvePreflight({
						agentId: context.principal.agentId,
						profileId: context.principal.toolPortalProfileId,
						namespaceId: request.capability.namespace,
						operationName: request.capability.name,
						input: request.input,
					});
					await hooks.afterPreflight?.();
					return hooks.transformPreflight?.(result) ?? result;
				},
			},
			// Mocked execution/provider edges. This test does not prove a Gog or VM run.
			backendPorts: {
				controllerExecution: execution.port,
				mcpProvider: createRecordingBackendPort('mcp_provider', 'unused').port,
				toolVmRunner: createRecordingBackendPort('tool_vm_runner', 'unused').port,
			},
		});
		return {
			fileSource,
			accountId: sun.accountId,
			brokerFixture: fixture,
			refreshes,
			core,
			ledger,
			execution,
			policyService,
			hooks,
		};
	}
	it.each(['bytes', 'vm'] as const)(
		'requires a new exact approval after input %s changes',
		async (changed) => {
			// Arrange: real Portal, compiler, encrypted catalog and durable ledger; substituted input VM.
			const fixture = await arrange(false, true);
			const context = trustedContext('ember');
			if (context === undefined) throw new Error('Missing context.');
			const request = googleSearchCall(fixture.accountId);
			await fixture.core.call(request, udsOptions(context));
			const [pending] = await fixture.ledger.list();
			if (pending === undefined) throw new Error('Expected pending approval.');
			expect(pending.challenge.intent.managedGoogle?.fileInputs?.files[0]?.relativePath).toBe(
				'unread',
			);
			expect(
				await fixture.ledger.decide({
					approvalId: pending.challenge.approvalId,
					authorityContext,
					decision: 'approve',
					operator: {
						approverId: 'operator-test',
						audience: GATEWAY_RUNTIME_APPROVAL_AUDIENCE,
						provenance: 'managed-gateway',
						stablePrincipal: deriveGatewayControlStablePrincipal({ principal: context.principal }),
					},
				}),
			).toMatchObject({ kind: 'recorded' });
			// Act
			if (changed === 'bytes') fixture.fileSource.bytes = new Uint8Array([5, 6, 7, 8]);
			else fixture.fileSource.vmId = 'replacement-vm';
			const retried = await fixture.core.call(request, udsOptions(context));
			// Assert: neither the old byte grant nor a replaced source can inherit approval.
			expect(retried.items[0]?.status).toBe('approval_required');
			expect(await fixture.ledger.list()).toHaveLength(2);
			expect(
				fixture.execution.invocations.filter((entry) => entry.operation === 'call'),
			).toHaveLength(0);
		},
	);

	async function denyEmberRead(fixture: Awaited<ReturnType<typeof arrange>>): Promise<void> {
		const opened = await fixture.policyService.openPolicyEditor({
			agentId: 'ember',
			accountId: fixture.accountId,
			applicationId: 'gmail-app',
			identity: facadeIdentity,
		});
		if (opened.kind !== 'opened') throw new Error('Expected owner editor.');
		const services = googleAccountPolicySnapshotSchema.parse({
			...opened.view.snapshot,
			services: {
				...opened.view.snapshot.services,
				gmail: { read: { kind: 'explicit', disposition: 'deny' }, write: { kind: 'inherit' } },
			},
		}).services;
		const preview = await fixture.policyService.previewPolicyChange({
			contextId: opened.contextId,
			browserBindingSecret: opened.browserBindingSecret,
			csrfToken: opened.csrfToken,
			identity: facadeIdentity,
			origin: 'https://auth.claw.askluna.xyz:18900',
			expectedConfigRevision: 'config-1',
			expectedOverrideRevision: opened.view.snapshot.overrideRevision,
			services,
		});
		if (preview.kind !== 'preview') throw new Error('Expected preview.');
		expect(
			await fixture.policyService.confirmPolicyChange({
				contextId: preview.contextId,
				browserBindingSecret: opened.browserBindingSecret,
				csrfToken: preview.csrfToken,
				identity: facadeIdentity,
				origin: 'https://auth.claw.askluna.xyz:18900',
			}),
		).toMatchObject({ kind: 'applied' });
	}

	it('allows Sun directly but requires an account-labeled durable approval for Ember on the same Google account', async () => {
		// Arrange
		const fixture = await arrange();
		const request = googleSearchCall(fixture.accountId);
		// Act
		const sun = await fixture.core.call(request, udsOptions(trustedContext('sun')));
		const ember = await fixture.core.call(request, udsOptions(trustedContext('ember')));
		// Assert
		expect(sun.items[0]?.status).toBe('ok');
		expect(ember.items[0]).toMatchObject({
			status: 'approval_required',
			approvalChallenge: {
				kind: 'managed_google',
				managedGoogleDisplay: { accountId: fixture.accountId, accountAlias: 'ember mailbox' },
			},
		});
		expect(
			fixture.execution.invocations.filter((entry) => entry.operation === 'call'),
		).toHaveLength(1);
		const [stored] = await fixture.ledger.list();
		expect(stored).toMatchObject({
			kind: 'pending',
			challenge: {
				intent: {
					managedGoogle: { binding: { accountId: fixture.accountId, overrideRevision: 1 } },
				},
			},
		});
	});

	it('consumes one human approval into one controller reservation without editing account policy', async () => {
		// Arrange
		const fixture = await arrange();
		const context = trustedContext('ember');
		if (context === undefined) throw new Error('Expected context.');
		const request = googleSearchCall(fixture.accountId);
		await fixture.core.call(request, udsOptions(context));
		const [pending] = await fixture.ledger.list();
		if (pending === undefined) throw new Error('Expected durable challenge.');
		// Act
		expect(
			await fixture.ledger.decide({
				approvalId: pending.challenge.approvalId,
				authorityContext,
				decision: 'approve',
				operator: {
					approverId: 'operator-test',
					audience: GATEWAY_RUNTIME_APPROVAL_AUDIENCE,
					provenance: 'managed-gateway',
					stablePrincipal: deriveGatewayControlStablePrincipal({ principal: context.principal }),
				},
			}),
		).toMatchObject({ kind: 'recorded' });
		const approved = await fixture.core.call(request, udsOptions(context));
		const replay = await fixture.core.call(request, udsOptions(context));
		// Assert
		expect(approved.items[0]?.status).toBe('ok');
		expect(replay.items[0]?.status).toBe('error');
		expect(
			fixture.execution.invocations.filter((entry) => entry.operation === 'call'),
		).toHaveLength(1);
		expect(await fixture.ledger.read(pending.challenge.approvalId)).toMatchObject({
			kind: 'consumed-not-dispatched',
		});
		expect(
			fixture.policyService.resolveManagedGoogleInvocation({
				agentId: 'ember',
				profileId: 'shared',
				namespaceId: 'google',
				operationName: 'gog',
				input: {
					accountId: fixture.accountId,
					argv: ['gmail', 'search', 'unread'],
					reason: 'Read inbox',
				},
			}),
		).toMatchObject({ kind: 'ready', disposition: 'ask', binding: { overrideRevision: 1 } });
	});

	it('rejects stale preflight if the owner saves Deny before approval is reserved, without affecting Sun', async () => {
		// Arrange
		const fixture = await arrange();
		fixture.hooks.afterPreflight = async () => {
			delete fixture.hooks.afterPreflight;
			await denyEmberRead(fixture);
		};
		// Act
		const result = await fixture.core.call(
			googleSearchCall(fixture.accountId),
			udsOptions(trustedContext('ember')),
		);
		// Assert
		expect(result.items[0]).toMatchObject({ status: 'error', outcome: { kind: 'not-dispatched' } });
		expect(await fixture.ledger.list()).toEqual([]);
		expect(fixture.execution.invocations).toHaveLength(0);
		expect(
			(
				await fixture.core.call(
					googleSearchCall(fixture.accountId),
					udsOptions(trustedContext('sun')),
				)
			).items[0]?.status,
		).toBe('ok');
	});

	it('retains an approved exact action across a real encrypted token-material refresh', async () => {
		// Arrange
		const fixture = await arrange(true);
		const context = trustedContext('ember');
		await fixture.core.call(googleSearchCall(fixture.accountId), udsOptions(context));
		const [pending] = await fixture.ledger.list();
		if (pending === undefined) throw new Error('Expected durable challenge.');
		const target = {
			accountId: fixture.accountId,
			applicationId: oauthApplicationIdSchema.parse('gmail-app'),
			agentId: 'ember',
		};
		const before = fixture.brokerFixture.catalog.getGrantForAccountApplication({
			...target,
			zoneId: 'test-zone',
		});
		if (before === undefined) throw new Error('Expected initial encrypted grant.');
		expect(
			await fixture.ledger.decide({
				approvalId: pending.challenge.approvalId,
				authorityContext,
				decision: 'approve',
				operator: {
					approverId: 'operator-test',
					audience: GATEWAY_RUNTIME_APPROVAL_AUDIENCE,
					provenance: 'managed-gateway',
					stablePrincipal: deriveGatewayControlStablePrincipal({ principal: context.principal }),
				},
			}),
		).toMatchObject({ kind: 'recorded' });
		// Act
		const credential = await fixture.brokerFixture.broker.resolveRuntimeCredential({
			...target,
			operationId: 'gmail.search',
			gmailWriteAllowed: false,
		});
		const reservation = await fixture.ledger.requestApproval({
			authorityContext,
			intent: pending.challenge.intent,
		});
		const after = fixture.brokerFixture.catalog.getGrantForAccountApplication({
			...target,
			zoneId: 'test-zone',
		});
		// Assert
		expect(credential.kind).toBe('ready');
		if (credential.kind === 'ready') credential.accessToken.fill(0);
		expect(fixture.refreshes.count).toBe(1);
		expect(after?.materialRevision).not.toBe(before.materialRevision);
		expect(after?.authorizationMetadataRevision).toBe(before.authorizationMetadataRevision);
		expect(reservation).toMatchObject({
			kind: 'dispatch-reserved',
			reservation: { fingerprint: pending.challenge.fingerprint },
		});
	});

	it('rejects a pending approval after an owner edits that account policy', async () => {
		// Arrange
		const fixture = await arrange();
		const context = trustedContext('ember');
		await fixture.core.call(googleSearchCall(fixture.accountId), udsOptions(context));
		const [pending] = await fixture.ledger.list();
		if (pending === undefined) throw new Error('Expected durable challenge.');
		await denyEmberRead(fixture);
		// Act
		const decision = await fixture.ledger.decide({
			approvalId: pending.challenge.approvalId,
			authorityContext,
			decision: 'approve',
			operator: {
				approverId: 'operator-test',
				audience: GATEWAY_RUNTIME_APPROVAL_AUDIENCE,
				provenance: 'managed-gateway',
				stablePrincipal: deriveGatewayControlStablePrincipal({ principal: context.principal }),
			},
		});
		// Assert
		expect(decision).toEqual({ kind: 'rejected', reason: 'stale-authority' });
		expect(fixture.execution.invocations).toHaveLength(0);
	});

	it('rejects forged account display at the Portal boundary before any approval or execution', async () => {
		// Arrange
		const fixture = await arrange();
		fixture.hooks.transformPreflight = (result) =>
			result.kind === 'ready'
				? {
						...result,
						display: {
							...result.display,
							accountId: oauthAccountIdSchema.parse('99999999-9999-4999-8999-999999999999'),
						},
					}
				: result;
		// Act
		const result = await fixture.core.call(
			googleSearchCall(fixture.accountId),
			udsOptions(trustedContext('ember')),
		);
		// Assert
		expect(result.items[0]).toMatchObject({ status: 'error', outcome: { kind: 'not-dispatched' } });
		expect(await fixture.ledger.list()).toEqual([]);
		expect(fixture.execution.invocations).toHaveLength(0);
	});
});
