/// <reference types="node" />

import { spawnSync } from 'node:child_process';
import {
	mkdtemp,
	readFile,
	readdir,
	realpath,
	writeFile,
	mkdir,
	rename,
	unlink,
	rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { collectToolHostNodeViolations } from './audit-portal-architecture.ts';
import { inventoryInstalledPackages } from './tool-host-node-closure-inventory.ts';
import {
	loaderSource,
	scannerSource,
	declarationScannerSource,
} from './tool-host-node-closure-scanners.ts';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = fileURLToPath(import.meta.url);

function argument(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index === -1 ? undefined : process.argv[index + 1];
}

interface CommandResult {
	readonly code: number;
	readonly output: string;
}

async function command(props: {
	readonly executable: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly label: string;
	readonly evidence: string;
}): Promise<CommandResult> {
	const result = spawnSync(props.executable, props.args, {
		cwd: props.cwd,
		env: { ...process.env, NODE_PATH: '' },
		encoding: 'utf8',
		maxBuffer: 32 * 1024 * 1024,
	});
	const code = result.status ?? 1;
	const output = `${result.stdout ?? ''}${result.stderr ?? ''}${result.error === undefined ? '' : String(result.error)}\nEXIT_CODE=${code}\n`;
	await writeFile(
		path.join(props.evidence, `${props.label}.log`),
		`COMMAND: ${props.executable} ${props.args.join(' ')}\nCWD: ${props.cwd}\n${output}`,
	);
	process.stdout.write(`${props.label}: ${output}`);
	return { code, output };
}

async function replaceArtifact(location: string, content: string): Promise<void> {
	const temporary = `${location}.s2-change`;
	await writeFile(temporary, content);
	await rename(temporary, location);
}

async function declarationViolations(root: string): Promise<readonly string[]> {
	const entries = await readdir(root, { withFileTypes: true });
	const results = await Promise.all(
		entries.map(async (entry): Promise<readonly string[]> => {
			const location = path.join(root, entry.name);
			if (entry.isDirectory()) return declarationViolations(location);
			if (!entry.name.endsWith('.d.ts')) return [];
			return collectToolHostNodeViolations({
				filePath: `packages/tool-host-node/src/contracts/${entry.name}`,
				sourceText: await readFile(location, 'utf8'),
			});
		}),
	);
	return results.flat();
}

async function sourceViolations(directory: string): Promise<readonly string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const results = await Promise.all(
		entries.map(async (entry): Promise<readonly string[]> => {
			const location = path.join(directory, entry.name);
			if (entry.isDirectory()) return sourceViolations(location);
			if (!entry.name.endsWith('.ts')) return [];
			return collectToolHostNodeViolations({
				filePath: path.relative(repositoryRoot, location),
				sourceText: await readFile(location, 'utf8'),
			});
		}),
	);
	return results.flat();
}

export async function assertToolHostNodeSourceIsRestricted(): Promise<void> {
	const violations = await sourceViolations(
		path.join(repositoryRoot, 'packages/tool-host-node/src'),
	);
	if (violations.length > 0) throw new Error(violations.join('\n'));
}

const requiredExports: Readonly<Record<string, readonly string[]>> = {
	'.': [
		'startNodeHost',
		'createNodeHostComposition',
		'openNodeOperationStore',
		'nodeHostConfigSchema',
		'extractDirectOperationItem',
		'createNodeHttpUpstreamTransport',
	],
	'./catalog-typescript': ['compileCatalogTypescriptModules', 'fingerprintCatalogTypescriptInput'],
};
function consumerSource(subpaths: readonly string[]): string {
	return `const required=${JSON.stringify(requiredExports)};let count=0;
 for(const subpath of ${JSON.stringify(subpaths)}) {
 const module=await import('@agent-collaboration/tool-host-node'+(subpath==='.'?'':subpath.slice(1)));
 for(const name of required[subpath]??[])if(!(name in module))throw new Error('missing named export '+name);
 if(subpath==='.') {
 if(module.extractDirectOperationItem({'tool-portal/operation-item':'packed-item'})!=='packed-item'||module.extractDirectOperationItem({})!==null)throw new Error('packed operation item mapping failed');
 if(module.nodeHostConfigSchema.safeParse({schemaVersion:1}).success)throw new Error('packed host accepts incomplete configuration');
 } else if(subpath==='./catalog-typescript') {
 const bundle=await module.compileCatalogTypescriptModules({tools:[{namespace:'alpha',name:'read',inputSchema:{type:'object'}}]});
 if(bundle.manifest.generatorVersion!=='2'||bundle.manifest.sdkContractVersion!=='1'||bundle.nativeTools[0]?.registeredName!=='alpha__read__151160dc30'||bundle.files.length!==1)throw new Error('packed compiler contract failed');
 } else throw new Error('No probe for '+subpath);
 count++;
 }if(count===0)throw new Error('empty entrypoints');console.log('packed Node consumers: '+count+' entrypoints, actual compiler and strict host schema passed');`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function installedCheck(root: string): Promise<void> {
	const evidenceDirectory = argument('--evidence-dir');
	if (evidenceDirectory === undefined) throw new Error('Missing evidence directory');
	await inventoryInstalledPackages(path.dirname(argument('--consumer') ?? ''), evidenceDirectory);
	const violations = await declarationViolations(path.join(root, 'dist'));
	if (violations.length > 0) throw new Error(violations.join('\n'));
	const directory = path.dirname(argument('--consumer') ?? '');
	const evidence = argument('--evidence-dir');
	const entries = argument('--entries');
	if (evidence === undefined || entries === undefined)
		throw new Error('Missing installed-check arguments');
	const graph = await command({
		executable: process.execPath,
		args: ['--experimental-import-meta-resolve', path.join(directory, 'scanner.mjs'), entries],
		cwd: directory,
		label: 'graph',
		evidence,
	});
	const parsedEntries: unknown = JSON.parse(entries);
	if (
		!Array.isArray(parsedEntries) ||
		!parsedEntries.every((entry): entry is string => typeof entry === 'string')
	)
		throw new Error('Invalid installed entry list');
	const declarations = await command({
		executable: process.execPath,
		args: [
			path.join(directory, 'declaration-scanner.mjs'),
			JSON.stringify(parsedEntries.map((entry) => entry.replace(/\.js$/u, '.d.ts'))),
		],
		cwd: directory,
		label: 'declarations',
		evidence,
	});
	const runtime = await command({
		executable: process.execPath,
		args: ['--import', path.join(directory, 'loader.mjs'), path.join(directory, 'consumer.mjs')],
		cwd: directory,
		label: 'consumer',
		evidence,
	});
	if (graph.code !== 0 || declarations.code !== 0 || runtime.code !== 0)
		throw new Error('Packed closure or blocked-loader consumer failed');
}

export async function verifyToolHostNodeClosure(): Promise<void> {
	await assertToolHostNodeSourceIsRestricted();
	const scratch = await mkdtemp(path.join(tmpdir(), '2026-10-s3b-closure-'));
	const evidence = path.resolve(argument('--evidence-dir') ?? path.join(scratch, 'evidence'));
	await mkdir(evidence, { recursive: true });
	process.stdout.write(`packed closure scratch: ${scratch}\nevidence: ${evidence}\n`);
	const tarball = path.join(scratch, 'tool-host-node.tgz');
	const pack = await command({
		executable: 'pnpm',
		args: [
			'--config.ignore-scripts=true',
			'--dir',
			path.join(repositoryRoot, 'packages/tool-host-node'),
			'pack',
			'--out',
			tarball,
		],
		cwd: repositoryRoot,
		label: 'pack',
		evidence,
	});
	if (pack.code !== 0) throw new Error('tool-host-node pack failed');
	const dependencyOverrides = await Promise.all(
		['tool-access', 'tool-engine', 'oauth-broker-contracts', 'agent-portal-sdk'].map(
			async (name): Promise<readonly [string, string]> => {
				const location = path.join(scratch, `${name}.tgz`);
				const dependencyPack = await command({
					executable: 'pnpm',
					args: [
						'--config.ignore-scripts=true',
						'--dir',
						path.join(repositoryRoot, 'packages', name),
						'pack',
						'--out',
						location,
					],
					cwd: repositoryRoot,
					label: `pack-${name}`,
					evidence,
				});
				if (dependencyPack.code !== 0) throw new Error(`Dependency pack failed: ${name}`);
				return [
					['tool-access', 'tool-engine'].includes(name)
						? `@agent-collaboration/${name}`
						: `@agent-vm/${name}`,
					`file:${location}`,
				];
			},
		),
	);
	const overrides: Record<string, string> = Object.fromEntries(dependencyOverrides);

	await writeFile(
		path.join(scratch, 'package.json'),
		JSON.stringify({
			private: true,
			type: 'module',
			dependencies: {
				'@agent-collaboration/tool-host-node': `file:${tarball}`,
				'@agent-collaboration/tool-access': overrides['@agent-collaboration/tool-access'],
			},
			pnpm: { overrides },
		}),
	);
	await writeFile(
		path.join(scratch, 'pnpm-workspace.yaml'),
		`packages:\n  - '.'\noverrides:\n${Object.entries(overrides)
			.map(([name, location]) => `  ${JSON.stringify(name)}: ${JSON.stringify(location)}`)
			.join('\n')}\n`,
	);
	const install = await command({
		executable: 'pnpm',
		args: ['install', '--ignore-scripts', '--store-dir', path.join(scratch, 'cold-pnpm-store')],
		cwd: scratch,
		label: 'install-packed',
		evidence,
	});
	if (install.code !== 0) throw new Error('Packed consumer installation failed');
	const root = await realpath(
		path.join(scratch, 'node_modules/@agent-collaboration/tool-host-node'),
	);
	if (root.startsWith(`${repositoryRoot}${path.sep}`))
		throw new Error('Packed consumer resolved back into workspace');
	const manifest: unknown = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
	if (!isRecord(manifest) || !isRecord(manifest.exports))
		throw new Error('Packed package has no exports map');
	const subpaths = Object.keys(manifest.exports);
	if (
		subpaths.length === 0 ||
		Object.keys(requiredExports).some((entry) => !subpaths.includes(entry))
	)
		throw new Error('Required packed entrypoints are absent');
	const entryPaths = Object.values(manifest.exports).map((entry) => {
		if (!isRecord(entry) || typeof entry.import !== 'string')
			throw new Error('Every published subpath needs an import target');
		return path.resolve(root, entry.import);
	});
	await writeFile(path.join(scratch, 'loader.mjs'), loaderSource(repositoryRoot));
	await writeFile(path.join(scratch, 'scanner.mjs'), scannerSource(repositoryRoot));
	await writeFile(
		path.join(scratch, 'declaration-scanner.mjs'),
		declarationScannerSource(repositoryRoot),
	);
	await writeFile(path.join(scratch, 'consumer.mjs'), consumerSource(subpaths));
	async function check(label: string): Promise<CommandResult> {
		const runEvidence = path.join(evidence, label);
		await mkdir(runEvidence, { recursive: true });
		return command({
			executable: process.execPath,
			args: [
				'--import',
				'tsx',
				scriptPath,
				'--installed',
				root,
				'--consumer',
				path.join(scratch, 'consumer.mjs'),
				'--entries',
				JSON.stringify(entryPaths),
				'--evidence-dir',
				runEvidence,
			],
			cwd: repositoryRoot,
			label,
			evidence,
		});
	}
	const clean = await check('clean');
	if (clean.code !== 0) throw new Error('Clean packed control failed');
	if (process.argv.includes('--fixtures')) {
		const sourcePoison = path.join(
			repositoryRoot,
			'packages/tool-host-node/src/closure-import-poison.ts',
		);
		try {
			await writeFile(
				sourcePoison,
				"import type { UnsafeHost } from '@agent-vm/agent-vm'; export type Poison=UnsafeHost;\n",
				{ flag: 'wx' },
			);
			const red = await command({
				executable: process.execPath,
				args: ['--import', 'tsx', scriptPath, '--source-only'],
				cwd: repositoryRoot,
				label: 'source-red',
				evidence,
			});
			if (
				red.code === 0 ||
				!red.output.includes('tool-host-node forbidden import @agent-vm/agent-vm')
			)
				throw new Error('Source poison missed its intended diagnostic');
		} finally {
			await unlink(sourcePoison);
		}
		await assertToolHostNodeSourceIsRestricted();
		process.stdout.write('source poison: 1 intended rejection, restored source passed\n');
		const consumerPath = path.join(scratch, 'consumer.mjs');
		const originalConsumer = await readFile(consumerPath, 'utf8');
		try {
			await writeFile(
				consumerPath,
				originalConsumer +
					"\nconst {createRequire}=await import('node:module');createRequire(import.meta.url)('@agent-vm/secret-management');\n",
			);
			const red = await command({
				executable: process.execPath,
				args: ['--import', path.join(scratch, 'loader.mjs'), consumerPath],
				cwd: scratch,
				label: 'runtime-require-red',
				evidence,
			});
			if (
				red.code === 0 ||
				!red.output.includes('tool-host-node forbidden import @agent-vm/secret-management')
			)
				throw new Error('Runtime require poison missed its intended diagnostic');
		} finally {
			await writeFile(consumerPath, originalConsumer);
		}
		const runtimeGreen = await command({
			executable: process.execPath,
			args: ['--import', path.join(scratch, 'loader.mjs'), consumerPath],
			cwd: scratch,
			label: 'runtime-require-green',
			evidence,
		});
		if (runtimeGreen.code !== 0) throw new Error('Runtime require restoration failed');
		await subpaths.reduce<Promise<void>>(async (previous, subpath): Promise<void> => {
			await previous;
			const entryDirectory = path.join(root, 'dist', subpath.slice(2));
			const fixturePrefix = subpath.slice(2) + '-';
			const contract = path.join(entryDirectory, 'index.js');
			const declaration = path.join(entryDirectory, 'index.d.ts');
			const original = await readFile(contract, 'utf8');
			const originalDeclaration = await readFile(declaration, 'utf8');
			const fixtureSources = [
				{
					name: 'direct',
					source: original + "\nimport '@agent-vm/agent-vm';",
					reason: 'tool-host-node forbidden import @agent-vm/agent-vm',
				},
				{
					name: 'lazy',
					source:
						original +
						"\nexport async function lazyPoison(){return import('@agent-vm/secret-management');}",
					reason: 'tool-host-node forbidden import @agent-vm/secret-management',
				},
				{
					name: 're-export',
					source: original + "\nexport * from '@agent-vm/managed-vm';",
					reason: 'tool-host-node forbidden import @agent-vm/managed-vm',
				},
				{
					name: 'transitive',
					source: original + "\nexport * from './s2-transitive-poison.js';",
					reason: 'tool-host-node forbidden import @agent-vm/secret-management',
				},
				{
					name: 'gondolin',
					source: original + "\nimport '@earendil-works/gondolin';",
					reason: 'tool-host-node forbidden import @earendil-works/gondolin',
				},
				{
					name: 'managed-type',
					source: original,
					reason: 'tool-host-node managed type GatewayRuntimeTrustedInvocationContext',
				},
				{
					name: 'transitive-type',
					source: original,
					reason: 'tool-host-node managed type GatewayRuntimeTrustedInvocationContext',
				},
			];
			await writeFile(
				path.join(entryDirectory, 's2-transitive-poison.js'),
				"export async function lazyPoison() { return import('@agent-vm/secret-management'); }\n",
			);
			await fixtureSources.reduce<Promise<void>>(async (prior, fixture): Promise<void> => {
				await prior;
				try {
					await replaceArtifact(contract, fixture.source);
					if (fixture.declaration !== undefined)
						await replaceArtifact(declaration, `${originalDeclaration}\n${fixture.declaration}\n`);
					if (fixture.name === 'managed-type')
						await replaceArtifact(
							declaration,
							`${originalDeclaration}\nimport type { GatewayRuntimeTrustedInvocationContext } from '@agent-vm/gateway-control-contracts';\nexport type ManagedPoison = GatewayRuntimeTrustedInvocationContext;\n`,
						);
					if (fixture.name === 'transitive-type') {
						await replaceArtifact(
							declaration,
							`${originalDeclaration}\nexport * from './s2-type-poison.js';\n`,
						);
						await writeFile(
							path.join(entryDirectory, 's2-type-poison.d.ts'),
							"import type { GatewayRuntimeTrustedInvocationContext } from '@agent-vm/gateway-control-contracts'; export type ManagedPoison = GatewayRuntimeTrustedInvocationContext;\n",
						);
					}
					const red = await check(`${fixturePrefix}${fixture.name}-red`);
					if (red.code === 0 || !red.output.includes(fixture.reason))
						throw new Error(`Fixture ${fixture.name} did not fail for its intended reason`);
				} finally {
					await replaceArtifact(contract, original);
					await replaceArtifact(declaration, originalDeclaration);
					if (fixture.name === 'transitive-type')
						await unlink(path.join(entryDirectory, 's2-type-poison.d.ts'));
				}
				const green = await check(`${fixturePrefix}${fixture.name}-green`);
				if (green.code !== 0) throw new Error(`Fixture ${fixture.name} restoration failed`);
			}, Promise.resolve());
			process.stdout.write(
				`sensitivity: ${fixtureSources.length} intended rejections, ${fixtureSources.length} restored passes\n`,
			);
		}, Promise.resolve());
		const forbiddenTarball = path.join(scratch, 'managed-vm.tgz');
		const forbiddenPack = await command({
			executable: 'pnpm',
			args: [
				'--config.ignore-scripts=true',
				'--dir',
				path.join(repositoryRoot, 'packages/managed-vm'),
				'pack',
				'--out',
				forbiddenTarball,
			],
			cwd: repositoryRoot,
			label: 'pack-forbidden-inventory-fixture',
			evidence,
		});
		if (forbiddenPack.code !== 0) throw new Error('Forbidden dependency fixture pack failed');
		const installedManifest = path.join(root, 'package.json');
		const originalManifest = await readFile(installedManifest, 'utf8');
		const manifestValue: unknown = JSON.parse(originalManifest);
		if (!isRecord(manifestValue) || !isRecord(manifestValue.dependencies))
			throw new Error('Missing host dependency map');
		const poisonedTarball = path.join(scratch, 'host-with-forbidden-dependency.tgz');
		try {
			await writeFile(
				installedManifest,
				JSON.stringify({
					...manifestValue,
					dependencies: {
						...manifestValue.dependencies,
						'@agent-vm/managed-vm': `file:${forbiddenTarball}`,
					},
				}),
			);
			const poisonedPack = await command({
				executable: 'pnpm',
				args: ['--config.ignore-scripts=true', '--dir', root, 'pack', '--out', poisonedTarball],
				cwd: scratch,
				label: 'pack-host-forbidden-dependency',
				evidence,
			});
			if (poisonedPack.code !== 0) throw new Error('Poisoned host pack failed');
		} finally {
			await writeFile(installedManifest, originalManifest);
		}
		let restorationCode = 0;
		try {
			const installedPoison = await command({
				executable: 'pnpm',
				args: [
					'add',
					`@agent-collaboration/tool-host-node@file:${poisonedTarball}`,
					'--ignore-scripts',
					'--store-dir',
					path.join(scratch, 'cold-pnpm-store'),
				],
				cwd: scratch,
				label: 'install-forbidden-dependency',
				evidence,
			});
			if (installedPoison.code !== 0)
				throw new Error('Forbidden dependency fixture installation failed');
			let rejected = false;
			try {
				await inventoryInstalledPackages(scratch, evidence);
			} catch (error) {
				if (
					!String(error).includes('tool-host-node forbidden installed package @agent-vm/managed-vm')
				)
					throw error;
				rejected = true;
				await writeFile(
					path.join(evidence, 'inventory-forbidden-red.log'),
					`${String(error)}\nEXIT_CODE=1\n`,
				);
			}
			if (!rejected) throw new Error('Installed forbidden package escaped the inventory');
		} finally {
			const restored = await command({
				executable: 'pnpm',
				args: [
					'add',
					`@agent-collaboration/tool-host-node@file:${tarball}`,
					'--ignore-scripts',
					'--store-dir',
					path.join(scratch, 'cold-pnpm-store'),
				],
				cwd: scratch,
				label: 'restore-host-dependency',
				evidence,
			});
			restorationCode = restored.code;
		}
		if (restorationCode !== 0) throw new Error('Host dependency restoration failed');
		// pnpm can retain unreachable virtual-store entries. Recreate this owned consumer's generated install so no poison residue remains loadable.
		await rm(path.join(scratch, 'node_modules'), { recursive: true, force: true });
		const cleanInstall = await command({
			executable: 'pnpm',
			args: [
				'install',
				'--frozen-lockfile',
				'--ignore-scripts',
				'--store-dir',
				path.join(scratch, 'cold-pnpm-store'),
			],
			cwd: scratch,
			label: 'reinstall-clean-consumer',
			evidence,
		});
		if (cleanInstall.code !== 0) throw new Error('Clean consumer reinstall failed');
		await inventoryInstalledPackages(scratch, evidence);
		const restoredControl = await check('inventory-restored-green');
		if (restoredControl.code !== 0)
			throw new Error('Installed dependency restoration failed its real consumer');
		process.stdout.write(
			'inventory dependency poison: actual third @agent-vm package rejected, restored inventory and consumer passed\n',
		);
	}
	process.stdout.write(`tool-host-node packed closure: passed (${subpaths.length} entrypoints)\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	try {
		const installed = argument('--installed');
		if (process.argv.includes('--source-only')) await assertToolHostNodeSourceIsRestricted();
		else if (installed === undefined) await verifyToolHostNodeClosure();
		else await installedCheck(installed);
	} catch (error) {
		process.stderr.write(`${String(error)}\n`);
		process.exitCode = 1;
	}
}
