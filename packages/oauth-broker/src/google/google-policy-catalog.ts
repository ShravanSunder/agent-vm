import {
	googlePolicyCatalogSchema,
	type GoogleCatalogFamilyId,
	type GooglePolicyCatalog,
} from '@agent-vm/oauth-broker-contracts';

import { getGoogleGogCommandDescriptors } from './google-gog-command-catalog.js';
import { googleGroupSupportsOperation } from './google-operation-group-mapping.js';
import {
	getGooglePermissionGroups,
	googleGogSourceIdentity,
	googlePermissionCatalogVersion,
	googleReadOnlyRecommendation,
} from './google-permission-catalog.js';

const families: readonly GoogleCatalogFamilyId[] = ['communications', 'documents', 'youtube'];

/** Host composition input; never accepted as deployment-authored policy. */
export function getGooglePolicyCatalog(): GooglePolicyCatalog {
	const groups = getGooglePermissionGroups();
	const operations = getGoogleGogCommandDescriptors();
	return googlePolicyCatalogSchema.parse({
		catalogVersion: googlePermissionCatalogVersion,
		gogBuildIdentity: googleGogSourceIdentity,
		// Generated defaults from google.golang.org/api v0.292.0, pinned by Gog:
		// googleapis/google-api-go-client tag v0.292.0, each service's *-gen.go:100.
		// Calendar/Drive use www.googleapis.com. Scope URLs are not endpoint evidence.
		// Downloads, redirects, alternate universes and mTLS need separate qualification.
		families: {
			communications: {
				allowedHosts: ['gmail.googleapis.com', 'people.googleapis.com', 'www.googleapis.com'],
			},
			documents: {
				allowedHosts: [
					'docs.googleapis.com',
					'forms.googleapis.com',
					'sheets.googleapis.com',
					'slides.googleapis.com',
					'www.googleapis.com',
				],
			},
			youtube: { allowedHosts: ['youtube.googleapis.com'] },
		},
		groups: groups.map((group) =>
			Object.assign({}, group, {
				operationIds: operations
					.filter((operation) => googleGroupSupportsOperation(group, operation))
					.map((operation) => operation.operationId),
			}),
		),
		operations,
		ceilingPresets: {
			'read-only-assistant': googleReadOnlyRecommendation.selections,
			'all-supported': Object.fromEntries(
				families.map((familyId) => [
					familyId,
					groups.filter((group) => group.familyId === familyId).map((group) => group.groupId),
				]),
			),
		},
		collections: {
			'read-only-assistant': {
				...googleReadOnlyRecommendation,
				defaults: Object.fromEntries(
					families.map((familyId) => {
						const selected = new Set<string>(googleReadOnlyRecommendation.selections[familyId]);
						const familyGroups = groups.filter((group) => group.familyId === familyId);
						return [
							familyId,
							Object.fromEntries(
								[...new Set(familyGroups.map((group) => group.serviceId))].map((serviceId) => [
									serviceId,
									{
										read: familyGroups.some(
											(group) =>
												group.serviceId === serviceId &&
												group.effect === 'read' &&
												selected.has(group.groupId),
										)
											? 'allow'
											: 'deny',
										write: 'deny',
									},
								]),
							),
						];
					}),
				),
			},
		},
	});
}
