import type { GogCommandDescriptorInput } from '@agent-vm/oauth-broker-contracts';

import type { GooglePermissionGroup } from './google-permission-catalog.js';

/** Pinned provider mapping, shared by grant checks and code-owned compiler data. */
export function googleGroupSupportsOperation(
	group: GooglePermissionGroup,
	operation: Pick<GogCommandDescriptorInput, 'familyId' | 'operationId' | 'requirements'>,
): boolean {
	if (
		group.familyId !== operation.familyId ||
		!operation.requirements.some(
			(requirement) =>
				requirement.serviceId === group.serviceId && requirement.effects.includes(group.effect),
		)
	)
		return false;
	if (group.serviceId !== 'forms') return true;
	return (
		group.groupId ===
		(operation.operationId.startsWith('forms.responses.')
			? 'forms.responses.read'
			: `forms.body.${group.effect}`)
	);
}
