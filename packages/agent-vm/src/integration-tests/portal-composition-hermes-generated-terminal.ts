import { spawn } from 'node:child_process';

const generatedTerminalMcpFactoryName = 'bindUpstreamMockTools';
const generatedTerminalConfiguredCliFactoryName = 'bindPortalCompositionExecutionTools';

export const portalCompositionGeneratedTerminalResultMarker =
	'portal-composition-generated-terminal-complete';

interface GeneratedTerminalOrientationImport {
	readonly exportedFactoryName: string;
	readonly modulePath: string;
}

export interface PortalCompositionGeneratedTerminalProgram {
	readonly command: string;
	readonly orientationImports: {
		readonly configuredCli: GeneratedTerminalOrientationImport;
		readonly mcp: GeneratedTerminalOrientationImport;
	};
	readonly source: string;
}

function readGeneratedOrientationImports(
	modelInstructions: string,
): readonly GeneratedTerminalOrientationImport[] {
	return [
		...modelInstructions.matchAll(
			/^- import \{ ([A-Za-z_$][A-Za-z0-9_$]*) \} from '([^']+\.ts)';$/gmu,
		),
	].map(([, exportedFactoryName, modulePath]) => {
		if (exportedFactoryName === undefined || modulePath === undefined) {
			throw new Error('Hermes generated an incomplete TypeScript orientation import.');
		}
		return { exportedFactoryName, modulePath };
	});
}

function requireOrientationImport(
	imports: readonly GeneratedTerminalOrientationImport[],
	exportedFactoryName: string,
): GeneratedTerminalOrientationImport {
	const matches = imports.filter((entry) => entry.exportedFactoryName === exportedFactoryName);
	if (matches.length !== 1 || matches[0] === undefined) {
		throw new Error(
			`Hermes orientation did not contain exactly one generated import for ${exportedFactoryName}.`,
		);
	}
	if (
		!/^\/run\/agent-vm\/tool-portal-sdk\/[a-f0-9]{64}\/[a-z0-9-]+-[a-f0-9]{8}\.ts$/u.test(
			matches[0].modulePath,
		)
	) {
		throw new Error(
			`Hermes orientation contained an invalid generated module path for ${exportedFactoryName}.`,
		);
	}
	return matches[0];
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function buildPortalCompositionGeneratedTerminalProgram(options: {
	readonly modelInstructions: string;
}): PortalCompositionGeneratedTerminalProgram {
	const imports = readGeneratedOrientationImports(options.modelInstructions);
	const mcp = requireOrientationImport(imports, generatedTerminalMcpFactoryName);
	const configuredCli = requireOrientationImport(
		imports,
		generatedTerminalConfiguredCliFactoryName,
	);
	const source = [
		"import { readFile } from 'node:fs/promises';",
		"import path from 'node:path';",
		"import { connectToolPortal } from '@agent-vm/agent-portal-sdk';",
		`import { ${mcp.exportedFactoryName} } from ${JSON.stringify(mcp.modulePath)};`,
		`import { ${configuredCli.exportedFactoryName} } from ${JSON.stringify(configuredCli.modulePath)};`,
		`const orientationImports = ${JSON.stringify({ configuredCli, mcp })};`,
		'const manifestPath = process.env.AGENT_VM_TOOL_PORTAL_SDK_MANIFEST;',
		'if (!manifestPath) throw new Error("foreground terminal omitted the generated SDK manifest path");',
		'const manifest = JSON.parse(await readFile(manifestPath, "utf8"));',
		'for (const selectedImport of Object.values(orientationImports)) {',
		'  const namespace = manifest.namespaces.find((entry) => entry.exportedFactoryName === selectedImport.exportedFactoryName);',
		'  if (!namespace || path.join(path.dirname(manifestPath), namespace.modulePath) !== selectedImport.modulePath) throw new Error("orientation import did not match the published manifest");',
		'}',
		'function requireSingleSuccessfulEnvelope(result, label) {',
		'  if (!result.ok || result.items.length !== 1 || result.items[0].status !== "ok") throw new Error(label + " did not return one successful canonical envelope: " + JSON.stringify(result));',
		'  const outcome = result.items[0].outcome;',
		'  if (outcome.kind !== "completed" || outcome.certainty !== "proven" || outcome.completion !== "succeeded") throw new Error(label + " lost canonical outcome semantics");',
		'  return result.items[0];',
		'}',
		'const portal = await connectToolPortal();',
		`const upstreamMock = ${mcp.exportedFactoryName}(portal);`,
		`const portalCompositionExecution = ${configuredCli.exportedFactoryName}(portal);`,
		'try {',
		'  const dependentRead = await upstreamMock.readThing({ title: "generated-terminal-seed" });',
		'  const dependentReadItem = requireSingleSuccessfulEnvelope(dependentRead, "generated MCP read");',
		'  const returnedToolName = dependentReadItem.value.result.structuredContent.name;',
		'  const derivedValue = "generated-from-" + returnedToolName.replace("_", "-");',
		'  const [concurrentMcpWrite, concurrentConfiguredCli] = await Promise.all([',
		'    upstreamMock.writeThing({ title: derivedValue }),',
		'    portalCompositionExecution.writeToolVmEffect({ argv: ["write-tool-vm-effect", derivedValue], reason: "Generated foreground terminal composition proof" }),',
		'  ]);',
		'  requireSingleSuccessfulEnvelope(concurrentMcpWrite, "generated MCP write");',
		'  const configuredCliItem = requireSingleSuccessfulEnvelope(concurrentConfiguredCli, "generated configured CLI");',
		'  if (configuredCliItem.value.stdout !== "tool-vm:" + derivedValue) throw new Error("generated configured CLI returned an unexpected destination effect");',
		`  process.stdout.write(JSON.stringify({ marker: ${JSON.stringify(portalCompositionGeneratedTerminalResultMarker)}, manifestFingerprint: manifest.definitionFingerprint, orientationImports, dependentRead, derivedValue, concurrentMcpWrite, concurrentConfiguredCli }));`,
		'} finally {',
		'  await portal.close();',
		'}',
	].join('\n');
	return {
		command: `node --input-type=module --eval ${shellQuote(source)}`,
		orientationImports: { configuredCli, mcp },
		source,
	};
}

export async function validatePortalCompositionGeneratedTerminalProgramSyntax(
	program: PortalCompositionGeneratedTerminalProgram,
): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn(process.execPath, ['--input-type=module', '--check'], {
			stdio: ['pipe', 'pipe', 'pipe'],
			signal: AbortSignal.timeout(10_000),
		});
		const stderr: Buffer[] = [];
		child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
		child.once('error', reject);
		child.once('close', (exitCode) => {
			if (exitCode === 0) {
				resolve();
				return;
			}
			reject(
				new Error(
					`Generated foreground terminal syntax check failed: ${Buffer.concat(stderr).toString('utf8')}`,
				),
			);
		});
		child.stdin.end(program.source);
	});
}
