import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
	compileCatalogTypescriptModules,
	fingerprintCatalogTypescriptInput,
} from './catalog-typescript-compiler.js';

describe('compileCatalogTypescriptModules', () => {
	it('keeps distinct tuple identities when names contain separator characters', () => {
		const tools = [
			{ namespace: 'a\u0000', name: 'b', inputSchema: { type: 'object' } },
			{ namespace: 'a', name: '\u0000b', inputSchema: { type: 'object' } },
		];
		expect(() => fingerprintCatalogTypescriptInput({ tools })).not.toThrow();
	});
	it('fingerprints canonically equivalent ordering without conflating distinct Unicode names', () => {
		const tools = ['é', 'e\u0301'].map((name) => ({
			inputSchema: { type: 'object' },
			name,
			namespace: 'unicode',
		}));
		expect(fingerprintCatalogTypescriptInput({ tools })).toBe(
			fingerprintCatalogTypescriptInput({ tools: [...tools].reverse() }),
		);
	});
	it('generates isolated deterministic namespace factories with exact wire names and typed schemas', async () => {
		const input = {
			tools: [
				{
					inputSchema: {
						$defs: { label: { type: 'string' } },
						additionalProperties: false,
						properties: {
							label: { $ref: '#/$defs/label' },
							mode: { enum: ['new', 'all'] },
							query: { type: ['string', 'null'] },
						},
						required: ['query'],
						type: 'object',
					},
					name: 'search-messages',
					namespace: 'google/mail',
				},
				{
					inputSchema: {
						$defs: { label: { type: 'number' } },
						properties: { label: { $ref: '#/$defs/label' } },
						type: 'object',
					},
					name: 'search_messages',
					namespace: 'google/mail',
				},
				{
					inputSchema: { properties: { path: { type: 'string' } }, type: 'object' },
					name: 'read',
					namespace: 'files',
				},
			],
		};

		const first = await compileCatalogTypescriptModules(input);
		const second = await compileCatalogTypescriptModules({ tools: input.tools.toReversed() });

		expect(first).toEqual(second);
		expect(fingerprintCatalogTypescriptInput(input)).toBe(first.definitionFingerprint);
		expect(first.files).toHaveLength(2);
		expect(first.manifest.namespaces.map((entry) => entry.namespace)).toEqual([
			'files',
			'google/mail',
		]);
		const googleModule = first.files.find((file) => file.namespace === 'google/mail');
		expect(googleModule?.source).toMatch(/export interface SearchMessages[0-9a-f]{8}Input/iu);
		expect(googleModule?.source).toContain('query: (string | null)');
		expect(googleModule?.source).toContain('"name": "search-messages"');
		expect(googleModule?.source).toContain('"name": "search_messages"');
		expect(googleModule?.source).not.toMatch(/export type Label\b/u);
		expect(new Set(googleModule?.source.match(/searchMessages[0-9a-f]{8}/gu) ?? [])).toHaveLength(
			2,
		);
		expect(first.definitionFingerprint).toMatch(/^[0-9a-f]{64}$/u);
	});

	it('widens malicious source extensions and external refs without embedding or resolving them', async () => {
		const sourcePayload = 'class Escaped { constructor() { globalThis.compromised = true; } }';
		const hostileDescription = '*/ export const injectedFromDescription = true; /*';
		const result = await compileCatalogTypescriptModules({
			tools: [
				{
					inputSchema: {
						description: hostileDescription,
						properties: {
							nested: {
								items: { tsEnumNames: ['Injected'], tsType: sourcePayload, type: 'string' },
								type: 'array',
							},
						},
						type: 'object',
					},
					name: 'hostile',
					namespace: 'unsafe',
				},
				{
					inputSchema: { $ref: 'file:///private/etc/passwd' },
					name: 'external-file',
					namespace: 'unsafe',
				},
				{
					inputSchema: { $ref: 'https://example.invalid/schema.json' },
					name: 'external-http',
					namespace: 'unsafe',
				},
			],
		});

		const source = result.files[0]?.source ?? '';
		// Original schemas remain embedded as inert JSON data for runtime validation.
		expect(source).toContain(JSON.stringify(sourcePayload));
		expect(source).toContain(JSON.stringify(hostileDescription));
		expect(source).toContain('file:///private/etc/passwd');
		expect(source).toContain('https://example.invalid/schema.json');
		expect(source).not.toContain(`export type HostileInput = ${sourcePayload}`);
		const parsedSource = ts.createSourceFile(
			'unsafe-generated.ts',
			source,
			ts.ScriptTarget.Latest,
			true,
			ts.ScriptKind.TS,
		);
		expect(parsedSource.statements.some(ts.isClassDeclaration)).toBe(false);
		expect(
			parsedSource.statements
				.filter(ts.isVariableStatement)
				.flatMap((statement) => statement.declarationList.declarations)
				.some(
					(declaration) =>
						ts.isIdentifier(declaration.name) &&
						declaration.name.text === 'injectedFromDescription',
				),
		).toBe(false);
		expect(result.manifest.tools.every((tool) => tool.typing === 'widened')).toBe(true);
		expect(result.manifest.tools.flatMap((tool) => tool.diagnostics)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: 'source-bearing-extension', keyword: 'tsType' }),
				expect.objectContaining({ kind: 'source-bearing-extension', keyword: 'tsEnumNames' }),
				expect.objectContaining({ kind: 'external-reference' }),
			]),
		);
	});

	it('records known runtime validation gaps as explicit portal-only fallbacks', async () => {
		const result = await compileCatalogTypescriptModules({
			tools: [
				{
					inputSchema: { properties: {}, type: 'object', unevaluatedProperties: false },
					name: 'unsupported-runtime',
					namespace: 'test',
				},
			],
		});

		expect(result.manifest.tools[0]).toMatchObject({ runtimeValidation: 'portal-only' });
		expect(result.files[0]?.source).toContain('"runtimeValidation": "portal-only"');
	});

	it('preserves source-like property and data keys while safely cloning __proto__', async () => {
		const properties = {
			['__proto__']: { type: 'boolean' },
			tsEnumNames: { type: 'number' },
			tsType: { type: 'string' },
		};
		const result = await compileCatalogTypescriptModules({
			tools: [
				{
					inputSchema: {
						default: { tsEnumNames: ['data'], tsType: 'data' },
						properties,
						type: 'object',
					},
					name: 'legitimate-names',
					namespace: 'safe',
				},
			],
		});

		expect(result.manifest.tools[0]?.typing).toBe('structurally-derived');
		expect(result.manifest.tools[0]?.diagnostics).toEqual([]);
		const source = result.files[0]?.source ?? '';
		expect(source).toContain('tsType?: string');
		expect(source).toContain('tsEnumNames?: number');
		expect(source).toContain('"__proto__"');
		expect(source).toContain('"tsType": "data"');
	});
});
