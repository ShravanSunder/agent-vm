import type { GatewayAuthConfig } from '@shravansunder/agent-vm-gateway-interface';
import { describe, expect, it, vi } from 'vitest';

import type { ControllerClient } from '../controller/http/controller-client.js';
import { defaultCliDependencies } from './agent-vm-cli-support.js';
import { listAuthProviders, runAuthInteractiveCommand } from './auth-interactive-command.js';

function createControllerClientStub(overrides?: {
	readonly enableZoneSsh?: ControllerClient['enableZoneSsh'];
	readonly execInZone?: ControllerClient['execInZone'];
}): ControllerClient {
	return {
		destroyZone: async () => ({}),
		enableZoneSsh: overrides?.enableZoneSsh ?? (async () => ({})),
		...(overrides?.execInZone ? { execInZone: overrides.execInZone } : {}),
		getControllerStatus: async () => ({}),
		getZoneLogs: async () => ({}),
		listLeases: async () => [],
		refreshZoneCredentials: async () => ({}),
		releaseLease: async () => {},
		stopController: async () => ({}),
		upgradeZone: async () => ({}),
	};
}

const authConfig: GatewayAuthConfig = {
	buildLoginCommand: (provider: string): string => `login --provider ${provider}`,
	listProvidersCommand: 'list-cmd',
};

describe('listAuthProviders', () => {
	it('queries over SSH and parses provider names from stdout', async () => {
		const runCommand = vi.fn(async () => ({
			exitCode: 0,
			stdout: 'codex\nopenai-codex\nanthropic\n',
			stderr: '',
		}));

		const providers = await listAuthProviders({
			listProvidersCommand: 'list-cmd',
			runCommand,
			sshAccess: {
				host: '127.0.0.1',
				identityFile: '/tmp/key',
				port: 2222,
				user: 'root',
			},
		});

		expect(providers).toEqual(['codex', 'openai-codex', 'anthropic']);
		expect(runCommand).toHaveBeenCalledWith(
			'ssh',
			expect.arrayContaining([
				'root@127.0.0.1',
				expect.stringContaining('source /etc/profile.d/openclaw-env.sh && list-cmd'),
			]),
		);
	});

	it('returns empty array when command produces no output', async () => {
		const runCommand = vi.fn(async () => ({
			exitCode: 0,
			stdout: '',
			stderr: '',
		}));

		const providers = await listAuthProviders({
			listProvidersCommand: 'list-cmd',
			runCommand,
			sshAccess: {
				host: '127.0.0.1',
				identityFile: '/tmp/key',
				port: 2222,
				user: 'root',
			},
		});

		expect(providers).toEqual([]);
	});

	it('throws when the SSH command fails', async () => {
		const runCommand = vi.fn(async () => ({
			exitCode: 255,
			stdout: '',
			stderr: 'connection refused',
		}));

		await expect(
			listAuthProviders({
				listProvidersCommand: 'list-cmd',
				runCommand,
				sshAccess: {
					host: '127.0.0.1',
					identityFile: '/tmp/key',
					port: 2222,
					user: 'root',
				},
			}),
		).rejects.toThrow('Failed to list auth providers: connection refused');
	});
});

describe('runAuthInteractiveCommand', () => {
	it('throws when the lifecycle has no authConfig', async () => {
		await expect(
			runAuthInteractiveCommand({
				authConfig: undefined,
				dependencies: {
					createControllerClient: vi.fn(),
					runInteractiveProcess: vi.fn(),
				},
				io: { stdout: { write: vi.fn(() => true) }, stderr: { write: vi.fn(() => true) } },
				provider: 'codex',
				systemConfig: {
					host: { controllerPort: 18800, projectNamespace: 'claw-tests-a1b2c3d4' },
				} as never,
				zoneId: 'test',
			}),
		).rejects.toThrow(/does not support interactive auth/i);
	});

	it('runs interactive SSH with the login command when provider is given', async () => {
		const runInteractiveProcess = vi.fn(async () => {});
		const enableZoneSsh = vi.fn(async () => ({
			host: '127.0.0.1',
			identityFile: '/tmp/key',
			port: 2222,
			user: 'root',
		}));

		await runAuthInteractiveCommand({
			authConfig,
			dependencies: {
				...defaultCliDependencies,
				createControllerClient: vi.fn(() =>
					createControllerClientStub({
						enableZoneSsh,
						execInZone: vi.fn(async () => ({
							exitCode: 0,
							stdout: '',
							stderr: '',
						})),
					}),
				),
				runInteractiveProcess,
			},
			io: { stdout: { write: vi.fn(() => true) }, stderr: { write: vi.fn(() => true) } },
			provider: 'codex',
			systemConfig: {
				host: { controllerPort: 18800, projectNamespace: 'claw-tests-a1b2c3d4' },
			} as never,
			zoneId: 'shravan',
		});

		expect(enableZoneSsh).toHaveBeenCalledWith('shravan');
		expect(runInteractiveProcess).toHaveBeenCalledWith(
			'ssh',
			expect.arrayContaining([
				'-t',
				'root@127.0.0.1',
				expect.stringContaining('source /etc/profile.d/openclaw-env.sh'),
			]),
		);
	});

	it('wraps interactive SSH failures with provider and zone context', async () => {
		const runInteractiveProcess = vi.fn(async () => {
			throw new Error('connect ECONNREFUSED');
		});
		const enableZoneSsh = vi.fn(async () => ({
			host: '127.0.0.1',
			port: 2222,
			user: 'root',
		}));

		await expect(
			runAuthInteractiveCommand({
				authConfig,
				dependencies: {
					...defaultCliDependencies,
					createControllerClient: vi.fn(() =>
						createControllerClientStub({
							enableZoneSsh,
						}),
					),
					runInteractiveProcess,
				},
				io: { stdout: { write: vi.fn(() => true) }, stderr: { write: vi.fn(() => true) } },
				provider: 'codex',
				systemConfig: {
					host: { controllerPort: 18800, projectNamespace: 'claw-tests-a1b2c3d4' },
				} as never,
				zoneId: 'shravan',
			}),
		).rejects.toThrow("Auth failed for codex in zone 'shravan': connect ECONNREFUSED");
	});
});
