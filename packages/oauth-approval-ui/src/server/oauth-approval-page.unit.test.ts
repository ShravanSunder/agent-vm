import { describe, expect, it } from 'vitest';

import { oauthApprovalPageModelSchema } from '../contracts.js';
import { renderOAuthApprovalPage } from './index.js';

const assets = {
	assetBasePath: '/oauth/assets',
	javascriptAssetName: 'oauth.0123456789abcdef.js',
	stylesheetAssetName: 'oauth.0123456789abcdef.css',
} as const;

const gmailApplication = {
	applicationId: 'gmail-app',
	description: 'Gmail account access.',
	label: 'Gmail',
	recommendedGroupIds: ['gmail.read'],
	selectedGroupIds: ['gmail.read'],
	suggestedGroupIds: ['gmail.write'],
	groups: [
		{
			groupId: 'gmail.read',
			serviceId: 'gmail',
			effect: 'read',
			label: 'Read Gmail',
			warning: 'Read your email.',
			offered: true,
		},
		{
			groupId: 'gmail.write',
			serviceId: 'gmail',
			effect: 'write',
			label: 'Write Gmail',
			warning: 'Includes reading, drafting and sending email.',
			offered: true,
		},
	],
};

describe('server-rendered OAuth approval page', () => {
	it.each([
		{
			label: 'initial Off',
			selectedGroupIds: [],
			selectionMode: undefined,
			checkedRead: true,
			checkedWrite: false,
			summary: 'No Google access selected.',
		},
		{
			label: 'explicitly cleared Custom',
			selectedGroupIds: [],
			selectionMode: 'custom',
			checkedRead: false,
			checkedWrite: false,
			summary: 'No Google access selected.',
		},
		{
			label: 'edits retained while Off',
			selectedGroupIds: ['gmail.write'],
			selectionMode: 'off',
			checkedRead: false,
			checkedWrite: true,
			summary: 'No Google access selected.',
		},
		{
			label: 'Recommended with retained Custom edits',
			selectedGroupIds: ['gmail.write'],
			selectionMode: 'recommended',
			checkedRead: false,
			checkedWrite: true,
			summary: '1 permission group selected across 1 application.',
		},
	])(
		'renders $label without relying on JavaScript for default selections or the summary',
		(scenario) => {
			// Arrange
			const model = oauthApprovalPageModelSchema.parse({
				agentId: 'sun',
				ownerLabel: 'Personal Google',
				kind: 'permission-selection',
				applications: [
					{
						...gmailApplication,
						selectedGroupIds: scenario.selectedGroupIds,
						selectionMode: scenario.selectionMode,
					},
				],
			});
			// Act
			const html = renderOAuthApprovalPage({
				...assets,
				csrfToken: 'c'.repeat(43),
				formAction: '/oauth/permissions',
				model,
			});
			const readInput = html.match(/<input[^>]*value="gmail.read"[^>]*>/u)?.[0];
			const writeInput = html.match(/<input[^>]*value="gmail.write"[^>]*>/u)?.[0];
			// Assert
			expect(readInput).toBeDefined();
			expect(writeInput).toBeDefined();
			expect(readInput?.includes('checked')).toBe(scenario.checkedRead);
			expect(writeInput?.includes('checked')).toBe(scenario.checkedWrite);
			expect(html).toContain(scenario.summary);
		},
	);

	it('renders semantic native permission controls and labels Hermes suggestions as advisory', () => {
		const html = renderOAuthApprovalPage({
			...assets,
			cancelAction: '/oauth/transactions/transaction/cancel',
			csrfToken: 'c'.repeat(43),
			formAction: '/oauth/transactions/transaction/permissions',
			model: oauthApprovalPageModelSchema.parse({
				agentId: 'sun',
				ownerLabel: 'Personal Google',
				applications: [gmailApplication],
				kind: 'permission-selection',
			}),
		});

		expect(html).toContain('<fieldset');
		expect(html).toContain('<legend>gmail</legend>');
		expect(html).toContain('Agent suggestions are advisory. You decide.');
		expect(html).toContain('Includes reading, drafting and sending email.');
		expect(html).toContain('Recommended');
		expect(html).toContain('Custom');
		expect(html).toContain('type="checkbox"');
		expect(html).toContain('type="radio"');
		expect(html).toContain('class="peer"');
		expect(html).toContain('name="csrfToken"');
		expect(html).toContain('method="post"');
		expect(html).not.toContain('accessToken');
		expect(html).not.toContain('oauthState');
	});

	it('escapes account labels and renders errors through an alert summary', () => {
		const html = renderOAuthApprovalPage({
			...assets,
			csrfToken: 'c'.repeat(43),
			formAction: '/oauth/transactions/transaction/permissions',
			model: oauthApprovalPageModelSchema.parse({
				agentId: 'sun',
				ownerLabel: '<script>alert(1)</script>',
				applications: [gmailApplication],
				errors: [
					{
						applicationId: 'gmail-app',
						message: 'Select at least one service.',
						serviceId: 'gmail',
					},
				],
				kind: 'permission-selection',
			}),
		});
		expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
		expect(html).not.toContain('<script>alert(1)</script>');
		expect(html).toContain('role="alert"');
		expect(html).toContain('tabindex="-1"');
		expect(html).toContain('autofocus');
		expect(html).toContain('aria-describedby="permission-error-gmail-app-gmail"');
	});

	it('renders progress and partial retry as native HTTPS navigation', () => {
		const progressHtml = renderOAuthApprovalPage({
			...assets,
			cancelAction: '/oauth/transactions/progress-id/cancel',
			continueUrl: 'https://accounts.google.test/authorize-next',
			csrfToken: 'c'.repeat(43),
			model: oauthApprovalPageModelSchema.parse({
				applications: [
					{ applicationId: 'gmail-app', label: 'Gmail', status: 'completed' },
					{ applicationId: 'workspace-app', label: 'Workspace', status: 'authorizing' },
				],
				kind: 'application-progress',
			}),
		});
		const partialHtml = renderOAuthApprovalPage({
			...assets,
			cancelAction: '/oauth/transactions/retry-id/cancel',
			csrfToken: 'c'.repeat(43),
			formAction: '/oauth/completions/retry-id/retry',
			model: oauthApprovalPageModelSchema.parse({
				completed: ['Gmail'],
				kind: 'partial-completion',
				retryable: ['Workspace'],
			}),
		});

		expect(progressHtml).toContain('Continue to Google');
		expect(progressHtml).toContain('https://accounts.google.test/authorize-next');
		expect(progressHtml).toContain('/oauth/transactions/progress-id/cancel');
		expect(partialHtml).toContain('Retry Google authorization');
		expect(partialHtml).toContain('/oauth/completions/retry-id/retry');
		expect(partialHtml).toContain('/oauth/transactions/retry-id/cancel');
		expect(partialHtml).toContain('method="post"');
		expect(progressHtml).toContain('name="csrfToken"');
	});

	it('renders account confirmation and cancellation as native form actions', () => {
		const html = renderOAuthApprovalPage({
			...assets,
			cancelAction: '/oauth/completions/completion-id/cancel',
			csrfToken: 'c'.repeat(43),
			formAction: '/oauth/completions/completion-id/confirm',
			model: oauthApprovalPageModelSchema.parse({
				accountLabel: 'human@example.test',
				applicationLabel: 'Gmail',
				grantedPermissionLabels: ['Gmail messages'],
				kind: 'account-confirmation',
			}),
		});

		expect(html).toContain('/oauth/completions/completion-id/confirm');
		expect(html).toContain('/oauth/completions/completion-id/cancel');
		expect(html).toContain('Confirm this account');
		expect(html).toContain('name="accountAlias"');
		expect(html).toContain('class="account-alias-field"');
		expect(html).toContain('value="human@example.test"');
		expect(html).toContain('Cancel');
		expect(html).toContain('method="post"');
	});

	it('renders an explicit before and after permission diff for reauthorization', () => {
		const html = renderOAuthApprovalPage({
			...assets,
			csrfToken: 'c'.repeat(43),
			formAction: '/oauth/completions/completion-id/confirm',
			model: oauthApprovalPageModelSchema.parse({
				accountLabel: 'human@example.test',
				applicationLabel: 'Gmail',
				previousPermissionLabels: ['Read Gmail', 'Read calendars'],
				grantedPermissionLabels: ['Read Gmail', 'Write Gmail'],
				kind: 'account-confirmation',
			}),
		});

		expect(html).toContain('Permission changes');
		expect(html).toContain('Before');
		expect(html).toContain('After');
		expect(html).toContain('Added');
		expect(html).toContain('Write Gmail');
		expect(html).toContain('Removed');
		expect(html).toContain('Read calendars');
	});

	it.each([
		{ accountLabel: 'Personal Google', kind: 'completed' },
		{ kind: 'expired', message: 'Start again from Hermes.' },
		{ kind: 'cancelled', message: 'Nothing was changed.' },
		{ kind: 'failed', message: 'Google authorization failed.' },
	] as const)('renders terminal $kind state without requiring a form', (model) => {
		const html = renderOAuthApprovalPage({
			...assets,
			model: oauthApprovalPageModelSchema.parse(model),
		});
		expect(html).toContain('<!doctype html>');
		expect(html).not.toContain('name="csrfToken"');
	});
});
