import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import { requireZone } from '../agent-vm-cli-support.js';
import { loadSystemConfigFromOption, parseGatewayType } from './command-definition-support.js';

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

describe('requireZone', () => {
	it('throws for an unknown zone name', () => {
		expect(() =>
			requireZone(
				{
					cacheDir: './cache',
					host: {
						controllerPort: 18800,
						secretsProvider: { type: '1password', tokenSource: { type: 'env' } },
					},
					images: {
						gateway: { buildConfig: './images/gateway/build-config.json' },
						tool: { buildConfig: './images/tool/build-config.json' },
					},
					tcpPool: { basePort: 19000, size: 5 },
					toolProfiles: {
						standard: { cpus: 1, memory: '1G', workspaceRoot: './workspaces/tools' },
					},
					zones: [
						{
							allowedHosts: ['api.openai.com'],
							gateway: {
								type: 'openclaw',
								cpus: 2,
								memory: '2G',
								gatewayConfig: './config/shravan/openclaw.json',
								port: 18791,
								stateDir: './state/shravan',
								workspaceDir: './workspaces/shravan',
							},
							id: 'shravan',
							secrets: {},
							toolProfile: 'standard',
							websocketBypass: [],
						},
					],
				},
				'nope',
			),
		).toThrow("Unknown zone 'nope'.");
	});
});

describe('parseGatewayType', () => {
	it('throws when the gateway type is missing', () => {
		expect(() => parseGatewayType(undefined)).toThrow(
			"Gateway type is required. Expected 'openclaw' or 'worker'.",
		);
	});
});
