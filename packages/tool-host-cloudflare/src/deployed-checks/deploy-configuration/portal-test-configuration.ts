import { organizationConfigurationSchema } from '@agent-collaboration/tool-host-core';

import type { PrivateDeployFile } from '#worker-host/deployed-checks/deploy-configuration/models/private-deploy-file';

export function portalTestConfigurations(configuration: PrivateDeployFile): unknown {
	return Object.fromEntries(
		configuration.organizations.map((organization, index) => [
			organization.organizationId,
			organizationConfigurationSchema.parse({
				organizationName: `${configuration.runId}:${organization.label}`,
				approvalKeyBinding: `TEST_APPROVAL_${String(index)}`,
				mcp: {
					schemaVersion: 1,
					providers: {
						fixture: {
							kind: 'mcp',
							namespace: 'same-server',
							transport: {
								kind: 'streamable-http',
								url: `${configuration.helper.origin}/mcp/${organization.label}`,
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
						[configuration.agentId]: { profile: 'one' },
						[configuration.otherAgentId]: { profile: 'two' },
					},
					profiles: {
						one: {
							namespaces: {
								'same-server': {
									tools: { allow: '*', deny: ['hidden'] },
									calls: {
										withoutApproval: { allow: ['read', `only-${organization.label}`] },
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
