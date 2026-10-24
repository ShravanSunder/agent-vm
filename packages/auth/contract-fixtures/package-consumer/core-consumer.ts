import {
	agentRegistrationAllowsToken,
	type AgentRegistration,
} from '@agent-collaboration/auth/core';

const organizationId = '11111111-1111-4111-8111-111111111111';
const registration: AgentRegistration = {
	clientId: 'packed-agent',
	metadata: { kind: 'agent', organizationId },
	grantTypes: ['client_credentials'],
	clientCredentialsScopes: ['tool-portal:agent'],
	tokenEndpointAuthMethod: 'client_secret_basic',
	resourceIds: ['https://portal.invalid/mcp'],
	disabled: false,
	registrationComplete: true,
};
const input = {
	registration,
	clientId: 'packed-agent',
	audience: 'https://portal.invalid/mcp',
	signedOrganizationId: organizationId,
};
if (!agentRegistrationAllowsToken(input))
	throw new Error('Packed core denied the reference registration');
if (agentRegistrationAllowsToken({ ...input, registration: { ...registration, disabled: true } }))
	throw new Error('Packed core admitted a disabled client');
if (
	agentRegistrationAllowsToken({
		...input,
		signedOrganizationId: '22222222-2222-4222-8222-222222222222',
	})
)
	throw new Error('Packed core admitted a foreign signed organization');
export const packedCoreObserved = true;
