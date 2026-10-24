import { readFile } from 'node:fs/promises';

import ts from 'typescript';
import { expect, it } from 'vitest';

it('production Worker composes only the ordinary HTTP factory without a test observer', async () => {
	const contents = await readFile(new URL('./cloudflare-host/index.ts', import.meta.url), 'utf8');
	const source = ts.createSourceFile(
		'production-worker.ts',
		contents,
		ts.ScriptTarget.Latest,
		true,
	);
	const calls: { readonly factory: string; readonly argumentCount: number }[] = [];
	function visit(node: ts.Node): void {
		if (
			ts.isCallExpression(node) &&
			ts.isIdentifier(node.expression) &&
			['createSignInHttpHandler'].includes(node.expression.text)
		) {
			calls.push({ factory: node.expression.text, argumentCount: node.arguments.length });
		}
		ts.forEachChild(node, visit);
	}
	visit(source);
	expect(calls.map((call) => call.factory)).toEqual(
		expect.arrayContaining(['createSignInHttpHandler']),
	);
	expect(calls.every((call) => call.argumentCount === 1)).toBe(true);
	expect(contents).not.toMatch(/observeManagement|management-observation-holds|test-fixtures/u);
});
