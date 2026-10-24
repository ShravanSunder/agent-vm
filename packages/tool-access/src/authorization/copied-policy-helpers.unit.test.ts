import {
	createPortalAgentIdentity,
	mcpPortalCallPolicyDecision,
	mcpPortalCallRequiresApproval,
	resolveCompiledGoogleCommand,
	resolvePortalAccessPolicy,
	toolPortalNamespaceAllowsOperation,
	toolPortalSelectorAllowsOperation,
} from '@agent-collaboration/tool-access/authorization';
import {
	compiledGoogleCommandSetSchema,
	resolvedMcpPortalProfileSchema,
	toolPortalCallPolicySchema,
	type CompiledGoogleCommandSet,
} from '@agent-collaboration/tool-access/contracts';
import { describe, expect, it } from 'vitest';

describe('copied selector and namespace policy', () => {
	it('deny wins over explicit and wildcard allows', () => {
		for (const allow of ['*', ['run']] as const) {
			expect(
				toolPortalSelectorAllowsOperation(
					{ allow: allow === '*' ? '*' : [...allow], deny: ['run'] },
					'run',
				),
			).toBe(false);
			expect(
				toolPortalSelectorAllowsOperation(
					{ allow: allow === '*' ? '*' : [...allow], deny: [] },
					'run',
				),
			).toBe(true);
		}
	});
	it('namespace reachability requires visibility and either call selector, or account policy', () => {
		const tools = { allow: '*', deny: [] } as const;
		const calls = {
			requiresApproval: { allow: ['run'], deny: [] },
			withoutApproval: { allow: [], deny: [] },
		};
		expect(
			toolPortalNamespaceAllowsOperation({ tools: { ...tools, deny: [] }, calls }, 'run'),
		).toBe(true);
		expect(
			toolPortalNamespaceAllowsOperation({ tools: { allow: '*', deny: ['run'] }, calls }, 'run'),
		).toBe(false);
		expect(
			toolPortalNamespaceAllowsOperation({ tools: { allow: '*', deny: [] }, calls }, 'other'),
		).toBe(false);
		expect(
			toolPortalNamespaceAllowsOperation(
				{ tools: { allow: '*', deny: [] }, calls: { source: 'managed_google_policy' } },
				'run',
			),
		).toBe(true);
	});
	it('retains pure call-policy overlap rejection and deny exclusions', () => {
		expect(
			toolPortalCallPolicySchema.safeParse({
				requiresApproval: { allow: ['run'] },
				withoutApproval: { allow: ['run'] },
			}).success,
		).toBe(false);
		expect(
			toolPortalCallPolicySchema.safeParse({
				requiresApproval: { allow: '*', deny: ['run'] },
				withoutApproval: { allow: ['run'] },
			}).success,
		).toBe(true);
	});
});

describe('copied MCP approval decision scenarios', () => {
	const profile = resolvedMcpPortalProfileSchema.parse({
		enabledNamespaces: ['linear'],
		enabledToolsByNamespace: {},
		hiddenToolsByNamespace: {},
		logging: { enabled: false },
		promptContext: { enabled: true, maxNamespaces: 12 },
		cache: { catalogTtlMs: 60000 },
		approval: {
			callPoliciesByNamespace: {
				linear: {
					withoutApproval: { allow: ['viewer'] },
					requiresApproval: { allow: ['delete_issue'] },
				},
			},
		},
	});
	it('fails closed for untrusted namespaces and missing annotations', () => {
		expect(
			mcpPortalCallPolicyDecision(profile, { namespace: 'github', toolName: 'delete_issue' }),
		).toEqual({ kind: 'blocked' });
		expect(
			mcpPortalCallRequiresApproval(profile, { namespace: 'linear', toolName: 'delete_issue' }),
		).toBe(true);
	});
	it('allows explicitly listed tools and retains blocked unnamed calls', () => {
		expect(
			mcpPortalCallPolicyDecision(profile, { namespace: 'linear', toolName: 'viewer' }),
		).toEqual({ kind: 'allow_without_approval' });
		expect(
			mcpPortalCallPolicyDecision(profile, { namespace: 'linear', toolName: 'list_issues' }),
		).toEqual({ kind: 'blocked' });
	});
	it('trusts read-only annotations only from the configured namespaces', () => {
		const trusted = resolvedMcpPortalProfileSchema.parse({
			...profile,
			approval: { ...profile.approval, trustedAnnotationNamespaces: ['linear'] },
		});
		expect(
			mcpPortalCallPolicyDecision(trusted, {
				namespace: 'linear',
				toolName: 'list_issues',
				annotations: { readOnlyHint: true },
			}),
		).toEqual({ kind: 'allow_without_approval' });
		expect(
			mcpPortalCallPolicyDecision(trusted, {
				namespace: 'linear',
				toolName: 'list_issues',
				annotations: { readOnlyHint: true, destructiveHint: true },
			}),
		).toEqual({ kind: 'blocked' });
	});
});

describe('copied pure session resolver scenarios and selection boundaries', () => {
	const identity = createPortalAgentIdentity({
		agentId: 'agent-a',
		agentScopeId: 'agent-scope-a',
		source: 'tool-portal-service',
	});
	it('explicit allow-all exposes configured upstream namespaces in sorted order', () => {
		expect(
			resolvePortalAccessPolicy({
				config: {
					defaultPolicy: 'allow-all',
					enabledNamespacesByAgent: {},
					enabledToolsByNamespaceByAgent: {},
					hiddenToolsByAgent: {},
				},
				identity,
				upstreamNamespaces: ['linear', 'github'],
			}),
		).toEqual({
			allowedNamespaces: ['github', 'linear'],
			enabledToolsByNamespace: {},
			hiddenTools: [],
		});
	});
	it('an explicit empty global list means deny-all', () => {
		expect(
			resolvePortalAccessPolicy({
				config: {
					defaultPolicy: 'allow-all',
					enabledNamespaces: [],
					enabledNamespacesByAgent: {},
					hiddenToolsByAgent: {},
				},
				identity,
				upstreamNamespaces: ['linear', 'github'],
			}).allowedNamespaces,
		).toEqual([]);
	});
	it('agent override precedes global selection, intersects upstreams, and sorts enabled and hidden tools', () => {
		expect(
			resolvePortalAccessPolicy({
				config: {
					defaultPolicy: 'deny-all',
					enabledNamespaces: ['global'],
					enabledNamespacesByAgent: { 'agent-a': ['linear', 'missing', 'github'] },
					enabledToolsByNamespaceByAgent: {
						'agent-a': { linear: ['write', 'read'], github: ['z', 'a'] },
					},
					hiddenToolsByAgent: {
						'agent-a': [
							{ namespace: 'linear', toolName: 'z' },
							{ namespace: 'github', toolName: 'b' },
							{ namespace: 'github', toolName: 'a' },
						],
					},
				},
				identity,
				upstreamNamespaces: ['github', 'linear', 'global'],
			}),
		).toEqual({
			allowedNamespaces: ['github', 'linear'],
			enabledToolsByNamespace: { github: ['a', 'z'], linear: ['read', 'write'] },
			hiddenTools: [
				{ namespace: 'github', toolName: 'a' },
				{ namespace: 'github', toolName: 'b' },
				{ namespace: 'linear', toolName: 'z' },
			],
		});
	});
	it('global list precedes default; absent/default-deny and explicit empty agent list deny all', () => {
		const base = { enabledNamespacesByAgent: {}, hiddenToolsByAgent: {} };
		expect(
			resolvePortalAccessPolicy({ config: base, identity, upstreamNamespaces: ['linear'] })
				.allowedNamespaces,
		).toEqual([]);
		expect(
			resolvePortalAccessPolicy({
				config: { ...base, enabledNamespaces: ['linear'] },
				identity,
				upstreamNamespaces: ['linear'],
			}).allowedNamespaces,
		).toEqual(['linear']);
		expect(
			resolvePortalAccessPolicy({
				config: {
					...base,
					defaultPolicy: 'allow-all',
					enabledNamespaces: ['linear'],
					enabledNamespacesByAgent: { 'agent-a': [] },
				},
				identity,
				upstreamNamespaces: ['linear'],
			}).allowedNamespaces,
		).toEqual([]);
	});
});

describe('compiled Google command set and wrapper', () => {
	const set: CompiledGoogleCommandSet = compiledGoogleCommandSetSchema.parse({
		descriptors: [
			{
				operationId: 'drive-list',
				familyId: 'documents',
				paths: [['drive', 'list']],
				requirements: [{ serviceId: 'drive', effects: ['read'] }],
				sendsMail: false,
				positionals: { minimum: 0, maximum: 0 },
				flags: [],
			},
		],
		noOAuthPaths: [['--help']],
		applicationIdsByFamily: {
			documents: 'workspace-app',
			communications: 'gmail-app',
			youtube: 'youtube-app',
		},
		revision: 'a'.repeat(64),
	});
	it('returns the admitted descriptor requirements unchanged', () => {
		expect(resolveCompiledGoogleCommand(set, ['drive', 'list'])).toEqual({
			kind: 'oauth',
			operationId: 'drive-list',
			familyId: 'documents',
			requirements: [{ serviceId: 'drive', effects: ['read'] }],
			sendsMail: false,
		});
	});
	it.each([
		['drive', 'delete'],
		['drive', 'list', '--unknown'],
		['drive'],
		['--help', 'extra'],
		['--version'],
		['version'],
	])('refuses denied or unrecognized argv %j', (...argv) => {
		expect(resolveCompiledGoogleCommand(set, argv)).toEqual({ kind: 'denied' });
	});
	it('only the exact configured no-OAuth path bypasses OAuth', () => {
		expect(resolveCompiledGoogleCommand(set, ['--help'])).toEqual({ kind: 'no-oauth' });
		expect(resolveCompiledGoogleCommand({ ...set, noOAuthPaths: [] }, ['--help'])).toEqual({
			kind: 'denied',
		});
	});
	it('invalid compiled set and overlapping descriptors fail closed', () => {
		expect(
			resolveCompiledGoogleCommand({ ...set, revision: 'invalid' }, ['drive', 'list']),
		).toEqual({ kind: 'denied' });
		expect(
			resolveCompiledGoogleCommand(
				{ ...set, descriptors: [...set.descriptors, ...set.descriptors] },
				['drive', 'list'],
			),
		).toEqual({ kind: 'denied' });
	});
});
