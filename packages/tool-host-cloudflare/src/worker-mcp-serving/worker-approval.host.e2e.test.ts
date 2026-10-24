import { hashCallArguments } from '@agent-collaboration/tool-access/contracts';
import { signApprovalToken } from '@agent-collaboration/tool-engine/mcp-gateway';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { organizationOne, organizationTwo } from '#worker-host/test-fixtures/controlled-mcp-issuer';
import {
	rpcResult,
	startLocalWorkerHarness,
	type LocalWorkerHarness,
} from '#worker-host/test-fixtures/local-worker-harness';

let harness: LocalWorkerHarness;
async function approvedAsk(value: string): Promise<Readonly<Record<string, unknown>>> {
	const approval = await signApprovalToken({
		agentId: '["bot","66666666-6666-4666-8666-666666666666"]',
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
	it.each([
		{ mode: 'indirect', carrier: 'input' },
		{ mode: 'direct', carrier: 'input' },
		{ mode: 'direct', carrier: 'metadata' },
	] as const)(
		'$mode/$carrier: rejects another organization approval key and admits its own key',
		async ({ mode, carrier }) => {
			const tokenB = await harness.fixture.sign({ organizationId: organizationTwo });
			const path =
				mode === 'direct'
					? '/workspaces/22222222-2222-4222-8222-222222222222/mcp?tools=direct'
					: '/workspaces/22222222-2222-4222-8222-222222222222/mcp';
			const listed = await rpcResult(
				await harness.rpc(
					'tools/list',
					{},
					{
						path: '/workspaces/22222222-2222-4222-8222-222222222222/mcp?tools=direct',
						token: tokenB,
					},
				),
			);
			const nativeName = z
				.object({ tools: z.array(z.object({ name: z.string() })) })
				.parse(listed)
				.tools.find((tool) => tool.name.startsWith('same-server__ask__'))?.name;
			if (nativeName === undefined) throw new Error('Missing independently listed approval tool.');
			const value = `${mode}-${carrier}-organization-key`;
			const claims = {
				agentId: '["bot","66666666-6666-4666-8666-666666666666"]',
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
			};
			// The claims and call are identical. Only the organization's signing key changes.
			const approvalA = await signApprovalToken({ ...claims, key: new Uint8Array(32).fill(0x12) });
			const approvalB = await signApprovalToken({ ...claims, key: new Uint8Array(32).fill(0x34) });
			const requestFor = (approval: string): Readonly<Record<string, unknown>> =>
				carrier === 'input'
					? {
							name: 'mcp_portal_call',
							arguments: {
								portalApprovalToken: approval,
								calls: [
									{ id: 'ask', namespace: 'same-server', toolName: 'ask', arguments: { value } },
								],
							},
						}
					: {
							name: nativeName,
							arguments: { value },
							_meta: {
								'io.modelcontextprotocol/protocolVersion': '2026-07-28',
								'io.modelcontextprotocol/clientCapabilities': {},
								'agent-vm/tool-portal-approval-token': approval,
							},
						};
			const before = harness.fixture.calls.length;
			const ownA = await rpcResult(
				await harness.rpc('tools/call', requestFor(approvalA), {
					path: path.replace(organizationTwo, organizationOne),
				}),
			);
			expect(ownA.isError).toBeUndefined();
			expect(harness.fixture.calls).toHaveLength(before + 1);
			expect(harness.fixture.calls.at(-1)?.credential).toBe('one-secret-canary');
			const foreign = await rpcResult(
				await harness.rpc('tools/call', requestFor(approvalA), { path, token: tokenB }),
			);
			expect(harness.fixture.calls).toHaveLength(before + 1);
			expect(foreign.isError).toBe(true);
			expect(JSON.stringify(foreign)).toContain('approval_token_invalid');
			// A signature refusal must not consume B's identical token ID.
			const ownB = await rpcResult(
				await harness.rpc('tools/call', requestFor(approvalB), { path, token: tokenB }),
			);
			expect(ownB.isError).toBeUndefined();
			expect(harness.fixture.calls).toHaveLength(before + 2);
			expect(harness.fixture.calls.at(-1)?.credential).toBe('two-secret-canary');
		},
	);
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
