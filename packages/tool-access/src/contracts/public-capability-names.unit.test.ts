import { describe, expect, it } from 'vitest';

import {
	accessNamespacePolicy,
	accessProfileProjection,
	capabilityRef,
	policyRuleRef,
	revisionRef,
} from './access-assessment.js';

const policy = {
	backendKind: 'mcp_provider',
	tools: { allow: '*', deny: [] },
	calls: {
		kind: 'selectors',
		withoutApproval: { allow: '*', deny: [] },
		requiresApproval: { allow: [], deny: [] },
	},
	operations: {},
};

describe('public names and opaque Access references', () => {
	it.each([257, 10_000])('preserves nonempty public names at %i characters', (length) => {
		const namespace = 'n'.repeat(length);
		const tool = 't'.repeat(length);

		expect(capabilityRef.parse({ namespace, tool })).toEqual({ namespace, tool });
		expect(
			accessProfileProjection.parse({ profileId: 'profile', namespaces: { [namespace]: policy } })
				.namespaces,
		).toHaveProperty(namespace);
		expect(
			accessNamespacePolicy.parse({
				...policy,
				operations: { [tool]: { cliPolicy: null, googleCommands: null } },
			}).operations,
		).toHaveProperty(tool);
		expect(policyRuleRef.parse({ source: 'profile-selector', ruleId: tool }).ruleId).toBe(tool);
	});

	it('keeps revision owners, revision IDs and profile IDs at their existing 256 boundary', () => {
		expect(
			revisionRef.safeParse({ owner: 'o'.repeat(256), revision: 'r'.repeat(256) }).success,
		).toBe(true);
		expect(revisionRef.safeParse({ owner: 'o'.repeat(257), revision: 'r' }).success).toBe(false);
		expect(revisionRef.safeParse({ owner: 'o', revision: 'r'.repeat(257) }).success).toBe(false);
		expect(
			accessProfileProjection.safeParse({ profileId: 'p'.repeat(256), namespaces: {} }).success,
		).toBe(true);
		expect(
			accessProfileProjection.safeParse({ profileId: 'p'.repeat(257), namespaces: {} }).success,
		).toBe(false);
	});

	it('still rejects empty public names', () => {
		expect(capabilityRef.safeParse({ namespace: '', tool: 'read' }).success).toBe(false);
		expect(capabilityRef.safeParse({ namespace: 'example', tool: '' }).success).toBe(false);
	});
});
