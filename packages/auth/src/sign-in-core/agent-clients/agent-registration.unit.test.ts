import { describe, expect, it } from 'vitest';

import {
	agentRegistrationAllowsToken,
	agentRegistrationSchema,
} from '#auth/sign-in-core/agent-clients/agent-registration';

const organizationId = '11111111-1111-4111-8111-111111111111';
const botId = '66666666-6666-4666-8666-666666666666';
const registration = {
	clientId: 'registered-bot-credential',
	metadata: { botId, organizationId },
	grantTypes: ['client_credentials'],
	clientCredentialsScopes: ['tool-portal:agent'],
	tokenEndpointAuthMethod: 'client_secret_basic',
	disabled: false,
};

describe('bot credential identity without a membership copy', () => {
	it('keeps the bot distinct from its credential and requires no workspace links', () => {
		// Arrange / Act: a credential identifies one bot and organization, without resourceIds.
		const parsed = agentRegistrationSchema.parse(registration);
		// Assert: taking the client ID as the bot, or requiring links, fails this contract.
		expect(parsed.metadata).toEqual({ botId, organizationId });
		expect(parsed.metadata.botId).not.toBe(parsed.clientId);
		expect(
			agentRegistrationAllowsToken({
				registration: parsed,
				clientId: parsed.clientId,
				signedOrganizationId: organizationId,
			}),
		).toBe(true);
	});
	it.each([
		{ grantTypes: ['client_credentials', 'authorization_code'] },
		{ grantTypes: ['authorization_code'] },
		{ clientCredentialsScopes: ['tool-portal:agent', 'offline_access'] },
		{ tokenEndpointAuthMethod: 'none' },
		{ metadata: { kind: 'agent', organizationId } },
		{ metadata: { botId, organizationId, owner: 'forged' } },
		{ resourceIds: ['https://portal.invalid/workspaces/old/mcp'] },
	])('rejects unauthorized credential shape %j', (changes) => {
		// Arrange / Act / Assert: old links and agent-only metadata cannot survive the cutover.
		expect(agentRegistrationSchema.safeParse({ ...registration, ...changes }).success).toBe(false);
	});
	it.each(['client_secret_basic', 'client_secret_post', 'private_key_jwt'])(
		'keeps the supported authenticated credential method %s',
		(tokenEndpointAuthMethod) => {
			expect(
				agentRegistrationSchema.parse({ ...registration, tokenEndpointAuthMethod })
					.tokenEndpointAuthMethod,
			).toBe(tokenEndpointAuthMethod);
		},
	);
	it.each([
		{ disabled: true, clientId: registration.clientId, signedOrganizationId: organizationId },
		{ disabled: false, clientId: 'another-credential', signedOrganizationId: organizationId },
		{
			disabled: false,
			clientId: registration.clientId,
			signedOrganizationId: '22222222-2222-4222-8222-222222222222',
		},
	])('refuses disabled or mismatched credential identity %j', ({ disabled, ...claims }) => {
		const parsed = agentRegistrationSchema.parse({ ...registration, disabled });
		expect(agentRegistrationAllowsToken({ registration: parsed, ...claims })).toBe(false);
	});
});
