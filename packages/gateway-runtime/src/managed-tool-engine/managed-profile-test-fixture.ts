// Copied from managed-tool-portal-real-backends.integration.test.ts at 3031ad24.
import type { GatewayRuntimeManagedToolPortalConfig } from '@agent-vm/config-contracts';
import type { GatewayRuntimePortalSemanticSnapshot } from '@agent-vm/gateway-control-contracts';

const namespaceSummaryPayloadCanary = 'SUMMARY_MARKER_MUST_NOT_ENTER_MANAGED_PAYLOADS';

export const toolPortalConfig = {
	agents: { 'agent-gate-c': { profile: 'gate-c-profile' } },
	mode: 'managed',
	profiles: {
		'gate-c-profile': {
			namespaces: {
				controller: {
					discovery: { summary: namespaceSummaryPayloadCanary },
					backend: {
						kind: 'controller_execution',
						operations: {
							controller_host_probe: { kind: 'registered_action' },
							workspace_git_push: { kind: 'registered_action' },
							push_branch: { kind: 'registered_action' },
							protected_uds: { kind: 'registered_action' },
						},
					},
					calls: {
						requiresApproval: { allow: ['push_branch'], deny: [] },
						withoutApproval: { allow: [], deny: [] },
					},
					tools: { allow: ['push_branch'], deny: [] },
				},
				github: {
					discovery: { summary: namespaceSummaryPayloadCanary },
					backend: { kind: 'mcp_provider' },
					calls: {
						requiresApproval: { allow: [], deny: [] },
						withoutApproval: { allow: ['get_issue'], deny: [] },
					},
					tools: { allow: ['get_issue'], deny: [] },
				},
				sandbox: {
					discovery: { summary: namespaceSummaryPayloadCanary },
					backend: {
						kind: 'tool_vm_runner',
						operations: {
							exec: {
								description: 'Run the fixture command.',
								executable: '/usr/bin/true',
								kind: 'command.fixed',
								mandatoryArgvPrefix: [],
								workingDirectory: '.',
							},
						},
						profile: 'sandbox_ssh',
					},
					calls: {
						requiresApproval: { allow: ['exec'], deny: [] },
						withoutApproval: { allow: [], deny: [] },
					},
					tools: { allow: ['exec'], deny: [] },
				},
			},
		},
	},
	schemaVersion: 1,
} satisfies GatewayRuntimeManagedToolPortalConfig;

export const semanticSnapshot = {
	activeRevision: 'semantic-gate-c-1',
	agentProjections: {
		'agent-gate-c': {
			agentId: 'agent-gate-c',
			frameworkIdentity: { kind: 'hermes', profileName: 'agent-gate-c' },
			profileAssignmentRevision: 'profile-assignment-gate-c-1',
			toolPortalNamespaces: [
				{ namespace: 'controller', summary: namespaceSummaryPayloadCanary },
				{ namespace: 'github', summary: namespaceSummaryPayloadCanary },
				{ namespace: 'sandbox', summary: namespaceSummaryPayloadCanary },
			],
			toolPortalProfileId: 'gate-c-profile',
		},
	},
	bindingRevision: 'binding-gate-c-1',
	catalogRevision: 'catalog-gate-c-1',
	desiredRevision: 'semantic-gate-c-1',
	profilePolicyRevision: 'policy-gate-c-1',
	projectionCohortDigest:
		'projection-cohort:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
	providerRevision: 'provider-gate-c-1',
	schemaRevision: 'schema-gate-c-1',
	schemaVersion: 1,
	surfaceEligibilityByProfile: {
		'gate-c-profile': {
			controller: ['protected_uds'],
			github: ['protected_uds'],
			sandbox: ['protected_uds'],
		},
	},
} satisfies GatewayRuntimePortalSemanticSnapshot;

export const trustedContext = {
	correlation: {
		runId: 'run-gate-c',
		sessionId: 'session-gate-c',
		toolCallId: 'tool-call-gate-c',
	},
	principal: {
		agentId: 'agent-gate-c',
		frameworkIdentity: { kind: 'hermes', profileName: 'agent-gate-c' },
		profileAssignmentRevision: 'profile-assignment-gate-c-1',
		toolPortalProfileId: 'gate-c-profile',
	},
	requester: { authenticatedSubjectId: 'subject-gate-c' },
} as const;
