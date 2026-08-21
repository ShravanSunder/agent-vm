import { createHash, createHmac } from 'node:crypto';

import type { GatewayStablePrincipalDigest } from '@agent-vm/agent-portal-sdk/contracts';
import {
	buildGatewayControlCallerContextAgentAuthorityPayload,
	buildGatewayControlCallerContextProofPayload,
	type GatewayRuntimeTrustedInvocationContext,
} from '@agent-vm/gateway-control-contracts';

import type {
	GatewayRuntimeControlCommand,
	GatewayRuntimeControlCommandClient,
} from './gateway-control-command-client.js';
import type {
	GatewayControlAcceptedSession,
	GatewayControlService,
} from './gateway-control-endpoint-contracts.js';

export interface GatewayControlCallerContextRegistrationRequest {
	readonly purpose?:
		| 'tool_portal_approval_decision'
		| 'tool_portal_controller_execution'
		| 'tool_vm_lease';
	readonly trustedContext: GatewayRuntimeTrustedInvocationContext;
}

export interface GatewayControlRegisteredCallerContext {
	readonly admissionPrincipal: GatewayStablePrincipalDigest;
	readonly callerContextId: string;
}

export interface GatewayControlCallerContextRegistrationClient {
	readonly close: () => Promise<void>;
	readonly register: (
		request: GatewayControlCallerContextRegistrationRequest,
	) => Promise<GatewayControlRegisteredCallerContext>;
}

export interface CreateGatewayControlCallerContextRegistrationClientProps {
	readonly agentAuthorityKeys: Readonly<Record<string, string>>;
	readonly callerContextProofKey: string;
	readonly controlCommandClient: GatewayRuntimeControlCommandClient;
	readonly controlService: Pick<
		GatewayControlService,
		'getCurrentAcceptedSession' | 'observeAcceptedSessions'
	>;
}

function buildRegistrationCommand(options: {
	readonly agentAuthorityKey: string;
	readonly callerContextProofKey: string;
	readonly request: GatewayControlCallerContextRegistrationRequest;
	readonly session: GatewayControlAcceptedSession;
}): {
	readonly cacheKey: string;
	readonly command: GatewayRuntimeControlCommand;
	readonly idempotencyKey: string;
} {
	const evidencePayload = {
		principal: options.request.trustedContext.principal,
		...(options.request.purpose === undefined ? {} : { purpose: options.request.purpose }),
		zoneId: options.session.zoneId,
	};
	const proofPayload = buildGatewayControlCallerContextProofPayload(evidencePayload);
	const agentAuthorityPayload =
		buildGatewayControlCallerContextAgentAuthorityPayload(evidencePayload);
	const correlation = options.request.trustedContext.correlation;
	const command = {
		kind: 'command',
		operation: 'caller_context_register',
		payload: {
			adapterEvidence: {
				agentAuthority: {
					algorithm: 'hmac-sha256',
					digest: createHmac('sha256', options.agentAuthorityKey)
						.update(agentAuthorityPayload, 'utf8')
						.digest('base64url'),
					keyId: options.request.trustedContext.principal.agentId,
				},
				...evidencePayload,
				proof: {
					algorithm: 'hmac-sha256',
					digest: createHmac('sha256', options.callerContextProofKey)
						.update(proofPayload, 'utf8')
						.digest('base64url'),
				},
			},
			...(correlation?.runId === undefined && correlation?.toolCallId === undefined
				? {}
				: {
						correlation: {
							...(correlation.runId === undefined ? {} : { runId: correlation.runId }),
							...(correlation.toolCallId === undefined
								? {}
								: { toolCallId: correlation.toolCallId }),
						},
					}),
		},
	} satisfies GatewayRuntimeControlCommand;
	const registrationDigest = createHash('sha256').update(proofPayload, 'utf8').digest('hex');
	return {
		cacheKey: proofPayload,
		command,
		idempotencyKey: `caller-context:${registrationDigest}`,
	};
}

export function createGatewayControlCallerContextRegistrationClient(
	props: CreateGatewayControlCallerContextRegistrationClientProps,
): GatewayControlCallerContextRegistrationClient {
	let closed = false;
	let cachedSession = props.controlService.getCurrentAcceptedSession();
	let registrationsByKey = new Map<string, Promise<GatewayControlRegisteredCallerContext>>();

	function replaceCachedSession(session: GatewayControlAcceptedSession): void {
		if (cachedSession === session) return;
		cachedSession = session;
		registrationsByKey = new Map();
	}

	const acceptedSessionObservation = props.controlService.observeAcceptedSessions(
		replaceCachedSession,
		() => undefined,
	);

	async function register(
		request: GatewayControlCallerContextRegistrationRequest,
	): Promise<GatewayControlRegisteredCallerContext> {
		if (closed) throw new Error('Gateway control caller-context registration client is closed.');
		const acceptedSession = props.controlService.getCurrentAcceptedSession();
		if (acceptedSession === undefined) {
			throw new Error('Gateway control caller-context registration is not connected.');
		}
		replaceCachedSession(acceptedSession);
		const agentAuthorityKey = props.agentAuthorityKeys[request.trustedContext.principal.agentId];
		if (agentAuthorityKey === undefined) {
			throw new Error(
				`Gateway control caller-context agent authority key is missing for ${request.trustedContext.principal.agentId}.`,
			);
		}
		const registrationCommand = buildRegistrationCommand({
			agentAuthorityKey,
			callerContextProofKey: props.callerContextProofKey,
			request,
			session: acceptedSession,
		});
		const cachedRegistration = registrationsByKey.get(registrationCommand.cacheKey);
		if (cachedRegistration !== undefined) return await cachedRegistration;

		const sessionRegistrations = registrationsByKey;
		const registration = (async (): Promise<GatewayControlRegisteredCallerContext> => {
			const commandResponse = await props.controlCommandClient.sendCommand({
				idempotencyKey: registrationCommand.idempotencyKey,
				message: registrationCommand.command,
			});
			if (
				closed ||
				commandResponse.acceptedSession !== acceptedSession ||
				props.controlService.getCurrentAcceptedSession() !== acceptedSession
			) {
				throw new Error('Gateway control session changed during caller-context registration.');
			}
			if (commandResponse.response.operation !== 'caller_context_register') {
				throw new Error(
					'Gateway control caller-context registration returned the wrong operation.',
				);
			}
			const responsePayload = commandResponse.response.payload;
			if (responsePayload.result !== 'ok') {
				throw new Error(responsePayload.error.safeMessage);
			}
			return Object.freeze({
				admissionPrincipal: responsePayload.callerContext.admissionPrincipal,
				callerContextId: responsePayload.callerContext.callerContextId,
			});
		})();
		sessionRegistrations.set(registrationCommand.cacheKey, registration);
		try {
			return await registration;
		} finally {
			if (sessionRegistrations.get(registrationCommand.cacheKey) === registration) {
				sessionRegistrations.delete(registrationCommand.cacheKey);
			}
		}
	}

	return {
		close: async () => {
			if (closed) return;
			closed = true;
			registrationsByKey.clear();
			acceptedSessionObservation.unsubscribe();
		},
		register,
	};
}
