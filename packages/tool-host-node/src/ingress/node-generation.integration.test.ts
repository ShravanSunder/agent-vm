import type {
	ApprovalPort,
	ApprovalReceipt,
	DispatchInvocation,
} from '@agent-collaboration/tool-engine/dispatch';
import { describe, expect, it } from 'vitest';

import { compileNodeHostCredentialSet } from '#node-host/ingress/bearer-credentials';
import { startNodeHost } from '#node-host/node-host-startup';
import {
	connectClient,
	decodedResult,
	fixtureConfig,
	fixtureDirectory,
	startControlledProvider,
	writeFixtureConfig,
} from '#node-host/test-fixtures/node-host-fixture';

function receiptFor(invocation: DispatchInvocation, reference: string): ApprovalReceipt {
	return {
		reference,
		decision: 'approve',
		authoritativeRevision: { owner: 'test-approval', revision: 'v1' },
		operationKey: invocation.operationKey,
		intentDigest: invocation.intentDigest,
		backendKind: invocation.backendKind,
		bindingRevision: invocation.bindingRevision,
		admissionRevisions: invocation.admissionRevisions,
		verifiedContextRef: invocation.verifiedContextRef,
		expiresAt: '2099-01-01T00:00:00.000Z',
	};
}

for (const exposure of ['compact', 'catalog'] as const) {
	describe(`${exposure}: current authority generation at real ingress`, () => {
		it('rejects a previous-generation approval, admits the exact current receipt, and keeps completed history reusable at the same key', async () => {
			const directory = await fixtureDirectory();
			const alpha = await startControlledProvider('alpha');
			const beta = await startControlledProvider('beta');
			const config = fixtureConfig(directory, [alpha.url, beta.url], exposure);
			const configPath = await writeFixtureConfig(config, directory);
			let previous: ApprovalReceipt | undefined;
			let current: ApprovalReceipt | undefined;
			let mode: 'pending' | 'old-receipt' | 'current-receipt' = 'pending';
			const approvals: ApprovalPort = {
				challenge: async (invocation) => {
					if (mode === 'pending') {
						previous = receiptFor(invocation, 'previous-generation');
						return {
							kind: 'pending',
							challenge: {
								authority: invocation.authority,
								approvalId: previous.reference,
								operationKey: invocation.operationKey,
								intentDigest: invocation.intentDigest,
								callerDisplay: 'test caller',
								targetDisplay: 'controlled provider',
								revisions: invocation.admissionRevisions,
								expiresAt: previous.expiresAt,
								permittedDecisions: ['approve', 'deny'],
							},
						};
					}
					current = receiptFor(invocation, 'current-generation');
					const offered = mode === 'old-receipt' ? previous : current;
					if (offered === undefined) throw new Error('Missing previous receipt fixture');
					return { kind: 'approved', receipt: offered };
				},
				receipt: async () => {
					const offered = mode === 'old-receipt' ? previous : current;
					return offered === undefined
						? { kind: 'unavailable' }
						: { kind: 'approved', receipt: offered };
				},
				decision: async () => ({ kind: 'unavailable' }),
			};
			const request = (
				tool: 'ask' | 'read',
				item: string,
			): {
				readonly name: string;
				readonly arguments: Record<string, unknown>;
				readonly _meta?: Record<string, string>;
			} =>
				exposure === 'compact'
					? {
							name: 'mcp_portal_call',
							arguments: {
								calls: [{ id: item, namespace: 'alpha', toolName: tool, arguments: { value: 42 } }],
							},
						}
					: {
							name: tool === 'ask' ? 'alpha__ask__645775a667' : 'alpha__read__151160dc30',
							arguments: { value: 42 },
							_meta: { 'tool-portal/operation-item': item },
						};
			const secrets = { resolve: async (): Promise<string> => 'test-only-secret' };
			let host = await startNodeHost({ configPath, secrets, approvals });
			if (host.http === undefined) throw new Error('Missing HTTP ingress');
			let connection = await connectClient(host.http.endpoint, 'credential-a');
			try {
				expect(
					decodedResult(await connection.client.callTool(request('ask', 'pending-item'))),
				).toMatchObject({ ok: false });
				expect(alpha.effects).toEqual([]);
				const completed = await connection.client.callTool(request('read', 'completed-item'));
				const key = { authority: config.authority, principal: 'agent-a', item: 'completed-item' };
				const originalContext = compileNodeHostCredentialSet(config.auth).credentials[0]
					?.credentialId;
				if (originalContext === undefined) throw new Error('Missing authenticated fixture context');
				const before = await host.composition.operations.lookup({
					version: 'tool-operation-v1',
					key,
					verifiedContextRef: originalContext,
				});
				expect(before).toMatchObject({
					kind: 'found',
					record: { key, state: { kind: 'completed' } },
				});
				await connection.client.close();
				await host.retire();
				const replacement = {
					...config,
					auth: { ...config.auth, serviceGeneration: 'generation-2' },
				};
				await writeFixtureConfig(replacement, directory);
				mode = 'old-receipt';
				host = await startNodeHost({ configPath, secrets, approvals });
				if (host.http === undefined) throw new Error('Missing replacement HTTP ingress');
				connection = await connectClient(host.http.endpoint, 'credential-a');
				const oldReply = await connection.client.callTool(request('ask', 'pending-item'));
				expect(alpha.effects.filter((effect) => effect.name === 'ask')).toEqual([]);
				expect(decodedResult(oldReply)).toMatchObject({ ok: false });
				mode = 'current-receipt';
				expect(
					decodedResult(await connection.client.callTool(request('ask', 'pending-item'))),
				).toMatchObject({ ok: true });
				expect(current?.verifiedContextRef).not.toBe(previous?.verifiedContextRef);
				expect(current?.operationKey).toEqual(previous?.operationKey);
				expect(alpha.effects.filter((effect) => effect.name === 'ask')).toHaveLength(1);
				const replacementContext = compileNodeHostCredentialSet(replacement.auth).credentials[0]
					?.credentialId;
				if (replacementContext === undefined)
					throw new Error('Missing replacement fixture context');
				expect(
					await host.composition.operations.lookup({
						version: 'tool-operation-v1',
						key,
						verifiedContextRef: replacementContext,
					}),
				).toEqual(before);
				expect(await connection.client.callTool(request('read', 'completed-item'))).toEqual(
					completed,
				);
				expect(alpha.effects.filter((effect) => effect.name === 'read')).toHaveLength(1);
			} finally {
				await connection.client.close();
				await host.retire();
				await alpha.close();
				await beta.close();
			}
		});
	});
}
