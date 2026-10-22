import { builtinModules } from 'node:module';

import { isForbiddenToolEngineImport } from './audit-portal-architecture.ts';

export type ToolEngineClosureScan = 'first-party' | 'worker';

/** Generate each isolated scanner so Node's resolution cache cannot cross the two policies. */
export function toolEngineClosureScannerSource(props: {
	readonly repositoryRoot: string;
	readonly scan: ToolEngineClosureScan;
	readonly typescriptUrl: string;
}): string {
	return `import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire, registerHooks } from 'node:module';
import ts from ${JSON.stringify(props.typescriptUrl)};
const scan = ${JSON.stringify(props.scan)};
const portableBuiltinNames = new Set(${JSON.stringify(builtinModules.map((name) => name.replace(/^node:/u, '')))});
${isForbiddenToolEngineImport.toString()}
// Wrangler 4.124.0 bundleWorker/getBuildConditions, packages/wrangler/src/deployment-bundle/bundle.ts:
// https://github.com/cloudflare/workers-sdk/blob/wrangler%404.124.0/packages/wrangler/src/deployment-bundle/bundle.ts
// Installed wrangler-dist/cli.js:252816-252821,252997. Keep Node's implicit condition out.
const workerConditions = ['workerd', 'worker', 'browser'];
let resolutionKind = 'import';
if (scan === 'worker') registerHooks({ resolve(specifier, context, nextResolve) {
 return nextResolve(specifier, { ...context, conditions: [...workerConditions, resolutionKind] });
}});
function resolveImport(specifier, location, kind) {
 if (scan === 'first-party') return kind === 'require'
  ? pathToFileURL(createRequire(location).resolve(specifier)).href
  : import.meta.resolve(specifier, pathToFileURL(location).href);
 resolutionKind = kind;
 // import.meta.resolve caches by parent/specifier. Distinguish import/require export branches.
 const parent = pathToFileURL(location); parent.searchParams.set('closure-kind', kind);
 return import.meta.resolve(specifier, parent.href);
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
 if (scan === 'first-party' && !await isFirstParty(location)) continue;
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
  if (scan === 'worker' || await isFirstParty(dependency)) pending.push(dependency);
 }
}
if (visited.size === 0) throw new Error('empty closure');
console.log(scan + ' emitted import closure: ' + visited.size + ' modules, ' + edges + ' static/lazy edges; no forbidden imports');
`;
}
