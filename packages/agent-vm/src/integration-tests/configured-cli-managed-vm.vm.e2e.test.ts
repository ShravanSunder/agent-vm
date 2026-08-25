import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
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
import {
	deterministicOperationId,
	directDispatchFingerprint,
} from '@agent-vm/tool-portal/dispatch-authority';
import { describe, expect, it } from 'vitest';

import { createManagedVmRuntimeComposition } from '../composition/gondolin-managed-vm-provider.js';
import type { LoadedSystemConfig } from '../config/system-config.js';
import type {
	GatewayControlAcceptedSessionRef,
	GatewayControlTrustedCallerContext,
} from '../controller/control-session/gateway-control-caller-context.js';
import { authorizeGatewayControlControllerExecution } from '../controller/control-session/gateway-control-controller-execution-authorization.js';
import { createConfiguredCliManagedVmExecutor } from '../controller/runner/configured-cli-managed-vm-executor.js';
import { writeGatewayRuntimePortalAdmissionFile } from '../gateway/gateway-runtime-portal-admission-file.js';
import { materializeGatewayRuntimePortalAdmission } from '../gateway/gateway-runtime-portal-admission-material.js';
import { writeMcpPortalEffectiveConfig } from '../gateway/mcp-portal-effective-config.js';
import { readProcessIdentity } from '../shared/managed-vm-process.js';
import { shouldRunLiveVmE2e } from './live-vm-e2e-gates.js';
import { startManagedGatewayImageBootFixture } from './managed-gateway-image-boot-test-fixture.js';

const describeLiveConfiguredRunner = shouldRunLiveVmE2e() ? describe : describe.skip;

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

describeLiveConfiguredRunner('configured CLI one-shot Managed VM', () => {
	it('proves direct, denied, unapproved, and approved dispositions with exact VM effects', async () => {
		const imageFixture = await startManagedGatewayImageBootFixture({
			sessionLabel: 'configured-cli-runner-image-fixture',
		});
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
						agents: { main: { profile: 'default' } },
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
													executablePath: '/usr/bin/printf',
													executionTarget: {
														allowedHosts: [],
														environment: { kind: 'empty' },
														guestCwd: '/tmp',
														imageReference: './configured-cli-image.json',
														kind: 'ephemeral_managed_vm',
													},
													kind: 'configured_cli',
													mandatoryArgvPrefix: ['runner-output:%s'],
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
						},
						schemaVersion: 1,
					},
					null,
					'\t',
				)}\n`,
				'utf8',
			);
			const effectiveHostConfigDir = path.join(
				imageFixture.project.tempRoot,
				'cache',
				'gateways',
				acceptedSession.zoneId,
				'tool-portal-effective',
			);
			const effectivePlan = await writeMcpPortalEffectiveConfig({
				approvalAccessConfigured: true,
				authoredConfigDir: configDir,
				declaredAgentIds: [trustedPrincipal.agentId],
				effectiveHostConfigDir,
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
					resolveAll: async () => ({}),
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
				],
				effectivePlan,
				surfaceEligibilityByProfile: {
					default: { controller_execution: ['protected_uds'] },
				},
			});
			await writeGatewayRuntimePortalAdmissionFile({
				directoryPath: effectiveHostConfigDir,
				material: portalAdmission,
			});
			const controllerExecutionNamespace =
				effectivePlan.effectiveToolPortalConfig.profiles.default?.namespaces.controller_execution;
			if (controllerExecutionNamespace?.backend.kind !== 'controller_execution') {
				throw new Error('configured CLI VM proof namespace is absent');
			}
			const operation = controllerExecutionNamespace.backend.operations.isolated_runner_proof;
			if (operation?.kind !== 'configured_cli') {
				throw new Error('configured CLI VM proof operation is absent');
			}
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
				storageRootDir: imageFixture.project.tempRoot,
				cacheDir: path.join(imageFixture.project.tempRoot, 'cache'),
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
						agents: [{ id: trustedPrincipal.agentId }],
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
			let createdRunnerVmCount = 0;
			const execute = createConfiguredCliManagedVmExecutor({
				controllerStateDir: path.join(imageFixture.project.tempRoot, 'controller-state'),
				managedVmExactProcessTermination: managedVm.managedVmExactProcessTermination,
				managedVmFactory: {
					createManagedVm: async (request) => {
						createdRunnerVmCount += 1;
						return await managedVm.managedVmFactory.createManagedVm(request);
					},
				},
				readProcessIdentity,
				resolveGatewayIdentity: async () => ({
					controllerEpoch: 'controller-epoch-configured-runner',
					gatewayEpoch: 'gateway-epoch-configured-runner',
					parentGatewayVmId: imageFixture.vm.id,
					runtimeEpoch: 'runtime-epoch-configured-runner',
				}),
			});

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
			expect(createdRunnerVmCount).toBe(2);
		} catch (error: unknown) {
			const recordsDirectory = path.join(
				imageFixture.project.tempRoot,
				'controller-state',
				'controller-runners',
				imageFixture.vm.id,
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
			await imageFixture.close();
		}
	}, 300_000);
});
