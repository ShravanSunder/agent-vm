import { option, parseSync } from '@optique/core';
import { zod } from '@optique/zod';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
	projectZodScalarPresence,
	type GatewayRuntimeCommand,
	gatewayRuntimeRootParser,
} from './gateway-runtime-cli-parser.js';

function parseGatewayRuntimeCommand(argumentsToParse: readonly string[]): GatewayRuntimeCommand {
	const result = parseSync(gatewayRuntimeRootParser, argumentsToParse);
	if (!result.success) {
		throw new Error('Expected Gateway Runtime CLI arguments to parse successfully.');
	}
	return result.value;
}

describe('Gateway Runtime CLI parser', () => {
	it('constructs without loading config or service effect owners', async () => {
		vi.resetModules();
		vi.doMock('../production/gateway-runtime-production-service.js', () => {
			throw new Error('Parser loaded the Gateway Runtime service effect owner.');
		});
		vi.doMock('../production/gateway-runtime-service-config.js', () => {
			throw new Error('Parser loaded the protected config effect owner.');
		});

		const parserModule = await import('./gateway-runtime-cli-parser.js');

		expect(
			parseSync(parserModule.gatewayRuntimeRootParser, ['--config', '/tmp/gateway-runtime.json'])
				.success,
		).toBe(true);
		vi.doUnmock('../production/gateway-runtime-production-service.js');
		vi.doUnmock('../production/gateway-runtime-service-config.js');
	});

	it('parses the required absolute config option without a public subcommand', () => {
		expect(parseGatewayRuntimeCommand(['--config', '/tmp/gateway-runtime.json'])).toEqual({
			command: 'start',
			configPath: '/tmp/gateway-runtime.json',
		});
	});

	it.each([
		['missing config option', []],
		['relative config path', ['--config', 'config/gateway-runtime.json']],
		['NUL-bearing config path', ['--config', '/tmp/gateway\0runtime.json']],
		['unknown option', ['--config', '/tmp/gateway-runtime.json', '--unknown']],
		[
			'duplicate config option',
			['--config', '/tmp/gateway-runtime.json', '--config', '/tmp/other.json'],
		],
	] as const)('rejects %s', (_description, argumentsToParse) => {
		expect(parseSync(gatewayRuntimeRootParser, argumentsToParse).success).toBe(false);
	});

	it.each([z.string().default('fallback').optional(), z.string().optional().default('fallback')])(
		'rejects mixed optional/default wrapper order',
		(schema) => {
			const parser = option('--value', zod(schema, { placeholder: undefined }));

			expect(() => projectZodScalarPresence(schema, parser)).toThrow(
				'CLI value schemas must not mix ZodOptional and ZodDefault',
			);
		},
	);

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
