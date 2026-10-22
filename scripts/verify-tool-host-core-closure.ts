import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { builtinModules, createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
	collectToolHostCoreViolations,
	isForbiddenToolHostCoreImport,
} from './audit-portal-architecture.ts';
import {
	preparePortalPackageClosureFixtures,
	portalPackageClosureFixtures,
} from './portal-package-closure-fixtures.ts';
import { portalPackageClosureScannerSource } from './portal-package-closure-scanner-source.ts';
import { isAllowedSdkNodeShimImport } from './tool-host-core-closure-policy.ts';
import { declarationScannerSource } from './verify-tool-engine-closure.ts';
import { resolveWorkerClosureBundler } from './worker-closure-bundler.ts';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function argument(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index === -1 ? undefined : process.argv[index + 1];
}

async function sourceViolations(directory: string): Promise<readonly string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const results = await Promise.all(
		entries.map(async (entry): Promise<readonly string[]> => {
			const location = path.join(directory, entry.name);
			if (entry.isDirectory()) return sourceViolations(location);
			if (!entry.name.endsWith('.ts')) return [];
			return collectToolHostCoreViolations({
				filePath: path.relative(repositoryRoot, location),
				sourceText: await readFile(location, 'utf8'),
			});
		}),
	);
	return results.flat();
}

export async function assertToolHostCoreSourceIsPortable(): Promise<void> {
	const violations = await sourceViolations(
		path.join(repositoryRoot, 'packages/tool-host-core/src'),
	);
	if (violations.length > 0) throw new Error(violations.join('\n'));
}

interface CommandResult {
	readonly code: number;
	readonly output: string;
}
async function command(props: {
	readonly args: readonly string[];
	readonly executable: string;
	readonly cwd: string;
	readonly evidence: string;
	readonly label: string;
}): Promise<CommandResult> {
	const result = spawnSync(props.executable, props.args, {
		cwd: props.cwd,
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

function policySource(): string {
	return `const portableBuiltinNames=new Set(${JSON.stringify(builtinModules.map((name) => name.replace(/^node:/u, '')))});
${isForbiddenToolHostCoreImport.toString()}
${isAllowedSdkNodeShimImport.toString()}
`;
}

function loaderSource(): string {
	return `import {registerHooks} from 'node:module';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
${policySource()}
const [condition,sdkNodeShim,graphPath]=JSON.parse(process.env.TOOL_HOST_CORE_CLOSURE_POLICY);
const firstPartyModules=new Set(JSON.parse(await readFile(graphPath,'utf8')).modules);
registerHooks({resolve(specifier,context,nextResolve){
 const importer=context.parentURL?.startsWith('file:')?fileURLToPath(context.parentURL):'';
 if(!firstPartyModules.has(importer))return nextResolve(specifier,context);
 if(isAllowedSdkNodeShimImport({condition,importer,sdkNodeShim,specifier}))return nextResolve(specifier,context);
 if(isForbiddenToolHostCoreImport(specifier))throw new Error('tool-host-core forbidden import '+specifier);
 const resolved=nextResolve(specifier,context);
 if(isForbiddenToolHostCoreImport(resolved.url))throw new Error('tool-host-core forbidden resolved import '+resolved.url);
 return resolved;
}});
`;
}

function consumerSource(): string {
	return `import {createOrganizationAuthority,createVolatileAuthorityStore,createHostedMcpProxy} from '@agent-collaboration/tool-host-core';
const store=createVolatileAuthorityStore();
const authority=createOrganizationAuthority({store,clock:{nowMs:()=>100},cap:1024});
const results=await Promise.all([authority.consumeApprovalToken('agent:token',200),authority.consumeApprovalToken('agent:token',200)]);
if(results.filter(result=>result.ok).length!==1)throw new Error('packed authority admitted duplicate use');
if(JSON.stringify(await store.read('approval-uses-v1'))!=='{"agent:token":200}')throw new Error('packed storage bytes changed');
const proxy=createHostedMcpProxy({verifier:{verify:async()=>{throw new Error('missing token must not verify');}},organizations:{forOrganization:()=>authority},configurations:{read:async()=>{throw new Error('must not load config');}},secrets:{read:()=>{throw new Error('must not read secret');}},analytics:{write:()=>{throw new Error('must not emit');}},log:()=>{},clock:{nowMs:()=>100,nowIso:()=>''},newId:()=> 'packed',limits:{requestBodyBytes:4194304,upstreamResponseBytes:4194304,replyBytes:16777216,batchCalls:50,batchConcurrency:6},createUpstreamMcpTransport:()=>{throw new Error('must not create transport');}});
const response=await proxy.handle(new Request('https://packed.invalid/mcp'));
if(response.status!==401||await response.text()!=='{"error":"missing-token"}')throw new Error('packed hosted caller response changed');
console.log('packed Node hosted proxy and atomic authority consumers passed');
`;
}

/** Packed consumers cannot fall back to workspace sources. Each condition is checked separately. */
export async function verifyToolHostCoreClosure(): Promise<void> {
	await assertToolHostCoreSourceIsPortable();
	const scratch = await mkdtemp(path.join(tmpdir(), '2026-10-tool-host-core-closure-'));
	const evidence = path.resolve(argument('--evidence-dir') ?? path.join(scratch, 'evidence'));
	await mkdir(evidence, { recursive: true });
	process.stdout.write(`packed closure scratch: ${scratch}\nevidence: ${evidence}\n`);
	const packageNames = ['tool-host-core', 'tool-engine', 'tool-access', 'oauth-broker-contracts'];
	const dependencies = await Promise.all(
		packageNames.map(async (name): Promise<readonly [string, string]> => {
			const tarball = path.join(scratch, `${name}.tgz`);
			const packed = await command({
				executable: 'pnpm',
				args: [
					'--config.ignore-scripts=true',
					'--dir',
					path.join(repositoryRoot, 'packages', name),
					'pack',
					'--out',
					tarball,
				],
				cwd: repositoryRoot,
				label: `pack-${name}`,
				evidence,
			});
			if (packed.code !== 0) throw new Error(`Failed to pack ${name}`);
			return [
				name === 'oauth-broker-contracts'
					? '@agent-vm/oauth-broker-contracts'
					: `@agent-collaboration/${name}`,
				`file:${tarball}`,
			];
		}),
	);
	const overrides = Object.fromEntries(dependencies);
	await writeFile(
		path.join(scratch, 'package.json'),
		JSON.stringify({ private: true, type: 'module', dependencies: overrides, pnpm: { overrides } }),
	);
	await writeFile(
		path.join(scratch, 'pnpm-workspace.yaml'),
		`packages:\n - '.'\noverrides:\n${Object.entries(overrides)
			.map(([name, location]) => ` ${JSON.stringify(name)}: ${JSON.stringify(location)}`)
			.join('\n')}\n`,
	);
	const install = await command({
		executable: 'pnpm',
		args: ['install', '--ignore-scripts'],
		cwd: scratch,
		label: 'install-packed',
		evidence,
	});
	if (install.code !== 0) throw new Error('Packed consumer installation failed');
	const root = await realpath(
		path.join(scratch, 'node_modules/@agent-collaboration/tool-host-core'),
	);
	const entry = path.join(root, 'dist/index.js');
	const requireFromEntry = createRequire(entry);
	const sdkNodeShim = requireFromEntry
		.resolve('@modelcontextprotocol/server/_shims')
		.replace(/\.cjs$/u, '.mjs');
	const bundler = await resolveWorkerClosureBundler(repositoryRoot);
	await Promise.all(
		(['first-party', 'worker'] as const).map(async (scan): Promise<void> => {
			await writeFile(
				path.join(scratch, `scanner-${scan}.mjs`),
				portalPackageClosureScannerSource({
					repositoryRoot,
					scan,
					packageLabel: 'tool-host-core',
					forbiddenImportSource: isForbiddenToolHostCoreImport.toString(),
					sdkNodeShim,
					typescriptUrl: import.meta.resolve('typescript'),
					esbuildUrl: bundler.esbuildUrl,
					bundlerProvenance: bundler,
				}),
			);
		}),
	);
	await writeFile(
		path.join(scratch, 'declaration-scanner.mjs'),
		declarationScannerSource({
			forbiddenImportSource: `const isForbiddenToolEngineImport = ${isForbiddenToolHostCoreImport.toString()};`,
			packageLabel: 'tool-host-core',
		}),
	);
	const declarations = await command({
		executable: process.execPath,
		args: [
			path.join(scratch, 'declaration-scanner.mjs'),
			JSON.stringify([path.join(root, 'dist/index.d.ts')]),
		],
		cwd: scratch,
		evidence,
		label: 'declarations',
	});
	if (declarations.code !== 0) throw new Error('Packed declaration closure failed');
	await writeFile(path.join(scratch, 'loader.mjs'), loaderSource());
	await writeFile(path.join(scratch, 'consumer.mjs'), consumerSource());
	async function scanClosure(
		scanKind: 'first-party' | 'worker',
		label: string,
	): Promise<CommandResult> {
		return command({
			executable: process.execPath,
			args: [
				'--experimental-import-meta-resolve',
				path.join(scratch, `scanner-${scanKind}.mjs`),
				JSON.stringify([entry]),
				path.join(evidence, label),
			],
			cwd: scratch,
			evidence,
			label,
		});
	}
	async function check(label: string): Promise<CommandResult> {
		const firstParty = await scanClosure('first-party', `${label}-first-party`);
		if (firstParty.code !== 0) return firstParty;
		return scanClosure('worker', `${label}-worker`);
	}
	if ((await check('clean')).code !== 0) throw new Error('Clean dual closure failed');
	// The Node runtime consumer has a loader that enforces the same exact edge policy.
	const consumer = spawnSync(
		process.execPath,
		['--import', path.join(scratch, 'loader.mjs'), path.join(scratch, 'consumer.mjs')],
		{
			cwd: scratch,
			encoding: 'utf8',
			env: {
				...process.env,
				TOOL_HOST_CORE_CLOSURE_POLICY: JSON.stringify([
					'node',
					sdkNodeShim,
					path.join(evidence, 'clean-first-party/first-party-graph.json'),
				]),
			},
		},
	);
	await writeFile(
		path.join(evidence, 'consumer.log'),
		`${consumer.stdout ?? ''}${consumer.stderr ?? ''}\nEXIT_CODE=${consumer.status ?? 1}\n`,
	);
	if (consumer.status !== 0) throw new Error(`Packed consumer failed: ${consumer.stderr ?? ''}`);
	if (process.argv.includes('--fixtures')) {
		await preparePortalPackageClosureFixtures(root);
		const original = await readFile(entry, 'utf8');
		const fixtures = portalPackageClosureFixtures(original, 'tool-host-core').filter((fixture) =>
			[
				'direct',
				'browser-main-field',
				'worker-nonliteral-import',
				'worker-nonliteral-require',
			].includes(fixture.name),
		);
		await fixtures.reduce<Promise<void>>(async (previous, fixture): Promise<void> => {
			await previous;
			try {
				await writeFile(entry, fixture.source);
				const red = await check(`${fixture.name}-red`);
				if (
					red.code === 0 ||
					!red.output.includes(fixture.reason) ||
					(fixture.scanReason !== undefined && !red.output.includes(fixture.scanReason))
				)
					throw new Error(`${fixture.name} did not fail for its intended reason`);
			} finally {
				await writeFile(entry, original);
			}
			if ((await check(`${fixture.name}-restored`)).code !== 0)
				throw new Error(`${fixture.name} closure did not restore`);
		}, Promise.resolve());
		process.stdout.write(
			`sensitivity: ${fixtures.length} intended rejections, ${fixtures.length} restored passes\n`,
		);
	}
	process.stdout.write(
		'tool-host-core packed closure: passed (Node first-party with exact SDK shim, full Worker bundler)\n',
	);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	try {
		await verifyToolHostCoreClosure();
	} catch (error) {
		process.stderr.write(`${String(error)}\n`);
		process.exitCode = 1;
	}
}
