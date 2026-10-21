import { hashCallArguments } from '@agent-collaboration/tool-access/contracts';
import { signApprovalToken } from '@agent-collaboration/tool-engine/mcp-gateway';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { organizationOne } from '#worker-host/test-fixtures/controlled-mcp-issuer';
import {
	rpcResult,
	startLocalWorkerHarness,
	type LocalWorkerHarness,
} from '#worker-host/test-fixtures/local-worker-harness';

let harness: LocalWorkerHarness;
async function approvedAsk(value: string): Promise<Readonly<Record<string, unknown>>> {
	const approval = await signApprovalToken({
		agentId: 'agent-one',
		key: new Uint8Array(32).fill(0x12),
		jti: crypto.randomUUID(),
		issuedAtMs: Date.now(),
		expiresAtMs: Date.now() + 60_000,
		calls: [
			{
				namespace: 'same-server',
				toolName: 'ask',
				argumentsHash: await hashCallArguments({ value }),
			},
		],
	});
	return {
		name: 'mcp_portal_call',
		arguments: {
			portalApprovalToken: approval,
			calls: [{ id: 'ask', namespace: 'same-server', toolName: 'ask', arguments: { value } }],
		},
	};
}
describe('Worker awaits its organization approval authority in local workerd', () => {
	beforeAll(async () => {
		harness = await startLocalWorkerHarness();
	});
	afterAll(async () => {
		await harness?.close();
	});
	it('runs exactly one concurrent use and refuses replay', async () => {
		const input = await approvedAsk('one-use');
		const before = harness.fixture.calls.length;
		await Promise.all([
			harness.rpc('tools/call', input).then(rpcResult),
			harness.rpc('tools/call', input).then(rpcResult),
		]);
		await rpcResult(await harness.rpc('tools/call', input));
		expect(harness.fixture.calls).toHaveLength(before + 1);
	});
	it('runs no call if recording throws', async () => {
		await harness.control({ kind: 'fault', organizationId: organizationOne, fault: 'fail' });
		const before = harness.fixture.calls.length;
		await rpcResult(await harness.rpc('tools/call', await approvedAsk('fail')));
		expect(harness.fixture.calls).toHaveLength(before);
		await harness.control({ kind: 'fault', organizationId: organizationOne, fault: 'none' });
	});
	it('holds all effects until the object answers first use', async () => {
		await harness.control({ kind: 'fault', organizationId: organizationOne, fault: 'stall' });
		const before = harness.fixture.calls.length;
		const call = harness.rpc('tools/call', await approvedAsk('stall')).then(rpcResult);
		await harness.control({ kind: 'wait-recording', organizationId: organizationOne });
		expect(harness.fixture.calls).toHaveLength(before);
		await harness.control({ kind: 'release', organizationId: organizationOne });
		await call;
		expect(harness.fixture.calls).toHaveLength(before + 1);
	});
});
