import { removalNoticeSchema } from '@agent-collaboration/tool-access/contracts';
import { expect, it } from 'vitest';

import { workspaceConfigurationSchema } from '#tool-host-core/hosted-configuration/models/hosted-configuration';
import { createRemovalNoticeReceiver } from '#tool-host-core/removal-notices/removal-notice-receiver';
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
const configuration = workspaceConfigurationSchema.parse({
	organizationId: notice.organizationId,
	workspaceName: 'fixture',
	approvalKeyBinding: 'KEY',
	mcp: { schemaVersion: 1, providers: {} },
	portal: { schemaVersion: 1, sessionDefaultProfile: 'operator', profiles: {} },
});
function fixture(): {
	readonly store: ReturnType<typeof createVolatileAuthorityStore>;
	readonly receiver: ReturnType<typeof createRemovalNoticeReceiver>;
} {
	const store = createVolatileAuthorityStore();
	const authority = createWorkspaceAuthority({ store, clock: { nowMs: () => 1000 }, cap: 1024 });
	return {
		store,
		receiver: createRemovalNoticeReceiver({
			verifier: { verify: async (token) => token === 'verified-service-token' },
			configurations: {
				workspaceIdsForOrganization: async () => [notice.workspaceId],
				read: async (workspaceId) => {
					if (workspaceId !== notice.workspaceId) throw new Error('not-hosted');
					return configuration;
				},
			},
			workspaces: { forWorkspace: () => authority },
		}),
	};
}
function request(body: unknown, bearer: string | null = 'verified-service-token'): Request {
	return new Request('https://attacker.invalid/internal/v1/removal-notices', {
		method: 'POST',
		headers: {
			...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }),
			'content-type': 'application/json',
		},
		body: JSON.stringify(body),
	});
}
it.each([
	{ label: 'missing authentication', bearer: null, body: notice, status: 401 },
	{ label: 'unverified service caller', bearer: 'forged', body: notice, status: 401 },
	{ label: 'malformed body', body: { ...notice, removalRevision: 2 ** 53 }, status: 400 },
	{
		label: 'foreign organization',
		body: { ...notice, organizationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
		status: 403,
	},
	{
		label: 'unhosted workspace',
		body: { ...notice, workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
		status: 403,
	},
])('refuses $label without writing any removal state', async ({ bearer, body, status }) => {
	const { store, receiver } = fixture();
	const response = await receiver.handle(request(body, bearer));
	expect(response.status).toBe(status);
	expect(await store.read('removal-notices-v1')).toBeUndefined();
});
it('acknowledges a valid notice after committing and makes an identical ID repeat inert', async () => {
	const { store, receiver } = fixture();
	expect(await (await receiver.handle(request(notice))).json()).toEqual({
		result: 'recorded',
		noticeId: notice.noticeId,
	});
	const committed = await store.read('removal-notices-v1');
	expect(committed).toMatchObject({
		marks: { '["bot","22222222-2222-4222-8222-222222222222"]': { revision: 8 } },
	});
	expect(await (await receiver.handle(request({ ...notice, removalRevision: 99 }))).json()).toEqual(
		{ result: 'alreadyRecorded', noticeId: notice.noticeId },
	);
	expect(await store.read('removal-notices-v1')).toEqual(committed);
});
