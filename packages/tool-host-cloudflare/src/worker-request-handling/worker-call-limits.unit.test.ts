import type { DispatchInvocation, ResourceResult } from '@agent-collaboration/tool-engine/dispatch';
import type { PortalBatchResult } from '@agent-collaboration/tool-engine/mcp-gateway';
import { describe, expect, it } from 'vitest';

import {
	createBatchScheduler,
	createWorkerRequestLimits,
	projectBoundedWorkerToolResult,
	workerReplyTrimOrder,
} from '#worker-host/worker-request-handling/worker-call-limits';

describe('whole-call Worker batch scheduling', () => {
	it('admits six whole calls and releases the next six only on completion', async () => {
		const scheduler = createBatchScheduler();
		const releases: (() => void)[] = [];
		let running = 0;
		let peak = 0;
		const started = Promise.withResolvers<void>();
		const calls = Array.from({ length: 12 }, async () =>
			scheduler.run(async () => {
				running += 1;
				peak = Math.max(peak, running);
				if (running === 6) started.resolve();
				await new Promise<void>((resolve) => releases.push(resolve));
				running -= 1;
			}),
		);
		await started.promise;
		expect(releases).toHaveLength(6);
		for (const release of releases.splice(0)) release();
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		for (const release of releases.splice(0)) release();
		await Promise.all(calls);
		expect(peak).toBe(6);
		expect(running).toBe(0);
	});
});

describe('raw batch admission precedes all descriptor validation', () => {
	it.each([51, 8000])(
		'counts %s raw entries without reading descriptors, including the refusal projection',
		(count) => {
			let descriptorReads = 0;
			const malformed = Object.defineProperty({}, 'id', {
				get: () => {
					descriptorReads += 1;
					return 'unexpected-descriptor-read';
				},
			});
			const input = { calls: Array.from({ length: count }, () => malformed) };
			const refused = createWorkerRequestLimits().begin(input, 'proof');
			expect(descriptorReads).toBe(0);
			expect(refused?.errors[0]?.kind).toBe('too_many_calls');
			if (refused === undefined) throw new Error('Expected a raw batch refusal.');
			const projected = projectBoundedWorkerToolResult({
				operation: 'mcp_portal_call',
				input,
				result: refused,
				requestId: 'proof',
				callHasStarted: () => false,
			});
			expect(JSON.stringify(projected.response)).toContain('too_many_calls');
			expect(descriptorReads).toBe(0);
		},
	);
});

it('uses explicit request order and invocation facts for all three trim classes', () => {
	const order = ['ambiguous', '1', 'success', '7', '2'];
	const result: PortalBatchResult = {
		ok: false,
		errors: [],
		diagnostics: [],
		results: {
			'1': { ok: false, input: {}, error: { kind: 'input_validation' } },
			'2': { ok: false, input: {}, error: { kind: 'approval_token_missing' } },
			'7': { ok: false, input: {}, error: { kind: 'input_validation' } },
			success: { ok: true, input: {}, output: { value: 'completed' } },
			ambiguous: { ok: false, input: {}, error: { kind: 'ambiguous' } },
		},
	};
	const started = new Set(['success', 'ambiguous', '1']);
	expect(
		workerReplyTrimOrder({
			operation: 'mcp_portal_call',
			input: { calls: order.map((id) => ({ id })) },
			result,
			callHasStarted: (id) => started.has(id),
		}),
	).toEqual(['7', '2', 'ambiguous', '1', 'success']);
});

it.each(['ambiguous', 'thrown'] as const)(
	'retains invocation-started facts when the outcome is %s',
	async (kind) => {
		const limits = createWorkerRequestLimits();
		const revision = { owner: 'test-authority', revision: 'one' };
		const invocation: DispatchInvocation = {
			version: 'tool-dispatch-v1',
			authority: 'test-authority',
			operationKey: { authority: 'test-authority', principal: 'agent-one', item: 'may-have-run' },
			capability: { namespace: 'same-server', tool: 'read' },
			arguments: {},
			backendKind: 'mcp_provider',
			bindingRevision: revision,
			admissionRevisions: {
				hostConfig: revision,
				registration: null,
				workspaceAllowance: null,
				profile: revision,
				assignment: revision,
				surfaceSnapshot: revision,
				upstreamBinding: revision,
				accounts: [],
			},
			verifiedContextRef: 'test-proof',
			approvalReceiptRef: null,
			surface: 'mcp',
			correlation: {},
			intentDigest: '1'.repeat(64),
		};
		limits.begin(
			{
				calls: [{ id: 'may-have-run', namespace: 'same-server', toolName: 'read', arguments: {} }],
			},
			'proof',
		);
		expect(limits.callHasStarted('may-have-run')).toBe(false);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const outcome = limits
			.invoke(invocation, async (): Promise<ResourceResult> => {
				entered.resolve();
				await release.promise;
				if (kind === 'thrown') throw new Error('controlled invocation failure');
				return { kind: 'ambiguous', reason: 'controlled uncertain effect' };
			})
			.then(
				(result) => result.kind,
				() => 'thrown',
			);
		await entered.promise;
		try {
			expect(limits.callHasStarted('may-have-run')).toBe(true);
			expect(limits.callHasStarted('not-invoked')).toBe(false);
		} finally {
			release.resolve();
		}
		expect(await outcome).toBe(kind);
		expect(limits.callHasStarted('may-have-run')).toBe(true);
	},
);
