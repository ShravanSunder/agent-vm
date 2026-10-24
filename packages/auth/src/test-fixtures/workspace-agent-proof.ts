import { expect } from 'vitest';
import { z } from 'zod';

import type { startLocalAuthHarness } from '#auth/test-fixtures/local-auth-harness';
import { workspaceAudience } from '#auth/test-fixtures/local-auth-harness';

type LocalAuthHarness = Awaited<ReturnType<typeof startLocalAuthHarness>>;
export const agentCredentialSchema = z.object({
	clientId: z.string().min(1),
	clientSecret: z.string().min(1),
});
export type AgentCredential = z.infer<typeof agentCredentialSchema>;

export async function addWorkspaceAgent(props: {
	readonly harness: LocalAuthHarness;
	readonly owner: string;
	readonly workspaceId: string;
	readonly requestId: string;
	readonly clientId?: string;
}): Promise<Response> {
	return props.harness.gateway(`/management/workspaces/${props.workspaceId}/agents`, {
		method: 'POST',
		headers: { authorization: `Bearer ${props.owner}`, 'content-type': 'application/json' },
		body: JSON.stringify({
			requestId: props.requestId,
			persona: 'operator',
			...(props.clientId === undefined ? {} : { clientId: props.clientId }),
		}),
	});
}
export async function workspaceTokenResponse(props: {
	readonly harness: LocalAuthHarness;
	readonly credential: AgentCredential;
	readonly workspaceId: string;
}): Promise<Response> {
	return props.harness.auth('/api/auth/oauth2/token', {
		method: 'POST',
		headers: {
			authorization: `Basic ${btoa(`${props.credential.clientId}:${props.credential.clientSecret}`)}`,
			'content-type': 'application/x-www-form-urlencoded',
		},
		body: new URLSearchParams({
			grant_type: 'client_credentials',
			scope: 'tool-portal:agent',
			resource: workspaceAudience(props.workspaceId),
		}),
	});
}
export async function workspaceToken(props: {
	readonly harness: LocalAuthHarness;
	readonly credential: AgentCredential;
	readonly workspaceId: string;
}): Promise<string> {
	const response = await workspaceTokenResponse(props);
	expect(response.status).toBe(200);
	return z
		.object({ access_token: z.string(), refresh_token: z.never().optional() })
		.parse(await response.json()).access_token;
}
export async function callWorkspaceTool(props: {
	readonly harness: LocalAuthHarness;
	readonly workspaceId: string;
	readonly token: string;
	readonly correlation: string;
	readonly secondHeap?: boolean;
}): Promise<Response> {
	return props.harness.gateway(
		`/workspaces/${props.workspaceId}/mcp`,
		{
			method: 'POST',
			headers: {
				authorization: `Bearer ${props.token}`,
				'content-type': 'application/json',
				accept: 'application/json, text/event-stream',
				'MCP-Protocol-Version': '2026-07-28',
				'Mcp-Method': 'tools/call',
				'Mcp-Name': 'mcp_portal_call',
			},
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: props.correlation,
				method: 'tools/call',
				params: {
					_meta: {
						'io.modelcontextprotocol/protocolVersion': '2026-07-28',
						'io.modelcontextprotocol/clientCapabilities': {},
					},
					name: 'mcp_portal_call',
					arguments: {
						calls: [
							{
								id: props.correlation,
								namespace: 'proof-upstream',
								toolName: 'record_effect',
								arguments: { correlation: props.correlation },
							},
						],
					},
				},
			}),
		},
		props.secondHeap ?? false,
	);
}
