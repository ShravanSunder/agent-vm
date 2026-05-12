import { randomUUID, timingSafeEqual } from 'node:crypto';

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono } from 'hono';

import type { PortalBindingIdentity } from '../portal-access-policy.js';
import { createPortalMcpServer } from './portal-mcp-server.js';
import type { PortalToolRuntime } from './portal-tools.js';

export interface PortalHttpBinding extends PortalBindingIdentity {
	readonly secret: string;
}

export interface PortalHttpAppOptions {
	readonly getBinding: (bindingId: string) => PortalHttpBinding | null;
	readonly onSessionClosed?: (identity: PortalBindingIdentity) => Promise<void> | void;
	readonly toolRuntime: PortalToolRuntime;
}

export type PortalHttpApp = Hono & {
	readonly closePortalSessions: () => Promise<void>;
};

const portalBindingSecretHeader = 'x-mcp-portal-binding-secret';
const mcpSessionIdHeader = 'mcp-session-id';

interface ActivePortalMcpSession {
	readonly identity: PortalBindingIdentity;
	readonly server: ReturnType<typeof createPortalMcpServer>;
	readonly transport: WebStandardStreamableHTTPServerTransport;
}

function timingSafeEqualString(left: string, right: string): boolean {
	const leftBuffer = Buffer.from(left);
	const rightBuffer = Buffer.from(right);
	return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function activeSessionKey(bindingId: string, sessionId: string): string {
	return `${bindingId}\n${sessionId}`;
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

	async function createActiveSession(binding: PortalHttpBinding): Promise<ActivePortalMcpSession> {
		const sessionId = randomUUID();
		const sessionKey = activeSessionKey(binding.bindingId, sessionId);
		let server: ReturnType<typeof createPortalMcpServer> | null = null;
		const identity = { agentId: binding.agentId, bindingId: binding.bindingId, sessionId };
		const transport = new WebStandardStreamableHTTPServerTransport({
			onsessionclosed: () => {
				void closeActiveSession(sessionKey, { closeTransport: false });
			},
			onsessioninitialized: (initializedSessionId) => {
				if (!server) {
					throw new Error('MCP Portal session initialized before server connection.');
				}
				activeSessions.set(activeSessionKey(binding.bindingId, initializedSessionId), {
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

	app.all('/mcp-portal/bindings/:bindingId/mcp', async (context) => {
		const bindingId = context.req.param('bindingId');
		const binding = options.getBinding(bindingId);
		const providedSecret = context.req.header(portalBindingSecretHeader);
		if (!binding || !providedSecret || !timingSafeEqualString(providedSecret, binding.secret)) {
			return new Response('Unauthorized', { status: 401 });
		}

		const mcpSessionId = context.req.header(mcpSessionIdHeader);
		if (mcpSessionId) {
			const activeSession = activeSessions.get(activeSessionKey(binding.bindingId, mcpSessionId));
			if (!activeSession) {
				return new Response('Unknown MCP portal session', { status: 404 });
			}
			return await activeSession.transport.handleRequest(context.req.raw);
		}

		const activeSession = await createActiveSession(binding);
		return await activeSession.transport.handleRequest(context.req.raw);
	});

	return Object.assign(app, { closePortalSessions });
}
