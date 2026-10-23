import { it } from 'vitest';
import { z } from 'zod';

import { readPrivateDeployFile } from '#worker-host/deployed-checks/deploy-configuration/private-file-access';
import {
	assertOwnCredential,
	assertOrganizationCatalogTools,
	assertRefusedCall,
} from '#worker-host/deployed-checks/deployed-check-suites/authorization-observations';
import {
	admitTestAgents,
	approvedCall,
	observations,
	portalCall,
	portalRpc,
	requireRpcResult,
	setAdmission,
	type PortalRequestOptions,
} from '#worker-host/deployed-checks/deployed-check-suites/deployed-portal-client';

it('row 14: token organization and sender own the tools and credential, including refused controls', async () => {
	const configuration = await readPrivateDeployFile();
	await admitTestAgents(configuration);
	const [alpha, beta] = configuration.organizations;
	await Promise.all(
		configuration.organizations.map(async (organization): Promise<void> => {
			const callId = `control-${organization.label}-${crypto.randomUUID()}`;
			const result = await requireRpcResult(
				await portalRpc(configuration, 'tools/call', portalCall(configuration, callId), {
					organization,
				}),
			);
			if (result.isError === true) throw new Error('Allowed control failed.');
			assertOwnCredential(
				await observations(configuration),
				callId,
				organization.credential,
				organization.label,
			);
			const listed = await requireRpcResult(
				await portalRpc(configuration, 'tools/list', {}, { organization, query: 'tools=direct' }),
			);
			const names = z
				.object({ tools: z.array(z.object({ name: z.string() })) })
				.parse(listed)
				.tools.map((tool) => tool.name);
			assertOrganizationCatalogTools({
				names,
				ownLabel: organization.label,
				otherLabel: organization === alpha ? beta.label : alpha.label,
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
	await Promise.all([
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
		await approvedCall(configuration, crossKeyId, alpha),
		{ organization: beta },
	);
	assertRefusedCall(await observations(configuration), crossKeyId, foreign);
	const own = await requireRpcResult(
		await portalRpc(
			configuration,
			'tools/call',
			await approvedCall(configuration, crossKeyId, beta),
			{ organization: beta },
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
	await setAdmission(configuration, alpha, 'removed');
	try {
		await refuse({});
	} finally {
		await setAdmission(configuration, alpha, 'listed');
	}
});
