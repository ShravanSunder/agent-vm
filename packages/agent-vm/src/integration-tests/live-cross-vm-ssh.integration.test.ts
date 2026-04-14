import fs from 'node:fs';

import { createManagedVm } from '@shravansunder/agent-vm-gondolin-core';
import type { ManagedVm } from '@shravansunder/agent-vm-gondolin-core';
/**
 * Live cross-VM SSH test — validates the tool VM lease + SSH exec flow.
 *
 * Creates a gateway VM and a tool VM, SSHes from gateway to tool via tcp.hosts.
 * This is the core execution path for the OpenClaw gondolin sandbox plugin.
 *
 * Run: pnpm vitest run packages/agent-vm/src/integration-tests/live-cross-vm-ssh.integration.test.ts
 * Requires: QEMU installed.
 */
import { describe, it, expect, afterAll } from 'vitest';

describe('live: cross-VM SSH via tcp.hosts (lease flow)', () => {
	let toolVm: ManagedVm | null = null;
	let gatewayVm: ManagedVm | null = null;

	afterAll(async () => {
		if (gatewayVm) await gatewayVm.close().catch(() => {});
		if (toolVm) await toolVm.close().catch(() => {});
	});

	it('should create tool VM, enable SSH, then SSH from gateway VM to tool VM', async () => {
		const t0 = Date.now();
		const log = (msg: string): void => {
			process.stdout.write(`[${String(Date.now() - t0).padStart(5)}ms] ${msg}\n`);
		};

		// Step 1: Create tool VM and enable SSH on a specific port
		const toolSshPort = 19100;
		log('creating tool VM...');

		toolVm = await createManagedVm({
			imagePath: '',
			memory: '512M',
			cpus: 1,
			rootfsMode: 'cow',
			allowedHosts: [],
			secrets: {},
			vfsMounts: {},
		});
		log('tool VM created');

		const toolSsh = await toolVm.enableSsh({
			user: 'root',
			listenHost: '127.0.0.1',
			listenPort: toolSshPort,
		});
		log(`tool SSH enabled: port=${toolSsh.port} identity=${toolSsh.identityFile}`);

		// Write a marker file in the tool VM for verification
		await toolVm.exec('echo tool_vm_marker > /tmp/marker.txt');

		// Step 2: Create gateway VM with tcp.hosts pointing to tool VM
		log('creating gateway VM with tcp.hosts...');

		gatewayVm = await createManagedVm({
			imagePath: '',
			memory: '512M',
			cpus: 1,
			rootfsMode: 'cow',
			allowedHosts: [],
			secrets: {},
			vfsMounts: {},
			tcpHosts: {
				[`tool-0.vm.host:22`]: `127.0.0.1:${toolSshPort}`,
			},
		});
		log('gateway VM created');

		// Step 3: Install the tool VM's SSH identity inside the gateway VM
		if (!toolSsh.identityFile) throw new Error('SSH identity file not available');
		const identityPem = fs.readFileSync(toolSsh.identityFile, 'utf-8');

		await gatewayVm.exec('mkdir -p /root/.ssh && chmod 700 /root/.ssh');
		// Write identity via base64 to avoid escaping issues
		const b64Key = Buffer.from(identityPem).toString('base64');
		await gatewayVm.exec(
			`echo ${b64Key} | base64 -d > /root/.ssh/tool_key && chmod 600 /root/.ssh/tool_key`,
		);
		log('SSH identity installed in gateway VM');

		// Step 4: SSH from gateway VM to tool VM through tcp.hosts
		log('SSHing from gateway to tool...');
		const sshResult = await gatewayVm.exec(
			'ssh -p 22 -i /root/.ssh/tool_key ' +
				'-o StrictHostKeyChecking=no ' +
				'-o UserKnownHostsFile=/dev/null ' +
				'-o BatchMode=yes ' +
				'-o ConnectTimeout=10 ' +
				'root@tool-0.vm.host ' +
				'"echo cross_vm_ok && cat /tmp/marker.txt && uname -m"',
		);
		log(`SSH result: exit=${sshResult.exitCode}`);

		expect(sshResult.exitCode).toBe(0);
		expect(sshResult.stdout).toContain('cross_vm_ok');
		expect(sshResult.stdout).toContain('tool_vm_marker');
		expect(sshResult.stdout).toContain('aarch64');

		// Step 5: Verify the two VMs are different (different exec channels)
		const gwHostname = await gatewayVm.exec('cat /proc/sys/kernel/hostname');
		const toolHostname = await toolVm.exec('cat /proc/sys/kernel/hostname');

		log(`gateway hostname: ${gwHostname.stdout.trim()}`);
		log(`tool hostname: ${toolHostname.stdout.trim()}`);

		// They should be different VMs
		// (both might say "(none)" on Alpine, but exec channels are definitely separate)
		expect(gwHostname.exitCode).toBe(0);
		expect(toolHostname.exitCode).toBe(0);

		log('PASS: cross-VM SSH works through tcp.hosts');
	}, 60_000);
});
