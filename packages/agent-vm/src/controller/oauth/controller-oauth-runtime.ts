import { access } from 'node:fs/promises';
import path from 'node:path';

import {
	googleOAuthApplicationIds,
	loadOAuthConfig,
	loadToolPortalConfig,
	validateOAuthToolPortalConfigPair,
	type GoogleOAuthApplicationId,
	type OAuthConfig,
} from '@agent-vm/config-contracts';
import { loadOAuthApprovalAssetBundle } from '@agent-vm/oauth-approval-ui';
import {
	oauthKeyEncryptionKeySchema,
	openOAuthCredentialCatalog,
	type OAuthCredentialCatalog,
	type OAuthKeyEncryptionKey,
} from '@agent-vm/oauth-broker';
import {
	createGoogleOAuthAdapter,
	createGoogleOAuthBrokerService,
	parseGoogleWebClientCredentials,
	type GoogleOAuthBrokerService,
	type GoogleWebClientCredentials,
} from '@agent-vm/oauth-broker/google';
import type { SecretRef, SecretResolver } from '@agent-vm/secret-management';

import { createOAuthHttpsApp, startOAuthHttpsServer } from './oauth-https-server.js';
import {
	createTailscaleLocalApiIdentityResolver,
	createTailscaleUnixSocketTransport,
	resolveLocalTailscaleAddress,
	type TailscaleLocalApiTransport,
} from './tailscale-local-api-identity-resolver.js';

const oauthConfigFileName = 'oauth.config.jsonc';
const toolPortalConfigFileName = 'tool-portal.config.jsonc';
const oauthCatalogRelativePath = path.join('oauth', 'credentials.sqlite');

function isMissingFileError(error: unknown): boolean {
	return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function onePasswordSecretReference(reference: {
	readonly ref: string;
	readonly source: '1password';
}): SecretRef {
	return { ref: reference.ref, source: reference.source };
}

function decodeKeyEncryptionKey(encodedKey: string): OAuthKeyEncryptionKey {
	const decodedKey = Uint8Array.from(Buffer.from(encodedKey, 'base64url'));
	if (Buffer.from(decodedKey).toString('base64url') !== encodedKey) {
		throw new Error('OAuth key-encryption key must use canonical base64url encoding.');
	}
	return oauthKeyEncryptionKeySchema.parse(decodedKey);
}

async function loadSelectedOAuthConfiguration(props: {
	readonly selectedZoneIds: readonly string[];
	readonly systemConfig: ControllerOAuthSystemConfig;
}): Promise<{ readonly config: OAuthConfig; readonly zoneId: string } | undefined> {
	const configuredZones: { readonly config: OAuthConfig; readonly zoneId: string }[] = [];
	for (const zoneId of props.selectedZoneIds) {
		const zone = props.systemConfig.zones.find((candidate) => candidate.id === zoneId);
		if (zone?.gateway.type !== 'hermes' || zone.toolPortal === undefined) continue;
		const oauthConfigPath = path.join(zone.toolPortal.configDir, oauthConfigFileName);
		try {
			// oxlint-disable-next-line no-await-in-loop -- selected zone config discovery is bounded and preserves deterministic diagnostics.
			await access(oauthConfigPath);
		} catch (error) {
			if (isMissingFileError(error)) continue;
			throw error;
		}
		// oxlint-disable-next-line no-await-in-loop -- each selected zone owns a distinct authored config pair.
		const [oauthConfig, toolPortalConfig] = await Promise.all([
			loadOAuthConfig(oauthConfigPath),
			loadToolPortalConfig(path.join(zone.toolPortal.configDir, toolPortalConfigFileName)),
		]);
		validateOAuthToolPortalConfigPair({ oauthConfig, toolPortalConfig });
		configuredZones.push({ config: oauthConfig, zoneId });
	}
	if (configuredZones.length > 1) {
		throw new Error('One controller process can host OAuth for exactly one selected Hermes zone.');
	}
	return configuredZones[0];
}

async function resolveGoogleClientCredentials(props: {
	readonly config: OAuthConfig;
	readonly secretResolver: SecretResolver;
}): Promise<Readonly<Record<GoogleOAuthApplicationId, GoogleWebClientCredentials>>> {
	const expectedRedirectUri = new URL(
		'/oauth/google/callback',
		props.config.browser.publicBaseUrl,
	).toString();
	const resolveApplication = async (
		applicationId: GoogleOAuthApplicationId,
	): Promise<GoogleWebClientCredentials> => {
		const application = props.config.providers.google.applications[applicationId];
		const rawClientCredentials = await props.secretResolver.resolve(
			onePasswordSecretReference(application.clientCredentials),
		);
		return parseGoogleWebClientCredentials({ expectedRedirectUri, rawClientCredentials });
	};
	const [workspaceCredentials, gmailCredentials, youtubeCredentials] = await Promise.all([
		resolveApplication(googleOAuthApplicationIds[0]),
		resolveApplication(googleOAuthApplicationIds[1]),
		resolveApplication(googleOAuthApplicationIds[2]),
	]);
	return {
		'gmail-app': gmailCredentials,
		'workspace-app': workspaceCredentials,
		'youtube-app': youtubeCredentials,
	};
}

export interface PreparedControllerOAuthRuntime {
	readonly brokerService: GoogleOAuthBrokerService;
	readonly port: 18_900;
	readonly zoneId: string;
	close(): Promise<void>;
	setCredentialInvalidationHandler(
		handler: (props: { readonly agentId: string; readonly zoneId: string }) => Promise<void>,
	): void;
	startHttpsListener(): Promise<{ close(): Promise<void> }>;
	stopAdmission(): void;
}

export interface ControllerOAuthSystemConfig {
	readonly controllerStateDir: string;
	readonly zones: readonly {
		readonly gateway: { readonly type: 'hermes' | 'worker' };
		readonly id: string;
		readonly toolPortal?: { readonly configDir: string } | undefined;
	}[];
}

export async function prepareControllerOAuthRuntime(props: {
	readonly createBrokerService?: typeof createGoogleOAuthBrokerService;
	readonly createHttpsApp?: typeof createOAuthHttpsApp;
	readonly secretResolver: SecretResolver;
	readonly selectedZoneIds: readonly string[];
	readonly systemConfig: ControllerOAuthSystemConfig;
	readonly loadApprovalAssets?: typeof loadOAuthApprovalAssetBundle;
	readonly tailscaleLocalApiTransport?: TailscaleLocalApiTransport | undefined;
}): Promise<PreparedControllerOAuthRuntime | undefined> {
	const selectedConfiguration = await loadSelectedOAuthConfiguration(props);
	if (selectedConfiguration === undefined) return undefined;
	const { config, zoneId } = selectedConfiguration;
	const catalog: OAuthCredentialCatalog = await openOAuthCredentialCatalog({
		databasePath: path.join(
			props.systemConfig.controllerStateDir,
			'zones',
			zoneId,
			oauthCatalogRelativePath,
		),
	});
	let brokerServiceForCleanup: GoogleOAuthBrokerService | undefined;
	let keyEncryptionKeyForCleanup: OAuthKeyEncryptionKey | undefined;
	try {
		const transport = props.tailscaleLocalApiTransport ?? createTailscaleUnixSocketTransport();
		const [encodedKeyEncryptionKey, clientCredentialsByApplication, assets, bindAddress] =
			await Promise.all([
				props.secretResolver.resolve(onePasswordSecretReference(config.storage.keyEncryptionKey)),
				resolveGoogleClientCredentials({ config, secretResolver: props.secretResolver }),
				(props.loadApprovalAssets ?? loadOAuthApprovalAssetBundle)(),
				resolveLocalTailscaleAddress({ transport }),
			]);
		let credentialInvalidationHandler: (props: {
			readonly agentId: string;
			readonly zoneId: string;
		}) => Promise<void> = async () => undefined;
		const keyEncryptionKey = decodeKeyEncryptionKey(encodedKeyEncryptionKey);
		keyEncryptionKeyForCleanup = keyEncryptionKey;
		catalog.verifyOrInitializeKeyEncryptionKey(keyEncryptionKey);
		const brokerService = (props.createBrokerService ?? createGoogleOAuthBrokerService)({
			catalog,
			clientCredentialsByApplication,
			config,
			googleAdapter: createGoogleOAuthAdapter(),
			keyEncryptionKey,
			keyEncryptionKeyVersion: 1,
			onCredentialMaterialChanged: async (event) => await credentialInvalidationHandler(event),
			zoneId,
		});
		brokerServiceForCleanup = brokerService;
		const app = (props.createHttpsApp ?? createOAuthHttpsApp)({
			assets,
			brokerService,
			publicBaseUrl: config.browser.publicBaseUrl,
			tailnetIdentityResolver: createTailscaleLocalApiIdentityResolver({ transport }),
		});
		let closePromise: Promise<void> | undefined;
		let admissionStopped = false;
		return {
			brokerService,
			close: async (): Promise<void> => {
				closePromise ??= (async (): Promise<void> => {
					try {
						await brokerService.close();
					} finally {
						keyEncryptionKey.fill(0);
						brokerServiceForCleanup = undefined;
						keyEncryptionKeyForCleanup = undefined;
						catalog.close();
					}
				})();
				await closePromise;
			},
			port: config.browser.listener.port,
			setCredentialInvalidationHandler: (handler): void => {
				credentialInvalidationHandler = handler;
			},
			startHttpsListener: async () =>
				await startOAuthHttpsServer({
					app,
					bindAddress,
					certificatePath: config.browser.listener.certificatePath,
					port: config.browser.listener.port,
					privateKeyPath: config.browser.listener.privateKeyPath,
					publicHostname: new URL(config.browser.publicBaseUrl).hostname,
				}),
			stopAdmission: (): void => {
				if (admissionStopped) return;
				admissionStopped = true;
				brokerService.stopAdmission();
			},
			zoneId,
		};
	} catch (error) {
		const cleanupErrors: unknown[] = [];
		try {
			await brokerServiceForCleanup?.close();
		} catch (cleanupError) {
			cleanupErrors.push(cleanupError);
		} finally {
			keyEncryptionKeyForCleanup?.fill(0);
			try {
				catalog.close();
			} catch (cleanupError) {
				cleanupErrors.push(cleanupError);
			}
		}
		if (cleanupErrors.length > 0) {
			throw new AggregateError(
				[error, ...cleanupErrors],
				'OAuth runtime preparation failed and resource cleanup was incomplete.',
				{ cause: error },
			);
		}
		throw error;
	}
}
