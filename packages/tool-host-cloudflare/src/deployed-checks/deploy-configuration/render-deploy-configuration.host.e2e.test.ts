import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { workspaceConfigurationSchema } from '@agent-collaboration/tool-host-core';
import { expect, it } from 'vitest';
import { z } from 'zod';

import { privateDeployFixture } from '#worker-host/deployed-checks/deploy-configuration/test-fixtures/private-deploy-fixture';
import { expectedWorkspaceRecordsSchema } from '#worker-host/deployed-checks/deployed-check-suites/analytics-observations';

const executeFile = promisify(execFile);

it('renders accepted trailing-slash helper origins through the real CLI and passes Wrangler dry-run validation', async () => {
	const directory = await mkdtemp(path.join(tmpdir(), '2026-10-helper-origin-'));
	try {
		const fixture = privateDeployFixture(directory);
		const input = path.join(directory, 'input.json');
		const output = path.join(directory, 'output');
		await writeFile(
			input,
			JSON.stringify({
				...fixture,
				helper: { ...fixture.helper, origin: 'https://helper.invalid/' },
				analyticsSqlFile: path.join(directory, 'sql-evidence', 'response.json'),
			}),
			{ mode: 0o600 },
		);
		await executeFile(
			process.execPath,
			[
				'--import',
				'tsx',
				'packages/tool-host-cloudflare/src/deployed-checks/deploy-configuration/render-deploy-configuration.ts',
				output,
				'--worker=all',
				'--workers-dev=false',
			],
			{
				cwd: process.cwd(),
				env: { ...process.env, TOOL_PORTAL_PRIVATE_DEPLOY_FILE: input },
			},
		);
		const portal: unknown = JSON.parse(await readFile(path.join(output, 'portal-a.json'), 'utf8'));
		expect(portal).toMatchObject({
			vars: {
				SIGN_IN_ISSUER: 'https://helper.invalid',
				SIGN_IN_JWKS_URL: 'https://helper.invalid/jwks',
			},
		});
		const parsedPortal = z
			.object({
				vars: z.object({ WORKSPACE_CONFIGURATIONS: z.string(), TOOL_PORTAL_ORIGIN: z.string() }),
			})
			.parse(portal);
		const workspaces = z
			.record(z.string(), workspaceConfigurationSchema)
			.parse(JSON.parse(parsedPortal.vars.WORKSPACE_CONFIGURATIONS));
		expect(Object.keys(workspaces)).toEqual(
			fixture.workspaces.map((workspace) => workspace.workspaceId),
		);
		for (const workspace of fixture.workspaces)
			expect(workspaces[workspace.workspaceId]).toMatchObject({
				organizationId: workspace.organizationId,
				workspaceName: `${fixture.runId}:${workspace.label}`,
			});
		const secrets = JSON.parse(await readFile(path.join(output, 'portal-a.secrets.json'), 'utf8'));
		expect(Object.values(secrets)).toEqual(
			fixture.workspaces.flatMap((workspace) => [workspace.credential, workspace.approvalKeyHex]),
		);
		const portalB = z
			.object({ vars: z.object({ TOOL_PORTAL_ORIGIN: z.string() }) })
			.parse(JSON.parse(await readFile(path.join(output, 'portal-b.json'), 'utf8')));
		expect(parsedPortal.vars.TOOL_PORTAL_ORIGIN).toBe(fixture.portalA.origin);
		expect(portalB.vars.TOOL_PORTAL_ORIGIN).toBe(fixture.portalA.origin);
		const expected = expectedWorkspaceRecordsSchema.parse(
			JSON.parse(
				await readFile(path.join(directory, 'sql-evidence', 'expected-workspaces.json'), 'utf8'),
			),
		);
		expect(expected).toEqual(
			fixture.workspaces.map(({ organizationId, workspaceId, label }) => ({
				organizationId,
				workspaceId,
				label,
			})),
		);
		const query = await readFile(
			path.join(directory, 'sql-evidence', 'row-16-analytics-query.sql'),
			'utf8',
		);
		expect(query).toContain('blob9');
		expect(query).toContain(fixture.workspaces[1].workspaceId);
		expect(query).toContain(`${fixture.runId}:beta`);
		await Promise.all(
			['expected-workspaces.json', 'row-16-analytics-query.sql'].map(
				async (name): Promise<void> => {
					expect((await stat(path.join(directory, 'sql-evidence', name))).mode & 0o777).toBe(0o600);
				},
			),
		);
		const rendered = JSON.stringify(portal);
		expect(rendered).toContain('https://helper.invalid/mcp/alpha');
		expect(rendered).not.toContain('https://helper.invalid//');
		expect((await stat(path.join(output, 'portal-a.json'))).mode & 0o777).toBe(0o600);
		await executeFile(
			'pnpm',
			[
				'--filter',
				'@agent-collaboration/tool-host-cloudflare',
				'exec',
				'wrangler',
				'deploy',
				'--dry-run',
				'--config',
				path.join(output, 'portal-a.json'),
				'--outdir',
				path.join(directory, 'bundle'),
			],
			{
				cwd: process.cwd(),
				env: {
					...process.env,
					WRANGLER_SEND_METRICS: 'false',
					WRANGLER_LOG_PATH: path.join(directory, 'wrangler.log'),
				},
				timeout: 60_000,
				maxBuffer: 4 * 1024 * 1024,
			},
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
