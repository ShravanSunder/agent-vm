import type {
	GoogleCatalogFamilyId,
	GoogleOperationEffect,
} from '@agent-vm/oauth-broker-contracts';

export interface GooglePermissionGroup {
	readonly groupId: string;
	readonly familyId: GoogleCatalogFamilyId;
	readonly serviceId: string;
	readonly effect: GoogleOperationEffect;
	readonly label: string;
	readonly scopes: readonly string[];
	readonly warning: string;
	readonly fileMode?: 'all-files' | 'app-files';
}

export const googleReadOnlyRecommendation = {
	version: '1',
	label: 'Read-only assistant',
	summary: 'Read selected services; deny writes.',
	rationale: 'Start with reading and opt in deliberately to write authority.',
	selections: {
		communications: ['gmail.read'],
		documents: [
			'drive.all-files.read',
			'docs.all-files.read',
			'sheets.all-files.read',
			'slides.all-files.read',
		],
		youtube: ['youtube.read'],
	},
} as const;

export const googlePermissionCatalogVersion = 'google-gog-v0.38.1-v1';
export const googleGogSourceIdentity = {
	version: '0.38.1',
	commit: '324f656a4949c3adbf8e1f18066d3965757ed9db',
} as const;

const scopePrefix = 'https://www.googleapis.com/auth/';
// Checked-in mappings; discovery documents are development evidence, not runtime policy.
const serviceGroups: readonly GooglePermissionGroup[] = [
	{
		groupId: 'gmail.read',
		familyId: 'communications',
		serviceId: 'gmail',
		effect: 'read',
		label: 'Read Gmail',
		scopes: [`${scopePrefix}gmail.readonly`],
		warning: 'Google can read messages and settings, but cannot send with this scope.',
	},
	{
		groupId: 'gmail.write',
		familyId: 'communications',
		serviceId: 'gmail',
		effect: 'write',
		label: 'Write Gmail, including drafting and sending',
		scopes: [`${scopePrefix}gmail.modify`],
		warning:
			'Google can read, draft, organize, trash and send email. This is not a draft-only token. Local Read and Write policies remain separate.',
	},
	{
		groupId: 'calendar.read',
		familyId: 'communications',
		serviceId: 'calendar',
		effect: 'read',
		label: 'Read calendars and events',
		scopes: [`${scopePrefix}calendar.readonly`],
		warning: 'Google can read calendars, events and related calendar metadata.',
	},
	{
		groupId: 'calendar.write',
		familyId: 'communications',
		serviceId: 'calendar',
		effect: 'write',
		label: 'Create, edit, cancel and respond to events',
		scopes: [`${scopePrefix}calendar.events`],
		warning:
			'Google can read and change events. Invitations and responses may notify other people. Helper reads require local Read permission too.',
	},
	{
		groupId: 'contacts.read',
		familyId: 'communications',
		serviceId: 'contacts',
		effect: 'read',
		label: 'Read contacts',
		scopes: [`${scopePrefix}contacts.readonly`],
		warning: 'Saved contacts only. Directory and other-contact discovery are not included.',
	},
	{
		groupId: 'contacts.write',
		familyId: 'communications',
		serviceId: 'contacts',
		effect: 'write',
		label: 'Create, edit and delete contacts',
		scopes: [`${scopePrefix}contacts`],
		warning: 'Google can read, create, edit and delete contacts.',
	},
	{
		groupId: 'forms.body.read',
		familyId: 'documents',
		serviceId: 'forms',
		effect: 'read',
		label: 'Read form bodies',
		scopes: [`${scopePrefix}forms.body.readonly`],
		warning: 'Form definitions only; response access is separate.',
	},
	{
		groupId: 'forms.body.write',
		familyId: 'documents',
		serviceId: 'forms',
		effect: 'write',
		label: 'Create and edit form bodies',
		scopes: [`${scopePrefix}forms.body`],
		warning: 'Google can read and change form definitions; responses are separate.',
	},
	{
		groupId: 'forms.responses.read',
		familyId: 'documents',
		serviceId: 'forms',
		effect: 'read',
		label: 'Read form responses',
		scopes: [`${scopePrefix}forms.responses.readonly`],
		warning: 'Responses may contain private information supplied by respondents.',
	},
	{
		groupId: 'youtube.read',
		familyId: 'youtube',
		serviceId: 'youtube',
		effect: 'read',
		label: 'Read YouTube account and content',
		scopes: [`${scopePrefix}youtube.readonly`],
		warning: 'Google can read permitted YouTube account, channel, video and playlist data.',
	},
	{
		groupId: 'youtube.write',
		familyId: 'youtube',
		serviceId: 'youtube',
		effect: 'write',
		label: 'Write supported YouTube content',
		scopes: [`${scopePrefix}youtube.force-ssl`],
		warning:
			'Google can read and change YouTube content beyond the locally supported command inventory.',
	},
];

const documentServiceLabels = {
	drive: 'Drive files',
	docs: 'Google Docs',
	sheets: 'Google Sheets',
	slides: 'Google Slides',
} as const;
const documentGroups: readonly GooglePermissionGroup[] = Object.entries(
	documentServiceLabels,
).flatMap(([serviceId, label]) =>
	(['all-files', 'app-files'] as const).flatMap((fileMode) =>
		(['read', 'write'] as const).map(
			(effect): GooglePermissionGroup => ({
				groupId: `${serviceId}.${fileMode}.${effect}`,
				familyId: 'documents',
				serviceId,
				effect,
				fileMode,
				label: `${effect === 'read' ? 'Read' : 'Write'} ${label} — ${fileMode === 'all-files' ? 'all accessible files' : 'app-created or explicitly app-authorized files'}`,
				scopes: [
					`${scopePrefix}${fileMode === 'app-files' ? 'drive.file' : effect === 'read' ? 'drive.readonly' : 'drive'}`,
				],
				warning:
					fileMode === 'app-files'
						? 'Google can read and write files this app creates or the person explicitly authorizes. Gog does not provide a Picker for arbitrary existing files. This scope itself is not read-only.'
						: effect === 'read'
							? 'Google can read all accessible files, not just this selected service. Local service policy limits commands.'
							: 'Google can read and write all accessible files, including sharing and deletion outside the local command inventory. Local service policy does not narrow the token.',
			}),
		),
	),
);
const permissionGroups = [...serviceGroups, ...documentGroups];
const groupById = new Map(permissionGroups.map((group) => [group.groupId, group]));

export function getGooglePermissionGroups(): readonly GooglePermissionGroup[] {
	return structuredClone(permissionGroups);
}

export function resolveGoogleCeilingPreset(
	presetId: string,
	familyId: GoogleCatalogFamilyId,
): readonly string[] {
	if (presetId === 'read-only-assistant')
		return [...googleReadOnlyRecommendation.selections[familyId]];
	if (presetId === 'all-supported')
		return permissionGroups
			.filter((group) => group.familyId === familyId)
			.map((group) => group.groupId);
	throw new Error('Unknown Google catalog ceiling preset.');
}

export function compileGooglePermissionSelection(props: {
	readonly familyId: GoogleCatalogFamilyId;
	readonly groupIds: readonly string[];
	readonly ceiling: readonly string[];
}): {
	readonly scopes: readonly string[];
	readonly effects: Readonly<Record<string, readonly GoogleOperationEffect[]>>;
	readonly warnings: readonly string[];
} {
	const ceiling = new Set(props.ceiling);
	for (const groupId of ceiling) {
		if (groupById.get(groupId)?.familyId !== props.familyId)
			throw new Error('Google ceiling contains an unknown or foreign-family group.');
	}
	const scopes = new Set<string>();
	const warnings = new Set<string>();
	const effects = new Map<string, Set<GoogleOperationEffect>>();
	for (const groupId of new Set(props.groupIds)) {
		const group = groupById.get(groupId);
		if (group === undefined || group.familyId !== props.familyId || !ceiling.has(groupId)) {
			throw new Error(
				'Google selection is unknown, belongs to another family, or exceeds the configured ceiling.',
			);
		}
		for (const scope of group.scopes) scopes.add(scope);
		warnings.add(group.warning);
		const serviceEffects = effects.get(group.serviceId) ?? new Set<GoogleOperationEffect>();
		serviceEffects.add(group.effect);
		effects.set(group.serviceId, serviceEffects);
	}
	return {
		scopes: [...scopes].toSorted(),
		warnings: [...warnings],
		effects: Object.fromEntries(
			[...effects].map(([serviceId, values]) => [serviceId, [...values].toSorted()]),
		),
	};
}
