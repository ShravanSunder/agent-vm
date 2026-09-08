export interface GoogleOperationGrantPolicyInput {
	readonly operationId: string;
	readonly selectedGroupIds: readonly string[];
	readonly ceiling: readonly string[];
	readonly actualScopes: readonly string[];
}
export type GoogleOperationGrantPolicyResult = {
	readonly kind: 'admitted' | 'consent-required' | 'scope-mismatch' | 'unavailable';
};

const operations = new Map(
	getGoogleGogCommandDescriptors().map((operation) => [operation.operationId, operation]),
);
const groups = getGooglePermissionGroups();

export function evaluateGoogleOperationGrant(
	input: GoogleOperationGrantPolicyInput,
): GoogleOperationGrantPolicyResult {
	const operation = operations.get(input.operationId);
	if (operation === undefined) return { kind: 'unavailable' };
	try {
		const compiled = compileGooglePermissionSelection({
			familyId: operation.familyId,
			groupIds: input.selectedGroupIds,
			ceiling: input.ceiling,
		});
		const expectedScopes = new Set<string>([...googleIdentityScopes, ...compiled.scopes]);
		const actualScopes = new Set(input.actualScopes);
		if (
			actualScopes.size !== expectedScopes.size ||
			[...expectedScopes].some((scope) => !actualScopes.has(scope))
		)
			return { kind: 'scope-mismatch' };
		const selections = new Set(input.selectedGroupIds);
		for (const requirement of operation.requirements) {
			for (const effect of requirement.effects) {
				const candidates = groups.filter(
					(group) =>
						group.familyId === operation.familyId &&
						group.serviceId === requirement.serviceId &&
						group.effect === effect,
				);
				const hasSelection = candidates.some(
					(group) =>
						selections.has(group.groupId) && googleGroupSupportsOperation(group, operation),
				);
				if (!hasSelection) return { kind: 'consent-required' };
			}
		}
		return { kind: 'admitted' };
	} catch {
		return { kind: 'unavailable' };
	}
}
import { getGoogleGogCommandDescriptors } from './google-gog-command-catalog.js';
import { googleIdentityScopes } from './google-oauth-adapter.js';
import { googleGroupSupportsOperation } from './google-operation-group-mapping.js';
import {
	compileGooglePermissionSelection,
	getGooglePermissionGroups,
} from './google-permission-catalog.js';
