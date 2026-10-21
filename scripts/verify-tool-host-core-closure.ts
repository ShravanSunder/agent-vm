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
import { isAllowedSdkNodeShimImport } from './tool-host-core-closure-policy.ts';
import { declarationScannerSource } from './verify-tool-engine-closure.ts';

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

function scannerSource(): string {
	return `import {readFile,realpath,writeFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import ts from ${JSON.stringify(import.meta.resolve('typescript'))};
${policySource()}
const [entry,condition,sdkNodeShim,graphPath]=process.argv.slice(2);
const pending=[entry],visited=new Set();let edges=0,allowedEdges=0;
while(pending.length){
 const location=await realpath(pending.pop());if(visited.has(location))continue;visited.add(location);
 if(location.startsWith(${JSON.stringify(repositoryRoot)}+'/'))throw new Error('tool-host-core workspace fallback '+location);
 if(isForbiddenToolHostCoreImport(pathToFileURL(location).href))throw new Error('tool-host-core forbidden resolved path '+location);
 if(location.endsWith('.json'))continue;
 const source=ts.createSourceFile(location,await readFile(location,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),imports=[];
 function visit(node){
  if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier)imports.push({specifier:node.moduleSpecifier.text,kind:'import'});
  if(ts.isCallExpression(node)&&(node.expression.kind===ts.SyntaxKind.ImportKeyword||(ts.isIdentifier(node.expression)&&node.expression.text==='require'))){
   if(node.arguments.length!==1||!ts.isStringLiteral(node.arguments[0]))throw new Error('tool-host-core nonliteral import '+location);
   imports.push({specifier:node.arguments[0].text,kind:node.expression.kind===ts.SyntaxKind.ImportKeyword?'import':'require'});
  }
  ts.forEachChild(node,visit);
 }visit(source);
 for(const {specifier,kind} of imports){
  edges++;
  if(isAllowedSdkNodeShimImport({condition,importer:location,sdkNodeShim,specifier})){allowedEdges++;continue;}
  if(isForbiddenToolHostCoreImport(specifier))throw new Error('tool-host-core forbidden import '+specifier+' from '+location);
  const resolved=kind==='require'?pathToFileURL(createRequire(location).resolve(specifier)).href:import.meta.resolve(specifier,pathToFileURL(location).href);
  if(isForbiddenToolHostCoreImport(resolved))throw new Error('tool-host-core forbidden resolved import '+resolved);
  if(!resolved.startsWith('file:'))throw new Error('tool-host-core non-file dependency '+resolved);
  pending.push(fileURLToPath(resolved));
 }
}
if(visited.size===0)throw new Error('empty closure');
if(condition==='node'&&allowedEdges!==1)throw new Error('Expected exactly one SDK Node shim edge, saw '+allowedEdges);
if(condition!=='node'&&allowedEdges!==0)throw new Error('Unexpected shim exception');
await writeFile(graphPath,JSON.stringify({condition,modules:[...visited],edges,allowedEdges,pkceModules:[...visited].filter(location=>location.includes('/pkce-challenge/'))},null,2));
console.log(condition+' closure: '+visited.size+' modules, '+edges+' edges, '+allowedEdges+' exact SDK Node shim edge(s)');
`;
}

function loaderSource(): string {
	return `import {registerHooks} from 'node:module';
import {fileURLToPath} from 'node:url';
${policySource()}
const [condition,sdkNodeShim]=JSON.parse(process.env.TOOL_HOST_CORE_CLOSURE_POLICY);
registerHooks({resolve(specifier,context,nextResolve){
 const importer=context.parentURL?.startsWith('file:')?fileURLToPath(context.parentURL):'';
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
	await writeFile(path.join(scratch, 'scanner.mjs'), scannerSource());
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
	async function scan(condition: string, label: string): Promise<CommandResult> {
		return command({
			executable: process.execPath,
			args: [
				'--experimental-import-meta-resolve',
				...(condition === 'node' ? [] : [`--conditions=${condition}`]),
				path.join(scratch, 'scanner.mjs'),
				entry,
				condition,
				sdkNodeShim,
				path.join(evidence, `${label}-graph.json`),
			],
			cwd: scratch,
			evidence,
			label,
		});
	}
	for (const condition of ['browser', 'workerd', 'node']) {
		const clean = await scan(condition, `${condition}-clean`);
		if (clean.code !== 0) throw new Error(`${condition} clean closure failed`);
	}
	// The Node runtime consumer has a loader that enforces the same exact edge policy.
	const consumer = spawnSync(
		process.execPath,
		['--import', path.join(scratch, 'loader.mjs'), path.join(scratch, 'consumer.mjs')],
		{
			cwd: scratch,
			encoding: 'utf8',
			env: { ...process.env, TOOL_HOST_CORE_CLOSURE_POLICY: JSON.stringify(['node', sdkNodeShim]) },
		},
	);
	await writeFile(
		path.join(evidence, 'consumer.log'),
		`${consumer.stdout ?? ''}${consumer.stderr ?? ''}\nEXIT_CODE=${consumer.status ?? 1}\n`,
	);
	if (consumer.status !== 0) throw new Error(`Packed consumer failed: ${consumer.stderr ?? ''}`);
	if (process.argv.includes('--fixtures')) {
		const original = await readFile(entry, 'utf8');
		for (const condition of ['browser', 'workerd', 'node']) {
			try {
				await writeFile(
					entry,
					`${original}\nexport async function forbiddenHostRuntime(){ return import('node:process'); }\n`,
				);
				const red = await scan(condition, `${condition}-planted-node-red`);
				if (red.code === 0 || !red.output.includes('tool-host-core forbidden import node:process'))
					throw new Error(`${condition} planted violation did not fail for its intended reason`);
			} finally {
				await writeFile(entry, original);
			}
			if ((await scan(condition, `${condition}-restored`)).code !== 0)
				throw new Error(`${condition} closure did not restore`);
		}
	}
	process.stdout.write(
		'tool-host-core packed closure: passed (browser, workerd, Node with exact SDK shim exception)\n',
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
