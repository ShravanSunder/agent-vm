import { createAccessAssessor } from '@agent-collaboration/tool-access/authorization';
import { assessAccessInput } from '@agent-collaboration/tool-access/contracts';
import { describe, expect, it } from 'vitest';

import { createCapabilityDispatcher } from '#capability-dispatch/capability-dispatcher';
import {
	approvalReceiptSchema,
	dispatchInvocationSchema,
	operationKeySchema,
	resourceResultSchema,
} from '#capability-dispatch/models/dispatch-contracts';
import {
	createStandaloneCoreFixture,
	fixtureRevision,
} from '#capability-dispatch/standalone-portal-core-fixture';
import { proxyUpstreamFailureResult } from '#mcp-gateway/proxy-results/proxy-upstream-failure';

describe('dispatch public names and opaque references', () => {
	it('retains 1024-character operation-key fields and refuses each at 1025', () => {
		const key = {
			authority: 'a'.repeat(1024),
			principal: 'p'.repeat(1024),
			item: 'i'.repeat(1024),
		};
		expect(operationKeySchema.safeParse(key).success).toBe(true);
		for (const field of ['authority', 'principal', 'item'] as const)
			expect(operationKeySchema.safeParse({ ...key, [field]: 'x'.repeat(1025) }).success).toBe(
				false,
			);
	});

	it('keeps verified contexts and receipt references bounded and digests exactly 64 hexadecimal digits', async () => {
		const fixture = createStandaloneCoreFixture();
		await fixture.core.call(
			{ calls: [{ id: 'read', namespace: 'example', name: 'read', arguments: {} }] },
			{ authenticatedRef: 'host-verified-agent' },
		);
		const invocation = fixture.effects[0];
		if (invocation === undefined) throw new Error('Expected real dispatcher invocation.');
		expect(
			dispatchInvocationSchema.safeParse({
				...invocation,
				verifiedContextRef: 'c'.repeat(1024),
				approvalReceiptRef: 'r'.repeat(1024),
			}).success,
		).toBe(true);
		for (const field of ['verifiedContextRef', 'approvalReceiptRef'] as const)
			expect(
				dispatchInvocationSchema.safeParse({ ...invocation, [field]: 'x'.repeat(1025) }).success,
			).toBe(false);
		for (const digest of ['a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64)])
			expect(
				dispatchInvocationSchema.safeParse({ ...invocation, intentDigest: digest }).success,
			).toBe(false);
		const receipt = {
			reference: 'r'.repeat(1024),
			decision: 'approve',
			authoritativeRevision: fixtureRevision,
			operationKey: invocation.operationKey,
			intentDigest: invocation.intentDigest,
			backendKind: invocation.backendKind,
			bindingRevision: invocation.bindingRevision,
			admissionRevisions: invocation.admissionRevisions,
			verifiedContextRef: invocation.verifiedContextRef,
			expiresAt: '2026-10-21T00:05:00.000Z',
		};
		expect(approvalReceiptSchema.safeParse(receipt).success).toBe(true);
		expect(
			approvalReceiptSchema.safeParse({ ...receipt, reference: 'r'.repeat(1025) }).success,
		).toBe(false);
	});

	it.each([257, 10_000])(
		'preserves a %i-character policy-refusal rule through the actual resource result schema',
		async (length) => {
			const name = 't'.repeat(length);
			const namespace = 'n'.repeat(length);
			const invocation = await createStandaloneCoreFixture().resolve({
				authenticatedRef: 'host-verified-agent',
			});
			const base = await invocation.accessForCall({
				id: 'read',
				namespace: 'example',
				name: 'read',
				arguments: {},
			});
			const policy = base.facts.assignment.profile.namespaces['example'];
			if (policy === undefined) throw new Error('Missing fixture policy.');
			const input = assessAccessInput.parse({
				...base,
				capability: { namespace, tool: name },
				facts: {
					...base.facts,
					assignment: {
						...base.facts.assignment,
						profile: {
							profileId: 'profile',
							namespaces: {
								[namespace]: {
									...policy,
									tools: { allow: '*', deny: [] },
									calls: {
										kind: 'selectors',
										withoutApproval: { allow: [], deny: [] },
										requiresApproval: { allow: [], deny: [] },
									},
								},
							},
						},
					},
				},
			});
			const result = createAccessAssessor({
				workspaceLayer: 'not-configured',
				config: fixtureRevision,
			})(input);
			if (result.kind !== 'assessed' || result.assessment.kind !== 'fixed')
				throw new Error('Expected fixed policy refusal.');
			expect(result.assessment.state).toEqual({
				kind: 'blocked-by-policy',
				rule: { source: 'mcp-approval-policy', ruleId: name },
			});
			expect(
				resourceResultSchema.parse({ kind: 'denied', state: result.assessment.state }),
			).toEqual({ kind: 'denied', state: result.assessment.state });
			let effects = 0;
			const dispatcher = createCapabilityDispatcher({
				assessAccess: createAccessAssessor({
					workspaceLayer: 'not-configured',
					config: fixtureRevision,
				}),
				now: () => 0,
				operations: {
					createOrRead: async () => ({ kind: 'untracked' }),
					lookup: async () => ({ kind: 'not-found' }),
					transition: async () => ({ kind: 'denied' }),
				},
				approvals: {
					challenge: async () => ({ kind: 'unavailable' }),
					receipt: async () => ({ kind: 'unavailable' }),
					decision: async () => ({ kind: 'unavailable' }),
				},
				backends: new Map([
					[
						'mcp_provider',
						{
							backendKind: 'mcp_provider',
							list: async () => null,
							search: async () => null,
							describe: async () => null,
							invoke: async () => {
								effects += 1;
								return { kind: 'completed', result: { executed: true } };
							},
						},
					],
				]),
			});
			const dispatchRequest = {
				authority: 'host',
				principal: 'agent',
				item: 'item',
				verifiedContextRef: 'host-context',
				correlation: {},
				access: input,
			};
			expect(resourceResultSchema.parse(await dispatcher.dispatch(dispatchRequest))).toEqual({
				kind: 'denied',
				state: result.assessment.state,
			});
			expect(effects).toBe(0);
			const allowedInput = assessAccessInput.parse({
				...input,
				facts: {
					...input.facts,
					assignment: {
						...input.facts.assignment,
						profile: {
							...input.facts.assignment.profile,
							namespaces: {
								[namespace]: {
									...policy,
									tools: { allow: '*', deny: [] },
									calls: {
										kind: 'selectors',
										withoutApproval: { allow: '*', deny: [] },
										requiresApproval: { allow: [], deny: [] },
									},
								},
							},
						},
					},
				},
			});
			expect(await dispatcher.dispatch({ ...dispatchRequest, access: allowedInput })).toEqual({
				kind: 'completed',
				result: { executed: true },
			});
			expect(effects).toBe(1);
		},
	);

	it.each(['namespace', 'tool', 'both'] as const)(
		'keeps long %s provider failure names and messages with honest certainty',
		(mode) => {
			const namespace = mode === 'tool' ? 'example' : 'n'.repeat(10_000);
			const toolName = mode === 'namespace' ? 'read' : 't'.repeat(10_000);
			for (const failureClass of ['tool_error', undefined] as const) {
				const result = proxyUpstreamFailureResult({
					namespace,
					toolName,
					failure: {
						kind: 'upstream_mcp_failed',
						namespace,
						toolName,
						phase: 'call_tool',
						operation: 'callTool',
						elapsedMs: 1,
						causeMessage: 'Upstream MCP provider failed.',
						transport: { kind: 'streamable-http' },
						...(failureClass === undefined ? {} : { failureClass }),
					},
				});
				expect(result.kind).toBe(failureClass === 'tool_error' ? 'failed' : 'ambiguous');
				if (result.kind !== 'failed' && result.kind !== 'ambiguous')
					throw new Error('Expected upstream failure result.');
				expect(result.detail).toMatchObject({
					code: 'upstream_call_failed',
					namespace,
					toolName,
					message: `${namespace}: call_tool ${toolName} failed`,
					upstream: { namespace, toolName },
				});
				expect(resourceResultSchema.parse(result)).toEqual(result);
			}
		},
	);
});
