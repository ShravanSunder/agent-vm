import path from 'node:path';

import ts from 'typescript';

export interface GatewayLifecycleNegativeFixtureVerification {
	readonly fixtureName: string;
	readonly matchedExpectedDiagnostic: boolean;
}

export interface GatewayLifecycleContractVerification {
	readonly negativeFixtures: readonly GatewayLifecycleNegativeFixtureVerification[];
	readonly positiveDiagnostics: readonly string[];
	readonly positiveFixtureUsesForbiddenGatewaySpecificSurface: boolean;
}

interface CompileFixtureResult {
	readonly diagnostics: readonly ts.Diagnostic[];
	readonly formattedDiagnostics: readonly string[];
}

const packageRoot = path.resolve(import.meta.dirname, '..');
const fixtureRoot = path.join(packageRoot, 'contract-fixtures');
const positiveFixtureName = 'python-guest-gateway-lifecycle';
const forbiddenPositiveFixtureSurfacePattern =
	/composeNodeOptions|FORCE_IPV4_EGRESS_NODE_OPTIONS|OpenClaw|authProfilesByAgent|rawEnvSecrets|controlAuth/u;

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
		return {
			diagnostics: [],
			formattedDiagnostics: [`Could not parse ${tsconfigPath}`],
		};
	}
	const program = ts.createProgram({
		options: parsedConfig.options,
		rootNames: parsedConfig.fileNames,
	});
	const diagnostics = ts.getPreEmitDiagnostics(program);
	return {
		diagnostics,
		formattedDiagnostics: diagnostics.map(formatDiagnostic),
	};
}

const negativeFixtureExpectations = [
	{
		expectedPackageName: '@agent-vm/gondolin-adapter',
		fixtureName: 'concrete-adapter-import',
	},
	{
		expectedPackageName: '@agent-vm/gateway-interface',
		fixtureName: 'old-package-import',
	},
] as const;

export function verifyGatewayLifecycleContracts(): GatewayLifecycleContractVerification {
	const positiveResult = compileFixture(positiveFixtureName);
	const positiveFixtureSource =
		ts.sys.readFile(path.join(fixtureRoot, positiveFixtureName, 'index.ts')) ?? '';
	const negativeFixtures = negativeFixtureExpectations.map(
		({ expectedPackageName, fixtureName }): GatewayLifecycleNegativeFixtureVerification => {
			const result = compileFixture(fixtureName);
			return {
				fixtureName,
				matchedExpectedDiagnostic:
					result.diagnostics.length > 0 &&
					result.diagnostics.some(
						(diagnostic) =>
							diagnostic.code === 2307 &&
							formatDiagnostic(diagnostic).includes(expectedPackageName),
					),
			};
		},
	);

	return {
		negativeFixtures,
		positiveDiagnostics: positiveResult.formattedDiagnostics,
		positiveFixtureUsesForbiddenGatewaySpecificSurface:
			forbiddenPositiveFixtureSurfacePattern.test(positiveFixtureSource),
	};
}
