import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { removalNoticeSchema } from '@agent-collaboration/tool-access/contracts';
import { createWorkspaceAuthority } from '@agent-collaboration/tool-host-core';
import { expect, it } from 'vitest';

import { openNodeWorkspaceAuthorityStore } from '#node-host/workspace-authority/node-workspace-authority-store';

const notice = removalNoticeSchema.parse({
	noticeId: '019a1335-20c0-7000-8000-000000000001',
	organizationId: '11111111-1111-4111-8111-111111111111',
	workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
	subject: { kind: 'bot', botId: '22222222-2222-4222-8222-222222222222' },
	removalRevision: 8,
	reason: 'personaChanged',
});

it('does not lose the removal mark, notice identity or approval use when the file is reopened', async () => {
	// Arrange
	const databasePath = join(
		await mkdtemp(join(tmpdir(), 'identity-authority-')),
		'workspace.sqlite',
	);
	const store = await openNodeWorkspaceAuthorityStore({ databasePath });
	const clock = { nowMs: () => 1000 };
	const authority = createWorkspaceAuthority({ store, clock, cap: 1024 });
	// Act
	await authority.recordRemovalNotice(notice);
	await authority.consumeApprovalToken('principal:approval', 20_000);
	await store.close();
	const reopened = await openNodeWorkspaceAuthorityStore({ databasePath });
	try {
		const next = createWorkspaceAuthority({ store: reopened, clock, cap: 1024 });
		// Assert
		expect(await next.readRemovalMark(notice.subject)).toBe(8);
		expect(await next.recordRemovalNotice(notice)).toEqual({
			result: 'alreadyRecorded',
			noticeId: notice.noticeId,
		});
		expect(await next.consumeApprovalToken('principal:approval', 20_000)).toEqual({
			ok: false,
			reason: 'replayed',
		});
	} finally {
		await reopened.close();
	}
});

it('does not accept two simultaneous first approval uses through separate file connections', async () => {
	// Arrange
	const databasePath = join(
		await mkdtemp(join(tmpdir(), 'identity-authority-')),
		'workspace.sqlite',
	);
	const first = await openNodeWorkspaceAuthorityStore({ databasePath });
	const second = await openNodeWorkspaceAuthorityStore({ databasePath });
	try {
		const authorities = [first, second].map((store) =>
			createWorkspaceAuthority({ store, clock: { nowMs: () => 1000 }, cap: 1024 }),
		);
		// Act
		const results = await Promise.all(
			authorities.map((authority) => authority.consumeApprovalToken('principal:approval', 20_000)),
		);
		// Assert
		expect(results.filter((result) => result.ok)).toHaveLength(1);
		expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, reason: 'replayed' }]);
		expect(await second.read('approval-uses-v1')).toEqual({ 'principal:approval': 20_000 });
	} finally {
		await Promise.all([first.close(), second.close()]);
	}
});

it('does not publish partial writes or strand later decisions after a transaction fails', async () => {
	// Arrange
	const databasePath = join(
		await mkdtemp(join(tmpdir(), 'identity-authority-')),
		'workspace.sqlite',
	);
	const store = await openNodeWorkspaceAuthorityStore({ databasePath });
	try {
		await store.write('retained', { value: 1 });
		// Act
		await expect(
			store.transaction(async (storage) => {
				await storage.write('retained', { value: 2 });
				await storage.write('partial', true);
				throw new Error('controlled failure');
			}),
		).rejects.toThrow('controlled failure');
		// Assert
		expect(await store.read('retained')).toEqual({ value: 1 });
		expect(await store.read('partial')).toBeUndefined();
		await store.write('next', true);
		expect(await store.read('next')).toBe(true);
	} finally {
		await store.close();
	}
});
