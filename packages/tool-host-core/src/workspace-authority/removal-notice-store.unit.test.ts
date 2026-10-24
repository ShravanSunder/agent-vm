import { removalNoticeSchema } from '@agent-collaboration/tool-access/contracts';
import { expect, it } from 'vitest';

import { createVolatileAuthorityStore } from '#tool-host-core/workspace-authority/volatile-authority-store';
import { createWorkspaceAuthority } from '#tool-host-core/workspace-authority/workspace-authority';

const notice = removalNoticeSchema.parse({
	noticeId: '019a1335-20c0-7000-8000-000000000001',
	organizationId: '11111111-1111-4111-8111-111111111111',
	workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
	subject: { kind: 'bot', botId: '22222222-2222-4222-8222-222222222222' },
	removalRevision: 8,
	reason: 'personaChanged',
});
it('never lowers a removal mark for a late lower notice and records each ID once', async () => {
	const store = createVolatileAuthorityStore();
	const authority = createWorkspaceAuthority({ store, clock: { nowMs: () => 1000 }, cap: 1024 });
	expect(await authority.recordRemovalNotice(notice)).toEqual({
		result: 'recorded',
		noticeId: notice.noticeId,
	});
	expect(await authority.recordRemovalNotice({ ...notice, removalRevision: 99 })).toEqual({
		result: 'alreadyRecorded',
		noticeId: notice.noticeId,
	});
	expect(
		await authority.recordRemovalNotice({
			...notice,
			noticeId: '019a1335-20c0-7000-8000-000000000002',
			removalRevision: 7,
		}),
	).toMatchObject({ result: 'recorded' });
	expect(await authority.readRemovalMark(notice.subject)).toBe(8);
	expect(await store.read('removal-notices-v1')).toEqual({
		marks: {
			'["bot","22222222-2222-4222-8222-222222222222"]': { revision: 8, retainUntilMs: 3_661_000 },
		},
		noticeIds: { [notice.noticeId]: 3_661_000, '019a1335-20c0-7000-8000-000000000002': 3_661_000 },
	});
});
it('keeps marks and notice IDs through receipt plus 61 minutes minus one second, and prunes after', async () => {
	let nowMs = 1000;
	const store = createVolatileAuthorityStore();
	const authority = createWorkspaceAuthority({ store, clock: { nowMs: () => nowMs }, cap: 1024 });
	await authority.recordRemovalNotice(notice);
	nowMs = 3_660_000;
	await authority.pruneRemovalNotices();
	expect(await authority.readRemovalMark(notice.subject)).toBe(8);
	expect(await authority.recordRemovalNotice(notice)).toMatchObject({ result: 'alreadyRecorded' });
	nowMs = 3_662_000;
	await authority.pruneRemovalNotices();
	expect(await authority.readRemovalMark(notice.subject)).toBeNull();
	expect(await store.read('removal-notices-v1')).toEqual({ marks: {}, noticeIds: {} });
});
it('returns no acknowledgment when the transaction cannot commit the mark and ID', async () => {
	const store = createVolatileAuthorityStore();
	const authority = createWorkspaceAuthority({
		clock: { nowMs: () => 1000 },
		cap: 1024,
		store: {
			...store,
			transaction: (decide) =>
				store.transaction((storage) =>
					decide({
						read: storage.read,
						write: async () => {
							throw new Error('controlled-write-failure');
						},
					}),
				),
		},
	});
	await expect(authority.recordRemovalNotice(notice)).rejects.toThrow('controlled-write-failure');
	expect(await store.read('removal-notices-v1')).toBeUndefined();
});
