import {
	markSchema,
	type RemovalNotice,
	type RemovalNoticeAck,
	type RemovalSubject,
} from '@agent-collaboration/tool-access/contracts';
import { z } from 'zod';

import type { Clock } from '#tool-host-core/workspace-authority/models/authority-clock';
import type { WorkspaceAuthorityStore } from '#tool-host-core/workspace-authority/models/workspace-authority-store';

export const removalNoticeRetentionMs = 61 * 60 * 1000;
export const removalNoticesKey = 'removal-notices-v1';
const removalStateSchema = z.strictObject({
	marks: z.record(
		z.string(),
		z.strictObject({ revision: markSchema, retainUntilMs: z.number().finite() }),
	),
	noticeIds: z.record(z.string(), z.number().finite()),
});
type RemovalState = z.infer<typeof removalStateSchema>;

export interface WorkspaceRemovalRead {
	readonly readRemovalMark: (subject: RemovalSubject) => Promise<number | null>;
}
export interface WorkspaceRemovalAuthority extends WorkspaceRemovalRead {
	readonly recordRemovalNotice: (notice: RemovalNotice) => Promise<RemovalNoticeAck>;
	readonly pruneRemovalNotices: () => Promise<void>;
}

function removalSubjectKey(subject: RemovalSubject): string {
	switch (subject.kind) {
		case 'bot':
			return JSON.stringify(['bot', subject.botId]);
		case 'fleetHarnessSession':
			return JSON.stringify([
				'fleetHarnessSession',
				subject.sessionRef.installation,
				subject.sessionRef.harnessEndpoint,
				subject.sessionRef.conversationId,
			]);
		case 'machine':
			return JSON.stringify(['machine', subject.installation]);
	}
}
function retainedRemovalState(stored: unknown, nowMs: number): RemovalState {
	const state =
		stored === undefined ? { marks: {}, noticeIds: {} } : removalStateSchema.parse(stored);
	return {
		marks: Object.fromEntries(
			Object.entries(state.marks).filter(([, mark]) => mark.retainUntilMs > nowMs),
		),
		noticeIds: Object.fromEntries(
			Object.entries(state.noticeIds).filter(([, retainUntilMs]) => retainUntilMs > nowMs),
		),
	};
}

/** One workspace owns these marks. Acknowledgment waits for the store transaction to commit. */
export function createWorkspaceRemovalAuthority(props: {
	readonly store: WorkspaceAuthorityStore;
	readonly clock: Pick<Clock, 'nowMs'>;
}): WorkspaceRemovalAuthority {
	return {
		readRemovalMark: (subject) =>
			props.store.transaction(async (storage) => {
				const state = retainedRemovalState(
					await storage.read(removalNoticesKey),
					props.clock.nowMs(),
				);
				await storage.write(removalNoticesKey, state);
				return state.marks[removalSubjectKey(subject)]?.revision ?? null;
			}),
		recordRemovalNotice: (notice) =>
			props.store.transaction(async (storage) => {
				const nowMs = props.clock.nowMs();
				const state = retainedRemovalState(await storage.read(removalNoticesKey), nowMs);
				if (state.noticeIds[notice.noticeId] !== undefined)
					return { result: 'alreadyRecorded', noticeId: notice.noticeId };
				const subjectKey = removalSubjectKey(notice.subject);
				const previous = state.marks[subjectKey];
				state.marks[subjectKey] = {
					revision: Math.max(previous?.revision ?? 0, notice.removalRevision),
					retainUntilMs: Math.max(previous?.retainUntilMs ?? 0, nowMs + removalNoticeRetentionMs),
				};
				state.noticeIds[notice.noticeId] = nowMs + removalNoticeRetentionMs;
				await storage.write(removalNoticesKey, state);
				return { result: 'recorded', noticeId: notice.noticeId };
			}),
		pruneRemovalNotices: () =>
			props.store.transaction(async (storage) => {
				const state = retainedRemovalState(
					await storage.read(removalNoticesKey),
					props.clock.nowMs(),
				);
				await storage.write(removalNoticesKey, state);
			}),
	};
}
