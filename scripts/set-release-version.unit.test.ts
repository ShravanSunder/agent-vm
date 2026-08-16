import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
	parseReleaseVersion,
	renderHermesAdapterProjectVersion,
	renderNpmPackageVersion,
	renderPythonProjectVersion,
	updateReleaseFiles,
} from './set-release-version.ts';

describe('release version rendering', () => {
	it('accepts stable semantic versions and rejects ranges or prereleases', () => {
		expect(parseReleaseVersion('0.0.139')).toBe('0.0.139');
		expect(() => parseReleaseVersion('v0.0.139')).toThrow('stable semantic version');
		expect(() => parseReleaseVersion('0.0.139-beta.1')).toThrow('stable semantic version');
		expect(() => parseReleaseVersion('^0.0.139')).toThrow('stable semantic version');
	});

	it('updates one npm package version without changing workspace dependency protocols', () => {
		const renderedManifest = renderNpmPackageVersion(
			`${JSON.stringify(
				{
					name: '@agent-vm/example',
					version: '0.0.138',
					dependencies: { '@agent-vm/managed-vm': 'workspace:*' },
				},
				null,
				'\t',
			)}\n`,
			'0.0.139',
		);

		expect(JSON.parse(renderedManifest)).toEqual({
			name: '@agent-vm/example',
			version: '0.0.139',
			dependencies: { '@agent-vm/managed-vm': 'workspace:*' },
		});
		expect(renderedManifest.endsWith('\n')).toBe(true);
	});

	it('updates both Python project versions and the Hermes adapter SDK pin', () => {
		const sdkProject = '[project]\nname = "agent-vm-agent-portal-sdk"\nversion = "0.0.138"\n';
		const adapterProject =
			'[project]\nname = "agent-vm-hermes-adapter"\nversion = "0.0.138"\ndependencies = [\n\t"agent-vm-agent-portal-sdk==0.0.138",\n]\n';

		expect(renderPythonProjectVersion(sdkProject, '0.0.139')).toContain('version = "0.0.139"');
		const renderedAdapter = renderHermesAdapterProjectVersion(adapterProject, '0.0.139');
		expect(renderedAdapter).toContain('version = "0.0.139"');
		expect(renderedAdapter).toContain('"agent-vm-agent-portal-sdk==0.0.139"');
	});

	it('updates every publishable package manifest while leaving private packages unchanged', async () => {
		const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'agent-vm-release-version-'));
		try {
			await Promise.all([
				mkdir(path.join(fixtureRoot, 'packages', 'public-package'), { recursive: true }),
				mkdir(path.join(fixtureRoot, 'packages', 'private-package'), { recursive: true }),
				mkdir(path.join(fixtureRoot, 'python', 'agent-vm-agent-portal-sdk'), {
					recursive: true,
				}),
				mkdir(path.join(fixtureRoot, 'python', 'agent-vm-hermes-adapter'), {
					recursive: true,
				}),
			]);
			await Promise.all([
				writeFile(
					path.join(fixtureRoot, 'packages', 'public-package', 'package.json'),
					'{"name":"@agent-vm/public-package","version":"0.0.138"}\n',
				),
				writeFile(
					path.join(fixtureRoot, 'packages', 'private-package', 'package.json'),
					'{"name":"@agent-vm/private-package","version":"0.0.138","private":true}\n',
				),
				writeFile(
					path.join(fixtureRoot, 'python', 'agent-vm-agent-portal-sdk', 'pyproject.toml'),
					'[project]\nname = "agent-vm-agent-portal-sdk"\nversion = "0.0.138"\n',
				),
				writeFile(
					path.join(fixtureRoot, 'python', 'agent-vm-hermes-adapter', 'pyproject.toml'),
					'[project]\nname = "agent-vm-hermes-adapter"\nversion = "0.0.138"\ndependencies = ["agent-vm-agent-portal-sdk==0.0.138"]\n',
				),
			]);

			await updateReleaseFiles(fixtureRoot, '0.0.139');

			const [publicManifest, privateManifest, sdkProject, adapterProject] = await Promise.all([
				readFile(path.join(fixtureRoot, 'packages', 'public-package', 'package.json'), 'utf8'),
				readFile(path.join(fixtureRoot, 'packages', 'private-package', 'package.json'), 'utf8'),
				readFile(
					path.join(fixtureRoot, 'python', 'agent-vm-agent-portal-sdk', 'pyproject.toml'),
					'utf8',
				),
				readFile(
					path.join(fixtureRoot, 'python', 'agent-vm-hermes-adapter', 'pyproject.toml'),
					'utf8',
				),
			]);
			expect(JSON.parse(publicManifest)).toMatchObject({ version: '0.0.139' });
			expect(JSON.parse(privateManifest)).toMatchObject({ version: '0.0.138' });
			expect(sdkProject).toContain('version = "0.0.139"');
			expect(adapterProject).toContain('version = "0.0.139"');
			expect(adapterProject).toContain('agent-vm-agent-portal-sdk==0.0.139');
		} finally {
			await rm(fixtureRoot, { recursive: true, force: true });
		}
	});
});
