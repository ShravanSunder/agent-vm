import { randomUUID } from 'node:crypto';

import { controllerEnforcedConfiguredCliOperationSchema } from '@agent-vm/config-contracts';
import type { GatewayRuntimeTrustedInvocationPrincipal } from '@agent-vm/gateway-control-contracts';
import {
	createGatewayControlCallerContextRegistrationClient,
	createGatewayRuntimeControlCommandClient,
	startGatewayControlEndpoint,
} from '@agent-vm/gateway-runtime';
import { describe, expect, it } from 'vitest';

import { withProtocolDeadline } from '../../integration-tests/e2e-protocol-wait.js';
import {
	createControlSessionDispatcher,
	createControlSessionFenceRegistry,
} from './control-session-dispatcher.js';
import { createGatewayControlCallerContextRegistry } from './gateway-control-caller-context.js';
import {
	createGatewayControlDomainHandler,
	resolveGatewayControlInboundStablePrincipal,
	type GatewayControlControllerExecutionOperations,
} from './gateway-control-domain-handler.js';
import { createGatewayControlProcessAdmissionCoordinator } from './gateway-control-process-admission-coordinator.js';
import {
	buildGatewayControlEndpoint,
	connectGatewayControlSession,
	createGatewayControlSessionMaterial,
} from './gateway-control-session.js';

function fixturePrincipal(agentId: string): GatewayRuntimeTrustedInvocationPrincipal {
	return {
		agentId,
		frameworkIdentity: { kind: 'hermes', profileName: agentId },
		profileAssignmentRevision: 'fixture-assignment',
		toolPortalProfileId: `fixture-${agentId}`,
	};
}

describe('configured CLI cancellation through the authenticated control connection', () => {
	it('cancels held authorization through saturated authority lanes and preserves sibling calls', async () => {
		// Arrange: actual control endpoints, signing, registration and admission; only
		// authorization latency and executor effects are substituted at their owned seam.
		const material = createGatewayControlSessionMaterial({
			agentIds: ['agent-a', 'agent-b'],
			controllerEpoch: 'cancellation-controller',
			zoneId: 'cancellation-zone',
		});
		const endpoint = await startGatewayControlEndpoint({
			identity: {
				bootId: material.bootId,
				controllerEpoch: material.controllerEpoch,
				generationId: material.generationId,
				peerId: material.peerId,
				processEpoch: material.processEpoch,
				zoneId: material.zoneId,
			},
			listen: { host: '127.0.0.1', port: 0 },
			verifierPublicKeyPem: material.verifierPublicKeyPem,
		});
		const callerContexts = createGatewayControlCallerContextRegistry({
			agentAuthorityKeys: material.agentAuthorityKeys,
			callerContextProofKey: material.callerContextProofKey,
			validateRegistration: ({ adapterEvidence }) => {
				const principal = adapterEvidence.principal;
				if (
					!['agent-a', 'agent-b'].includes(principal.agentId) ||
					principal.toolPortalProfileId !== `fixture-${principal.agentId}`
				) {
					throw new Error('Unexpected fixture principal.');
				}
			},
		});
		const operation = controllerEnforcedConfiguredCliOperationSchema.parse({
			kind: 'configured_cli',
			executablePath: '/usr/bin/printf',
			mandatoryArgvPrefix: [],
			executionTarget: { kind: 'controller_host', cwd: '/tmp', environment: { kind: 'empty' } },
			commands: [{ path: ['inspect'] }],
			deniedPatterns: [],
			calls: { withoutApproval: 'remaining_admitted' },
			stdin: { kind: 'none' },
			timeout: { kind: 'quick' },
			output: {
				modelVisibleStderr: 'none',
				overflow: 'fail',
				stderrMaxBytes: 1024,
				stdoutMaxBytes: 1024,
			},
			safeHelp: 'Cancellation wire fixture.',
		});
		const releaseAuthorization = Promise.withResolvers<void>();
		const allAuthorizing = Promise.withResolvers<void>();
		const authorizing: string[] = [];
		const executed: string[] = [];
		const actions: GatewayControlControllerExecutionOperations = {
			authorizeControllerExecution: async ({ payload }) => {
				if (payload.kind !== 'configured_cli' || payload.authority.kind !== 'without_approval')
					throw new Error('Unexpected fixture action.');
				authorizing.push(payload.invocation.callId);
				if (authorizing.length === 4) allAuthorizing.resolve();
				await releaseAuthorization.promise;
				return {
					authorized: true,
					configuredCli: {
						operation,
						evaluation: {
							authorityKind: 'without_approval',
							disposition: 'without_approval',
							targetKind: 'controller_host',
							bindingRevision: payload.authority.bindingRevision,
							fingerprint: payload.authority.fingerprint,
							operationId: payload.authority.operationId,
							operationName: payload.operationName,
						},
					},
				};
			},
			executeConfiguredCli: async ({ payload }) => {
				executed.push(payload.invocation.callId);
				return {
					exitCode: 0,
					stdout: payload.invocation.callId,
					stdoutTruncated: false,
					stderrTruncated: false,
				};
			},
			pushWorkspaceGit: async () => {
				throw new Error('Git is outside this fixture.');
			},
			runControllerHostProbe: async () => {
				throw new Error('Registered probes are outside this fixture.');
			},
		};
		const coordinator = createGatewayControlProcessAdmissionCoordinator();
		const sessionFenceRegistry = createControlSessionFenceRegistry();
		const dispatcher = createControlSessionDispatcher({ sessionFenceRegistry });
		dispatcher.register(
			'gateway_control',
			createGatewayControlDomainHandler({
				callerContexts,
				controllerExecutions: actions,
				gateway: {
					bootId: material.bootId,
					controllerEpoch: material.controllerEpoch,
					gatewayEpochId: material.generationId,
					gatewayVmId: 'fixture-vm',
					generationId: material.generationId,
					zoneId: material.zoneId,
				},
				session: {
					bootId: material.processEpoch,
					controllerEpoch: material.controllerEpoch,
					peerId: material.peerId,
					zoneId: material.zoneId,
				},
			}),
		);
		let client: Awaited<ReturnType<typeof connectGatewayControlSession>> | undefined;
		const sender = createGatewayRuntimeControlCommandClient({ controlService: endpoint.service });
		const registrations = createGatewayControlCallerContextRegistrationClient({
			agentAuthorityKeys: material.agentAuthorityKeys,
			callerContextProofKey: material.callerContextProofKey,
			controlCommandClient: sender,
			controlService: endpoint.service,
		});
		const pendingCommands: Array<ReturnType<typeof sender.sendCommand>> = [];
		try {
			client = await connectGatewayControlSession({
				dispatcher,
				endpoint: buildGatewayControlEndpoint({ host: '127.0.0.1', port: endpoint.readiness.port }),
				material,
				processAdmissionCoordinator: coordinator,
				sessionFenceRegistry,
				resolveInboundStablePrincipal: ({ envelope, message }) =>
					resolveGatewayControlInboundStablePrincipal({ callerContexts, envelope, message }),
			});
			const owner = await registrations.register({
				purpose: 'tool_portal_controller_execution',
				trustedContext: { principal: fixturePrincipal('agent-a') },
			});
			const other = await registrations.register({
				purpose: 'tool_portal_controller_execution',
				trustedContext: { principal: fixturePrincipal('agent-b') },
			});
			const acceptedSession = endpoint.service.getCurrentAcceptedSession();
			if (
				acceptedSession === undefined ||
				owner.operationCancelEvidence === undefined ||
				other.operationCancelEvidence === undefined
			)
				throw new Error('Fixture registration omitted cancellation authority.');
			const commandIds = Array.from({ length: 4 }, () => randomUUID());
			for (const [index, commandId] of commandIds.entries()) {
				const command = sender.sendCommand({
					admissionPrincipal: owner.admissionPrincipal,
					commandId,
					commandResultTimeoutMs: 5000,
					expiresAtMs: Date.now() + 30_000,
					idempotencyKey: `fixture:${commandId}`,
					message: {
						kind: 'command',
						operation: 'tool_portal_controller_execution',
						payload: {
							kind: 'configured_cli',
							callerContext: { callerContextId: owner.callerContextId },
							capability: { namespace: 'fixture', name: 'inspect' },
							operationName: 'inspect',
							correlation: { capability: { namespace: 'fixture', name: 'inspect' } },
							input: { argv: ['inspect'], reason: 'Cancellation wire proof' },
							authority: {
								kind: 'without_approval',
								bindingRevision: 'fixture-binding',
								fingerprint: `sha256:${'d'.repeat(64)}`,
								operationId: commandId,
							},
							invocation: {
								callId: `call-${String(index)}`,
								surfaceClass: 'protected_uds',
								trustedContext: { principal: fixturePrincipal('agent-a') },
							},
						},
					},
				});
				void command.catch(() => undefined);
				pendingCommands.push(command);
			}
			await withProtocolDeadline(allAuthorizing.promise, 'four held authorizations');
			const targetCommand = commandIds[0];
			if (targetCommand === undefined) throw new Error('Missing target command.');
			const cancel = async (authority: typeof owner): ReturnType<typeof sender.sendCommand> => {
				if (authority.operationCancelEvidence === undefined)
					throw new Error('Missing cancellation evidence.');
				return await sender.sendCommand({
					admissionPrincipal: authority.admissionPrincipal,
					commandResultTimeoutMs: 2000,
					requiredAcceptedSession: acceptedSession,
					message: {
						kind: 'command',
						operation: 'operation_cancel',
						payload: {
							activeOperationId: targetCommand,
							adapterEvidence: authority.operationCancelEvidence,
							initiatedBy: 'gateway',
							reason: 'caller_cancelled',
						},
					},
				});
			};
			// Act: both ordinary authority lanes are occupied; only safety admission can progress.
			const wrongOwner = await withProtocolDeadline(cancel(other), 'wrong-owner cancellation');
			expect(wrongOwner.response.payload.result).toBe('rejected');
			const cancelled = await withProtocolDeadline(
				cancel(owner),
				'owned cancellation under saturation',
			);
			expect(cancelled.response.payload.result).toBe('ok');
			expect(executed).toEqual([]);
			expect(coordinator.diagnostics().nonSafetyMessages).toBe(4);
			releaseAuthorization.resolve();
			const results = await withProtocolDeadline(
				Promise.all(pendingCommands),
				'held commands settle',
			);
			// Assert: the real domain handler fences late authorization, siblings retain results.
			expect(results[0]?.response.payload.result).toBe('cancelled');
			expect(results.slice(1).map((result) => result.response.payload.result)).toEqual([
				'ok',
				'ok',
				'ok',
			]);
			expect(executed.toSorted()).toEqual(['call-1', 'call-2', 'call-3']);
		} finally {
			releaseAuthorization.resolve();
			await Promise.allSettled(pendingCommands);
			await registrations.close();
			client?.close();
			await endpoint.close();
		}
	});
});
