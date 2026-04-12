import type { ManagedVm } from 'gondolin-core';
import { describe, expect, it, vi } from 'vitest';

import { setupGatewayVmRuntime } from './gateway-vm-setup.js';

describe('setupGatewayVmRuntime', () => {
	it('writes the environment profile without running CA updates or plugin copy', async () => {
		const execCalls: string[] = [];
		const managedVm: ManagedVm = {
			id: 'gateway-vm',
			close: vi.fn(async () => {}),
			enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
			enableSsh: vi.fn(async () => ({ host: '127.0.0.1', port: 2222 })),
			exec: vi.fn(async (command: string) => {
				execCalls.push(command);
				return { exitCode: 0, stderr: '', stdout: '' };
			}),
			setIngressRoutes: vi.fn(),
			getVmInstance: vi.fn(),
		};

		await setupGatewayVmRuntime({
			gatewayToken: 'test-token',
			managedVm,
			openClawConfigPath: './config/shravan/openclaw.json',
		});

		expect(execCalls.some((command) => command.includes('.openclaw-env'))).toBe(true);
		expect(execCalls.some((command) => command.includes('update-ca-certificates'))).toBe(false);
		expect(execCalls.some((command) => command.includes('cp -a /opt/gondolin-plugin-src'))).toBe(
			false,
		);
	});

	it('escapes single quotes in the gateway token', async () => {
		const execCalls: string[] = [];
		const managedVm: ManagedVm = {
			id: 'gateway-vm',
			close: vi.fn(async () => {}),
			enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
			enableSsh: vi.fn(async () => ({ host: '127.0.0.1', port: 2222 })),
			exec: vi.fn(async (command: string) => {
				execCalls.push(command);
				return { exitCode: 0, stderr: '', stdout: '' };
			}),
			setIngressRoutes: vi.fn(),
			getVmInstance: vi.fn(),
		};

		await setupGatewayVmRuntime({
			gatewayToken: "abc'def",
			managedVm,
			openClawConfigPath: './config/shravan/openclaw.json',
		});

		expect(execCalls.join('\n')).toContain("OPENCLAW_GATEWAY_TOKEN='abc'\\''def'");
	});
});
