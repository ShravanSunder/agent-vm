import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, realpath, copyFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import {
	collectAuthCoreViolations,
	isForbiddenAuthCoreImport,
	isForbiddenToolHostCoreImport,
} from './audit-portal-architecture.ts';
import { portalPackageClosureScannerSource } from './portal-package-closure-scanner-source.ts';
import { resolveWorkerClosureBundler } from './worker-closure-bundler.ts';

const repositoryRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));

export async function assertAuthCorePlainNodeExecution(entry: string): Promise<void> {
	const tracked = new Set([entry]);
	const hooks = registerHooks({
		resolve(specifier, context, nextResolve) {
			const belongsToCore = specifier === entry || tracked.has(context.parentURL ?? '');
			if (belongsToCore && isForbiddenAuthCoreImport(specifier))
				throw new Error(`Auth core loaded a runtime dependency: ${specifier}`);
			const resolved = nextResolve(specifier, context);
			if (belongsToCore) {
				if (isForbiddenAuthCoreImport(resolved.url))
					throw new Error(`Auth core loaded a runtime dependency: ${resolved.url}`);
				tracked.add(resolved.url);
			}
			return resolved;
		},
	});
	try {
		const core: unknown = await import(entry);
		if (typeof core !== 'object' || core === null || !('agentRegistrationAllowsToken' in core))
			throw new Error('Auth core module exports missing');
		const rule: unknown = core.agentRegistrationAllowsToken;
		if (!isCoreRegistrationRule(rule)) throw new Error('Auth core registration rule missing');
		const organizationId = '11111111-1111-4111-8111-111111111111';
		if (
			rule({
				registration: {
					clientId: 'plain-node-agent',
					metadata: { botId: '66666666-6666-4666-8666-666666666666', organizationId },
					grantTypes: ['client_credentials'],
					clientCredentialsScopes: ['tool-portal:agent'],
					tokenEndpointAuthMethod: 'client_secret_basic',

					disabled: false,
				},
				clientId: 'plain-node-agent',
				audience: 'https://portal.invalid/mcp',
				signedOrganizationId: organizationId,
			}) !== true
		)
			throw new Error('Auth core failed the plain Node reference policy');
	} finally {
		hooks.deregister();
	}
}

function isCoreRegistrationRule(
	value: unknown,
): value is (props: Readonly<Record<string, unknown>>) => unknown {
	return typeof value === 'function';
}

/** Packed proof runs through the existing export gate's --packed-auth lane after the workspace build. */
export async function verifyAuthPackageClosure(): Promise<void> {
	const scratch = await mkdtemp(path.join(tmpdir(), '2026-10-auth-package-closure-'));
	const evidence = path.join(scratch, 'evidence');
	await mkdir(evidence, { mode: 0o700 });
	async function command(
		executable: string,
		args: readonly string[],
		cwd: string,
		label: string,
	): Promise<void> {
		const result = spawnSync(executable, [...args], {
			cwd,
			encoding: 'utf8',
			timeout: 300_000,
			maxBuffer: 16 * 1024 * 1024,
		});
		await writeFile(
			path.join(evidence, label + '.log'),
			(result.stdout ?? '') + (result.stderr ?? '') + '\nEXIT_CODE=' + String(result.status ?? 1),
			{ mode: 0o600 },
		);
		if (result.status !== 0)
			throw new Error('Auth packed ' + label + ' failed; private evidence: ' + evidence);
	}
	const dependencies = await Promise.all(
		['auth', 'tool-access', 'oauth-broker-contracts'].map(async (name) => {
			const file = path.join(scratch, name + '.tgz');
			await command(
				'pnpm',
				[
					'--config.ignore-scripts=true',
					'--dir',
					path.join(repositoryRoot, 'packages', name),
					'pack',
					'--out',
					file,
				],
				repositoryRoot,
				'pack-' + name,
			);
			return [
				name === 'oauth-broker-contracts'
					? '@agent-vm/oauth-broker-contracts'
					: '@agent-collaboration/' + name,
				'file:' + file,
			] as const;
		}),
	);
	const overrides = Object.fromEntries(dependencies);
	await writeFile(
		path.join(scratch, 'package.json'),
		JSON.stringify({
			private: true,
			type: 'module',
			dependencies: { ...overrides, '@types/node': '25.6.2' },
			pnpm: { overrides },
		}),
		{ mode: 0o600 },
	);
	await writeFile(
		path.join(scratch, 'pnpm-workspace.yaml'),
		`packages:\n - '.'\noverrides:\n${Object.entries(overrides)
			.map(([name, location]) => ' ' + JSON.stringify(name) + ': ' + JSON.stringify(location))
			.join('\n')}\n`,
		{ mode: 0o600 },
	);
	await command('pnpm', ['install', '--ignore-scripts'], scratch, 'install');
	const authRoot = await realpath(path.join(scratch, 'node_modules/@agent-collaboration/auth'));
	if (authRoot.startsWith(repositoryRoot + path.sep))
		throw new Error('Packed auth resolved into workspace');
	const entry = path.join(authRoot, 'dist/sign-in-core/index.js');
	const forbiddenSource = `(specifier) => { const isForbiddenToolHostCoreImport = ${isForbiddenToolHostCoreImport.toString()}; return (${isForbiddenAuthCoreImport.toString()})(specifier); }`;
	const bundler = await resolveWorkerClosureBundler(repositoryRoot);
	await Promise.all(
		(['first-party', 'worker'] as const).map(async (scan) => {
			const scanner = path.join(scratch, 'scanner-' + scan + '.mjs');
			await writeFile(
				scanner,
				portalPackageClosureScannerSource({
					repositoryRoot,
					packageLabel: 'auth-core',
					forbiddenImportSource: forbiddenSource,
					scan,
					esbuildUrl: bundler.esbuildUrl,
					bundlerProvenance: bundler,
					typescriptUrl: import.meta.resolve('typescript'),
				}),
				{ mode: 0o600 },
			);
			await command(
				process.execPath,
				[
					'--experimental-import-meta-resolve',
					scanner,
					JSON.stringify([entry]),
					path.join(evidence, scan),
				],
				scratch,
				scan,
			);
		}),
	);
	const loader = `import { registerHooks, builtinModules } from 'node:module';
 const portableBuiltinNames = new Set(builtinModules.map(name => name.replace(/^node:/u, '')));
 const forbidden = ${forbiddenSource};
 registerHooks({ resolve(specifier, context, nextResolve) { if(forbidden(specifier)) throw new Error('auth-core forbidden import ' + specifier); const resolved = nextResolve(specifier,context); if(forbidden(resolved.url)) throw new Error('auth-core forbidden resolved import ' + resolved.url); return resolved; } });`;
	await writeFile(path.join(scratch, 'loader.mjs'), loader, { mode: 0o600 });
	await Promise.all(
		['core', 'cloudflare'].map((name) =>
			copyFile(
				path.join(
					repositoryRoot,
					'packages/auth/contract-fixtures/package-consumer',
					name + '-consumer.ts',
				),
				path.join(scratch, name + '-consumer.ts'),
			),
		),
	);
	await command(
		process.execPath,
		['--import', path.join(scratch, 'loader.mjs'), path.join(scratch, 'core-consumer.ts')],
		scratch,
		'plain-node-core',
	);
	await Promise.all(
		(['core', 'cloudflare'] as const).map(async (surface) => {
			const program = ts.createProgram([path.join(scratch, surface + '-consumer.ts')], {
				target: ts.ScriptTarget.ES2024,
				module: ts.ModuleKind.NodeNext,
				moduleResolution: ts.ModuleResolutionKind.NodeNext,
				strict: true,
				exactOptionalPropertyTypes: true,
				noEmit: true,
				skipLibCheck: surface === 'cloudflare',
				types: surface === 'core' ? [] : ['node'],
				typeRoots: [path.join(scratch, 'node_modules/@types')],
				lib: surface === 'core' ? ['lib.es2024.d.ts', 'lib.dom.d.ts'] : ['lib.es2024.d.ts'],
			});
			const diagnostics = ts.getPreEmitDiagnostics(program);
			await writeFile(
				path.join(evidence, surface + '-declarations.log'),
				ts.formatDiagnosticsWithColorAndContext(diagnostics, {
					getCanonicalFileName: (file) => file,
					getCurrentDirectory: () => scratch,
					getNewLine: () => '\n',
				}),
				{ mode: 0o600 },
			);
			if (diagnostics.length > 0)
				throw new Error(
					'Packed ' + surface + ' declaration consumer failed; private evidence: ' + evidence,
				);
			if (surface === 'core') {
				const closure = program
					.getSourceFiles()
					.filter((file) => file.fileName.startsWith(authRoot + path.sep));
				if (closure.length === 0) throw new Error('Empty packed core declaration closure');
				const violations = closure.flatMap((file) =>
					collectAuthCoreViolations({
						filePath: 'packages/auth/src/sign-in-core/' + path.basename(file.fileName),
						sourceText: file.text,
					}),
				);
				if (violations.length > 0) throw new Error(violations.join('\n'));
				await writeFile(
					path.join(evidence, 'core-declaration-graph.json'),
					JSON.stringify(closure.map((file) => file.fileName)),
					{ mode: 0o600 },
				);
			}
		}),
	);
	process.stdout.write(
		'auth packed core Node/Worker/declaration closure and Cloudflare declaration consumer passed; private evidence: ' +
			evidence +
			'\n',
	);
}
