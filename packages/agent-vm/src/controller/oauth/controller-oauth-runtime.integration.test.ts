import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createGoogleOAuthBrokerService } from '@agent-vm/oauth-broker/google';
import type { SecretRef, SecretResolver } from '@agent-vm/secret-management';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createOAuthPolicyCompilerTestInput } from '../../../../config-contracts/src/oauth-policy-compiler-test-fixture.js';
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

function oauthConfig(): unknown {
	const input = createOAuthPolicyCompilerTestInput().oauthConfig;
	return {
		...input,
		zoneId: 'apollofam',
		browser: {
			...input.browser,
			listener: {
				...input.browser.listener,
				certificatePath: path.join(testRoot, 'tls.crt'),
				privateKeyPath: path.join(testRoot, 'tls.key'),
			},
		},
	};
}

function toolPortalConfig(): unknown {
	const input = createOAuthPolicyCompilerTestInput().toolPortalConfig;
	const google = input.profiles.shared.namespaces.google;
	return {
		...input,
		agents: {
			sun: {
				profile: 'shared',
				googlePolicyDefaults: {
					kind: 'explicit',
					applications: { 'gmail-app': { gmail: { read: 'allow', write: 'deny' } } },
				},
			},
			ember: input.agents.ember,
		},
		profiles: {
			shared: {
				namespaces: {
					...input.profiles.shared.namespaces,
					google: {
						...google,
						backend: {
							...google.backend,
							operations: {
								gog: {
									...google.backend.operations.gog,
									executionTarget: {
										...google.backend.operations.gog.executionTarget,
										allowedHosts: [
											'gmail.googleapis.com',
											'people.googleapis.com',
											'www.googleapis.com',
										],
									},
								},
							},
						},
					},
				},
			},
		},
	};
}

function systemConfig(configDirectory: string): ControllerOAuthSystemConfig {
	return {
		controllerStateDir: path.join(testRoot, 'controller-state'),
		host: { controllerPort: 18_800 },
		tcpPool: { basePort: 19_000, size: 5 },
		zones: [
			{
				gateway: { port: 18_792, type: 'hermes' },
				id: 'apollofam',
				toolPortal: { configDir: configDirectory },
			},
		],
	};
}

function secretResolver(options: { readonly duplicateClientIds?: boolean } = {}): SecretResolver {
	const callbackUrl = 'https://auth.claw.askluna.xyz:18900/oauth/google/callback';
	const resolve = vi.fn(async (reference: SecretRef) => {
		if (reference.source === '1password' && reference.ref.includes('wrapping-key')) {
			return Buffer.alloc(32, 41).toString('base64url');
		}
		if (reference.source === '1password' && reference.ref.includes('/clerk/'))
			return 'sk_test_fixture_only';
		const applicationIdentity = options.duplicateClientIds
			? 'shared'
			: reference.source === '1password' && reference.ref.includes('gmail')
				? 'gmail'
				: reference.source === '1password' && reference.ref.includes('workspace')
					? 'workspace'
					: 'youtube';
		return JSON.stringify({
			web: {
				project_id: 'synthetic-project',
				auth_uri: 'https://accounts.google.com/o/oauth2/v2/auth',
				client_id: `${applicationIdentity}-client-id`,
				client_secret: `${applicationIdentity}-client-secret`,
				redirect_uris: [callbackUrl],
				token_uri: 'https://oauth2.googleapis.com/token',
			},
		});
	});
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
	it('serializes publication with authority commits and drains publication before close', async () => {
		// Arrange: real runtime/SQLite composition, fake provider and browser edges.
		const configDirectory = path.join(testRoot, 'config');
		await mkdir(configDirectory);
		await writeFile(
			path.join(configDirectory, 'oauth.config.jsonc'),
			JSON.stringify(oauthConfig()),
		);
		await writeFile(
			path.join(configDirectory, 'tool-portal.config.jsonc'),
			JSON.stringify(toolPortalConfig()),
		);
		let runCommit: Parameters<typeof createGoogleOAuthBrokerService>[0]['runAuthorityCommit'];
		const prepared = await prepareControllerOAuthRuntime({
			createBrokerService: (brokerProps) => {
				runCommit = brokerProps.runAuthorityCommit;
				return createGoogleOAuthBrokerService(brokerProps);
			},
			loadApprovalAssets: async () => ({
				files: {},
				manifest: { css: 'oauth.css', javascript: 'oauth.js' },
			}),
			secretResolver: secretResolver(),
			selectedZoneIds: ['apollofam'],
			systemConfig: systemConfig(configDirectory),
			tailscaleLocalApiTransport: {
				getJson: async () => ({ Self: { TailscaleIPs: ['100.100.100.10'] } }),
			},
		});
		if (prepared === undefined || runCommit === undefined)
			throw new Error('Expected publication guard.');
		try {
			prepared.setContainmentHandlers({
				authorization: async () => 'contained',
				policy: async () => 'contained',
			});
			prepared.activateAfterRuntimeCleanup();
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			let committed = false;
			const publishing = prepared.withPublicationGuard(async () => {
				entered.resolve();
				await release.promise;
			});
			await entered.promise;
			// Act
			const commit = runCommit(() => {
				committed = true;
				return 'committed';
			});
			await Promise.resolve();
			// Assert
			expect(committed).toBe(false);
			release.resolve();
			await publishing;
			expect(await commit).toBe('committed');
			expect(committed).toBe(true);
			await expect(prepared.withPublicationGuard(async () => 'after-commit')).resolves.toBe(
				'after-commit',
			);
			const finalPublicationEntered = Promise.withResolvers<void>();
			const finishPublication = Promise.withResolvers<void>();
			const finalPublication = prepared.withPublicationGuard(async () => {
				finalPublicationEntered.resolve();
				await finishPublication.promise;
			});
			await finalPublicationEntered.promise;
			let closed = false;
			const closing = prepared.close().then(() => {
				closed = true;
			});
			try {
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(closed).toBe(false);
			} finally {
				finishPublication.resolve();
				await finalPublication;
				await closing;
			}
		} finally {
			await prepared.close();
		}
	});
	it('rejects an OAuth listener port inside the Managed runtime TCP pool before secrets resolve', async () => {
		const configDirectory = path.join(testRoot, 'config', 'gateways', 'apollofam');
		await mkdir(configDirectory, { recursive: true });
		await Promise.all([
			writeFile(path.join(configDirectory, 'oauth.config.jsonc'), JSON.stringify(oauthConfig())),
			writeFile(
				path.join(configDirectory, 'tool-portal.config.jsonc'),
				JSON.stringify(toolPortalConfig()),
			),
		]);
		const resolver: SecretResolver = {
			resolve: async () => {
				throw new Error('secret resolution must not start for a colliding port');
			},
			resolveAll: async () => ({}),
		};

		await expect(
			prepareControllerOAuthRuntime({
				secretResolver: resolver,
				selectedZoneIds: ['apollofam'],
				systemConfig: {
					...systemConfig(configDirectory),
					tcpPool: { basePort: 18_900, size: 1 },
				},
			}),
		).rejects.toThrow(/OAuth listener port 18900 collides/u);
	});

	it('rejects distinct references that resolve to one Google client ID', async () => {
		// Arrange
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

		// Act / Assert
		await expect(
			prepareControllerOAuthRuntime({
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
				secretResolver: secretResolver({ duplicateClientIds: true }),
				selectedZoneIds: ['apollofam'],
				systemConfig: systemConfig(configDirectory),
				tailscaleLocalApiTransport: { getJson: localApiGetJson },
			}),
		).rejects.toThrow(/distinct Google Web OAuth client IDs/u);
	});

	it('drains the broker and clears the KEK when preparation fails after broker creation', async () => {
		// Arrange
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
		const preparationFailure = new Error('approval application composition failed');
		const closeBroker = vi.fn();
		let capturedKeyEncryptionKey: Uint8Array | undefined;

		// Act / Assert
		await expect(
			prepareControllerOAuthRuntime({
				createBrokerService: (brokerProps) => {
					capturedKeyEncryptionKey = brokerProps.keyEncryptionKey;
					const brokerService = createGoogleOAuthBrokerService(brokerProps);
					return {
						...brokerService,
						close: async () => {
							closeBroker();
							await brokerService.close();
						},
					};
				},
				createHttpsApp: () => {
					throw preparationFailure;
				},
				loadApprovalAssets: async () => ({
					files: {},
					manifest: { css: 'oauth.css', javascript: 'oauth.js' },
				}),
				secretResolver: secretResolver(),
				selectedZoneIds: ['apollofam'],
				systemConfig: systemConfig(configDirectory),
				tailscaleLocalApiTransport: { getJson: localApiGetJson },
			}),
		).rejects.toBe(preparationFailure);
		expect(closeBroker).toHaveBeenCalledOnce();
		expect(capturedKeyEncryptionKey).toBeDefined();
		expect(capturedKeyEncryptionKey?.every((byte) => byte === 0)).toBe(true);

		const retry = await prepareControllerOAuthRuntime({
			loadApprovalAssets: async () => ({
				files: {},
				manifest: { css: 'oauth.css', javascript: 'oauth.js' },
			}),
			secretResolver: secretResolver(),
			selectedZoneIds: ['apollofam'],
			systemConfig: systemConfig(configDirectory),
			tailscaleLocalApiTransport: { getJson: localApiGetJson },
		});
		if (retry === undefined) throw new Error('Expected OAuth runtime retry to succeed.');
		await retry.close();
	});

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
		let capturedKeyEncryptionKey: Uint8Array | undefined;

		const prepared = await prepareControllerOAuthRuntime({
			createBrokerService: (brokerProps) => {
				capturedKeyEncryptionKey = brokerProps.keyEncryptionKey;
				return createGoogleOAuthBrokerService(brokerProps);
			},
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
				agentId: 'sun',
				request: { actionId: 'oauth_authorization.list' },
			}),
		).rejects.toThrow(/admission/u);
		expect(() => prepared.activateAfterRuntimeCleanup()).toThrow(/containment handlers/u);
		prepared.setContainmentHandlers({
			authorization: async () => 'contained',
			policy: async () => 'contained',
		});
		prepared.activateAfterRuntimeCleanup();
		await expect(
			prepared.brokerService.executeAuthorizationAction({
				agentId: 'sun',
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
		await prepared.close();
		await prepared.close();
		expect(capturedKeyEncryptionKey).toBeDefined();
		expect(capturedKeyEncryptionKey?.every((byte) => byte === 0)).toBe(true);
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
