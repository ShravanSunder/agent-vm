import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { SecretRef, SecretResolver } from '@agent-vm/secret-management';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	prepareControllerOAuthRuntime,
	type ControllerOAuthSystemConfig,
} from './controller-oauth-runtime.js';

let testRoot: string;

beforeEach(async () => {
	testRoot = await mkdtemp(path.join(tmpdir(), 'agent-vm-controller-oauth-runtime-'));
});

afterEach(async () => {
	await rm(testRoot, { force: true, recursive: true });
});

function oauthApplication(label: string, serviceId: string): Record<string, unknown> {
	return {
		clientCredentials: {
			ref: `op://agent-vm-testing/${label.toLowerCase()}/client-json`,
			source: '1password',
		},
		clientKind: 'web',
		description: `${label} application.`,
		label,
		services: {
			[serviceId]: { label: serviceId, read: [`scope.${serviceId}.read`] },
		},
	};
}

function oauthConfig(): unknown {
	return {
		agents: {
			hermes: {
				accountProfiles: {
					'personal-google': {
						applications: {
							'gmail-app': { maximumPermissions: { gmail: 'read' } },
						},
						authorizedTailnetLogins: ['human@example.test'],
						provider: 'google',
					},
				},
			},
		},
		browser: {
			listener: {
				certificatePath: path.join(testRoot, 'tls.crt'),
				kind: 'tailscale_https',
				port: 18_900,
				privateKeyPath: path.join(testRoot, 'tls.key'),
			},
			publicBaseUrl: 'https://auth.claw.askluna.xyz:18900',
		},
		providers: {
			google: {
				applications: {
					'gmail-app': oauthApplication('Gmail', 'gmail'),
					'workspace-app': oauthApplication('Workspace', 'calendar'),
					'youtube-app': oauthApplication('YouTube', 'youtube'),
				},
				kind: 'google',
			},
		},
		schemaVersion: 1,
		storage: {
			keyEncryptionKey: {
				ref: 'op://agent-vm-testing/oauth-kek/password',
				source: '1password',
			},
		},
	};
}

function toolPortalConfig(): unknown {
	return {
		agents: { hermes: { profile: 'google-enabled' } },
		mode: 'managed',
		profiles: {
			'google-enabled': {
				namespaces: {
					oauth_authorization: {
						backend: {
							kind: 'controller_execution',
							operations: {
								begin: { kind: 'registered_action' },
								cancel: { kind: 'registered_action' },
								list: { kind: 'registered_action' },
								reauthorize: { kind: 'registered_action' },
								revoke: { kind: 'registered_action' },
								status: { kind: 'registered_action' },
							},
						},
						calls: {
							requiresApproval: { allow: ['reauthorize', 'revoke'] },
							withoutApproval: { allow: ['begin', 'cancel', 'list', 'status'] },
						},
						discovery: { summary: 'Set up and inspect account authorization.' },
						tools: { allow: ['begin', 'cancel', 'list', 'reauthorize', 'revoke', 'status'] },
					},
				},
			},
		},
		schemaVersion: 1,
	};
}

function systemConfig(configDirectory: string): ControllerOAuthSystemConfig {
	return {
		controllerStateDir: path.join(testRoot, 'controller-state'),
		zones: [
			{
				gateway: { type: 'hermes' },
				id: 'apollofam',
				toolPortal: { configDir: configDirectory },
			},
		],
	};
}

function secretResolver(): SecretResolver {
	const callbackUrl = 'https://auth.claw.askluna.xyz:18900/oauth/google/callback';
	const clientJson = JSON.stringify({
		web: {
			auth_uri: 'https://accounts.google.com/o/oauth2/v2/auth',
			client_id: 'client-id',
			client_secret: 'client-secret',
			redirect_uris: [callbackUrl],
			token_uri: 'https://oauth2.googleapis.com/token',
		},
	});
	const resolve = vi.fn(async (reference: SecretRef) =>
		reference.source === '1password' && reference.ref.includes('oauth-kek')
			? Buffer.alloc(32, 41).toString('base64url')
			: clientJson,
	);
	return {
		resolve,
		resolveAll: async (references) =>
			Object.fromEntries(
				await Promise.all(
					Object.entries(references).map(async ([name, reference]) => [
						name,
						await resolve(reference),
					]),
				),
			),
	};
}

describe('controller OAuth runtime composition', () => {
	it('loads the zone config pair, resolves 1Password material, and opens the durable catalog', async () => {
		const configDirectory = path.join(testRoot, 'config', 'gateways', 'apollofam');
		await mkdir(configDirectory, { recursive: true });
		await Promise.all([
			writeFile(path.join(configDirectory, 'oauth.config.jsonc'), JSON.stringify(oauthConfig())),
			writeFile(
				path.join(configDirectory, 'tool-portal.config.jsonc'),
				JSON.stringify(toolPortalConfig()),
			),
		]);
		const localApiGetJson = vi.fn(async (requestPath: string) => {
			if (requestPath === '/localapi/v0/status') {
				return { Self: { TailscaleIPs: ['100.100.100.10'] } };
			}
			throw new Error(`Unexpected LocalAPI request: ${requestPath}`);
		});

		const prepared = await prepareControllerOAuthRuntime({
			loadApprovalAssets: async () => ({
				files: {
					'oauth.1111111111111111.css': new Uint8Array(),
					'oauth.2222222222222222.js': new Uint8Array(),
				},
				manifest: {
					css: 'oauth.1111111111111111.css',
					javascript: 'oauth.2222222222222222.js',
				},
			}),
			secretResolver: secretResolver(),
			selectedZoneIds: ['apollofam'],
			systemConfig: systemConfig(configDirectory),
			tailscaleLocalApiTransport: { getJson: localApiGetJson },
		});

		expect(prepared).toMatchObject({ port: 18_900, zoneId: 'apollofam' });
		if (prepared === undefined) throw new Error('Expected prepared OAuth runtime.');
		await expect(
			prepared.brokerService.executeAuthorizationAction({
				agentId: 'hermes',
				request: { actionId: 'oauth_authorization.list' },
			}),
		).resolves.toMatchObject({ kind: 'authorization-list' });
		await expect(
			access(
				path.join(
					testRoot,
					'controller-state',
					'zones',
					'apollofam',
					'oauth',
					'credentials.sqlite',
				),
			),
		).resolves.toBeUndefined();
		prepared.close();
		prepared.close();
	});

	it('remains disabled when the selected Hermes zone has no OAuth config', async () => {
		const configDirectory = path.join(testRoot, 'config', 'gateways', 'apollofam');
		await mkdir(configDirectory, { recursive: true });

		await expect(
			prepareControllerOAuthRuntime({
				secretResolver: secretResolver(),
				selectedZoneIds: ['apollofam'],
				systemConfig: systemConfig(configDirectory),
				tailscaleLocalApiTransport: { getJson: vi.fn() },
			}),
		).resolves.toBeUndefined();
	});
});
