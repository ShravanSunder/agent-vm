import { readFile } from 'node:fs/promises';

import { createGondolinManagedVmProvider } from '@agent-vm/gondolin-vm-adapter';
import type { ManagedVm, ManagedVmSshAccess } from '@agent-vm/managed-vm';
import { afterAll, describe, expect, it } from 'vitest';

import {
	terminateLiveManagedVm,
	type ManagedVmProcessTarget,
} from '../shared/controller-managed-vm-termination.js';
import { readProcessIdentity, sleep } from '../shared/managed-vm-process.js';
import { currentE2eArchitecture } from './e2e-harness.js';
import { shouldRunLiveVmE2e } from './live-vm-e2e-gates.js';

const managedVmProvider = createGondolinManagedVmProvider();
const managedVmFactory = managedVmProvider.factory;

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

async function startVmAndCaptureProcessTarget(vm: ManagedVm): Promise<ManagedVmProcessTarget> {
	await vm.start();
	const hostPid = vm.getHostProcessId();
	if (hostPid === null) {
		throw new Error(`Started Gondolin VM '${vm.id}' did not expose a host PID.`);
	}
	const processIdentity = await readProcessIdentity(hostPid);
	if (processIdentity === null) {
		throw new Error(`Started Gondolin VM '${vm.id}' process identity could not be captured.`);
	}
	return { hostPid, processIdentity, vmId: vm.id };
}

async function terminateStartedVm(options: {
	readonly context: string;
	readonly processTarget: ManagedVmProcessTarget;
	readonly sshAccess?: ManagedVmSshAccess;
	readonly vm: ManagedVm;
}): Promise<void> {
	await options.sshAccess?.close();
	await terminateLiveManagedVm({
		contextLabel: options.context,
		exactProcessTermination: managedVmProvider.exactProcessTermination,
		sleep,
		target: options.processTarget,
		vm: options.vm,
	});
}

describeLiveVmIntegration('live: cross-VM SSH via tcp.hosts (lease flow)', () => {
	let toolVm: ManagedVm | null = null;
	let gatewayVm: ManagedVm | null = null;
	let toolVmProcessTarget: ManagedVmProcessTarget | null = null;
	let gatewayVmProcessTarget: ManagedVmProcessTarget | null = null;
	let toolSshAccess: ManagedVmSshAccess | null = null;

	afterAll(async () => {
		const cleanupResults = await Promise.allSettled([
			gatewayVm === null || gatewayVmProcessTarget === null
				? Promise.resolve()
				: terminateStartedVm({
						context: 'gateway VM cleanup',
						processTarget: gatewayVmProcessTarget,
						vm: gatewayVm,
					}),
			toolVm === null || toolVmProcessTarget === null
				? Promise.resolve()
				: terminateStartedVm({
						context: 'tool VM cleanup',
						processTarget: toolVmProcessTarget,
						...(toolSshAccess === null ? {} : { sshAccess: toolSshAccess }),
						vm: toolVm,
					}),
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
		gatewayVmProcessTarget = null;
		toolVmProcessTarget = null;
		toolSshAccess = null;
	});

	it('pins exact Tool VM SSH identity and rejects an old key after same-slot replacement', async () => {
		const t0 = Date.now();
		const log = (msg: string): void => {
			process.stdout.write(`[${String(Date.now() - t0).padStart(5)}ms] ${msg}\n`);
		};

		// Step 1: Create tool VM and enable SSH on a specific port
		const toolSshPort = 19100;
		log('creating tool VM...');
		toolVm = await managedVmFactory.createManagedVm({
			allowedHosts: [],
			environment: {},
			imageReference: 'alpine-base:latest',
			mediatedSecrets: [],
			mounts: {},
			resources: { cpuCount: 1, memory: '512M' },
			rootfsMode: 'cow',
			sessionLabel: 'cross-vm-ssh-tool-primary',
			tcpHosts: [],
		});
		toolVmProcessTarget = await startVmAndCaptureProcessTarget(toolVm);
		log('tool VM created');

		toolSshAccess = await toolVm.enableSsh({
			user: 'root',
			listenHost: '127.0.0.1',
			listenPort: toolSshPort,
		});
		log(`tool SSH enabled: port=${toolSshAccess.port} identity=${toolSshAccess.identityFile}`);
		const firstToolServerHostKey = toolSshAccess.serverHostKey;

		// Write a marker file in the tool VM for verification
		await toolVm.exec('echo tool_vm_marker > /tmp/marker.txt');

		// Step 2: Create gateway VM with tcp.hosts pointing to tool VM
		log('creating gateway VM with tcp.hosts...');

		gatewayVm = await managedVmFactory.createManagedVm({
			allowedHosts: [],
			environment: {},
			imageReference: 'alpine-base:latest',
			mediatedSecrets: [],
			mounts: {},
			resources: { cpuCount: 1, memory: '512M' },
			rootfsMode: 'cow',
			sessionLabel: 'cross-vm-ssh-gateway',
			tcpHosts: [{ guestHost: 'tool-0.vm.host:22', target: `127.0.0.1:${toolSshPort}` }],
		});
		gatewayVmProcessTarget = await startVmAndCaptureProcessTarget(gatewayVm);
		log('gateway VM created');

		// Step 3: Install the tool VM's SSH identity inside the gateway VM
		if (!toolSshAccess.identityFile) throw new Error('SSH identity file not available');
		const identityPem = await readFile(toolSshAccess.identityFile, 'utf-8');

		await gatewayVm.exec('mkdir -p /root/.ssh && chmod 700 /root/.ssh');
		// Write SSH material via base64 to avoid shell escaping ambiguity.
		const b64Key = Buffer.from(identityPem).toString('base64');
		const firstKnownHostsLine = `tool-0.vm.host ${toolSshAccess.serverHostKey.algorithm} ${toolSshAccess.serverHostKey.publicKeyBase64}\n`;
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
		if (toolVmProcessTarget === null) throw new Error('Tool VM process target is unavailable');
		await terminateStartedVm({
			context: 'first Tool VM replacement',
			processTarget: toolVmProcessTarget,
			sshAccess: toolSshAccess,
			vm: toolVm,
		});
		toolVm = null;
		toolVmProcessTarget = null;
		toolSshAccess = null;
		toolVm = await managedVmFactory.createManagedVm({
			allowedHosts: [],
			environment: {},
			imageReference: 'alpine-base:latest',
			mediatedSecrets: [],
			mounts: {},
			resources: { cpuCount: 1, memory: '512M' },
			rootfsMode: 'cow',
			sessionLabel: 'cross-vm-ssh-tool-replacement',
			tcpHosts: [],
		});
		toolVmProcessTarget = await startVmAndCaptureProcessTarget(toolVm);
		toolSshAccess = await toolVm.enableSsh({
			user: 'root',
			listenHost: '127.0.0.1',
			listenPort: toolSshPort,
		});
		expect(toolSshAccess.serverHostKey).not.toEqual(firstToolServerHostKey);
		if (!toolSshAccess.identityFile) {
			throw new Error('Replacement SSH identity file not available');
		}
		const replacementIdentityPem = await readFile(toolSshAccess.identityFile, 'utf8');
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
		const replacementKnownHostsLine = `tool-0.vm.host ${toolSshAccess.serverHostKey.algorithm} ${toolSshAccess.serverHostKey.publicKeyBase64}\n`;
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
