import { randomUUID, timingSafeEqual } from 'node:crypto';

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono } from 'hono';

import { createPortalAgentIdentity, type PortalAgentIdentity } from '../portal-access-policy.js';
import { createPortalMcpServer } from './portal-mcp-server.js';
import type { PortalToolRuntime } from './portal-tools.js';

export interface PortalHttpAgentIdentity extends PortalAgentIdentity {}

export interface PortalServerAccess {
	readonly expectedValue: string;
	readonly headerName: string;
}

export interface PortalHttpAppOptions {
	readonly onSessionClosed?: (identity: PortalAgentIdentity) => Promise<void> | void;
	readonly registeredAgentIds?: readonly string[];
	readonly resolveAgentIdentity?: (agentId: string) => PortalHttpAgentIdentity | null;
	readonly serverAccess?: PortalServerAccess;
	readonly toolRuntime: PortalToolRuntime;
}

export type PortalHttpApp = Hono & {
	readonly closePortalSessions: () => Promise<void>;
};

const mcpSessionIdHeader = 'mcp-session-id';

interface ActivePortalMcpSession {
	readonly identity: PortalAgentIdentity;
	readonly server: ReturnType<typeof createPortalMcpServer>;
	readonly transport: WebStandardStreamableHTTPServerTransport;
}

function timingSafeEqualString(left: string, right: string): boolean {
	const leftBuffer = Buffer.from(left);
	const rightBuffer = Buffer.from(right);
	return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function activeSessionKey(scopeId: string, sessionId: string): string {
	return `${scopeId}\n${sessionId}`;
}

export function createPortalHttpApp(options: PortalHttpAppOptions): PortalHttpApp {
	const app = new Hono();
	const activeSessions = new Map<string, ActivePortalMcpSession>();

	async function closeActiveSession(
		sessionKey: string,
		closeOptions: { readonly closeTransport: boolean },
	): Promise<void> {
		const activeSession = activeSessions.get(sessionKey);
		if (!activeSession) {
			return;
		}
		activeSessions.delete(sessionKey);
		if (closeOptions.closeTransport) {
			await activeSession.transport.close();
		}
		await options.onSessionClosed?.(activeSession.identity);
	}

	async function createActiveSession(
		identityBase: PortalAgentIdentity,
	): Promise<ActivePortalMcpSession> {
		const sessionId = randomUUID();
		const sessionKey = activeSessionKey(identityBase.agentScopeId, sessionId);
		let server: ReturnType<typeof createPortalMcpServer> | null = null;
		const identity = createPortalAgentIdentity({
			agentId: identityBase.agentId,
			agentScopeId: identityBase.agentScopeId,
			sessionId,
		});
		const transport = new WebStandardStreamableHTTPServerTransport({
			onsessionclosed: () => {
				void closeActiveSession(sessionKey, { closeTransport: false });
			},
			onsessioninitialized: (initializedSessionId) => {
				if (!server) {
					throw new Error('MCP Portal session initialized before server connection.');
				}
				activeSessions.set(activeSessionKey(identityBase.agentScopeId, initializedSessionId), {
					identity,
					server,
					transport,
				});
			},
			sessionIdGenerator: () => sessionId,
		});
		server = createPortalMcpServer({
			identity,
			runtime: options.toolRuntime,
		});
		await server.connect(transport);
		return { identity, server, transport };
	}

	async function closePortalSessions(): Promise<void> {
		await Promise.all(
			[...activeSessions.keys()].map((sessionKey) =>
				closeActiveSession(sessionKey, { closeTransport: true }),
			),
		);
	}

	app.get('/health', (context) =>
		context.json({ agents: [...(options.registeredAgentIds ?? [])].toSorted(), ok: true }),
	);

	app.all('/agents/:agentId/mcp', async (context) => {
		const serverAccess = options.serverAccess;
		if (serverAccess !== undefined) {
			const providedSecret = context.req.header(serverAccess.headerName);
			if (
				providedSecret === undefined ||
				!timingSafeEqualString(providedSecret, serverAccess.expectedValue)
			) {
				return context.json({ error: { kind: 'unauthorized' }, ok: false }, 401);
			}
		}

		const agentId = context.req.param('agentId');
		const agentIdentity = options.resolveAgentIdentity?.(agentId) ?? null;
		if (agentIdentity === null) {
			return context.json({ error: { kind: 'unknown_agent' }, ok: false }, 404);
		}

		const mcpSessionId = context.req.header(mcpSessionIdHeader);
		if (mcpSessionId) {
			const activeSession = activeSessions.get(
				activeSessionKey(agentIdentity.agentScopeId, mcpSessionId),
			);
			if (!activeSession) {
				return new Response('Unknown MCP portal session', { status: 404 });
			}
			return await activeSession.transport.handleRequest(context.req.raw);
		}

		const activeSession = await createActiveSession(agentIdentity);
		return await activeSession.transport.handleRequest(context.req.raw);
	});

	return Object.assign(app, { closePortalSessions });
}
