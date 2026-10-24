import { mkdir, readFile, writeFile } from 'node:fs/promises';

import { removalNoticeSchema } from '../packages/tool-access/src/contracts/removal-notice.ts';
import {
	collaborationTokenClaimsSchema,
	isolationSchema,
	workspaceTokenClaimsSchema,
} from '../packages/tool-access/src/contracts/workspace-token-claims.ts';

const organizationId = '11111111-1111-4111-8111-111111111111';
const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const botId = '22222222-2222-4222-8222-222222222222';
const issuerClaims = {
	iss: 'https://issuer.invalid',
	aud: `https://portal.invalid/workspaces/${workspaceId}/mcp`,
	sub: 'authenticated-client',
	client_id: 'authenticated-client',
	jti: 'identity-fixture',
	iat: 1_800_000_000,
	exp: 1_800_003_600,
	scope: 'tool-portal:agent',
};
const grantClaims = {
	organization_id: organizationId,
	grant_revision: Number.MAX_SAFE_INTEGER,
	grant_expires_at: 1_800_000_300,
};
const isolationRecords = [
	{ kind: 'host', instance_id: 'launch-host' },
	{ kind: 'processSandbox', mechanism: 'seatbelt', instance_id: 'launch-sandbox' },
	{
		kind: 'container',
		runtime: 'docker',
		container_id: 'container-one',
		instance_id: 'launch-container',
	},
	{ kind: 'vm', launcher: 'agent-vm', vm_id: 'vm-one', instance_id: 'launch-vm' },
];
const workspaces = [
	workspaceTokenClaimsSchema.parse({
		...issuerClaims,
		...grantClaims,
		workspace_id: workspaceId,
		principal: { kind: 'bot', bot_id: botId },
		persona: { kind: 'named', name: 'operator' },
	}),
	...isolationRecords.map((isolation, index) =>
		workspaceTokenClaimsSchema.parse({
			...issuerClaims,
			...grantClaims,
			workspace_id: workspaceId,
			principal: {
				kind: 'fleetHarnessSession',
				session_ref: {
					installation: '33333333-3333-4333-8333-333333333333',
					harness_endpoint: 'codex-local',
					conversation_id: `conversation-${String(index)}`,
				},
				machine_environment:
					index % 2 === 0
						? { kind: 'physical' }
						: { kind: 'cloudVm', provider: 'test-cloud', instance: 'cloud-one' },
				project_id: 'project-one',
				isolation: isolationSchema.parse(isolation),
			},
			persona: index % 2 === 0 ? { kind: 'sessionDefault' } : { kind: 'named', name: 'operator' },
		}),
	),
];
const collaboration = collaborationTokenClaimsSchema.parse({
	...issuerClaims,
	...grantClaims,
	aud: 'https://fleet.invalid/v1/collaboration',
	principal: { kind: 'bot', bot_id: botId },
});
const removal = removalNoticeSchema.parse({
	noticeId: '019a1335-20c0-7000-8000-000000000001',
	organizationId,
	workspaceId,
	subject: { kind: 'bot', botId },
	removalRevision: Number.MAX_SAFE_INTEGER,
	reason: 'membershipEnded',
});
const output = `${JSON.stringify({ workspaces, collaboration, removal }, null, '\t')}\n`;
const destination = new URL(
	'../packages/tool-access/fixtures/identity/identity-contracts.json',
	import.meta.url,
);
if (process.argv.includes('--check-clean')) {
	if ((await readFile(destination, 'utf8')) !== output) {
		throw new Error('Identity fixtures are stale; run pnpm generate:identity-fixtures.');
	}
} else {
	await mkdir(new URL('.', destination), { recursive: true });
	await writeFile(destination, output);
}
