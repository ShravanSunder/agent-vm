import {
	googleOAuthApplicationIdSchema,
	type GoogleOAuthApplicationId,
	type OAuthConfig,
} from '@agent-vm/config-contracts';
import {
	oauthApplicationIdSchema,
	oauthPermissionSelectionsSchema,
	oauthScopeSchema,
	type OAuthPermissionSelections,
	type OAuthScope,
} from '@agent-vm/oauth-broker-contracts';
import { z } from 'zod';

import { googleIdentityScopes } from './google-oauth-adapter.js';
import {
	compileGooglePermissionSelection,
	getGooglePermissionGroups,
	googleGogSourceIdentity,
	googlePermissionCatalogVersion,
	resolveGoogleCeilingPreset,
} from './google-permission-catalog.js';

export type GoogleOfferedPermissionGroups = Readonly<
	Record<string, Partial<Record<GoogleOAuthApplicationId, readonly string[]>>>
>;

interface GoogleSelectionRequest {
	readonly agentId: string;
	readonly selections: z.input<typeof oauthPermissionSelectionsSchema>;
}

export class GoogleOAuthSelectionError extends Error {
	constructor(readonly code: 'configuration-change-required' | 'unsupported-selection') {
		super(
			code === 'configuration-change-required'
				? 'Google selection exceeds the configured executable permission maximum.'
				: 'Google selection is unsupported by the pinned catalog.',
		);
		this.name = 'GoogleOAuthSelectionError';
	}
}

export interface GoogleOAuthPermissionPolicy {
	completeSelections(props: GoogleSelectionRequest): OAuthPermissionSelections;
	validateSelections(props: GoogleSelectionRequest): OAuthPermissionSelections;
	scopesForApplication(
		applicationId: GoogleOAuthApplicationId,
		selections: OAuthPermissionSelections,
	): readonly OAuthScope[];
}

export function createGoogleOAuthPermissionPolicy(props: {
	readonly config: OAuthConfig;
	readonly offeredGroupIdsByAgentApplication: GoogleOfferedPermissionGroups;
}): GoogleOAuthPermissionPolicy {
	const provider = props.config.providers.google;
	if (
		provider.catalogVersion !== googlePermissionCatalogVersion ||
		provider.gogBuildIdentity.version !== googleGogSourceIdentity.version ||
		provider.gogBuildIdentity.commit !== googleGogSourceIdentity.commit
	) {
		throw new Error('OAuth configuration does not match the pinned Google/Gog catalog.');
	}
	const groups = getGooglePermissionGroups();
	const groupById = new Map(groups.map((group) => [group.groupId, group]));
	const offered = structuredClone(props.offeredGroupIdsByAgentApplication);

	const maximum = (agentId: string, applicationId: GoogleOAuthApplicationId): readonly string[] => {
		const ceiling = props.config.agents[agentId]?.applications[applicationId]?.ceiling;
		if (ceiling === undefined) return [];
		const familyId = provider.applications[applicationId].catalogFamilyId;
		const groupIds =
			ceiling.kind === 'explicit'
				? ceiling.groupIds
				: resolveGoogleCeilingPreset(ceiling.presetId, familyId);
		compileGooglePermissionSelection({ familyId, groupIds: [], ceiling: groupIds });
		return groupIds;
	};
	for (const [agentId, applications] of Object.entries(offered)) {
		if (props.config.agents[agentId] === undefined)
			throw new Error('Compiled Google offers reference an unknown agent.');
		for (const [applicationId, groupIds] of Object.entries(applications)) {
			const parsedApplicationId = googleOAuthApplicationIdSchema.parse(applicationId);
			const allowed = new Set(maximum(agentId, parsedApplicationId));
			if (groupIds.some((groupId) => !allowed.has(groupId)))
				throw new Error('Compiled Google offers exceed the authored ceiling.');
		}
	}

	const validateSelections = (request: GoogleSelectionRequest): OAuthPermissionSelections => {
		if (props.config.agents[request.agentId] === undefined)
			throw new GoogleOAuthSelectionError('configuration-change-required');
		const selections = oauthPermissionSelectionsSchema.parse(request.selections);
		for (const [applicationId, groupIds] of Object.entries(selections)) {
			const application = googleOAuthApplicationIdSchema.safeParse(applicationId);
			if (!application.success) throw new GoogleOAuthSelectionError('unsupported-selection');
			const familyId = provider.applications[application.data].catalogFamilyId;
			if (groupIds.some((groupId) => groupById.get(groupId)?.familyId !== familyId))
				throw new GoogleOAuthSelectionError('unsupported-selection');
			const maximumGroups = new Set(maximum(request.agentId, application.data));
			const offeredGroups = new Set(offered[request.agentId]?.[application.data] ?? []);
			if (groupIds.some((groupId) => !maximumGroups.has(groupId) || !offeredGroups.has(groupId))) {
				throw new GoogleOAuthSelectionError('configuration-change-required');
			}
			compileGooglePermissionSelection({ familyId, groupIds, ceiling: [...offeredGroups] });
		}
		return selections;
	};

	return {
		validateSelections,
		completeSelections: (request) => {
			const selections = validateSelections(request);
			const agent = props.config.agents[request.agentId];
			if (agent === undefined) throw new GoogleOAuthSelectionError('configuration-change-required');
			return oauthPermissionSelectionsSchema.parse(
				Object.fromEntries(
					Object.keys(agent.applications).map((applicationId) => [
						applicationId,
						selections[oauthApplicationIdSchema.parse(applicationId)] ?? [],
					]),
				),
			);
		},
		scopesForApplication: (applicationId, selections) => {
			const groupIds = selections[oauthApplicationIdSchema.parse(applicationId)] ?? [];
			if (groupIds.length === 0) return [];
			const familyId = provider.applications[applicationId].catalogFamilyId;
			const compiled = compileGooglePermissionSelection({
				familyId,
				groupIds,
				ceiling: groups
					.filter((group) => group.familyId === familyId)
					.map((group) => group.groupId),
			});
			return z
				.array(oauthScopeSchema)
				.readonly()
				.parse([...new Set([...googleIdentityScopes, ...compiled.scopes])].toSorted());
		},
	};
}
