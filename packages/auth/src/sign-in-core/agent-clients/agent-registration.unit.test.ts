import { describe, expect, it } from 'vitest';

import {
	agentRegistrationAllowsToken,
	agentRegistrationSchema,
} from '#auth/sign-in-core/agent-clients/agent-registration';

const organizationId = '11111111-1111-4111-8111-111111111111';
const audience = 'https://portal.invalid/mcp';
const registration = {
	clientId: 'registered-agent',
	metadata: { kind: 'agent', organizationId },
	grantTypes: ['client_credentials'],
	clientCredentialsScopes: ['tool-portal:agent'],
	tokenEndpointAuthMethod: 'client_secret_basic',
	resourceIds: [audience],
	disabled: false,
	registrationComplete: true,
};

describe('strict E9 registration and final release policy', () => {
	it('admits the completed, active, audience-bound registration', () => {
		expect(
			agentRegistrationAllowsToken({
				registration: agentRegistrationSchema.parse(registration),
				clientId: 'registered-agent',
				audience,
				signedOrganizationId: organizationId,
			}),
		).toBe(true);
	});
	it.each([
		{ grantTypes: ['client_credentials', 'authorization_code'] },
		{ grantTypes: ['authorization_code'] },
		{ clientCredentialsScopes: ['tool-portal:agent', 'offline_access'] },
		{ tokenEndpointAuthMethod: 'none' },
		{ metadata: { kind: 'person', organizationId } },
		{ metadata: { kind: 'agent', organizationId, owner: 'forged' } },
	])('rejects an E9 with unauthorized shape: %j', (changes) => {
		expect(agentRegistrationSchema.safeParse({ ...registration, ...changes }).success).toBe(false);
	});
	it.each([
		{ resourceIds: [] },
		{ resourceIds: [audience] },
		{
			resourceIds: [
				audience,
				'https://portal.invalid/workspaces/22222222-2222-4222-8222-222222222222/mcp',
			],
		},
	])(
		'keeps zero or many workspace links as agent state: %j',
		({ resourceIds }: { readonly resourceIds: readonly string[] }) => {
			expect(agentRegistrationSchema.parse({ ...registration, resourceIds }).resourceIds).toEqual(
				resourceIds,
			);
		},
	);
	it('accepts a linked workspace beyond the first without widening another audience', () => {
		const secondAudience =
			'https://portal.invalid/workspaces/22222222-2222-4222-8222-222222222222/mcp';
		const multiWorkspace = agentRegistrationSchema.parse({
			...registration,
			resourceIds: [audience, secondAudience],
		});
		expect(
			agentRegistrationAllowsToken({
				registration: multiWorkspace,
				clientId: registration.clientId,
				audience: secondAudience,
				signedOrganizationId: organizationId,
			}),
		).toBe(true);
		expect(
			agentRegistrationAllowsToken({
				registration: multiWorkspace,
				clientId: registration.clientId,
				audience: 'https://portal.invalid/unlinked',
				signedOrganizationId: organizationId,
			}),
		).toBe(false);
	});
	it.each([
		{ disabled: true, registrationComplete: true },
		{ disabled: false, registrationComplete: false },
	])('refuses token release for state %j', (state) => {
		expect(
			agentRegistrationAllowsToken({
				registration: agentRegistrationSchema.parse({ ...registration, ...state }),
				clientId: 'registered-agent',
				audience,
				signedOrganizationId: organizationId,
			}),
		).toBe(false);
	});
	it.each([
		{ clientId: 'different-agent', audience, signedOrganizationId: organizationId },
		{
			clientId: 'registered-agent',
			audience: 'https://other.invalid',
			signedOrganizationId: organizationId,
		},
		{
			clientId: 'registered-agent',
			audience,
			signedOrganizationId: '22222222-2222-4222-8222-222222222222',
		},
	])('refuses mismatched signed identity or resource %j', (claims) => {
		expect(
			agentRegistrationAllowsToken({
				registration: agentRegistrationSchema.parse(registration),
				...claims,
			}),
		).toBe(false);
	});
});
