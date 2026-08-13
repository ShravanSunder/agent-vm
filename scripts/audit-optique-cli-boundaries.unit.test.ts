import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
	auditOptiqueCliBoundaries,
	type OptiqueCliBoundaryInventoryEntry,
} from './audit-optique-cli-boundaries.js';

const createdDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		createdDirectories
			.splice(0)
			.map(async (directoryPath) => await rm(directoryPath, { force: true, recursive: true })),
	);
});

interface FixtureFile {
	readonly content: string;
	readonly relativePath: string;
}

async function auditFixture(
	files: readonly FixtureFile[],
	entryOverrides: Partial<OptiqueCliBoundaryInventoryEntry> = {},
): Promise<readonly string[]> {
	const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), 'optique-cli-audit-'));
	createdDirectories.push(repositoryRoot);
	await Promise.all(
		files.map(async (file) => {
			const filePath = path.join(repositoryRoot, file.relativePath);
			await mkdir(path.dirname(filePath), { recursive: true });
			await writeFile(filePath, file.content, 'utf8');
		}),
	);
	const inventory = [
		{
			commandTypeAlias: 'FixtureCommand',
			executableName: 'fixture-cli',
			executableRoot: 'packages/fixture/src/bin/fixture-cli.ts',
			parserFiles: ['packages/fixture/src/cli/fixture-cli-parser.ts'],
			rootParserName: 'fixtureRootParser',
			valueBearing: true,
			...entryOverrides,
		},
	] satisfies readonly OptiqueCliBoundaryInventoryEntry[];
	const findings = await auditOptiqueCliBoundaries({ inventory, repositoryRoot });
	return findings.map((finding) => `${finding.filePath}:${String(finding.line)} ${finding.reason}`);
}

const admittedRoot = `
import { run } from '@optique/run';
import { fixtureRootParser } from '../cli/fixture-cli-parser.js';
const command = await run(fixtureRootParser, { help: 'both' });
void command;
`;

const admittedParser = `
import { type InferValue, multiple, option, optional, withDefault } from '@optique/core';
import { zod } from '@optique/zod';
import { z, ZodArray, ZodDefault, ZodOptional } from 'zod';
export const fixtureRootParser = option('--name', zod(z.string(), { placeholder: '' }));
export type FixtureCommand = InferValue<typeof fixtureRootParser>;
export function projectZodScalarPresence(value: unknown): unknown {
	if (value instanceof ZodOptional) return optional(fixtureRootParser);
	if (value instanceof ZodDefault) return withDefault(fixtureRootParser, value.parse(undefined));
	return fixtureRootParser;
}
export function projectZodRepeatedOption(value: ZodDefault<ZodArray>): unknown {
	return optional(multiple(fixtureRootParser, { min: 1 }));
}
`;

describe('Optique CLI architecture audit', () => {
	it('accepts the direct runner, exact inferred alias, and admitted projection owners', async () => {
		// Arrange / Act
		const findings = await auditFixture([
			{ content: admittedRoot, relativePath: 'packages/fixture/src/bin/fixture-cli.ts' },
			{ content: admittedParser, relativePath: 'packages/fixture/src/cli/fixture-cli-parser.ts' },
		]);

		// Assert
		expect(findings).toEqual([]);
	});

	it('rejects a repeated projection that lets Optique synthesize an empty collection', async () => {
		// Arrange
		const projectionWithoutMinimum = admittedParser.replace(
			'multiple(fixtureRootParser, { min: 1 })',
			'multiple(fixtureRootParser)',
		);

		// Act
		const findings = await auditFixture([
			{ content: admittedRoot, relativePath: 'packages/fixture/src/bin/fixture-cli.ts' },
			{
				content: projectionWithoutMinimum,
				relativePath: 'packages/fixture/src/cli/fixture-cli-parser.ts',
			},
		]);

		// Assert
		expect(findings.join('\n')).toMatch(/preserve absence with min: 1/u);
	});

	it('rejects recreated Zod schema expressions inside a scalar projection', async () => {
		// Arrange
		const parser = `${admittedParser}\nconst optionalNameSchema = z.string().optional();\nconst projectedName = projectZodScalarPresence(optionalNameSchema.optional(), option('--projected-name', zod(optionalNameSchema.optional(), { placeholder: '' })));\nvoid projectedName;`;

		// Act
		const findings = await auditFixture([
			{ content: admittedRoot, relativePath: 'packages/fixture/src/bin/fixture-cli.ts' },
			{ content: parser, relativePath: 'packages/fixture/src/cli/fixture-cli-parser.ts' },
		]);

		// Assert
		expect(findings.join('\n')).toMatch(/exact named Zod schema object/u);
	});

	it('rejects a repeated projection whose element parser uses a different array schema', async () => {
		// Arrange
		const parser = `${admittedParser}
const repeatedNameSchema = z.array(z.string()).default([]);
const differentRepeatedNameSchema = z.array(z.string()).default([]);
const projectedNames = projectZodRepeatedOption({
	schema: repeatedNameSchema,
	parser: option('--name', zod(differentRepeatedNameSchema.unwrap().element, { placeholder: '' })),
});
void projectedNames;`;

		// Act
		const findings = await auditFixture([
			{ content: admittedRoot, relativePath: 'packages/fixture/src/bin/fixture-cli.ts' },
			{ content: parser, relativePath: 'packages/fixture/src/cli/fixture-cli-parser.ts' },
		]);

		// Assert
		expect(findings.join('\n')).toMatch(/repeated projection.*exact named Zod array schema/u);
	});

	it('rejects fixed-default literals repeated in parser help descriptions', async () => {
		// Arrange
		const parser = `${admittedParser}\nconst defaultNameSchema = z.string().default('fixture');\nconst description = 'Name (default: fixture)';\nvoid defaultNameSchema;\nvoid description;`;

		// Act
		const findings = await auditFixture([
			{ content: admittedRoot, relativePath: 'packages/fixture/src/bin/fixture-cli.ts' },
			{ content: parser, relativePath: 'packages/fixture/src/cli/fixture-cli-parser.ts' },
		]);

		// Assert
		expect(findings.join('\n')).toMatch(/fixed default literal.*schema/u);
	});

	it('rejects schema-named imports from a module without a pure schema-owner name', async () => {
		// Arrange
		const parser = `${admittedParser}\nimport { operationValueSchema } from '../runtime/fixture-runtime.js';\nvoid operationValueSchema;`;

		// Act
		const findings = await auditFixture([
			{ content: admittedRoot, relativePath: 'packages/fixture/src/bin/fixture-cli.ts' },
			{ content: parser, relativePath: 'packages/fixture/src/cli/fixture-cli-parser.ts' },
			{
				content: `import { readFile } from 'node:fs/promises';\nimport { z } from 'zod';\nvoid readFile;\nexport const operationValueSchema = z.string();`,
				relativePath: 'packages/fixture/src/runtime/fixture-runtime.ts',
			},
		]);

		// Assert
		expect(findings.join('\n')).toMatch(/effect owner.*fixture-runtime/u);
	});

	it('accepts schema-named imports from a pure local schema owner', async () => {
		// Arrange
		const parser = `${admittedParser}\nimport { operationValueSchema } from '../schemas/fixture-value-schemas.js';\nvoid operationValueSchema;`;

		// Act
		const findings = await auditFixture([
			{ content: admittedRoot, relativePath: 'packages/fixture/src/bin/fixture-cli.ts' },
			{ content: parser, relativePath: 'packages/fixture/src/cli/fixture-cli-parser.ts' },
			{
				content: `import { z } from 'zod';\nexport const operationValueSchema = z.string();`,
				relativePath: 'packages/fixture/src/schemas/fixture-value-schemas.ts',
			},
		]);

		// Assert
		expect(findings).toEqual([]);
	});

	it('rejects schema-named imports from an effectful file with a schema-owner name', async () => {
		// Arrange
		const parser = `${admittedParser}\nimport { operationValueSchema } from '../schemas/fixture-value-schemas.js';\nvoid operationValueSchema;`;

		// Act
		const findings = await auditFixture([
			{ content: admittedRoot, relativePath: 'packages/fixture/src/bin/fixture-cli.ts' },
			{ content: parser, relativePath: 'packages/fixture/src/cli/fixture-cli-parser.ts' },
			{
				content: `import { readFile } from 'node:fs/promises';\nimport { z } from 'zod';\nvoid readFile;\nexport const operationValueSchema = z.string();`,
				relativePath: 'packages/fixture/src/schemas/fixture-value-schemas.ts',
			},
		]);

		// Assert
		expect(findings.join('\n')).toMatch(/effect owner.*fixture-value-schemas/u);
	});

	it('rejects an explicit zod output type argument', async () => {
		// Arrange
		const parser = admittedParser.replace('zod(z.string()', 'zod<string>(z.string()');

		// Act
		const findings = await auditFixture([
			{ content: admittedRoot, relativePath: 'packages/fixture/src/bin/fixture-cli.ts' },
			{ content: parser, relativePath: 'packages/fixture/src/cli/fixture-cli-parser.ts' },
		]);

		// Assert
		expect(findings.join('\n')).toMatch(/infer its output.*without a type argument/u);
	});

	it('rejects a handwritten scalar Parser output type', async () => {
		// Arrange
		const parser = admittedParser
			.replace(
				"import { type InferValue, multiple, option, optional, withDefault } from '@optique/core';",
				"import { type InferValue, multiple, option, optional, type Parser, withDefault } from '@optique/core';",
			)
			.concat(
				"\nfunction createNameParser(): Parser<'sync', string> { return fixtureRootParser; }\nvoid createNameParser;\n",
			);

		// Act
		const findings = await auditFixture([
			{ content: admittedRoot, relativePath: 'packages/fixture/src/bin/fixture-cli.ts' },
			{ content: parser, relativePath: 'packages/fixture/src/cli/fixture-cli-parser.ts' },
		]);

		// Assert
		expect(findings.join('\n')).toMatch(/Zod schema inference.*handwritten scalar/u);
	});

	it('accepts official Optique subpaths, pure paths, schema-only imports, and presence flags', async () => {
		// Arrange
		const root = `
import { realpathSync } from 'node:fs';
import { run } from '@optique/run';
import { defaultDependencies } from '../cli/fixture-cli-support.js';
import { fixtureRootParser } from '../cli/fixture-cli-parser.js';
void realpathSync;
void defaultDependencies;
const command = run(fixtureRootParser, { help: 'both' });
void command;
`;
		const parser = `
import path from 'node:path';
import { object } from '@optique/core/constructs';
import { withDefault } from '@optique/core/modifiers';
import type { InferValue } from '@optique/core/parser';
import { flag, option } from '@optique/core/primitives';
import { zod } from '@optique/zod';
import { fixtureNameSchema, type FixtureDomain } from '../domain/fixture-domain-schemas.js';
void path;
void object;
void (undefined as FixtureDomain | undefined);
const enabled = withDefault(flag('--enabled'), false);
export const fixtureRootParser = option('--name', zod(fixtureNameSchema, { placeholder: '' }));
export type FixtureCommand = InferValue<typeof fixtureRootParser>;
void enabled;
`;

		// Act
		const findings = await auditFixture([
			{ content: root, relativePath: 'packages/fixture/src/bin/fixture-cli.ts' },
			{ content: parser, relativePath: 'packages/fixture/src/cli/fixture-cli-parser.ts' },
			{
				content: `export const defaultDependencies = {};`,
				relativePath: 'packages/fixture/src/cli/fixture-cli-support.ts',
			},
			{
				content: `import { z } from 'zod';\nexport const fixtureNameSchema = z.string();\nexport type FixtureDomain = string;`,
				relativePath: 'packages/fixture/src/domain/fixture-domain-schemas.ts',
			},
		]);

		// Assert
		expect(findings).toEqual([]);
	});

	it('does not classify unrelated reachable contracts as parser modules', async () => {
		// Arrange
		const parser = `${admittedParser}\nimport type { RuntimeCommand } from '../domain/runtime-contract.js';\nvoid (undefined as RuntimeCommand | undefined);`;

		// Act
		const findings = await auditFixture([
			{ content: admittedRoot, relativePath: 'packages/fixture/src/bin/fixture-cli.ts' },
			{ content: parser, relativePath: 'packages/fixture/src/cli/fixture-cli-parser.ts' },
			{
				content: `export type RuntimeCommand = { kind: 'one' } | { kind: 'two' };`,
				relativePath: 'packages/fixture/src/domain/runtime-contract.ts',
			},
		]);

		// Assert
		expect(findings).toEqual([]);
	});

	it.each([
		['cmd-ts import', `import { command } from 'cmd-ts';\nvoid command;`, /cmd-ts/u],
		[
			'node util argument parser',
			`import { parseArgs } from 'node:util';\nparseArgs({ args: [] });`,
			/node:util.*parseArgs/u,
		],
		[
			'production runParser',
			`import { runParser } from '@optique/core';\nrunParser(fixtureRootParser, []);`,
			/runParser/u,
		],
		[
			'custom runner protocol',
			`type CliExitOutcome = { readonly status: number };\nfunction executeCliWithExitProtocol(): CliExitOutcome { return { status: 0 }; }`,
			/custom runner|exit protocol/u,
		],
		[
			'effect owner import',
			`import { readFile } from 'node:fs/promises';\nvoid readFile;`,
			/effect owner/u,
		],
		[
			'handwritten command union',
			`export type FixtureCommand = { command: 'one' } | { command: 'two' };`,
			/InferValue/u,
		],
		[
			'wrong inferred alias target',
			`import type { InferValue } from '@optique/core';\nexport type FixtureCommand = InferValue<typeof otherParser>;`,
			/InferValue.*fixtureRootParser/u,
		],
		['private Zod representation', `const shape = schema._def;\nvoid shape;`, /private Zod/u],
		[
			'mixed default then optional wrappers',
			`const schema = z.string().default('x').optional();\nvoid schema;`,
			/mixes ZodOptional and ZodDefault/u,
		],
		[
			'mixed optional then default wrappers',
			`const schema = z.string().optional().default('x');\nvoid schema;`,
			/mixes ZodOptional and ZodDefault/u,
		],
		[
			'Optique optional outside projection',
			`import { optional } from '@optique/core';\nconst parser = optional(fixtureRootParser);\nvoid parser;`,
			/optional.*projection/u,
		],
		[
			'Optique default outside projection',
			`import { withDefault } from '@optique/core';\nconst parser = withDefault(fixtureRootParser, 'x');\nvoid parser;`,
			/withDefault.*projection/u,
		],
		[
			'Optique repetition outside projection',
			`import { multiple } from '@optique/core';\nconst parser = multiple(fixtureRootParser);\nvoid parser;`,
			/multiple.*projection/u,
		],
	])('rejects %s', async (_caseName, prohibitedSource, expectedReason) => {
		// Arrange / Act
		const findings = await auditFixture([
			{ content: admittedRoot, relativePath: 'packages/fixture/src/bin/fixture-cli.ts' },
			{
				content: `${admittedParser}\n${prohibitedSource}`,
				relativePath: 'packages/fixture/src/cli/fixture-cli-parser.ts',
			},
		]);

		// Assert
		expect(findings.join('\n')).toMatch(expectedReason);
	});

	it('rejects manual argv slicing while allowing entrypoint identity inspection', async () => {
		// Arrange
		const root = `
	import path from 'node:path';
	import { run } from '@optique/run';
	import { fixtureRootParser } from '../cli/fixture-cli-parser.js';
	if (process.argv[1] !== undefined) void path.resolve(process.argv[1]);
	const command = await run(fixtureRootParser, { args: process.argv.slice(2) });
void command;
`;

		// Act
		const findings = await auditFixture([
			{ content: root, relativePath: 'packages/fixture/src/bin/fixture-cli.ts' },
			{ content: admittedParser, relativePath: 'packages/fixture/src/cli/fixture-cli-parser.ts' },
		]);

		// Assert
		expect(findings.join('\n')).toMatch(/manual argv parsing/u);
		expect(findings.join('\n')).not.toMatch(/manual argv consumer/u);
		expect(findings.join('\n')).not.toMatch(/argv\[1\]/u);
	});

	it('requires direct @optique/run and @optique/zod imports', async () => {
		// Arrange / Act
		const findings = await auditFixture([
			{
				content: `import { fixtureRootParser } from '../cli/fixture-cli-parser.js';\nvoid fixtureRootParser;`,
				relativePath: 'packages/fixture/src/bin/fixture-cli.ts',
			},
			{
				content: `import type { InferValue } from '@optique/core';\nexport const fixtureRootParser = {};\nexport type FixtureCommand = InferValue<typeof fixtureRootParser>;`,
				relativePath: 'packages/fixture/src/cli/fixture-cli-parser.ts',
			},
		]);

		// Assert
		expect(findings.join('\n')).toMatch(/@optique\/run/u);
		expect(findings.join('\n')).toMatch(/@optique\/zod/u);
	});

	it('rejects a renamed manual argv consumer even when the official runner is also called', async () => {
		// Arrange
		const root = `${admittedRoot}
import { parseCliArguments as decodeLegacyArguments } from '../cli/decode.js';
void decodeLegacyArguments(process.argv);
`;

		// Act
		const findings = await auditFixture([
			{ content: root, relativePath: 'packages/fixture/src/bin/fixture-cli.ts' },
			{ content: admittedParser, relativePath: 'packages/fixture/src/cli/fixture-cli-parser.ts' },
			{
				content: `export function parseCliArguments(argv: readonly string[]): string | undefined { return argv[0]; }`,
				relativePath: 'packages/fixture/src/cli/decode.ts',
			},
		]);

		// Assert
		expect(findings.join('\n')).toMatch(/manual argv consumer/u);
	});

	it.each([
		['indexing', `const selectedArgument = process.argv[2];\nvoid selectedArgument;`],
		['destructuring', `const [, , selectedArgument] = process.argv;\nvoid selectedArgument;`],
	])('rejects process.argv %s in the executable root', async (_caseName, source) => {
		// Arrange
		const root = `${admittedRoot}\n${source}`;

		// Act
		const findings = await auditFixture([
			{ content: root, relativePath: 'packages/fixture/src/bin/fixture-cli.ts' },
			{ content: admittedParser, relativePath: 'packages/fixture/src/cli/fixture-cli-parser.ts' },
		]);

		// Assert
		expect(findings.join('\n')).toMatch(/manual process\.argv/u);
	});

	it('rejects process.argv in a root-reachable module whose name has no parser marker', async () => {
		// Arrange
		const root = `${admittedRoot}
import { decodeSelection } from '../cli/decode.js';
void decodeSelection;
`;

		// Act
		const findings = await auditFixture([
			{ content: root, relativePath: 'packages/fixture/src/bin/fixture-cli.ts' },
			{ content: admittedParser, relativePath: 'packages/fixture/src/cli/fixture-cli-parser.ts' },
			{
				content: `export const decodeSelection = process.argv[2];`,
				relativePath: 'packages/fixture/src/cli/decode.ts',
			},
		]);

		// Assert
		expect(findings.join('\n')).toMatch(
			/packages\/fixture\/src\/cli\/decode\.ts.*manual process\.argv/u,
		);
	});

	it('rejects aliasing process.argv before passing it to a legacy consumer', async () => {
		// Arrange
		const root = `${admittedRoot}
import { dispatchFixtureCommand } from '../cli/fixture-command-dispatcher.js';
void dispatchFixtureCommand;
`;
		const dispatcher = `
function decodeLegacyArguments(arguments_: readonly string[]): void { void arguments_; }
const legacyArguments = process.argv;
decodeLegacyArguments(legacyArguments);
export const dispatchFixtureCommand = decodeLegacyArguments;
`;

		// Act
		const findings = await auditFixture([
			{ content: root, relativePath: 'packages/fixture/src/bin/fixture-cli.ts' },
			{ content: admittedParser, relativePath: 'packages/fixture/src/cli/fixture-cli-parser.ts' },
			{
				content: dispatcher,
				relativePath: 'packages/fixture/src/cli/fixture-command-dispatcher.ts',
			},
		]);

		// Assert
		expect(findings.join('\n')).toMatch(/fixture-command-dispatcher\.ts.*manual process\.argv/u);
	});

	it.each([
		['indexing', `const selectedArgument = process.argv[2];\nvoid selectedArgument;`],
		['destructuring', `const [, , selectedArgument] = process.argv;\nvoid selectedArgument;`],
	])('rejects process.argv %s in a package-local parser dependency', async (_caseName, source) => {
		// Arrange
		const parser = `${admittedParser}
import './parser-owned-argv.js';
`;

		// Act
		const findings = await auditFixture([
			{ content: admittedRoot, relativePath: 'packages/fixture/src/bin/fixture-cli.ts' },
			{ content: parser, relativePath: 'packages/fixture/src/cli/fixture-cli-parser.ts' },
			{ content: source, relativePath: 'packages/fixture/src/cli/parser-owned-argv.ts' },
		]);

		// Assert
		expect(findings.join('\n')).toMatch(/manual process\.argv/u);
	});

	it.each([
		[
			'aliased optional',
			`import { optional as schemaOptional } from '@optique/core';\nconst bypass = schemaOptional(fixtureRootParser);\nvoid bypass;`,
			/optional.*projection/u,
		],
		[
			'aliased default',
			`import { withDefault as schemaDefault } from '@optique/core';\nconst bypass = schemaDefault(fixtureRootParser, 'x');\nvoid bypass;`,
			/withDefault.*projection/u,
		],
	])('rejects %s outside the admitted projections', async (_caseName, source, expectedReason) => {
		// Arrange / Act
		const findings = await auditFixture([
			{ content: admittedRoot, relativePath: 'packages/fixture/src/bin/fixture-cli.ts' },
			{
				content: `${admittedParser}\n${source}`,
				relativePath: 'packages/fixture/src/cli/fixture-cli-parser.ts',
			},
		]);

		// Assert
		expect(findings.join('\n')).toMatch(expectedReason);
	});

	it('rejects namespace repetition outside the admitted projection', async () => {
		// Arrange
		const parser = admittedParser
			.replace('type InferValue, multiple, option', 'type InferValue, option')
			.replace(
				`import { zod } from '@optique/zod';`,
				`import { zod } from '@optique/zod';\nimport * as optique from '@optique/core';`,
			)
			.replace('optional(multiple(', 'optional(optique.multiple(');
		const parserWithBypass = `${parser}
const bypass = optique.multiple(fixtureRootParser);
void bypass;
`;

		// Act
		const findings = await auditFixture([
			{ content: admittedRoot, relativePath: 'packages/fixture/src/bin/fixture-cli.ts' },
			{
				content: parserWithBypass,
				relativePath: 'packages/fixture/src/cli/fixture-cli-parser.ts',
			},
		]);

		// Assert
		expect(findings.join('\n')).toMatch(/multiple.*projection/u);
	});

	it('does not accept an unrelated object run method as the executable runner call', async () => {
		// Arrange
		const root = `
import { run } from '@optique/run';
import { fixtureRootParser } from '../cli/fixture-cli-parser.js';
const runner = { run: (value: unknown) => value };
const command = runner.run(fixtureRootParser);
void run;
void command;
`;

		// Act
		const findings = await auditFixture([
			{ content: root, relativePath: 'packages/fixture/src/bin/fixture-cli.ts' },
			{ content: admittedParser, relativePath: 'packages/fixture/src/cli/fixture-cli-parser.ts' },
		]);

		// Assert
		expect(findings.join('\n')).toMatch(/must call run from @optique\/run/u);
	});

	it.each([
		['non-exported', admittedParser.replace('export type FixtureCommand', 'type FixtureCommand')],
		[
			'locally defined InferValue',
			admittedParser.replace(
				`import { type InferValue, multiple, option, optional, withDefault } from '@optique/core';`,
				`import { multiple, option, optional, withDefault } from '@optique/core';\ntype InferValue<TValue> = TValue;`,
			),
		],
	])('rejects a %s command alias', async (_caseName, parser) => {
		// Arrange / Act
		const findings = await auditFixture([
			{ content: admittedRoot, relativePath: 'packages/fixture/src/bin/fixture-cli.ts' },
			{ content: parser, relativePath: 'packages/fixture/src/cli/fixture-cli-parser.ts' },
		]);

		// Assert
		expect(findings.join('\n')).toMatch(/must export.*InferValue/u);
	});

	it('rejects any value parser that bypasses @optique/zod', async () => {
		// Arrange
		const parser = `${admittedParser}
const bypassParser = option('--raw', z.string());
void bypassParser;
`;

		// Act
		const findings = await auditFixture([
			{ content: admittedRoot, relativePath: 'packages/fixture/src/bin/fixture-cli.ts' },
			{ content: parser, relativePath: 'packages/fixture/src/cli/fixture-cli-parser.ts' },
		]);

		// Assert
		expect(findings.join('\n')).toMatch(/value parser.*@optique\/zod/u);
	});

	it('permits package-local pure schema modules whose names contain server or runtime', async () => {
		// Arrange
		const parser = `${admittedParser}
import { serverConfigSchema } from './server-config-schema.js';
import { gatewayRuntimeSchema } from './gateway-runtime-schema.js';
void serverConfigSchema;
void gatewayRuntimeSchema;
`;

		// Act
		const findings = await auditFixture([
			{ content: admittedRoot, relativePath: 'packages/fixture/src/bin/fixture-cli.ts' },
			{ content: parser, relativePath: 'packages/fixture/src/cli/fixture-cli-parser.ts' },
			{
				content: `export const serverConfigSchema = {};`,
				relativePath: 'packages/fixture/src/cli/server-config-schema.ts',
			},
			{
				content: `export const gatewayRuntimeSchema = {};`,
				relativePath: 'packages/fixture/src/cli/gateway-runtime-schema.ts',
			},
		]);

		// Assert
		expect(findings).toEqual([]);
	});

	it('rejects a parser-owned schema module that imports a Node effect API', async () => {
		// Arrange
		const parser = `${admittedParser}
import { fixtureSchema } from './fixture-schema.js';
void fixtureSchema;
`;

		// Act
		const findings = await auditFixture([
			{ content: admittedRoot, relativePath: 'packages/fixture/src/bin/fixture-cli.ts' },
			{ content: parser, relativePath: 'packages/fixture/src/cli/fixture-cli-parser.ts' },
			{
				content: `import { readFile } from 'node:fs/promises';\nexport const fixtureSchema = readFile;`,
				relativePath: 'packages/fixture/src/cli/fixture-schema.ts',
			},
		]);

		// Assert
		expect(findings.join('\n')).toMatch(/fixture-schema\.ts.*effect owner/u);
	});

	it('rejects an unknown external runtime import from a parser module', async () => {
		// Arrange
		const parser = `${admittedParser}
import { serve } from '@hono/node-server';
void serve;
`;

		// Act
		const findings = await auditFixture([
			{ content: admittedRoot, relativePath: 'packages/fixture/src/bin/fixture-cli.ts' },
			{ content: parser, relativePath: 'packages/fixture/src/cli/fixture-cli-parser.ts' },
		]);

		// Assert
		expect(findings.join('\n')).toMatch(/forbidden runtime module @hono\/node-server/u);
	});

	it('rejects named schema imports from a bare package barrel whose purity is unresolved', async () => {
		// Arrange
		const parser = `${admittedParser}
import { systemConfigSchema } from '@agent-vm/config-contracts';
void systemConfigSchema;
`;

		// Act
		const findings = await auditFixture([
			{ content: admittedRoot, relativePath: 'packages/fixture/src/bin/fixture-cli.ts' },
			{ content: parser, relativePath: 'packages/fixture/src/cli/fixture-cli-parser.ts' },
		]);

		// Assert
		expect(findings.join('\n')).toMatch(/forbidden runtime module @agent-vm\/config-contracts/u);
	});

	it('permits an effect-owning operation reachable from a pure parser dispatcher', async () => {
		// Arrange
		const root = `${admittedRoot}
import { dispatchFixtureCommand } from '../cli/fixture-command-dispatcher.js';
void dispatchFixtureCommand;
`;

		// Act
		const findings = await auditFixture([
			{ content: root, relativePath: 'packages/fixture/src/bin/fixture-cli.ts' },
			{ content: admittedParser, relativePath: 'packages/fixture/src/cli/fixture-cli-parser.ts' },
			{
				content: `import { executeFixtureOperation } from './fixture-operation.js';\nexport const dispatchFixtureCommand = executeFixtureOperation;`,
				relativePath: 'packages/fixture/src/cli/fixture-command-dispatcher.ts',
			},
			{
				content: `import { readFile } from 'node:fs/promises';\nexport async function executeFixtureOperation(): Promise<void> { await readFile('/tmp/fixture'); }`,
				relativePath: 'packages/fixture/src/cli/fixture-operation.ts',
			},
		]);

		// Assert
		expect(findings).toEqual([]);
	});

	it('rejects a root importing an operation directly', async () => {
		// Arrange
		const root = `${admittedRoot}
import { executeFixtureOperation } from '../cli/fixture-operation.js';
void executeFixtureOperation;
`;

		// Act
		const findings = await auditFixture([
			{ content: root, relativePath: 'packages/fixture/src/bin/fixture-cli.ts' },
			{ content: admittedParser, relativePath: 'packages/fixture/src/cli/fixture-cli-parser.ts' },
			{
				content: `export function executeFixtureOperation(): void {}`,
				relativePath: 'packages/fixture/src/cli/fixture-operation.ts',
			},
		]);

		// Assert
		expect(findings.join('\n')).toMatch(
			/executable root imports forbidden owner.*fixture-operation/u,
		);
	});

	it('rejects a root importing a Node effect API directly', async () => {
		// Arrange
		const root = `${admittedRoot}
import { readFile } from 'node:fs/promises';
void readFile;
`;

		// Act
		const findings = await auditFixture([
			{ content: root, relativePath: 'packages/fixture/src/bin/fixture-cli.ts' },
			{ content: admittedParser, relativePath: 'packages/fixture/src/cli/fixture-cli-parser.ts' },
		]);

		// Assert
		expect(findings.join('\n')).toMatch(
			/executable root imports forbidden owner node:fs\/promises/u,
		);
	});

	it('rejects a parser importing an effect-owning module with an unclassified name', async () => {
		// Arrange
		const parser = `${admittedParser}
import { decodeFixture } from './decode.js';
void decodeFixture;
`;

		// Act
		const findings = await auditFixture([
			{ content: admittedRoot, relativePath: 'packages/fixture/src/bin/fixture-cli.ts' },
			{ content: parser, relativePath: 'packages/fixture/src/cli/fixture-cli-parser.ts' },
			{
				content: `export function decodeFixture(): string { return 'decoded'; }`,
				relativePath: 'packages/fixture/src/cli/decode.ts',
			},
		]);

		// Assert
		expect(findings.join('\n')).toMatch(/fixture-cli-parser\.ts.*effect owner.*decode\.js/u);
	});

	it('detects the retired MCP parser export through AST declarations and export strings', async () => {
		// Arrange
		const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), 'optique-cli-audit-export-'));
		createdDirectories.push(repositoryRoot);
		const exportFile = 'scripts/verify-exports.ts';
		await mkdir(path.join(repositoryRoot, 'scripts'), { recursive: true });
		await writeFile(
			path.join(repositoryRoot, exportFile),
			`export { parsePortalServerCliArgs } from '../portal.js';\nconst names = ['parsePortalServerCliArgs'];\nvoid names;`,
			'utf8',
		);

		// Act
		const findings = await auditOptiqueCliBoundaries({
			additionalExportFiles: [exportFile],
			inventory: [],
			repositoryRoot,
		});

		// Assert
		expect(findings.map((finding) => finding.reason).join('\n')).toMatch(
			/parsePortalServerCliArgs export/u,
		);
	});

	it('reports a configured export file that is missing', async () => {
		// Arrange
		const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), 'optique-cli-audit-export-'));
		createdDirectories.push(repositoryRoot);

		// Act
		const findings = await auditOptiqueCliBoundaries({
			additionalExportFiles: ['scripts/missing-exports.ts'],
			inventory: [],
			repositoryRoot,
		});

		// Assert
		expect(findings).toEqual([
			{
				executableName: 'configured-export',
				filePath: 'scripts/missing-exports.ts',
				line: 1,
				reason: 'configured export file is missing',
			},
		]);
	});

	it('reports a configured parser file that is missing', async () => {
		// Arrange / Act
		const findings = await auditFixture(
			[{ content: admittedRoot, relativePath: 'packages/fixture/src/bin/fixture-cli.ts' }],
			{ parserFiles: ['packages/fixture/src/cli/missing-parser.ts'] },
		);

		// Assert
		expect(findings).toContain(
			'packages/fixture/src/cli/missing-parser.ts:1 configured parser file is missing',
		);
	});
});
