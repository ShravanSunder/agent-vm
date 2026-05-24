import { describe, expect, it } from 'vitest';

import {
	mcpPortalCallPolicyDecision,
	mcpPortalCallRequiresApproval,
} from './mcp-portal-approval-policy.js';
import { resolveMcpPortalProfile, type McpPortalConfig } from './mcp-portal-config.js';

const portalConfig = {
	agents: { shravan: { credentialVersion: 1, profile: 'builder' } },
	profiles: {
		builder: {
			namespaces: {
				linear: {
					calls: {
						withoutApproval: { allow: ['viewer'], deny: [] },
						requiresApproval: { allow: ['delete_issue'], deny: [] },
					},
					tools: { allow: '*', deny: [] },
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
			mcpPortalCallPolicyDecision(profile, {
				namespace: 'github',
				toolName: 'delete_issue',
			}),
		).toEqual({ kind: 'blocked' });
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
			mcpPortalCallPolicyDecision(profile, {
				namespace: 'linear',
				toolName: 'list_issues',
			}),
		).toEqual({ kind: 'blocked' });
	});
});
