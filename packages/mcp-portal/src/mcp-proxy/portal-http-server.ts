import { randomUUID } from 'node:crypto';

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono } from 'hono';

import { verifyAgentBearerAuthorization } from '../auth/agent-bearer-token.js';
import type { PortalCore } from '../core/portal-core.js';
import { createPortalAgentIdentity, type PortalAgentIdentity } from '../portal-access-policy.js';
import { createPortalMcpServer } from './portal-mcp-server.js';

export interface PortalHttpAgentIdentity extends PortalAgentIdentity {}

export interface PortalAgentBearerAuth {
	readonly authorizationHeaderName: string;
	readonly masterKey: Buffer;
}

export interface PortalHttpAppOptions {
	readonly agentBearerAuth: PortalAgentBearerAuth;
	readonly core: PortalCore;
	readonly onSessionClosed?: (identity: PortalAgentIdentity) => Promise<void> | void;
	readonly registeredAgentIds?: readonly string[];
	readonly resolveAgentIdentity?: (agentId: string) => PortalHttpAgentIdentity | null;
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

function activeSessionKey(scopeId: string, sessionId: string): string {
	return `${scopeId}\n${sessionId}`;
}

export function createPortalHttpApp(options: PortalHttpAppOptions): PortalHttpApp {
	if (options.agentBearerAuth === undefined) {
		throw new Error('MCP Portal HTTP app requires agent bearer auth.');
	}
	if (options.agentBearerAuth.authorizationHeaderName.length === 0) {
		throw new Error('MCP Portal HTTP app requires agent bearer auth header name.');
	}
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
		try {
			if (closeOptions.closeTransport) {
				await activeSession.transport.close();
			}
		} finally {
			await options.onSessionClosed?.(activeSession.identity);
		}
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
			source: identityBase.source,
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
			core: options.core,
			scope: identity,
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
		const agentId = context.req.param('agentId');
		const agentBearerAuth = options.agentBearerAuth;
		const verification = verifyAgentBearerAuthorization({
			agentId,
			authorizationHeader: context.req.header(agentBearerAuth.authorizationHeaderName),
			masterKey: agentBearerAuth.masterKey,
		});
		if (!verification.ok) {
			return context.json(
				{ error: { kind: 'unauthorized', reason: verification.reason }, ok: false },
				401,
			);
		}

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
