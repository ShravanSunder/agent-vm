import { createAccessAssessor } from '@agent-collaboration/tool-access/authorization';
import { assessAccessInput } from '@agent-collaboration/tool-access/contracts';
import {
	createCapabilityDispatcher,
	canonicalDispatchJson,
	dispatchIntentDigest,
	dispatchInvocationSchema,
	type ApprovalPort,
	type ApprovalReceipt,
	type BackendKind,
	type DispatchInvocation,
	type DispatchRequest,
	type OperationPort,
	type OperationRecord,
	type ToolBackend,
} from '@agent-collaboration/tool-engine/capability-dispatch';
import { projectManagedAccessProfile } from '@agent-vm/gateway-runtime/managed-tool-engine/managed-access/access-profile-projection.js';
import { toolPortalConfig } from '@agent-vm/gateway-runtime/managed-tool-engine/test-fixtures/managed-profile-test-fixture.js';
import { describe, expect, it, vi } from 'vitest';

const revision = { owner: 'controller', revision: 'policy:1' };
const now = Date.parse('2026-10-20T12:00:00.000Z');
function request(): DispatchRequest {
	return {
		authority: 'computer-a',
		principal: 'agent-a',
		item: 'original-item',
		verifiedContextRef: 'issuance-a',
		correlation: {},
		access: assessAccessInput.parse({
			capability: { namespace: 'github', tool: 'get_issue' },
			surface: 'protected_uds',
			call: { arguments: { issue: 42 }, account: null, digest: 'a'.repeat(64) },
			facts: {
				workspace: { kind: 'not-configured' },
				assignment: {
					profile: projectManagedAccessProfile({
						config: toolPortalConfig,
						profileId: 'gate-c-profile',
					}),
					profileRevision: revision,
					revision,
				},
				surface: { eligible: ['protected_uds'], snapshot: revision },
				accounts: [],
				upstream: { status: 'available', credentialNeed: 'none', binding: revision },
			},
		}),
	};
}
function requireApproval(input: DispatchRequest): void {
	const policy = input.access.facts.assignment.profile.namespaces.github;
	if (policy === undefined) throw new Error('Missing fixture policy.');
	policy.calls = {
		kind: 'selectors',
		withoutApproval: { allow: [], deny: [] },
		requiresApproval: { allow: ['get_issue'], deny: [] },
	};
}
function harness(): {
	dispatcher: ReturnType<typeof createCapabilityDispatcher>;
	invocations: DispatchInvocation[];
	operations: OperationPort;
	approvals: ApprovalPort;
	keys: DispatchInvocation['operationKey'][];
} {
	const invocations: DispatchInvocation[] = [];
	const keys: DispatchInvocation['operationKey'][] = [];
	const records = new Map<string, OperationRecord>();
	const operations: OperationPort = {
		createOrRead: async ({ invocation }) => {
			keys.push(invocation.operationKey);
			const key = JSON.stringify(invocation.operationKey);
			const old = records.get(key);
			if (old !== undefined)
				return old.intentDigest === invocation.intentDigest
					? { kind: 'existing', record: old }
					: { kind: 'conflict' };
			const record: OperationRecord = {
				version: 'tool-operation-v1',
				key: invocation.operationKey,
				intentDigest: invocation.intentDigest,
				createdAt: new Date(now).toISOString(),
				updatedAt: new Date(now).toISOString(),
				revision: '1',
				state: { kind: 'ready' },
			};
			records.set(key, record);
			return { kind: 'created', record };
		},
		lookup: async ({ key }) => {
			const record = records.get(JSON.stringify(key));
			return record === undefined ? { kind: 'not-found' } : { kind: 'found', record };
		},
		transition: async ({ invocation, expectedRevision, next }) => {
			const key = JSON.stringify(invocation.operationKey);
			const record = records.get(key);
			if (record === undefined || record.revision !== expectedRevision) return { kind: 'conflict' };
			const updated = { ...record, revision: String(Number(record.revision) + 1), state: next };
			records.set(key, updated);
			return { kind: 'found', record: updated };
		},
	};
	function receipt(invocation: DispatchInvocation): ApprovalReceipt {
		return {
			reference: 'receipt:1',
			decision: 'approve',
			authoritativeRevision: revision,
			operationKey: invocation.operationKey,
			intentDigest: invocation.intentDigest,
			backendKind: invocation.backendKind,
			bindingRevision: invocation.bindingRevision,
			admissionRevisions: invocation.admissionRevisions,
			verifiedContextRef: invocation.verifiedContextRef,
			expiresAt: '2026-10-20T13:00:00.000Z',
		};
	}
	const approvals: ApprovalPort = {
		challenge: async (invocation) => ({ kind: 'approved', receipt: receipt(invocation) }),
		receipt: async ({ invocation }) => ({ kind: 'approved', receipt: receipt(invocation) }),
		decision: async () => ({ kind: 'denied' }),
	};
	const backend: ToolBackend<BackendKind> = {
		backendKind: 'mcp_provider',
		list: async () => ({}),
		describe: async () => ({}),
		search: async () => ({}),
		invoke: async (invocation) => {
			invocations.push(invocation);
			return { kind: 'completed', result: { issue: 42 } };
		},
	};
	return {
		invocations,
		operations,
		approvals,
		keys,
		dispatcher: createCapabilityDispatcher({
			assessAccess: createAccessAssessor({ workspaceLayer: 'not-configured', config: revision }),
			operations,
			approvals,
			backends: new Map([['mcp_provider', backend]]),
			now: () => now,
		}),
	};
}

// Oracles: Spec R3/R5, Program Design §1 and stable operations; all effects are process-local recorders.
describe('neutral capability dispatch', () => {
	it('admits the real managed projection and returns the backend result', async () => {
		const subject = harness();
		expect(await subject.dispatcher.dispatch(request())).toEqual({
			kind: 'completed',
			result: { issue: 42 },
		});
		expect(subject.invocations).toHaveLength(1);
	});
	it.each(['policy', 'surface'] as const)(
		'refuses a real %s denial before invoke',
		async (kind) => {
			const subject = harness();
			const input = request();
			if (kind === 'surface') input.access.facts.surface.eligible = [];
			else {
				const policy = input.access.facts.assignment.profile.namespaces.github;
				if (policy === undefined) throw new Error('Missing policy.');
				policy.tools.deny = ['get_issue'];
			}
			expect(await subject.dispatcher.dispatch(input)).toMatchObject({ kind: 'denied' });
			expect(subject.invocations).toEqual([]);
			expect(subject.keys).toEqual([]);
		},
	);
	it('refuses contradictory workspace facts with the specified unavailable state', async () => {
		const subject = harness();
		const input = request();
		input.access.facts.workspace = {
			kind: 'configured',
			registration: { status: 'active', revision },
			allowance: {
				allowed: true,
				revision,
				rule: { source: 'workspace-allowance', ruleId: 'workspace-a' },
			},
		};
		expect(await subject.dispatcher.dispatch(input)).toEqual({
			kind: 'denied',
			state: { kind: 'not-usable', firstUnmet: 'service-unavailable' },
		});
		expect(subject.invocations).toEqual([]);
	});
	it('catches an assessor parse error from malformed facts', async () => {
		const subject = harness();
		const input = request();
		// The boundary can receive malformed JSON despite its static type.
		Reflect.set(input.access.facts, 'upstream', { status: 'available' });
		expect(await subject.dispatcher.dispatch(input)).toEqual({
			kind: 'denied',
			state: { kind: 'not-usable', firstUnmet: 'service-unavailable' },
		});
		expect(subject.invocations).toEqual([]);
	});
	it.each(['denied', 'unavailable', 'unsupported-version', 'conflict'] as const)(
		'does not invoke when create-or-read is %s',
		async (kind) => {
			const subject = harness();
			vi.spyOn(subject.operations, 'createOrRead').mockImplementation(async () => ({ kind }));
			expect(await subject.dispatcher.dispatch(request())).toEqual({
				kind: 'not-dispatched',
				reason: kind,
			});
			expect(subject.invocations).toEqual([]);
		},
	);
	it.each(['pending', 'denied', 'unavailable', 'expired'] as const)(
		'does not invoke without an exact receipt: %s',
		async (kind) => {
			const subject = harness();
			const input = request();
			requireApproval(input);
			vi.spyOn(subject.approvals, 'challenge').mockImplementation(async (invocation) =>
				kind === 'pending'
					? {
							kind,
							challenge: {
								authority: invocation.authority,
								approvalId: 'challenge:1',
								operationKey: invocation.operationKey,
								intentDigest: invocation.intentDigest,
								callerDisplay: 'agent',
								targetDisplay: 'provider',
								revisions: invocation.admissionRevisions,
								expiresAt: '2026-10-20T13:00:00.000Z',
								permittedDecisions: ['approve', 'deny'],
							},
						}
					: { kind },
			);
			expect((await subject.dispatcher.dispatch(input)).kind).not.toBe('completed');
			expect(subject.invocations).toEqual([]);
		},
	);
	it.each(['conflict', 'denied', 'unavailable', 'unsupported-version'] as const)(
		'does not invoke when the arm transition is %s',
		async (kind) => {
			const subject = harness();
			vi.spyOn(subject.operations, 'transition').mockImplementation(async () => ({ kind }));
			expect(await subject.dispatcher.dispatch(request())).toEqual({
				kind: 'not-dispatched',
				reason: kind,
			});
			expect(subject.invocations).toEqual([]);
		},
	);
	it.each([
		'item',
		'digest',
		'principal',
		'backend',
		'revision',
		'admission-revision',
		'issuance',
		'expired',
	] as const)('refuses a schema-valid wrong receipt binding: %s', async (field) => {
		const subject = harness();
		const input = request();
		requireApproval(input);
		const original = subject.approvals.challenge;
		vi.spyOn(subject.approvals, 'challenge').mockImplementation(async (invocation) => {
			const result = await original(invocation);
			if (result.kind !== 'approved') throw new Error('Fixture must approve.');
			const receipt = result.receipt;
			if (field === 'item')
				receipt.operationKey = { ...receipt.operationKey, item: 'another-item' };
			if (field === 'principal')
				receipt.operationKey = { ...receipt.operationKey, principal: 'another-agent' };
			if (field === 'digest') receipt.intentDigest = 'b'.repeat(64);
			if (field === 'backend') receipt.backendKind = 'tool_vm_runner';
			if (field === 'revision') receipt.bindingRevision = { ...revision, revision: 'stale' };
			if (field === 'admission-revision')
				receipt.admissionRevisions = {
					...receipt.admissionRevisions,
					assignment: { ...revision, revision: 'stale-assignment' },
				};
			if (field === 'issuance') receipt.verifiedContextRef = 'another-issuance';
			if (field === 'expired') receipt.expiresAt = '2026-10-20T11:00:00.000Z';
			return result;
		});
		expect((await subject.dispatcher.dispatch(input)).kind).not.toBe('completed');
		expect(subject.invocations).toEqual([]);
	});
	it('pins public canonical bytes, intent digest and explicit version refusal', async () => {
		const subject = harness();
		await subject.dispatcher.dispatch(request());
		const incoming = subject.invocations[0];
		if (incoming === undefined) throw new Error('Expected invoke.');
		expect(canonicalDispatchJson({ z: [2, 1], a: { b: true, a: null } })).toBe(
			'{"a":{"a":null,"b":true},"z":[2,1]}',
		);
		expect(await dispatchIntentDigest(incoming)).toBe(
			'6199b07f98bc86557c7f7a1ddd51e36f10e460122286df72d5d9cd8f501e125b',
		);
		expect(dispatchInvocationSchema.safeParse({ ...incoming, version: 'legacy-v1' }).success).toBe(
			false,
		);
	});
	it('invokes with an exact current receipt', async () => {
		const subject = harness();
		const input = request();
		requireApproval(input);
		expect(await subject.dispatcher.dispatch(input)).toEqual({
			kind: 'completed',
			result: { issue: 42 },
		});
		expect(subject.invocations[0]?.approvalReceiptRef).toBe('receipt:1');
	});
	it.each(['denied', 'unavailable', 'expired'] as const)(
		'refuses a receipt becoming %s after its challenge',
		async (kind) => {
			const subject = harness();
			const input = request();
			requireApproval(input);
			vi.spyOn(subject.approvals, 'receipt').mockImplementation(async () => ({ kind }));
			expect(await subject.dispatcher.dispatch(input)).toEqual({
				kind: 'not-dispatched',
				reason: kind,
			});
			expect(subject.invocations).toEqual([]);
		},
	);
	it('requires a record for protected work even when the approval port would approve', async () => {
		const subject = harness();
		vi.spyOn(subject.operations, 'createOrRead').mockImplementation(async () => ({
			kind: 'untracked',
		}));
		const input = request();
		requireApproval(input);
		expect((await subject.dispatcher.dispatch(input)).kind).toBe('denied');
		expect(subject.invocations).toEqual([]);
	});
	it('lets any host leave unprotected calls unrecorded without a reuse guarantee', async () => {
		// Arrange: a public host explicitly declines recording; its store cannot transition.
		const subject = harness();
		const create = vi
			.spyOn(subject.operations, 'createOrRead')
			.mockResolvedValue({ kind: 'untracked' });
		const transition = vi
			.spyOn(subject.operations, 'transition')
			.mockRejectedValue(new Error('No record'));
		const challenge = vi.spyOn(subject.approvals, 'challenge');
		// Act: the same item is intentional work again, not a retained completion.
		const results = [
			await subject.dispatcher.dispatch(request()),
			await subject.dispatcher.dispatch(request()),
		];
		// Assert: both effects run without approval or a nonexistent record transition.
		expect(results).toEqual([
			{ kind: 'completed', result: { issue: 42 } },
			{ kind: 'completed', result: { issue: 42 } },
		]);
		expect(subject.invocations).toHaveLength(2);
		expect(create.mock.calls.map(([input]) => input.requiresApproval)).toEqual([false, false]);
		expect(transition).not.toHaveBeenCalled();
		expect(challenge).not.toHaveBeenCalled();
	});
	it('retains the original key across reconnect/revision change, reuses completion and conflicts on changed intent', async () => {
		const subject = harness();
		const first = request();
		await subject.dispatcher.dispatch(first);
		const retry = { ...request(), verifiedContextRef: 'new-issuance' };
		retry.access.facts.assignment.revision = { ...revision, revision: 'assignment:2' };
		expect(await subject.dispatcher.dispatch(retry)).toEqual({
			kind: 'completed',
			result: { issue: 42 },
		});
		expect(subject.invocations).toHaveLength(1);
		expect(subject.keys).toEqual([
			{ authority: 'computer-a', principal: 'agent-a', item: 'original-item' },
			{ authority: 'computer-a', principal: 'agent-a', item: 'original-item' },
		]);
		if (retry.access.call === null) throw new Error('Missing fixture call.');
		retry.access.call.arguments = { issue: 43 };
		expect(await subject.dispatcher.dispatch(retry)).toEqual({
			kind: 'not-dispatched',
			reason: 'conflict',
		});
		expect(subject.invocations).toHaveLength(1);
	});
	it.each(['armed', 'ambiguous', 'result-expired', 'completed'] as const)(
		'does not redispatch an existing %s operation at the same key and intent',
		async (kind) => {
			// Arrange: the operation authority already owns this exact original item.
			const subject = harness();
			vi.spyOn(subject.operations, 'createOrRead').mockImplementation(async ({ invocation }) => ({
				kind: 'existing',
				record: {
					version: 'tool-operation-v1',
					key: invocation.operationKey,
					intentDigest: invocation.intentDigest,
					createdAt: new Date(now).toISOString(),
					updatedAt: new Date(now).toISOString(),
					revision: 'held:1',
					state:
						kind === 'completed'
							? { kind, result: { retained: 'original-result' } }
							: kind === 'ambiguous'
								? { kind, reason: 'previous-attempt-unconfirmed' }
								: { kind },
				},
			}));
			const transition = vi.spyOn(subject.operations, 'transition');
			const challenge = vi.spyOn(subject.approvals, 'challenge');
			// Act
			const result = await subject.dispatcher.dispatch(request());
			// Assert: retained state, never a fresh effect or approval/arm attempt.
			expect(result).toEqual(
				kind === 'completed'
					? { kind: 'completed', result: { retained: 'original-result' } }
					: kind === 'result-expired'
						? { kind: 'result-expired' }
						: { kind: 'ambiguous', reason: 'operation-may-have-dispatched' },
			);
			expect(subject.invocations).toEqual([]);
			expect(transition).not.toHaveBeenCalled();
			expect(challenge).not.toHaveBeenCalled();
		},
	);
	it('keeps identical intentional items and principals distinct, and lookup never invokes', async () => {
		const subject = harness();
		await subject.dispatcher.dispatch(request());
		await subject.dispatcher.dispatch({ ...request(), item: 'second-item' });
		await subject.dispatcher.dispatch({ ...request(), principal: 'agent-b' });
		expect(subject.invocations.map(({ operationKey }) => operationKey)).toEqual([
			{ authority: 'computer-a', principal: 'agent-a', item: 'original-item' },
			{ authority: 'computer-a', principal: 'agent-a', item: 'second-item' },
			{ authority: 'computer-a', principal: 'agent-b', item: 'original-item' },
		]);
		expect(
			(
				await subject.dispatcher.lookup({
					version: 'tool-operation-v1',
					key: { authority: 'computer-a', principal: 'agent-a', item: 'original-item' },
					verifiedContextRef: 'issuance-a',
				})
			).kind,
		).toBe('found');
		expect(subject.invocations).toHaveLength(3);
	});
});
