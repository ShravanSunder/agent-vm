import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import http, { type Server } from 'node:http';
import path from 'node:path';

import { decodeConfiguredCliPreparedImageIdentity } from '@agent-vm/config-contracts';
import {
	deriveGatewayControlControllerExecutionRpcWindow,
	deriveGatewayControlStablePrincipal,
	deriveGatewayRuntimeApprovalFingerprint,
	deriveGatewayRuntimeApprovalId,
	type GatewayControlToolPortalControllerExecutionPayload,
	type GatewayRuntimeApprovalChallengeIntent,
	type GatewayRuntimeControllerExecutionDispatchReservation,
	type GatewayRuntimePortalSemanticSnapshot,
} from '@agent-vm/gateway-control-contracts';
import type { ManagedVmCreateRequest } from '@agent-vm/managed-vm';
import { createSecretResolver, type SecretResolver } from '@agent-vm/secret-management';
import {
	deterministicOperationId,
	directDispatchFingerprint,
} from '@agent-vm/tool-portal/dispatch-authority';
import { describe, expect, it } from 'vitest';

import { createManagedVmRuntimeComposition } from '../composition/gondolin-managed-vm-provider.js';
import {
	deploymentGeneratedDirForStorageRoot,
	sharedImageCacheDirForSystemConfig,
	type LoadedSystemConfig,
} from '../config/system-config.js';
import type {
	GatewayControlAcceptedSessionRef,
	GatewayControlTrustedCallerContext,
} from '../controller/control-session/gateway-control-caller-context.js';
import { authorizeGatewayControlControllerExecution } from '../controller/control-session/gateway-control-controller-execution-authorization.js';
import { createCredentialedRuntimeManager } from '../controller/credentialed-runtime/credentialed-runtime-manager.js';
import { createControllerCredentialedRuntimeRegistryPublisher } from '../controller/credentialed-runtime/credentialed-runtime-registry.js';
import type { CredentialedRuntimeResolution } from '../controller/credentialed-runtime/credentialed-runtime-registry.js';
import { createConfiguredCliManagedVmExecutor } from '../controller/runner/configured-cli-managed-vm-executor.js';
import { writeGatewayRuntimePortalAdmissionFile } from '../gateway/gateway-runtime-portal-admission-file.js';
import { materializeGatewayRuntimePortalAdmission } from '../gateway/gateway-runtime-portal-admission-material.js';
import { writeMcpPortalEffectiveConfig } from '../gateway/mcp-portal-effective-config.js';
import { readProcessIdentity } from '../shared/managed-vm-process.js';
import { waitForProtocolRetryInterval, withProtocolDeadline } from './e2e-protocol-wait.js';
import { shouldRunLiveVmE2e } from './live-vm-e2e-gates.js';
import { startManagedGatewayImageBootFixture } from './managed-gateway-image-boot-test-fixture.js';

const describeLiveConfiguredRunner = shouldRunLiveVmE2e() ? describe : describe.skip;
const mediatedCredentialHost = 'credentialed-mediation.vm.host';
const untrustedCredentialHost = 'credentialed-untrusted.vm.host';
const mediatedCredentialValue = 'credentialed-runtime-http-secret';

const acceptedSession = {
	bootId: 'configured-cli-vm-boot',
	controllerEpoch: 'configured-cli-vm-controller',
	peerId: 'configured-cli-vm-peer',
	zoneId: 'configured-cli-vm-zone',
} satisfies GatewayControlAcceptedSessionRef;

const trustedPrincipal = {
	agentId: 'main',
	frameworkIdentity: { kind: 'hermes', profileName: 'researcher' },
	profileAssignmentRevision: 'configured-cli-vm-assignment',
	toolPortalProfileId: 'default',
} as const;

const trustedCallerContext = {
	agentId: trustedPrincipal.agentId,
	bootId: acceptedSession.bootId,
	callerContextId: '11111111-1111-4111-8111-111111111111',
	connectionId: '22222222-2222-4222-8222-222222222222',
	controllerEpoch: acceptedSession.controllerEpoch,
	peerId: acceptedSession.peerId,
	principal: trustedPrincipal,
	purpose: 'tool_portal_controller_execution',
	sessionId: '33333333-3333-4333-8333-333333333333',
	stablePrincipal: deriveGatewayControlStablePrincipal({ principal: trustedPrincipal }),
	zoneId: acceptedSession.zoneId,
} satisfies GatewayControlTrustedCallerContext;

const approvalAuthorityContext = {
	controllerEpoch: acceptedSession.controllerEpoch,
	frameworkEpoch: 'configured-cli-vm-framework',
	gatewayEpoch: 'configured-cli-vm-gateway',
	runtimeEpoch: 'configured-cli-vm-runtime',
	zoneId: acceptedSession.zoneId,
} as const;

const configuredCliProofScript = [
	'set -eu;',
	'case "${2-}" in',
	'  --write-state) printf retained > /tmp/credential-runtime-marker; printf state-written ;;',
	'  --read-state) if [ -f /tmp/credential-runtime-marker ]; then cat /tmp/credential-runtime-marker; else printf absent; fi ;;',
	'  --credential-proof) test "$PROOF_CREDENTIAL_ROOT" = /run/agent-vm/credentials; test -s "$PROOF_CREDENTIAL_FILE"; mode=$(stat -c %a "$PROOF_CREDENTIAL_FILE"); test "$mode" = 600; if printf forbidden > "$PROOF_CREDENTIAL_FILE" 2>/dev/null; then exit 91; fi; credential=$(cat "$PROOF_CREDENTIAL_FILE"); if grep -R -F -l -- "$credential" /tmp /root /home 2>/dev/null | grep -q .; then exit 92; fi; printf credential-read-only ;;',
	'  --host-isolation) test ! -e "$3"; printf host-isolated ;;',
	'  --http-mediated) printf "env:%s\\n" "$PROOF_HTTP_TOKEN"; curl -sS -H "Authorization: Bearer $PROOF_HTTP_TOKEN" "$3" ;;',
	'  --http-untrusted) curl -sS -H "Authorization: Bearer $PROOF_HTTP_TOKEN" "$3" ;;',
	'  --oauth-mediated) printf "env:%s\\n" "$GOG_ACCESS_TOKEN"; curl -sS -H "Authorization: Bearer $GOG_ACCESS_TOKEN" "$3" ;;',
	'  --oauth-untrusted) curl -sS -H "Authorization: Bearer $GOG_ACCESS_TOKEN" "$3" ;;',
	'  --hold) printf started; sleep 30 ;;',
	'  *) printf "runner-output:%s" "$1"; [ "$#" -lt 2 ] || printf "runner-output:%s" "$2" ;;',
	'esac',
].join(' ');

async function startCredentialedMediationServer(): Promise<{
	readonly port: number;
	readonly server: Server;
}> {
	const server = http.createServer((request, response) => {
		response.end(
			request.headers.authorization === `Bearer ${mediatedCredentialValue}`
				? 'substituted'
				: 'not-substituted',
		);
	});
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			server.off('error', reject);
			resolve();
		});
	});
	const address = server.address();
	if (address === null || typeof address === 'string') {
		throw new Error('Credentialed mediation server did not expose a TCP port.');
	}
	return { port: address.port, server };
}

async function closeCredentialedMediationServer(server: Server): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		server.close((error) => (error === undefined ? resolve() : reject(error)));
	});
}

async function readDirectoryTreeText(directoryPath: string): Promise<string> {
	const relativePaths = await readdir(directoryPath, { recursive: true }).catch(() => []);
	return (
		await Promise.all(
			relativePaths.map(
				async (relativePath) =>
					await readFile(path.join(directoryPath, relativePath), 'utf8').catch(() => ''),
			),
		)
	).join('\n');
}

function semanticRevisions(
	semanticSnapshot: GatewayRuntimePortalSemanticSnapshot,
): GatewayRuntimeApprovalChallengeIntent['semanticRevisions'] {
	return {
		activeRevision: semanticSnapshot.activeRevision,
		bindingRevision: semanticSnapshot.bindingRevision,
		catalogRevision: semanticSnapshot.catalogRevision,
		profilePolicyRevision: semanticSnapshot.profilePolicyRevision,
		providerRevision: semanticSnapshot.providerRevision,
		schemaRevision: semanticSnapshot.schemaRevision,
	};
}

describeLiveConfiguredRunner('configured CLI reusable credentialed Managed VM', () => {
	it('proves direct, denied, unapproved, and approved dispositions with one retained VM', async () => {
		const imageFixture = await startManagedGatewayImageBootFixture({
			sessionLabel: 'configured-cli-runner-image-fixture',
		});
		const mediationServer = await startCredentialedMediationServer();
		let closeCredentialedRuntime: (() => Promise<void>) | undefined;
		try {
			const configDir = path.join(imageFixture.project.tempRoot, 'configured-cli-policy');
			await mkdir(configDir, { recursive: true });
			await writeFile(
				path.join(configDir, 'mcp.config.jsonc'),
				`${JSON.stringify({ providers: {}, schemaVersion: 1 }, null, '\t')}\n`,
				'utf8',
			);
			await writeFile(
				path.join(configDir, 'tool-portal.config.jsonc'),
				`${JSON.stringify(
					{
						agents: {
							main: {
								credentialBindings: {
									proof: {
										files: {
											input: {
												ref: 'op://agent-vm-testing/smoke-test-item1/ref1',
												source: '1password',
											},
										},
									},
								},
								profile: 'default',
							},
							secondary: {
								credentialBindings: {
									proof: {
										files: {
											input: {
												ref: 'op://agent-vm-testing/smoke-test-item1/ref1',
												source: '1password',
											},
										},
									},
								},
								profile: 'default',
							},
							mediated: { profile: 'mediated' },
						},
						mode: 'managed',
						profiles: {
							default: {
								namespaces: {
									controller_execution: {
										backend: {
											kind: 'controller_execution',
											operations: {
												isolated_runner_proof: {
													calls: {
														deny: [
															{
																flags: [{ names: ['--deny'] }],
																path: ['isolated'],
															},
														],
														requiresApproval: [
															{
																flags: [{ names: ['--approve'] }],
																path: ['isolated'],
															},
														],
														withoutApproval: 'remaining_admitted',
													},
													commands: [{ path: ['isolated'] }],
													deniedPatterns: [],
													executablePath: '/bin/sh',
													executionTarget: {
														allowedHosts: [],
														credentialProjection: {
															credentialBinding: 'proof',
															credentialEnvironment: {
																PROOF_CREDENTIAL_FILE: {
																	kind: 'credential_file',
																	source: 'input',
																},
																PROOF_CREDENTIAL_ROOT: { kind: 'credential_root' },
															},
															credentialFiles: [{ path: 'input.txt', source: 'input' }],
															kind: 'file_binding',
														},
														environment: { kind: 'empty' },
														guestCwd: '/tmp',
														imageReference: './configured-cli-image.json',
														kind: 'ephemeral_managed_vm',
													},
													kind: 'configured_cli',
													mandatoryArgvPrefix: ['-c', configuredCliProofScript, 'proof-command'],
													output: {
														modelVisibleStderr: 'none',
														overflow: 'fail',
														stderrMaxBytes: 4096,
														stdoutMaxBytes: 4096,
													},
													safeHelp: 'Run the isolated Managed VM proof.',
													stdin: { kind: 'none' },
													timeout: { kind: 'open' },
												},
											},
										},
										calls: {
											requiresApproval: { allow: [] },
											withoutApproval: { allow: ['isolated_runner_proof'] },
										},
										tools: { allow: ['isolated_runner_proof'] },
									},
								},
							},
							mediated: {
								namespaces: {
									controller_execution: {
										backend: {
											kind: 'controller_execution',
											operations: {
												mediated_runner_proof: {
													calls: {
														deny: [],
														requiresApproval: [],
														withoutApproval: 'remaining_admitted',
													},
													commands: [{ path: ['mediated'] }],
													deniedPatterns: [],
													executablePath: '/bin/sh',
													executionTarget: {
														allowedHosts: [
															mediatedCredentialHost,
															untrustedCredentialHost,
															'127.0.0.1',
														],
														credentialProjection: {
															environment: {
																PROOF_HTTP_TOKEN: {
																	hosts: [mediatedCredentialHost, '127.0.0.1'],
																	secret: {
																		name: 'AGENT_VM_CREDENTIALED_RUNTIME_E2E_TOKEN',
																		source: 'environment',
																	},
																},
															},
															kind: 'http_mediation',
														},
														environment: { kind: 'empty' },
														guestCwd: '/tmp',
														imageReference: './configured-cli-image.json',
														kind: 'ephemeral_managed_vm',
													},
													kind: 'configured_cli',
													mandatoryArgvPrefix: ['-c', configuredCliProofScript, 'proof-command'],
													output: {
														modelVisibleStderr: 'none',
														overflow: 'fail',
														stderrMaxBytes: 4096,
														stdoutMaxBytes: 4096,
													},
													safeHelp: 'Prove credentialed HTTP mediation.',
													stdin: { kind: 'none' },
													timeout: { kind: 'open' },
												},
											},
										},
										calls: {
											requiresApproval: { allow: [] },
											withoutApproval: { allow: ['mediated_runner_proof'] },
										},
										tools: { allow: ['mediated_runner_proof'] },
									},
								},
							},
						},
						schemaVersion: 1,
					},
					null,
					'\t',
				)}\n`,
				'utf8',
			);
			const effectiveHostConfigDir = path.join(
				deploymentGeneratedDirForStorageRoot(imageFixture.project.systemConfig.storageRootDir),
				'gateway-effective',
				acceptedSession.zoneId,
			);
			const effectivePlan = await writeMcpPortalEffectiveConfig({
				approvalAccessConfigured: true,
				authoredConfigDir: configDir,
				declaredAgentIds: [trustedPrincipal.agentId, 'secondary', 'mediated'],
				effectiveHostConfigDir,
				sharedImageCacheDir: sharedImageCacheDirForSystemConfig(imageFixture.project.systemConfig),
				managedVmImages: {
					prepareImage: async () => ({
						built: false,
						fingerprint: imageFixture.preparedImage.fingerprint,
						imageReference: imageFixture.preparedImage.imagePath,
					}),
				},
				secretResolver: {
					resolve: async () => {
						throw new Error('configured CLI VM proof must not resolve secrets');
					},
					resolveAll: async () => ({ input: 'configured CLI VM proof credential' }),
				},
				workspaceGitPushAgentEligibility: { eligibleAgentIds: [] },
				zoneId: acceptedSession.zoneId,
			});
			const portalAdmission = materializeGatewayRuntimePortalAdmission({
				agentProjections: [
					{
						agentId: trustedPrincipal.agentId,
						frameworkIdentity: trustedPrincipal.frameworkIdentity,
						toolPortalProfileId: trustedPrincipal.toolPortalProfileId,
					},
					{
						agentId: 'secondary',
						frameworkIdentity: { kind: 'hermes', profileName: 'secondary' },
						toolPortalProfileId: trustedPrincipal.toolPortalProfileId,
					},
					{
						agentId: 'mediated',
						frameworkIdentity: { kind: 'hermes', profileName: 'mediated' },
						toolPortalProfileId: 'mediated',
					},
				],
				effectivePlan,
				surfaceEligibilityByProfile: {
					default: { controller_execution: ['protected_uds'] },
					mediated: { controller_execution: ['protected_uds'] },
				},
			});
			await writeGatewayRuntimePortalAdmissionFile({
				directoryPath: effectiveHostConfigDir,
				material: portalAdmission,
			});
			const operation = effectivePlan.credentialedRuntimeRegistrySnapshot.resolve({
				agentId: trustedPrincipal.agentId,
				cohortRevision: effectivePlan.credentialedRuntimeRegistrySnapshot.cohortRevision,
				namespaceId: 'controller_execution',
				operationName: 'isolated_runner_proof',
				profileId: trustedPrincipal.toolPortalProfileId,
			}).operation;
			const preparedTarget = decodeConfiguredCliPreparedImageIdentity(
				operation.executionTarget.kind === 'ephemeral_managed_vm'
					? operation.executionTarget.imageReference
					: '',
			);
			expect(preparedTarget).toEqual({
				fingerprint: imageFixture.preparedImage.fingerprint,
				imageReference: imageFixture.preparedImage.imagePath,
				schemaVersion: 1,
			});

			const systemConfig = {
				storageRootDir: imageFixture.project.systemConfig.storageRootDir,
				cacheDir: imageFixture.project.systemConfig.cacheDir,
				controllerStateDir: path.join(imageFixture.project.tempRoot, 'controller-state'),
				controllerRuntimeDir: path.join(imageFixture.project.tempRoot, 'controller-runtime'),
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
				host: { controllerPort: 18_800, projectNamespace: 'configured-cli-vm-proof' },
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
				systemConfigPath: path.join(imageFixture.project.tempRoot, 'config', 'system.jsonc'),
				tcpPool: { basePort: 19_000, size: 5 },
				toolVmProfiles: {},
				zones: [
					{
						agents: [{ id: trustedPrincipal.agentId }, { id: 'secondary' }, { id: 'mediated' }],
						approvalAccess: {
							approvers: [{ approverId: 'hermes-native', kind: 'managed_gateway' }],
							audience: 'agent-vm-controller-approval',
						},
						egressHosts: [],
						gateway: {
							config: path.join(imageFixture.project.tempRoot, 'config', 'hermes.yaml'),
							cpus: 2,
							imageProfile: 'hermes',
							memory: '2G',
							port: 18_791,
							profileSecretProjectionsByAgent: { main: {} },
							profilesByAgent: { main: 'researcher' },
							stateDir: path.join(imageFixture.project.tempRoot, 'gateway-state'),
							type: 'hermes',
							zoneFilesDir: path.join(imageFixture.project.tempRoot, 'zone-files'),
							zoneRuntimeDir: path.join(imageFixture.project.tempRoot, 'gateway-runtime'),
						},
						id: acceptedSession.zoneId,
						secrets: {},
						toolPortal: {
							configDir,
							surfaceEligibilityByProfile: {
								default: { controller_execution: ['protected_uds'] },
							},
						},
					},
				],
			} satisfies LoadedSystemConfig;

			const managedVm = createManagedVmRuntimeComposition();
			const testServiceAccountToken = process.env.AGENT_VM_TEST_OP_SERVICE_ACCOUNT_TOKEN;
			const baseCredentialSecretResolver =
				testServiceAccountToken === undefined
					? {
							resolve: async () => 'configured CLI VM proof credential',
							resolveAll: async () => ({ input: 'configured CLI VM proof credential' }),
						}
					: await createSecretResolver({ serviceAccountToken: testServiceAccountToken });
			let credentialResolveAllCount = 0;
			let lastResolvedCredential = '';
			const credentialSecretResolver = {
				resolve: async (secretRef) => await baseCredentialSecretResolver.resolve(secretRef),
				resolveAll: async (secretRefs) => {
					credentialResolveAllCount += 1;
					if ('PROOF_HTTP_TOKEN' in secretRefs) {
						return { PROOF_HTTP_TOKEN: mediatedCredentialValue };
					}
					const resolved = await baseCredentialSecretResolver.resolveAll(secretRefs);
					lastResolvedCredential = resolved.input ?? '';
					return resolved;
				},
			} satisfies SecretResolver;
			let createdRunnerVmCount = 0;
			const managedVmFactory = {
				createManagedVm: async (request: ManagedVmCreateRequest) => {
					createdRunnerVmCount += 1;
					return await managedVm.managedVmFactory.createManagedVm({
						...request,
						mediation: {
							onRequest: async (httpRequest) => {
								const url = new URL(httpRequest.url);
								if (url.hostname === untrustedCredentialHost) {
									return new Response(
										httpRequest.headers.get('authorization') === `Bearer ${mediatedCredentialValue}`
											? 'unexpected-substitution'
											: 'not-substituted',
									);
								}
								if (url.hostname !== mediatedCredentialHost) return undefined;
								url.hostname = '127.0.0.1';
								url.port = String(mediationServer.port);
								return new Request(url, {
									headers: httpRequest.headers,
									method: httpRequest.method,
								});
							},
						},
						tcpHosts: [
							{
								guestHost: `127.0.0.1:${String(mediationServer.port)}`,
								target: `127.0.0.1:${String(mediationServer.port)}`,
							},
						],
					});
				},
			};
			const runtimeManager = createCredentialedRuntimeManager({
				controllerStateDir: path.join(imageFixture.project.tempRoot, 'controller-state'),
				exactProcessTermination: managedVm.managedVmExactProcessTermination,
				managedVmFactory,
				readProcessIdentity,
				secretResolver: credentialSecretResolver,
			});
			closeCredentialedRuntime = async () => await runtimeManager.closeZone(acceptedSession.zoneId);
			const execute = createConfiguredCliManagedVmExecutor({
				resolveGatewayIdentity: async () => ({
					controllerEpoch: 'controller-epoch-configured-runner',
					gatewayEpoch: 'gateway-epoch-configured-runner',
					parentGatewayVmId: imageFixture.vm.id,
					runtimeEpoch: 'runtime-epoch-configured-runner',
				}),
				runtimeManager,
			});
			const credentialedRuntimeRegistryPublisher =
				createControllerCredentialedRuntimeRegistryPublisher();
			credentialedRuntimeRegistryPublisher.activate(
				effectivePlan.credentialedRuntimeRegistrySnapshot,
			);

			const runInvocation = async (props: {
				readonly authority: Extract<
					GatewayControlToolPortalControllerExecutionPayload,
					{ readonly kind: 'configured_cli' }
				>['authority'];
				readonly callId: string;
				readonly input: {
					readonly argv: string[];
					readonly reason: string;
					readonly timeoutMs: number;
				};
			}): Promise<Awaited<ReturnType<typeof execute>> | undefined> => {
				const payload = {
					authority: props.authority,
					callerContext: { callerContextId: trustedCallerContext.callerContextId },
					capability: {
						name: 'isolated_runner_proof',
						namespace: 'controller_execution',
					},
					correlation: {
						capability: {
							name: 'isolated_runner_proof',
							namespace: 'controller_execution',
						},
					},
					input: props.input,
					invocation: {
						callId: props.callId,
						surfaceClass: 'protected_uds',
						trustedContext: { principal: trustedPrincipal },
					},
					kind: 'configured_cli',
					operationName: 'isolated_runner_proof',
				} as const satisfies Extract<
					GatewayControlToolPortalControllerExecutionPayload,
					{ readonly kind: 'configured_cli' }
				>;
				const authorization = await authorizeGatewayControlControllerExecution({
					callerContext: trustedCallerContext,
					credentialedRuntimeRegistryPublisher,
					createdAtMs: 1_000,
					expiresAtMs: deriveGatewayControlControllerExecutionRpcWindow({
						input: props.input,
						nowMs: 1_000,
						targetKind: 'ephemeral_managed_vm',
						timeoutKind: 'open',
					}).expiresAtMs,
					payload,
					session: acceptedSession,
					systemConfig,
				});
				if (!authorization.authorized) return undefined;
				if (authorization.configuredCli === undefined) {
					throw new Error('configured CLI VM proof authorization omitted its operation');
				}
				const configuredAuthorization = authorization.configuredCli;
				return await execute({
					authorization: configuredAuthorization,
					input: props.input,
					operation: configuredAuthorization.operation,
					operationName: payload.operationName,
					reloadAuthorization: async () => configuredAuthorization,
					stablePrincipal: trustedCallerContext.stablePrincipal,
					zoneId: acceptedSession.zoneId,
				});
			};
			const authorityFor = (props: {
				readonly approved: boolean;
				readonly callId: string;
				readonly input: {
					readonly argv: string[];
					readonly reason: string;
					readonly timeoutMs: number;
				};
			}): Extract<
				GatewayControlToolPortalControllerExecutionPayload,
				{ readonly kind: 'configured_cli' }
			>['authority'] => {
				const call = {
					arguments: props.input,
					id: props.callId,
					name: 'isolated_runner_proof',
					namespace: 'controller_execution',
				};
				const operationId = deterministicOperationId({
					callId: props.callId,
					semanticRevision: portalAdmission.semanticSnapshot.activeRevision,
					stablePrincipal: trustedCallerContext.stablePrincipal,
					surfaceClass: 'protected_uds',
				});
				if (!props.approved) {
					return {
						bindingRevision: portalAdmission.semanticSnapshot.bindingRevision,
						fingerprint: directDispatchFingerprint({
							backendKind: 'controller_execution',
							call,
							principal: trustedPrincipal,
							semanticSnapshot: portalAdmission.semanticSnapshot,
							surfaceClass: 'protected_uds',
						}),
						kind: 'without_approval',
						operationId,
					};
				}
				const intent = {
					backendKind: 'controller_execution' as const,
					call,
					operationId,
					semanticRevisions: semanticRevisions(portalAdmission.semanticSnapshot),
					surfaceClass: 'protected_uds' as const,
					trustedContext: { principal: trustedPrincipal },
				};
				const fingerprint = deriveGatewayRuntimeApprovalFingerprint({
					authorityContext: approvalAuthorityContext,
					intent,
				});
				const reservation = {
					approvalId: deriveGatewayRuntimeApprovalId(fingerprint),
					authorityContext: approvalAuthorityContext,
					backendKind: 'controller_execution',
					bindingRevision: portalAdmission.semanticSnapshot.bindingRevision,
					expiresAt: '2026-08-25T00:00:00.000Z',
					fingerprint,
					operationId,
					reservationId: '44444444-4444-4444-8444-444444444444',
					stablePrincipal: trustedCallerContext.stablePrincipal,
				} as const satisfies GatewayRuntimeControllerExecutionDispatchReservation;
				return { kind: 'controller_approval_reservation', reservation };
			};

			const directInput = {
				argv: ['isolated'],
				reason: 'real VM direct proof',
				timeoutMs: 60_000,
			};
			const deniedInput = {
				argv: ['isolated', '--deny'],
				reason: 'real VM deny proof',
				timeoutMs: 60_000,
			};
			const unapprovedInput = {
				argv: ['isolated', '--approve'],
				reason: 'real VM unapproved proof',
				timeoutMs: 60_000,
			};
			const approvedInput = {
				argv: ['isolated', '--approve'],
				reason: 'real VM approved proof',
				timeoutMs: 60_000,
			};
			const directResult = await runInvocation({
				authority: authorityFor({ approved: false, callId: 'direct-call', input: directInput }),
				callId: 'direct-call',
				input: directInput,
			});
			const deniedResult = await runInvocation({
				authority: authorityFor({ approved: false, callId: 'denied-call', input: deniedInput }),
				callId: 'denied-call',
				input: deniedInput,
			});
			const unapprovedResult = await runInvocation({
				authority: authorityFor({
					approved: false,
					callId: 'unapproved-call',
					input: unapprovedInput,
				}),
				callId: 'unapproved-call',
				input: unapprovedInput,
			});
			const approvedResult = await runInvocation({
				authority: authorityFor({ approved: true, callId: 'approved-call', input: approvedInput }),
				callId: 'approved-call',
				input: approvedInput,
			});

			expect(directResult).toEqual({
				exitCode: 0,
				stderrTruncated: false,
				stdout: 'runner-output:isolated',
				stdoutTruncated: false,
			});
			expect(deniedResult).toBeUndefined();
			expect(unapprovedResult).toBeUndefined();
			expect(approvedResult).toEqual({
				exitCode: 0,
				stderrTruncated: false,
				stdout: 'runner-output:isolatedrunner-output:--approve',
				stdoutTruncated: false,
			});
			expect(createdRunnerVmCount).toBe(1);

			const credentialProofInput = {
				argv: ['isolated', '--credential-proof'],
				reason: 'real VM credential mount proof',
				timeoutMs: 60_000,
			};
			expect(
				await runInvocation({
					authority: authorityFor({
						approved: false,
						callId: 'credential-proof-call',
						input: credentialProofInput,
					}),
					callId: 'credential-proof-call',
					input: credentialProofInput,
				}),
			).toMatchObject({ exitCode: 0, stdout: 'credential-read-only' });
			expect(credentialResolveAllCount).toBe(1);
			expect(lastResolvedCredential.length).toBeGreaterThan(0);
			const effectiveArtifactText = await readDirectoryTreeText(effectiveHostConfigDir);
			const controllerRecordText = await readDirectoryTreeText(
				path.join(imageFixture.project.tempRoot, 'controller-state'),
			);
			expect(effectiveArtifactText.includes(lastResolvedCredential)).toBe(false);
			expect(controllerRecordText.includes(lastResolvedCredential)).toBe(false);
			expect(effectiveArtifactText.includes('op://agent-vm-testing/')).toBe(false);
			expect(controllerRecordText.includes('op://agent-vm-testing/')).toBe(false);
			const controllerHostSentinelPath = path.join(
				imageFixture.project.tempRoot,
				'controller-host-only-sentinel',
			);
			await writeFile(controllerHostSentinelPath, 'host-only', 'utf8');
			const hostIsolationInput = {
				argv: ['isolated', '--host-isolation', controllerHostSentinelPath],
				reason: 'prove controller host filesystem isolation',
				timeoutMs: 60_000,
			};
			expect(
				await runInvocation({
					authority: authorityFor({
						approved: false,
						callId: 'host-isolation-call',
						input: hostIsolationInput,
					}),
					callId: 'host-isolation-call',
					input: hostIsolationInput,
				}),
			).toMatchObject({ exitCode: 0, stdout: 'host-isolated' });

			const writeStateInput = {
				argv: ['isolated', '--write-state'],
				reason: 'write reusable rootfs marker',
				timeoutMs: 60_000,
			};
			const readStateInput = {
				argv: ['isolated', '--read-state'],
				reason: 'read reusable rootfs marker',
				timeoutMs: 60_000,
			};
			expect(
				await runInvocation({
					authority: authorityFor({
						approved: false,
						callId: 'write-state-call',
						input: writeStateInput,
					}),
					callId: 'write-state-call',
					input: writeStateInput,
				}),
			).toMatchObject({ exitCode: 0, stdout: 'state-written' });
			expect(
				await runInvocation({
					authority: authorityFor({
						approved: false,
						callId: 'read-state-call',
						input: readStateInput,
					}),
					callId: 'read-state-call',
					input: readStateInput,
				}),
			).toMatchObject({ exitCode: 0, stdout: 'retained' });
			expect(createdRunnerVmCount).toBe(1);

			const secondaryResolution = effectivePlan.credentialedRuntimeRegistrySnapshot.resolve({
				agentId: 'secondary',
				cohortRevision: effectivePlan.credentialedRuntimeRegistrySnapshot.cohortRevision,
				namespaceId: 'controller_execution',
				operationName: 'isolated_runner_proof',
				profileId: trustedPrincipal.toolPortalProfileId,
			});
			const secondaryAcquisition = await runtimeManager.acquireCommand({
				finalAuthorization: async () => true,
				operationId: 'secondary-agent-operation',
				ownerIdentity: {
					controllerEpoch: 'controller-epoch-configured-runner',
					gatewayEpoch: 'gateway-epoch-configured-runner',
					parentGatewayVmId: imageFixture.vm.id,
					runtimeEpoch: 'runtime-epoch-configured-runner',
					stablePrincipal: 'secondary-agent-stable-principal',
				},
				resolution: secondaryResolution,
			});
			expect(secondaryAcquisition.kind).toBe('acquired');
			if (secondaryAcquisition.kind !== 'acquired') {
				throw new Error('Secondary agent did not acquire its independent runtime.');
			}
			try {
				expect(await secondaryAcquisition.command.exec(readStateInput)).toMatchObject({
					exitCode: 0,
					stdout: 'absent',
				});
			} finally {
				await secondaryAcquisition.command.complete({ kind: 'completed' });
			}
			expect(createdRunnerVmCount).toBe(2);
			expect(credentialResolveAllCount).toBe(2);

			const holdInput = {
				argv: ['isolated', '--hold'],
				reason: 'hold the reusable runtime active',
				timeoutMs: 60_000,
			};
			const holdPromise = runInvocation({
				authority: authorityFor({
					approved: false,
					callId: 'hold-call',
					input: holdInput,
				}),
				callId: 'hold-call',
				input: holdInput,
			});
			const recordsDirectory = path.join(
				imageFixture.project.tempRoot,
				'controller-state',
				'zones',
				acceptedSession.zoneId,
				'credentialed-runtimes',
			);
			await withProtocolDeadline(
				(async (): Promise<void> => {
					while (true) {
						// oxlint-disable-next-line no-await-in-loop -- protocol polling observes the durable active transition
						const recordNames = await readdir(recordsDirectory).catch(() => []);
						// oxlint-disable-next-line no-await-in-loop -- each poll reads the current bounded record set together
						const recordContents = await Promise.all(
							recordNames.map(
								async (recordName) =>
									await readFile(path.join(recordsDirectory, recordName), 'utf8'),
							),
						);
						if (recordContents.some((record) => record.includes('"kind":"current-active"'))) {
							return;
						}
						// oxlint-disable-next-line no-await-in-loop -- the named protocol interval bounds record polling
						await waitForProtocolRetryInterval(50);
					}
				})(),
				'credentialed runtime active record',
				5_000,
			);
			const busyInput = {
				argv: ['isolated'],
				reason: 'prove busy has no late dispatch',
				timeoutMs: 60_000,
			};
			await expect(
				runInvocation({
					authority: authorityFor({
						approved: false,
						callId: 'busy-call',
						input: busyInput,
					}),
					callId: 'busy-call',
					input: busyInput,
				}),
			).rejects.toMatchObject({ code: 'runtime_busy' });
			expect(createdRunnerVmCount).toBe(2);

			const retirement = runtimeManager.retire({
				agentId: trustedPrincipal.agentId,
				force: true,
				zoneId: acceptedSession.zoneId,
			});
			await expect(holdPromise).rejects.toBeDefined();
			await expect(retirement).resolves.toEqual({ kind: 'retired' });

			expect(
				await runInvocation({
					authority: authorityFor({
						approved: false,
						callId: 'post-retirement-read-call',
						input: readStateInput,
					}),
					callId: 'post-retirement-read-call',
					input: readStateInput,
				}),
			).toMatchObject({ exitCode: 0, stdout: 'absent' });
			expect(createdRunnerVmCount).toBe(3);
			expect(credentialResolveAllCount).toBe(3);

			const mediatedResolution = effectivePlan.credentialedRuntimeRegistrySnapshot.resolve({
				agentId: 'mediated',
				cohortRevision: effectivePlan.credentialedRuntimeRegistrySnapshot.cohortRevision,
				namespaceId: 'controller_execution',
				operationName: 'mediated_runner_proof',
				profileId: 'mediated',
			});
			const mediatedAcquisition = await runtimeManager.acquireCommand({
				finalAuthorization: async () => true,
				operationId: 'mediated-agent-operation',
				ownerIdentity: {
					controllerEpoch: 'controller-epoch-configured-runner',
					gatewayEpoch: 'gateway-epoch-configured-runner',
					parentGatewayVmId: imageFixture.vm.id,
					runtimeEpoch: 'runtime-epoch-configured-runner',
					stablePrincipal: 'mediated-agent-stable-principal',
				},
				resolution: mediatedResolution,
			});
			if (mediatedAcquisition.kind !== 'acquired') {
				throw new Error('Mediated agent did not acquire its credentialed runtime.');
			}
			try {
				const allowedResult = await mediatedAcquisition.command.exec({
					argv: ['mediated', '--http-mediated', `http://${mediatedCredentialHost}/proof`],
					reason: 'prove credentialed HTTP substitution',
					timeoutMs: 60_000,
				});
				expect(allowedResult.stdout).toMatch(/^env:GONDOLIN_SECRET_[0-9a-f]{48}\nsubstituted$/u);
				const untrustedResult = await mediatedAcquisition.command.exec({
					argv: ['mediated', '--http-untrusted', `http://${untrustedCredentialHost}/proof`],
					reason: 'prove credentialed HTTP host isolation',
					timeoutMs: 60_000,
				});
				expect(untrustedResult.stdout).toBe('not-substituted');
			} finally {
				await mediatedAcquisition.command.complete({ kind: 'completed' });
			}

			const oauthOperation = structuredClone(mediatedResolution.operation);
			if (oauthOperation.executionTarget.kind !== 'ephemeral_managed_vm') {
				throw new Error('OAuth VM proof requires a Managed VM operation.');
			}
			oauthOperation.executionTarget.allowedHosts = [
				mediatedCredentialHost,
				'127.0.0.1',
				untrustedCredentialHost,
			];
			oauthOperation.executionTarget.credentialProjection = {
				environment: { GOG_ACCESS_TOKEN: { kind: 'oauth_access_token' } },
				kind: 'http_mediation',
			};
			const oauthResolution = {
				...mediatedResolution,
				agentId: 'oauth-agent',
				agentRuntimeRevision: 'sha256:oauth-real-vm-proof',
				operation: oauthOperation,
				operationName: 'oauth_mediated_runner_proof',
				profileId: 'oauth',
				projection: {
					environmentName: 'GOG_ACCESS_TOKEN',
					kind: 'oauth_http_mediation',
				},
			} satisfies CredentialedRuntimeResolution;
			const oauthAccessTokenBytes = new TextEncoder().encode(mediatedCredentialValue);
			const oauthAcquisition = await runtimeManager.acquireCommand({
				finalAuthorization: async () => true,
				materializeResolution: async () => ({
					dynamicHttpMediation: {
						allowedHosts: [mediatedCredentialHost, '127.0.0.1'],
						credentialId: 'oauth-credential-real-vm-proof',
						environmentName: 'GOG_ACCESS_TOKEN',
						kind: 'dynamic_http_mediation',
						materialRevision: 'sha256:oauth-real-vm-material',
						placeholderValue: `GONDOLIN_SECRET_${'a'.repeat(48)}`,
						secretValue: oauthAccessTokenBytes,
					},
					resolution: oauthResolution,
				}),
				operationId: 'oauth-real-vm-operation',
				ownerIdentity: {
					controllerEpoch: 'controller-epoch-configured-runner',
					gatewayEpoch: 'gateway-epoch-configured-runner',
					parentGatewayVmId: imageFixture.vm.id,
					runtimeEpoch: 'runtime-epoch-configured-runner',
					stablePrincipal: 'oauth-agent-stable-principal',
				},
				runtimeIdentity: { agentId: 'oauth-agent', zoneId: acceptedSession.zoneId },
			});
			if (oauthAcquisition.kind !== 'acquired') {
				throw new Error('OAuth agent did not acquire its credentialed runtime.');
			}
			try {
				const allowedResult = await oauthAcquisition.command.exec({
					argv: ['mediated', '--oauth-mediated', `http://${mediatedCredentialHost}/proof`],
					reason: 'prove OAuth access-token mediation',
					timeoutMs: 60_000,
				});
				expect(allowedResult.stdout).toMatch(/^env:GONDOLIN_SECRET_[0-9a-f]{48}\nsubstituted$/u);
				const untrustedResult = await oauthAcquisition.command.exec({
					argv: ['mediated', '--oauth-untrusted', `http://${untrustedCredentialHost}/proof`],
					reason: 'prove OAuth access-token host isolation',
					timeoutMs: 60_000,
				});
				expect(untrustedResult.stdout).toBe('not-substituted');
			} finally {
				await oauthAcquisition.command.complete({ kind: 'completed' });
			}
			expect(oauthAccessTokenBytes.every((byte) => byte === 0)).toBe(true);
			const oauthControllerStateText = await readDirectoryTreeText(
				path.join(imageFixture.project.tempRoot, 'controller-state'),
			);
			expect(oauthControllerStateText).not.toContain(mediatedCredentialValue);
		} catch (error: unknown) {
			const recordsDirectory = path.join(
				imageFixture.project.tempRoot,
				'controller-state',
				'zones',
				acceptedSession.zoneId,
				'credentialed-runtimes',
			);
			const recordNames = await readdir(recordsDirectory).catch(() => []);
			const recordContents = await Promise.all(
				recordNames.map(async (recordName) => ({
					record: await readFile(path.join(recordsDirectory, recordName), 'utf8'),
					recordName,
				})),
			);
			throw new Error(
				`Configured runner failed with operation records: ${JSON.stringify(recordContents)}`,
				{ cause: error },
			);
		} finally {
			await closeCredentialedRuntime?.();
			await closeCredentialedMediationServer(mediationServer.server);
			await imageFixture.close();
		}
	});
});
