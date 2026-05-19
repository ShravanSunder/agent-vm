import { randomUUID } from 'node:crypto';

import { StreamableHTTPTransport } from '@hono/mcp';
import { Hono } from 'hono';

import type { PortalCore } from '../core/portal-core.js';
import { createPortalAgentIdentity, type PortalAgentIdentity } from '../portal-access-policy.js';
import { verifyAgentBearerAuthorization } from '../portal-auth/agent-bearer-token.js';
import { createPortalMcpServer } from './portal-mcp-server.js';

export interface PortalHttpAgentIdentity extends PortalAgentIdentity {}

export interface PortalAgentBearerAuth {
	readonly authorizationHeaderName: string;
	readonly credentialVersionsByAgent?: Readonly<Record<string, number>>;
	readonly masterKey: Buffer;
}

export type PortalHttpAuditEvent = {
	readonly agentId: string;
	readonly clientAddress: string;
	readonly decision: 'allow' | 'deny';
	readonly kind: 'mcp_proxy_auth';
	readonly reason?:
		| 'malformed'
		| 'missing'
		| 'rate_limited'
		| 'signature-mismatch'
		| 'unknown_agent';
	readonly timeMs: number;
};

export interface PortalHttpAppOptions {
	readonly agentBearerAuth: PortalAgentBearerAuth;
	readonly auditSink?: (event: PortalHttpAuditEvent) => Promise<void> | void;
	readonly authFailureLimit?: {
		readonly maxFailures: number;
		readonly windowMs: number;
	};
	readonly core: PortalCore;
	readonly onSessionClosed?: (identity: PortalAgentIdentity) => Promise<void> | void;
	readonly registeredAgentIds?: readonly string[];
	readonly resolveAgentIdentity?: (agentId: string) => PortalHttpAgentIdentity | null;
}

export type PortalHttpApp = Hono & {
	readonly closePortalSessions: () => Promise<void>;
};

const mcpSessionIdHeader = 'mcp-session-id';
const defaultAuthFailureLimit = { maxFailures: 60, windowMs: 60_000 } as const;

interface ActivePortalMcpSession {
	readonly identity: PortalAgentIdentity;
	readonly server: ReturnType<typeof createPortalMcpServer>;
	readonly transport: StreamableHTTPTransport;
}

interface AuthFailureBucket {
	readonly resetAtMs: number;
	failures: number;
}

function activeSessionKey(scopeId: string, sessionId: string): string {
	return `${scopeId}\n${sessionId}`;
}

function unauthorizedResponse(): Response {
	return Response.json({ error: { kind: 'unauthorized' }, ok: false }, { status: 401 });
}

function rateLimitedResponse(): Response {
	return Response.json({ error: { kind: 'rate_limited' }, ok: false }, { status: 429 });
}

function clientAddressFromHeaders(headers: Headers): string {
	const forwardedFor = headers.get('x-forwarded-for')?.split(',', 1)[0]?.trim();
	return forwardedFor && forwardedFor.length > 0
		? forwardedFor
		: (headers.get('x-real-ip') ?? 'unknown');
}

function authFailureKey(agentId: string, clientAddress: string): string {
	return `${agentId}\n${clientAddress}`;
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
	const authFailureBuckets = new Map<string, AuthFailureBucket>();
	const authFailureLimit = options.authFailureLimit ?? defaultAuthFailureLimit;

	async function auditAuth(event: Omit<PortalHttpAuditEvent, 'kind' | 'timeMs'>): Promise<void> {
		await Promise.resolve(
			options.auditSink?.({ ...event, kind: 'mcp_proxy_auth', timeMs: Date.now() }),
		).catch(() => undefined);
	}

	function isAuthFailureRateLimited(agentId: string, clientAddress: string): boolean {
		const nowMs = Date.now();
		const key = authFailureKey(agentId, clientAddress);
		const bucket = authFailureBuckets.get(key);
		if (bucket === undefined) {
			return false;
		}
		if (bucket.resetAtMs <= nowMs) {
			authFailureBuckets.delete(key);
			return false;
		}
		return bucket.failures >= authFailureLimit.maxFailures;
	}

	function recordAuthFailure(agentId: string, clientAddress: string): void {
		const nowMs = Date.now();
		const key = authFailureKey(agentId, clientAddress);
		const bucket = authFailureBuckets.get(key);
		if (bucket !== undefined && bucket.resetAtMs > nowMs) {
			bucket.failures += 1;
			return;
		}
		authFailureBuckets.set(key, {
			failures: 1,
			resetAtMs: nowMs + authFailureLimit.windowMs,
		});
	}

	function clearAuthFailures(agentId: string, clientAddress: string): void {
		authFailureBuckets.delete(authFailureKey(agentId, clientAddress));
	}

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
		const transport = new StreamableHTTPTransport({
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
		const closeResults = await Promise.allSettled(
			[...activeSessions.keys()].map((sessionKey) =>
				closeActiveSession(sessionKey, { closeTransport: true }),
			),
		);
		const closeErrors = closeResults
			.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
			.map((result): unknown => result.reason);
		if (closeErrors.length > 0) {
			throw new AggregateError(closeErrors, 'Failed to close one or more MCP Portal sessions.');
		}
	}

	app.get('/health', (context) =>
		context.json({ agents: [...(options.registeredAgentIds ?? [])].toSorted(), ok: true }),
	);

	app.all('/agents/:agentId/mcp', async (context) => {
		const agentId = context.req.param('agentId');
		const clientAddress = clientAddressFromHeaders(context.req.raw.headers);
		if (isAuthFailureRateLimited(agentId, clientAddress)) {
			await auditAuth({
				agentId,
				clientAddress,
				decision: 'deny',
				reason: 'rate_limited',
			});
			return rateLimitedResponse();
		}
		const agentIdentity = options.resolveAgentIdentity?.(agentId) ?? null;
		if (agentIdentity === null) {
			recordAuthFailure(agentId, clientAddress);
			await auditAuth({
				agentId,
				clientAddress,
				decision: 'deny',
				reason: 'unknown_agent',
			});
			return unauthorizedResponse();
		}

		const agentBearerAuth = options.agentBearerAuth;
		const credentialVersion = agentBearerAuth.credentialVersionsByAgent?.[agentId];
		const verification = verifyAgentBearerAuthorization({
			agentId,
			authorizationHeader: context.req.header(agentBearerAuth.authorizationHeaderName),
			...(credentialVersion === undefined ? {} : { credentialVersion }),
			masterKey: agentBearerAuth.masterKey,
		});
		if (!verification.ok) {
			recordAuthFailure(agentId, clientAddress);
			await auditAuth({
				agentId,
				clientAddress,
				decision: 'deny',
				reason: verification.reason,
			});
			return unauthorizedResponse();
		}
		clearAuthFailures(agentId, clientAddress);
		await auditAuth({ agentId, clientAddress, decision: 'allow' });

		const mcpSessionId = context.req.header(mcpSessionIdHeader);
		if (mcpSessionId) {
			const activeSession = activeSessions.get(
				activeSessionKey(agentIdentity.agentScopeId, mcpSessionId),
			);
			if (!activeSession) {
				return new Response('Unknown MCP portal session', { status: 404 });
			}
			return await activeSession.transport.handleRequest(context);
		}

		const activeSession = await createActiveSession(agentIdentity);
		return await activeSession.transport.handleRequest(context);
	});

	return Object.assign(app, { closePortalSessions });
}
