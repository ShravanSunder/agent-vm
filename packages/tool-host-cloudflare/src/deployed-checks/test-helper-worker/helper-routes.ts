import { z } from 'zod';

import { controlledResponseStream } from '#worker-host/deployed-checks/test-helper-worker/controlled-response-stream';
import {
	admissionInputSchema,
	controlledCallSchema,
	publicJwksSchema,
	rpcInputSchema,
	type HelperRoutePorts,
} from '#worker-host/deployed-checks/test-helper-worker/models/helper-contracts';

/** Test-only routes. Public keys are the sole unauthenticated surface. */
export async function handleHelperRequest(
	request: Request,
	ports: HelperRoutePorts,
): Promise<Response> {
	const url = new URL(request.url);
	if (url.pathname === '/jwks' && request.method === 'GET')
		return Response.json(publicJwksSchema.parse(ports.publicJwks));
	if (url.pathname === '/admission' || url.pathname === '/observations') {
		if (request.headers.get('authorization') !== `Bearer ${ports.admissionSecret}`)
			return new Response(null, { status: 401 });
		if (url.pathname === '/admission' && request.method === 'POST') {
			const input = admissionInputSchema.parse(await request.json());
			if (!Object.values(ports.workspaces).some((entry) => entry.workspaceId === input.workspaceId))
				return new Response(null, { status: 403 });
			await ports.setAdmission(input);
			return Response.json({ ok: true });
		}
		if (url.pathname === '/observations') {
			const runId = z.string().min(1).max(100).parse(url.searchParams.get('runId'));
			const observations = ports.observations(runId);
			if (request.method === 'DELETE') await observations.reset();
			else if (request.method === 'POST') {
				z.strictObject({ action: z.literal('release') }).parse(await request.json());
				await observations.release();
			} else if (request.method !== 'GET') return new Response(null, { status: 405 });
			return Response.json(await observations.snapshot());
		}
		return new Response(null, { status: 405 });
	}
	const label = url.pathname.match(/^\/mcp\/([a-z0-9-]+)$/u)?.[1];
	const workspace = label === undefined ? undefined : ports.workspaces[label];
	if (workspace === undefined || label === undefined) return new Response(null, { status: 404 });
	if (request.headers.get('authorization') !== workspace.credential)
		return new Response(null, { status: 401 });
	if (request.method !== 'POST') return new Response(null, { status: 405 });
	const rpc = rpcInputSchema.parse(await request.json());
	let result: unknown;
	if (rpc.method === 'initialize')
		result = {
			protocolVersion: '2025-11-25',
			capabilities: { tools: {} },
			serverInfo: { name: 'controlled', version: '1' },
		};
	else if (rpc.method === 'tools/list')
		result = {
			tools: ['read', 'ask', 'hidden', 'blocked', `only-${label}`].map((name) => ({
				name,
				inputSchema: { type: 'object', additionalProperties: true },
			})),
		};
	else if (rpc.method === 'tools/call') {
		const input = controlledCallSchema.parse(rpc.params?.arguments);
		const name = z.string().min(1).parse(rpc.params?.name);
		if (!['read', 'ask', 'hidden', 'blocked', `only-${label}`].includes(name))
			return Response.json({
				jsonrpc: '2.0',
				id: rpc.id,
				error: { code: -32602, message: 'Unknown controlled tool.' },
			});
		const observations = ports.observations(input.runId);
		await observations.begin({
			workspaceLabel: label,
			callId: input.callId,
			credential: workspace.credential,
			toolName: name,
		});
		return controlledResponseStream({ rpcId: rpc.id, input, observations });
	} else {
		if (rpc.id === undefined) return new Response(null, { status: 202 });
		return Response.json({
			jsonrpc: '2.0',
			id: rpc.id,
			error: { code: -32601, message: 'Method not found' },
		});
	}
	return Response.json({ jsonrpc: '2.0', id: rpc.id, result });
}
