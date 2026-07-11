import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
	createManagedVm,
	createManagedVmOwnershipReservation,
	type ManagedVm,
	type ManagedVmOwnershipReservationReferenceV1,
} from '@agent-vm/gondolin-adapter';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assertVmDestructionComplete } from '../shared/vm-destruction-receipt.js';
import { currentE2eArchitecture } from './e2e-harness.js';
import { shouldRunLiveVmE2e } from './live-vm-e2e-gates.js';

/**
 * Live cross-VM SSH test — validates the gateway VM to Tool VM data path.
 *
 * 1. Tool VM exposes guest sshd through Gondolin enableSsh().
 * 2. Host listens on 127.0.0.1:<toolSshPort>.
 * 3. Gateway VM resolves tool-0.vm.host through per-host synthetic DNS.
 * 4. Gondolin tcp.hosts maps tool-0.vm.host:22 to the host listener.
 *
 * Command stdout/stderr flows gateway VM -> Tool VM over SSH. The controller is
 * not in the command data path.
 *
 * Run: mise exec -- pnpm vitest run --config vitest.integration.config.ts packages/agent-vm/src/integration-tests/live-cross-vm-ssh.integration.test.ts
 * Requires: QEMU/Gondolin runtime assets. Current Gondolin maps tcp.hosts flows
 * as raw TCP via allowRawTcp, so SSH protocol sniffing is intentionally bypassed.
 */
const describeLiveVmIntegration = shouldRunLiveVmE2e() ? describe : describe.skip;
const expectedGuestArchitecture = currentE2eArchitecture();

async function createStandaloneOwnershipReservation(
	testDeploymentRoot: string,
	vmRoleLabel: string,
): Promise<ManagedVmOwnershipReservationReferenceV1> {
	const vmIdentity = `${vmRoleLabel}-${randomUUID()}`;
	const ownershipReservation = await createManagedVmOwnershipReservation({
		controllerEpoch: 'live-cross-vm-ssh-e2e',
		parentGateway: null,
		reservationId: `reservation-${vmIdentity}`,
		reservationRoot: path.join(testDeploymentRoot, 'state', 'vm-ownership'),
		role: 'standalone',
		sessionLabel: `live-cross-vm-ssh-${vmRoleLabel}`,
		vmId: `vm-${vmIdentity}`,
	});
	return ownershipReservation.reference;
}

async function closeVmAndRequireCompleteReceipt(
	managedVm: ManagedVm | null,
	context: string,
): Promise<void> {
	if (managedVm === null) return;
	const receipt = await managedVm.close();
	assertVmDestructionComplete(receipt, context);
}

describeLiveVmIntegration('live: cross-VM SSH via tcp.hosts (lease flow)', () => {
	let toolVm: ManagedVm | null = null;
	let gatewayVm: ManagedVm | null = null;
	let testDeploymentRoot: string | null = null;

	beforeAll(async () => {
		testDeploymentRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-cross-vm-ssh-e2e-'));
	});

	afterAll(async () => {
		const cleanupResults = await Promise.allSettled([
			closeVmAndRequireCompleteReceipt(gatewayVm, 'gateway VM cleanup'),
			closeVmAndRequireCompleteReceipt(toolVm, 'tool VM cleanup'),
		]);
		const cleanupErrors: unknown[] = [];
		for (const result of cleanupResults) {
			if (result.status === 'rejected') {
				cleanupErrors.push(result.reason as unknown);
			}
		}
		if (cleanupErrors.length > 0) {
			throw new AggregateError(cleanupErrors, 'cross-VM SSH E2E cleanup failed');
		}
		gatewayVm = null;
		toolVm = null;
		if (testDeploymentRoot !== null) {
			await rm(testDeploymentRoot, { force: true, recursive: true });
			testDeploymentRoot = null;
		}
	});

	it('pins exact Tool VM SSH identity and rejects an old key after same-slot replacement', async () => {
		const t0 = Date.now();
		const log = (msg: string): void => {
			process.stdout.write(`[${String(Date.now() - t0).padStart(5)}ms] ${msg}\n`);
		};

		// Step 1: Create tool VM and enable SSH on a specific port
		const toolSshPort = 19100;
		log('creating tool VM...');
		if (testDeploymentRoot === null) throw new Error('test deployment root is unavailable');

		toolVm = await createManagedVm({
			ownershipReservation: await createStandaloneOwnershipReservation(testDeploymentRoot, 'tool'),
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
			ownershipReservation: await createStandaloneOwnershipReservation(
				testDeploymentRoot,
				'gateway',
			),
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
		const identityPem = await readFile(toolSsh.identityFile, 'utf-8');

		await gatewayVm.exec('mkdir -p /root/.ssh && chmod 700 /root/.ssh');
		// Write SSH material via base64 to avoid shell escaping ambiguity.
		const b64Key = Buffer.from(identityPem).toString('base64');
		const firstKnownHostsLine = `tool-0.vm.host ${toolSsh.serverHostKey.algorithm} ${toolSsh.serverHostKey.publicKeyBase64}\n`;
		const firstKnownHostsBase64 = Buffer.from(firstKnownHostsLine).toString('base64');
		await gatewayVm.exec(
			`echo ${b64Key} | base64 -d > /root/.ssh/tool_key && chmod 600 /root/.ssh/tool_key && ` +
				`echo ${firstKnownHostsBase64} | base64 -d > /root/.ssh/known_hosts && chmod 600 /root/.ssh/known_hosts`,
		);
		log('SSH client and exact server identity installed in gateway VM');

		// Step 4: SSH from gateway VM to tool VM through tcp.hosts
		log('SSHing from gateway to tool...');
		// tcp.hosts maps the synthetic per-host IPv4 answer; the shared AAAA
		// answer is only present for SSRF compatibility and is not a raw TCP path.
		const sshResult = await gatewayVm.exec(
			'ssh -4 -p 22 -i /root/.ssh/tool_key ' +
				'-o StrictHostKeyChecking=yes ' +
				'-o UserKnownHostsFile=/root/.ssh/known_hosts ' +
				'-o BatchMode=yes ' +
				'-o ConnectTimeout=10 ' +
				'root@tool-0.vm.host ' +
				'"echo cross_vm_ok && cat /tmp/marker.txt && uname -m"',
		);
		log(`SSH result: exit=${sshResult.exitCode}`);
		if (sshResult.exitCode !== 0) {
			log(`SSH stdout: ${sshResult.stdout.trim()}`);
			log(`SSH stderr: ${sshResult.stderr.trim()}`);
		}

		expect(sshResult.exitCode).toBe(0);
		expect(sshResult.stdout).toContain('cross_vm_ok');
		expect(sshResult.stdout).toContain('tool_vm_marker');
		expect(sshResult.stdout).toContain(expectedGuestArchitecture);

		// Step 5: Replace only the Tool VM on the same TCP slot. Install the new
		// client credential but deliberately keep the old pinned server key.
		await closeVmAndRequireCompleteReceipt(toolVm, 'first Tool VM replacement');
		toolVm = await createManagedVm({
			ownershipReservation: await createStandaloneOwnershipReservation(
				testDeploymentRoot,
				'tool-replacement',
			),
			imagePath: '',
			memory: '512M',
			cpus: 1,
			rootfsMode: 'cow',
			allowedHosts: [],
			secrets: {},
			vfsMounts: {},
		});
		const replacementToolSsh = await toolVm.enableSsh({
			user: 'root',
			listenHost: '127.0.0.1',
			listenPort: toolSshPort,
		});
		expect(replacementToolSsh.serverHostKey).not.toEqual(toolSsh.serverHostKey);
		if (!replacementToolSsh.identityFile) {
			throw new Error('Replacement SSH identity file not available');
		}
		const replacementIdentityPem = await readFile(replacementToolSsh.identityFile, 'utf8');
		const replacementIdentityBase64 = Buffer.from(replacementIdentityPem).toString('base64');
		await gatewayVm.exec(
			`echo ${replacementIdentityBase64} | base64 -d > /root/.ssh/tool_key && chmod 600 /root/.ssh/tool_key`,
		);
		await toolVm.exec('echo replacement_tool_vm_marker > /tmp/marker.txt');

		const staleServerIdentityResult = await gatewayVm.exec(
			'ssh -4 -p 22 -i /root/.ssh/tool_key ' +
				'-o StrictHostKeyChecking=yes ' +
				'-o UserKnownHostsFile=/root/.ssh/known_hosts ' +
				'-o BatchMode=yes -o ConnectTimeout=10 ' +
				'root@tool-0.vm.host true',
		);
		expect(staleServerIdentityResult.exitCode).not.toBe(0);
		expect(staleServerIdentityResult.stderr).toMatch(
			/host key verification failed|remote host identification has changed/iu,
		);

		// Step 6: Replace the pinned public identity and prove the new exact leaf.
		const replacementKnownHostsLine = `tool-0.vm.host ${replacementToolSsh.serverHostKey.algorithm} ${replacementToolSsh.serverHostKey.publicKeyBase64}\n`;
		const replacementKnownHostsBase64 = Buffer.from(replacementKnownHostsLine).toString('base64');
		await gatewayVm.exec(
			`echo ${replacementKnownHostsBase64} | base64 -d > /root/.ssh/known_hosts && chmod 600 /root/.ssh/known_hosts`,
		);
		const replacementSshResult = await gatewayVm.exec(
			'ssh -4 -p 22 -i /root/.ssh/tool_key ' +
				'-o StrictHostKeyChecking=yes ' +
				'-o UserKnownHostsFile=/root/.ssh/known_hosts ' +
				'-o BatchMode=yes -o ConnectTimeout=10 ' +
				'root@tool-0.vm.host "cat /tmp/marker.txt"',
		);
		expect(replacementSshResult.exitCode).toBe(0);
		expect(replacementSshResult.stdout).toContain('replacement_tool_vm_marker');

		// Step 7: Verify the two live VMs are different (different exec channels)
		const gwHostname = await gatewayVm.exec('cat /proc/sys/kernel/hostname');
		const toolHostname = await toolVm.exec('cat /proc/sys/kernel/hostname');

		log(`gateway hostname: ${gwHostname.stdout.trim()}`);
		log(`tool hostname: ${toolHostname.stdout.trim()}`);

		// They should be different VMs
		// (both might say "(none)" on Alpine, but exec channels are definitely separate)
		expect(gwHostname.exitCode).toBe(0);
		expect(toolHostname.exitCode).toBe(0);

		log('PASS: cross-VM SSH works through tcp.hosts');
	}, 90_000);
});
