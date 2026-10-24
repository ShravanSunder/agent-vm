import {
	workspaceResourceIdentifier,
	hashCallArguments,
} from '@agent-collaboration/tool-access/contracts';
import { signApprovalToken } from '@agent-collaboration/tool-engine/mcp-gateway';
import { generateKeyPair, importJWK, SignJWT, type JWTPayload } from 'jose';
import { z } from 'zod';

import type {
	PrivateDeployFile,
	PrivateOrganization,
} from '#worker-host/deployed-checks/deploy-configuration/models/private-deploy-file';
import {
	runObservationsSchema,
	type RunObservations,
} from '#worker-host/deployed-checks/test-helper-worker/models/helper-contracts';

export interface PortalRequestOptions {
	readonly token?: string;
	readonly copy?: 'a' | 'b';
	readonly organization?: PrivateOrganization;
	readonly agentId?: string;
	readonly changes?: JWTPayload;
	readonly forged?: boolean;
	readonly noToken?: boolean;
	readonly query?: string;
	readonly headers?: Readonly<Record<string, string>>;
	readonly bodyBytes?: number;
}
export function portalCall(
	configuration: PrivateDeployFile,
	callId: string,
	toolName = 'read',
	extra: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
	return {
		name: 'mcp_portal_call',
		arguments: {
			calls: [
				{
					id: callId,
					namespace: 'same-server',
					toolName,
					arguments: { runId: configuration.runId, callId, ...extra },
				},
			],
		},
	};
}
export async function agentToken(
	configuration: PrivateDeployFile,
	options: PortalRequestOptions = {},
): Promise<string> {
	const agentId = options.agentId ?? configuration.agentId;
	const now = Math.floor(Date.now() / 1000);
	const key = options.forged
		? (await generateKeyPair('ES256')).privateKey
		: await importJWK(configuration.privateSigningJwk, 'ES256');
	return new SignJWT({
		iss: configuration.helper.origin,
		sub: agentId,
		aud: workspaceResourceIdentifier({
			toolPortalOrigin: configuration.portalA.origin,
			workspaceId: (options.organization ?? configuration.organizations[0]).organizationId,
		}),
		workspace_id: (options.organization ?? configuration.organizations[0]).organizationId,
		iat: now,
		exp: now + 3600,
		scope: 'tool-portal:agent',
		client_id: agentId,
		azp: agentId,
		jti: crypto.randomUUID(),
		organization_id: (options.organization ?? configuration.organizations[0]).organizationId,
		...options.changes,
	})
		.setProtectedHeader({ alg: 'ES256', kid: configuration.signingKeyId, typ: 'at+jwt' })
		.sign(key);
}
export async function portalRpc(
	configuration: PrivateDeployFile,
	method: string,
	params: Readonly<Record<string, unknown>> = {},
	options: PortalRequestOptions = {},
): Promise<{
	readonly status: number;
	readonly result: Record<string, unknown>;
	readonly bytes: number;
}> {
	const origin = options.copy === 'b' ? configuration.portalB.origin : configuration.portalA.origin;
	const url = new URL(
		`/workspaces/${(options.organization ?? configuration.organizations[0]).organizationId}/mcp`,
		origin,
	);
	url.search = options.query ?? '';
	url.searchParams.set('runId', configuration.runId);
	const body = JSON.stringify({
		jsonrpc: '2.0',
		id: crypto.randomUUID(),
		method,
		params: {
			_meta: {
				'io.modelcontextprotocol/protocolVersion': '2026-07-28',
				'io.modelcontextprotocol/clientCapabilities': {},
			},
			...params,
		},
	});
	const response = await fetch(url, {
		method: 'POST',
		redirect: 'error',
		signal: AbortSignal.timeout(120_000),
		headers: {
			'CF-Access-Client-Id': configuration.access.clientId,
			'CF-Access-Client-Secret': configuration.access.clientSecret,
			...(options.noToken
				? {}
				: {
						authorization: `Bearer ${options.token ?? (await agentToken(configuration, options))}`,
					}),
			'content-type': 'application/json',
			accept: 'application/json, text/event-stream',
			'MCP-Protocol-Version': '2026-07-28',
			'Mcp-Method': method,
			...(typeof params.name === 'string' ? { 'Mcp-Name': params.name } : {}),
			...options.headers,
		},
		body:
			options.bodyBytes === undefined
				? body
				: body +
					' '.repeat(Math.max(0, options.bodyBytes - new TextEncoder().encode(body).byteLength)),
	});
	const text = await response.text();
	const bytes = new TextEncoder().encode(text).byteLength;
	if (response.status !== 200) return { status: response.status, result: {}, bytes };
	const result = z
		.object({ result: z.record(z.string(), z.unknown()) })
		.parse(JSON.parse(text)).result;
	return { status: response.status, result, bytes };
}
export async function requireRpcResult(
	response: Awaited<ReturnType<typeof portalRpc>>,
): Promise<Record<string, unknown>> {
	if (response.status !== 200)
		throw new Error(`Portal returned status ${String(response.status)}.`);
	return response.result;
}
export async function helperRequest(
	configuration: PrivateDeployFile,
	route: string,
	method = 'GET',
	body?: unknown,
): Promise<Response> {
	const response = await fetch(new URL(route, configuration.helper.origin), {
		method,
		redirect: 'error',
		signal: AbortSignal.timeout(30_000),
		headers: {
			authorization: `Bearer ${configuration.admissionSecret}`,
			'content-type': 'application/json',
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	if (response.status !== 200) {
		await response.body?.cancel();
		throw new Error(`Helper returned status ${String(response.status)}.`);
	}
	return response;
}
export async function observations(configuration: PrivateDeployFile): Promise<RunObservations> {
	const snapshot = runObservationsSchema.parse(
		await (await helperRequest(configuration, `/observations?runId=${configuration.runId}`)).json(),
	);
	if (snapshot.runId !== configuration.runId)
		throw new Error('Observations are from a different run.');
	return snapshot;
}
export async function setAdmission(
	configuration: PrivateDeployFile,
	organization: PrivateOrganization,
	state: 'listed' | 'removed',
	agentId = configuration.agentId,
): Promise<void> {
	await (
		await helperRequest(configuration, '/admission', 'POST', {
			organizationId: organization.organizationId,
			agentId,
			state,
		})
	).body?.cancel();
}
export async function admitTestAgents(configuration: PrivateDeployFile): Promise<void> {
	await Promise.all(
		configuration.organizations.flatMap((organization) =>
			[configuration.agentId, configuration.otherAgentId].map(
				async (agentId): Promise<void> =>
					setAdmission(configuration, organization, 'listed', agentId),
			),
		),
	);
}
export async function approvedCall(
	configuration: PrivateDeployFile,
	callId: string,
	organization = configuration.organizations[0],
	expiresAtMs = Date.now() + 6 * 60 * 60 * 1000,
): Promise<Record<string, unknown>> {
	const params = portalCall(configuration, callId, 'ask');
	const approval = await signApprovalToken({
		agentId: configuration.agentId,
		key: Uint8Array.from(Buffer.from(organization.approvalKeyHex, 'hex')),
		jti: crypto.randomUUID(),
		issuedAtMs: Date.now(),
		expiresAtMs,
		calls: [
			{
				namespace: 'same-server',
				toolName: 'ask',
				argumentsHash: await hashCallArguments({ runId: configuration.runId, callId }),
			},
		],
	});
	return {
		...params,
		arguments: {
			...z.record(z.string(), z.unknown()).parse(params.arguments),
			portalApprovalToken: approval,
		},
	};
}
