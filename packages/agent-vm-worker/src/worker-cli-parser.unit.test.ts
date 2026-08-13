import { readFile } from 'node:fs/promises';

import { option, parseSync } from '@optique/core';
import { zod } from '@optique/zod';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
	projectZodScalarPresence,
	type WorkerCommand,
	workerCommandParser,
} from './worker-cli-parser.js';

function parseWorkerCommand(argumentsToParse: readonly string[]): WorkerCommand {
	const result = parseSync(workerCommandParser, argumentsToParse);
	if (!result.success) {
		throw new Error('Expected Worker CLI arguments to parse successfully.');
	}
	return result.value;
}

describe('worker CLI parser', () => {
	it('keeps parser construction free of runtime operation effects', async () => {
		const parserSource = await readFile(new URL('./worker-cli-parser.ts', import.meta.url), 'utf8');

		expect(parserSource).not.toMatch(/node:(?:child_process|fs|http|net)/u);
		expect(parserSource).not.toMatch(/process\.|run[A-Z]\w*Operation|createNode\w*Transport/u);
	});

	it('parses serve with the schema-owned port default', () => {
		expect(parseWorkerCommand(['serve'])).toEqual({
			command: 'serve',
			config: undefined,
			port: 18_789,
			stateDir: undefined,
		});
	});

	it.each([0, 65_535])('accepts the TCP port boundary %i', (port) => {
		expect(parseWorkerCommand(['serve', '--port', String(port)])).toMatchObject({
			command: 'serve',
			port,
		});
	});

	it('parses operation-owned config and state directory inputs without defaults', () => {
		expect(
			parseWorkerCommand([
				'serve',
				'--config',
				'/tmp/worker.json',
				'--state-dir',
				'/tmp/worker-state',
			]),
		).toEqual({
			command: 'serve',
			config: '/tmp/worker.json',
			port: 18_789,
			stateDir: '/tmp/worker-state',
		});
	});

	it('parses health as a distinct command variant', () => {
		expect(parseWorkerCommand(['health', '-p', '0'])).toEqual({
			command: 'health',
			port: 0,
		});
	});

	it.each(['', '   ', '-1', '65536', '1.5', 'not-a-number'])(
		'rejects invalid port value %s before dispatch',
		(port) => {
			expect(parseSync(workerCommandParser, ['health', '--port', port]).success).toBe(false);
		},
	);

	it('rejects default wrapped by optional at parser construction', () => {
		const mixedSchema = z.string().default('default-value').optional();
		const parser = option('--value', zod(mixedSchema, { placeholder: 'placeholder' }));

		expect(() => projectZodScalarPresence(mixedSchema, parser)).toThrow(/optional and default/u);
	});

	it('rejects optional wrapped by default at parser construction', () => {
		const mixedSchema = z.string().optional().default('default-value');
		const parser = option('--value', zod(mixedSchema, { placeholder: 'placeholder' }));

		expect(() => projectZodScalarPresence(mixedSchema, parser)).toThrow(/optional and default/u);
	});

	it.each([
		z.string().prefault('fallback'),
		z.string().catch('fallback'),
		z.string().default('fallback').pipe(z.string()),
	])('rejects unsupported schemas that accept undefined', (schema) => {
		const parser = option('--value', zod(schema, { placeholder: 'fallback' }));

		expect(() => projectZodScalarPresence(schema, parser)).toThrow(
			/accepting undefined must use ZodOptional or ZodDefault/u,
		);
	});
});
