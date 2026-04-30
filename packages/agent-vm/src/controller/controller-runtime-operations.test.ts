import { describe, expect, it, vi } from 'vitest';

import type { SystemConfig } from '../config/system-config.js';
import { createControllerRuntimeOperations } from './controller-runtime-operations.js';
import type { OpenClawZoneRuntime } from './zone-runtimes/zone-runtime-types.js';

const systemConfig = {
	cacheDir: './cache',
	runtimeDir: './runtime',
	host: {
		controllerPort: 18800,
		projectNamespace: 'claw-tests-a1b2c3d4',
		secretsProvider: {
			type: '1password',
			tokenSource: { type: 'env', envVar: 'OP_SERVICE_ACCOUNT_TOKEN' },
		},
	},
	imageProfiles: {
		gateways: {
			openclaw: {
				type: 'openclaw',
				buildConfig: './vm-images/gateways/openclaw/build-config.json',
			},
			worker: { type: 'worker', buildConfig: './vm-images/gateways/worker/build-config.json' },
		},
		toolVms: {
			default: { type: 'toolVm', buildConfig: './vm-images/tool-vms/default/build-config.json' },
		},
	},
	zones: [
		{
			id: 'shravan',
			gateway: {
				type: 'openclaw',
				imageProfile: 'openclaw',
				memory: '2G',
				cpus: 2,
				port: 18791,
				config: './config/shravan/openclaw.json',
				stateDir: './state/shravan',
				zoneFilesDir: './zone-files/shravan',
			},
			secrets: {},
			allowedHosts: ['api.openai.com'],
			websocketBypass: [],
			defaultToolVmProfile: 'standard',
			agentToolVmProfiles: {},
		},
		{
			id: 'alevtina',
			gateway: {
				type: 'openclaw',
				imageProfile: 'openclaw',
				memory: '2G',
				cpus: 2,
				port: 18792,
				config: './config/alevtina/openclaw.json',
				stateDir: './state/alevtina',
				zoneFilesDir: './zone-files/alevtina',
			},
			secrets: {},
			allowedHosts: ['api.openai.com'],
			websocketBypass: [],
			defaultToolVmProfile: 'standard',
			agentToolVmProfiles: {},
		},
	],
	toolVmProfiles: {
		standard: {
			memory: '1G',
			cpus: 1,
			imageProfile: 'default',
		},
	},
	tcpPool: {
		basePort: 19000,
		size: 5,
	},
} satisfies SystemConfig;

describe('createControllerRuntimeOperations', () => {
	it('dispatches OpenClaw operations to the requested zone runtime', async () => {
		const shravanRuntime = {
			destroy: vi.fn(async (purged: boolean) => ({ ok: true as const, purged, zoneId: 'shravan' })),
			enableSsh: vi.fn(async () => ({ command: 'ssh shravan', host: '127.0.0.1', port: 22 })),
			exec: vi.fn(async () => ({ exitCode: 0, stderr: '', stdout: 'shravan' })),
			getLogs: vi.fn(async () => ({ output: 'shravan logs', zoneId: 'shravan' })),
			refreshCredentials: vi.fn(async () => ({ ok: true as const, zoneId: 'shravan' })),
			upgrade: vi.fn(async () => ({ ok: true as const, zoneId: 'shravan' })),
		} satisfies Pick<
			OpenClawZoneRuntime,
			'destroy' | 'enableSsh' | 'exec' | 'getLogs' | 'refreshCredentials' | 'upgrade'
		>;
		const alevtinaRuntime = {
			destroy: vi.fn(async (purged: boolean) => ({
				ok: true as const,
				purged,
				zoneId: 'alevtina',
			})),
			enableSsh: vi.fn(async () => ({
				command: 'ssh alevtina',
				host: '127.0.0.1',
				port: 22,
			})),
			exec: vi.fn(async () => ({ exitCode: 0, stderr: '', stdout: 'alevtina' })),
			getLogs: vi.fn(async () => ({ output: 'alevtina logs', zoneId: 'alevtina' })),
			refreshCredentials: vi.fn(async () => ({ ok: true as const, zoneId: 'alevtina' })),
			upgrade: vi.fn(async () => ({ ok: true as const, zoneId: 'alevtina' })),
		} satisfies Pick<
			OpenClawZoneRuntime,
			'destroy' | 'enableSsh' | 'exec' | 'getLogs' | 'refreshCredentials' | 'upgrade'
		>;
		const operations = createControllerRuntimeOperations({
			destroyZoneRuntime: async (zoneId, purged) =>
				await (zoneId === 'shravan' ? shravanRuntime : alevtinaRuntime).destroy(purged),
			getActiveLeases: () => [],
			getOpenClawRuntime: (zoneId) => (zoneId === 'shravan' ? shravanRuntime : alevtinaRuntime),
			getRuntimeStatusByZone: () => ({
				alevtina: { lifecycleState: 'running' },
				shravan: { lifecycleState: 'running' },
			}),
			systemConfig,
		});

		await expect(operations.getZoneLogs('alevtina')).resolves.toEqual({
			output: 'alevtina logs',
			zoneId: 'alevtina',
		});
		await expect(operations.execInZone('shravan', 'pwd')).resolves.toEqual({
			exitCode: 0,
			stderr: '',
			stdout: 'shravan',
		});
		await expect(operations.destroyZone('alevtina', true)).resolves.toEqual({
			ok: true,
			purged: true,
			zoneId: 'alevtina',
		});

		expect(alevtinaRuntime.getLogs).toHaveBeenCalledTimes(1);
		expect(shravanRuntime.exec).toHaveBeenCalledWith('pwd');
		expect(alevtinaRuntime.destroy).toHaveBeenCalledWith(true);
	});
});
