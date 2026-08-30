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
} from './oauth-https-server.js';

const transactionId = oauthTransactionIdSchema.parse('transaction_identifier_1234567890abcdef');
const browserBindingSecret = 'browser_binding_secret_1234567890abcdefghi';
const csrfToken = 'csrf_token_1234567890abcdefghijklmnop';
const publicBaseUrl = 'https://auth.claw.askluna.xyz:18900';

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
	readonly cancelBrowserTransaction: ReturnType<typeof vi.fn>;
	readonly submitPermissions: ReturnType<typeof vi.fn>;
} {
	const cancelBrowserTransaction = vi.fn(() => true);
	const submitPermissions = vi.fn(
		(): GoogleOAuthPermissionSubmissionResult => ({
			authorizationUrl: 'https://accounts.google.test/authorize',
			browserBindingSecret,
			kind: 'redirect',
			transactionId,
		}),
	);
	return {
		brokerService: {
			cancelBrowserTransaction,
			close: () => undefined,
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
			submitPermissions,
		},
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
		expect(permissionResponse.status).toBe(302);
		expect(permissionResponse.headers.get('location')).toBe(
			'https://accounts.google.test/authorize',
		);
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
});
