import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import { loadSystemConfigFromOption } from './command-definition-support.js';

describe('loadSystemConfigFromOption', () => {
	it('formats system config validation errors for CLI output', async () => {
		await expect(
			loadSystemConfigFromOption(undefined, {
				loadSystemConfig: async () => {
					throw new ZodError([
						{
							code: 'invalid_type',
							expected: 'string',
							input: undefined,
							message: 'Invalid input: expected string, received undefined',
							path: ['zones', 0, 'gateway', 'gatewayConfig'],
						},
					]);
				},
			}),
		).rejects.toThrow(
			[
				'Invalid system.json configuration:',
				'  zones[0].gateway.gatewayConfig: Invalid input: expected string, received undefined',
			].join('\n'),
		);
	});

	it('formats invalid JSON errors for CLI output', async () => {
		await expect(
			loadSystemConfigFromOption('./broken-system.json', {
				loadSystemConfig: async () => {
					throw new SyntaxError('Unexpected token ] in JSON at position 42');
				},
			}),
		).rejects.toThrow(
			'Invalid JSON in ./broken-system.json: Unexpected token ] in JSON at position 42',
		);
	});
});
