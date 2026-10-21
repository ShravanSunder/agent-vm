import {
	allAccessFilters,
	type AccessFilters,
	type AccessRow,
	type ChangeIntent,
} from '@tool-access-ui/panel-state/models/panel-view-types';
export type RoutedRequest =
	| { readonly kind: 'show'; readonly filters: AccessFilters }
	| { readonly kind: 'scan' }
	| { readonly kind: 'propose'; readonly intent: ChangeIntent }
	| { readonly kind: 'clarify'; readonly message: string }
	| { readonly kind: 'unsupported'; readonly message: string };
/** Deterministic example routing only. This classifier never grants or applies access. */
export function routePanelRequest(request: string, rows: readonly AccessRow[]): RoutedRequest {
	const text = request.trim().toLowerCase();
	if (!text) return { kind: 'unsupported', message: 'Enter a request, or choose an example.' };
	if (/^show scan[.!]?$/.test(text)) return { kind: 'scan' };
	const matches = rows.filter((row): boolean => text.includes(row.tool.toLowerCase()));
	// Show is an explicit read intent even when the tool name itself contains a verb.
	const isEdit = /^(block|approve|change|set|allow|edit)\b/.test(text);
	if (isEdit) {
		const row = matches.length === 1 ? matches[0] : undefined;
		if (!row)
			return {
				kind: 'clarify',
				message: 'Choose one tool below, then select Propose change. No change was made.',
			};
		const mode = text.includes('block')
			? 'blocked'
			: text.includes('auto')
				? 'auto'
				: text.includes('requires approval')
					? 'requires approval'
					: 'approved';
		return { kind: 'propose', intent: { rowId: row.id, mode, reason: request } };
	}
	if (!/^show\b/.test(text))
		return {
			kind: 'unsupported',
			message:
				'This example router supports Show or a single tool mode change. The current view is retained.',
		};
	const exact = matches.length === 1 ? matches[0] : undefined;
	const emailRows = rows.filter((row): boolean => /email/i.test(row.tool));
	const emailAccounts = [...new Set(emailRows.map((row): string => row.account))];
	const emailAccount = emailAccounts.length === 1 ? emailAccounts[0] : undefined;
	if (
		!exact &&
		!text.includes('email') &&
		!text.includes('research') &&
		!/\b(all|access)\b/.test(text)
	)
		return {
			kind: 'unsupported',
			message: 'No example view matches this request. The current view is retained.',
		};
	if (!exact && text.includes('email') && !emailAccount)
		return {
			kind: 'clarify',
			message: 'Choose an email account using the Account filter. No settings changed.',
		};
	return {
		kind: 'show',
		filters: {
			...allAccessFilters,
			tool: exact?.tool ?? 'All',
			agent: text.includes('research') ? 'Research assistant' : 'All',
			account: text.includes('email') && !exact ? (emailAccount ?? 'All') : 'All',
		},
	};
}
