import { randomUUID } from 'node:crypto';

import { StreamableHTTPTransport } from '@hono/mcp';
import { getConnInfo } from '@hono/node-server/conninfo';
import { Hono, type Context } from 'hono';

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
	readonly auditErrorSink?: (error: Error, event: PortalHttpAuditEvent) => Promise<void> | void;
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
const authFailureBucketLimit = 1_024;
const directClientAddress = 'direct-client';

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

function unavailableResponse(): Response {
	return Response.json({ error: { kind: 'shutting_down' }, ok: false }, { status: 503 });
}

function errorFromUnknown(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function clientAddressFromContext(context: Context): string {
	try {
		const address = getConnInfo(context).remote.address;
		return address && address.length > 0 ? address : directClientAddress;
	} catch {
		return directClientAddress;
	}
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
	let closing = false;

	async function auditAuth(event: Omit<PortalHttpAuditEvent, 'kind' | 'timeMs'>): Promise<void> {
		const auditEvent = { ...event, kind: 'mcp_proxy_auth', timeMs: Date.now() } as const;
		try {
			await options.auditSink?.(auditEvent);
		} catch (error) {
			await options.auditErrorSink?.(errorFromUnknown(error), auditEvent);
		}
	}

	function pruneAuthFailureBuckets(nowMs: number): void {
		for (const [key, bucket] of authFailureBuckets) {
			if (bucket.resetAtMs <= nowMs) {
				authFailureBuckets.delete(key);
			}
		}
		while (authFailureBuckets.size > authFailureBucketLimit) {
			const firstKey = authFailureBuckets.keys().next().value;
			if (typeof firstKey !== 'string') {
				return;
			}
			authFailureBuckets.delete(firstKey);
		}
	}

	function isAuthFailureRateLimited(clientAddress: string): boolean {
		const nowMs = Date.now();
		pruneAuthFailureBuckets(nowMs);
		const bucket = authFailureBuckets.get(clientAddress);
		if (bucket === undefined) {
			return false;
		}
		if (bucket.resetAtMs <= nowMs) {
			authFailureBuckets.delete(clientAddress);
			return false;
		}
		return bucket.failures >= authFailureLimit.maxFailures;
	}

	function recordAuthFailure(clientAddress: string): void {
		const nowMs = Date.now();
		pruneAuthFailureBuckets(nowMs);
		const bucket = authFailureBuckets.get(clientAddress);
		if (bucket !== undefined && bucket.resetAtMs > nowMs) {
			bucket.failures += 1;
			return;
		}
		authFailureBuckets.set(clientAddress, {
			failures: 1,
			resetAtMs: nowMs + authFailureLimit.windowMs,
		});
		pruneAuthFailureBuckets(nowMs);
	}

	function clearAuthFailures(clientAddress: string): void {
		authFailureBuckets.delete(clientAddress);
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
		closing = true;
		const closeErrors: unknown[] = [];
		while (activeSessions.size > 0) {
			// Closing may trigger callbacks that mutate activeSessions, so drain snapshots until empty.
			// eslint-disable-next-line no-await-in-loop
			const closeResults = await Promise.allSettled(
				[...activeSessions.keys()].map((sessionKey) =>
					closeActiveSession(sessionKey, { closeTransport: true }),
				),
			);
			closeErrors.push(
				...closeResults
					.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
					.map((result): unknown => result.reason),
			);
		}
		if (closeErrors.length > 0) {
			throw new AggregateError(closeErrors, 'Failed to close one or more MCP Portal sessions.');
		}
	}

	app.get('/health', (context) =>
		context.json({ agents: [...(options.registeredAgentIds ?? [])].toSorted(), ok: true }),
	);

	app.all('/agents/:agentId/mcp', async (context) => {
		const agentId = context.req.param('agentId');
		const clientAddress = clientAddressFromContext(context);
		if (closing) {
			return unavailableResponse();
		}
		if (isAuthFailureRateLimited(clientAddress)) {
			await auditAuth({
				agentId,
				clientAddress,
				decision: 'deny',
				reason: 'rate_limited',
			});
			return rateLimitedResponse();
		}
		const agentBearerAuth = options.agentBearerAuth;
		const credentialVersion = agentBearerAuth.credentialVersionsByAgent?.[agentId];
		const verification = verifyAgentBearerAuthorization({
			agentId,
			authorizationHeader: context.req.header(agentBearerAuth.authorizationHeaderName),
			...(credentialVersion === undefined ? {} : { credentialVersion }),
			masterKey: agentBearerAuth.masterKey,
		});
		const agentIdentity = options.resolveAgentIdentity?.(agentId) ?? null;
		if (agentIdentity === null) {
			recordAuthFailure(clientAddress);
			await auditAuth({
				agentId,
				clientAddress,
				decision: 'deny',
				reason: 'unknown_agent',
			});
			return unauthorizedResponse();
		}
		if (!verification.ok) {
			recordAuthFailure(clientAddress);
			await auditAuth({
				agentId,
				clientAddress,
				decision: 'deny',
				reason: verification.reason,
			});
			return unauthorizedResponse();
		}
		clearAuthFailures(clientAddress);
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
