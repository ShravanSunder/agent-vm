import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
	dispatchInvocationSchema,
	type DispatchInvocation,
} from '@agent-collaboration/tool-engine/dispatch';
import { describe, expect, it } from 'vitest';

import { openNodeOperationStore } from '#node-host/operations/node-operation-store';
import { fixtureDirectory, revision } from '#node-host/test-fixtures/node-host-fixture';

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

describe('fenced crash-durable public Node operation records', () => {
	it('serializes overlapping creates and conditional arms, preserves records after orderly reopen, scopes lookup and conflicts on changed intent', async () => {
		const directory = await fixtureDirectory();
		const options = {
			directory,
			authority: 'authority',
			authorize: (key: { readonly principal: string }, context: string): boolean =>
				key.principal === 'caller-a' && context === 'verified-a',
			now: () => 0,
		};
		const store = await openNodeOperationStore(options);
		const call = invocation();
		const created = await Promise.all(
			Array.from({ length: 8 }, async () =>
				store.createOrRead({ invocation: call, requiresApproval: false }),
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
				requiresApproval: false,
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
			await store.createOrRead({ invocation: invocation('two'), requiresApproval: false }),
		).toMatchObject({ kind: 'created', record: { key: { item: 'two' } } });
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
		await expect(openNodeOperationStore(options)).rejects.toThrow(/store-already-active/u);
		await store.close();
		const reopened = await openNodeOperationStore(options);
		try {
			expect(
				await reopened.lookup({
					version: 'tool-operation-v1',
					key: call.operationKey,
					verifiedContextRef: 'verified-a',
				}),
			).toMatchObject({
				kind: 'found',
				record: {
					createdAt: '1970-01-01T00:00:00.000Z',
					state: { kind: 'completed', result: { literal: 42 } },
				},
			});
		} finally {
			await reopened.close();
		}
	});
	it('returns unavailable when record storage cannot write; never returns untracked', async () => {
		const directory = await fixtureDirectory();
		const store = await openNodeOperationStore({
			directory,
			authority: 'authority',
			authorize: () => true,
		});
		await writeFile(path.join(directory, 'tool-operations-v1'), 'not a directory');
		try {
			expect(
				await store.createOrRead({ invocation: invocation(), requiresApproval: false }),
			).toEqual({ kind: 'unavailable' });
		} finally {
			await store.close();
		}
	});
});
