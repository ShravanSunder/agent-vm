import { it } from 'vitest';
import { z } from 'zod';

import { readPrivateDeployFile } from '#worker-host/deployed-checks/deploy-configuration/private-file-access';
import {
	assertOwnCredential,
	assertWorkspaceCatalogTools,
	assertRefusedCall,
} from '#worker-host/deployed-checks/deployed-check-suites/authorization-observations';
import {
	admitTestAgents,
	agentToken,
	approvedCall,
	observations,
	portalCall,
	portalRpc,
	requireRpcResult,
	setAdmission,
	type PortalRequestOptions,
} from '#worker-host/deployed-checks/deployed-check-suites/deployed-portal-client';

it('row 14 PRECURSOR: controlled issuer and helper admission stand in for deployed sign-in and management; workspace and sender own tools and credentials', async () => {
	const configuration = await readPrivateDeployFile();
	await admitTestAgents(configuration);
	const [alpha, beta, gamma] = configuration.workspaces;
	await Promise.all(
		configuration.workspaces.map(async (workspace): Promise<void> => {
			const callId = `control-${workspace.label}-${crypto.randomUUID()}`;
			const result = await requireRpcResult(
				await portalRpc(configuration, 'tools/call', portalCall(configuration, callId), {
					workspace,
				}),
			);
			if (result.isError === true) throw new Error('Allowed control failed.');
			assertOwnCredential(
				await observations(configuration),
				callId,
				workspace.credential,
				workspace.label,
			);
			const listed = await requireRpcResult(
				await portalRpc(configuration, 'tools/list', {}, { workspace, query: 'tools=direct' }),
			);
			const names = z
				.object({ tools: z.array(z.object({ name: z.string() })) })
				.parse(listed)
				.tools.map((tool) => tool.name);
			assertWorkspaceCatalogTools({
				names,
				ownLabel: workspace.label,
				otherLabel: workspace === alpha ? beta.label : alpha.label,
			});
		}),
	);
	const refuse = async (options: PortalRequestOptions, toolName = 'read'): Promise<void> => {
		const callId = `refused-${crypto.randomUUID()}`;
		const response = await portalRpc(
			configuration,
			'tools/call',
			portalCall(configuration, callId, toolName),
			options,
		);
		assertRefusedCall(await observations(configuration), callId, response);
	};
	const alphaToken = await agentToken(configuration, { workspace: alpha });
	await Promise.all([
		refuse({ workspace: beta, token: alphaToken }),
		refuse({ workspace: gamma, token: alphaToken }),
		refuse({ changes: { aud: configuration.portalA.origin, workspace_id: undefined } }),
		refuse({ noToken: true }),
		refuse({ forged: true }),
		refuse({ changes: { exp: 1 } }),
		refuse({ changes: { aud: 'wrong-test-audience' } }),
		refuse({}, `only-${beta.label}`),
		refuse({ agentId: configuration.otherAgentId }),
	]);
	const crossKeyId = `foreign-key-${crypto.randomUUID()}`;
	const foreign = await portalRpc(
		configuration,
		'tools/call',
		await approvedCall(configuration, { callId: crossKeyId, workspace: alpha }),
		{ workspace: beta },
	);
	assertRefusedCall(await observations(configuration), crossKeyId, foreign);
	const own = await requireRpcResult(
		await portalRpc(
			configuration,
			'tools/call',
			await approvedCall(configuration, { callId: crossKeyId, workspace: beta }),
			{ workspace: beta },
		),
	);
	if (own.isError === true) throw new Error('Own approval-key control failed.');
	assertOwnCredential(await observations(configuration), crossKeyId, beta.credential, beta.label);
	const spoofId = `false-label-${crypto.randomUUID()}`;
	const spoof = await requireRpcResult(
		await portalRpc(configuration, 'tools/call', portalCall(configuration, spoofId), {
			query: `tools=direct&organization_id=${beta.organizationId}&agent=${configuration.otherAgentId}&sessionId=spoof`,
			headers: {
				'x-organization-id': beta.organizationId,
				'x-agent-id': configuration.otherAgentId,
				'Mcp-Session-Id': 'spoof',
			},
		}),
	);
	if (spoof.isError === true) throw new Error('False labels changed allowed sender behavior.');
	assertOwnCredential(await observations(configuration), spoofId, alpha.credential, alpha.label);
	await setAdmission(configuration, { workspace: alpha, state: 'removed' });
	try {
		await refuse({ token: alphaToken });
		const siblingCallId = `sibling-after-removal-${crypto.randomUUID()}`;
		const sibling = await requireRpcResult(
			await portalRpc(configuration, 'tools/call', portalCall(configuration, siblingCallId), {
				workspace: beta,
			}),
		);
		if (sibling.isError === true) throw new Error('Removing W1 stopped sibling W2.');
		assertOwnCredential(
			await observations(configuration),
			siblingCallId,
			beta.credential,
			beta.label,
		);
	} finally {
		await setAdmission(configuration, { workspace: alpha, state: 'member', persona: 'one' });
	}
});
