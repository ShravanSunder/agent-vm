import { workspaceConfigurationSchema } from '@agent-collaboration/tool-host-core';

import type { PrivateDeployFile } from '#worker-host/deployed-checks/deploy-configuration/models/private-deploy-file';

export function portalTestConfigurations(configuration: PrivateDeployFile): unknown {
	return Object.fromEntries(
		configuration.workspaces.map((workspace, index) => [
			workspace.workspaceId,
			workspaceConfigurationSchema.parse({
				organizationId: workspace.organizationId,
				workspaceName: `${configuration.runId}:${workspace.label}`,
				approvalKeyBinding: `TEST_APPROVAL_${String(index)}`,
				mcp: {
					schemaVersion: 1,
					providers: {
						fixture: {
							kind: 'mcp',
							namespace: 'same-server',
							transport: {
								kind: 'streamable-http',
								url: `${configuration.helper.origin}/mcp/${workspace.label}`,
								headers: {
									authorization: {
										source: 'environment',
										name: `TEST_CREDENTIAL_${String(index)}`,
									},
								},
							},
						},
					},
				},
				portal: {
					schemaVersion: 1,
					agents: {
						[configuration.agentId]: { credentialVersion: 1 },
						[configuration.otherAgentId]: { credentialVersion: 1 },
					},
					profiles: {
						one: {
							namespaces: {
								'same-server': {
									tools: { allow: '*', deny: ['hidden'] },
									calls: {
										withoutApproval: { allow: ['read', `only-${workspace.label}`] },
										requiresApproval: { allow: ['ask'] },
									},
								},
							},
						},
						two: {
							namespaces: {
								'same-server': {
									tools: { allow: ['ask'] },
									calls: { withoutApproval: { allow: ['ask'] }, requiresApproval: { allow: [] } },
								},
							},
						},
					},
				},
			}),
		]),
	);
}
