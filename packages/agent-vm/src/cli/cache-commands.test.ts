import { describe, expect, it, vi } from 'vitest';

import type { SystemConfig } from '../config/system-config.js';
import { runCacheCommand, type CacheCommandDependencies } from './cache-commands.js';

function createCacheCommandSystemConfig(): SystemConfig {
	return {
		cacheDir: '/cache',
		host: {
			controllerPort: 18800,
			secretsProvider: {
				type: '1password',
				tokenSource: { type: 'env' },
			},
		},
		images: {
			gateway: {
				buildConfig: '/project/images/gateway/build-config.json',
			},
			tool: {
				buildConfig: '/project/images/tool/build-config.json',
			},
		},
		tcpPool: {
			basePort: 19000,
			size: 5,
		},
		toolProfiles: {
			standard: {
				cpus: 1,
				memory: '1G',
				workspaceRoot: '/workspaces/tools',
			},
		},
		zones: [
			{
				allowedHosts: ['api.anthropic.com'],
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
	};
}

describe('runCacheCommand', () => {
	it('lists cached fingerprints and marks the current ones', async () => {
		const stdoutChunks: string[] = [];

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
				computeFingerprintFromConfigPath: async (buildConfigPath) =>
					buildConfigPath.includes('gateway') ? 'gateway-current' : 'tool-current',
				listCacheEntries: () => [
					{ current: true, fingerprint: 'gateway-current' },
					{ current: false, fingerprint: 'stale-fingerprint' },
				],
			},
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
			findStaleImageDirectories: () => [
				{
					absolutePath: '/cache/images/gateway/stale-fingerprint',
					imageType: 'gateway',
					name: 'stale-fingerprint',
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
			findStaleImageDirectories: () => [
				{
					absolutePath: '/cache/images/gateway/stale-fingerprint',
					imageType: 'gateway',
					name: 'stale-fingerprint',
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
				absolutePath: '/cache/images/gateway/stale-fingerprint',
				imageType: 'gateway',
				name: 'stale-fingerprint',
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
				findStaleImageDirectories: () => [],
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
