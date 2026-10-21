import {
	dispatchInvocationSchema,
	type DispatchInvocation,
} from '@agent-collaboration/tool-engine/dispatch';
import { describe, expect, it } from 'vitest';

import { openNodeOperationStore } from '#node-host/operations/node-operation-store';
const revision = { owner: 'fixture', revision: 'v1' };

function invocation(item = 'one'): DispatchInvocation {
	return dispatchInvocationSchema.parse({
		version: 'tool-dispatch-v1',
		authority: 'authority',
		operationKey: { authority: 'authority', principal: 'caller-a', item },
		capability: { namespace: 'alpha', tool: 'read' },
		arguments: { value: 42 },
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
		verifiedContextRef: 'verified-a',
		approvalReceiptRef: null,
		surface: 'mcp',
		correlation: {},
		intentDigest: 'a'.repeat(64),
	});
}

describe('process-local approval operation entries', () => {
	it('records only protected calls, serializes creates and arms, scopes lookup and forgets entries on close', async () => {
		const options = {
			directory: 'unused',
			authority: 'authority',
			authorize: (key: { readonly principal: string }, context: string): boolean =>
				key.principal === 'caller-a' && context === 'verified-a',
			now: () => 0,
		};
		const store = await openNodeOperationStore(options);
		const call = invocation();
		expect(await store.createOrRead({ invocation: call, requiresApproval: false })).toEqual({
			kind: 'untracked',
		});
		expect(
			await store.lookup({
				version: 'tool-operation-v1',
				key: call.operationKey,
				verifiedContextRef: 'verified-a',
			}),
		).toEqual({ kind: 'not-found' });
		const created = await Promise.all(
			Array.from({ length: 8 }, async () =>
				store.createOrRead({ invocation: call, requiresApproval: true }),
			),
		);
		expect(created.map((result) => result.kind).toSorted()).toEqual([
			'created',
			...Array<string>(7).fill('existing'),
		]);
		const first = created[0];
		if (first?.kind !== 'created' && first?.kind !== 'existing') throw new Error('Missing record');
		expect(
			await store.createOrRead({
				invocation: { ...call, intentDigest: 'b'.repeat(64) },
				requiresApproval: true,
			}),
		).toEqual({ kind: 'conflict' });
		const arms = await Promise.all(
			Array.from({ length: 8 }, async () =>
				store.transition({
					invocation: call,
					expectedRevision: first.record.revision,
					next: { kind: 'armed' },
				}),
			),
		);
		expect(arms.map((result) => result.kind).toSorted()).toEqual([
			...Array<string>(7).fill('conflict'),
			'found',
		]);
		const armed = arms.find((result) => result.kind === 'found');
		if (armed?.kind !== 'found') throw new Error('No armed record');
		expect(
			await store.transition({
				invocation: call,
				expectedRevision: armed.record.revision,
				next: { kind: 'completed', result: { literal: 42 } },
			}),
		).toMatchObject({
			kind: 'found',
			record: { state: { kind: 'completed', result: { literal: 42 } } },
		});
		expect(
			await store.lookup({
				version: 'tool-operation-v1',
				key: call.operationKey,
				verifiedContextRef: 'verified-b',
			}),
		).toEqual({ kind: 'denied' });
		expect(
			await store.lookup({
				version: 'future',
				key: call.operationKey,
				verifiedContextRef: 'verified-a',
			}),
		).toEqual({ kind: 'unsupported-version' });
		await store.close();
		expect(await store.createOrRead({ invocation: call, requiresApproval: true })).toEqual({
			kind: 'denied',
		});
		const replacement = await openNodeOperationStore(options);
		expect(
			await replacement.lookup({
				version: 'tool-operation-v1',
				key: call.operationKey,
				verifiedContextRef: 'verified-a',
			}),
		).toEqual({ kind: 'not-found' });
		await replacement.close();
	});
});
