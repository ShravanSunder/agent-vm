import { readFile, mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import {
	Miniflare,
	Response as WorkerResponse,
	type V4FetchHandler,
	type WorkerOptions,
} from 'miniflare';
import { z } from 'zod';

import type { AuthTarget } from '#auth/native-owner-cli/auth-target';
import { ownerManagementToken } from '#auth/native-owner-cli/owner-cli-login';
import { startControlledToolUpstream } from '#auth/test-fixtures/controlled-tool-upstream';
import { d1MigrationStatements } from '#auth/test-fixtures/d1-migration-statements';
import { createGoogleOAuthProtocol } from '#auth/test-fixtures/google-oauth-protocol';

export const organizationOne = '11111111-1111-4111-8111-111111111111';
export const organizationTwo = '22222222-2222-4222-8222-222222222222';
export const registrationRequestId = 'b015079b-19b6-4aa2-9b82-1298efcb2f79';
export const registeredClientId = `agent-${organizationOne}-${registrationRequestId}`;
export const agentAudience = 'https://portal-test.invalid/mcp';
export const managementAudience = 'https://portal-test.invalid/management';

function workerManifest(script: string): NonNullable<WorkerOptions['config']['manifest']> {
	return { mainModule: 'worker.mjs', modules: { 'worker.mjs': { type: 'esm', contents: script } } };
}
function textBindings(
	values: Readonly<Record<string, string>>,
): Record<string, { readonly type: 'text'; readonly value: string }> {
	return Object.fromEntries(
		Object.entries(values).map(([name, value]) => [name, { type: 'text', value }]),
	);
}

async function bundleWorker(entry: string): Promise<string> {
	const result = await build({
		entryPoints: [entry],
		bundle: true,
		write: false,
		format: 'esm',
		platform: 'neutral',
		target: 'es2022',
		conditions: ['workerd', 'worker', 'browser'],
		mainFields: ['module', 'main'],
		external: ['cloudflare:workers', 'node:*'],
		logLevel: 'silent',
	});
	const output = result.outputFiles?.[0];
	if (output === undefined) throw new Error('Worker bundle is empty');
	return output.text;
}

function organizationConfigurations(upstream: string): unknown {
	function configuration(name: string, credential: string): unknown {
		return {
			organizationName: name,
			approvalKeyBinding: 'APPROVAL_KEY',
			mcp: {
				schemaVersion: 1,
				providers: {
					fixture: {
						kind: 'mcp',
						namespace: 'proof-upstream',
						transport: {
							kind: 'streamable-http',
							url: upstream,
							headers: { authorization: { source: 'environment', name: credential } },
						},
					},
				},
			},
			portal: {
				schemaVersion: 1,
				agents: { [registeredClientId]: { profile: 'operator' } },
				profiles: {
					operator: {
						namespaces: {
							'proof-upstream': {
								tools: { allow: '*' },
								calls: {
									withoutApproval: { allow: ['record_effect'] },
									requiresApproval: { allow: [] },
								},
							},
						},
					},
				},
			},
		};
	}
	return {
		[organizationOne]: configuration('proof-one', 'ONE_CREDENTIAL'),
		[organizationTwo]: configuration('proof-two', 'TWO_CREDENTIAL'),
	};
}

/** Actual local workerd, D1, Better Auth, named RPC and Gateway/DO. No admission or identity rows are preseeded. */
export async function startLocalAuthHarness(): Promise<{
	readonly miniflare: Miniflare;
	readonly database: Awaited<ReturnType<Miniflare['getD1Database']>>;
	readonly target: AuthTarget;
	readonly effects: Awaited<ReturnType<typeof startControlledToolUpstream>>['effects'];
	readonly issuer: string;
	readonly cookie: () => string;
	readonly ownerToken: () => Promise<string>;
	readonly auth: (pathname: string, init?: RequestInit) => Promise<Response>;
	readonly gateway: (
		pathname: string,
		init?: RequestInit,
		secondHeap?: boolean,
	) => Promise<Response>;
	readonly close: () => Promise<void>;
}> {
	const root = fileURLToPath(new URL('../../../../', import.meta.url));
	const runtimeDirectory = await mkdtemp(path.join(tmpdir(), '2026-10-auth-s1-'));
	const google = await createGoogleOAuthProtocol();
	const upstream = await startControlledToolUpstream();
	const miniflareReady = Promise.withResolvers<Miniflare>();
	const server = createServer((request, response) => {
		void (async (): Promise<void> => {
			try {
				const runtime = await miniflareReady.promise;
				let body = '';
				for await (const chunk of request) body += String(chunk);
				const pathname = request.url ?? '/';
				const worker = await runtime.getWorker(
					pathname.startsWith('/management/') || pathname.startsWith('/mcp')
						? 'gateway-one'
						: 'sign-in',
				);
				const headers = Object.fromEntries(
					Object.entries(request.headers).flatMap(([name, value]) =>
						value === undefined ? [] : [[name, Array.isArray(value) ? value.join(', ') : value]],
					),
				);
				const result = await worker.fetch(`${issuer}${pathname}`, {
					method: request.method ?? 'GET',
					headers,
					...(body === '' ? {} : { body }),
					redirect: 'manual',
				});
				const cookies = result.headers.getSetCookie();
				response.writeHead(result.status, Object.fromEntries(result.headers));
				if (cookies.length > 0) response.setHeader('set-cookie', cookies);
				response.end(Buffer.from(await result.arrayBuffer()));
			} catch {
				response.writeHead(503).end('Local auth transport failed');
			}
		})();
	});
	async function closeServers(): Promise<void> {
		server.closeAllConnections();
		await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		await upstream.close();
	}
	await new Promise<void>((resolveListen, rejectListen) => {
		server.once('error', rejectListen);
		server.listen(0, '127.0.0.1', resolveListen);
	});
	const address = server.address();
	if (address === null || typeof address === 'string')
		throw new Error('Local auth listener unavailable');
	const issuer = `http://127.0.0.1:${address.port}`;
	const [authScript, gatewayScript] = await Promise.all([
		bundleWorker(path.join(root, 'packages/auth/src/test-fixtures/auth-proof-entrypoint.ts')),
		bundleWorker(
			path.join(
				root,
				'packages/tool-host-cloudflare/src/test-fixtures/auth-gateway-proof-entrypoint.ts',
			),
		),
	]).catch(async (error: unknown) => {
		await closeServers();
		throw error;
	});
	const configuration = {
		issuer,
		mode: 'private',
		ownerEmail: 'owner@example.invalid',
		agentAudience,
		managementAudience,
		organizationIds: [organizationOne, organizationTwo],
		ownerCliClientId: 'owner-cli-local',
		ownerCliRedirectUri: 'http://127.0.0.1/callback',
		accessTokenSeconds: 300,
		managementHumanCheck: 'remembered-login',
	};
	const outbound: V4FetchHandler = async (request, runtime): Promise<WorkerResponse> => {
		const destination = new URL(request.url);
		if (destination.origin !== issuer && destination.origin !== upstream.url)
			return google.fetch(request, runtime);
		const response = await fetch(request.url, {
			method: request.method,
			headers: Object.fromEntries(request.headers),
			...(['GET', 'HEAD'].includes(request.method) ? {} : { body: await request.text() }),
			redirect: 'manual',
		});
		return new WorkerResponse(response.status === 204 ? null : await response.arrayBuffer(), {
			status: response.status,
			headers: Object.fromEntries(response.headers),
		});
	};
	const gatewayBindings = {
		SIGN_IN_ISSUER: issuer,
		SIGN_IN_JWKS_URL: `${issuer}/api/auth/jwks`,
		TOOL_PORTAL_AUDIENCE: agentAudience,
		MANAGEMENT_AUDIENCE: managementAudience,
		ORGANIZATION_CONFIGURATIONS: JSON.stringify(organizationConfigurations(upstream.url)),
		ONE_CREDENTIAL: 'Bearer organization-one-canary',
		TWO_CREDENTIAL: 'Bearer organization-two-canary',
		APPROVAL_KEY: '12'.repeat(32),
	};
	const miniflare = await Promise.resolve()
		.then(
			() =>
				new Miniflare({
					resourcePersistencePath: path.join(runtimeDirectory, 'state'),
					telemetry: { enabled: false },
					logRequests: false,
					workers: [
						{
							config: {
								type: 'worker',
								name: 'sign-in',
								manifest: workerManifest(authScript),
								compatibilityDate: '2026-08-15',
								compatibilityFlags: ['nodejs_compat'],
								env: {
									DB: { type: 'd1', id: 'auth-local' },
									...textBindings({
										SIGN_IN_CONFIGURATION: JSON.stringify(configuration),
										AUTH_SECRET: 'test-only-auth-secret-'.repeat(3),
										GOOGLE_CLIENT_ID: 'fixture-google-client',
										GOOGLE_CLIENT_SECRET: 'fixture-google-secret',
										GITHUB_CLIENT_ID: 'fixture-github-client',
										GITHUB_CLIENT_SECRET: 'fixture-github-secret',
									}),
								},
							},
							dev: { outboundService: { type: 'fetcher', handler: outbound } },
						},
						...['gateway-one', 'gateway-two'].map(
							(name): WorkerOptions => ({
								config: {
									type: 'worker',
									name,
									manifest: workerManifest(gatewayScript),
									compatibilityDate: '2026-08-15',
									env: {
										...textBindings(gatewayBindings),
										SIGN_IN: {
											type: 'worker',
											workerName: 'sign-in',
											exportName: 'AgentClientManagement',
										},
										ORGANIZATIONS: {
											type: 'durable-object',
											workerName: 'gateway-one',
											exportName: 'OrganizationAuthorization',
										},
										CALL_ANALYTICS: { type: 'analytics-engine-dataset', name: 'auth-proof-calls' },
									},
									...(name === 'gateway-one'
										? {
												exports: {
													OrganizationAuthorization: { type: 'durable-object', storage: 'sqlite' },
												},
											}
										: {}),
								},
								dev: { outboundService: { type: 'fetcher', handler: outbound } },
							}),
						),
					],
				}),
		)
		.catch(async (error: unknown) => {
			await closeServers();
			throw error;
		});
	miniflareReady.resolve(miniflare);
	const database = await (async (): Promise<Awaited<ReturnType<Miniflare['getD1Database']>>> => {
		await miniflare.ready;
		const localDatabase = await miniflare.getD1Database('DB', 'sign-in');
		const migrations = await Promise.all(
			['0001-better-auth.sql', '0002-private-admission-audit.sql'].map((file) =>
				readFile(path.join(root, 'packages/auth/migrations', file), 'utf8'),
			),
		);
		const statements = d1MigrationStatements(migrations);
		await localDatabase.batch(statements.map((statement) => localDatabase.prepare(statement)));
		return localDatabase;
	})().catch(async (error: unknown) => {
		try {
			await miniflare.dispose();
		} finally {
			await closeServers();
		}
		throw error;
	});
	const jar = new Map<string, string>();
	async function auth(pathname: string, init: RequestInit = {}): Promise<Response> {
		const response = await fetch(new URL(pathname, issuer), {
			...init,
			headers: {
				cookie: [...jar.values()].join('; '),
				origin: issuer,
				'sec-fetch-site': 'same-origin',
				...Object.fromEntries(new Headers(init.headers)),
			},
			redirect: 'manual',
		});
		for (const header of response.headers.getSetCookie()) {
			const pair = header.split(';')[0];
			if (pair !== undefined) jar.set(pair.split('=')[0] ?? '', pair);
		}
		return response;
	}
	const target: AuthTarget = {
		issuer,
		managementAudience,
		gatewayUrl: issuer,
		organizationId: organizationOne,
		ownerCliClientId: configuration.ownerCliClientId,
		ownerCliRedirectUri: configuration.ownerCliRedirectUri,
		tokenCachePath: path.join(runtimeDirectory, 'owner-token.json'),
	};
	return {
		miniflare,
		database,
		target,
		effects: upstream.effects,
		issuer,
		cookie: () => [...jar.values()].join('; '),
		auth,
		async ownerToken(): Promise<string> {
			return ownerManagementToken({
				target,
				browser: async (url): Promise<void> => {
					const authorization = new URL(new URL(url).searchParams.get('authorize') ?? 'invalid:');
					const signin = await auth('/api/auth/sign-in/social', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							provider: 'google',
							callbackURL: new URL('/owner-ready', issuer).toString(),
						}),
					});
					if (!signin.ok) throw new Error('Real provider sign-in initiation refused');
					const providerUrl = z.object({ url: z.url() }).parse(await signin.json()).url;
					const callback = google.authorize(new URL(providerUrl));
					const admitted = await auth(callback.toString());
					if (admitted.status !== 302) throw new Error('Real owner callback refused');
					const bootstrap = await auth('/api/auth/owner/bootstrap', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: '{}',
					});
					if (!bootstrap.ok) throw new Error('Real fixed owner-client bootstrap refused');
					const authorized = await auth(authorization.toString());
					const location = authorized.headers.get('location');
					if (location === null) throw new Error('Real native authorization did not return a code');
					const completed = await fetch(location, { redirect: 'manual' });
					if (!completed.ok) throw new Error('Real native CLI loopback callback refused');
				},
			});
		},
		async gateway(pathname, init = {}, secondHeap = false): Promise<Response> {
			const worker = await miniflare.getWorker(secondHeap ? 'gateway-two' : 'gateway-one');
			const incoming = new Request(new URL(pathname, issuer), init);
			const response = await worker.fetch(incoming.url, {
				method: incoming.method,
				headers: Object.fromEntries(incoming.headers),
				...(['GET', 'HEAD'].includes(incoming.method) ? {} : { body: await incoming.text() }),
			});
			return new Response(response.status === 204 ? null : await response.arrayBuffer(), {
				status: response.status,
				headers: Object.fromEntries(response.headers),
			});
		},
		async close(): Promise<void> {
			try {
				await miniflare.dispose();
			} finally {
				await closeServers();
			}
		},
	};
}
