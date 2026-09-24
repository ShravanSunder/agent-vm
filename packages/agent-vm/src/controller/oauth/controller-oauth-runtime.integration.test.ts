import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { OAuthConfig } from '@agent-vm/config-contracts';
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
	testRoot = await mkdtemp(path.join(tmpdir(), 'agent-vm-access-runtime-'));
});
afterEach(async () => {
	await rm(testRoot, { force: true, recursive: true });
});

function toolPortalConfig(): unknown {
	const input = createOAuthPolicyCompilerTestInput().toolPortalConfig;
	const google = input.profiles.shared.namespaces.google;
	return {
		...input,
		agents: { sun: { profile: 'shared' } },
		profiles: {
			shared: {
				...input.profiles.shared,
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

function runtimeOAuthConfig(): OAuthConfig {
	const oauth = createOAuthPolicyCompilerTestInput().oauthConfig;
	return {
		...oauth,
		zoneId: 'apollofam',
		owners: { owner: { ...oauth.owners.owner, allowedAgentIds: ['sun'] } },
		policyEditors: { editor: { ...oauth.policyEditors.editor, editableAgentIds: ['sun'] } },
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

function secretResolver(
	callbackUrl: string,
	options: { readonly duplicateClientIds?: boolean } = {},
): SecretResolver {
	const resolve = async (reference: SecretRef): Promise<string> => {
		if (reference.source === '1password' && reference.ref.includes('wrapping-key'))
			return Buffer.alloc(32, 41).toString('base64url');
		const identity = options.duplicateClientIds
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
				client_id: `${identity}-client-id`,
				client_secret: `${identity}-client-secret`,
				redirect_uris: [callbackUrl],
				token_uri: 'https://oauth2.googleapis.com/token',
			},
		});
	};
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

describe('controller Access OAuth runtime composition', () => {
	it('composes schema-v3 config, configured public origin, loopback listener port, and serialized authority publication', async () => {
		const configDirectory = path.join(testRoot, 'config');
		await mkdir(configDirectory);
		const oauth = createOAuthPolicyCompilerTestInput().oauthConfig;
		const configured = {
			...oauth,
			zoneId: 'apollofam',
			owners: { owner: { ...oauth.owners.owner, allowedAgentIds: ['sun'] } },
			policyEditors: { editor: { ...oauth.policyEditors.editor, editableAgentIds: ['sun'] } },
			browser: {
				...oauth.browser,
				publicBaseUrl: 'https://household.example.test',
				listener: { kind: 'loopback_http', port: 19_123 },
			},
		};
		await writeFile(path.join(configDirectory, 'oauth.config.jsonc'), JSON.stringify(configured));
		await writeFile(
			path.join(configDirectory, 'tool-portal.config.jsonc'),
			JSON.stringify(toolPortalConfig()),
		);
		let runCommit: Parameters<typeof createGoogleOAuthBrokerService>[0]['runAuthorityCommit'];
		const prepared = await prepareControllerOAuthRuntime({
			createBrokerService: (props) => {
				runCommit = props.runAuthorityCommit;
				return createGoogleOAuthBrokerService(props);
			},
			loadApprovalAssets: async () => ({
				files: {},
				manifest: { css: 'oauth.1111111111111111.css', javascript: 'oauth.2222222222222222.js' },
			}),
			secretResolver: secretResolver('https://household.example.test/oauth/google/callback'),
			selectedZoneIds: ['apollofam'],
			systemConfig: systemConfig(configDirectory),
		});
		if (prepared === undefined || runCommit === undefined)
			throw new Error('Expected prepared OAuth runtime.');
		try {
			expect(prepared.port).toBe(19_123);
			expect(() => prepared.activateAfterRuntimeCleanup()).toThrow(
				/OAuth admission requires installed containment handlers/u,
			);
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
			const commit = runCommit(() => {
				committed = true;
				return 'committed';
			});
			await Promise.resolve();
			expect(committed).toBe(false);
			release.resolve();
			await publishing;
			expect(await commit).toBe('committed');
			const closeEntered = Promise.withResolvers<void>();
			const releaseClose = Promise.withResolvers<void>();
			const guardedPublication = prepared.withPublicationGuard(async () => {
				closeEntered.resolve();
				await releaseClose.promise;
			});
			await closeEntered.promise;
			let closeCompleted = false;
			const closing = prepared.close().then(() => {
				closeCompleted = true;
			});
			await Promise.resolve();
			expect(closeCompleted).toBe(false);
			releaseClose.resolve();
			await Promise.all([guardedPublication, closing]);
			expect(closeCompleted).toBe(true);
		} finally {
			await prepared.close();
			await prepared.close();
		}
	});

	it('rejects a loopback listener port inside the managed runtime TCP pool before resolving secrets', async () => {
		const configDirectory = path.join(testRoot, 'config');
		await mkdir(configDirectory);
		await Promise.all([
			writeFile(
				path.join(configDirectory, 'oauth.config.jsonc'),
				JSON.stringify(runtimeOAuthConfig()),
			),
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

	it('rejects distinct application references that resolve to one Google client ID', async () => {
		const configDirectory = path.join(testRoot, 'config');
		await mkdir(configDirectory);
		const oauth = runtimeOAuthConfig();
		await Promise.all([
			writeFile(path.join(configDirectory, 'oauth.config.jsonc'), JSON.stringify(oauth)),
			writeFile(
				path.join(configDirectory, 'tool-portal.config.jsonc'),
				JSON.stringify(toolPortalConfig()),
			),
		]);

		await expect(
			prepareControllerOAuthRuntime({
				loadApprovalAssets: async () => ({
					files: {},
					manifest: {
						css: 'oauth.1111111111111111.css',
						javascript: 'oauth.2222222222222222.js',
					},
				}),
				secretResolver: secretResolver(oauth.browser.publicBaseUrl + '/oauth/google/callback', {
					duplicateClientIds: true,
				}),
				selectedZoneIds: ['apollofam'],
				systemConfig: systemConfig(configDirectory),
			}),
		).rejects.toThrow(/distinct Google Web OAuth client IDs/u);
	});

	it('drains the broker and zeroes the KEK when HTTP application composition fails', async () => {
		const configDirectory = path.join(testRoot, 'config');
		await mkdir(configDirectory);
		const configured = runtimeOAuthConfig();
		await Promise.all([
			writeFile(path.join(configDirectory, 'oauth.config.jsonc'), JSON.stringify(configured)),
			writeFile(
				path.join(configDirectory, 'tool-portal.config.jsonc'),
				JSON.stringify(toolPortalConfig()),
			),
		]);
		const preparationFailure = new Error('HTTP application composition failed');
		const closeBroker = vi.fn();
		let capturedKeyEncryptionKey: Uint8Array | undefined;

		await expect(
			prepareControllerOAuthRuntime({
				createBrokerService: (props) => {
					capturedKeyEncryptionKey = props.keyEncryptionKey;
					const broker = createGoogleOAuthBrokerService(props);
					return {
						...broker,
						close: async () => {
							closeBroker();
							await broker.close();
						},
					};
				},
				createHttpApp: () => {
					throw preparationFailure;
				},
				loadApprovalAssets: async () => ({
					files: {},
					manifest: {
						css: 'oauth.1111111111111111.css',
						javascript: 'oauth.2222222222222222.js',
					},
				}),
				secretResolver: secretResolver(`${configured.browser.publicBaseUrl}/oauth/google/callback`),
				selectedZoneIds: ['apollofam'],
				systemConfig: systemConfig(configDirectory),
			}),
		).rejects.toBe(preparationFailure);
		expect(closeBroker).toHaveBeenCalledOnce();
		expect(capturedKeyEncryptionKey).toBeDefined();
		expect(capturedKeyEncryptionKey?.every((byte) => byte === 0)).toBe(true);
		const retried = await prepareControllerOAuthRuntime({
			loadApprovalAssets: async () => ({
				files: {},
				manifest: { css: 'oauth.1111111111111111.css', javascript: 'oauth.2222222222222222.js' },
			}),
			secretResolver: secretResolver(`${configured.browser.publicBaseUrl}/oauth/google/callback`),
			selectedZoneIds: ['apollofam'],
			systemConfig: systemConfig(configDirectory),
		});
		if (retried === undefined)
			throw new Error('Expected successful retry after failed preparation.');
		await retried.close();
	});

	it('keeps catalog operations closed until activation and zeroes the KEK on close', async () => {
		const configDirectory = path.join(testRoot, 'config');
		await mkdir(configDirectory);
		const configured = runtimeOAuthConfig();
		await Promise.all([
			writeFile(path.join(configDirectory, 'oauth.config.jsonc'), JSON.stringify(configured)),
			writeFile(
				path.join(configDirectory, 'tool-portal.config.jsonc'),
				JSON.stringify(toolPortalConfig()),
			),
		]);
		let capturedKeyEncryptionKey: Uint8Array | undefined;
		const prepared = await prepareControllerOAuthRuntime({
			createBrokerService: (props) => {
				capturedKeyEncryptionKey = props.keyEncryptionKey;
				return createGoogleOAuthBrokerService(props);
			},
			loadApprovalAssets: async () => ({
				files: {},
				manifest: {
					css: 'oauth.1111111111111111.css',
					javascript: 'oauth.2222222222222222.js',
				},
			}),
			secretResolver: secretResolver(`${configured.browser.publicBaseUrl}/oauth/google/callback`),
			selectedZoneIds: ['apollofam'],
			systemConfig: systemConfig(configDirectory),
		});
		if (prepared === undefined) throw new Error('Expected prepared OAuth runtime.');
		await expect(
			prepared.brokerService.executeAuthorizationAction({
				agentId: 'sun',
				request: { actionId: 'oauth_authorization.list' },
			}),
		).rejects.toThrow(/admission/u);
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
		expect(capturedKeyEncryptionKey?.every((byte) => byte === 0)).toBe(true);
	});

	it('remains disabled when a selected managed zone does not require or define OAuth', async () => {
		const configDirectory = path.join(testRoot, 'config');
		await mkdir(configDirectory);
		await writeFile(
			path.join(configDirectory, 'tool-portal.config.jsonc'),
			JSON.stringify({
				agents: {},
				mode: 'managed',
				profiles: { default: { namespaces: {} } },
				schemaVersion: 1,
			}),
		);

		await expect(
			prepareControllerOAuthRuntime({
				secretResolver: secretResolver('https://unused.example.test/oauth/google/callback'),
				selectedZoneIds: ['apollofam'],
				systemConfig: systemConfig(configDirectory),
			}),
		).resolves.toBeUndefined();
	});
});
