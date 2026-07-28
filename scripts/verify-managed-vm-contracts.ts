import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

export interface ManagedVmNegativeFixtureVerification {
	readonly fixtureName: string;
	readonly matchedExpectedDiagnostic: boolean;
}

export interface ManagedVmContractVerification {
	readonly negativeFixtures: readonly ManagedVmNegativeFixtureVerification[];
	readonly positiveDiagnostics: readonly string[];
}

interface CompileFixtureResult {
	readonly diagnostics: readonly string[];
	readonly exitCode: 0 | 1;
}

export interface ManagedVmPublicDeclarationSource {
	readonly content: string;
	readonly filePath: string;
	readonly packageName: string;
}

export interface ManagedVmPublicDeclarationFinding {
	readonly filePath: string;
	readonly forbiddenToken: string;
	readonly packageName: string;
}

const concreteAdapterPackageName = '@agent-vm/gondolin-vm-adapter';
const forbiddenPublicDeclarationTokens = [
	'@earendil-works/gondolin',
	'ManagedVmInstance',
	'PinnedRealFsRoot',
	'VirtualProvider',
	'getVmInstance',
	'nativeOptions',
	'backendData',
] as const;
const forbiddenIdentityDeclarationTokens = [
	'ManagedVmGuestOwnership',
	'ProjectedGuestIdentity',
	'createGuestIdentityProjectedProvider',
	'guestOwnership',
	'projected-guest-identity',
] as const;

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixtureRoot = path.join(repositoryRoot, 'scripts/fixtures/managed-vm-contracts');

function formatDiagnostic(diagnostic: ts.Diagnostic): string {
	return ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
}

function compileFixture(fixtureName: string): CompileFixtureResult {
	const tsconfigPath = path.join(fixtureRoot, fixtureName, 'tsconfig.json');
	const parsedConfig = ts.getParsedCommandLineOfConfigFile(
		tsconfigPath,
		{},
		{
			...ts.sys,
			onUnRecoverableConfigFileDiagnostic: () => {},
		},
	);
	if (!parsedConfig) {
		return { diagnostics: [`Could not parse ${tsconfigPath}`], exitCode: 1 };
	}
	const program = ts.createProgram({
		options: parsedConfig.options,
		rootNames: parsedConfig.fileNames,
	});
	const diagnostics = ts.getPreEmitDiagnostics(program).map(formatDiagnostic);
	return {
		diagnostics,
		exitCode: diagnostics.length === 0 ? 0 : 1,
	};
}

const negativeFixtureExpectations = [
	{
		expectedDiagnostics: ["Property 'images' does not exist on type 'ManagedVmFactory'"],
		fixtureName: 'aggregate-provider-consumer',
	},
	{
		expectedDiagnostics: [
			"Property 'backend' does not exist on type 'ManagedVmCreateRequest'",
			"Property 'opaque' does not exist on type 'ManagedVmCreateRequest'",
			'Type \'"backend-mount"\' is not assignable',
			'Type \'"overlay"\' does not satisfy',
			'Type \'"open"\' is not assignable',
		],
		fixtureName: 'closed-contract-variants',
	},
	{
		expectedDiagnostics: [
			"Property 'getVmInstance' does not exist on type 'ManagedVm'",
			"Property 'fs' does not exist on type 'ManagedVm'",
			"Property 'nativeOptions' does not exist on type 'ManagedVmCreateRequest'",
			"Property 'backendData' does not exist on type 'ManagedVmCreateRequest'",
			"Property 'fd' does not exist on type 'OwnedHostDirectory'",
			"Property 'hostPath' does not exist on type 'OwnedHostDirectory'",
		],
		fixtureName: 'native-escape-hatches',
	},
] as const;

export function auditManagedVmPublicDeclarations(
	sources: readonly ManagedVmPublicDeclarationSource[],
): readonly ManagedVmPublicDeclarationFinding[] {
	const findings: ManagedVmPublicDeclarationFinding[] = [];
	for (const source of sources) {
		for (const forbiddenToken of forbiddenIdentityDeclarationTokens) {
			if (source.content.includes(forbiddenToken)) {
				findings.push({
					filePath: source.filePath.replaceAll('\\', '/'),
					forbiddenToken,
					packageName: source.packageName,
				});
			}
		}
		if (source.packageName !== concreteAdapterPackageName) {
			for (const forbiddenToken of forbiddenPublicDeclarationTokens) {
				if (source.content.includes(forbiddenToken)) {
					findings.push({
						filePath: source.filePath.replaceAll('\\', '/'),
						forbiddenToken,
						packageName: source.packageName,
					});
				}
			}
		}
	}
	return findings.toSorted(
		(left, right) =>
			left.filePath.localeCompare(right.filePath) ||
			left.forbiddenToken.localeCompare(right.forbiddenToken),
	);
}

async function listDeclarationFiles(directoryPath: string): Promise<readonly string[]> {
	let entries;
	try {
		entries = await readdir(directoryPath, { withFileTypes: true });
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
			return [];
		}
		throw error;
	}
	return (
		await Promise.all(
			entries.map(async (entry): Promise<readonly string[]> => {
				const entryPath = path.join(directoryPath, entry.name);
				if (entry.isDirectory()) {
					return await listDeclarationFiles(entryPath);
				}
				return entry.isFile() && entry.name.endsWith('.d.ts') ? [entryPath] : [];
			}),
		)
	).flat();
}

export async function readManagedVmPublicDeclarations(
	repositoryDirectory: string,
): Promise<readonly ManagedVmPublicDeclarationSource[]> {
	const packagesDirectory = path.join(repositoryDirectory, 'packages');
	const packageEntries = await readdir(packagesDirectory, { withFileTypes: true });
	const packageSources = await Promise.all(
		packageEntries.map(
			async (packageEntry): Promise<readonly ManagedVmPublicDeclarationSource[]> => {
				if (!packageEntry.isDirectory()) {
					return [];
				}
				const packageDirectory = path.join(packagesDirectory, packageEntry.name);
				let manifestContent: string;
				try {
					manifestContent = await readFile(path.join(packageDirectory, 'package.json'), 'utf8');
				} catch (error) {
					if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
						return [];
					}
					throw error;
				}
				const manifest: unknown = JSON.parse(manifestContent);
				if (
					typeof manifest !== 'object' ||
					manifest === null ||
					!('name' in manifest) ||
					typeof manifest.name !== 'string'
				) {
					throw new Error(`Package manifest has no name: ${packageEntry.name}`);
				}
				const declarationFiles = await listDeclarationFiles(path.join(packageDirectory, 'dist'));
				return await Promise.all(
					declarationFiles.map(
						async (declarationFile): Promise<ManagedVmPublicDeclarationSource> => ({
							content: await readFile(declarationFile, 'utf8'),
							filePath: path.relative(repositoryDirectory, declarationFile).replaceAll('\\', '/'),
							packageName: manifest.name,
						}),
					),
				);
			},
		),
	);
	return packageSources.flat();
}

async function rebuildWorkspace(repositoryDirectory: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn('pnpm', ['--recursive', 'run', 'build'], {
			cwd: repositoryDirectory,
			stdio: 'inherit',
		});
		child.once('error', reject);
		child.once('exit', (exitCode, signal) => {
			if (exitCode === 0) {
				resolve();
				return;
			}
			reject(
				new Error(
					`workspace declaration rebuild failed with ${signal === null ? `exit ${String(exitCode)}` : `signal ${signal}`}`,
				),
			);
		});
	});
}

export function verifyManagedVmContracts(): ManagedVmContractVerification {
	const positiveResult = compileFixture('positive-provider');
	const negativeFixtures = negativeFixtureExpectations.map(
		({ expectedDiagnostics, fixtureName }): ManagedVmNegativeFixtureVerification => {
			const result = compileFixture(fixtureName);
			return {
				fixtureName,
				matchedExpectedDiagnostic:
					result.exitCode === 1 &&
					expectedDiagnostics.every((expectedDiagnostic) =>
						result.diagnostics.some((diagnostic) => diagnostic.includes(expectedDiagnostic)),
					),
			};
		},
	);
	return {
		negativeFixtures,
		positiveDiagnostics: positiveResult.diagnostics,
	};
}

export function shouldRebuildManagedVmContractWorkspace(arguments_: readonly string[]): boolean {
	return !arguments_.includes('--skip-workspace-build');
}

async function runManagedVmContractVerifier(): Promise<void> {
	if (shouldRebuildManagedVmContractWorkspace(process.argv.slice(2))) {
		await rebuildWorkspace(repositoryRoot);
	}
	const verification = verifyManagedVmContracts();
	const declarationFindings = auditManagedVmPublicDeclarations(
		await readManagedVmPublicDeclarations(repositoryRoot),
	);
	const failedNegativeFixtures = verification.negativeFixtures.filter(
		(fixture) => !fixture.matchedExpectedDiagnostic,
	);
	if (
		verification.positiveDiagnostics.length > 0 ||
		failedNegativeFixtures.length > 0 ||
		declarationFindings.length > 0
	) {
		process.stderr.write('managed-vm contract verification failed\n');
		for (const diagnostic of verification.positiveDiagnostics) {
			process.stderr.write(`positive-provider: ${diagnostic}\n`);
		}
		for (const fixture of failedNegativeFixtures) {
			process.stderr.write(`${fixture.fixtureName}: expected compile rejection was not observed\n`);
		}
		for (const finding of declarationFindings) {
			process.stderr.write(
				`${finding.filePath}: ${finding.packageName} exposes forbidden '${finding.forbiddenToken}'\n`,
			);
		}
		process.exitCode = 1;
		return;
	}
	process.stdout.write(
		'managed-vm contract verification passed: 1 positive, 3 negative fixtures, public declarations neutral\n',
	);
}

const invokedScriptPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedScriptPath === fileURLToPath(import.meta.url)) {
	await runManagedVmContractVerifier();
}
