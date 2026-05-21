import type { ResolvedMcpPortalProfile } from '@agent-vm/config-contracts';
import { describe, expect, it } from 'vitest';

import { profileAllowsPortalCall } from './portal-tool-policy.js';

const baseProfile = {
	approval: {
		allowWithoutApprovalTools: [],
		alwaysAskTools: [],
		annotationPolicy: 'destructive-requires-approval',
		trustedAnnotationNamespaces: [],
		writeTools: [],
	},
	cache: { catalogTtlMs: 60_000 },
	enabledNamespaces: ['linear'],
	enabledToolsByNamespace: {},
	hiddenToolsByNamespace: {},
	logging: { enabled: false },
	promptContext: { enabled: true, maxNamespaces: 8 },
} satisfies ResolvedMcpPortalProfile;

describe('profileAllowsPortalCall', () => {
	it('treats missing or empty enabledTools entries as namespace-level allow', () => {
		expect(
			profileAllowsPortalCall(baseProfile, {
				namespace: 'linear',
				toolName: 'list_issues',
			}),
		).toBe(true);
		expect(
			profileAllowsPortalCall(
				{
					...baseProfile,
					enabledToolsByNamespace: { linear: [] },
				},
				{
					namespace: 'linear',
					toolName: 'list_issues',
				},
			),
		).toBe(true);
	});

	it('narrows tools only when enabledTools lists explicit tool names', () => {
		const profile = {
			...baseProfile,
			enabledToolsByNamespace: { linear: ['list_issues'] },
		} satisfies ResolvedMcpPortalProfile;

		expect(
			profileAllowsPortalCall(profile, {
				namespace: 'linear',
				toolName: 'list_issues',
			}),
		).toBe(true);
		expect(
			profileAllowsPortalCall(profile, {
				namespace: 'linear',
				toolName: 'create_issue',
			}),
		).toBe(false);
	});

	it('applies hidden tools after namespace-level allow', () => {
		const profile = {
			...baseProfile,
			hiddenToolsByNamespace: { linear: ['delete_issue'] },
		} satisfies ResolvedMcpPortalProfile;

		expect(
			profileAllowsPortalCall(profile, {
				namespace: 'linear',
				toolName: 'delete_issue',
			}),
		).toBe(false);
	});
});
