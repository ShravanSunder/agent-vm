import { describe, expect, it, vi } from 'vitest';

import type { SystemConfig } from '../features/controller/system-config.js';
import { runAgentVmCli } from './agent-vm.js';

describe('runAgentVmCli', () => {
	it('routes doctor and status subcommands to their handlers', async () => {
		const outputs: string[] = [];

		await runAgentVmCli(
			['controller', 'doctor'],
			{
				stderr: {
					write: () => true,
				},
				stdout: {
					write: (chunk: string | Uint8Array) => {
						outputs.push(String(chunk));
						return true;
					},
				},
			},
			{
				buildControllerStatus: () => ({
					controllerPort: 18800,
					toolProfiles: ['standard'],
					zones: [],
				}),
				createControllerClient: () => ({
					destroyZone: async () => ({ ok: true, zoneId: 'shravan' }),
					getLogs: async () => ({ output: '', zoneId: 'shravan' }),
					getStatus: async () => ({
						controllerPort: 18800,
						toolProfiles: ['standard'],
						zones: [],
					}),
					listLeases: async () => [],
					refreshCredentials: async () => ({ ok: true, zoneId: 'shravan' }),
					releaseLease: async () => {},
					stop: async () => ({ ok: true }),
					upgradeZone: async () => ({ ok: true, zoneId: 'shravan' }),
				}),
				createAgeEncryption: () => ({ encrypt: async () => {}, decrypt: async () => {} }),
				createSecretResolver: async () => ({
					resolve: async () => '',
					resolveAll: async () => ({}),
				}),
				createSnapshotManager: () => ({
					createSnapshot: async () => ({ snapshotPath: '', timestamp: '', zoneId: '' }),
					restoreSnapshot: async () => ({ stateDir: '', workspaceDir: '', zoneId: '' }),
					listSnapshots: () => [],
				}),
				resolveServiceAccountToken: async () => 'mock-token',
				loadSystemConfig: () => ({
					host: {
						controllerPort: 18800,
						secretsProvider: {
							type: '1password',
							tokenSource: { type: 'env', envVar: 'OP_SERVICE_ACCOUNT_TOKEN' },
						},
					},
					images: {
						gateway: {
							buildConfig: './images/gateway/build-config.json',
							postBuild: [],
						},
						tool: {
							buildConfig: './images/tool/build-config.json',
							postBuild: [],
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
							workspaceRoot: './workspaces/tools',
						},
					},
					zones: [],
				}),
				runControllerDoctor: () => ({
					checks: [],
					ok: true,
				}),
				startControllerRuntime: vi.fn(
					async () =>
						({
							controllerPort: 18800,
							gateway: {
								ingress: {
									host: '127.0.0.1',
									port: 18791,
								},
								vm: {
									id: 'vm-123',
								},
							},
							close: async () => {},
						}) as never,
				),
				resolveServiceAccountToken: async () => 'mock-token',
				startGatewayZone: vi.fn(async () => undefined as never),
			},
		);
		await runAgentVmCli(
			['controller', 'status'],
			{
				stderr: {
					write: () => true,
				},
				stdout: {
					write: (chunk: string | Uint8Array) => {
						outputs.push(String(chunk));
						return true;
					},
				},
			},
			{
				buildControllerStatus: () => ({
					controllerPort: 18800,
					toolProfiles: ['standard'],
					zones: [],
				}),
				createControllerClient: () => ({
					destroyZone: async () => ({ ok: true, zoneId: 'shravan' }),
					getLogs: async () => ({ output: '', zoneId: 'shravan' }),
					getStatus: async () => ({
						controllerPort: 18800,
						toolProfiles: ['standard'],
						zones: [],
					}),
					listLeases: async () => [],
					refreshCredentials: async () => ({ ok: true, zoneId: 'shravan' }),
					releaseLease: async () => {},
					stop: async () => ({ ok: true }),
					upgradeZone: async () => ({ ok: true, zoneId: 'shravan' }),
				}),
				createAgeEncryption: () => ({ encrypt: async () => {}, decrypt: async () => {} }),
				createSecretResolver: async () => ({
					resolve: async () => '',
					resolveAll: async () => ({}),
				}),
				createSnapshotManager: () => ({
					createSnapshot: async () => ({ snapshotPath: '', timestamp: '', zoneId: '' }),
					restoreSnapshot: async () => ({ stateDir: '', workspaceDir: '', zoneId: '' }),
					listSnapshots: () => [],
				}),
				resolveServiceAccountToken: async () => 'mock-token',
				loadSystemConfig: () => ({
					host: {
						controllerPort: 18800,
						secretsProvider: {
							type: '1password',
							tokenSource: { type: 'env', envVar: 'OP_SERVICE_ACCOUNT_TOKEN' },
						},
					},
					images: {
						gateway: {
							buildConfig: './images/gateway/build-config.json',
							postBuild: [],
						},
						tool: {
							buildConfig: './images/tool/build-config.json',
							postBuild: [],
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
							workspaceRoot: './workspaces/tools',
						},
					},
					zones: [],
				}),
				runControllerDoctor: () => ({
					checks: [],
					ok: true,
				}),
				startControllerRuntime: vi.fn(
					async () =>
						({
							controllerPort: 18800,
							gateway: {
								ingress: {
									host: '127.0.0.1',
									port: 18791,
								},
								vm: {
									id: 'vm-123',
								},
							},
							close: async () => {},
						}) as never,
				),
				resolveServiceAccountToken: async () => 'mock-token',
				startGatewayZone: vi.fn(async () => undefined as never),
			},
		);

		expect(outputs.join('\n')).toContain('"ok": true');
		expect(outputs.join('\n')).toContain('"controllerPort": 18800');
	});

	it('passes the bundled gondolin plugin source path into controller start', async () => {
		const startControllerRuntime = vi.fn(
			async () =>
				({
					controllerPort: 18800,
					gateway: {
						ingress: {
							host: '127.0.0.1',
							port: 18791,
						},
						vm: {
							id: 'vm-123',
						},
					},
					close: async () => {},
				}) as never,
		);

		process.env.OP_SERVICE_ACCOUNT_TOKEN = 'token';

		await runAgentVmCli(
			['controller', 'start'],
			{
				stderr: {
					write: () => true,
				},
				stdout: {
					write: () => true,
				},
			},
			{
				buildControllerStatus: () => ({
					controllerPort: 18800,
					toolProfiles: ['standard'],
					zones: [],
				}),
				createControllerClient: () => ({
					destroyZone: async () => ({ ok: true, zoneId: 'shravan' }),
					getLogs: async () => ({ output: '', zoneId: 'shravan' }),
					getStatus: async () => ({
						controllerPort: 18800,
						toolProfiles: ['standard'],
						zones: [],
					}),
					listLeases: async () => [],
					refreshCredentials: async () => ({ ok: true, zoneId: 'shravan' }),
					releaseLease: async () => {},
					stop: async () => ({ ok: true }),
					upgradeZone: async () => ({ ok: true, zoneId: 'shravan' }),
				}),
				createAgeEncryption: () => ({ encrypt: async () => {}, decrypt: async () => {} }),
				createSecretResolver: async () => ({
					resolve: async () => '',
					resolveAll: async () => ({}),
				}),
				createSnapshotManager: () => ({
					createSnapshot: async () => ({ snapshotPath: '', timestamp: '', zoneId: '' }),
					restoreSnapshot: async () => ({ stateDir: '', workspaceDir: '', zoneId: '' }),
					listSnapshots: () => [],
				}),
				resolveServiceAccountToken: async () => 'mock-token',
				loadSystemConfig: () => ({
					host: {
						controllerPort: 18800,
						secretsProvider: {
							type: '1password',
							tokenSource: { type: 'env', envVar: 'OP_SERVICE_ACCOUNT_TOKEN' },
						},
					},
					images: {
						gateway: {
							buildConfig: './images/gateway/build-config.json',
							postBuild: [],
						},
						tool: {
							buildConfig: './images/tool/build-config.json',
							postBuild: [],
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
							workspaceRoot: './workspaces/tools',
						},
					},
					zones: [
						{
							allowedHosts: ['api.anthropic.com'],
							gateway: {
								cpus: 2,
								memory: '2G',
								openclawConfig: './config/shravan/openclaw.json',
								port: 18791,
								stateDir: './state/shravan',
								workspaceDir: './workspaces/shravan',
							},
							id: 'shravan',
							secrets: {},
							toolProfile: 'standard',
						},
					],
				}),
				runControllerDoctor: () => ({
					checks: [],
					ok: true,
				}),
				startControllerRuntime,
				resolveServiceAccountToken: async () => 'mock-token',
				startGatewayZone: vi.fn(async () => undefined as never),
			},
		);

		expect(startControllerRuntime).toHaveBeenCalledWith(
			expect.objectContaining({
				pluginSourceDir: expect.stringMatching(/openclaw-agent-vm-plugin\/dist\/?$/u),
				zoneId: 'shravan',
			}),
		);
	});

	it('routes controller operation subcommands through the controller client', async () => {
		const outputs: string[] = [];
		const controllerClient = {
			destroyZone: vi.fn(async () => ({ ok: true, purged: true, zoneId: 'shravan' })),
			getLogs: vi.fn(async () => ({ output: 'logs', zoneId: 'shravan' })),
			getStatus: vi.fn(async () => ({
				controllerPort: 18800,
				toolProfiles: ['standard'],
				zones: [{ id: 'shravan', ingressPort: 18791, toolProfile: 'standard' }],
			})),
			listLeases: vi.fn(async () => []),
			refreshCredentials: vi.fn(async () => ({ ok: true, zoneId: 'shravan' })),
			releaseLease: vi.fn(async () => {}),
			stop: vi.fn(async () => ({ ok: true })),
			upgradeZone: vi.fn(async () => ({ ok: true, zoneId: 'shravan' })),
		};

		const baseDependencies = {
			buildControllerStatus: () => ({
				controllerPort: 18800,
				toolProfiles: ['standard'],
				zones: [],
			}),
			createAgeEncryption: () => ({ encrypt: async () => {}, decrypt: async () => {} }),
			createControllerClient: () => controllerClient,
			createSecretResolver: async () => ({
				resolve: async () => '',
				resolveAll: async () => ({}),
			}),
			createSnapshotManager: () => ({
				createSnapshot: async () => ({ snapshotPath: '', timestamp: '', zoneId: '' }),
				restoreSnapshot: async () => ({ stateDir: '', workspaceDir: '', zoneId: '' }),
				listSnapshots: () => [],
			}),
			resolveServiceAccountToken: async () => 'mock-token',
			loadSystemConfig: (): SystemConfig => ({
				host: {
					controllerPort: 18800,
					secretsProvider: {
						type: '1password',
						tokenSource: { type: 'env', envVar: 'OP_SERVICE_ACCOUNT_TOKEN' },
					},
				},
				images: {
					gateway: {
						buildConfig: './images/gateway/build-config.json',
						postBuild: [],
					},
					tool: {
						buildConfig: './images/tool/build-config.json',
						postBuild: [],
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
						workspaceRoot: './workspaces/tools',
					},
				},
				zones: [
					{
						allowedHosts: ['api.anthropic.com'],
						gateway: {
							cpus: 2,
							memory: '2G',
							openclawConfig: './config/shravan/openclaw.json',
							port: 18791,
							stateDir: './state/shravan',
							workspaceDir: './workspaces/shravan',
						},
						id: 'shravan',
						secrets: {},
						toolProfile: 'standard',
					},
				],
			}),
			runControllerDoctor: () => ({
				checks: [],
				ok: true,
			}),
			startControllerRuntime: vi.fn(async () => ({
				controllerPort: 18800,
				gateway: {
					ingress: {
						host: '127.0.0.1',
						port: 18791,
					},
					vm: {
						id: 'vm-123',
					},
				},
			})),
			startGatewayZone: vi.fn(async () => undefined as never),
		};

		for (const command of [
			['controller', 'status'],
			['controller', 'logs', '--zone', 'shravan'],
			['controller', 'destroy', '--zone', 'shravan', '--purge'],
			['controller', 'upgrade', '--zone', 'shravan'],
			['controller', 'credentials', 'refresh', '--zone', 'shravan'],
		] as const) {
			await runAgentVmCli(
				command,
				{
					stderr: {
						write: () => true,
					},
					stdout: {
						write: (chunk: string | Uint8Array) => {
							outputs.push(String(chunk));
							return true;
						},
					},
				},
				baseDependencies,
			);
		}

		expect(controllerClient.getStatus).toHaveBeenCalled();
		expect(controllerClient.getLogs).toHaveBeenCalledWith('shravan');
		expect(controllerClient.destroyZone).toHaveBeenCalledWith('shravan', true);
		expect(controllerClient.upgradeZone).toHaveBeenCalledWith('shravan');
		expect(controllerClient.refreshCredentials).toHaveBeenCalledWith('shravan');
		expect(outputs.join('\n')).toContain('"zoneId": "shravan"');
	});

	it('routes snapshot list through the snapshot manager', async () => {
		const outputs: string[] = [];
		const listSnapshots = vi.fn(() => [
			{ snapshotPath: '/state/shravan/snapshots/shravan-2026-04-06.tar.age', timestamp: '2026-04-06', zoneId: 'shravan' },
		]);

		await runAgentVmCli(
			['controller', 'snapshot', 'list', '--zone', 'shravan'],
			{
				stderr: { write: () => true },
				stdout: {
					write: (chunk: string | Uint8Array) => {
						outputs.push(String(chunk));
						return true;
					},
				},
			},
			{
				buildControllerStatus: () => ({ controllerPort: 18800, toolProfiles: ['standard'], zones: [] }),
				createAgeEncryption: () => ({ encrypt: async () => {}, decrypt: async () => {} }),
				createControllerClient: () => ({
					destroyZone: async () => ({}),
					getLogs: async () => ({}),
					getStatus: async () => ({}),
					listLeases: async () => [],
					refreshCredentials: async () => ({}),
					releaseLease: async () => {},
					stop: async () => ({}),
					upgradeZone: async () => ({}),
				}),
				createSecretResolver: async () => ({
					resolve: async () => '',
					resolveAll: async () => ({}),
				}),
				createSnapshotManager: () => ({
					createSnapshot: async () => ({ snapshotPath: '', timestamp: '', zoneId: '' }),
					restoreSnapshot: async () => ({ stateDir: '', workspaceDir: '', zoneId: '' }),
					listSnapshots,
				}),
				loadSystemConfig: () => ({
					host: { controllerPort: 18800, secretsProvider: { type: '1password', tokenSource: { type: 'env', envVar: 'OP_SERVICE_ACCOUNT_TOKEN' } } },
					images: { gateway: { buildConfig: '', postBuild: [] }, tool: { buildConfig: '', postBuild: [] } },
					tcpPool: { basePort: 19000, size: 5 },
					toolProfiles: { standard: { cpus: 1, memory: '1G', workspaceRoot: './workspaces/tools' } },
					zones: [{ allowedHosts: ['api.anthropic.com'], gateway: { cpus: 2, memory: '2G', openclawConfig: './config/shravan/openclaw.json', port: 18791, stateDir: './state/shravan', workspaceDir: './workspaces/shravan' }, id: 'shravan', secrets: {}, toolProfile: 'standard' }],
				}),
				runControllerDoctor: () => ({ checks: [], ok: true }),
				startControllerRuntime: vi.fn(async () => ({ controllerPort: 18800, gateway: { ingress: { host: '127.0.0.1', port: 18791 }, vm: { id: 'vm-1' } } })),
				resolveServiceAccountToken: async () => 'mock-token',
				startGatewayZone: vi.fn(async () => undefined as never),
			},
		);

		expect(listSnapshots).toHaveBeenCalledWith(
			expect.objectContaining({ snapshotDir: './state/shravan/snapshots', zoneId: 'shravan' }),
		);
		expect(outputs.join('')).toContain('shravan-2026-04-06.tar.age');
	});

	it('routes snapshot create through the snapshot manager with 1P passphrase', async () => {
		const outputs: string[] = [];
		const createSnapshot = vi.fn(async () => ({
			snapshotPath: './state/shravan/snapshots/shravan-2026-04-06T12-00.tar.age',
			timestamp: '2026-04-06T12-00',
			zoneId: 'shravan',
		}));
		const resolvePassphraseCalls: string[] = [];

		process.env.OP_SERVICE_ACCOUNT_TOKEN = 'test-token';

		await runAgentVmCli(
			['controller', 'snapshot', 'create', '--zone', 'shravan'],
			{
				stderr: { write: () => true },
				stdout: {
					write: (chunk: string | Uint8Array) => {
						outputs.push(String(chunk));
						return true;
					},
				},
			},
			{
				buildControllerStatus: () => ({ controllerPort: 18800, toolProfiles: ['standard'], zones: [] }),
				createAgeEncryption: (deps) => {
					// Capture the passphrase resolver to verify the 1P ref pattern
					void deps.resolvePassphrase().then((passphrase) => resolvePassphraseCalls.push(passphrase));
					return { encrypt: async () => {}, decrypt: async () => {} };
				},
				createControllerClient: () => ({
					destroyZone: async () => ({}),
					getLogs: async () => ({}),
					getStatus: async () => ({}),
					listLeases: async () => [],
					refreshCredentials: async () => ({}),
					releaseLease: async () => {},
					stop: async () => ({}),
					upgradeZone: async () => ({}),
				}),
				createSecretResolver: async () => ({
					resolve: async (ref: { ref: string }) => {
						// Verify the 1P ref pattern
						expect(ref.ref).toBe('op://agent-vm/agent-shravan-snapshot/password');
						return 'resolved-passphrase';
					},
					resolveAll: async () => ({}),
				}),
				createSnapshotManager: () => ({
					createSnapshot,
					restoreSnapshot: async () => ({ stateDir: '', workspaceDir: '', zoneId: '' }),
					listSnapshots: () => [],
				}),
				loadSystemConfig: () => ({
					host: { controllerPort: 18800, secretsProvider: { type: '1password', tokenSource: { type: 'env', envVar: 'OP_SERVICE_ACCOUNT_TOKEN' } } },
					images: { gateway: { buildConfig: '', postBuild: [] }, tool: { buildConfig: '', postBuild: [] } },
					tcpPool: { basePort: 19000, size: 5 },
					toolProfiles: { standard: { cpus: 1, memory: '1G', workspaceRoot: './workspaces/tools' } },
					zones: [{ allowedHosts: ['api.anthropic.com'], gateway: { cpus: 2, memory: '2G', openclawConfig: './config/shravan/openclaw.json', port: 18791, stateDir: './state/shravan', workspaceDir: './workspaces/shravan' }, id: 'shravan', secrets: {}, toolProfile: 'standard' }],
				}),
				runControllerDoctor: () => ({ checks: [], ok: true }),
				startControllerRuntime: vi.fn(async () => ({ controllerPort: 18800, gateway: { ingress: { host: '127.0.0.1', port: 18791 }, vm: { id: 'vm-1' } } })),
				resolveServiceAccountToken: async () => 'mock-token',
				startGatewayZone: vi.fn(async () => undefined as never),
			},
		);

		expect(createSnapshot).toHaveBeenCalledWith(
			expect.objectContaining({
				zoneId: 'shravan',
				stateDir: './state/shravan',
				workspaceDir: './workspaces/shravan',
				snapshotDir: './state/shravan/snapshots',
			}),
		);
		expect(outputs.join('')).toContain('shravan-2026-04-06T12-00.tar.age');
	});
});
