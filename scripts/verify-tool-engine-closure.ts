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
} from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
	collectToolEngineViolations,
	isForbiddenToolEngineImport,
} from './audit-portal-architecture.ts';
import {
	preparePortalPackageClosureFixtures,
	portalPackageClosureFixtures,
} from './portal-package-closure-fixtures.ts';
import { portalPackageClosureScannerSource } from './portal-package-closure-scanner-source.ts';
import { resolveWorkerClosureBundler } from './worker-closure-bundler.ts';

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
			return collectToolEngineViolations({
				filePath: `packages/tool-engine/src/contracts/${entry.name}`,
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
			return collectToolEngineViolations({
				filePath: path.relative(repositoryRoot, location),
				sourceText: await readFile(location, 'utf8'),
			});
		}),
	);
	return results.flat();
}

export async function assertToolEngineSourceIsPortable(): Promise<void> {
	const violations = await sourceViolations(path.join(repositoryRoot, 'packages/tool-engine/src'));
	if (violations.length > 0) throw new Error(violations.join('\n'));
}

function loaderSource(): string {
	return `import { registerHooks } from 'node:module';
const portableBuiltinNames = new Set(${JSON.stringify(builtinModules.map((name) => name.replace(/^node:/u, '')))});
${isForbiddenToolEngineImport.toString()}
registerHooks({resolve(specifier, context, nextResolve) {
 if (isForbiddenToolEngineImport(specifier)) throw new Error('tool-engine forbidden import ' + specifier);
 const resolved=nextResolve(specifier,context);
 if (isForbiddenToolEngineImport(resolved.url)) throw new Error('tool-engine forbidden resolved path ' + resolved.url);
 return resolved;
}});
`;
}

export function declarationScannerSource(
	props: {
		readonly forbiddenImportSource?: string;
		readonly packageLabel?: string;
	} = {},
): string {
	return `import {readFile,realpath} from 'node:fs/promises';
import {builtinModules} from 'node:module';
import {pathToFileURL} from 'node:url';
import ts from ${JSON.stringify(import.meta.resolve('typescript'))};
const portableBuiltinNames=new Set(builtinModules.map(name=>name.replace(/^node:/u,'')));
${props.forbiddenImportSource ?? isForbiddenToolEngineImport.toString()}
const pending=JSON.parse(process.argv[2]); const visited=new Set();let edges=0;
while(pending.length){
 const location=await realpath(pending.pop());if(visited.has(location))continue;visited.add(location);
 if(location.startsWith(${JSON.stringify(repositoryRoot)}+'/'))throw new Error('tool-engine declaration workspace fallback '+location);
 const source=ts.createSourceFile(location,await readFile(location,'utf8'),ts.ScriptTarget.Latest,true); const imports=[];
 for(const reference of source.typeReferenceDirectives)if(reference.fileName==='node')throw new Error('tool-engine forbidden declaration node types from '+location);
 function visit(node){
 if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier&&ts.isStringLiteral(node.moduleSpecifier))imports.push(node.moduleSpecifier.text);
 if(ts.isImportTypeNode(node)&&ts.isLiteralTypeNode(node.argument)&&ts.isStringLiteral(node.argument.literal))imports.push(node.argument.literal.text);
 if(ts.isImportEqualsDeclaration(node)&&ts.isExternalModuleReference(node.moduleReference)&&node.moduleReference.expression&&ts.isStringLiteral(node.moduleReference.expression))imports.push(node.moduleReference.expression.text);
 if(ts.isIdentifier(node)&&node.text.startsWith('GatewayRuntime'))throw new Error('tool-engine managed type '+node.text);
 ts.forEachChild(node,visit);
 }visit(source);
 for(const specifier of imports){
 if(isForbiddenToolEngineImport(specifier))throw new Error('tool-engine forbidden import '+specifier+' from '+location);
 const resolved=ts.resolveModuleName(specifier,location,{module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext},ts.sys,undefined,undefined,ts.ModuleKind.ESNext).resolvedModule;
 if(!resolved)throw new Error('tool-engine unresolved declaration '+specifier+' from '+location);
 if(isForbiddenToolEngineImport(pathToFileURL(resolved.resolvedFileName).href))throw new Error('tool-engine forbidden resolved declaration '+resolved.resolvedFileName);
 pending.push(resolved.resolvedFileName);edges++;
 }
}
if(visited.size===0)throw new Error('empty declaration closure');console.log('declaration import closure: '+visited.size+' modules, '+edges+' type edges');
`.replaceAll('tool-engine', props.packageLabel ?? 'tool-engine');
}

const requiredExports: Readonly<Record<string, readonly string[]>> = {
	'./standalone-tool-portal': [
		'createStandaloneToolPortalCore',
		'mergeToolPortalList',
		'mergeToolPortalSearch',
		'mergeToolPortalDescribe',
	],
	'./mcp-gateway': [
		'createMcpGateway',
		'encodeToolRef',
		'decodeToolRef',
		'createAgentCatalogViewCache',
	],
	'./upstream-mcp-connectors': [
		'createUpstreamMcpClientRuntime',
		'redactUpstreamResponse',
		'UpstreamMcpError',
	],
	'./capability-dispatch': [
		'createCapabilityDispatcher',
		'dispatchInvocationSchema',
		'operationKeySchema',
		'operationRecordSchema',
		'approvalReceiptSchema',
		'approvalChallengeSchema',
	],
};
function consumerSource(subpaths: readonly string[]): string {
	return `const required=${JSON.stringify(requiredExports)};
const contracts=await import('@agent-collaboration/tool-access/contracts');
const {createAccessAssessor}=await import('@agent-collaboration/tool-access/authorization');
let count=0;
for(const subpath of ${JSON.stringify(subpaths)}) {
 const module=await import('@agent-collaboration/tool-engine'+subpath.slice(1));
 for(const name of required[subpath]??[])if(!(name in module))throw new Error('missing named export '+name);
 if(subpath==='./capability-dispatch') {
 const key=module.operationKeySchema.parse({authority:'packed',principal:'agent',item:'original'});
 if(key.item!=='original')throw new Error('operation key changed');
 const revision={owner:'packed',revision:'v1'};
 const access=contracts.assessAccessInput.parse({capability:{namespace:'example',tool:'read'},surface:'mcp',call:{arguments:{},account:null,digest:'a'.repeat(64)},facts:{workspace:{kind:'not-configured'},assignment:{profile:{profileId:'packed',namespaces:{example:{backendKind:'mcp_provider',tools:{allow:'*',deny:[]},calls:{kind:'selectors',requiresApproval:{allow:[],deny:[]},withoutApproval:{allow:'*',deny:[]}},operations:{}}}},profileRevision:revision,revision},surface:{eligible:['mcp'],snapshot:revision},accounts:[],upstream:{status:'available',credentialNeed:'none',binding:revision}}});
 let invokes=0;
 const backend={backendKind:'mcp_provider',list:async()=>({}),describe:async()=>({}),search:async()=>({}),invoke:async(invocation)=>{invokes++;if(invocation.operationKey.item!=='original')throw new Error('dispatch changed the item');return {kind:'completed',result:'packed-ok'};}};
 const unavailable=async()=>({kind:'unavailable'});
 const dispatcher=module.createCapabilityDispatcher({assessAccess:createAccessAssessor({workspaceLayer:'not-configured',config:revision}),operations:{createOrRead:async()=>({kind:'untracked'}),lookup:unavailable,transition:unavailable},approvals:{challenge:unavailable,decision:unavailable,receipt:unavailable},backends:new Map([['mcp_provider',backend]]),now:()=>0});
 const result=await dispatcher.dispatch({authority:'packed',principal:'agent',item:'original',verifiedContextRef:'packed-context',correlation:{},access});
 if(result.kind!=='completed'||result.result!=='packed-ok'||invokes!==1)throw new Error('packed dispatch did not reach its backend exactly once');
 } else if(subpath==='./standalone-tool-portal') {
 const revision={owner:'packed',revision:'v1'};
 const forbiddenEffect=()=>{throw new Error('empty discovery must not prepare or invoke a call');};
 const core=module.createStandaloneToolPortalCore({binding:{workspaceLayer:'not-configured',config:revision},now:()=>0,resolveInvocation:async()=>({authority:'packed',principal:'agent',verifiedContextRef:'packed-context',owningGeneration:'packed-generation',correlation:{},entries:[],readOptions:undefined,accessForCall:forbiddenEffect,operationId:forbiddenEffect,prepareBatch:forbiddenEffect})});
 const list=await core.list({requests:[{id:'packed-list'}]},undefined);
 const search=await core.search({requests:[{id:'packed-search',query:'packed'}]},undefined);
 const describe=await core.describe({requests:[{id:'packed-describe',tools:[{namespace:'example',name:'read'}]}]},undefined);
 const expectedList={items:[{id:'packed-list',status:'ok',value:{namespaces:[],tools:[],namespaceDiscovery:[]}}],ok:true};
 const expectedSearch={items:[{id:'packed-search',status:'ok',value:{tools:[],namespaceDiscovery:[]}}],ok:true};
 const expectedDescribe={items:[{id:'packed-describe',status:'ok',value:{tools:[],namespaceDiscovery:[]}}],ok:true};
 if(JSON.stringify(list)!==JSON.stringify(expectedList)||JSON.stringify(search)!==JSON.stringify(expectedSearch)||JSON.stringify(describe)!==JSON.stringify(expectedDescribe))throw new Error('packed standalone discovery did not retain empty-entry results');
 } else if(subpath==='./mcp-gateway') {
 if(module.encodeToolRef({namespace:'雪',toolName:'café:read'})!=='mcp:6Zuq:Y2Fmw6k6cmVhZA')throw new Error('packed reference bytes changed');
 const identity=module.decodeToolRef('mcp:YWxwaGE:cmVhZA');if(identity.namespace!=='alpha'||identity.toolName!=='read')throw new Error('packed reference decode changed');
 } else if(subpath==='./upstream-mcp-connectors') {
 const redacted=module.redactUpstreamResponse({nested:{token:'secret'}});if(redacted.nested.token!=='[REDACTED]')throw new Error('packed redaction failed');
 const runtime=module.createUpstreamMcpClientRuntime({servers:[],createUpstreamMcpTransport:()=>{throw new Error('no configured transport');}});
 await runtime.closeAgentScope('packed');
 } else throw new Error('No entrypoint-specific probe for '+subpath);
 count++;
}
if(count===0)throw new Error('empty entrypoint inventory');
console.log('packed entrypoint consumers: '+count+' entrypoints, required exports, schemas, real assessment and dispatch passed');`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function installedCheck(root: string): Promise<void> {
	const violations = await declarationViolations(path.join(root, 'dist'));
	if (violations.length > 0) throw new Error(violations.join('\n'));
	const directory = path.dirname(argument('--consumer') ?? '');
	const evidence = argument('--evidence-dir');
	const entries = argument('--entries');
	if (evidence === undefined || entries === undefined)
		throw new Error('Missing installed-check arguments');
	const graphs = await Promise.all(
		(['first-party', 'worker'] as const).map(
			async (scan): Promise<CommandResult> =>
				await command({
					executable: process.execPath,
					args: [
						'--experimental-import-meta-resolve',
						path.join(directory, `scanner-${scan}.mjs`),
						entries,
						path.join(evidence, 'worker-metafiles'),
					],
					cwd: directory,
					label: `graph-${scan}`,
					evidence,
				}),
		),
	);
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
	if (graphs.some((graph) => graph.code !== 0) || declarations.code !== 0 || runtime.code !== 0)
		throw new Error('Packed closure or blocked-loader consumer failed');
}

export async function verifyToolEngineClosure(): Promise<void> {
	await assertToolEngineSourceIsPortable();
	const scratch = await mkdtemp(path.join(tmpdir(), '2026-10-s2-closure-'));
	const evidence = path.resolve(argument('--evidence-dir') ?? path.join(scratch, 'evidence'));
	await mkdir(evidence, { recursive: true });
	process.stdout.write(`packed closure scratch: ${scratch}\nevidence: ${evidence}\n`);
	const tarball = path.join(scratch, 'tool-engine.tgz');
	const pack = await command({
		executable: 'pnpm',
		args: [
			'--config.ignore-scripts=true',
			'--dir',
			path.join(repositoryRoot, 'packages/tool-engine'),
			'pack',
			'--out',
			tarball,
		],
		cwd: repositoryRoot,
		label: 'pack',
		evidence,
	});
	if (pack.code !== 0) throw new Error('tool-engine pack failed');
	const dependencyOverrides = await Promise.all(
		['tool-access', 'oauth-broker-contracts'].map(
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
					name === 'tool-access'
						? '@agent-collaboration/tool-access'
						: '@agent-vm/oauth-broker-contracts',
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
				'@agent-collaboration/tool-engine': `file:${tarball}`,
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
		args: ['install', '--ignore-scripts'],
		cwd: scratch,
		label: 'install-packed',
		evidence,
	});
	if (install.code !== 0) throw new Error('Packed consumer installation failed');
	const root = await realpath(path.join(scratch, 'node_modules/@agent-collaboration/tool-engine'));
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
	await writeFile(path.join(scratch, 'loader.mjs'), loaderSource());
	const bundler = await resolveWorkerClosureBundler(repositoryRoot);
	await Promise.all(
		(['first-party', 'worker'] as const).map(async (scan): Promise<void> => {
			await writeFile(
				path.join(scratch, `scanner-${scan}.mjs`),
				portalPackageClosureScannerSource({
					scan,
					packageLabel: 'tool-engine',
					forbiddenImportSource: isForbiddenToolEngineImport.toString(),
					repositoryRoot,
					typescriptUrl: import.meta.resolve('typescript'),
					esbuildUrl: bundler.esbuildUrl,
					bundlerProvenance: bundler,
				}),
			);
		}),
	);
	await writeFile(path.join(scratch, 'declaration-scanner.mjs'), declarationScannerSource());
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
		await preparePortalPackageClosureFixtures(root);
		await subpaths.reduce<Promise<void>>(async (previous, subpath): Promise<void> => {
			await previous;
			const entryDirectory = path.join(root, 'dist', subpath.slice(2));
			const fixturePrefix = subpath.slice(2) + '-';
			const contract = path.join(entryDirectory, 'index.js');
			const declaration = path.join(entryDirectory, 'index.d.ts');
			const original = await readFile(contract, 'utf8');
			const originalDeclaration = await readFile(declaration, 'utf8');
			const fixtureSources = portalPackageClosureFixtures(original);
			await writeFile(
				path.join(entryDirectory, 's2-transitive-poison.js'),
				"export async function lazyPoison() { return import('node:fs'); }\n",
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
					if (
						red.code === 0 ||
						!red.output.includes(fixture.reason) ||
						(fixture.scanReason !== undefined && !red.output.includes(fixture.scanReason))
					)
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
	}
	process.stdout.write(`tool-engine packed closure: passed (${subpaths.length} entrypoints)\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	try {
		const installed = argument('--installed');
		if (installed === undefined) await verifyToolEngineClosure();
		else await installedCheck(installed);
	} catch (error) {
		process.stderr.write(`${String(error)}\n`);
		process.exitCode = 1;
	}
}
