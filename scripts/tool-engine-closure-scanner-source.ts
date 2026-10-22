import { builtinModules } from 'node:module';

import { isForbiddenToolEngineImport } from './audit-portal-architecture.ts';

export type ToolEngineClosureScan = 'first-party' | 'worker';

/** Generate each isolated scanner so Node's resolution cache cannot cross the two policies. */
export function toolEngineClosureScannerSource(props: {
	readonly repositoryRoot: string;
	readonly scan: ToolEngineClosureScan;
	readonly esbuildUrl: string;
	readonly typescriptUrl: string;
}): string {
	if (props.scan === 'worker') return workerBundlerSource(props.esbuildUrl);
	return `import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import ts from ${JSON.stringify(props.typescriptUrl)};
const scan = ${JSON.stringify(props.scan)};
const portableBuiltinNames = new Set(${JSON.stringify(builtinModules.map((name) => name.replace(/^node:/u, '')))});
${isForbiddenToolEngineImport.toString()}
function resolveImport(specifier, location, kind) {
 return kind === 'require' ? pathToFileURL(createRequire(location).resolve(specifier)).href : import.meta.resolve(specifier, pathToFileURL(location).href);
}
const packageOwners = new Map();
async function isFirstParty(location) {
 let directory = path.dirname(location); const searched = [];
 while (true) {
  if (packageOwners.has(directory)) {
   const result = packageOwners.get(directory); for (const item of searched) packageOwners.set(item, result); return result;
  }
  searched.push(directory);
  try {
   const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
   const result = typeof manifest.name === 'string' && manifest.name.startsWith('@agent-collaboration/');
   for (const item of searched) packageOwners.set(item, result); return result;
  } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
  const parent = path.dirname(directory); if (parent === directory) throw new Error('No owning package: ' + location); directory = parent;
 }
}
const pending = JSON.parse(process.argv[2]); const visited = new Set(); let edges = 0;
while (pending.length) {
 const location = await realpath(pending.pop()); if (visited.has(location)) continue;
 if (!await isFirstParty(location)) continue;
 visited.add(location);
 if (isForbiddenToolEngineImport(pathToFileURL(location).href)) throw new Error('tool-engine forbidden resolved path ' + location + ' [' + scan + ' scan]');
 if (location.startsWith(${JSON.stringify(props.repositoryRoot)} + '/')) throw new Error('tool-engine workspace fallback ' + location);
 const text = await readFile(location, 'utf8'); if (location.endsWith('.json')) continue;
 const source = ts.createSourceFile(location, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS); const imports = [];
 function visit(node) {
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) imports.push({specifier: node.moduleSpecifier.text, kind: 'import'});
  if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
   if (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0])) throw new Error('tool-engine nonliteral import cannot be closed: ' + location);
   imports.push({specifier: node.arguments[0].text, kind: node.expression.kind === ts.SyntaxKind.ImportKeyword ? 'import' : 'require'});
  }
  ts.forEachChild(node, visit);
 }
 visit(source);
 for (const {specifier, kind} of imports) {
  if (isForbiddenToolEngineImport(specifier)) throw new Error('tool-engine forbidden import ' + specifier + ' from ' + location + ' [' + scan + ' scan]');
  const resolved = resolveImport(specifier, location, kind); edges++;
  if (isForbiddenToolEngineImport(resolved)) throw new Error('tool-engine forbidden resolved path ' + resolved + ' [' + scan + ' scan]');
  if (!resolved.startsWith('file:')) throw new Error('tool-engine non-file dependency ' + resolved);
  const dependency = fileURLToPath(resolved);
  if (await isFirstParty(dependency)) pending.push(dependency);
 }
}
if (visited.size === 0) throw new Error('empty closure');
console.log(scan + ' emitted import closure: ' + visited.size + ' modules, ' + edges + ' static/lazy edges; no forbidden imports');
`;
}

/** Use the actual mirrored Wrangler resolver, including browser main-field remapping. */
function workerBundlerSource(esbuildUrl: string): string {
	return `import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build, version, stop } from ${JSON.stringify(esbuildUrl)};
const portableBuiltinNames = new Set(${JSON.stringify(builtinModules.map((name) => name.replace(/^node:/u, '')))});
${isForbiddenToolEngineImport.toString()}
// Wrangler 4.124.0: wrangler-dist/cli.js:252816-252834,252997; its published manifest pins esbuild 0.28.1.
// Mirror bundleWorker's unset platform and default mainFields, not only its export conditions.
const workerConditions = ['workerd', 'worker', 'browser'];
const workerPlatform = undefined;
const workerMainFields = undefined;
const mirroredEsbuildVersion = '0.28.1';
if (version !== mirroredEsbuildVersion) throw new Error('Worker closure esbuild version drift: ' + version);
const entries = JSON.parse(process.argv[2]);
const evidence = process.argv[3];
await mkdir(evidence, { recursive: true });
const deniedImports = []; const resolveErrors = []; const inputs = new Set(); let edges = 0;
try {
 for (const [index, entry] of entries.entries()) {
  try {
   const result = await build({
    entryPoints: [entry], bundle: true, format: 'esm', write: false, metafile: true,
    conditions: workerConditions, platform: workerPlatform, mainFields: workerMainFields,
    logLevel: 'silent',
    plugins: [{name: 'tool-engine-worker-import-policy', setup(context) {
     context.onResolve({filter: /.*/}, (args) => {
      if (isForbiddenToolEngineImport(args.path)) {
       deniedImports.push({specifier: args.path, importer: args.importer || entry});
       return {path: args.path, external: true};
      }
     });
    }}],
   });
   await writeFile(path.join(evidence, index + '.metafile.json'), JSON.stringify(result.metafile, null, 2));
   for (const [location, data] of Object.entries(result.metafile.inputs)) { inputs.add(location); edges += data.imports.length; }
  } catch (error) { resolveErrors.push({entry, error: error instanceof Error ? error.message : String(error)}); }
 }
} finally { stop(); }
await writeFile(path.join(evidence, 'resolution.json'), JSON.stringify({wrangler: '4.124.0', esbuild: version, conditions: workerConditions, platform: 'unset', mainFields: 'default', entries, deniedImports, resolveErrors}, null, 2));
for (const denied of deniedImports) process.stderr.write('tool-engine forbidden import ' + denied.specifier + ' from ' + denied.importer + ' [worker scan]\\n');
for (const failure of resolveErrors) process.stderr.write(failure.error + '\\n');
if (deniedImports.length || resolveErrors.length) process.exitCode = 1;
else {
 if (!inputs.size) throw new Error('empty Worker closure');
 console.log('worker bundled closure: ' + inputs.size + ' modules, ' + edges + ' resolved edges; no forbidden imports');
}
`;
}
