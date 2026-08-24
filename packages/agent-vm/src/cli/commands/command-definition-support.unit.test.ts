import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import { requireZone } from '../agent-vm-cli-support.js';
import { cliDescription } from './command-definition-support.js';
import { loadSystemConfigFromCliOption } from './command-operation-support.js';

describe('cliDescription', () => {
	it('creates plain help text instead of a quoted value term', () => {
		expect(cliDescription('Boot the controller and gateway')).toEqual([
			{ text: 'Boot the controller and gateway', type: 'text' },
		]);
	});
});

describe('loadSystemConfigFromCliOption', () => {
	it('formats system config validation errors for CLI output', async () => {
		await expect(
			loadSystemConfigFromCliOption('config/system.json', {
				loadSystemConfig: async () => {
					throw new ZodError([
						{
							code: 'invalid_type',
							expected: 'string',
							input: undefined,
							message: 'Invalid input: expected string, received undefined',
							path: ['zones', 0, 'gateway', 'config'],
						},
					]);
				},
			}),
		).rejects.toThrow(
			[
				'Invalid config/system.json configuration:',
				'  zones[0].gateway.config: Invalid input: expected string, received undefined',
			].join('\n'),
		);
	});

	it('formats invalid JSON errors for CLI output', async () => {
		await expect(
			loadSystemConfigFromCliOption('./broken-system.json', {
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
					storageRootDir: './storage',
					cacheDir: './cache',
					controllerStateDir: '/controller-state-test',
					controllerRuntimeDir: './controller-runtime',
					schemaVersion: 2,
					host: {
						controllerPort: 18800,
						projectNamespace: 'claw-tests-a1b2c3d4',
						secretsProvider: { type: '1password', tokenSource: { type: 'env' } },
					},
					imageProfiles: {
						gateways: {
							openclaw: {
								type: 'hermes',
								buildConfig: './vm-images/gateways/openclaw/build-config.json',
							},
							worker: {
								type: 'worker',
								buildConfig: './vm-images/gateways/worker/build-config.json',
							},
						},
						toolVms: {
							default: {
								type: 'toolVm',
								buildConfig: './vm-images/tool-vms/default/build-config.json',
							},
						},
					},
					tcpPool: { basePort: 19000, size: 5 },
					toolVmProfiles: {
						standard: {
							cpus: 1,
							memory: '1G',
							imageProfile: 'default',
						},
					},
					zones: [
						{
							egressHosts: ['api.openai.com'].map((host) => ({
								host,
								audience: 'gateway' as const,
							})),
							gateway: {
								type: 'hermes',
								profileSecretProjectionsByAgent: { main: {} },
								profilesByAgent: { main: 'main' },
								imageProfile: 'openclaw',
								cpus: 2,
								memory: '2G',
								config: './config/shravan/openclaw.json',
								port: 18791,
								stateDir: './state/shravan',
								zoneFilesDir: './zone-files/shravan',
								zoneRuntimeDir: './runtime/shravan',
							},
							id: 'shravan',
							secrets: {
								OPENCLAW_GATEWAY_TOKEN: {
									source: 'environment',
									envVar: 'OPENCLAW_GATEWAY_TOKEN',
									injection: 'env',
									audience: 'gateway',
								},
							},
							defaultToolVmProfile: 'standard',
							agentToolVmProfiles: {},
						},
					],
				},
				'nope',
			),
		).toThrow("Unknown zone 'nope'.");
	});
});
