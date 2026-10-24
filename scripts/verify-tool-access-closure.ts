import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, realpath, writeFile, mkdir, rename } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
	collectToolAccessViolations,
	isForbiddenToolAccessImport,
} from './audit-portal-architecture.ts';

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
	const temporary = `${location}.s1-change`;
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
			return collectToolAccessViolations({
				filePath: `packages/tool-access/src/contracts/${entry.name}`,
				sourceText: await readFile(location, 'utf8'),
			});
		}),
	);
	return results.flat();
}

function loaderSource(): string {
	return `import { registerHooks } from 'node:module';
const portableBuiltinNames = new Set(${JSON.stringify(builtinModules.map((name) => name.replace(/^node:/u, '')))});
${isForbiddenToolAccessImport.toString()}
registerHooks({resolve(specifier, context, nextResolve) {
 if (isForbiddenToolAccessImport(specifier)) throw new Error('tool-access forbidden import ' + specifier);
 const resolved=nextResolve(specifier,context);
 if (isForbiddenToolAccessImport(resolved.url)) throw new Error('tool-access forbidden resolved path ' + resolved.url);
 return resolved;
}});
`;
}

function scannerSource(): string {
	return `import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from ${JSON.stringify(import.meta.resolve('typescript'))};
const portableBuiltinNames = new Set(${JSON.stringify(builtinModules.map((name) => name.replace(/^node:/u, '')))});
${isForbiddenToolAccessImport.toString()}
const pending=JSON.parse(process.argv[2]); const visited=new Set(); let edges=0;
while(pending.length) {
 const location=await realpath(pending.pop()); if(visited.has(location))continue; visited.add(location);
 if(isForbiddenToolAccessImport(pathToFileURL(location).href))throw new Error('tool-access forbidden resolved path '+location);
 const text=await readFile(location,'utf8');
 if(location.endsWith('.json'))continue;
 const source=ts.createSourceFile(location,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS); const imports=[];
 function visit(node) {
  if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier)imports.push(node.moduleSpecifier.text);
  if(ts.isCallExpression(node)&&(node.expression.kind===ts.SyntaxKind.ImportKeyword||(ts.isIdentifier(node.expression)&&node.expression.text==='require'))) {
   if(node.arguments.length!==1||!ts.isStringLiteral(node.arguments[0]))throw new Error('tool-access nonliteral import cannot be closed: '+location);
   imports.push(node.arguments[0].text);
  }
  ts.forEachChild(node,visit);
 }
 visit(source);
 for(const specifier of imports) {
  if(isForbiddenToolAccessImport(specifier))throw new Error('tool-access forbidden import '+specifier+' from '+location);
  const resolved=import.meta.resolve(specifier,pathToFileURL(location).href); edges++;
  if(isForbiddenToolAccessImport(resolved))throw new Error('tool-access forbidden resolved path '+resolved);
  if(!resolved.startsWith('file:'))throw new Error('tool-access non-file dependency '+resolved);
  pending.push(fileURLToPath(resolved));
 }
}
if(visited.size===0)throw new Error('empty closure');
console.log('emitted import closure: '+visited.size+' modules, '+edges+' static/lazy edges; no forbidden imports');
`;
}

const requiredExports: Readonly<Record<string, readonly string[]>> = {
	'./contracts': [
		'hostAccessBinding',
		'accessFacts',
		'assessAccessInput',
		'accessAssessment',
		'assessAccessResult',
	],
	'./authorization': [
		'createAccessAssessor',
		'resolvePortalAccessPolicy',
		'mcpPortalCallPolicyDecision',
		'validateCliAllowanceInvocation',
		'resolveCompiledGoogleCommand',
	],
};

function consumerSource(subpaths: readonly string[]): string {
	return `const required=${JSON.stringify(requiredExports)};
const modules={};
for(const subpath of ${JSON.stringify(subpaths)}) {
 const specifier='@agent-collaboration/tool-access'+subpath.slice(1);
 const loaded=await import(specifier); modules[subpath]=loaded;
 for(const name of required[subpath]??[])if(!(name in loaded))throw new Error('missing named export '+specifier+'.'+name);
}
const contracts=modules['./contracts']; const authorization=modules['./authorization'];
const revision={owner:'packed-consumer',revision:'v1'};
const binding=contracts.hostAccessBinding.parse({workspaceLayer:'not-configured',config:revision});
const input=contracts.assessAccessInput.parse({capability:{namespace:'example',tool:'read'},surface:'mcp',call:{arguments:{},account:null,digest:'a'.repeat(64)},facts:{workspace:{kind:'not-configured'},assignment:{profile:{profileId:'packed',namespaces:{example:{backendKind:'mcp_provider',tools:{allow:'*',deny:[]},calls:{kind:'selectors',requiresApproval:{allow:[],deny:[]},withoutApproval:{allow:'*',deny:[]}},operations:{}}}},profileRevision:revision,revision},surface:{eligible:['mcp'],snapshot:revision},accounts:[],upstream:{status:'available',credentialNeed:'none',binding:revision}}});
const result=contracts.assessAccessResult.parse(authorization.createAccessAssessor(binding)(input));
if(result.kind!=='assessed'||result.assessment.kind!=='fixed'||result.assessment.state.kind!=='usable')throw new Error('packed assessment did not admit the control');
console.log('packed consumer: '+Object.keys(modules).length+' entrypoints imported; required named exports, schema parse and assessAccess usable passed');
`;
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
	const graph = await command({
		executable: process.execPath,
		args: ['--experimental-import-meta-resolve', path.join(directory, 'scanner.mjs'), entries],
		cwd: directory,
		label: 'graph',
		evidence,
	});
	const runtime = await command({
		executable: process.execPath,
		args: ['--import', path.join(directory, 'loader.mjs'), path.join(directory, 'consumer.mjs')],
		cwd: directory,
		label: 'consumer',
		evidence,
	});
	if (graph.code !== 0 || runtime.code !== 0)
		throw new Error('Packed closure or blocked-loader consumer failed');
}

export async function verifyToolAccessClosure(): Promise<void> {
	const scratch = await mkdtemp(path.join(tmpdir(), '2026-10-s1-closure-'));
	const evidence = path.resolve(argument('--evidence-dir') ?? path.join(scratch, 'evidence'));
	await mkdir(evidence, { recursive: true });
	process.stdout.write(`packed closure scratch: ${scratch}\nevidence: ${evidence}\n`);
	const tarball = path.join(scratch, 'tool-access.tgz');
	const pack = await command({
		executable: 'pnpm',
		args: ['--dir', path.join(repositoryRoot, 'packages/tool-access'), 'pack', '--out', tarball],
		cwd: repositoryRoot,
		label: 'pack',
		evidence,
	});
	if (pack.code !== 0) throw new Error('tool-access pack failed');
	await writeFile(
		path.join(scratch, 'package.json'),
		JSON.stringify({
			private: true,
			type: 'module',
			dependencies: { '@agent-collaboration/tool-access': `file:${tarball}` },
		}),
	);
	const install = await command({
		executable: 'pnpm',
		args: ['install', '--ignore-scripts'],
		cwd: scratch,
		label: 'install-packed',
		evidence,
	});
	if (install.code !== 0) throw new Error('Packed consumer installation failed');
	const root = await realpath(path.join(scratch, 'node_modules/@agent-collaboration/tool-access'));
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
	await writeFile(path.join(scratch, 'scanner.mjs'), scannerSource());
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
		const contract = path.join(root, 'dist/contracts/index.js');
		const declaration = path.join(root, 'dist/contracts/index.d.ts');
		const original = await readFile(contract, 'utf8');
		const originalDeclaration = await readFile(declaration, 'utf8');
		const fixtureSources = [
			{
				name: 'direct',
				source: `${original}\nimport 'node:fs';`,
				reason: 'tool-access forbidden import node:fs',
			},
			{
				name: 'transitive',
				source: `${original}\nexport * from './s1-transitive-poison.js';`,
				reason: 'tool-access forbidden import node:fs',
			},
			{
				name: 'host',
				source: `${original}\nimport '@agent-collaboration/tool-host-node';`,
				reason: 'tool-access forbidden import @agent-collaboration/tool-host-node',
			},
			{
				name: 'execution',
				source: original,
				reason: 'tool-access execution-bearing contract field target',
			},
		];
		await writeFile(
			path.join(root, 'dist/contracts/s1-transitive-poison.js'),
			"export async function lazyPoison() { return import('node:fs'); }\n",
		);
		await fixtureSources.reduce<Promise<void>>(async (previous, fixture): Promise<void> => {
			await previous;
			try {
				await replaceArtifact(contract, fixture.source);
				if (fixture.name === 'execution')
					await replaceArtifact(
						declaration,
						`${originalDeclaration}\nexport interface ExecutionPoison { target: string }\n`,
					);
				const red = await check(`${fixture.name}-red`);
				if (red.code === 0 || !red.output.includes(fixture.reason))
					throw new Error(`Fixture ${fixture.name} did not fail for its intended reason`);
			} finally {
				await replaceArtifact(contract, original);
				await replaceArtifact(declaration, originalDeclaration);
			}
			const green = await check(`${fixture.name}-green`);
			if (green.code !== 0) throw new Error(`Fixture ${fixture.name} restoration failed`);
		}, Promise.resolve());
		process.stdout.write('sensitivity: 4 intended rejections, 4 restored passes\n');
	}
	process.stdout.write(`tool-access packed closure: passed (${subpaths.length} entrypoints)\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	try {
		const installed = argument('--installed');
		if (installed === undefined) await verifyToolAccessClosure();
		else await installedCheck(installed);
	} catch (error) {
		process.stderr.write(`${String(error)}\n`);
		process.exitCode = 1;
	}
}
