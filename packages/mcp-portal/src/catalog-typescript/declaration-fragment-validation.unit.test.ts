import { describe, expect, it } from 'vitest';

import { validateDeclarationOnlyTypeFragment } from './declaration-fragment-validation.js';

describe('validateDeclarationOnlyTypeFragment', () => {
	it('accepts interfaces and type aliases only', () => {
		expect(
			validateDeclarationOnlyTypeFragment(
				'export interface Input { query: string }\nexport type Mode = "new" | "all";',
			),
		).toEqual({ ok: true });
	});

	it.each([
		'export const injected = true;',
		'import "./side-effect.js";',
		'export enum Mode { All = "all" }',
		'export class Input {}',
		'export function execute() {}',
		'globalThis.compromised = true;',
	])('rejects runtime-bearing generated syntax: %s', (source) => {
		expect(validateDeclarationOnlyTypeFragment(source)).toMatchObject({ ok: false });
	});
});
