// Copied from managed-tool-portal-composition.integration.test.ts at 3031ad24.
import type { GatewayRuntimeManagedToolPortalConfig } from '@agent-vm/config-contracts';
import type { GatewayRuntimePortalSemanticSnapshot } from '@agent-vm/gateway-control-contracts';
export const compositionToolPortalConfig = {
	agents: {
		'agent-a': { profile: 'code-builder' },
	},
	mode: 'managed',
	profiles: {
		'code-builder': {
			namespaces: {
				github: {
					discovery: {},
					backend: { kind: 'mcp_provider' },
					calls: {
						requiresApproval: { allow: ['create_issue'], deny: [] },
						withoutApproval: { allow: ['backend_error', 'get_issue'], deny: [] },
					},
					tools: { allow: ['backend_error', 'create_issue', 'get_issue'], deny: [] },
				},
				private_github: {
					discovery: {},
					backend: { kind: 'mcp_provider' },
					calls: {
						requiresApproval: { allow: [], deny: [] },
						withoutApproval: { allow: ['private_probe'], deny: [] },
					},
					tools: { allow: ['private_probe'], deny: [] },
				},
			},
		},
	},
	schemaVersion: 1,
} satisfies GatewayRuntimeManagedToolPortalConfig;

export const compositionSemanticSnapshot = {
	activeRevision: 'semantic:managed-composition:1',
	agentProjections: {
		'agent-a': {
			agentId: 'agent-a',
			frameworkIdentity: { kind: 'hermes', profileName: 'agent-a' },
			profileAssignmentRevision: 'profile-assignment:agent-a:1',
			toolPortalNamespaces: [{ namespace: 'github' }, { namespace: 'private_github' }],
			toolPortalProfileId: 'code-builder',
		},
	},
	bindingRevision: 'binding:managed-composition:1',
	catalogRevision: 'catalog:managed-composition:1',
	desiredRevision: 'semantic:managed-composition:1',
	profilePolicyRevision: 'profile-policy:managed-composition:1',
	projectionCohortDigest:
		'projection-cohort:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
	providerRevision: 'provider:managed-composition:1',
	schemaRevision: 'schema:managed-composition:1',
	schemaVersion: 1,
	surfaceEligibilityByProfile: {
		'code-builder': {
			github: ['protected_uds'],
			private_github: ['protected_uds'],
		},
	},
} satisfies GatewayRuntimePortalSemanticSnapshot;

export const compositionTrustedContext = {
	correlation: {
		runId: 'run-managed-composition',
		sessionId: 'session-managed-composition',
		toolCallId: 'tool-call-managed-composition',
	},
	principal: {
		agentId: 'agent-a',
		frameworkIdentity: { kind: 'hermes', profileName: 'agent-a' },
		profileAssignmentRevision: 'profile-assignment:agent-a:1',
		toolPortalProfileId: 'code-builder',
	},
	requester: { authenticatedSubjectId: 'subject-a' },
} as const;
