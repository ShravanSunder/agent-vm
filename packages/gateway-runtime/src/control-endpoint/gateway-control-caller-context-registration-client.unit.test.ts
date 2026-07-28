import { createHash, createHmac } from 'node:crypto';

import {
	buildGatewayControlCallerContextAgentAuthorityPayload,
	buildGatewayControlCallerContextProofPayload,
	type GatewayRuntimeTrustedInvocationContext,
} from '@agent-vm/gateway-control-contracts';
import { describe, expect, it, vi } from 'vitest';

import {
	createGatewayControlCallerContextRegistrationClient,
	type GatewayControlCallerContextRegistrationRequest,
} from './gateway-control-caller-context-registration-client.js';
import type {
	GatewayRuntimeControlCommandClient,
	GatewayRuntimeControlCommandRequest,
} from './gateway-control-command-client.js';
import type {
	GatewayControlAcceptedSession,
	GatewayControlAcceptedSessionObserver,
	GatewayControlService,
} from './gateway-control-endpoint-contracts.js';

const callerContextProofKey = 'caller-context-proof-key';
const agentAuthorityKey = 'agent-a-authority-key';
const callerContextId = '11111111-1111-4111-8111-111111111111';
const messageId = '22222222-2222-4222-8222-222222222222';
const admissionPrincipal = 'a'.repeat(64);

const sessionA = Object.freeze({
	attachmentGeneration: 1,
	bootId: 'boot-a',
	connectionId: '33333333-3333-4333-8333-333333333333',
	controllerEpoch: 'controller-a',
	gatewayEpoch: 'gateway-a',
	generationId: 'generation-a',
	peerId: 'gateway-zone-a',
	processEpoch: 'process-a',
	sessionId: '44444444-4444-4444-8444-444444444444',
	zoneId: 'zone-a',
}) satisfies GatewayControlAcceptedSession;

const sessionB = Object.freeze({
	...sessionA,
	connectionId: '55555555-5555-4555-8555-555555555555',
	sessionId: '66666666-6666-4666-8666-666666666666',
}) satisfies GatewayControlAcceptedSession;

const trustedContext = {
	correlation: { runId: 'run-a', sessionId: 'framework-session-a', toolCallId: 'tool-call-a' },
	principal: {
		agentId: 'agent-a',
		frameworkIdentity: { agentId: 'agent-a', kind: 'openclaw' },
		profileAssignmentRevision: 'profile-assignment-a',
		toolPortalProfileId: 'code-builder',
	},
	requester: { authenticatedSubjectId: 'openclaw:agent-a' },
} as const satisfies GatewayRuntimeTrustedInvocationContext;

const registrationRequest = {
	purpose: 'tool_vm_lease',
	trustedContext,
} as const satisfies GatewayControlCallerContextRegistrationRequest;

interface ControlServiceFixture {
	readonly service: Pick<
		GatewayControlService,
		'getCurrentAcceptedSession' | 'observeAcceptedSessions'
	>;
	getObserverCount(): number;
	setSession(session: GatewayControlAcceptedSession | undefined): void;
}

const defaultAcceptedSession = Symbol('default-accepted-session');

function createControlServiceFixture(
	initialSession:
		| GatewayControlAcceptedSession
		| null
		| undefined
		| typeof defaultAcceptedSession = defaultAcceptedSession,
): ControlServiceFixture {
	let currentSession =
		initialSession === defaultAcceptedSession ? sessionA : (initialSession ?? undefined);
	const observers = new Set<GatewayControlAcceptedSessionObserver>();
	return {
		getObserverCount: () => observers.size,
		service: {
			getCurrentAcceptedSession: () => currentSession,
			observeAcceptedSessions: (observer) => {
				observers.add(observer);
				return { unsubscribe: () => observers.delete(observer) };
			},
		},
		setSession: (session) => {
			currentSession = session;
			const acceptedSession = session;
			if (acceptedSession !== undefined) {
				for (const observer of observers) observer(acceptedSession);
			}
		},
	};
}

function successfulCommandResponse(
	acceptedSession: GatewayControlAcceptedSession,
	responseMessageId = messageId,
): Awaited<ReturnType<GatewayRuntimeControlCommandClient['sendCommand']>> {
	return {
		acceptedSession,
		messageId: responseMessageId,
		response: {
			kind: 'command_result',
			operation: 'caller_context_register',
			payload: {
				callerContext: { admissionPrincipal, callerContextId },
				responseToMessageId: responseMessageId,
				result: 'ok',
			},
		},
	};
}

function failedCommandResponse(
	acceptedSession: GatewayControlAcceptedSession,
): Awaited<ReturnType<GatewayRuntimeControlCommandClient['sendCommand']>> {
	return {
		acceptedSession,
		messageId,
		response: {
			kind: 'command_result',
			operation: 'caller_context_register',
			payload: {
				error: {
					errorClass: 'caller_context_registration_failed',
					retryable: true,
					safeMessage: 'registration response failed',
				},
				responseToMessageId: messageId,
				result: 'failed',
			},
		},
	};
}

function createClient(options: {
	readonly controlService: ControlServiceFixture;
	readonly sendCommand: GatewayRuntimeControlCommandClient['sendCommand'];
}): ReturnType<typeof createGatewayControlCallerContextRegistrationClient> {
	return createGatewayControlCallerContextRegistrationClient({
		agentAuthorityKeys: { 'agent-a': agentAuthorityKey },
		callerContextProofKey,
		controlCommandClient: { sendCommand: options.sendCommand },
		controlService: options.controlService.service,
	});
}

describe('Gateway control caller-context registration client', () => {
	it('signs immutable caller evidence and registers it without a prior admission principal', async () => {
		// Arrange
		const controlService = createControlServiceFixture();
		let capturedRequest: GatewayRuntimeControlCommandRequest | undefined;
		const sendCommand = vi.fn<GatewayRuntimeControlCommandClient['sendCommand']>(
			async (request) => {
				capturedRequest = request;
				return successfulCommandResponse(sessionA);
			},
		);
		const client = createClient({ controlService, sendCommand });

		// Act
		const registered = await client.register(registrationRequest);

		// Assert
		expect(registered).toEqual({ admissionPrincipal, callerContextId });
		expect(sendCommand).toHaveBeenCalledTimes(1);
		if (capturedRequest === undefined) throw new Error('Expected registration command.');
		expect(capturedRequest).not.toHaveProperty('admissionPrincipal');
		expect(capturedRequest.message).toMatchObject({
			kind: 'command',
			operation: 'caller_context_register',
			payload: {
				adapterEvidence: {
					principal: trustedContext.principal,
					purpose: registrationRequest.purpose,
					zoneId: sessionA.zoneId,
				},
				correlation: { runId: 'run-a', toolCallId: 'tool-call-a' },
			},
		});
		if (capturedRequest.message.operation !== 'caller_context_register') {
			throw new Error('Expected caller-context registration operation.');
		}
		const evidence = capturedRequest.message.payload.adapterEvidence;
		expect(evidence).not.toHaveProperty('agentWorkspaceDir');
		expect(evidence).not.toHaveProperty('workMountDir');
		expect(capturedRequest.idempotencyKey).toBe(
			`caller-context:${createHash('sha256')
				.update(buildGatewayControlCallerContextProofPayload(evidence), 'utf8')
				.digest('hex')}`,
		);
		expect(evidence.proof.digest).toBe(
			createHmac('sha256', callerContextProofKey)
				.update(buildGatewayControlCallerContextProofPayload(evidence), 'utf8')
				.digest('base64url'),
		);
		expect(evidence.agentAuthority.digest).toBe(
			createHmac('sha256', agentAuthorityKey)
				.update(buildGatewayControlCallerContextAgentAuthorityPayload(evidence), 'utf8')
				.digest('base64url'),
		);
		await client.close();
	});

	it('collapses only concurrent identical registrations within the exact session', async () => {
		// Arrange
		const controlService = createControlServiceFixture();
		let resolveCommand: ((value: ReturnType<typeof successfulCommandResponse>) => void) | undefined;
		const commandResult = new Promise<ReturnType<typeof successfulCommandResponse>>((resolve) => {
			resolveCommand = resolve;
		});
		const sendCommand = vi
			.fn<GatewayRuntimeControlCommandClient['sendCommand']>()
			.mockImplementationOnce(async () => await commandResult)
			.mockResolvedValueOnce(successfulCommandResponse(sessionA))
			.mockResolvedValueOnce(successfulCommandResponse(sessionB));
		const client = createClient({ controlService, sendCommand });

		// Act
		const first = client.register(registrationRequest);
		const second = client.register(registrationRequest);
		resolveCommand?.(successfulCommandResponse(sessionA));

		// Assert
		expect(await first).toEqual(await second);
		expect(await client.register(registrationRequest)).toEqual({
			admissionPrincipal,
			callerContextId,
		});
		expect(sendCommand).toHaveBeenCalledTimes(2);

		// Act
		controlService.setSession(sessionB);
		await client.register(registrationRequest);

		// Assert
		expect(sendCommand).toHaveBeenCalledTimes(3);
		await client.close();
	});

	it('fences an in-flight registration when the accepted session is replaced', async () => {
		// Arrange
		const controlService = createControlServiceFixture();
		let resolveCommand: ((value: ReturnType<typeof successfulCommandResponse>) => void) | undefined;
		const commandResult = new Promise<ReturnType<typeof successfulCommandResponse>>((resolve) => {
			resolveCommand = resolve;
		});
		const sendCommand = vi
			.fn<GatewayRuntimeControlCommandClient['sendCommand']>()
			.mockImplementationOnce(async () => await commandResult)
			.mockResolvedValueOnce(successfulCommandResponse(sessionB));
		const client = createClient({ controlService, sendCommand });

		// Act
		const registration = client.register(registrationRequest);
		controlService.setSession(sessionB);
		resolveCommand?.(successfulCommandResponse(sessionA));

		// Assert
		await expect(registration).rejects.toThrow('control session changed');
		expect(await client.register(registrationRequest)).toEqual({
			admissionPrincipal,
			callerContextId,
		});
		expect(sendCommand).toHaveBeenCalledTimes(2);
		await client.close();
	});

	it('fails closed when the command binds to a different accepted session', async () => {
		// Arrange
		const controlService = createControlServiceFixture();
		const client = createClient({
			controlService,
			sendCommand: async () => successfulCommandResponse(sessionB),
		});

		// Act / Assert
		await expect(client.register(registrationRequest)).rejects.toThrow('control session changed');
		await client.close();
	});

	it('does not dispatch before a control session exists or after the client closes', async () => {
		// Arrange
		const controlService = createControlServiceFixture(null);
		const sendCommand = vi.fn<GatewayRuntimeControlCommandClient['sendCommand']>();
		const client = createClient({ controlService, sendCommand });
		expect(controlService.getObserverCount()).toBe(1);

		// Act / Assert
		await expect(client.register(registrationRequest)).rejects.toThrow('not connected');
		expect(sendCommand).not.toHaveBeenCalled();
		await client.close();
		expect(controlService.getObserverCount()).toBe(0);
		await expect(client.register(registrationRequest)).rejects.toThrow('closed');
	});

	it('does not cache failed registration responses', async () => {
		// Arrange
		const controlService = createControlServiceFixture();
		const sendCommand = vi
			.fn<GatewayRuntimeControlCommandClient['sendCommand']>()
			.mockResolvedValueOnce(failedCommandResponse(sessionA))
			.mockResolvedValue(successfulCommandResponse(sessionA));
		const client = createClient({ controlService, sendCommand });

		// Act / Assert
		await expect(client.register(registrationRequest)).rejects.toThrow(
			'registration response failed',
		);
		expect(await client.register(registrationRequest)).toEqual({
			admissionPrincipal,
			callerContextId,
		});
		expect(sendCommand).toHaveBeenCalledTimes(2);
		await client.close();
	});

	it('fences an in-flight registration when the client closes', async () => {
		// Arrange
		const controlService = createControlServiceFixture();
		let resolveCommand: ((value: ReturnType<typeof successfulCommandResponse>) => void) | undefined;
		const commandResult = new Promise<ReturnType<typeof successfulCommandResponse>>((resolve) => {
			resolveCommand = resolve;
		});
		const sendCommand = vi.fn<GatewayRuntimeControlCommandClient['sendCommand']>(
			async () => await commandResult,
		);
		const client = createClient({ controlService, sendCommand });
		const registration = client.register(registrationRequest);

		// Act
		await client.close();
		resolveCommand?.(successfulCommandResponse(sessionA));

		// Assert
		await expect(registration).rejects.toThrow('control session changed');
		expect(controlService.getObserverCount()).toBe(0);
	});
});
