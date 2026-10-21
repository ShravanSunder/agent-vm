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
		audience: 'unit-audience',
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
			{
				label: 'alpha',
				organizationId: '11111111-1111-4111-8111-111111111111',
				credential: 'unit-alpha-credential',
				approvalKeyHex: '12'.repeat(32),
			},
			{
				label: 'beta',
				organizationId: '22222222-2222-4222-8222-222222222222',
				credential: 'unit-beta-credential',
				approvalKeyHex: '34'.repeat(32),
			},
		],
		evidenceDirectory,
		logFile: `${evidenceDirectory}/logs.jsonl`,
		analyticsSqlFile: `${evidenceDirectory}/analytics.json`,
	});
}
