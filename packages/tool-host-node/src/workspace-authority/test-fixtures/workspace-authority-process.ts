import { once } from 'node:events';
import { createInterface } from 'node:readline';

import { removalNoticeSchema } from '@agent-collaboration/tool-access/contracts';
import { createWorkspaceAuthority } from '@agent-collaboration/tool-host-core';

import { openNodeWorkspaceAuthorityStore } from '#node-host/workspace-authority/node-workspace-authority-store';

const databasePath = process.argv[2];
const operation = process.argv[3];
if (databasePath === undefined) throw new Error('Missing database file');
const store = await openNodeWorkspaceAuthorityStore({ databasePath });
const authority = createWorkspaceAuthority({ store, clock: { nowMs: () => 1000 }, cap: 1024 });
const notice = removalNoticeSchema.parse({
	noticeId: '019a1335-20c0-7000-8000-000000000001',
	organizationId: '11111111-1111-4111-8111-111111111111',
	workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
	subject: { kind: 'bot', botId: '22222222-2222-4222-8222-222222222222' },
	removalRevision: 8,
	reason: 'personaChanged',
});
try {
	let result: unknown;
	if (operation === 'record') {
		result = {
			notice: await authority.recordRemovalNotice(notice),
			approval: await authority.consumeApprovalToken('principal:approval', 20_000),
		};
	} else if (operation === 'read') {
		result = {
			mark: await authority.readRemovalMark(notice.subject),
			notice: await authority.recordRemovalNotice(notice),
			approval: await authority.consumeApprovalToken('principal:approval', 20_000),
			uses: await store.read('approval-uses-v1'),
		};
	} else if (operation === 'contend') {
		const lines = createInterface({ input: process.stdin });
		const released = once(lines, 'line');
		process.stdout.write(`${JSON.stringify({ ready: true, pid: process.pid })}\n`);
		await released;
		lines.close();
		result = await authority.consumeApprovalToken('principal:contended', 20_000);
	} else {
		throw new Error('Unknown process operation');
	}
	await store.close();
	process.stdout.write(`${JSON.stringify({ pid: process.pid, result })}\n`);
} finally {
	await store.close();
}
