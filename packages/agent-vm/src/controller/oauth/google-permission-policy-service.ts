import { isDeepStrictEqual } from 'node:util';

import {
	googleOAuthApplicationIdSchema,
	controllerConfiguredCliInputSchema,
	configuredGoogleOperationKey,
	isControllerEphemeralManagedVmConfiguredCliOperation,
	resolveCompiledGoogleCommand,
	toolPortalNamespaceAllowsOperation,
	type ControllerConfiguredCliInput,
	type CompiledOAuthPolicy,
	type GoogleOAuthApplicationId,
} from '@agent-vm/config-contracts';
import {
	oauthStoredGrantSchema,
	type OAuthAccountPolicyChangeEvent,
	type OAuthCredentialCatalog,
	type OAuthKeyEncryptionKey,
	type OAuthStoredAuthorization,
} from '@agent-vm/oauth-broker';
import {
	googleAccountPolicyBindingSchema,
	oauthApplicationIdSchema,
	oauthAccountIdSchema,
	oauthBrowserSessionIdentitySchema,
	oauthServiceIdSchema,
	managedGooglePreflightResultSchema,
	type ManagedGooglePreflightResult,
	type ManagedGoogleInvocationBinding,
	type OAuthOperationToolRequirement,
	type OAuthOperationAvailability,
	type OAuthAccountToolOption,
	type GoogleAccountPolicySnapshot,
	type GoogleOperationEffect,
	type OAuthAccountActivityAvailability,
} from '@agent-vm/oauth-broker-contracts';
import {
	decryptGoogleCredentialPayload,
	evaluateGoogleOperationGrant,
	getGooglePolicyCatalog,
	readGoogleAccountPolicySnapshot,
	type GoogleOAuthAccountActivityReader,
} from '@agent-vm/oauth-broker/google';
import {
	resolveGoogleAccountInvocationPolicy,
	validateCliAllowanceInvocation,
} from '@agent-vm/tool-portal';
import { z } from 'zod';

import {
	createGoogleAccountPolicyEditor,
	type GoogleAccountPolicyEditor,
	type GoogleAccountPolicyEditorProps,
} from './google-account-policy-editor.js';

const policyTargetSchema = z
	.object({
		agentId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/u),
		accountId: oauthAccountIdSchema,
		applicationId: googleOAuthApplicationIdSchema.and(oauthApplicationIdSchema),
	})
	.strict();
const policyViewRequestSchema = policyTargetSchema
	.extend({ identity: oauthBrowserSessionIdentitySchema })
	.strict();
type PolicyTarget = z.infer<typeof policyTargetSchema>;
type PolicyViewRequest = z.infer<typeof policyViewRequestSchema>;
type ServiceEffects = Record<string, readonly GoogleOperationEffect[]>;
export type GoogleAccountPolicyView =
	| { readonly kind: 'denied' | 'unavailable' }
	| {
			readonly kind: 'ready';
			readonly canEdit: boolean;
			readonly accountAlias: string;
			readonly applicationLabel: string;
			readonly ownerLabel: string;
			readonly activities: readonly {
				readonly operationId: string;
				readonly availability: OAuthAccountActivityAvailability;
			}[];
			readonly snapshot: GoogleAccountPolicySnapshot;
			readonly configRevision: string;
			readonly defaultsRevision: string;
			readonly defaults: NonNullable<
				CompiledOAuthPolicy['defaultsByAgentApplication'][string][GoogleOAuthApplicationId]
			>;
			readonly maximums: Readonly<ServiceEffects>;
			readonly history: readonly OAuthAccountPolicyChangeEvent[];
	  };
export interface GooglePermissionPolicyService extends GoogleAccountPolicyEditor {
	resolveOperationAvailability(request: {
		readonly agentId: string;
		readonly requirement: OAuthOperationToolRequirement;
	}): OAuthOperationAvailability;
	resolveManagedGoogleInvocation(
		request: ManagedGoogleInvocationRequest,
	): ManagedGooglePreflightResult;
	readCurrentPolicyForDispatch(props: {
		readonly request: ManagedGoogleInvocationRequest;
		readonly expected: ManagedGoogleInvocationBinding;
	}): boolean;
	listOwnerAccounts(
		identity: Parameters<GooglePermissionPolicyService['readAccountPolicyView']>[0]['identity'],
	): readonly {
		readonly agentId: string;
		readonly accounts: readonly {
			readonly accountId: GoogleAccountPolicySnapshot['accountId'];
			readonly accountAlias: string;
			readonly applicationIds: readonly GoogleAccountPolicySnapshot['applicationId'][];
		}[];
	}[];
	/** Internal host input: identity comes from the verified browser context, never form fields. */
	readAccountPolicyView(request: PolicyViewRequest): GoogleAccountPolicyView;
	/** Advisory activity result, not an exact-argv execution authorization. Never refreshes tokens. */
	resolveActivityAvailability: GoogleOAuthAccountActivityReader;
}
export interface ManagedGoogleInvocationRequest {
	readonly agentId: string;
	readonly profileId: string;
	readonly namespaceId: string;
	readonly operationName: string;
	readonly input: ControllerConfiguredCliInput;
}
export interface GooglePermissionPolicyServiceProps extends Pick<
	GoogleAccountPolicyEditorProps,
	| 'verifySession'
	| 'containPolicyMaterial'
	| 'keyEncryptionKeyVersion'
	| 'now'
	| 'runAuthorityCommit'
> {
	readonly catalog: OAuthCredentialCatalog;
	readonly compiled: CompiledOAuthPolicy;
	readonly configRevision: string;
	readonly clientBindingRevisionsByApplication: Readonly<Record<GoogleOAuthApplicationId, string>>;
	readonly keyEncryptionKey: OAuthKeyEncryptionKey;
	readonly isAdmissionOpen: () => boolean;
}

/** Host joins authenticated SQLite state and compiled policy; Portal owns the pure evaluator. */
export function createGooglePermissionPolicyService(
	props: GooglePermissionPolicyServiceProps,
): GooglePermissionPolicyService {
	const config = props.compiled.oauthConfig;
	const policyCatalog = getGooglePolicyCatalog();
	const operations = new Map(
		policyCatalog.operations.map((operation) => [operation.operationId, operation]),
	);
	const ownerAdmitted = (owner: OAuthStoredAuthorization['owner'], agentId: string): boolean =>
		owner.issuer === config.browser.identity.issuer &&
		Object.values(config.owners).some(
			(admission) =>
				admission.clerkUserId === owner.userId && admission.allowedAgentIds.includes(agentId),
		);
	const defaultsActive = (): boolean =>
		props.isAdmissionOpen() &&
		props.catalog.getPolicyDefaultsActivation(config.zoneId)?.activeDefaultsDigest ===
			props.compiled.defaultsRevision;
	const readAuthorization = (target: PolicyTarget): OAuthStoredAuthorization | undefined => {
		const authorization = props.catalog.getAuthorizationForAccountApplication({
			...target,
			zoneId: config.zoneId,
		});
		if (
			authorization === undefined ||
			authorization.zoneId !== config.zoneId ||
			authorization.agentId !== target.agentId ||
			authorization.accountId !== target.accountId ||
			authorization.applicationId !== target.applicationId ||
			!ownerAdmitted(authorization.owner, target.agentId)
		)
			return undefined;
		return authorization;
	};
	const readPolicy = (
		authorization: OAuthStoredAuthorization,
	): ReturnType<typeof readGoogleAccountPolicySnapshot> =>
		readGoogleAccountPolicySnapshot({
			binding: googleAccountPolicyBindingSchema.strip().parse(authorization),
			policy: props.catalog.getPolicy(authorization.authorizationId),
			keyEncryptionKey: props.keyEncryptionKey,
		});
	const maximumsFor = (target: PolicyTarget, operationId?: string): ServiceEffects => {
		const applicationId = googleOAuthApplicationIdSchema.parse(target.applicationId);
		const family = config.providers.google.applications[applicationId].catalogFamilyId;
		const offered = new Set(
			props.compiled.offeredGroupIdsByAgentApplication[target.agentId]?.[applicationId] ?? [],
		);
		const maximums: ServiceEffects = {};
		for (const group of policyCatalog.groups) {
			if (
				group.familyId !== family ||
				!offered.has(group.groupId) ||
				(operationId !== undefined && !group.operationIds.includes(operationId))
			)
				continue;
			maximums[group.serviceId] = [
				...new Set([...(maximums[group.serviceId] ?? []), group.effect]),
			];
		}
		return maximums;
	};
	const reader: Pick<
		GooglePermissionPolicyService,
		| 'readAccountPolicyView'
		| 'resolveActivityAvailability'
		| 'listOwnerAccounts'
		| 'resolveManagedGoogleInvocation'
		| 'readCurrentPolicyForDispatch'
		| 'resolveOperationAvailability'
	> = {
		resolveOperationAvailability: ({ agentId, requirement }) => {
			const application = googleOAuthApplicationIdSchema.safeParse(requirement.applicationId);
			if (
				!application.success ||
				!props.compiled.operationIdsByAgent[agentId]?.includes(requirement.operationId) ||
				operations.get(requirement.operationId)?.familyId !==
					config.providers.google.applications[application.data].catalogFamilyId
			)
				return { kind: 'unavailable' };
			try {
				if (!defaultsActive()) return { kind: 'unavailable' };
				const authorizations = props.catalog
					.listAuthorizationsForAgent({ agentId, zoneId: config.zoneId })
					.filter(
						(authorization) =>
							authorization.applicationId === requirement.applicationId &&
							ownerAdmitted(authorization.owner, agentId),
					);
				if (authorizations.length > 256) return { kind: 'unavailable' };
				const accounts = authorizations.map((authorization): OAuthAccountToolOption => {
					let metadata: OAuthAccountToolOption['metadata'] = { kind: 'unavailable' };
					if (
						authorization.accessState === 'connected' ||
						authorization.accessState === 'replacing'
					) {
						try {
							metadata = {
								kind: 'verified',
								accountAlias: decryptGoogleCredentialPayload({
									grant: oauthStoredGrantSchema.strip().parse(authorization),
									keyEncryptionKey: props.keyEncryptionKey,
								}).authority.accountAlias,
							};
						} catch {
							/* Keep unauthenticated hints out of discovery. */
						}
					}
					return {
						accountId: authorization.accountId,
						metadata,
						availability: reader.resolveActivityAvailability({
							agentId,
							accountId: authorization.accountId,
							applicationId: requirement.applicationId,
							operationId: requirement.operationId,
						}),
					};
				});
				return { kind: 'accounts', accounts };
			} catch {
				return { kind: 'unavailable' };
			}
		},
		resolveManagedGoogleInvocation: (request) => {
			if (props.compiled.toolPortalConfig.agents[request.agentId]?.profile !== request.profileId)
				return { kind: 'denied' };
			const namespace =
				props.compiled.toolPortalConfig.profiles[request.profileId]?.namespaces[
					request.namespaceId
				];
			if (
				namespace?.backend.kind !== 'controller_execution' ||
				!toolPortalNamespaceAllowsOperation(namespace, request.operationName)
			)
				return { kind: 'denied' };
			const operation = namespace.backend.operations[request.operationName];
			const commandSet =
				props.compiled.commandSetsByConfiguredOperation[
					configuredGoogleOperationKey(
						request.profileId,
						request.namespaceId,
						request.operationName,
					)
				];
			const input = controllerConfiguredCliInputSchema.safeParse(request.input);
			if (
				operation?.kind !== 'configured_cli' ||
				!isControllerEphemeralManagedVmConfiguredCliOperation(operation) ||
				operation.authorization?.kind !== 'oauth_account' ||
				commandSet === undefined ||
				!input.success
			)
				return { kind: 'denied' };
			try {
				if (!defaultsActive()) return { kind: 'unavailable' };
				const shape = validateCliAllowanceInvocation({ allowance: operation, input: input.data });
				if (!shape.ok || shape.matchedDenyRule) return { kind: 'denied' };
				const resolved = resolveCompiledGoogleCommand(commandSet, input.data.argv);
				if (resolved.kind === 'denied') return { kind: 'denied' };
				if (resolved.kind === 'no-oauth')
					return { kind: 'no-oauth', commandTableRevision: commandSet.revision };
				if (!('accountId' in input.data)) return { kind: 'denied' };
				const applicationId = googleOAuthApplicationIdSchema.parse(
					commandSet.applicationIdsByFamily[resolved.familyId],
				);
				const target = policyTargetSchema.parse({
					agentId: request.agentId,
					accountId: input.data.accountId,
					applicationId,
				});
				const activity = reader.resolveActivityAvailability({
					...target,
					operationId: resolved.operationId,
				});
				if (activity.kind !== 'ready') return activity;
				const authorization = readAuthorization(target);
				if (authorization?.accessState !== 'connected') return { kind: 'unavailable' };
				const policy = readPolicy(authorization);
				if (policy.kind !== 'verified' || policy.snapshot.state !== 'active')
					return { kind: 'unavailable' };
				const payload = decryptGoogleCredentialPayload({
					grant: oauthStoredGrantSchema.strip().parse(authorization),
					keyEncryptionKey: props.keyEncryptionKey,
				});
				const gmail = oauthServiceIdSchema.parse('gmail');
				const writeCell = policy.snapshot.services[gmail]?.write;
				const gmailWrite =
					writeCell?.kind === 'explicit'
						? writeCell.disposition
						: (props.compiled.defaultsByAgentApplication[request.agentId]?.[applicationId]?.[gmail]
								?.write ?? 'deny');
				const gmailWriteAllowed =
					gmailWrite !== 'deny' &&
					payload.authority.selectedGroupIds.includes('gmail.write') &&
					(
						props.compiled.offeredGroupIdsByAgentApplication[request.agentId]?.[applicationId] ?? []
					).includes('gmail.write');
				return managedGooglePreflightResultSchema.parse({
					kind: 'ready',
					disposition: activity.disposition,
					binding: {
						accountId: authorization.accountId,
						applicationId: authorization.applicationId,
						authorizationId: authorization.authorizationId,
						generation: authorization.generation,
						authorizationMetadataRevision: authorization.authorizationMetadataRevision,
						overrideRevision: policy.snapshot.overrideRevision,
						defaultsRevision: props.compiled.defaultsRevision,
						configRevision: props.configRevision,
						clientBindingRevision: authorization.clientBindingRevision,
						catalogVersion: authorization.catalogVersion,
						commandTableRevision: commandSet.revision,
						operationId: resolved.operationId,
						gmailWriteAllowed,
					},
					display: {
						accountId: authorization.accountId,
						authorizationId: authorization.authorizationId,
						accountAlias: payload.authority.accountAlias,
						applicationLabel: config.providers.google.applications[applicationId].label,
						authorizationMetadataRevision: authorization.authorizationMetadataRevision,
					},
				});
			} catch {
				return { kind: 'unavailable' };
			}
		},
		readCurrentPolicyForDispatch: ({ request, expected }) => {
			const current = reader.resolveManagedGoogleInvocation(request);
			return current.kind === 'ready' && isDeepStrictEqual(current.binding, expected);
		},
		listOwnerAccounts: (identity) => {
			if (!oauthBrowserSessionIdentitySchema.safeParse(identity).success || !defaultsActive())
				return [];
			return Object.keys(config.agents)
				.filter((agentId) => ownerAdmitted(identity, agentId))
				.map((agentId) => {
					const owned = props.catalog
						.listAuthorizationsForAgent({ agentId, zoneId: config.zoneId })
						.filter(
							(authorization) =>
								authorization.owner.issuer === identity.issuer &&
								authorization.owner.userId === identity.userId,
						);
					const accounts = new Map<
						GoogleAccountPolicySnapshot['accountId'],
						{
							accountId: GoogleAccountPolicySnapshot['accountId'];
							accountAlias: string;
							applicationIds: GoogleAccountPolicySnapshot['applicationId'][];
						}
					>();
					for (const authorization of owned) {
						const applicationId = googleOAuthApplicationIdSchema
							.and(oauthApplicationIdSchema)
							.parse(authorization.applicationId);
						const view = reader.readAccountPolicyView({
							identity,
							agentId,
							accountId: authorization.accountId,
							applicationId,
						});
						if (view.kind !== 'ready') continue;
						const account = accounts.get(authorization.accountId) ?? {
							accountId: authorization.accountId,
							accountAlias: view.accountAlias,
							applicationIds: [],
						};
						account.applicationIds.push(authorization.applicationId);
						accounts.set(authorization.accountId, account);
					}
					return { agentId, accounts: [...accounts.values()] };
				});
		},
		readAccountPolicyView: (request): GoogleAccountPolicyView => {
			const parsed = policyViewRequestSchema.safeParse(request);
			if (!parsed.success || !ownerAdmitted(parsed.data.identity, parsed.data.agentId))
				return { kind: 'denied' };
			try {
				if (!defaultsActive()) return { kind: 'unavailable' };
				const target = policyTargetSchema.parse({
					agentId: parsed.data.agentId,
					accountId: parsed.data.accountId,
					applicationId: parsed.data.applicationId,
				});
				const authorization = readAuthorization(target);
				const applicationId = googleOAuthApplicationIdSchema.parse(target.applicationId);
				if (
					authorization === undefined ||
					authorization.owner.issuer !== parsed.data.identity.issuer ||
					authorization.owner.userId !== parsed.data.identity.userId
				)
					return { kind: 'denied' };
				const policy = readPolicy(authorization);
				if (policy.kind !== 'verified') return { kind: 'unavailable' };
				const canEdit = Object.values(config.policyEditors).some(
					(editor) =>
						editor.clerkUserId === parsed.data.identity.userId &&
						editor.editableAgentIds.includes(target.agentId),
				);
				let accountAlias = 'Account metadata unavailable';
				if (
					authorization.accessState === 'connected' ||
					authorization.accessState === 'replacing'
				) {
					try {
						accountAlias = decryptGoogleCredentialPayload({
							grant: oauthStoredGrantSchema.strip().parse(authorization),
							keyEncryptionKey: props.keyEncryptionKey,
						}).authority.accountAlias;
					} catch {
						/* Unauthenticated metadata is never displayed as the account identity. */
					}
				}
				return {
					kind: 'ready',
					canEdit,
					accountAlias,
					applicationLabel: config.providers.google.applications[applicationId].label,
					ownerLabel:
						Object.values(config.owners).find(
							(owner) => owner.clerkUserId === parsed.data.identity.userId,
						)?.label ?? 'Account owner',
					activities: (props.compiled.operationIdsByAgent[target.agentId] ?? [])
						.filter(
							(operationId) =>
								operations.get(operationId)?.familyId ===
								config.providers.google.applications[applicationId].catalogFamilyId,
						)
						.map((operationId) => ({
							operationId,
							availability: reader.resolveActivityAvailability({ ...target, operationId }),
						})),
					snapshot: policy.snapshot,
					configRevision: props.configRevision,
					defaultsRevision: props.compiled.defaultsRevision,
					defaults: structuredClone(
						props.compiled.defaultsByAgentApplication[target.agentId]?.[applicationId] ?? {},
					),
					maximums: maximumsFor(target),
					history: canEdit
						? props.catalog.listAccountPolicyHistory(authorization.authorizationId)
						: [],
				};
			} catch {
				return { kind: 'unavailable' };
			}
		},
		resolveActivityAvailability: (request): OAuthAccountActivityAvailability => {
			const parsed = policyTargetSchema.safeParse({
				agentId: request.agentId,
				accountId: request.accountId,
				applicationId: request.applicationId,
			});
			if (!parsed.success) return { kind: 'unavailable' };
			const target = parsed.data;
			const applicationId = googleOAuthApplicationIdSchema.parse(target.applicationId);
			const operation = operations.get(request.operationId);
			const familyId = config.providers.google.applications[applicationId].catalogFamilyId;
			if (
				operation === undefined ||
				operation.familyId !== familyId ||
				!props.compiled.operationIdsByAgent[target.agentId]?.includes(request.operationId)
			)
				return { kind: 'denied' };
			try {
				if (!defaultsActive()) return { kind: 'unavailable' };
				const authorization = readAuthorization(target);
				if (authorization === undefined) return { kind: 'unavailable' };
				const policy = readPolicy(authorization);
				if (policy.kind !== 'verified' || policy.snapshot.state !== 'active')
					return { kind: 'unavailable' };
				if (
					authorization.accessState === 'replacing' ||
					authorization.accessState === 'disconnecting'
				)
					return { kind: 'unavailable' };
				const grants: ServiceEffects = {};
				if (authorization.accessState === 'connected') {
					if (
						authorization.catalogVersion !== config.providers.google.catalogVersion ||
						authorization.clientBindingRevision !==
							props.clientBindingRevisionsByApplication[applicationId]
					)
						return { kind: 'unavailable' };
					const payload = decryptGoogleCredentialPayload({
						grant: oauthStoredGrantSchema.strip().parse(authorization),
						keyEncryptionKey: props.keyEncryptionKey,
					});
					const permission = evaluateGoogleOperationGrant({
						operationId: request.operationId,
						selectedGroupIds: payload.authority.selectedGroupIds,
						actualScopes: payload.authority.grantedScopes,
						ceiling: policyCatalog.groups
							.filter((group) => group.familyId === familyId)
							.map((group) => group.groupId),
					});
					if (
						permission.kind === 'unavailable' ||
						permission.kind === 'scope-mismatch' ||
						authorization.lifecycleKind === 'degraded'
					)
						return { kind: 'unavailable' };
					if (permission.kind === 'admitted' && authorization.lifecycleKind === 'active')
						for (const requirement of operation.requirements)
							grants[requirement.serviceId] = requirement.effects;
				}
				const resolved = resolveGoogleAccountInvocationPolicy({
					binding: googleAccountPolicyBindingSchema.strip().parse(authorization),
					snapshot: policy.snapshot,
					defaults:
						props.compiled.defaultsByAgentApplication[target.agentId]?.[applicationId] ?? {},
					maximums: maximumsFor(target, request.operationId),
					grants,
					requirements: operation.requirements,
					commandAllowed: true,
				});
				if (resolved.kind === 'allowed')
					return {
						kind: 'ready',
						disposition: resolved.disposition,
						overrideRevision: resolved.overrideRevision,
						defaultsRevision: props.compiled.defaultsRevision,
					};
				return { kind: resolved.kind };
			} catch {
				return { kind: 'unavailable' };
			}
		},
	};
	return {
		...reader,
		...createGoogleAccountPolicyEditor({
			...props,
			readAccountPolicyView: reader.readAccountPolicyView,
			websiteOrigin: config.browser.publicBaseUrl,
		}),
	};
}
