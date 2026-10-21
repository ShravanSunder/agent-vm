import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { z } from 'zod';

import type { PrivateDeployFile } from '#worker-host/deployed-checks/deploy-configuration/models/private-deploy-file';
import { portalTestConfigurations } from '#worker-host/deployed-checks/deploy-configuration/portal-test-configuration';
import {
	readPrivateDeployFile,
	requireOutsideGitWorkTree,
} from '#worker-host/deployed-checks/deploy-configuration/private-file-access';

const templateDirectory = fileURLToPath(new URL('templates/', import.meta.url));
export function substituteTemplate(
	template: string,
	replacements: Readonly<Record<string, unknown>>,
): unknown {
	return JSON.parse(
		template.replace(/"(__[A-Z_]+__)"/gu, (_match: string, key: string): string => {
			if (!(key in replacements)) throw new Error('Missing deployment template replacement.');
			return JSON.stringify(replacements[key]);
		}),
	);
}
export async function renderDeployConfiguration(
	configuration: PrivateDeployFile,
	outputDirectory: string,
): Promise<void> {
	const destination = await requireOutsideGitWorkTree(outputDirectory);
	await mkdir(destination, { recursive: true, mode: 0o700 });
	await chmod(destination, 0o700);
	const { ['d']: _privateScalar, ...publicKey } = configuration.privateSigningJwk;
	const common = {
		__ACCOUNT_ID__: configuration.accountId,
		__PORTAL_A_NAME__: configuration.portalA.name,
		__PORTAL_ENTRY__: fileURLToPath(new URL('../../index.ts', import.meta.url)),
		__HELPER_ENTRY__: fileURLToPath(
			new URL('../test-helper-worker/test-helper-worker.ts', import.meta.url),
		),
		__ANALYTICS_DATASET__: configuration.analyticsDataset,
		__PORTAL_VARIABLES__: {
			SIGN_IN_ISSUER: configuration.helper.origin,
			SIGN_IN_JWKS_URL: `${configuration.helper.origin}/jwks`,
			TOOL_PORTAL_AUDIENCE: configuration.audience,
			ORGANIZATION_CONFIGURATIONS: JSON.stringify(portalTestConfigurations(configuration)),
		},
		__HELPER_VARIABLES__: {
			TEST_PUBLIC_JWKS: JSON.stringify({
				keys: [{ ...publicKey, kid: configuration.signingKeyId, alg: 'ES256', use: 'sig' }],
			}),
		},
	};
	const portalSecrets = Object.fromEntries(
		configuration.organizations.flatMap((organization, index) => [
			[`TEST_CREDENTIAL_${String(index)}`, organization.credential],
			[`TEST_APPROVAL_${String(index)}`, organization.approvalKeyHex],
		]),
	);
	const helperSecrets = {
		ADMISSION_SECRET: configuration.admissionSecret,
		TEST_ORGANIZATIONS: JSON.stringify(
			Object.fromEntries(
				configuration.organizations.map((organization) => [
					organization.label,
					{ organizationId: organization.organizationId, credential: organization.credential },
				]),
			),
		),
	};
	await Promise.all(
		[
			{ file: 'portal-a', name: configuration.portalA.name, secrets: portalSecrets },
			{ file: 'portal-b', name: configuration.portalB.name, secrets: portalSecrets },
			{ file: 'test-helper', name: configuration.helper.name, secrets: helperSecrets },
		].map(async (entry): Promise<void> => {
			const template = await readFile(
				path.join(templateDirectory, `${entry.file}.template.json`),
				'utf8',
			);
			await Promise.all(
				['json', 'secrets.json'].map(
					async (suffix): Promise<string> =>
						requireOutsideGitWorkTree(path.join(destination, `${entry.file}.${suffix}`)),
				),
			);
			await writeFile(
				path.join(destination, `${entry.file}.json`),
				JSON.stringify(
					substituteTemplate(template, { ...common, __WORKER_NAME__: entry.name }),
					null,
					2,
				),
				{ mode: 0o600 },
			);
			await writeFile(
				path.join(destination, `${entry.file}.secrets.json`),
				JSON.stringify(entry.secrets),
				{ mode: 0o600 },
			);
		}),
	);
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	await renderDeployConfiguration(
		await readPrivateDeployFile(),
		z.string().min(1).parse(process.argv[2]),
	);
}
