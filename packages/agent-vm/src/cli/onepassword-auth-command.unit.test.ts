import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { SystemConfig } from '../config/system-config.js';
import type { CliIo } from './agent-vm-cli-support.js';
import { runOnePasswordAuthCommand } from './onepassword-auth-command.js';

function createSystemConfig(
	tokenSource: NonNullable<SystemConfig['host']['secretsProvider']>['tokenSource'] = {
		type: 'keychain',
		service: 'agent-vm',
		account: '1p-service-account--shravan-claw',
	},
): SystemConfig {
	return {
		schemaVersion: 2,
		storageRootDir: './storage',
		cacheDir: './cache',
		controllerStateDir: '/controller-state-test',
		controllerRuntimeDir: './controller-runtime',
		host: {
			controllerPort: 18800,
			projectNamespace: 'agent-vm-tests-a1b2c3d4',
			secretsProvider: {
				type: '1password',
				tokenSource,
			},
		},
		imageProfiles: {
			gateways: {},
			toolVms: {},
		},
		tcpPool: { basePort: 19000, size: 5 },
		toolVmProfiles: {},
		zones: [],
	};
}

function createIo(): {
	readonly io: CliIo;
	readonly stderrChunks: readonly string[];
	readonly stdoutChunks: readonly string[];
} {
	const stderrChunks: string[] = [];
	const stdoutChunks: string[] = [];
	return {
		io: {
			stderr: {
				write: (chunk: string | Uint8Array): boolean => {
					stderrChunks.push(String(chunk));
					return true;
				},
			},
			stdout: {
				write: (chunk: string | Uint8Array): boolean => {
					stdoutChunks.push(String(chunk));
					return true;
				},
			},
		},
		stderrChunks,
		stdoutChunks,
	};
}

describe('runOnePasswordAuthCommand', () => {
	it('reads a token ref with op and stores it in the configured Keychain entry', async () => {
		const { io, stdoutChunks } = createIo();
		const runCommand = vi.fn(async () => ({
			exitCode: 0,
			stderr: '',
			stdout: 'service-account-token\n',
		}));
		const storeServiceAccountToken = vi.fn();

		await runOnePasswordAuthCommand({
			dependencies: { runCommand, storeServiceAccountToken },
			io,
			systemConfig: createSystemConfig(),
			tokenReference: 'op://agent-vm/1p-service-account-shravan-claw/credential',
		});

		expect(runCommand).toHaveBeenCalledWith('op', [
			'read',
			'op://agent-vm/1p-service-account-shravan-claw/credential',
		]);
		expect(storeServiceAccountToken).toHaveBeenCalledWith('service-account-token', {
			service: 'agent-vm',
			account: '1p-service-account--shravan-claw',
		});
		expect(stdoutChunks).toContain(
			"Stored 1Password service account token in macOS Keychain service 'agent-vm' account '1p-service-account--shravan-claw'.\n",
		);
		expect(stdoutChunks.join('')).not.toContain('service-account-token');
	});

	it('preserves op read token bytes except the stdout terminator', async () => {
		const storeServiceAccountToken = vi.fn();

		await runOnePasswordAuthCommand({
			dependencies: {
				runCommand: vi.fn(async () => ({
					exitCode: 0,
					stderr: '',
					stdout: ' leading-space-token ',
				})),
				storeServiceAccountToken,
			},
			io: createIo().io,
			systemConfig: createSystemConfig(),
			tokenReference: 'op://agent-vm/service-account/credential',
		});

		expect(storeServiceAccountToken).toHaveBeenCalledWith(' leading-space-token ', {
			service: 'agent-vm',
			account: '1p-service-account--shravan-claw',
		});
	});

	it('rejects missing 1Password host provider config', async () => {
		await expect(
			runOnePasswordAuthCommand({
				dependencies: { runCommand: vi.fn() },
				io: createIo().io,
				systemConfig: {
					...createSystemConfig(),
					host: { controllerPort: 18800, projectNamespace: 'agent-vm-tests-a1b2c3d4' },
				},
				tokenReference: 'op://agent-vm/service-account/credential',
			}),
		).rejects.toThrow('host.secretsProvider.type="1password"');
	});

	it('rejects env-backed 1Password token sources', async () => {
		await expect(
			runOnePasswordAuthCommand({
				dependencies: { runCommand: vi.fn() },
				io: createIo().io,
				systemConfig: createSystemConfig({ type: 'env', envVar: 'OP_SERVICE_ACCOUNT_TOKEN' }),
				tokenReference: 'op://agent-vm/service-account/credential',
			}),
		).rejects.toThrow('host.secretsProvider.tokenSource.type="keychain"');
	});

	it('rejects invalid configured Keychain targets before running op', async () => {
		const runCommand = vi.fn();

		await expect(
			runOnePasswordAuthCommand({
				dependencies: { runCommand },
				io: createIo().io,
				systemConfig: createSystemConfig({
					type: 'keychain',
					service: 'agent-vm',
					account: 'bad/name',
				}),
				tokenReference: 'op://agent-vm/service-account/credential',
			}),
		).rejects.toThrow('Invalid 1Password Keychain account');
		expect(runCommand).not.toHaveBeenCalled();
	});

	it('rejects empty op read output', async () => {
		await expect(
			runOnePasswordAuthCommand({
				dependencies: {
					runCommand: vi.fn(async () => ({ exitCode: 0, stderr: '', stdout: '\n' })),
					storeServiceAccountToken: vi.fn(),
				},
				io: createIo().io,
				systemConfig: createSystemConfig(),
				tokenReference: 'op://agent-vm/service-account/credential',
			}),
		).rejects.toThrow('1Password service account token is empty.');
	});

	it('redacts default op read failures', async () => {
		const originalPath = process.env.PATH;
		const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-op-read-failure-'));
		const opPath = path.join(temporaryDirectory, 'op');
		await writeFile(
			opPath,
			`#!/usr/bin/env sh
echo "LEAKED-SERVICE-TOKEN" >&2
exit 7
`,
			{ mode: 0o755 },
		);
		process.env.PATH = `${temporaryDirectory}:${originalPath ?? ''}`;
		try {
			await expect(
				runOnePasswordAuthCommand({
					dependencies: { storeServiceAccountToken: vi.fn() },
					io: createIo().io,
					systemConfig: createSystemConfig(),
					tokenReference: 'op://agent-vm/service-account/credential',
				}),
			).rejects.toThrow('Failed to read 1Password service account token with op read.');
			await expect(
				runOnePasswordAuthCommand({
					dependencies: { storeServiceAccountToken: vi.fn() },
					io: createIo().io,
					systemConfig: createSystemConfig(),
					tokenReference: 'op://agent-vm/service-account/credential',
				}),
			).rejects.not.toThrow('LEAKED-SERVICE-TOKEN');
		} finally {
			process.env.PATH = originalPath;
			await rm(temporaryDirectory, { recursive: true, force: true });
		}
	});

	it('fails clearly without a ref in non-interactive mode', async () => {
		await expect(
			runOnePasswordAuthCommand({
				dependencies: { stdinIsTty: () => false },
				io: createIo().io,
				systemConfig: createSystemConfig(),
			}),
		).rejects.toThrow('requires a token ref/url argument when stdin is not interactive');
	});

	it('stores an interactively pasted token when no ref is provided', async () => {
		const storeServiceAccountToken = vi.fn();
		const readlineInterface = {
			close: vi.fn(),
			question: vi.fn(async () => ' pasted-token '),
		};

		await runOnePasswordAuthCommand({
			dependencies: {
				createReadlineInterface: () => readlineInterface as never,
				stdinIsTty: () => true,
				storeServiceAccountToken,
			},
			io: createIo().io,
			systemConfig: createSystemConfig(),
		});

		expect(storeServiceAccountToken).toHaveBeenCalledWith(' pasted-token ', {
			service: 'agent-vm',
			account: '1p-service-account--shravan-claw',
		});
		expect(readlineInterface.close).toHaveBeenCalled();
	});

	it('rejects blank pasted tokens', async () => {
		await expect(
			runOnePasswordAuthCommand({
				dependencies: {
					createReadlineInterface: () =>
						({
							close: vi.fn(),
							question: vi.fn(async () => '   '),
						}) as never,
					stdinIsTty: () => true,
					storeServiceAccountToken: vi.fn(),
				},
				io: createIo().io,
				systemConfig: createSystemConfig(),
			}),
		).rejects.toThrow('1Password service account token is empty.');
	});
});
