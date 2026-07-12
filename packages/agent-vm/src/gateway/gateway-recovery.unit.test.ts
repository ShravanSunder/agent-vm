import { describe, expect, it, vi } from 'vitest';

import type { GatewayOwnershipUnsafeError } from './gateway-ownership-evidence.js';
import {
	checkMissingGatewayRuntimeRecordPortPreflight,
	cleanupRecordedGatewayRuntime,
} from './gateway-recovery.js';
import type {
	GatewayRuntimeRecord,
	GatewayRuntimeRecordLoadResult,
} from './gateway-runtime-record.js';

const matchingProcessIdentity = {
	command: 'qemu-system-aarch64 -m 4G -smp 4 -kernel /vm-images/gateway/kernel',
	lstart: 'Mon Apr 13 12:34:56 2026',
};

function createGatewayRuntimeRecord(
	overrides: Partial<GatewayRuntimeRecord> = {},
): GatewayRuntimeRecord {
	return {
		configPath: '/deployments/shravan-claw/config/system.jsonc',
		controllerPort: 18_800,
		createdAt: '2026-04-13T12:34:56.000Z',
		gateway: {
			bootId: 'boot-a',
			controllerEpoch: 'controller-epoch-a',
			gatewayEpochId: 'gateway-epoch-a',
			gatewayVmId: 'gateway-vm-123',
			generationId: 'generation-a',
			zoneId: 'shravan',
		},
		gatewayType: 'openclaw',
		guestListenPort: 18_789,
		ingressPort: 18_791,
		processIdentity: matchingProcessIdentity,
		projectNamespace: 'claw-tests-a1b2c3d4',
		qemuPid: 48_282,
		schemaVersion: 2,
		sessionLabel: 'claw-tests-a1b2c3d4:shravan:gateway',
		vmId: 'gateway-vm-123',
		zoneId: 'shravan',
		...overrides,
	};
}

function loadedGatewayRuntimeRecord(record: GatewayRuntimeRecord): GatewayRuntimeRecordLoadResult {
	return {
		kind: 'loaded',
		path: `/state/${record.zoneId}/gateway-runtime.json`,
		record,
	};
}

function createGatewayRecoveryOptions(
	overrides: Partial<Parameters<typeof cleanupRecordedGatewayRuntime>[0]> = {},
): Parameters<typeof cleanupRecordedGatewayRuntime>[0] {
	return {
		expectedConfigPath: '/deployments/shravan-claw/config/system.jsonc',
		expectedControllerPort: 18_800,
		projectNamespace: 'claw-tests-a1b2c3d4',
		stateDir: '/state/shravan',
		zoneId: 'shravan',
		...overrides,
	};
}

async function matchingIdentityResolver(): Promise<{ command: string; lstart: string }> {
	return matchingProcessIdentity;
}

describe('cleanupRecordedGatewayRuntime', () => {
	it('returns no cleanup when no runtime record exists', async () => {
		await expect(
			cleanupRecordedGatewayRuntime(createGatewayRecoveryOptions(), {
				loadGatewayRuntimeRecordResult: async () => ({
					kind: 'missing',
					path: '/state/shravan/gateway-runtime.json',
				}),
			}),
		).resolves.toEqual({ cleanedUp: false, killedPid: null });
	});

	it('reports clear missing-record ingress preflight when the configured port is free', async () => {
		await expect(
			checkMissingGatewayRuntimeRecordPortPreflight({
				gatewayIngressPort: 18_791,
				readTcpListenPortOwner: async () => null,
			}),
		).resolves.toEqual({ kind: 'clear' });
	});

	it('reports clear missing-record ingress preflight when the current controller owns the configured port', async () => {
		await expect(
			checkMissingGatewayRuntimeRecordPortPreflight({
				expectedControllerPid: process.pid,
				gatewayIngressPort: 18_791,
				readTcpListenPortOwner: async () => ({
					command: 'node agent-vm controller start',
					pid: process.pid,
				}),
			}),
		).resolves.toEqual({ kind: 'clear' });
	});

	it('reports owner-unsafe evidence when the runtime record is missing and configured ingress port is occupied', async () => {
		await expect(
			checkMissingGatewayRuntimeRecordPortPreflight({
				gatewayIngressPort: 18_791,
				readTcpListenPortOwner: async () => ({
					command: 'qemu-system-aarch64 -m 4G',
					pid: 98_765,
				}),
			}),
		).resolves.toEqual({
			evidence: {
				kind: 'missing-record-port-owned',
				ownerCommand: 'qemu-system-aarch64 -m 4G',
				ownerPid: 98_765,
				port: 18_791,
			},
			kind: 'blocked',
		});
	});

	it('blocks cold-start cleanup when the runtime record is missing and configured ingress port is occupied', async () => {
		const killProcess = vi.fn();

		await expect(
			cleanupRecordedGatewayRuntime(
				createGatewayRecoveryOptions({
					configuredIngressPort: 18_791,
					mode: 'in-process-recovery',
				}),
				{
					killProcess,
					loadGatewayRuntimeRecordResult: async () => ({
						kind: 'missing',
						path: '/state/shravan/gateway-runtime.json',
					}),
					readTcpListenPortOwner: async () => ({
						command: 'qemu-system-aarch64 -m 4G',
						pid: 98_765,
					}),
				},
			),
		).rejects.toMatchObject({
			evidence: {
				kind: 'missing-record-port-owned',
				ownerCommand: 'qemu-system-aarch64 -m 4G',
				ownerPid: 98_765,
				port: 18_791,
			},
		} satisfies Pick<GatewayOwnershipUnsafeError, 'evidence'>);
		expect(killProcess).not.toHaveBeenCalled();
	});

	it('warns and skips malformed records during in-process recovery without mutating', async () => {
		const logMessages: string[] = [];

		await expect(
			cleanupRecordedGatewayRuntime(createGatewayRecoveryOptions({ mode: 'in-process-recovery' }), {
				loadGatewayRuntimeRecordResult: async () => ({
					error: new Error('expected schemaVersion'),
					kind: 'parse-error',
					path: '/state/shravan/gateway-runtime.json',
				}),
				log: (message) => {
					logMessages.push(message);
				},
			}),
		).resolves.toEqual({
			cleanedUp: false,
			cleanupWarning: expect.stringContaining('Malformed gateway runtime record'),
			killedPid: null,
			ownershipEvidence: {
				kind: 'record-parse-error',
				message: 'expected schemaVersion',
				path: '/state/shravan/gateway-runtime.json',
			},
		});
		expect(logMessages.join('\n')).toContain('Malformed gateway runtime record');
	});

	it('throws on malformed records during offline cleanup', async () => {
		await expect(
			cleanupRecordedGatewayRuntime(createGatewayRecoveryOptions({ mode: 'offline-cleanup' }), {
				loadGatewayRuntimeRecordResult: async () => ({
					error: new Error('expected schemaVersion'),
					kind: 'parse-error',
					path: '/state/shravan/gateway-runtime.json',
				}),
			}),
		).rejects.toThrow(/Malformed gateway runtime record/u);
	});

	it('refuses to clean up a runtime record from another project namespace', async () => {
		await expect(
			cleanupRecordedGatewayRuntime(createGatewayRecoveryOptions(), {
				deleteGatewayRuntimeRecord: vi.fn(async () => {}),
				isProcessAlive: () => true,
				killProcess: vi.fn(),
				loadGatewayRuntimeRecordResult: async () =>
					loadedGatewayRuntimeRecord(
						createGatewayRuntimeRecord({
							projectNamespace: 'shravan-claw-463c3e5f',
							sessionLabel: 'shravan-claw-463c3e5f:shravan:gateway',
						}),
					),
				readTcpListenPortOwner: async () => ({ command: 'qemu-system-aarch64', pid: 48_282 }),
				sleep: async () => {},
			}),
		).rejects.toThrow(/belongs to projectNamespace 'shravan-claw-463c3e5f'/u);
	});

	it('skips mismatched records during in-process recovery without signaling the process', async () => {
		const logMessages: string[] = [];
		const killProcess = vi.fn();

		await expect(
			cleanupRecordedGatewayRuntime(
				createGatewayRecoveryOptions({
					mode: 'in-process-recovery',
					projectNamespace: 'shravan-claw-beta-25319b68',
					stateDir: '/state/beta',
					zoneId: 'beta',
				}),
				{
					deleteGatewayRuntimeRecord: vi.fn(async () => {}),
					isProcessAlive: () => true,
					killProcess,
					loadGatewayRuntimeRecordResult: async () =>
						loadedGatewayRuntimeRecord(
							createGatewayRuntimeRecord({
								projectNamespace: 'shravan-claw-463c3e5f',
								sessionLabel: 'shravan-claw-463c3e5f:sunfam:gateway',
								zoneId: 'sunfam',
							}),
						),
					log: (message) => {
						logMessages.push(message);
					},
					readTcpListenPortOwner: async () => ({
						command: 'qemu-system-aarch64',
						pid: 48_282,
					}),
					sleep: async () => {},
				},
			),
		).resolves.toEqual({
			cleanedUp: false,
			cleanupWarning: expect.stringContaining('Skipping the stale runtime record'),
			killedPid: null,
			ownershipEvidence: {
				actualScope: 'projectNamespace:shravan-claw-463c3e5f',
				expectedScope: 'projectNamespace:shravan-claw-beta-25319b68',
				kind: 'record-scope-mismatch',
			},
		});

		expect(killProcess).not.toHaveBeenCalled();
		expect(logMessages.join('\n')).toContain('projectNamespace');
	});

	it.each([
		{
			expectedReason: /belongs to configPath '/u,
			fixture: { configPath: '/deployments/other/config/system.jsonc' },
			label: 'configPath fence',
		},
		{
			expectedReason: /belongs to controllerPort '19999'/u,
			fixture: { controllerPort: 19_999 },
			label: 'controllerPort fence',
		},
	])(
		'skips gateway cleanup on $label mismatch during in-process recovery',
		async ({ expectedReason, fixture }) => {
			const deleteGatewayRuntimeRecord = vi.fn(async () => {});
			const killProcess = vi.fn();

			await expect(
				cleanupRecordedGatewayRuntime(
					createGatewayRecoveryOptions({ mode: 'in-process-recovery' }),
					{
						deleteGatewayRuntimeRecord,
						killProcess,
						loadGatewayRuntimeRecordResult: async () =>
							loadedGatewayRuntimeRecord(createGatewayRuntimeRecord(fixture)),
						readTcpListenPortOwner: async () => ({ command: 'qemu-system-aarch64', pid: 48_282 }),
					},
				),
			).resolves.toEqual({
				cleanedUp: false,
				cleanupWarning: expect.stringMatching(expectedReason),
				killedPid: null,
				ownershipEvidence: expect.objectContaining({
					kind: 'record-scope-mismatch',
				}),
			});
			expect(killProcess).not.toHaveBeenCalled();
			expect(deleteGatewayRuntimeRecord).not.toHaveBeenCalled();
		},
	);

	it('skips gateway recovery when the ingress port is held by a different pid during startup recovery', async () => {
		const killProcess = vi.fn();
		const logMessages: string[] = [];

		await expect(
			cleanupRecordedGatewayRuntime(createGatewayRecoveryOptions({ mode: 'in-process-recovery' }), {
				killProcess,
				loadGatewayRuntimeRecordResult: async () =>
					loadedGatewayRuntimeRecord(
						createGatewayRuntimeRecord({ ingressPort: 18_891, qemuPid: 111 }),
					),
				log: (message) => {
					logMessages.push(message);
				},
				readTcpListenPortOwner: async () => ({ command: 'qemu-system-aarch64', pid: 222 }),
			}),
		).resolves.toEqual({
			cleanedUp: false,
			cleanupWarning: expect.stringContaining('held by pid 222'),
			killedPid: null,
			ownershipEvidence: {
				expectedPid: 111,
				kind: 'port-owner-mismatch',
				ownerPid: 222,
				port: 18_891,
			},
		});
		expect(killProcess).not.toHaveBeenCalled();
		expect(logMessages.join('\n')).toContain('held by pid 222');
	});

	it('throws in offline cleanup when the gateway ingress port is held by a different pid', async () => {
		const killProcess = vi.fn();

		await expect(
			cleanupRecordedGatewayRuntime(createGatewayRecoveryOptions({ mode: 'offline-cleanup' }), {
				killProcess,
				loadGatewayRuntimeRecordResult: async () =>
					loadedGatewayRuntimeRecord(
						createGatewayRuntimeRecord({ ingressPort: 18_891, qemuPid: 111 }),
					),
				readTcpListenPortOwner: async () => ({ command: 'qemu-system-aarch64', pid: 222 }),
			}),
		).rejects.toThrow(/port 18891 is held by pid 222/u);
		expect(killProcess).not.toHaveBeenCalled();
	});

	it('deletes a stale gateway record during in-process recovery when the current controller owns ingress', async () => {
		const deleteGatewayRuntimeRecord = vi.fn(async () => {});
		const killProcess = vi.fn();
		const record = createGatewayRuntimeRecord({ ingressPort: 18_891, qemuPid: 111 });

		await expect(
			cleanupRecordedGatewayRuntime(createGatewayRecoveryOptions({ mode: 'in-process-recovery' }), {
				deleteGatewayRuntimeRecord,
				isProcessAlive: () => false,
				killProcess,
				loadGatewayRuntimeRecordResult: async () => loadedGatewayRuntimeRecord(record),
				readTcpListenPortOwner: async () => ({
					command: 'node agent-vm controller start',
					pid: process.pid,
				}),
			}),
		).resolves.toEqual({
			cleanedUp: true,
			killedPid: null,
		});
		expect(killProcess).not.toHaveBeenCalled();
		expect(deleteGatewayRuntimeRecord).toHaveBeenCalledWith('/state/shravan');
	});

	it('kills the recorded gateway process before deleting when its ingress port is already free', async () => {
		const deleteGatewayRuntimeRecord = vi.fn(async () => {});
		const killProcess = vi.fn();
		const record = createGatewayRuntimeRecord({ qemuPid: 111 });
		const isProcessAlive = vi
			.fn()
			.mockReturnValueOnce(true)
			.mockReturnValueOnce(true)
			.mockReturnValueOnce(false);

		await expect(
			cleanupRecordedGatewayRuntime(createGatewayRecoveryOptions(), {
				deleteGatewayRuntimeRecord,
				isProcessAlive,
				killProcess,
				loadGatewayRuntimeRecordResult: async () => loadedGatewayRuntimeRecord(record),
				readProcessCommand: async () => 'qemu-system-aarch64 -nodefaults',
				readProcessIdentity: async () => record.processIdentity,
				readTcpListenPortOwner: async () => null,
				sleep: async () => {},
			}),
		).resolves.toEqual({
			cleanedUp: true,
			killedPid: 111,
		});
		expect(killProcess).toHaveBeenCalledWith(111, 'SIGTERM');
		expect(deleteGatewayRuntimeRecord).toHaveBeenCalledWith('/state/shravan');
	});

	it('kills an early persisted gateway process when ingress has not been established', async () => {
		const deleteGatewayRuntimeRecord = vi.fn(async () => {});
		const killProcess = vi.fn();
		const record = createGatewayRuntimeRecord({ ingressPort: undefined, qemuPid: 111 });
		const isProcessAlive = vi
			.fn()
			.mockReturnValueOnce(true)
			.mockReturnValueOnce(true)
			.mockReturnValueOnce(false);
		const readTcpListenPortOwner = vi.fn();

		await expect(
			cleanupRecordedGatewayRuntime(createGatewayRecoveryOptions(), {
				deleteGatewayRuntimeRecord,
				isProcessAlive,
				killProcess,
				loadGatewayRuntimeRecordResult: async () => loadedGatewayRuntimeRecord(record),
				readProcessCommand: async () => 'qemu-system-aarch64 -nodefaults',
				readProcessIdentity: async () => record.processIdentity,
				readTcpListenPortOwner,
				sleep: async () => {},
			}),
		).resolves.toEqual({
			cleanedUp: true,
			killedPid: 111,
		});
		expect(readTcpListenPortOwner).not.toHaveBeenCalled();
		expect(killProcess).toHaveBeenCalledWith(111, 'SIGTERM');
		expect(deleteGatewayRuntimeRecord).toHaveBeenCalledWith('/state/shravan');
	});

	it('refuses to delete a port-free gateway record when the recorded pid was reused', async () => {
		const deleteGatewayRuntimeRecord = vi.fn(async () => {});
		const killProcess = vi.fn();

		await expect(
			cleanupRecordedGatewayRuntime(createGatewayRecoveryOptions(), {
				deleteGatewayRuntimeRecord,
				isProcessAlive: () => true,
				killProcess,
				loadGatewayRuntimeRecordResult: async () =>
					loadedGatewayRuntimeRecord(createGatewayRuntimeRecord({ qemuPid: 111 })),
				readProcessCommand: async () => 'node /tmp/not-gateway.js',
				readProcessIdentity: async () => ({
					command: 'node /tmp/not-gateway.js',
					lstart: 'Tue Apr 14 15:00:00 2026',
				}),
				readTcpListenPortOwner: async () => null,
				sleep: async () => {},
			}),
		).rejects.toThrow(/refusing SIGTERM to pid 111: process identity changed/u);
		expect(killProcess).not.toHaveBeenCalled();
		expect(deleteGatewayRuntimeRecord).not.toHaveBeenCalled();
	});

	it('terminates an owned recorded qemu process, deletes the runtime record, and reports cleanup', async () => {
		const logMessages: string[] = [];
		const readProcessCommand = vi.fn(async () => 'qemu-system-aarch64 -nodefaults');
		const isProcessAlive = vi
			.fn()
			.mockReturnValueOnce(true)
			.mockReturnValueOnce(true)
			.mockReturnValueOnce(false);
		const killProcess = vi.fn();
		const deleteGatewayRuntimeRecord = vi.fn(async () => {});

		await expect(
			cleanupRecordedGatewayRuntime(createGatewayRecoveryOptions(), {
				deleteGatewayRuntimeRecord,
				isProcessAlive,
				killProcess,
				loadGatewayRuntimeRecordResult: async () =>
					loadedGatewayRuntimeRecord(createGatewayRuntimeRecord()),
				log: (message) => {
					logMessages.push(message);
				},
				readProcessCommand,
				readProcessIdentity: matchingIdentityResolver,
				readTcpListenPortOwner: async () => ({
					command: 'qemu-system-aarch64',
					pid: 48_282,
				}),
				sleep: async () => {},
			}),
		).resolves.toEqual({
			cleanedUp: true,
			killedPid: 48_282,
		});

		expect(killProcess).toHaveBeenNthCalledWith(1, 48_282, 'SIGTERM');
		expect(deleteGatewayRuntimeRecord).toHaveBeenCalledWith('/state/shravan');
		expect(logMessages).toEqual([
			"Found persisted gateway runtime for zone 'shravan' (pid 48282, vm gateway-vm-123).",
			"Removed stale gateway runtime record for zone 'shravan' after terminating recorded gateway pid 48282.",
		]);
	});

	it('warns and skips when the recorded pid owns the port but is not a managed VM command', async () => {
		const killProcess = vi.fn();

		await expect(
			cleanupRecordedGatewayRuntime(createGatewayRecoveryOptions({ mode: 'in-process-recovery' }), {
				killProcess,
				loadGatewayRuntimeRecordResult: async () =>
					loadedGatewayRuntimeRecord(createGatewayRuntimeRecord({ qemuPid: 111 })),
				readTcpListenPortOwner: async () => ({ command: '/usr/bin/python3', pid: 111 }),
			}),
		).resolves.toEqual({
			cleanedUp: false,
			cleanupWarning: expect.stringContaining('not a managed VM process'),
			killedPid: null,
			ownershipEvidence: {
				kind: 'unmanaged-port-owner',
				ownerCommand: '/usr/bin/python3',
				ownerPid: 111,
				port: 18_791,
			},
		});
		expect(killProcess).not.toHaveBeenCalled();
	});

	it('fails fast when the recorded pid belongs to a different process', async () => {
		const killProcess = vi.fn();

		await expect(
			cleanupRecordedGatewayRuntime(createGatewayRecoveryOptions(), {
				deleteGatewayRuntimeRecord: vi.fn(async () => {}),
				isProcessAlive: () => true,
				killProcess,
				loadGatewayRuntimeRecordResult: async () =>
					loadedGatewayRuntimeRecord(createGatewayRuntimeRecord()),
				readProcessCommand: async () => 'node /tmp/something-else.js',
				readProcessIdentity: async () => ({
					command: 'node /tmp/something-else.js',
					lstart: 'Tue Apr 14 15:00:00 2026',
				}),
				readTcpListenPortOwner: async () => ({
					command: 'qemu-system-aarch64',
					pid: 48_282,
				}),
				sleep: async () => {},
			}),
		).rejects.toThrow(/refusing SIGTERM to pid 48282: process identity changed/u);
		expect(killProcess).not.toHaveBeenCalled();
	});
});
