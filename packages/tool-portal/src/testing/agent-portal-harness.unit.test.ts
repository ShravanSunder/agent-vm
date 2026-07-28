import { PortalCallResultSchema, PortalListResultSchema } from '@agent-vm/agent-portal-sdk';
import { ManagedVmExecRequestSchema } from '@agent-vm/controller-execution-contracts';
import { describe, expect, it } from 'vitest';

import { createFakeManagedVmRunner } from '../../../../tests/harness/agent-portal/fake-managed-vm-runner.js';
import { createFakeMcpProviderBackend } from '../../../../tests/harness/agent-portal/fake-mcp-provider-server.js';
import { createFakeToolPortalController } from '../../../../tests/harness/agent-portal/fake-tool-portal-controller.js';
import {
	assertPortalResultHasNoHiddenControlFields,
	assertPortalResultMatchesContract,
} from '../../../../tests/harness/agent-portal/portal-contract-assertions.js';

describe('shared agent portal harness', () => {
	it('drives portal batch contracts without real provider, VM, shell, or sleeps', async () => {
		const providerBackend = createFakeMcpProviderBackend({
			capabilities: [
				{
					description: 'Read issue',
					inputSchema: { properties: { number: { type: 'number' } }, type: 'object' },
					namespace: 'github',
					name: 'get_issue',
					value: { number: 42, title: 'Harness proof' },
				},
			],
		});
		const controller = createFakeToolPortalController({ providerBackend });

		const listResult = await controller.list({
			requests: [{ id: 'list-github', namespaces: ['github'] }],
		});
		const callResult = await controller.call({
			calls: [
				{
					arguments: { number: 42 },
					id: 'call-github',
					namespace: 'github',
					name: 'get_issue',
				},
			],
		});

		assertPortalResultMatchesContract(PortalListResultSchema, listResult);
		assertPortalResultMatchesContract(PortalCallResultSchema, callResult);
		assertPortalResultHasNoHiddenControlFields(callResult);
		expect(callResult).toMatchObject({
			items: [
				{
					id: 'call-github',
					operationId: 'fake-operation:call-github',
					outcome: {
						certainty: 'proven',
						completion: 'succeeded',
						kind: 'completed',
						retryClass: 'forbidden',
					},
					owningGeneration: 'fake-mcp-provider-generation',
					status: 'ok',
					value: { number: 42, title: 'Harness proof' },
				},
			],
			ok: true,
		});
	});

	it('validates fake ManagedVm runner requests through controller contracts', async () => {
		const runner = createFakeManagedVmRunner();

		const result = await runner.exec(
			ManagedVmExecRequestSchema.parse({
				argv: ['calendar', 'events', '--json'],
				cwd: { kind: 'workspace_root' },
				env: {},
				executablePath: '/usr/local/bin/gog',
				shellMode: 'none',
				stderr: 'stream',
				stderrMaxBytes: 1024,
				stdout: 'stream',
				stdoutMaxBytes: 1024,
				timeoutMs: 10_000,
				pty: false,
			}),
		);

		expect(result).toMatchObject({
			status: 'ok',
			stdout: '',
		});
		expect(runner.recordedExecRequests).toHaveLength(1);
	});
});
