import { GatewayStablePrincipalDigestSchema } from '@agent-vm/agent-portal-sdk/contracts';
import {
	GatewayControlRpcCommandResultMessageSchema,
	type GatewayRuntimeTrustedInvocationContext,
} from '@agent-vm/gateway-control-contracts';
import {
	oauthAccountProfileIdSchema,
	oauthAccountProfileToolRequirementSchema,
	oauthToolAvailabilityBatchResultSchema,
} from '@agent-vm/oauth-broker-contracts';
import { describe, expect, it, vi } from 'vitest';

import type { GatewayControlCallerContextRegistrationClient } from './control-endpoint/gateway-control-caller-context-registration-client.js';
import type { GatewayRuntimeControlCommandClient } from './control-endpoint/gateway-control-command-client.js';
import type { GatewayControlAcceptedSession } from './control-endpoint/gateway-control-endpoint-contracts.js';
import { createGatewayControlOAuthAvailabilityPort } from './oauth-availability-gateway-control-port.js';

const trustedContext = {
	principal: {
		agentId: 'hermes',
		frameworkIdentity: { kind: 'hermes', profileName: 'hermes' },
		profileAssignmentRevision: 'profile-assignment:1',
		toolPortalProfileId: 'google-enabled',
	},
} satisfies GatewayRuntimeTrustedInvocationContext;

const requirement = oauthAccountProfileToolRequirementSchema.parse({
	applicationId: 'gmail-app',
	kind: 'oauth-account-profile',
	minimumPermission: 'read',
	serviceId: 'gmail',
});

const acceptedSession = {
	attachmentGeneration: 1,
	bootId: 'gateway-boot',
	connectionId: '30000000-0000-4000-8000-000000000003',
	controllerEpoch: 'controller-epoch',
	gatewayEpoch: 'gateway-epoch',
	generationId: 'gateway-generation',
	peerId: 'gateway-peer',
	processEpoch: 'process-epoch',
	sessionId: '40000000-0000-4000-8000-000000000004',
	zoneId: 'apollofam',
} satisfies GatewayControlAcceptedSession;

describe('Gateway control OAuth availability port', () => {
	it('registers the authenticated caller and returns the exact controller batch', async () => {
		// Arrange
		const register: GatewayControlCallerContextRegistrationClient['register'] = vi.fn(async () => ({
			admissionPrincipal: GatewayStablePrincipalDigestSchema.parse(
				'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			),
			callerContextId: '10000000-0000-4000-8000-000000000001',
		}));
		const sendCommand: GatewayRuntimeControlCommandClient['sendCommand'] = vi.fn(async () => ({
			acceptedSession,
			messageId: '20000000-0000-4000-8000-000000000002',
			response: GatewayControlRpcCommandResultMessageSchema.parse({
				kind: 'command_result',
				operation: 'tool_portal_oauth_availability',
				payload: {
					oauthAvailabilityBatch: oauthToolAvailabilityBatchResultSchema.parse({
						items: [
							{
								availability: {
									accountProfiles: [
										{
											accountLabel: 'Personal Google',
											accountProfileId: oauthAccountProfileIdSchema.parse('personal-google'),
										},
									],
									kind: 'ready',
								},
								requirement,
							},
						],
					}),
					responseToMessageId: '20000000-0000-4000-8000-000000000002',
					result: 'ok',
				},
			}),
		}));
		const port = createGatewayControlOAuthAvailabilityPort({
			callerContextRegistrationClient: { close: async () => undefined, register },
			controlCommandClient: { sendCommand },
			now: () => 1_000,
		});

		// Act
		const result = await port.resolve({
			request: { requirements: [requirement] },
			trustedContext,
		});

		// Assert
		expect(register).toHaveBeenCalledWith({
			purpose: 'tool_portal_oauth_availability',
			trustedContext,
		});
		expect(sendCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				createdAtMs: 1_000,
				expiresAtMs: 6_000,
				message: expect.objectContaining({ operation: 'tool_portal_oauth_availability' }),
			}),
		);
		expect(result.items[0]).toMatchObject({ availability: { kind: 'ready' }, requirement });
	});
});
