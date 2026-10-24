import {
	privateDeployFileSchema,
	type PrivateDeployFile,
} from '#worker-host/deployed-checks/deploy-configuration/models/private-deploy-file';

/** Synthetic placeholders, never a deployable account or signing key. */
export function privateDeployFixture(evidenceDirectory: string): PrivateDeployFile {
	return privateDeployFileSchema.parse({
		runId: 'synthetic-unit-run',
		accountId: 'a'.repeat(32),
		portalA: { name: 'unit-portal-a', origin: 'https://portal-a.invalid' },
		portalB: { name: 'unit-portal-b', origin: 'https://portal-b.invalid' },
		helper: { name: 'unit-helper', origin: 'https://helper.invalid' },
		analyticsDataset: 'unit_dataset',
		agentId: 'same-agent',
		otherAgentId: 'other-agent',
		signingKeyId: 'unit-key',
		privateSigningJwk: {
			kty: 'EC',
			crv: 'P-256',
			['x']: 'public-x',
			['y']: 'public-y',
			['d']: 'private-unit-scalar',
		},
		admissionSecret: 'unit-admission-secret',
		access: { clientId: 'unit-access-id', clientSecret: 'unit-access-secret' },
		organizations: [
			{ label: 'organization-one', organizationId: '11111111-1111-4111-8111-111111111111' },
			{ label: 'organization-two', organizationId: '22222222-2222-4222-8222-222222222222' },
		],
		workspaces: [
			{
				label: 'alpha',
				organizationId: '11111111-1111-4111-8111-111111111111',
				workspaceId: '33333333-3333-4333-8333-333333333333',
				credential: 'unit-alpha-credential',
				approvalKeyHex: '12'.repeat(32),
			},
			{
				label: 'beta',
				organizationId: '11111111-1111-4111-8111-111111111111',
				workspaceId: '44444444-4444-4444-8444-444444444444',
				credential: 'unit-beta-credential',
				approvalKeyHex: '34'.repeat(32),
			},
			{
				label: 'gamma',
				organizationId: '22222222-2222-4222-8222-222222222222',
				workspaceId: '55555555-5555-4555-8555-555555555555',
				credential: 'unit-gamma-credential',
				approvalKeyHex: '56'.repeat(32),
			},
		],
		evidenceDirectory,
		logFile: `${evidenceDirectory}/logs.jsonl`,
		analyticsSqlFile: `${evidenceDirectory}/analytics.json`,
	});
}
