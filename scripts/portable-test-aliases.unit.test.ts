import { readFile } from 'node:fs/promises';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
	collectPortalArchitectureViolations,
	collectToolEngineViolations,
} from './audit-portal-architecture.js';

const aliases = [
	'@agent-vm/controller-test-support/approval/controller-approval-ledger.js',
	'@agent-vm/config-contracts-test-support/oauth-policy-compiler-test-fixture.js',
	'@agent-vm/tool-portal/policy-comparison',
] as const;

function compilerOptions(config: string): ts.CompilerOptions {
	const parsed = ts.getParsedCommandLineOfConfigFile(
		path.resolve(config),
		{},
		{
			...ts.sys,
			onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
				throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
			},
		},
	);
	if (parsed === undefined) throw new Error(`Cannot parse ${config}`);
	return parsed.options;
}

describe('test-only portable alias boundaries', () => {
	it.each(aliases)('rejects production imports and declarations through %s', (alias) => {
		const sourceTexts = [
			`import type { TestOnlyDependency } from '${alias}'; export type Leak = TestOnlyDependency;`,
			`export type { TestOnlyDependency } from '${alias}';`,
			`import type TestOnlyDependency = require('${alias}'); export type Leak = TestOnlyDependency;`,
		];
		for (const sourceText of sourceTexts) {
			for (const filePath of [
				'packages/tool-engine/src/capability-dispatch/alias-consumer.ts',
				'packages/gateway-runtime/src/managed-tool-engine/alias-consumer.ts',
			])
				expect(
					collectPortalArchitectureViolations({ files: [{ filePath, sourceText }] }),
				).toContain(`${filePath}: production must not import test-only alias ${alias}`);
			expect(
				collectToolEngineViolations({
					filePath: 'packages/tool-engine/src/contracts/alias-consumer.d.ts',
					sourceText,
				}),
			).toContain(
				`packages/tool-engine/src/contracts/alias-consumer.d.ts: tool-engine forbidden import ${alias}`,
			);
			// Legitimate test access remains available; this is not a blanket removal of the test seam.
			expect(
				collectPortalArchitectureViolations({
					files: [
						{
							filePath: 'packages/tool-engine/src/capability-dispatch/alias-consumer.unit.test.ts',
							sourceText,
						},
					],
				}),
			).toEqual([]);
		}
	});
	it('rejects the actual controller-alias production type-import fixture', async () => {
		const sourceText = await readFile(
			new URL('./fixtures/portable-test-aliases/controller-type-import.ts', import.meta.url),
			'utf8',
		);
		const violations = collectToolEngineViolations({
			filePath: 'packages/tool-engine/src/capability-dispatch/controller-type-import.ts',
			sourceText,
		});
		expect(violations).toEqual([
			'packages/tool-engine/src/capability-dispatch/controller-type-import.ts: tool-engine forbidden import @agent-vm/controller-test-support/approval/controller-approval-ledger.js',
		]);
	});
	it.each([
		[aliases[0], 'packages/agent-vm/src/controller/approval/controller-approval-ledger.ts'],
		[aliases[1], 'packages/config-contracts/src/oauth-policy-compiler-test-fixture.ts'],
		[aliases[2], 'packages/tool-portal/src/tool-portal-service-common.ts'],
	] as const)('retains legitimate shared test resolution for %s', (alias, expectedPath) => {
		expect(
			ts.resolveModuleName(
				alias,
				path.resolve('packages/tool-engine/src/capability-dispatch/alias-consumer.unit.test.ts'),
				compilerOptions('tsconfig.json'),
				ts.sys,
			).resolvedModule?.resolvedFileName,
		).toBe(path.resolve(expectedPath));
	});
});
