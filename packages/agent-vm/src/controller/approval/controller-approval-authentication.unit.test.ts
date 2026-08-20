import path from 'node:path';

import { GATEWAY_RUNTIME_APPROVAL_AUDIENCE } from '@agent-vm/gateway-control-contracts';
import type { SecretRef, SecretResolver } from '@agent-vm/secret-management';
import { describe, expect, it, test, vi } from 'vitest';

import {
	createLoadedSystemConfig,
	type LoadedSystemConfig,
	type SystemConfigInput,
} from '../../config/system-config.js';
import { createControllerApprovalBearerAuthenticator } from './controller-approval-authentication.js';

const TEST_ROOT = path.join('/tmp', 'agent-vm-approval-authentication-test');
const ENVIRONMENT_CREDENTIAL = 'environment-approval-secret';
const CONFIG_CREDENTIAL = 'config-approval-secret';
const ONE_PASSWORD_CREDENTIAL = 'one-password-approval-secret';
const ADMIN_CREDENTIAL = 'zone-admin-secret';
const CONFIG_ADMIN_CREDENTIAL = 'config-zone-admin-secret';
const ONE_PASSWORD_ADMIN_CREDENTIAL = 'one-password-zone-admin-secret';
const UNKNOWN_CREDENTIAL = 'unknown-secret';
const EXPECTED_ENVIRONMENT_CREDENTIAL_ID =
	'sha256:25f6e1452631c74f7c0cbc1290376af68c696058f7a4cf879e07ef3783c37c10';

type ApprovalSecretReference =
	| { readonly source: '1password'; readonly ref: string }
	| { readonly source: 'environment'; readonly envVar: string }
	| { readonly source: 'config'; readonly value: string };

interface ApprovalApproverDefinition {
	readonly approverId: string;
	readonly secret: ApprovalSecretReference;
}

interface ApprovalZoneDefinition {
	readonly adminSecret?: ApprovalSecretReference;
	readonly approvers: readonly ApprovalApproverDefinition[];
	readonly zoneId: string;
}

interface TestSecretResolver extends SecretResolver {
	readonly resolveMock: ReturnType<typeof vi.fn>;
}

const NON_APPROVAL_ADMIN_CREDENTIAL_CASES = [
	[
		'environment-backed',
		{ envVar: 'ZONE_ADMIN_SECRET', source: 'environment' },
		ADMIN_CREDENTIAL,
		{ ZONE_ADMIN_SECRET: ADMIN_CREDENTIAL },
	],
	[
		'config-backed',
		{ source: 'config', value: CONFIG_ADMIN_CREDENTIAL },
		CONFIG_ADMIN_CREDENTIAL,
		{},
	],
	[
		'1Password-backed',
		{ ref: 'op://agent-vm-testing/admin/credential', source: '1password' },
		ONE_PASSWORD_ADMIN_CREDENTIAL,
		{ 'op://agent-vm-testing/admin/credential': ONE_PASSWORD_ADMIN_CREDENTIAL },
	],
] as const satisfies readonly (readonly [
	string,
	ApprovalSecretReference,
	string,
	Readonly<Record<string, string>>,
])[];

function createSystemConfig(
	zoneDefinitions: readonly ApprovalZoneDefinition[],
): LoadedSystemConfig {
	const config = {
		schemaVersion: 2,
		storageRootDir: TEST_ROOT,
		host: {
			controllerPort: 18_800,
			projectNamespace: 'approval-authentication-test',
			secretsProvider: {
				tokenSource: { envVar: 'OP_SERVICE_ACCOUNT_TOKEN', type: 'env' },
				type: '1password',
			},
		},
		imageProfiles: {
			gateways: {
				worker: {
					buildConfig: path.join(TEST_ROOT, 'worker-build-config.json'),
					type: 'worker',
				},
			},
			toolVms: {},
		},
		tcpPool: { basePort: 19_000, size: 10 },
		toolVmProfiles: {},
		zones: zoneDefinitions.map((definition, zoneIndex) => ({
			...(definition.adminSecret === undefined
				? {}
				: { adminAccess: { mode: 'secret', secret: definition.adminSecret } }),
			approvalAccess: {
				approvers: definition.approvers.map((approver) => ({
					...approver,
					kind: 'bearer' as const,
				})),
				audience: GATEWAY_RUNTIME_APPROVAL_AUDIENCE,
			},
			egressHosts: [{ audience: 'gateway', host: 'example.com' }],
			gateway: {
				config: path.join(TEST_ROOT, definition.zoneId, 'worker.json'),
				cpus: 1,
				imageProfile: 'worker',
				memory: '1G',
				port: 20_000 + zoneIndex,
				type: 'worker',
			},
			id: definition.zoneId,
			secrets: {},
		})),
	} satisfies SystemConfigInput;

	return createLoadedSystemConfig(config, {
		systemConfigPath: path.join(TEST_ROOT, 'config', 'system.json'),
	});
}

function createSecretResolver(values: Readonly<Record<string, string>>): TestSecretResolver {
	const resolveMock = vi.fn(async (reference: SecretRef): Promise<string> => {
		if (reference.source === 'config') {
			return reference.value;
		}
		const value = values[reference.ref];
		if (value === undefined) {
			throw new Error(`Test resolver has no value for ${reference.source} reference.`);
		}
		return value;
	});
	return {
		resolve: resolveMock,
		resolveAll: vi.fn(async (): Promise<Record<string, string>> => ({})),
		resolveMock,
	} satisfies TestSecretResolver;
}

function createSupportedReferenceSystemConfig(): LoadedSystemConfig {
	return createSystemConfig([
		{
			approvers: [
				{
					approverId: 'environment-operator',
					secret: {
						envVar: 'AGENT_VM_APPROVAL_ENV',
						source: 'environment',
					},
				},
				{
					approverId: 'config-operator',
					secret: { source: 'config', value: CONFIG_CREDENTIAL },
				},
				{
					approverId: 'one-password-operator',
					secret: {
						ref: 'op://agent-vm-testing/approval/credential',
						source: '1password',
					},
				},
			],
			zoneId: 'zone-a',
		},
	]);
}

describe('controller approval bearer authentication', () => {
	it('resolves every supported host secret reference and returns only server-derived operator identity', async () => {
		// Arrange
		const secretResolver = createSecretResolver({
			AGENT_VM_APPROVAL_ENV: ENVIRONMENT_CREDENTIAL,
			'op://agent-vm-testing/approval/credential': ONE_PASSWORD_CREDENTIAL,
		});
		const authenticateBearer = await createControllerApprovalBearerAuthenticator({
			secretResolver,
			systemConfig: createSupportedReferenceSystemConfig(),
		});

		// Act
		const environmentResult = await authenticateBearer({
			authorizationHeader: `Bearer ${ENVIRONMENT_CREDENTIAL}`,
			zoneId: 'zone-a',
		});
		const configResult = await authenticateBearer({
			authorizationHeader: `Bearer ${CONFIG_CREDENTIAL}`,
			zoneId: 'zone-a',
		});
		const onePasswordResult = await authenticateBearer({
			authorizationHeader: `Bearer ${ONE_PASSWORD_CREDENTIAL}`,
			zoneId: 'zone-a',
		});

		// Assert
		expect(secretResolver.resolveMock.mock.calls).toEqual([
			[{ ref: 'AGENT_VM_APPROVAL_ENV', source: 'environment' }],
			[{ source: 'config', value: CONFIG_CREDENTIAL }],
			[{ ref: 'op://agent-vm-testing/approval/credential', source: '1password' }],
		]);
		expect(environmentResult).toEqual({
			kind: 'authenticated',
			operator: {
				approverId: 'environment-operator',
				audience: GATEWAY_RUNTIME_APPROVAL_AUDIENCE,
				credentialId: EXPECTED_ENVIRONMENT_CREDENTIAL_ID,
				provenance: 'approval-access',
			},
		});
		expect(configResult).toMatchObject({
			kind: 'authenticated',
			operator: {
				approverId: 'config-operator',
				audience: GATEWAY_RUNTIME_APPROVAL_AUDIENCE,
				credentialId: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
				provenance: 'approval-access',
			},
		});
		expect(onePasswordResult).toMatchObject({
			kind: 'authenticated',
			operator: {
				approverId: 'one-password-operator',
				audience: GATEWAY_RUNTIME_APPROVAL_AUDIENCE,
				credentialId: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
				provenance: 'approval-access',
			},
		});
		const serializedResults = JSON.stringify([environmentResult, configResult, onePasswordResult]);
		expect(serializedResults).not.toContain(ENVIRONMENT_CREDENTIAL);
		expect(serializedResults).not.toContain(CONFIG_CREDENTIAL);
		expect(serializedResults).not.toContain(ONE_PASSWORD_CREDENTIAL);
	});

	test.each([
		['missing bearer', undefined, { kind: 'unauthorized', reason: 'missing' }],
		[
			'wrong authentication scheme',
			'Basic credential',
			{ kind: 'unauthorized', reason: 'malformed' },
		],
		['empty bearer', 'Bearer ', { kind: 'unauthorized', reason: 'malformed' }],
		['unknown bearer', `Bearer ${UNKNOWN_CREDENTIAL}`, { kind: 'unauthorized', reason: 'unknown' }],
	] as const)('rejects a %s', async (_caseName, authorizationHeader, expectedResult) => {
		// Arrange
		const authenticateBearer = await createControllerApprovalBearerAuthenticator({
			secretResolver: createSecretResolver({
				AGENT_VM_APPROVAL_ENV: ENVIRONMENT_CREDENTIAL,
				'op://agent-vm-testing/approval/credential': ONE_PASSWORD_CREDENTIAL,
			}),
			systemConfig: createSupportedReferenceSystemConfig(),
		});

		// Act
		const result = await authenticateBearer({ authorizationHeader, zoneId: 'zone-a' });

		// Assert
		expect(result).toEqual(expectedResult);
		expect(JSON.stringify(result)).not.toContain(UNKNOWN_CREDENTIAL);
	});

	it('scopes approval credentials to their configured zone', async () => {
		// Arrange
		const authenticateBearer = await createControllerApprovalBearerAuthenticator({
			secretResolver: createSecretResolver({
				ZONE_A_APPROVAL: 'zone-a-approval-secret',
				ZONE_B_APPROVAL: 'zone-b-approval-secret',
			}),
			systemConfig: createSystemConfig([
				{
					approvers: [
						{
							approverId: 'zone-a-operator',
							secret: { envVar: 'ZONE_A_APPROVAL', source: 'environment' },
						},
					],
					zoneId: 'zone-a',
				},
				{
					approvers: [
						{
							approverId: 'zone-b-operator',
							secret: { envVar: 'ZONE_B_APPROVAL', source: 'environment' },
						},
					],
					zoneId: 'zone-b',
				},
			]),
		});

		// Act
		const crossZoneResult = await authenticateBearer({
			authorizationHeader: 'Bearer zone-a-approval-secret',
			zoneId: 'zone-b',
		});

		// Assert
		expect(crossZoneResult).toEqual({ kind: 'unauthorized', reason: 'unknown' });
	});

	it('rejects old resolved bytes after authenticator reconstruction while preserving operator identity', async () => {
		// Arrange
		const systemConfig = createSystemConfig([
			{
				approvers: [
					{
						approverId: 'environment-operator',
						secret: {
							envVar: 'AGENT_VM_APPROVAL_ENV',
							source: 'environment',
						},
					},
				],
				zoneId: 'zone-a',
			},
		]);
		const firstAuthenticateBearer = await createControllerApprovalBearerAuthenticator({
			secretResolver: createSecretResolver({ AGENT_VM_APPROVAL_ENV: 'first-secret-bytes' }),
			systemConfig,
		});
		const rotatedAuthenticateBearer = await createControllerApprovalBearerAuthenticator({
			secretResolver: createSecretResolver({ AGENT_VM_APPROVAL_ENV: 'rotated-secret-bytes' }),
			systemConfig,
		});

		// Act
		const firstResult = await firstAuthenticateBearer({
			authorizationHeader: 'Bearer first-secret-bytes',
			zoneId: 'zone-a',
		});
		const rotatedResult = await rotatedAuthenticateBearer({
			authorizationHeader: 'Bearer rotated-secret-bytes',
			zoneId: 'zone-a',
		});
		const staleResult = await rotatedAuthenticateBearer({
			authorizationHeader: 'Bearer first-secret-bytes',
			zoneId: 'zone-a',
		});

		// Assert
		if (firstResult.kind !== 'authenticated' || rotatedResult.kind !== 'authenticated') {
			throw new Error('Expected both configured approval credentials to authenticate.');
		}
		if (firstResult.operator.provenance !== 'approval-access') {
			throw new Error('Expected bearer authentication to return approval-access provenance.');
		}
		expect(firstResult.operator.credentialId).toBe(EXPECTED_ENVIRONMENT_CREDENTIAL_ID);
		expect(rotatedResult.operator).toEqual(firstResult.operator);
		expect(rotatedResult.operator).toEqual({
			approverId: 'environment-operator',
			audience: GATEWAY_RUNTIME_APPROVAL_AUDIENCE,
			credentialId: EXPECTED_ENVIRONMENT_CREDENTIAL_ID,
			provenance: 'approval-access',
		});
		expect(staleResult).toEqual({ kind: 'unauthorized', reason: 'unknown' });
		expect(JSON.stringify([firstResult, rotatedResult, staleResult])).not.toMatch(/secret-bytes/u);
	});

	test.each(NON_APPROVAL_ADMIN_CREDENTIAL_CASES)(
		'recognizes a configured %s zone admin credential but forbids it from approval authority',
		async (_caseName, adminSecret, adminCredential, resolverValues) => {
			// Arrange
			const authenticateBearer = await createControllerApprovalBearerAuthenticator({
				secretResolver: createSecretResolver({
					APPROVAL_SECRET: ENVIRONMENT_CREDENTIAL,
					...resolverValues,
				}),
				systemConfig: createSystemConfig([
					{
						adminSecret,
						approvers: [
							{
								approverId: 'approval-operator',
								secret: { envVar: 'APPROVAL_SECRET', source: 'environment' },
							},
						],
						zoneId: 'zone-a',
					},
				]),
			});

			// Act
			const result = await authenticateBearer({
				authorizationHeader: `Bearer ${adminCredential}`,
				zoneId: 'zone-a',
			});

			// Assert
			expect(result).toEqual({
				kind: 'forbidden',
				reason: 'recognized-non-approval-credential',
			});
			expect(JSON.stringify(result)).not.toContain(adminCredential);
		},
	);

	it('fails startup when different approvers resolve to the same credential without leaking it', async () => {
		// Arrange
		const duplicateCredential = 'duplicate-approval-secret-must-stay-private';
		const createAuthenticator = createControllerApprovalBearerAuthenticator({
			secretResolver: createSecretResolver({
				ZONE_A_APPROVAL: duplicateCredential,
				ZONE_B_APPROVAL: duplicateCredential,
			}),
			systemConfig: createSystemConfig([
				{
					approvers: [
						{
							approverId: 'zone-a-operator',
							secret: { envVar: 'ZONE_A_APPROVAL', source: 'environment' },
						},
					],
					zoneId: 'zone-a',
				},
				{
					approvers: [
						{
							approverId: 'zone-b-operator',
							secret: { envVar: 'ZONE_B_APPROVAL', source: 'environment' },
						},
					],
					zoneId: 'zone-b',
				},
			]),
		});

		// Act / Assert
		await expect(createAuthenticator).rejects.toThrow(
			'One approval credential cannot identify more than one approver.',
		);
		await createAuthenticator.catch((error: Error) => {
			expect(error.message).not.toContain(duplicateCredential);
			expect(JSON.stringify(error)).not.toContain(duplicateCredential);
		});
	});

	it('fails startup when an approval credential resolves to an empty value', async () => {
		// Arrange
		const createAuthenticator = createControllerApprovalBearerAuthenticator({
			secretResolver: createSecretResolver({ EMPTY_APPROVAL_SECRET: '' }),
			systemConfig: createSystemConfig([
				{
					approvers: [
						{
							approverId: 'empty-credential-operator',
							secret: { envVar: 'EMPTY_APPROVAL_SECRET', source: 'environment' },
						},
					],
					zoneId: 'zone-a',
				},
			]),
		});

		// Act / Assert
		await expect(createAuthenticator).rejects.toThrow(
			"Approval credential for zone 'zone-a' must not be empty.",
		);
	});
});
