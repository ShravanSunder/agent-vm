import { createHash } from 'node:crypto';
import { access } from 'node:fs/promises';
import path from 'node:path';

import {
	googleOAuthApplicationIds,
	loadOAuthConfig,
	loadToolPortalConfig,
	compileOAuthPolicy,
	type CompiledOAuthPolicy,
	type GoogleOAuthApplicationId,
	type OAuthConfig,
} from '@agent-vm/config-contracts';
import { loadOAuthApprovalAssetBundle } from '@agent-vm/oauth-approval-ui';
import {
	oauthKeyEncryptionKeySchema,
	openOAuthCredentialCatalog,
	createOAuthBrowserNavigationStore,
	createOAuthLoginContinuationStore,
	createOAuthPolicyEnvelopeCodec,
	oauthPolicyEnvelopeBindingSchema,
	type OAuthCredentialCatalog,
	type OAuthKeyEncryptionKey,
} from '@agent-vm/oauth-broker';
import { oauthStoredGrantSchema } from '@agent-vm/oauth-broker';
import {
	googleAccountPolicyBindingSchema,
	googleAccountPolicySnapshotSchema,
} from '@agent-vm/oauth-broker-contracts';
import {
	createGoogleOAuthAdapter,
	createGoogleOAuthBrokerService,
	parseGoogleWebClientCredentials,
	getGooglePolicyCatalog,
	readGoogleAccountPolicySnapshot,
	decryptGoogleCredentialPayload,
	type GoogleOAuthBrokerService,
	type GoogleWebClientCredentials,
} from '@agent-vm/oauth-broker/google';
import type { SecretRef, SecretResolver } from '@agent-vm/secret-management';

import { createKeyedAsyncLock } from '../credentialed-runtime/keyed-async-lock.js';
import type { GoogleAccountPolicyEditorProps } from './google-account-policy-editor.js';
import {
	createGooglePermissionPolicyService,
	type GooglePermissionPolicyService,
} from './google-permission-policy-service.js';
import { createOAuthHttpsApp, startOAuthHttpsServer } from './oauth-https-server.js';
import { assertOAuthListenerPortAvailable } from './oauth-listener-port-validation.js';
import { prepareClerkBrowserIdentity } from './prepare-clerk-browser-identity.js';
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
}): Promise<
	| {
			readonly config: OAuthConfig;
			readonly compiled: CompiledOAuthPolicy;
			readonly zoneId: string;
	  }
	| undefined
> {
	const configuredZones: {
		readonly config: OAuthConfig;
		readonly compiled: CompiledOAuthPolicy;
		readonly zoneId: string;
	}[] = [];
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
		if (oauthConfig.zoneId !== zoneId)
			throw new Error('OAuth config zone does not match its selected Hermes zone.');
		const compiled = compileOAuthPolicy({
			oauthConfig,
			toolPortalConfig,
			catalog: getGooglePolicyCatalog(),
		});
		configuredZones.push({ config: oauthConfig, compiled, zoneId });
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
		const credentials = parseGoogleWebClientCredentials({
			expectedRedirectUri,
			rawClientCredentials,
		});
		if (credentials.web.project_id !== application.projectId)
			throw new Error('Google client credentials do not match the configured project.');
		return credentials;
	};
	const [workspaceCredentials, gmailCredentials, youtubeCredentials] = await Promise.all([
		resolveApplication(googleOAuthApplicationIds[0]),
		resolveApplication(googleOAuthApplicationIds[1]),
		resolveApplication(googleOAuthApplicationIds[2]),
	]);
	if (
		new Set([
			workspaceCredentials.web.client_id,
			gmailCredentials.web.client_id,
			youtubeCredentials.web.client_id,
		]).size !== googleOAuthApplicationIds.length
	) {
		throw new Error(
			'OAuth applications must resolve to three distinct Google Web OAuth client IDs.',
		);
	}
	return {
		'gmail-app': gmailCredentials,
		'workspace-app': workspaceCredentials,
		'youtube-app': youtubeCredentials,
	};
}

export interface PreparedControllerOAuthRuntime {
	withPublicationGuard<TResult>(publish: () => Promise<TResult>): Promise<TResult>;
	readonly brokerService: GoogleOAuthBrokerService;
	readonly policyService: GooglePermissionPolicyService;
	readonly compiledOAuthPolicy: CompiledOAuthPolicy;
	readonly port: 18_900;
	readonly zoneId: string;
	close(): Promise<void>;
	drain(): Promise<void>;
	setContainmentHandlers(handlers: ControllerOAuthContainmentHandlers): void;
	activateAfterRuntimeCleanup(): void;
	startHttpsListener(): Promise<{ close(): Promise<void> }>;
	stopAdmission(): void;
}

export interface ControllerOAuthContainmentHandlers {
	readonly authorization: Parameters<
		typeof createGoogleOAuthBrokerService
	>[0]['containAuthorizationMaterial'];
	readonly policy: GoogleAccountPolicyEditorProps['containPolicyMaterial'];
}

export interface ControllerOAuthSystemConfig {
	readonly controllerStateDir: string;
	readonly host: {
		readonly controllerPort: number;
		readonly observability?:
			| { readonly enabled: false }
			| { readonly enabled: true; readonly ports: Readonly<Record<string, number>> }
			| undefined;
	};
	readonly tcpPool: { readonly basePort: number; readonly size: number };
	readonly zones: readonly {
		readonly gateway: { readonly port: number; readonly type: 'hermes' | 'worker' };
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
	const { config, compiled, zoneId } = selectedConfiguration;
	assertOAuthListenerPortAvailable({
		oauthPort: config.browser.listener.port,
		systemConfig: props.systemConfig,
	});
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
		const [
			encodedKeyEncryptionKey,
			clientCredentialsByApplication,
			assets,
			bindAddress,
			browserIdentityVerifier,
		] = await Promise.all([
			props.secretResolver.resolve(onePasswordSecretReference(config.storage.keyEncryptionKey)),
			resolveGoogleClientCredentials({ config, secretResolver: props.secretResolver }),
			(props.loadApprovalAssets ?? loadOAuthApprovalAssetBundle)(),
			resolveLocalTailscaleAddress({ transport }),
			prepareClerkBrowserIdentity({
				config: config.browser.identity,
				publicBaseUrl: config.browser.publicBaseUrl,
				secretResolver: props.secretResolver,
			}),
		]);
		let containmentHandlers: ControllerOAuthContainmentHandlers | undefined;
		let admissionOpen = false;
		let admissionStopped = false;
		const keyEncryptionKey = decodeKeyEncryptionKey(encodedKeyEncryptionKey);
		keyEncryptionKeyForCleanup = keyEncryptionKey;
		catalog.verifyOrInitializeKeyEncryptionKey(keyEncryptionKey);
		const bindingRevision = (applicationId: GoogleOAuthApplicationId): string =>
			createHash('sha256')
				.update(
					JSON.stringify([
						zoneId,
						applicationId,
						config.providers.google.applications[applicationId].catalogFamilyId,
						config.providers.google.applications[applicationId].projectId,
						clientCredentialsByApplication[applicationId].web.client_id,
						config.browser.publicBaseUrl,
					]),
				)
				.digest('hex');
		const clientBindingRevisionsByApplication = {
			'gmail-app': bindingRevision('gmail-app'),
			'workspace-app': bindingRevision('workspace-app'),
			'youtube-app': bindingRevision('youtube-app'),
		};
		const configRevision = createHash('sha256')
			.update(
				JSON.stringify([config, compiled.toolPortalConfig, clientBindingRevisionsByApplication]),
			)
			.digest('hex');
		const navigation = createOAuthBrowserNavigationStore();
		const loginContinuations = createOAuthLoginContinuationStore();
		const publicationLock = createKeyedAsyncLock();
		const runAuthorityCommit = async <TResult>(commit: () => TResult): Promise<TResult> =>
			await publicationLock.runExclusive(zoneId, async () => {
				if (!admissionOpen || admissionStopped)
					throw new Error('OAuth authority admission is closed.');
				return commit();
			});
		const policyService = createGooglePermissionPolicyService({
			runAuthorityCommit,
			catalog,
			compiled,
			configRevision,
			clientBindingRevisionsByApplication,
			keyEncryptionKey,
			keyEncryptionKeyVersion: 1,
			isAdmissionOpen: () => admissionOpen && !admissionStopped,
			verifySession: async (identity) => await browserIdentityVerifier.verifySession(identity),
			containPolicyMaterial: async (target) =>
				containmentHandlers === undefined ? 'failed' : await containmentHandlers.policy(target),
		});
		const brokerService = (props.createBrokerService ?? createGoogleOAuthBrokerService)({
			runAuthorityCommit,
			catalog,
			clientCredentialsByApplication,
			config,
			configRevision,
			clientBindingRevisionsByApplication,
			allowedHostsByApplication: compiled.allowedHostsByApplication,
			offeredGroupIdsByAgentApplication: compiled.offeredGroupIdsByAgentApplication,
			operationIdsByAgent: compiled.operationIdsByAgent,
			recommendationSelectionsByAgent: compiled.recommendationSelectionsByAgent,
			readAccountActivity: policyService.resolveActivityAvailability,
			isAdmissionOpen: () => admissionOpen && !admissionStopped,
			googleAdapter: createGoogleOAuthAdapter(),
			keyEncryptionKey,
			keyEncryptionKeyVersion: 1,
			containAuthorizationMaterial: async (target) =>
				containmentHandlers === undefined
					? 'failed'
					: await containmentHandlers.authorization(target),
		});
		brokerServiceForCleanup = brokerService;
		const app = (props.createHttpsApp ?? createOAuthHttpsApp)({
			assets,
			brokerService,
			config,
			browserIdentityVerifier,
			navigation,
			loginContinuations,
			policyService,
			isAdmissionOpen: () => admissionOpen && !admissionStopped,
			publicBaseUrl: config.browser.publicBaseUrl,
			tailnetIdentityResolver: createTailscaleLocalApiIdentityResolver({ transport }),
		});
		let closePromise: Promise<void> | undefined;
		const stopAdmission = (): void => {
			admissionStopped = true;
			admissionOpen = false;
			brokerService.stopAdmission();
			policyService.clear();
			navigation.clear();
			loginContinuations.clear();
		};
		return {
			brokerService,
			withPublicationGuard: async (publish) => await publicationLock.runExclusive(zoneId, publish),
			policyService,
			compiledOAuthPolicy: compiled,
			activateAfterRuntimeCleanup: (): void => {
				if (admissionStopped || containmentHandlers === undefined)
					throw new Error(
						'OAuth admission requires installed containment handlers and completed runtime cleanup.',
					);
				if (admissionOpen) return;
				catalog.activatePolicyDefaults({
					zoneId,
					defaultsRevision: compiled.defaultsRevision,
					snapshot: compiled.defaultsSnapshot,
				});
				const codec = createOAuthPolicyEnvelopeCodec({
					payloadSchema: googleAccountPolicySnapshotSchema,
				});
				for (const agentId of Object.keys(config.agents))
					for (const authorization of catalog.listAuthorizationsForAgent({ agentId, zoneId })) {
						const policy = catalog.getPolicy(authorization.authorizationId);
						const read = readGoogleAccountPolicySnapshot({
							binding: googleAccountPolicyBindingSchema.strip().parse(authorization),
							policy,
							keyEncryptionKey,
						});
						if (read.kind !== 'verified' || policy === undefined)
							throw new Error('OAuth policy recovery could not authenticate stored state.');
						if (read.snapshot.state === 'applying') {
							const active = googleAccountPolicySnapshotSchema.parse({
								...read.snapshot,
								state: 'active',
							});
							const result = catalog.activateAccountPolicy({
								before: read.snapshot,
								after: active,
								expectedTransitionId: policy.transitionId,
								envelope: codec.encrypt({
									binding: oauthPolicyEnvelopeBindingSchema.strip().parse(active),
									payload: active,
									keyEncryptionKey,
									keyEncryptionKeyVersion: 1,
								}),
							});
							if (result.kind !== 'updated')
								throw new Error('OAuth policy recovery could not record activation.');
						}
						if (
							authorization.accessState === 'replacing' ||
							authorization.accessState === 'disconnecting'
						) {
							if (authorization.accessState === 'replacing')
								decryptGoogleCredentialPayload({
									grant: oauthStoredGrantSchema.strip().parse(authorization),
									keyEncryptionKey,
								});
							if (
								catalog.settleAuthorizationTransition({
									authorizationId: authorization.authorizationId,
									expectedRecordRevision: authorization.recordRevision,
									transitionId: authorization.transitionId,
								}).kind !== 'updated'
							)
								throw new Error('OAuth authorization recovery could not settle stored state.');
						}
					}
				admissionOpen = true;
			},
			close: async (): Promise<void> => {
				stopAdmission();
				closePromise ??= (async (): Promise<void> => {
					try {
						// A publication already inside the guard must settle before its
						// catalog/key resources are closed. New admission is fenced above.
						await publicationLock.runExclusive(zoneId, async () => {});
						await Promise.all([brokerService.close(), policyService.drain()]);
					} finally {
						keyEncryptionKey.fill(0);
						brokerServiceForCleanup = undefined;
						keyEncryptionKeyForCleanup = undefined;
						catalog.close();
					}
				})();
				await closePromise;
			},
			drain: async (): Promise<void> => {
				stopAdmission();
				await publicationLock.runExclusive(zoneId, async () => {});
				await Promise.all([brokerService.drain(), policyService.drain()]);
			},
			port: config.browser.listener.port,
			setContainmentHandlers: (handlers): void => {
				if (admissionOpen || admissionStopped)
					throw new Error('OAuth containment handlers must be installed before admission.');
				containmentHandlers = handlers;
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
			stopAdmission,
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
