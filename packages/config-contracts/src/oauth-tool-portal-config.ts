import { createHash } from 'node:crypto';
import path from 'node:path';

import {
	createGogOperationResolver,
	googlePolicyCatalogSchema,
	googlePolicyDefaultsSnapshotSchema,
	type GooglePolicyDefaultsSource,
	type GooglePolicyDefaultsSnapshot,
	type googleServicePolicyDefaultsSchema,
	oauthPermissionSelectionsSchema,
	type GogCommandDescriptor,
	type GooglePolicyCatalog,
	type OAuthPermissionSelections,
} from '@agent-vm/oauth-broker-contracts';
import { z } from 'zod';

import {
	compiledGoogleCommandSetSchema,
	type CompiledGoogleCommandSet,
} from './compiled-google-command-set.js';
import {
	isControllerEphemeralManagedVmConfiguredCliOperation,
	type ControllerEphemeralManagedVmConfiguredCliOperation,
} from './controller-configured-cli.js';
import {
	googleOAuthApplicationIdSchema,
	oauthConfigSchema,
	resolvedOAuthConfigSchema,
	type GoogleOAuthApplicationId,
	type ResolvedOAuthConfig,
} from './oauth-config.js';
import {
	toolPortalConfigSchema,
	toolPortalNamespaceAllowsOperation,
	toolPortalSelectorAllowsOperation,
	type ManagedToolPortalConfig,
} from './tool-portal-config.js';

type DefaultMap = z.infer<typeof googleServicePolicyDefaultsSchema>;
type ApplicationGroups = Partial<Record<GoogleOAuthApplicationId, readonly string[]>>;
export type { CompiledGoogleCommandSet } from './compiled-google-command-set.js';
export interface CompiledOAuthPolicy {
	readonly oauthConfig: ResolvedOAuthConfig;
	readonly toolPortalConfig: ManagedToolPortalConfig;
	readonly offeredGroupIdsByAgentApplication: Readonly<Record<string, ApplicationGroups>>;
	readonly operationIdsByAgent: Readonly<Record<string, readonly string[]>>;
	readonly recommendationSelectionsByAgent: Readonly<Record<string, OAuthPermissionSelections>>;
	readonly defaultsByAgentApplication: Readonly<
		Record<string, Partial<Record<GoogleOAuthApplicationId, DefaultMap>>>
	>;
	readonly defaultsRevision: string;
	readonly defaultsSnapshot: GooglePolicyDefaultsSnapshot;
	readonly allowedHostsByApplication: Readonly<Record<GoogleOAuthApplicationId, readonly string[]>>;
	readonly commandSetsByConfiguredOperation: Readonly<Record<string, CompiledGoogleCommandSet>>;
}
export function configuredGoogleOperationKey(
	profileId: string,
	namespaceId: string,
	operationName: string,
): string {
	return JSON.stringify([profileId, namespaceId, operationName]);
}
function compilationError(message: string): never {
	throw new Error(`OAuth/Tool Portal compilation: ${message}`);
}
function samePath(left: readonly string[], right: readonly string[]): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}
function canonicalDefaults(defaults: CompiledOAuthPolicy['defaultsByAgentApplication']): unknown {
	return Object.entries(defaults)
		.toSorted(([left], [right]) => left.localeCompare(right))
		.map(([agentId, applications]) => [
			agentId,
			Object.entries(applications)
				.toSorted(([left], [right]) => left.localeCompare(right))
				.map(([applicationId, services]) => [
					applicationId,
					Object.entries(services)
						.toSorted(([left], [right]) => left.localeCompare(right))
						.map(([serviceId, values]) => [
							serviceId,
							values.read ?? 'deny',
							values.write ?? 'deny',
						]),
				]),
		]);
}
function validateCatalog(catalog: GooglePolicyCatalog): void {
	createGogOperationResolver(catalog.operations);
	const groupIds = new Set(catalog.groups.map((group) => group.groupId));
	if (groupIds.size !== catalog.groups.length)
		compilationError('catalog group IDs must be unique.');
	for (const group of catalog.groups) {
		for (const operationId of group.operationIds) {
			const operation = catalog.operations.find(
				(candidate) => candidate.operationId === operationId,
			);
			if (
				operation === undefined ||
				operation.familyId !== group.familyId ||
				!operation.requirements.some(
					(requirement) =>
						requirement.serviceId === group.serviceId && requirement.effects.includes(group.effect),
				)
			)
				compilationError('catalog group has an incompatible operation association.');
		}
	}
}
function compileCommandSet(props: {
	readonly operation: ControllerEphemeralManagedVmConfiguredCliOperation;
	readonly catalog: GooglePolicyCatalog;
	readonly applicationIdsByFamily: CompiledGoogleCommandSet['applicationIdsByFamily'];
}): CompiledGoogleCommandSet {
	const { operation, catalog } = props;
	if (operation.authorization?.kind !== 'oauth_account' || !('source' in operation.calls))
		compilationError('Google commands require the account policy source.');
	if (
		path.basename(operation.executablePath) !== 'gog' ||
		operation.mandatoryArgvPrefix.length !== 0
	)
		compilationError(
			'Google calls require the fixed Gog executable without authored argv prefixes.',
		);
	if (operation.stdin.kind !== 'none')
		compilationError('Google file inputs use the qualified file path, not process stdin.');
	if (
		operation.executionTarget.environment.kind === 'inherit_allowlist' &&
		operation.executionTarget.environment.names.some((name) =>
			/^(GOG_|GOOGLE_|CLOUDSDK_|HOME$|XDG_)/u.test(name),
		)
	)
		compilationError('Google runtime identity and defense environment are controller-owned.');
	const descriptors = new Map<string, GogCommandDescriptor>();
	const admittedPaths: readonly string[][] = operation.commands.map((command) => command.path);
	const noOAuthPaths: (readonly string[])[] = [];
	for (const command of operation.commands) {
		if (
			operation.calls.deny.some(
				(denial) => denial.flags.length === 0 && samePath(denial.path, command.path),
			)
		)
			continue;
		if (
			command.path.length === 1 &&
			['--help', '--version', 'version'].includes(command.path[0] ?? '')
		) {
			if (command.flagRules.length > 0)
				compilationError('local help/version does not take extra flags.');
			noOAuthPaths.push(command.path);
			continue;
		}
		const descriptor = catalog.operations.find((entry) =>
			entry.paths.some((candidate) => samePath(candidate, command.path)),
		);
		if (descriptor === undefined)
			compilationError('an admitted Gog command is not a qualified exact catalog path.');
		for (const rule of command.flagRules) {
			for (const name of rule.names) {
				const flag = descriptor.flags.find(
					(candidate) => candidate.name === name || candidate.aliases.includes(name),
				);
				if (flag === undefined)
					compilationError('an authored flag restriction names an unqualified Gog flag.');
				const valid = rule.values.every((value) => {
					if (flag.kind === 'choice') return flag.choices.includes(value);
					if (flag.kind === 'switch') return value === 'true';
					if (flag.kind === 'integer')
						return (
							/^(0|[1-9][0-9]*)$/u.test(value) &&
							Number.isSafeInteger(Number(value)) &&
							Number(value) >= flag.minimum &&
							Number(value) <= flag.maximum
						);
					return value.trim().length > 0 && !value.startsWith('-');
				});
				if (!valid)
					compilationError(
						'an authored flag restriction is incompatible with the qualified Gog parser.',
					);
			}
		}
		descriptors.set(descriptor.operationId, descriptor);
	}
	const families = new Set([...descriptors.values()].map((descriptor) => descriptor.familyId));
	const expectedHosts = new Set(
		[...families].flatMap((familyId) => catalog.families[familyId].allowedHosts),
	);
	const configuredHosts = new Set(operation.executionTarget.allowedHosts);
	if (
		[...expectedHosts].some((host) => !configuredHosts.has(host)) ||
		[...configuredHosts].some((host) => !expectedHosts.has(host))
	)
		compilationError('Google target hosts must equal the code-owned qualified family hosts.');
	const commandSet = {
		applicationIdsByFamily: props.applicationIdsByFamily,
		descriptors: [...descriptors.values()].map((descriptor) =>
			Object.assign({}, descriptor, {
				paths: descriptor.paths.filter((candidate) =>
					admittedPaths.some((admitted) => samePath(admitted, candidate)),
				),
			}),
		),
		noOAuthPaths,
	};
	return compiledGoogleCommandSetSchema.parse({
		...commandSet,
		revision: createHash('sha256')
			.update(JSON.stringify([catalog.catalogVersion, catalog.gogBuildIdentity, commandSet]))
			.digest('hex'),
	});
}
const lifecycleTools = ['list', 'begin', 'status', 'cancel', 'reauthorize', 'disconnect'] as const;

export function managedToolPortalRequiresOAuthConfiguration(
	config: ManagedToolPortalConfig,
): boolean {
	return Object.values(config.profiles).some(
		(profile) =>
			Object.keys(profile.oauthApplications ?? {}).length > 0 ||
			Object.values(profile.namespaces).some(
				(namespace) =>
					namespace.backend.kind === 'controller_execution' &&
					Object.values(namespace.backend.operations).some(
						(operation) =>
							operation.kind === 'configured_cli' &&
							isControllerEphemeralManagedVmConfiguredCliOperation(operation) &&
							operation.authorization?.kind === 'oauth_account',
					),
			),
	);
}

interface CompiledProfileOAuthPolicy {
	readonly applications: ResolvedOAuthConfig['agents'][string]['applications'];
	readonly defaults: Partial<Record<GoogleOAuthApplicationId, DefaultMap>>;
	readonly defaultsSource: GooglePolicyDefaultsSource;
	readonly offeredApplications: ApplicationGroups;
	readonly operationIds: readonly string[];
	readonly recommendations: OAuthPermissionSelections;
}

function normalizeDefaultsSource(
	applications: NonNullable<ManagedToolPortalConfig['profiles'][string]['oauthApplications']>,
): GooglePolicyDefaultsSource {
	const configured = Object.values(applications).flatMap((application) =>
		application.policyDefaults === undefined ? [] : [application.policyDefaults],
	);
	if (configured.length === 0) return { kind: 'missing' };
	const first = configured[0];
	if (
		first?.kind === 'collection' &&
		configured.every(
			(candidate) =>
				candidate.kind === 'collection' &&
				candidate.collectionId === first.collectionId &&
				candidate.version === first.version,
		)
	)
		return {
			kind: 'collection',
			collectionId: first.collectionId,
			version: first.version,
		};
	return { kind: 'explicit' };
}

/** Host composition supplies the pinned catalog. Neither authored config nor agents supply scopes or classifiers. */
export function compileOAuthPolicy(input: {
	readonly oauthConfig: unknown;
	readonly toolPortalConfig: unknown;
	readonly catalog: unknown;
}): CompiledOAuthPolicy {
	const authoredOAuthConfig = oauthConfigSchema.parse(input.oauthConfig);
	const toolPortalConfig = toolPortalConfigSchema.parse(input.toolPortalConfig);
	const catalog = googlePolicyCatalogSchema.parse(input.catalog);
	validateCatalog(catalog);
	if (toolPortalConfig.mode !== 'managed')
		compilationError('OAuth requires managed Tool Portal mode.');
	const provider = authoredOAuthConfig.providers.google;
	if (
		provider.catalogVersion !== catalog.catalogVersion ||
		provider.gogBuildIdentity.version !== catalog.gogBuildIdentity.version ||
		provider.gogBuildIdentity.commit !== catalog.gogBuildIdentity.commit
	)
		compilationError('Google/Gog catalog and build pins do not match.');
	const applicationIdsByFamily = z
		.record(z.enum(['communications', 'documents', 'youtube']), googleOAuthApplicationIdSchema)
		.parse(
			Object.fromEntries(
				Object.entries(provider.applications).map(([applicationId, application]) => [
					application.catalogFamilyId,
					applicationId,
				]),
			),
		);
	const allowedHostsByApplication = z
		.record(googleOAuthApplicationIdSchema, z.array(z.string()).readonly())
		.parse(
			Object.fromEntries(
				Object.entries(provider.applications).map(([applicationId, application]) => [
					applicationId,
					catalog.families[application.catalogFamilyId].allowedHosts,
				]),
			),
		);
	const groupById = new Map(catalog.groups.map((group) => [group.groupId, group]));
	const offeredGroupIdsByAgentApplication: Record<string, ApplicationGroups> = {};
	const operationIdsByAgent: Record<string, readonly string[]> = {};
	const recommendationSelectionsByAgent: Record<string, OAuthPermissionSelections> = {};
	const defaultsByAgentApplication: Record<
		string,
		Partial<Record<GoogleOAuthApplicationId, DefaultMap>>
	> = {};
	const commandSetsByConfiguredOperation: Record<string, CompiledGoogleCommandSet> = {};
	const defaultsSourceByAgent: Record<string, GooglePolicyDefaultsSource> = {};
	const profilePolicyById: Record<string, CompiledProfileOAuthPolicy> = {};
	for (const [profileId, profile] of Object.entries(toolPortalConfig.profiles)) {
		const applications = profile.oauthApplications ?? {};
		const maxima: Partial<Record<GoogleOAuthApplicationId, readonly string[]>> = {};
		for (const [id, application] of Object.entries(applications)) {
			const applicationId = googleOAuthApplicationIdSchema.parse(id);
			const familyId = provider.applications[applicationId].catalogFamilyId;
			const groupIds =
				application.ceiling.kind === 'explicit'
					? application.ceiling.groupIds
					: catalog.ceilingPresets[application.ceiling.presetId]?.[familyId];
			if (
				groupIds === undefined ||
				groupIds.some((groupId) => groupById.get(groupId)?.familyId !== familyId)
			)
				compilationError('a ceiling contains unknown, missing or foreign-family groups.');
			maxima[applicationId] = groupIds;
		}
		if (Object.keys(applications).length > 0) {
			const lifecycle = profile.namespaces.oauth_authorization;
			if (lifecycle?.backend.kind !== 'controller_execution' || 'source' in lifecycle.calls)
				compilationError('OAuth lifecycle tools require a static configured disposition.');
			for (const name of lifecycleTools) {
				if (
					lifecycle.backend.operations[name]?.kind !== 'registered_action' ||
					!toolPortalSelectorAllowsOperation(lifecycle.tools, name)
				)
					compilationError('all account lifecycle actions must be exposed explicitly.');
				const ask = toolPortalSelectorAllowsOperation(lifecycle.calls.requiresApproval, name);
				const direct = toolPortalSelectorAllowsOperation(lifecycle.calls.withoutApproval, name);
				if (ask === direct)
					compilationError('each lifecycle action requires exactly one configured disposition.');
			}
		}
		const reachedOperations = new Map<string, GogCommandDescriptor>();
		const offered = new Set<string>();
		for (const [namespaceId, namespace] of Object.entries(profile.namespaces)) {
			if (namespace.backend.kind !== 'controller_execution') continue;
			for (const [operationName, operation] of Object.entries(namespace.backend.operations)) {
				if (
					operation.kind !== 'configured_cli' ||
					!isControllerEphemeralManagedVmConfiguredCliOperation(operation) ||
					operation.authorization?.kind !== 'oauth_account' ||
					!toolPortalNamespaceAllowsOperation(namespace, operationName)
				)
					continue;
				if (!('source' in namespace.calls))
					compilationError('Google namespace disposition is not managed account policy.');
				const key = configuredGoogleOperationKey(profileId, namespaceId, operationName);
				const commandSet =
					commandSetsByConfiguredOperation[key] ??
					compileCommandSet({ operation, catalog, applicationIdsByFamily });
				commandSetsByConfiguredOperation[key] = commandSet;
				for (const descriptor of commandSet.descriptors) {
					const applicationId = applicationIdsByFamily[descriptor.familyId];
					const ceiling = maxima[applicationId];
					if (ceiling === undefined)
						compilationError('a reachable Google command has no application ceiling.');
					const compatible = catalog.groups.filter(
						(group) =>
							ceiling.includes(group.groupId) &&
							group.operationIds.includes(descriptor.operationId),
					);
					for (const requirement of descriptor.requirements) {
						if (
							requirement.effects.some(
								(effect) =>
									!compatible.some(
										(group) => group.serviceId === requirement.serviceId && group.effect === effect,
									),
							)
						)
							compilationError('a reachable Google command exceeds the profile ceiling.');
					}
					for (const group of compatible) offered.add(group.groupId);
					reachedOperations.set(descriptor.operationId, descriptor);
				}
			}
		}
		const offeredApplications: ApplicationGroups = {};
		for (const id of Object.keys(applications)) {
			const applicationId = googleOAuthApplicationIdSchema.parse(id);
			const familyId = provider.applications[applicationId].catalogFamilyId;
			offeredApplications[applicationId] = [...offered]
				.filter((groupId) => groupById.get(groupId)?.familyId === familyId)
				.toSorted();
		}
		const defaults: Partial<Record<GoogleOAuthApplicationId, DefaultMap>> = {};
		const recommendations: Record<string, readonly string[]> = {};
		for (const [id, application] of Object.entries(applications)) {
			const applicationId = googleOAuthApplicationIdSchema.parse(id);
			const familyId = provider.applications[applicationId].catalogFamilyId;
			const recommendation = application.consentRecommendation;
			if (recommendation !== undefined) {
				const selected =
					recommendation.kind === 'explicit'
						? recommendation.groupIds
						: catalog.collections[recommendation.collectionId]?.version === recommendation.version
							? catalog.collections[recommendation.collectionId]?.selections[familyId]
							: undefined;
				if (
					selected === undefined ||
					selected.some((groupId) => groupById.get(groupId)?.familyId !== familyId)
				)
					compilationError('unknown or foreign recommendation collection/group.');
				if (selected.some((groupId) => !offeredApplications[applicationId]?.includes(groupId)))
					compilationError('recommended consent exceeds the executable hard maximum.');
				recommendations[applicationId] = selected;
			}
			const authoredDefaults = application.policyDefaults;
			if (authoredDefaults !== undefined) {
				const services =
					authoredDefaults.kind === 'explicit'
						? authoredDefaults.services
						: catalog.collections[authoredDefaults.collectionId]?.version ===
							  authoredDefaults.version
							? catalog.collections[authoredDefaults.collectionId]?.defaults[familyId]
							: undefined;
				if (services === undefined) compilationError('unknown defaults collection/version.');
				defaults[applicationId] = services;
			}
		}
		for (const [id, services] of Object.entries(defaults)) {
			const applicationId = googleOAuthApplicationIdSchema.parse(id);
			const familyId = provider.applications[applicationId].catalogFamilyId;
			for (const [serviceId, values] of Object.entries(services)) {
				if (
					!catalog.groups.some(
						(group) => group.familyId === familyId && group.serviceId === serviceId,
					)
				)
					compilationError('defaults reference an unsupported family/service.');
				for (const effect of ['read', 'write'] as const) {
					if (values[effect] === undefined || values[effect] === 'deny') continue;
					if (
						!catalog.groups.some(
							(group) =>
								group.familyId === familyId &&
								group.serviceId === serviceId &&
								group.effect === effect &&
								offeredApplications[applicationId]?.includes(group.groupId) === true,
						)
					)
						compilationError('configured defaults exceed the executable hard maximum.');
				}
			}
		}
		profilePolicyById[profileId] = {
			applications,
			defaults,
			defaultsSource: normalizeDefaultsSource(applications),
			offeredApplications,
			operationIds: [...reachedOperations.keys()].toSorted(),
			recommendations: oauthPermissionSelectionsSchema.parse(recommendations),
		};
	}
	const resolvedAgents: Record<string, ResolvedOAuthConfig['agents'][string]> = {};
	for (const [agentId, portalAgent] of Object.entries(toolPortalConfig.agents)) {
		const policy = profilePolicyById[portalAgent.profile];
		if (policy === undefined) compilationError('Tool Portal profile is missing.');
		if (Object.keys(policy.applications).length === 0) continue;
		resolvedAgents[agentId] = {
			applications: Object.fromEntries(
				Object.entries(policy.applications).map(([applicationId, application]) => [
					applicationId,
					{ ceiling: application.ceiling },
				]),
			),
		};
		offeredGroupIdsByAgentApplication[agentId] = policy.offeredApplications;
		operationIdsByAgent[agentId] = policy.operationIds;
		recommendationSelectionsByAgent[agentId] = policy.recommendations;
		defaultsByAgentApplication[agentId] = policy.defaults;
		defaultsSourceByAgent[agentId] = policy.defaultsSource;
	}
	const oauthConfig = resolvedOAuthConfigSchema.parse({
		...authoredOAuthConfig,
		agents: resolvedAgents,
	});
	return {
		oauthConfig,
		toolPortalConfig,
		offeredGroupIdsByAgentApplication,
		operationIdsByAgent,
		recommendationSelectionsByAgent,
		defaultsByAgentApplication,
		allowedHostsByApplication,
		commandSetsByConfiguredOperation,
		defaultsSnapshot: googlePolicyDefaultsSnapshotSchema.parse({
			defaultsByAgentApplication,
			sourcesByAgent: defaultsSourceByAgent,
		}),
		defaultsRevision: createHash('sha256')
			.update(
				JSON.stringify({
					zoneId: oauthConfig.zoneId,
					defaults: canonicalDefaults(defaultsByAgentApplication),
					sources: Object.entries(defaultsSourceByAgent).toSorted(([left], [right]) =>
						left.localeCompare(right),
					),
				}),
			)
			.digest('hex'),
	};
}
