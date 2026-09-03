import { PortalBackendDescribeResultSchema } from '@agent-vm/agent-portal-sdk';
import { gatewayRuntimeManagedToolPortalConfigSchema } from '@agent-vm/config-contracts';
import { describe, expect, it } from 'vitest';

import { describeToolVmRunnerCatalog } from './tool-vm-runner-catalog-projection.js';
import { compileGatewayRuntimeToolVmRunnerConfiguredCatalog } from './tool-vm-runner-configured-catalog.js';

describe('Tool VM runner catalog projection', () => {
	it('preserves safe command.cli discovery fields in describe without exposing execution authority', () => {
		// Arrange
		const catalog = compileGatewayRuntimeToolVmRunnerConfiguredCatalog(
			gatewayRuntimeManagedToolPortalConfigSchema.parse({
				agents: { 'agent-a': { profile: 'research' } },
				mode: 'managed',
				profiles: {
					research: {
						namespaces: {
							sandbox: {
								backend: {
									kind: 'tool_vm_runner',
									operations: {
										firecrawl: {
											advisoryHints: {
												hintDeny: [{ path: ['private-deny-matcher'] }],
												hintRequiresApproval: [{ path: ['private-approval-matcher'] }],
											},
											executable: '/usr/local/bin/firecrawl',
											kind: 'command.cli',
											metadata: {
												categories: ['research'],
												displayName: 'Firecrawl CLI',
												source: 'firecrawl',
												version: '1.x',
											},
											output: {
												modelVisibleStderr: 'fixed_safe_summary',
												overflow: 'truncate',
												stderrMaxBytes: 4_096,
												stdoutMaxBytes: 4_096,
											},
											safeHelp: 'Run Firecrawl with caller-selected arguments.',
											timeout: { kind: 'open' },
											workingDirectory: '.',
										},
									},
									profile: 'sandbox_ssh',
								},
								calls: {
									requiresApproval: { allow: [], deny: [] },
									withoutApproval: { allow: ['firecrawl'], deny: [] },
								},
								discovery: {},
								tools: { allow: ['firecrawl'], deny: [] },
							},
						},
					},
				},
				schemaVersion: 1,
			}),
		).research;
		if (catalog === undefined) throw new Error('Expected the research Tool VM catalog.');

		// Act
		const result = PortalBackendDescribeResultSchema.parse(
			describeToolVmRunnerCatalog(
				{
					requests: [
						{
							id: 'describe-firecrawl',
							includeJsonSchema: true,
							includeRelated: true,
							includeTypescriptHelper: false,
							includeZod: false,
							tools: [{ name: 'firecrawl', namespace: 'sandbox' }],
						},
					],
				},
				catalog,
			),
		);

		// Assert
		expect(result.items[0]).toMatchObject({
			status: 'ok',
			value: {
				tools: [
					{
						advisory: {
							bypassableWithinToolVm: true,
							hasHintDeny: true,
							hasHintRequiresApproval: true,
							kind: 'tool_vm_call_hints',
							scope: 'tool_portal_call_only',
						},
						description: 'Run Firecrawl with caller-selected arguments.',
						toolVmCliMetadata: {
							categories: ['research'],
							displayName: 'Firecrawl CLI',
							source: 'firecrawl',
							version: '1.x',
						},
					},
				],
			},
		});
		const serializedResult = JSON.stringify(result);
		expect(serializedResult).not.toMatch(
			/private-approval-matcher|private-deny-matcher|\/usr\/local\/bin\/firecrawl/u,
		);
	});
});
