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
	type GoogleOAuthApplicationId,
	type OAuthConfig,
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
	readonly oauthConfig: OAuthConfig;
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

/** Host composition supplies the pinned catalog. Neither authored config nor agents supply scopes or classifiers. */
export function compileOAuthPolicy(input: {
	readonly oauthConfig: unknown;
	readonly toolPortalConfig: unknown;
	readonly catalog: unknown;
}): CompiledOAuthPolicy {
	const oauthConfig = oauthConfigSchema.parse(input.oauthConfig);
	const toolPortalConfig = toolPortalConfigSchema.parse(input.toolPortalConfig);
	const catalog = googlePolicyCatalogSchema.parse(input.catalog);
	validateCatalog(catalog);
	if (toolPortalConfig.mode !== 'managed')
		compilationError('OAuth requires managed Tool Portal mode.');
	const provider = oauthConfig.providers.google;
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
	for (const agentId of Object.keys(oauthConfig.agents)) {
		if (toolPortalConfig.agents[agentId] === undefined)
			compilationError('an OAuth agent has no Tool Portal assignment.');
	}
	for (const [agentId, portalAgent] of Object.entries(toolPortalConfig.agents)) {
		const profile = toolPortalConfig.profiles[portalAgent.profile];
		if (profile === undefined) compilationError('Tool Portal profile is missing.');
		const agent = oauthConfig.agents[agentId];
		const maxima: Partial<Record<GoogleOAuthApplicationId, readonly string[]>> = {};
		if (agent !== undefined) {
			for (const [id, application] of Object.entries(agent.applications)) {
				const applicationId = googleOAuthApplicationIdSchema.parse(id);
				const familyId = provider.applications[applicationId].catalogFamilyId;
				const ceiling = application.ceiling;
				const groupIds =
					ceiling.kind === 'explicit'
						? ceiling.groupIds
						: catalog.ceilingPresets[ceiling.presetId]?.[familyId];
				if (
					groupIds === undefined ||
					groupIds.some((groupId) => groupById.get(groupId)?.familyId !== familyId)
				)
					compilationError('a ceiling contains unknown, missing or foreign-family groups.');
				maxima[applicationId] = groupIds;
			}
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
				if (agent === undefined)
					compilationError('an agent can reach Google commands without OAuth ceilings.');
				if (!('source' in namespace.calls))
					compilationError('Google namespace disposition is not managed account policy.');
				const key = configuredGoogleOperationKey(portalAgent.profile, namespaceId, operationName);
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
							compilationError('a reachable Google command exceeds the agent ceiling.');
					}
					for (const group of compatible) offered.add(group.groupId);
					reachedOperations.set(descriptor.operationId, descriptor);
				}
			}
		}
		if (agent === undefined) {
			if (portalAgent.googlePolicyDefaults !== undefined)
				compilationError('Google defaults refer to an agent without OAuth configuration.');
			continue;
		}
		const offeredApplications: ApplicationGroups = {};
		for (const id of Object.keys(agent.applications)) {
			const applicationId = googleOAuthApplicationIdSchema.parse(id);
			const familyId = provider.applications[applicationId].catalogFamilyId;
			offeredApplications[applicationId] = [...offered]
				.filter((groupId) => groupById.get(groupId)?.familyId === familyId)
				.toSorted();
		}
		offeredGroupIdsByAgentApplication[agentId] = offeredApplications;
		operationIdsByAgent[agentId] = [...reachedOperations.keys()].toSorted();
		const defaults: Partial<Record<GoogleOAuthApplicationId, DefaultMap>> = {};
		const recommendations: Record<string, readonly string[]> = {};
		const authored = portalAgent.googlePolicyDefaults;
		if (authored?.kind === 'collection') {
			const collection = catalog.collections[authored.collectionId];
			if (collection === undefined || collection.version !== authored.version)
				compilationError('unknown recommendation collection/version.');
			defaultsSourceByAgent[agentId] = {
				kind: 'collection',
				collectionId: authored.collectionId,
				version: authored.version,
			};
			for (const id of Object.keys(agent.applications)) {
				const applicationId = googleOAuthApplicationIdSchema.parse(id);
				const familyId = provider.applications[applicationId].catalogFamilyId;
				const selected = collection.selections[familyId];
				if (selected.some((groupId) => !offeredApplications[applicationId]?.includes(groupId)))
					compilationError('recommended consent exceeds the executable hard maximum.');
				recommendations[applicationId] = selected;
				defaults[applicationId] = collection.defaults[familyId];
			}
		} else if (authored?.kind === 'explicit') {
			defaultsSourceByAgent[agentId] = { kind: 'explicit' };
			for (const [id, services] of Object.entries(authored.applications)) {
				const applicationId = googleOAuthApplicationIdSchema.parse(id);
				if (agent.applications[applicationId] === undefined)
					compilationError('defaults reference an application without a ceiling.');
				defaults[applicationId] = services;
			}
			// Explicit call defaults do not implicitly select a consent recommendation.
		} else defaultsSourceByAgent[agentId] = { kind: 'missing' };
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
								offered.has(group.groupId),
						)
					)
						compilationError('configured defaults exceed the executable hard maximum.');
				}
			}
		}
		defaultsByAgentApplication[agentId] = defaults;
		recommendationSelectionsByAgent[agentId] =
			oauthPermissionSelectionsSchema.parse(recommendations);
	}
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
