import {
	oauthApprovalPageModelSchema,
	type OAuthApprovalPageModel,
	type OAuthPermissionFieldError,
} from '@agent-vm/oauth-approval-ui';
import {
	oauthPermissionSelectionsSchema,
	type OAuthPermissionSelections,
} from '@agent-vm/oauth-broker-contracts';
import type { GoogleOAuthPermissionPageData } from '@agent-vm/oauth-broker/google';

export function permissionPageModel(page: GoogleOAuthPermissionPageData): OAuthApprovalPageModel {
	if (page.intent === 'disconnect')
		return oauthApprovalPageModelSchema.parse({
			kind: 'disconnect-confirmation',
			agentId: page.agentId,
			accountAlias: page.accountAlias ?? 'Selected account',
			applicationLabel: page.applications[0]?.label ?? 'Google',
		});
	return oauthApprovalPageModelSchema.parse({
		kind: 'permission-selection',
		agentId: page.agentId,
		ownerLabel: page.ownerLabel,
		...(page.accountAlias === undefined ? {} : { accountAlias: page.accountAlias }),
		applications: page.applications,
	});
}
type PermissionSelectionPageModel = Extract<
	OAuthApprovalPageModel,
	{ kind: 'permission-selection' }
>;
export type PermissionFormResult =
	| { readonly kind: 'invalid'; readonly model: PermissionSelectionPageModel }
	| { readonly kind: 'valid'; readonly selections: OAuthPermissionSelections };

/** Posted modes select only server-owned presets or exact offered group IDs, never raw scopes. */
export function parsePermissionForm(
	page: GoogleOAuthPermissionPageData,
	form: FormData,
): PermissionFormResult {
	const model = permissionPageModel(page);
	if (model.kind !== 'permission-selection')
		throw new Error('This ceremony does not accept scope selections.');
	const expectedKeys = new Set([
		'csrfToken',
		...model.applications.flatMap((application) => [
			`mode.${application.applicationId}`,
			`groups.${application.applicationId}`,
		]),
	]);
	if (
		[...form.keys()].some((key) => !expectedKeys.has(key)) ||
		form.getAll('csrfToken').length !== 1
	)
		throw new Error('Unknown or repeated form authority.');
	const fieldErrors: OAuthPermissionFieldError[] = [];
	const selections: Record<string, readonly string[]> = {};
	const applications = model.applications.map(
		(application): PermissionSelectionPageModel['applications'][number] => {
			const rawMode = form.get(`mode.${application.applicationId}`);
			const groups = form.getAll(`groups.${application.applicationId}`);
			const offered = new Set(
				application.groups.filter((group) => group.offered).map((group) => group.groupId),
			);
			const validMode =
				(rawMode === 'off' || rawMode === 'recommended' || rawMode === 'custom') &&
				form.getAll(`mode.${application.applicationId}`).length === 1;
			const validGroups =
				groups.every((group) => typeof group === 'string' && offered.has(group)) &&
				new Set(groups).size === groups.length;
			if (!validMode || !validGroups) {
				const firstGroup = application.groups[0];
				if (firstGroup === undefined) throw new Error('Missing permission groups.');
				fieldErrors.push({
					applicationId: application.applicationId,
					serviceId: firstGroup.serviceId,
					message: `Choose Off, Recommended, or offered Custom access for ${application.label}.`,
				});
				return application;
			}
			const selectedGroupIds = groups.filter((group): group is string => typeof group === 'string');
			selections[application.applicationId] =
				rawMode === 'off'
					? []
					: rawMode === 'recommended'
						? application.recommendedGroupIds
						: selectedGroupIds;
			return { ...application, selectedGroupIds, selectionMode: rawMode };
		},
	);
	return fieldErrors.length > 0
		? { kind: 'invalid', model: { ...model, applications, errors: fieldErrors } }
		: { kind: 'valid', selections: oauthPermissionSelectionsSchema.parse(selections) };
}
