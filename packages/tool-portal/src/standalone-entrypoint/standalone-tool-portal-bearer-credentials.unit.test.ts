import { describe, expect, it } from 'vitest';

import {
	compileStandaloneToolPortalCredentialSet,
	TOOL_PORTAL_MCP_BEARER_AUDIENCE,
	type StandaloneToolPortalBearerCredentialSet,
} from './standalone-tool-portal-bearer-credentials.js';

const standalonePrincipal = {
	agentId: 'agent-a',
	profileAssignmentRevision: 'profile-assignment:3',
	toolPortalProfileId: 'builder',
};

const credentialSet = {
	audience: TOOL_PORTAL_MCP_BEARER_AUDIENCE,
	credentials: [
		{
			bearerToken: 'standalone-bearer-token',
			credentialVersion: 3,
			principal: standalonePrincipal,
		},
	],
	serviceGeneration: 'standalone-service:1',
} satisfies StandaloneToolPortalBearerCredentialSet;

describe('standalone Tool Portal bearer identity', () => {
	it('derives one immutable Tool-Portal principal including credential version', () => {
		const compiled = compileStandaloneToolPortalCredentialSet(credentialSet);

		expect(compiled.credentials[0]?.principal).toEqual({
			agentId: 'agent-a',
			credentialVersion: 3,
			profileAssignmentRevision: 'profile-assignment:3',
			toolPortalProfileId: 'builder',
		});
	});

	it.each([
		{
			...standalonePrincipal,
			frameworkIdentity: { agentId: 'agent-a', kind: 'openclaw' },
		},
		{
			...standalonePrincipal,
			selfRoot: '/zone/agents/agent-a/self',
		},
		{
			...standalonePrincipal,
			workRoot: '/zone/agents/agent-a/work',
		},
	])('rejects managed-only or root authority fields from standalone identity', (principal) => {
		expect(() =>
			compileStandaloneToolPortalCredentialSet({
				...credentialSet,
				credentials: [
					{
						bearerToken: 'standalone-bearer-token',
						credentialVersion: 3,
						principal,
					},
				],
			}),
		).toThrow();
	});

	it('rejects a non-Tool-Portal bearer audience', () => {
		expect(() =>
			compileStandaloneToolPortalCredentialSet({
				...credentialSet,
				audience: 'mcp-portal:mcp',
			} as never),
		).toThrow();
	});
});
