import { map, option, parseSync, type Parser } from '@optique/core';
import { zod } from '@optique/zod';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { projectZodRepeatedOption, projectZodScalarPresence } from './agent-vm-parser-support.js';

function parseValue<TValue>(
	parser: Parser<'sync', TValue, unknown>,
	arguments_: readonly string[],
): TValue {
	const result = parseSync(parser, arguments_);
	if (!result.success) {
		throw new Error('Expected parser to succeed.');
	}
	return result.value;
}

describe('Agent VM Zod presence projection', () => {
	it('projects required, optional, and fixed-default scalar presence from the schema', () => {
		const requiredSchema = z.string().min(1);
		const optionalSchema = z.string().min(1).optional();
		const defaultSchema = z.string().min(1).default('schema-default');

		const requiredParser = projectZodScalarPresence({
			parser: option('--required', zod(requiredSchema, { placeholder: '' })),
			schema: requiredSchema,
		});
		const optionalParser = projectZodScalarPresence({
			parser: option('--optional', zod(optionalSchema, { placeholder: undefined })),
			schema: optionalSchema,
		});
		const defaultParser = projectZodScalarPresence({
			parser: option(
				'--default',
				zod(defaultSchema, { placeholder: defaultSchema.parse(undefined) }),
			),
			schema: defaultSchema,
		});

		expect(parseSync(requiredParser, []).success).toBe(false);
		expect(parseValue(optionalParser, [])).toBeUndefined();
		expect(parseValue(defaultParser, [])).toBe('schema-default');
		expect(parseValue(requiredParser, ['--required', 'value'])).toBe('value');
	});

	it('rejects both mixed optional/default wrapper orders', () => {
		const defaultThenOptional = z.string().default('value').optional();
		const optionalThenDefault = z.string().optional().default('value');

		expect(() =>
			projectZodScalarPresence({
				parser: option('--value', zod(defaultThenOptional, { placeholder: undefined })),
				schema: defaultThenOptional,
			}),
		).toThrow(/must not mix ZodOptional and ZodDefault/u);
		expect(() =>
			projectZodScalarPresence({
				parser: option('--value', zod(optionalThenDefault, { placeholder: 'value' })),
				schema: optionalThenDefault,
			}),
		).toThrow(/must not mix ZodOptional and ZodDefault/u);
	});

	it.each([
		z.string().prefault('fallback'),
		z.string().catch('fallback'),
		z.string().default('fallback').pipe(z.string()),
	])('rejects unsupported schemas that accept undefined', (schema) => {
		const parser = option('--value', zod(schema, { placeholder: 'fallback' }));

		expect(() => projectZodScalarPresence({ parser, schema })).toThrow(
			/accepting undefined must use ZodOptional or ZodDefault/u,
		);
	});

	it('projects repeated authentication profile ids with a schema-owned empty default', () => {
		const profileIdSchema = z.string().regex(/^profile:/u);
		const profileIdsSchema = z.array(profileIdSchema).default([]);
		const parser = projectZodRepeatedOption({
			parser: option(
				'--profile-id',
				zod(profileIdsSchema.unwrap().element, { placeholder: 'profile:example' }),
			),
			schema: profileIdsSchema,
		});

		expect(parseValue(parser, [])).toEqual([]);
		expect(parseValue(parser, ['--profile-id', 'profile:one'])).toEqual(['profile:one']);
		expect(
			parseValue(parser, ['--profile-id', 'profile:one', '--profile-id', 'profile:two']),
		).toEqual(['profile:one', 'profile:two']);
		expect(parseSync(parser, ['--profile-id', 'invalid']).success).toBe(false);
	});

	it('returns the full array schema output after token collection', () => {
		const repeatedSchema = z.array(z.string()).default([]);
		const parser = projectZodRepeatedOption({
			parser: option('--value', zod(repeatedSchema.unwrap().element, { placeholder: '' })),
			schema: repeatedSchema,
		});

		expect(
			parseValue(
				map(parser, (values) => values.length),
				['--value', 'one'],
			),
		).toBe(1);
	});
});
