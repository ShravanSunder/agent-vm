import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
	readPrivateDeployFile,
	requireOutsideGitWorkTree,
} from '#worker-host/deployed-checks/deploy-configuration/private-file-access';
import {
	renderDeployConfiguration,
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
		await renderDeployConfiguration(privateDeployFixture(directory), directory);
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
	it('substitutes JSON values without string interpolation and refuses unfilled placeholders', () => {
		expect(
			substituteTemplate('{"value":"__VALUE__"}', { __VALUE__: { nested: '"quoted"' } }),
		).toEqual({ value: { nested: '"quoted"' } });
		expect(() => substituteTemplate('"__MISSING__"', {})).toThrow();
	});
});
