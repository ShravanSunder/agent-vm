import {
	oauthApplicationIdSchema,
	oauthServiceIdSchema,
	oauthTransactionIdSchema,
	type OAuthAuthorizationActionResult,
} from '@agent-vm/oauth-broker-contracts';
import type {
	GoogleOAuthBrokerService,
	GoogleOAuthPermissionSubmissionResult,
} from '@agent-vm/oauth-broker/google';
import { describe, expect, it, vi } from 'vitest';

import {
	createOAuthHttpsApp,
	type OAuthApprovalAssets,
	type OAuthHttpsBindings,
	startOAuthHttpsServer,
	startOAuthTlsListener,
} from './oauth-https-server.js';

const transactionId = oauthTransactionIdSchema.parse('transaction_identifier_1234567890abcdef');
const browserBindingSecret = 'browser_binding_secret_1234567890abcdefghi';
const csrfToken = 'csrf_token_1234567890abcdefghijklmnop';
const publicBaseUrl = 'https://auth.claw.askluna.xyz:18900';
const certificatePath = fileURLToPath(
	new URL('./test-fixtures/oauth-listener-test.crt', import.meta.url),
);
const privateKeyPath = fileURLToPath(
	new URL('./test-fixtures/oauth-listener-test.key', import.meta.url),
);

async function reserveAvailablePort(): Promise<number> {
	const reservation = createServer();
	await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
	const address = reservation.address();
	if (address === null || typeof address === 'string') {
		throw new Error('Port reservation did not expose a TCP port.');
	}
	await new Promise<void>((resolve, reject) =>
		reservation.close((error) => (error === undefined ? resolve() : reject(error))),
	);
	return address.port;
}

async function requestLocalHttpsStatus(port: number): Promise<number | undefined> {
	return await new Promise<number | undefined>((resolve, reject) => {
		const request = requestHttps(
			{
				hostname: '127.0.0.1',
				method: 'GET',
				path: '/',
				port,
				rejectUnauthorized: false,
			},
			(response) => {
				response.resume();
				response.once('end', () => resolve(response.statusCode));
			},
		);
		request.once('error', reject);
		request.end();
	});
}

function requestEnvironment(remoteAddress = '100.100.100.10'): OAuthHttpsBindings {
	return {
		incoming: {
			socket: { remoteAddress, remotePort: 48_123 },
		},
	};
}

function approvalAssets(): OAuthApprovalAssets {
	return {
		files: {
			'oauth.1111111111111111.css': new TextEncoder().encode('body{}'),
			'oauth.2222222222222222.js': new TextEncoder().encode('export {};'),
		},
		manifest: {
			css: 'oauth.1111111111111111.css',
			javascript: 'oauth.2222222222222222.js',
		},
	};
}

function cookieHeader(response: Response): string {
	return response.headers
		.getSetCookie()
		.map((cookie) => cookie.slice(0, cookie.indexOf(';')))
		.join('; ');
}

function createBrokerHarness(): {
	readonly brokerService: GoogleOAuthBrokerService;
	readonly cancelBrowserCompletion: ReturnType<typeof vi.fn>;
	readonly cancelBrowserTransaction: ReturnType<typeof vi.fn>;
	readonly submitPermissions: ReturnType<typeof vi.fn>;
} {
	const cancelBrowserCompletion = vi.fn(() => true);
	const cancelBrowserTransaction = vi.fn(() => true);
	const submitPermissions = vi.fn(
		(): GoogleOAuthPermissionSubmissionResult => ({
			applicationId: oauthApplicationIdSchema.parse('gmail-app'),
			applicationLabel: 'Gmail',
			authorizationUrl: 'https://accounts.google.test/authorize',
			browserBindingSecret,
			kind: 'redirect',
			transactionId,
		}),
	);
	return {
		brokerService: {
			cancelBrowserCompletion,
			cancelBrowserTransaction,
			close: async () => undefined,
			confirmAccount: async () => ({ accountLabel: 'Personal Google', kind: 'completed' }),
			executeAuthorizationAction: async (): Promise<OAuthAuthorizationActionResult> => ({
				kind: 'authorization-list',
				profiles: [],
			}),
			getPermissionPage: () => ({
				accountProfileLabel: 'Personal Google',
				applications: [
					{
						applicationId: 'gmail-app',
						description: 'Gmail authorization.',
						label: 'Gmail',
						services: [
							{
								allowedChoices: ['none', 'read', 'write'],
								label: 'Gmail messages',
								selectedChoice: 'read',
								serviceId: 'gmail',
							},
						],
					},
				],
				browserBindingSecret,
				csrfToken,
				transactionId,
			}),
			handleGoogleCallback: async () => ({ kind: 'failed', reason: 'unused-in-test' }),
			resolveRuntimeCredential: async () => ({
				kind: 'unavailable',
				reason: 'authorization-missing',
			}),
			resolveToolAvailability: () => ({ kind: 'authorization-status-unavailable' }),
			reapExpiredTransactions: () => ({ completionSessionCount: 0, transactionCount: 0 }),
			retryApplication: () => ({
				applicationId: oauthApplicationIdSchema.parse('gmail-app'),
				applicationLabel: 'Gmail',
				authorizationUrl: 'https://accounts.google.test/retry',
				browserBindingSecret,
				kind: 'redirect',
				transactionId,
			}),
			stopAdmission: () => undefined,
			submitPermissions,
		},
		cancelBrowserCompletion,
		cancelBrowserTransaction,
		submitPermissions,
	};
}

describe('OAuth HTTPS application', () => {
	it('binds the browser transaction to the socket peer and renders bounded approval context', async () => {
		const resolvedPeers: { readonly remoteAddress: string; readonly remotePort: number }[] = [];
		const harness = createBrokerHarness();
		const app = createOAuthHttpsApp({
			assets: approvalAssets(),
			brokerService: harness.brokerService,
			publicBaseUrl,
			tailnetIdentityResolver: {
				resolvePeerIdentity: async (peer) => {
					resolvedPeers.push(peer);
					return { loginName: 'authorized-human@example.test' };
				},
			},
		});

		const response = await app.request(
			`${publicBaseUrl}/oauth/transactions/${transactionId}`,
			{ headers: { 'tailscale-user-login': 'forged@example.test' } },
			requestEnvironment(),
		);

		expect(response.status).toBe(200);
		expect(resolvedPeers).toEqual([{ remoteAddress: '100.100.100.10', remotePort: 48_123 }]);
		expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
		expect(response.headers.getSetCookie()).toEqual([
			expect.stringContaining('agent_vm_oauth_transaction='),
			expect.stringContaining('agent_vm_oauth_transaction_binding='),
		]);
		const body = await response.text();
		expect(body).toContain('Choose access for Personal Google');
		expect(body).toContain('Tool Portal approval remains separate for every action.');
		expect(body).not.toContain('forged@example.test');
	});

	it('rejects cross-origin permission submission before invoking the broker', async () => {
		const harness = createBrokerHarness();
		const app = createOAuthHttpsApp({
			assets: approvalAssets(),
			brokerService: harness.brokerService,
			publicBaseUrl,
			tailnetIdentityResolver: {
				resolvePeerIdentity: async () => ({ loginName: 'authorized-human@example.test' }),
			},
		});
		const initial = await app.request(
			`${publicBaseUrl}/oauth/transactions/${transactionId}`,
			undefined,
			requestEnvironment(),
		);

		const response = await app.request(
			`${publicBaseUrl}/oauth/transactions/${transactionId}/permissions`,
			{
				body: new URLSearchParams({
					csrfToken,
					[`permission.${oauthApplicationIdSchema.parse('gmail-app')}.${oauthServiceIdSchema.parse('gmail')}`]:
						'read',
				}),
				headers: {
					'content-type': 'application/x-www-form-urlencoded',
					cookie: cookieHeader(initial),
					origin: 'https://attacker.example.test',
				},
				method: 'POST',
			},
			requestEnvironment(),
		);

		expect(response.status).toBe(403);
		expect(harness.submitPermissions).not.toHaveBeenCalled();
	});

	it('submits native-form permissions and supports bound cancellation', async () => {
		const harness = createBrokerHarness();
		const app = createOAuthHttpsApp({
			assets: approvalAssets(),
			brokerService: harness.brokerService,
			publicBaseUrl,
			tailnetIdentityResolver: {
				resolvePeerIdentity: async () => ({ loginName: 'authorized-human@example.test' }),
			},
		});
		const initial = await app.request(
			`${publicBaseUrl}/oauth/transactions/${transactionId}`,
			undefined,
			requestEnvironment(),
		);
		const cookies = cookieHeader(initial);
		const formHeaders = {
			'content-type': 'application/x-www-form-urlencoded',
			cookie: cookies,
			origin: publicBaseUrl,
		};

		const permissionResponse = await app.request(
			`${publicBaseUrl}/oauth/transactions/${transactionId}/permissions`,
			{
				body: new URLSearchParams({
					csrfToken,
					'permission.gmail-app.gmail': 'read',
				}),
				headers: formHeaders,
				method: 'POST',
			},
			requestEnvironment(),
		);
		expect(permissionResponse.status).toBe(200);
		expect(permissionResponse.headers.get('location')).toBeNull();
		const permissionBody = await permissionResponse.text();
		expect(permissionBody).toContain('Connecting Google applications');
		expect(permissionBody).toContain('https://accounts.google.test/authorize');
		expect(permissionBody).toContain(`/oauth/transactions/${transactionId}/cancel`);
		expect(harness.submitPermissions).toHaveBeenCalledWith(
			expect.objectContaining({
				selections: { 'gmail-app': { gmail: 'read' } },
				tailnetLogin: 'authorized-human@example.test',
				transactionId,
			}),
		);

		const cancelResponse = await app.request(
			`${publicBaseUrl}/oauth/transactions/${transactionId}/cancel`,
			{
				body: new URLSearchParams({ csrfToken }),
				headers: formHeaders,
				method: 'POST',
			},
			requestEnvironment(),
		);
		expect(cancelResponse.status).toBe(200);
		expect(harness.cancelBrowserTransaction).toHaveBeenCalledWith({
			browserBindingSecret,
			csrfToken,
			tailnetLogin: 'authorized-human@example.test',
			transactionId,
		});
	});

	it('renders application progress before the next Google application', async () => {
		// Arrange
		const harness = createBrokerHarness();
		const completionId = 'completion_session_1234567890abcdef';
		const app = createOAuthHttpsApp({
			assets: approvalAssets(),
			brokerService: {
				...harness.brokerService,
				confirmAccount: async () => ({
					applications: [
						{
							applicationId: oauthApplicationIdSchema.parse('gmail-app'),
							label: 'Gmail',
							status: 'completed',
						},
						{
							applicationId: oauthApplicationIdSchema.parse('workspace-app'),
							label: 'Workspace',
							status: 'authorizing',
						},
					],
					authorizationUrl: 'https://accounts.google.test/authorize-next',
					browserBindingSecret,
					csrfToken,
					kind: 'redirect',
					transactionId,
				}),
			},
			publicBaseUrl,
			tailnetIdentityResolver: {
				resolvePeerIdentity: async () => ({ loginName: 'authorized-human@example.test' }),
			},
		});

		// Act
		const response = await app.request(
			`${publicBaseUrl}/oauth/completions/${completionId}/confirm`,
			{
				body: new URLSearchParams({ csrfToken }),
				headers: {
					'content-type': 'application/x-www-form-urlencoded',
					cookie: `agent_vm_oauth_completion=${completionId}; agent_vm_oauth_completion_binding=${browserBindingSecret}`,
					origin: publicBaseUrl,
				},
				method: 'POST',
			},
			requestEnvironment(),
		);

		// Assert
		expect(response.status).toBe(200);
		const body = await response.text();
		expect(body).toContain('Connecting Google applications');
		expect(body).toContain('Workspace');
		expect(body).toContain('https://accounts.google.test/authorize-next');
		expect(body).toContain(`/oauth/transactions/${transactionId}/cancel`);
		const cancelResponse = await app.request(
			`${publicBaseUrl}/oauth/transactions/${transactionId}/cancel`,
			{
				body: new URLSearchParams({ csrfToken }),
				headers: {
					'content-type': 'application/x-www-form-urlencoded',
					cookie: `agent_vm_oauth_transaction=${transactionId}; agent_vm_oauth_transaction_binding=${browserBindingSecret}`,
					origin: publicBaseUrl,
				},
				method: 'POST',
			},
			requestEnvironment(),
		);
		expect(cancelResponse.status).toBe(200);
		expect(harness.cancelBrowserTransaction).toHaveBeenCalled();
	});

	it('cancels account confirmation through the bound native form route', async () => {
		const harness = createBrokerHarness();
		const completionId = 'completion_session_1234567890abcdef';
		const app = createOAuthHttpsApp({
			assets: approvalAssets(),
			brokerService: harness.brokerService,
			publicBaseUrl,
			tailnetIdentityResolver: {
				resolvePeerIdentity: async () => ({ loginName: 'authorized-human@example.test' }),
			},
		});

		const response = await app.request(
			`${publicBaseUrl}/oauth/completions/${completionId}/cancel`,
			{
				body: new URLSearchParams({ csrfToken }),
				headers: {
					'content-type': 'application/x-www-form-urlencoded',
					cookie: `agent_vm_oauth_completion=${completionId}; agent_vm_oauth_completion_binding=${browserBindingSecret}`,
					origin: publicBaseUrl,
				},
				method: 'POST',
			},
			requestEnvironment(),
		);

		expect(response.status).toBe(200);
		expect(await response.text()).toContain('Authorization was cancelled.');
		expect(harness.cancelBrowserCompletion).toHaveBeenCalledWith({
			browserBindingSecret,
			completionSessionId: completionId,
			csrfToken,
			tailnetLogin: 'authorized-human@example.test',
		});
	});

	it('renders a partial completion with a native retry link', async () => {
		// Arrange
		const harness = createBrokerHarness();
		const app = createOAuthHttpsApp({
			assets: approvalAssets(),
			brokerService: {
				...harness.brokerService,
				handleGoogleCallback: async () => ({
					completed: ['Gmail'],
					kind: 'partial-completion',
					retry: {
						applicationId: oauthApplicationIdSchema.parse('workspace-app'),
						applicationLabel: 'Workspace',
						authorizationUrl: 'https://accounts.google.test/retry-workspace',
						browserBindingSecret,
						kind: 'redirect',
						transactionId,
					},
					retryCsrfToken: csrfToken,
					retryable: ['Workspace'],
				}),
				retryApplication: () => ({
					applicationId: oauthApplicationIdSchema.parse('workspace-app'),
					applicationLabel: 'Workspace',
					authorizationUrl: 'https://accounts.google.test/retry-workspace',
					browserBindingSecret,
					kind: 'redirect',
					transactionId,
				}),
			},
			publicBaseUrl,
			tailnetIdentityResolver: {
				resolvePeerIdentity: async () => ({ loginName: 'authorized-human@example.test' }),
			},
		});

		// Act
		const response = await app.request(
			`${publicBaseUrl}/oauth/google/callback?code=test-code&state=test-state`,
			{
				headers: {
					cookie: `agent_vm_oauth_transaction=${transactionId}; agent_vm_oauth_transaction_binding=${browserBindingSecret}`,
				},
			},
			requestEnvironment(),
		);

		// Assert
		expect(response.status).toBe(200);
		const body = await response.text();
		expect(body).toContain('Some applications need attention');
		expect(body).toContain('Retry Google authorization');
		expect(body).toContain(`/oauth/completions/${transactionId}/retry`);
		expect(body).toContain(`/oauth/transactions/${transactionId}/cancel`);
		const cancelResponse = await app.request(
			`${publicBaseUrl}/oauth/transactions/${transactionId}/cancel`,
			{
				body: new URLSearchParams({ csrfToken }),
				headers: {
					'content-type': 'application/x-www-form-urlencoded',
					cookie: `agent_vm_oauth_transaction=${transactionId}; agent_vm_oauth_transaction_binding=${browserBindingSecret}`,
					origin: publicBaseUrl,
				},
				method: 'POST',
			},
			requestEnvironment(),
		);
		expect(cancelResponse.status).toBe(200);

		const retryResponse = await app.request(
			`${publicBaseUrl}/oauth/completions/${transactionId}/retry`,
			{
				body: new URLSearchParams({ csrfToken }),
				headers: {
					'content-type': 'application/x-www-form-urlencoded',
					cookie: `agent_vm_oauth_transaction=${transactionId}; agent_vm_oauth_transaction_binding=${browserBindingSecret}`,
					origin: publicBaseUrl,
				},
				method: 'POST',
			},
			requestEnvironment(),
		);
		expect(retryResponse.status).toBe(200);
		expect(retryResponse.headers.get('location')).toBeNull();
		const retryBody = await retryResponse.text();
		expect(retryBody).toContain('Connecting Google applications');
		expect(retryBody).toContain('Workspace');
		expect(retryBody).toContain('https://accounts.google.test/retry-workspace');
		expect(retryBody).toContain(`/oauth/transactions/${transactionId}/cancel`);
	});

	it('renders an expired callback explicitly', async () => {
		const harness = createBrokerHarness();
		const app = createOAuthHttpsApp({
			assets: approvalAssets(),
			brokerService: {
				...harness.brokerService,
				handleGoogleCallback: async () => ({ kind: 'failed', reason: 'expired' }),
			},
			publicBaseUrl,
			tailnetIdentityResolver: {
				resolvePeerIdentity: async () => ({ loginName: 'authorized-human@example.test' }),
			},
		});

		const response = await app.request(
			`${publicBaseUrl}/oauth/google/callback?code=test-code&state=test-state`,
			{
				headers: {
					cookie: `agent_vm_oauth_transaction=${transactionId}; agent_vm_oauth_transaction_binding=${browserBindingSecret}`,
				},
			},
			requestEnvironment(),
		);

		expect(response.status).toBe(410);
		expect(await response.text()).toContain('Authorization expired');
	});
});

describe('OAuth HTTPS listener', () => {
	function createTestApp(): ReturnType<typeof createOAuthHttpsApp> {
		return createOAuthHttpsApp({
			assets: approvalAssets(),
			brokerService: createBrokerHarness().brokerService,
			publicBaseUrl,
			tailnetIdentityResolver: {
				resolvePeerIdentity: async () => ({ loginName: 'authorized-human@example.test' }),
			},
		});
	}

	it('serves real TLS and closes the listener cleanly', async () => {
		// Arrange
		const [certificate, privateKey, port] = await Promise.all([
			readFile(certificatePath, 'utf8'),
			readFile(privateKeyPath, 'utf8'),
			reserveAvailablePort(),
		]);

		// Act
		const server = await startOAuthTlsListener({
			app: createTestApp(),
			bindAddress: '127.0.0.1',
			certificate,
			port,
			privateKey,
		});

		// Assert
		try {
			await expect(requestLocalHttpsStatus(port)).resolves.toBe(404);
		} finally {
			await server.close();
		}
	});

	it('rejects only after an occupied TLS port emits its bind failure', async () => {
		// Arrange
		const [certificate, privateKey] = await Promise.all([
			readFile(certificatePath, 'utf8'),
			readFile(privateKeyPath, 'utf8'),
		]);
		const reservation = createServer();
		await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
		const address = reservation.address();
		if (address === null || typeof address === 'string') {
			throw new Error('Port reservation did not expose a TCP port.');
		}

		// Act / Assert
		try {
			await expect(
				startOAuthTlsListener({
					app: createTestApp(),
					bindAddress: '127.0.0.1',
					certificate,
					port: address.port,
					privateKey,
				}),
			).rejects.toMatchObject({ code: 'EADDRINUSE' });
		} finally {
			await new Promise<void>((resolve, reject) =>
				reservation.close((error) => (error === undefined ? resolve() : reject(error))),
			);
		}
	});

	it.each([
		['not-yet-valid', 0],
		['expired', Date.UTC(2040, 0, 1)],
	])('rejects a %s certificate before opening a socket', async (_caseName, nowMs) => {
		// Arrange / Act / Assert
		await expect(
			startOAuthHttpsServer({
				app: createTestApp(),
				bindAddress: '100.100.100.10',
				certificatePath,
				now: () => nowMs,
				port: 18_900,
				privateKeyPath,
				publicHostname: 'auth.claw.askluna.xyz',
			}),
		).rejects.toThrow('OAuth TLS certificate is not valid at the current time.');
	});
});
import { readFile } from 'node:fs/promises';
import { request as requestHttps } from 'node:https';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
