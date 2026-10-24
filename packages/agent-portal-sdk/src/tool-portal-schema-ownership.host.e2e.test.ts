import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';

const executeFile = promisify(execFile);

it('keeps packed SDK and access schemas and refinement registry identical', async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), '2026-10-s3d-schema-pack-'));
	const repositoryRoot = process.cwd();
	try {
		await Promise.all(
			['tool-access', 'agent-portal-sdk'].map(async (packageDirectory) => {
				const archivePath = path.join(directory, `${packageDirectory}.tgz`);
				await executeFile(
					'pnpm',
					['--dir', `packages/${packageDirectory}`, 'pack', '--out', archivePath],
					{
						cwd: repositoryRoot,
						env: { ...process.env, npm_config_ignore_scripts: 'true' },
					},
				);
				const unpackedPath = path.join(directory, packageDirectory);
				await mkdir(unpackedPath);
				await executeFile('tar', ['-xzf', archivePath, '-C', unpackedPath]);
			}),
		);
		// Recreate each packed owner's declared dependency edges, using the packed
		// Access artifact for the shared contract identity and installed external packages.
		await Promise.all(
			['tool-access', 'agent-portal-sdk'].map(async (packageDirectory) => {
				const packedRoot = path.join(directory, packageDirectory, 'package');
				const manifest: unknown = JSON.parse(
					await readFile(path.join(packedRoot, 'package.json'), 'utf8'),
				);
				if (
					typeof manifest !== 'object' ||
					manifest === null ||
					!('dependencies' in manifest) ||
					typeof manifest.dependencies !== 'object' ||
					manifest.dependencies === null
				)
					throw new Error(`Packed ${packageDirectory} has no dependency manifest.`);
				await Promise.all(
					Object.keys(manifest.dependencies).map(async (dependency) => {
						const link = path.join(packedRoot, 'node_modules', dependency);
						await mkdir(path.dirname(link), { recursive: true });
						await symlink(
							dependency === '@agent-collaboration/tool-access'
								? path.join(directory, 'tool-access/package')
								: path.join(
										repositoryRoot,
										'packages',
										packageDirectory,
										'node_modules',
										dependency,
									),
							link,
							'dir',
						);
					}),
				);
			}),
		);
		const oracle: unknown = JSON.parse(
			await readFile(
				new URL('./tool-portal-schema-d25be046.snapshot.json', import.meta.url),
				'utf8',
			),
		);
		const script = `
import { createHash } from 'node:crypto';
const sdk = await import(${JSON.stringify(path.join(directory, 'agent-portal-sdk/package/dist/index.js'))});
const access = await import(${JSON.stringify(path.join(directory, 'tool-access/package/dist/contracts/index.js'))});
const shared = Object.entries(access).filter(([name, value]) => name in sdk && name.endsWith('Schema'));
const hash = createHash('sha256').update(JSON.stringify(sdk.createPortableContractSchemaManifest())).digest('hex');
console.log(JSON.stringify({ exports: Object.keys(sdk).toSorted(), manifestBytes: hash, sharedCount: shared.length, differentInstances: shared.filter(([name, value]) => sdk[name] !== value).map(([name]) => name) }));
`;
		const { stdout } = await executeFile(
			process.execPath,
			['--input-type=module', '--eval', script],
			{ cwd: repositoryRoot },
		);
		const result: unknown = JSON.parse(stdout);
		expect(result).toMatchObject({
			differentInstances: [],
			manifestBytes: Reflect.get(Object(oracle), 'manifestBytes'),
		});
		expect(result).toMatchObject({
			exports: Reflect.get(Object(Reflect.get(Object(oracle), 'exports')), 'sdkRoot'),
		});
		expect(Reflect.get(Object(result), 'sharedCount')).toBeGreaterThan(40);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
