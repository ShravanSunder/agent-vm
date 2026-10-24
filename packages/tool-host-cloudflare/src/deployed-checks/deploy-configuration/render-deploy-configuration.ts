import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { z } from 'zod';

import { analyticsText } from '#worker-host/analytics-engine-sink/analytics-engine-sink';
import {
	renderSelectionSchema,
	type PrivateDeployFile,
	type RenderSelection,
} from '#worker-host/deployed-checks/deploy-configuration/models/private-deploy-file';
import { portalTestConfigurations } from '#worker-host/deployed-checks/deploy-configuration/portal-test-configuration';
import {
	readPrivateDeployFile,
	requireOutsideGitWorkTree,
} from '#worker-host/deployed-checks/deploy-configuration/private-file-access';
import { expectedWorkspaceRecordsSchema } from '#worker-host/deployed-checks/deployed-check-suites/analytics-observations';

const templateDirectory = fileURLToPath(new URL('templates/', import.meta.url));
export function parseRenderSelection(argumentsValue: readonly string[]): RenderSelection {
	const options: Record<string, unknown> = {};
	for (const argument of argumentsValue) {
		if (argument.startsWith('--worker=')) options.worker = argument.slice('--worker='.length);
		else if (argument === '--workers-dev=true' || argument === '--workers-dev=false')
			options.workersDev = argument === '--workers-dev=true';
		else throw new Error('Use --worker=all|a|b|helper and --workers-dev=false|true.');
	}
	return renderSelectionSchema.parse(options);
}
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

function quoteAnalyticsSqlLiteral(value: string): string {
	return "'" + value.replaceAll("'", "''") + "'";
}

export function analyticsEvidenceQuery(configuration: PrivateDeployFile): string {
	const ids = configuration.workspaces
		.map((workspace) => quoteAnalyticsSqlLiteral(workspace.workspaceId))
		.join(', ');
	const names = configuration.workspaces
		.map((workspace) =>
			quoteAnalyticsSqlLiteral(analyticsText(`${configuration.runId}:${workspace.label}`)),
		)
		.join(', ');
	return `SELECT index1, blob1, blob2, blob3, blob4, blob5, blob6, blob7, blob8, blob9, double1, double2, double3, _sample_interval FROM ${configuration.analyticsDataset} WHERE index1 IN (${ids}) AND blob2 IN (${names}) LIMIT 1000 FORMAT JSON
`;
}

async function writeAnalyticsInputs(configuration: PrivateDeployFile): Promise<void> {
	const directory = await requireOutsideGitWorkTree(path.dirname(configuration.analyticsSqlFile));
	await mkdir(directory, { recursive: true, mode: 0o700 });
	if (
		['expected-workspaces.json', 'row-16-analytics-query.sql'].includes(
			path.basename(configuration.analyticsSqlFile),
		)
	)
		throw new Error('Analytics response path conflicts with generated evidence inputs.');
	const expected = expectedWorkspaceRecordsSchema.parse(
		configuration.workspaces.map(({ organizationId, workspaceId, label }) => ({
			organizationId,
			workspaceId,
			label,
		})),
	);
	const outputs = [
		['expected-workspaces.json', JSON.stringify(expected, null, 2)],
		['row-16-analytics-query.sql', analyticsEvidenceQuery(configuration)],
	] as const;
	await Promise.all(
		outputs.map(async ([name, contents]): Promise<void> => {
			const file = await requireOutsideGitWorkTree(path.join(directory, name));
			await writeFile(file, contents, { mode: 0o600 });
			await chmod(file, 0o600);
		}),
	);
}

export async function renderDeployConfiguration(
	configuration: PrivateDeployFile,
	outputDirectory: string,
	selection: RenderSelection = renderSelectionSchema.parse({}),
): Promise<void> {
	const destination = await requireOutsideGitWorkTree(outputDirectory);
	await mkdir(destination, { recursive: true, mode: 0o700 });
	await chmod(destination, 0o700);
	await writeAnalyticsInputs(configuration);
	const { ['d']: _privateScalar, ...publicKey } = configuration.privateSigningJwk;
	const common = {
		__WORKERS_DEV__: selection.workersDev,
		__ACCOUNT_ID__: configuration.accountId,
		__PORTAL_A_NAME__: configuration.portalA.name,
		__PORTAL_ENTRY__: fileURLToPath(new URL('../../index.ts', import.meta.url)),
		__HELPER_ENTRY__: fileURLToPath(
			new URL('../test-helper-worker/test-helper-worker.ts', import.meta.url),
		),
		__ANALYTICS_DATASET__: configuration.analyticsDataset,
		__PORTAL_VARIABLES__: {
			SIGN_IN_ISSUER: configuration.helper.origin,
			FLEET_CENTRAL_CLIENT_ID: 'controlled-central',
			SIGN_IN_JWKS_URL: `${configuration.helper.origin}/jwks`,
			TOOL_PORTAL_ORIGIN: configuration.portalA.origin,
			WORKSPACE_CONFIGURATIONS: JSON.stringify(portalTestConfigurations(configuration)),
		},
		__HELPER_VARIABLES__: {
			TEST_PUBLIC_JWKS: JSON.stringify({
				keys: [{ ...publicKey, kid: configuration.signingKeyId, alg: 'ES256', use: 'sig' }],
			}),
		},
	};
	const portalSecrets = Object.fromEntries(
		configuration.workspaces.flatMap((workspace, index) => [
			[`TEST_CREDENTIAL_${String(index)}`, workspace.credential],
			[`TEST_APPROVAL_${String(index)}`, workspace.approvalKeyHex],
		]),
	);
	const helperSecrets = {
		ADMISSION_SECRET: configuration.admissionSecret,
		TEST_WORKSPACES: JSON.stringify(
			Object.fromEntries(
				configuration.workspaces.map((workspace) => [
					workspace.label,
					{
						workspaceId: workspace.workspaceId,
						organizationId: workspace.organizationId,
						credential: workspace.credential,
					},
				]),
			),
		),
	};
	await Promise.all(
		[
			{ worker: 'a', file: 'portal-a', name: configuration.portalA.name, secrets: portalSecrets },
			{ worker: 'b', file: 'portal-b', name: configuration.portalB.name, secrets: portalSecrets },
			{
				worker: 'helper',
				file: 'test-helper',
				name: configuration.helper.name,
				secrets: helperSecrets,
			},
		]
			.filter((entry) => selection.worker === 'all' || selection.worker === entry.worker)
			.map(async (entry): Promise<void> => {
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
				await Promise.all(
					['json', 'secrets.json'].map(
						async (suffix): Promise<void> =>
							chmod(path.join(destination, `${entry.file}.${suffix}`), 0o600),
					),
				);
			}),
	);
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	await renderDeployConfiguration(
		await readPrivateDeployFile(),
		z.string().min(1).parse(process.argv[2]),
		parseRenderSelection(process.argv.slice(3)),
	);
}
