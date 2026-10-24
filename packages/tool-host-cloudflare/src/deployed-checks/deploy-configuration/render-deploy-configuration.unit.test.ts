import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { privateDeployFileSchema } from '#worker-host/deployed-checks/deploy-configuration/models/private-deploy-file';
import { portalTestConfigurations } from '#worker-host/deployed-checks/deploy-configuration/portal-test-configuration';
import {
	readPrivateDeployFile,
	requireOutsideGitWorkTree,
} from '#worker-host/deployed-checks/deploy-configuration/private-file-access';
import {
	renderDeployConfiguration,
	analyticsEvidenceQuery,
	parseRenderSelection,
	substituteTemplate,
} from '#worker-host/deployed-checks/deploy-configuration/render-deploy-configuration';
import { privateDeployFixture } from '#worker-host/deployed-checks/deploy-configuration/test-fixtures/private-deploy-fixture';

const ownedDirectories: string[] = [];
async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), '2026-10-deploy-config-'));
	ownedDirectories.push(directory);
	return directory;
}
afterEach(async () => {
	await Promise.all(
		ownedDirectories
			.splice(0)
			.map(async (directory): Promise<void> => rm(directory, { recursive: true, force: true })),
	);
});
describe('private deployment renderer', () => {
	it('requires explicit environment input and mode 0600, rejects invalid private JSON safely', async () => {
		await expect(readPrivateDeployFile('')).rejects.toThrow('TOOL_PORTAL_PRIVATE_DEPLOY_FILE');
		const directory = await temporaryDirectory();
		const file = path.join(directory, 'private.json');
		await writeFile(file, JSON.stringify(privateDeployFixture(directory)), { mode: 0o600 });
		expect((await readPrivateDeployFile(file)).runId).toBe('synthetic-unit-run');
		await chmod(file, 0o644);
		await expect(readPrivateDeployFile(file)).rejects.toThrow('0600');
		await chmod(file, 0o600);
		await writeFile(file, '{"private":"secret-canary"}');
		await expect(readPrivateDeployFile(file)).rejects.toThrow('configuration schema');
	});
	it('rejects current repo, nested git worktrees and symlink escapes', async () => {
		await expect(
			requireOutsideGitWorkTree(path.join(process.cwd(), 'tmp', 'private-output')),
		).rejects.toThrow('git work tree');
		const directory = await temporaryDirectory();
		await mkdir(path.join(directory, 'repo'));
		await writeFile(path.join(directory, 'repo', '.git'), 'gitdir: placeholder');
		await symlink(path.join(directory, 'repo'), path.join(directory, 'linked'));
		await expect(
			requireOutsideGitWorkTree(path.join(directory, 'linked', 'nested', 'output')),
		).rejects.toThrow('git work tree');
	});
	it('renders shared authorization bindings and separates all secrets from Worker public variables', async () => {
		const directory = await temporaryDirectory();
		await renderDeployConfiguration(privateDeployFixture(directory), directory, {
			worker: 'all',
			workersDev: true,
		});
		const read = async (file: string): Promise<string> =>
			readFile(path.join(directory, file), 'utf8');
		const portalA = await read('portal-a.json');
		const portalB = await read('portal-b.json');
		const helper = await read('test-helper.json');
		expect(portalA).toContain('global_fetch_strictly_public');
		expect(JSON.parse(portalB)).toMatchObject({
			durable_objects: { bindings: [{ script_name: 'unit-portal-a' }] },
			workers_dev: true,
			preview_urls: false,
			routes: [],
		});
		expect(JSON.parse(helper)).toMatchObject({
			durable_objects: {
				bindings: [{ script_name: 'unit-portal-a' }, { class_name: 'TestObservations' }],
			},
		});
		for (const text of [
			portalA,
			portalB,
			helper,
			await read('test-helper.secrets.json'),
			await read('portal-a.secrets.json'),
		])
			expect(text).not.toContain('private-unit-scalar');
		for (const text of [portalA, portalB, helper])
			expect(text).not.toContain('unit-alpha-credential');
		expect(await read('portal-a.secrets.json')).toContain('unit-alpha-credential');
		expect((await stat(path.join(directory, 'portal-a.secrets.json'))).mode & 0o777).toBe(0o600);
		expect(helper).not.toContain('__HELPER');
	});
	it('defaults to dark deployment and changes only the selected Worker', async () => {
		const directory = await temporaryDirectory();
		await renderDeployConfiguration(privateDeployFixture(directory), directory);
		expect(
			JSON.parse(await readFile(path.join(directory, 'portal-a.json'), 'utf8')).workers_dev,
		).toBe(false);
		await renderDeployConfiguration(
			privateDeployFixture(directory),
			directory,
			parseRenderSelection(['--worker=a', '--workers-dev=true']),
		);
		expect(
			JSON.parse(await readFile(path.join(directory, 'portal-a.json'), 'utf8')).workers_dev,
		).toBe(true);
		expect(
			JSON.parse(await readFile(path.join(directory, 'portal-b.json'), 'utf8')).workers_dev,
		).toBe(false);
		expect(() => parseRenderSelection(['--workers-dev=invalid'])).toThrow();
	});
	it('substitutes JSON values without string interpolation and refuses unfilled placeholders', () => {
		expect(
			substituteTemplate('{"value":"__VALUE__"}', { __VALUE__: { nested: '"quoted"' } }),
		).toEqual({ value: { nested: '"quoted"' } });
		expect(() => substituteTemplate('"__MISSING__"', {})).toThrow();
	});
});

it('uses canonical helper origins for accepted trailing-slash input in JWKS and MCP URLs', async () => {
	const directory = await temporaryDirectory();
	const fixture = privateDeployFixture(directory);
	const configuration = privateDeployFileSchema.parse({
		...fixture,
		helper: { ...fixture.helper, origin: 'https://helper.invalid/' },
	});
	await renderDeployConfiguration(configuration, directory, { worker: 'all', workersDev: false });
	const portal: unknown = JSON.parse(await readFile(path.join(directory, 'portal-a.json'), 'utf8'));
	expect(portal).toMatchObject({ vars: { SIGN_IN_JWKS_URL: 'https://helper.invalid/jwks' } });
	expect(portalTestConfigurations(configuration)).toMatchObject({
		'33333333-3333-4333-8333-333333333333': {
			mcp: { providers: { fixture: { transport: { url: 'https://helper.invalid/mcp/alpha' } } } },
		},
	});
});

it('renders three distinct workspace identities and retains the nonempty-state rename and shared namespace', async () => {
	const directory = await temporaryDirectory();
	const fixture = privateDeployFixture(directory);
	await renderDeployConfiguration(fixture, directory);
	expect(
		Object.keys(z.record(z.string(), z.unknown()).parse(portalTestConfigurations(fixture))),
	).toEqual([
		'33333333-3333-4333-8333-333333333333',
		'44444444-4444-4444-8444-444444444444',
		'55555555-5555-4555-8555-555555555555',
	]);
	const portalA = JSON.parse(await readFile(path.join(directory, 'portal-a.json'), 'utf8'));
	expect(portalA.migrations).toEqual([
		{ tag: 'v1', new_sqlite_classes: ['OrganizationAuthorization'] },
		{
			tag: 'v2',
			renamed_classes: [{ from: 'OrganizationAuthorization', to: 'WorkspaceAuthority' }],
		},
	]);
	expect(portalA.durable_objects.bindings).toEqual([
		{ name: 'WORKSPACES', class_name: 'WorkspaceAuthority' },
	]);
	await Promise.all(
		['portal-b.json', 'test-helper.json'].map(async (filename): Promise<void> => {
			const worker = z
				.object({ durable_objects: z.object({ bindings: z.array(z.unknown()) }) })
				.parse(JSON.parse(await readFile(path.join(directory, filename), 'utf8')));
			expect(worker.durable_objects.bindings).toContainEqual({
				name: 'WORKSPACES',
				class_name: 'WorkspaceAuthority',
				script_name: fixture.portalA.name,
			});
		}),
	);
	expect(JSON.stringify(portalA)).not.toContain('deleted_classes');
});

it('rejects duplicate, foreign and legacy private workspace configuration without a compatibility path', () => {
	const fixture = privateDeployFixture('/tmp/synthetic-private-model');
	expect(
		privateDeployFileSchema.safeParse({
			...fixture,
			workspaces: [fixture.workspaces[0], fixture.workspaces[0], fixture.workspaces[2]],
		}).success,
	).toBe(false);
	expect(
		privateDeployFileSchema.safeParse({
			...fixture,
			workspaces: [
				fixture.workspaces[0],
				{ ...fixture.workspaces[1], organizationId: fixture.organizations[1].organizationId },
				fixture.workspaces[2],
			],
		}).success,
	).toBe(false);
	expect(privateDeployFileSchema.safeParse({ ...fixture, workspaces: undefined }).success).toBe(
		false,
	);
	expect(
		privateDeployFileSchema.safeParse({
			...fixture,
			workspaces: [
				{ ...fixture.workspaces[0], extra: true },
				fixture.workspaces[1],
				fixture.workspaces[2],
			],
		}).success,
	).toBe(false);
});
it('writes current-run inventory and separate nine-blob SQL beside the configured JSON evidence, outside render output', async () => {
	const directory = await temporaryDirectory();
	const configuration = privateDeployFileSchema.parse({
		...privateDeployFixture(directory),
		analyticsSqlFile: path.join(directory, 'sql-input', 'response.json'),
	});
	const output = path.join(directory, 'render-output');
	await renderDeployConfiguration(configuration, output);
	const expected = JSON.parse(
		await readFile(path.join(directory, 'sql-input', 'expected-workspaces.json'), 'utf8'),
	);
	expect(expected).toEqual(
		configuration.workspaces.map(({ organizationId, workspaceId, label }) => ({
			organizationId,
			workspaceId,
			label,
		})),
	);
	const query = await readFile(
		path.join(directory, 'sql-input', 'row-16-analytics-query.sql'),
		'utf8',
	);
	expect(query).toBe(analyticsEvidenceQuery(configuration));
	expect(query.split(' FROM ')[0]).toBe(
		'SELECT index1, blob1, blob2, blob3, blob4, blob5, blob6, blob7, blob8, blob9, double1, double2, double3, _sample_interval',
	);
	for (const workspace of configuration.workspaces) {
		expect(query).toContain(workspace.workspaceId);
		expect(query).toContain(`${configuration.runId}:${workspace.label}`);
	}
	await Promise.all(
		['expected-workspaces.json', 'row-16-analytics-query.sql'].map(async (file): Promise<void> => {
			expect((await stat(path.join(directory, 'sql-input', file))).mode & 0o777).toBe(0o600);
		}),
	);
	await expect(readFile(configuration.analyticsSqlFile)).rejects.toThrow();
	await expect(readFile(path.join(output, 'expected-workspaces.json'))).rejects.toThrow();
});

it.each(['credential', 'approvalKeyHex'] as const)(
	'requires a distinct per-workspace %s independently of all other identities',
	(field) => {
		const fixture = privateDeployFixture('/tmp/synthetic-unique-workspaces');
		const duplicate = { ...fixture.workspaces[1], [field]: fixture.workspaces[0][field] };
		expect(privateDeployFileSchema.safeParse(fixture).success).toBe(true);
		expect(
			privateDeployFileSchema.safeParse({
				...fixture,
				workspaces: [fixture.workspaces[0], duplicate, fixture.workspaces[2]],
			}).success,
		).toBe(false);
	},
);

it('orders analytics evidence only by selected columns', () => {
	// Arrange: Analytics Engine requires ORDER BY columns in the projection.
	const configuration = privateDeployFixture('/tmp/synthetic-analytics-query');
	// Act: inspect the actual generated statement, including optional ordering.
	const query = analyticsEvidenceQuery(configuration);
	const selectedColumns =
		query
			.split(' FROM ')[0]
			?.replace(/^SELECT /u, '')
			.split(',')
			.map((column) => column.trim()) ?? [];
	const ordering = / ORDER BY (.+?)(?: LIMIT | FORMAT |$)/u.exec(query)?.[1];
	const orderedColumns = ordering?.split(',').map((term) => term.trim().split(/\s+/u)[0]) ?? [];
	// Assert: an unselected timestamp must never reach the provider.
	expect(selectedColumns).toEqual(expect.arrayContaining(orderedColumns));
});
