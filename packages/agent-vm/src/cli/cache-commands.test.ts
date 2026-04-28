import { describe, expect, it, vi } from 'vitest';

import { createLoadedSystemConfig, type LoadedSystemConfig } from '../config/system-config.js';
import { runCacheCommand, type CacheCommandDependencies } from './cache-commands.js';

function createCacheCommandSystemConfig(): LoadedSystemConfig {
	return createLoadedSystemConfig(
		{
			cacheDir: '/cache',
			runtimeDir: '/runtime',
			host: {
				controllerPort: 18800,
				projectNamespace: 'claw-tests-a1b2c3d4',
				secretsProvider: {
					type: '1password',
					tokenSource: { type: 'env' },
				},
			},
			imageProfiles: {
				gateways: {
					openclaw: {
						type: 'openclaw',
						buildConfig: '/project/vm-images/gateways/openclaw/build-config.json',
					},
				},
				toolVms: {
					default: {
						type: 'toolVm',
						buildConfig: '/project/vm-images/tool-vms/default/build-config.json',
					},
				},
			},
			tcpPool: {
				basePort: 19000,
				size: 5,
			},
			toolProfiles: {
				standard: {
					cpus: 1,
					imageProfile: 'default',
					memory: '1G',
					workspaceRoot: '/workspaces/tools',
				},
			},
			zones: [
				{
					allowedHosts: ['api.anthropic.com'],
					gateway: {
						type: 'openclaw',
						imageProfile: 'openclaw',
						cpus: 2,
						memory: '2G',
						config: './config/shravan/openclaw.json',
						port: 18791,
						stateDir: './state/shravan',
						zoneFilesDir: './zone-files/shravan',
					},
					id: 'shravan',
					secrets: {},
					toolProfile: 'standard',
					websocketBypass: [],
				},
			],
		},
		{ systemConfigPath: '/project/config/system.json' },
	);
}

describe('runCacheCommand', () => {
	it('lists cached fingerprints and marks the current ones', async () => {
		const stdoutChunks: string[] = [];
		const computeFingerprintFromConfigPath = vi.fn(
			async (buildConfigPath: string, _systemCacheIdentifierPath: string) =>
				buildConfigPath.includes('gateway') ? 'gateway-current' : 'tool-current',
		);

		await runCacheCommand(
			{
				subcommand: 'list',
				systemConfig: createCacheCommandSystemConfig(),
			},
			{
				stderr: { write: () => true },
				stdout: {
					write: (chunk: string | Uint8Array) => {
						stdoutChunks.push(String(chunk));
						return true;
					},
				},
			},
			{
				computeFingerprintFromConfigPath,
				listCacheEntries: async () => [
					{ current: true, fingerprint: 'gateway-current' },
					{ current: false, fingerprint: 'stale-fingerprint' },
				],
			},
		);

		expect(computeFingerprintFromConfigPath).toHaveBeenCalledWith(
			'/project/vm-images/gateways/openclaw/build-config.json',
			'/project/config/systemCacheIdentifier.json',
		);
		expect(computeFingerprintFromConfigPath).toHaveBeenCalledWith(
			'/project/vm-images/tool-vms/default/build-config.json',
			'/project/config/systemCacheIdentifier.json',
		);
		expect(stdoutChunks.join('')).toContain('"gateway-current"');
		expect(stdoutChunks.join('')).toContain('"stale-fingerprint"');
	});

	it('warns and does not delete stale images without --confirm', async () => {
		const stderrChunks: string[] = [];
		const deleteStaleImageDirectories = vi.fn();
		const dependencies: CacheCommandDependencies = {
			computeFingerprintFromConfigPath: async (buildConfigPath) =>
				buildConfigPath.includes('gateway') ? 'gateway-current' : 'tool-current',
			deleteStaleImageDirectories,
			findStaleImageDirectories: async () => [
				{
					absolutePath: '/cache/gateway-images/openclaw/stale-fingerprint',
					family: 'gateway',
					fingerprint: 'stale-fingerprint',
					profileName: 'openclaw',
					sizeBytes: 1024,
				},
			],
		};

		await runCacheCommand(
			{
				subcommand: 'clean',
				systemConfig: createCacheCommandSystemConfig(),
			},
			{
				stderr: {
					write: (chunk: string | Uint8Array) => {
						stderrChunks.push(String(chunk));
						return true;
					},
				},
				stdout: { write: () => true },
			},
			dependencies,
		);

		expect(deleteStaleImageDirectories).not.toHaveBeenCalled();
		expect(stderrChunks.join('')).toContain('Run with --confirm to delete');
	});

	it('deletes stale images when --confirm is provided', async () => {
		const deleteStaleImageDirectories = vi.fn();
		const dependencies: CacheCommandDependencies = {
			computeFingerprintFromConfigPath: async (buildConfigPath) =>
				buildConfigPath.includes('gateway') ? 'gateway-current' : 'tool-current',
			deleteStaleImageDirectories,
			findStaleImageDirectories: async () => [
				{
					absolutePath: '/cache/gateway-images/openclaw/stale-fingerprint',
					family: 'gateway',
					fingerprint: 'stale-fingerprint',
					profileName: 'openclaw',
					sizeBytes: 1024,
				},
			],
		};

		await runCacheCommand(
			{
				confirm: true,
				subcommand: 'clean',
				systemConfig: createCacheCommandSystemConfig(),
			},
			{
				stderr: { write: () => true },
				stdout: { write: () => true },
			},
			dependencies,
		);

		expect(deleteStaleImageDirectories).toHaveBeenCalledWith([
			{
				absolutePath: '/cache/gateway-images/openclaw/stale-fingerprint',
				family: 'gateway',
				fingerprint: 'stale-fingerprint',
				profileName: 'openclaw',
				sizeBytes: 1024,
			},
		]);
	});

	it('prints a friendly message when no stale images are found', async () => {
		const stderrChunks: string[] = [];

		await runCacheCommand(
			{
				subcommand: 'clean',
				systemConfig: createCacheCommandSystemConfig(),
			},
			{
				stderr: {
					write: (chunk: string | Uint8Array) => {
						stderrChunks.push(String(chunk));
						return true;
					},
				},
				stdout: { write: () => true },
			},
			{
				computeFingerprintFromConfigPath: async (buildConfigPath) =>
					buildConfigPath.includes('gateway') ? 'gateway-current' : 'tool-current',
				findStaleImageDirectories: async () => [],
			},
		);

		expect(stderrChunks.join('')).toContain('No stale images found.');
	});

	it('throws for an unknown cache subcommand', async () => {
		await expect(
			runCacheCommand(
				{
					subcommand: 'prune',
					systemConfig: createCacheCommandSystemConfig(),
				},
				{
					stderr: { write: () => true },
					stdout: { write: () => true },
				},
				{
					computeFingerprintFromConfigPath: async (buildConfigPath) =>
						buildConfigPath.includes('gateway') ? 'gateway-current' : 'tool-current',
				},
			),
		).rejects.toThrow("Unknown cache subcommand 'prune'.");
	});
});
