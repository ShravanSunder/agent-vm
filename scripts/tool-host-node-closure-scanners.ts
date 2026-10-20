import { builtinModules } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { isForbiddenToolHostNodeImport } from './tool-host-node-architecture.ts';
export function loaderSource(repositoryRoot: string): string {
	return `import { registerHooks } from 'node:module';
const portableBuiltinNames = new Set(${JSON.stringify(builtinModules.map((name) => name.replace(/^node:/u, '')))});
${isForbiddenToolHostNodeImport.toString()}
registerHooks({resolve(specifier, context, nextResolve) {
 if (isForbiddenToolHostNodeImport(specifier)) throw new Error('tool-host-node forbidden import ' + specifier);
 const resolved=nextResolve(specifier,context);
 if(resolved.url.startsWith(${JSON.stringify(pathToFileURL(repositoryRoot + path.sep).href)}))throw new Error('tool-host-node runtime workspace fallback '+resolved.url);
 if (isForbiddenToolHostNodeImport(resolved.url)) throw new Error('tool-host-node forbidden resolved path ' + resolved.url);
 return resolved;
}});
`;
}

export function scannerSource(repositoryRoot: string): string {
	return `import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {createRequire} from 'node:module';
import ts from ${JSON.stringify(import.meta.resolve('typescript'))};
const portableBuiltinNames = new Set(${JSON.stringify(builtinModules.map((name) => name.replace(/^node:/u, '')))});
${isForbiddenToolHostNodeImport.toString()}
const pending=JSON.parse(process.argv[2]); const visited=new Set(); let edges=0;
while(pending.length) {
 const location=await realpath(pending.pop()); if(visited.has(location))continue; visited.add(location);
 if(isForbiddenToolHostNodeImport(pathToFileURL(location).href))throw new Error('tool-host-node forbidden resolved path '+location);
 if(location.startsWith(${JSON.stringify(repositoryRoot)}+'/'))throw new Error('tool-host-node workspace fallback '+location);
 const text=await readFile(location,'utf8');
 if(location.endsWith('.json'))continue;
 const source=ts.createSourceFile(location,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS); const imports=[];
 function visit(node) {
  if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier)imports.push({specifier:node.moduleSpecifier.text,kind:"import"});
  if(ts.isCallExpression(node)&&(node.expression.kind===ts.SyntaxKind.ImportKeyword||(ts.isIdentifier(node.expression)&&node.expression.text==='require'))) {
   if(node.arguments.length!==1||!ts.isStringLiteral(node.arguments[0])){if(location.includes('/@agent-collaboration/tool-host-node/dist/'))throw new Error('tool-host-node nonliteral own import cannot be closed: '+location);console.log('third-party computed loader statically unenumerated; installed inventory and runtime hook apply: '+location);ts.forEachChild(node,visit);return;}
   imports.push({specifier:node.arguments[0].text,kind:node.expression.kind===ts.SyntaxKind.ImportKeyword?"import":"require"});
  }
  ts.forEachChild(node,visit);
 }
 visit(source);
 for(const {specifier,kind} of imports) {
  if(isForbiddenToolHostNodeImport(specifier))throw new Error('tool-host-node forbidden import '+specifier+' from '+location);
  if(specifier.startsWith('node:')||portableBuiltinNames.has(specifier))continue;
  let resolved;try{resolved=kind==='require'?pathToFileURL(createRequire(location).resolve(specifier)).href:import.meta.resolve(specifier,pathToFileURL(location).href);}catch(error){if(error.code==='MODULE_NOT_FOUND'&&!location.includes('/@agent-collaboration/tool-host-node/dist/')){console.log('uninstalled optional literal dependency: '+specifier+' from '+location);continue;}throw error;}edges++;
  if(isForbiddenToolHostNodeImport(resolved))throw new Error('tool-host-node forbidden resolved path '+resolved);
  if(resolved.startsWith('node:'))continue;
  if(!resolved.startsWith('file:'))throw new Error('tool-host-node non-file dependency '+resolved);
  pending.push(fileURLToPath(resolved));
 }
}
if(visited.size===0)throw new Error('empty closure');
console.log('emitted import closure: '+visited.size+' modules, '+edges+' static/lazy edges; no forbidden imports');
`;
}

export function declarationScannerSource(repositoryRoot: string): string {
	return `import {readFile,realpath} from 'node:fs/promises';
import {builtinModules} from 'node:module';
import {pathToFileURL} from 'node:url';
import ts from ${JSON.stringify(import.meta.resolve('typescript'))};
const portableBuiltinNames=new Set(builtinModules.map(name=>name.replace(/^node:/u,'')));
${isForbiddenToolHostNodeImport.toString()}
const pending=JSON.parse(process.argv[2]); const visited=new Set();let edges=0;
while(pending.length){
 const location=await realpath(pending.pop());if(visited.has(location))continue;visited.add(location);
 if(location.startsWith(${JSON.stringify(repositoryRoot)}+'/'))throw new Error('tool-host-node declaration workspace fallback '+location);
 const source=ts.createSourceFile(location,await readFile(location,'utf8'),ts.ScriptTarget.Latest,true); const imports=[];
 
 function visit(node){
 if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier&&ts.isStringLiteral(node.moduleSpecifier))imports.push(node.moduleSpecifier.text);
 if(ts.isImportTypeNode(node)&&ts.isLiteralTypeNode(node.argument)&&ts.isStringLiteral(node.argument.literal))imports.push(node.argument.literal.text);
 if(ts.isImportEqualsDeclaration(node)&&ts.isExternalModuleReference(node.moduleReference)&&node.moduleReference.expression&&ts.isStringLiteral(node.moduleReference.expression))imports.push(node.moduleReference.expression.text);
 if(ts.isIdentifier(node)&&node.text.startsWith('GatewayRuntime'))throw new Error('tool-host-node managed type '+node.text);
 ts.forEachChild(node,visit);
 }visit(source);
 for(const specifier of imports){
 if(specifier.startsWith('node:')||portableBuiltinNames.has(specifier))continue;
 if(isForbiddenToolHostNodeImport(specifier))throw new Error('tool-host-node forbidden import '+specifier+' from '+location);
 const options={module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext};
 const mode=ts.getImpliedNodeFormatForFile(location,undefined,ts.sys,options);
 const resolved=ts.resolveModuleName(specifier,location,options,ts.sys,undefined,undefined,mode).resolvedModule;
 if(!resolved)throw new Error('tool-host-node unresolved declaration '+specifier+' from '+location);
 if(isForbiddenToolHostNodeImport(pathToFileURL(resolved.resolvedFileName).href))throw new Error('tool-host-node forbidden resolved declaration '+resolved.resolvedFileName);
 pending.push(resolved.resolvedFileName);edges++;
 }
}
if(visited.size===0)throw new Error('empty declaration closure');console.log('declaration import closure: '+visited.size+' modules, '+edges+' type edges');
`;
}
