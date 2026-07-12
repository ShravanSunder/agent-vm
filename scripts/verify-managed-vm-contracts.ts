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

function runManagedVmContractVerifier(): void {
	const verification = verifyManagedVmContracts();
	const failedNegativeFixtures = verification.negativeFixtures.filter(
		(fixture) => !fixture.matchedExpectedDiagnostic,
	);
	if (verification.positiveDiagnostics.length > 0 || failedNegativeFixtures.length > 0) {
		process.stderr.write('managed-vm contract verification failed\n');
		for (const diagnostic of verification.positiveDiagnostics) {
			process.stderr.write(`positive-provider: ${diagnostic}\n`);
		}
		for (const fixture of failedNegativeFixtures) {
			process.stderr.write(`${fixture.fixtureName}: expected compile rejection was not observed\n`);
		}
		process.exitCode = 1;
		return;
	}
	process.stdout.write(
		'managed-vm contract verification passed: 1 positive, 3 negative fixtures\n',
	);
}

const invokedScriptPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedScriptPath === fileURLToPath(import.meta.url)) {
	runManagedVmContractVerifier();
}
