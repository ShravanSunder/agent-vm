import { describe, expect, it } from 'vitest';

import { mcpPortalCallRequiresApproval } from './mcp-portal-approval-policy.js';
import { resolveMcpPortalProfile, type McpPortalConfig } from './mcp-portal-config.js';

const portalConfig = {
	agents: { shravan: { credentialVersion: 1, profile: 'builder' } },
	profiles: {
		builder: {
			namespaces: {
				linear: {
					approval: {
						allowWithoutApproval: ['viewer'],
						alwaysAsk: [],
						trustedAnnotations: true,
						write: [],
					},
					tools: { enableAll: true, hidden: [] },
				},
			},
		},
	},
	schemaVersion: 1,
} satisfies McpPortalConfig;

describe('mcpPortalCallRequiresApproval', () => {
	const profile = resolveMcpPortalProfile(portalConfig, 'builder');

	it('fails closed for untrusted namespaces and missing annotations', () => {
		expect(
			mcpPortalCallRequiresApproval(profile, {
				namespace: 'github',
				toolName: 'delete_issue',
			}),
		).toBe(true);
		expect(
			mcpPortalCallRequiresApproval(profile, {
				namespace: 'linear',
				toolName: 'delete_issue',
			}),
		).toBe(true);
	});

	it('allows explicitly allowlisted tools and trusted read-only annotations', () => {
		expect(
			mcpPortalCallRequiresApproval(profile, {
				namespace: 'linear',
				toolName: 'viewer',
			}),
		).toBe(false);
		expect(
			mcpPortalCallRequiresApproval(profile, {
				annotations: { destructiveHint: false, readOnlyHint: true },
				namespace: 'linear',
				toolName: 'list_issues',
			}),
		).toBe(false);
	});
});
