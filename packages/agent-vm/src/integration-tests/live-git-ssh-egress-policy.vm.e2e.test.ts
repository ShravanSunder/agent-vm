import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { createGondolinManagedVmProvider } from '@agent-vm/gondolin-vm-adapter';
import type { ManagedVm, ManagedVmCreateRequest } from '@agent-vm/managed-vm';
import { afterAll, describe, expect, it } from 'vitest';

import {
	terminateLiveManagedVm,
	type ManagedVmProcessTarget,
} from '../shared/controller-managed-vm-termination.js';
import {
	isProcessAlive,
	killProcess,
	readProcessCommand,
	readProcessIdentity,
	sleep,
} from '../shared/managed-vm-process.js';
import { shouldRunLiveVmE2e } from './live-vm-e2e-gates.js';

const describeLiveVmIntegration = shouldRunLiveVmE2e() ? describe : describe.skip;

const upstreamGitHost = '127.0.0.1.sslip.io';
const allowedRepository = 'agent-vm/read-only-fixture.git';
const crossVmSshFixturePort = 19100;
const managedVmFactory = createGondolinManagedVmProvider().factory;
const execFileAsync = promisify(execFile);

function createLiveVmRequest(
	overrides: Partial<ManagedVmCreateRequest> = {},
): ManagedVmCreateRequest {
	return {
		allowedHosts: [],
		environment: {},
		imageReference: '',
		mediatedSecrets: [],
		mounts: {},
		resources: { cpuCount: 1, memory: '512M' },
		rootfsMode: 'cow',
		sessionLabel: 'git-ssh-egress-policy',
		tcpHosts: [],
		...overrides,
	};
}

async function startVmAndCaptureProcess(managedVm: ManagedVm): Promise<ManagedVmProcessTarget> {
	await managedVm.start();
	const hostPid = managedVm.getHostProcessId();
	if (hostPid === null) {
		throw new Error(`Expected started VM '${managedVm.id}' to expose its host pid.`);
	}
	const processIdentity = await readProcessIdentity(hostPid);
	if (processIdentity === null) {
		throw new Error(`Expected started VM '${managedVm.id}' process identity.`);
	}
	return { hostPid, processIdentity, vmId: managedVm.id };
}

async function terminateVmRuntime(
	runtime: { readonly managedVm: ManagedVm; readonly target: ManagedVmProcessTarget } | null,
	context: string,
): Promise<void> {
	if (runtime === null) return;
	await terminateLiveManagedVm({
		contextLabel: context,
		dependencies: { isProcessAlive, killProcess, readProcessCommand, readProcessIdentity, sleep },
		target: runtime.target,
		vm: runtime.managedVm,
	});
}

async function allocateLocalTcpPort(): Promise<number> {
	return await new Promise<number>((resolve, reject) => {
		const server = net.createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			server.close((closeError) => {
				if (closeError) {
					reject(closeError);
					return;
				}
				if (!address || typeof address === 'string') {
					reject(new Error('failed to allocate local TCP port'));
					return;
				}
				resolve(address.port);
			});
		});
	});
}

async function allocateLocalTcpPortExcluding(excludedPorts: readonly number[]): Promise<number> {
	const candidatePorts = await Promise.all(
		Array.from({ length: 10 }, async () => await allocateLocalTcpPort()),
	);
	const port = candidatePorts.find((candidatePort) => !excludedPorts.includes(candidatePort));
	if (port !== undefined) {
		return port;
	}
	throw new Error('failed to allocate a non-excluded local TCP port');
}

function createGuestGitSshCommand(props: {
	readonly host?: string;
	readonly port: number;
	readonly repository?: string;
	readonly service: 'git-receive-pack' | 'git-upload-pack';
}): string {
	return [
		'ssh -4',
		`-p ${String(props.port)}`,
		'-o StrictHostKeyChecking=no',
		'-o UserKnownHostsFile=/dev/null',
		'-o PreferredAuthentications=none',
		'-o NumberOfPasswordPrompts=0',
		'-o BatchMode=yes',
		`git@${props.host ?? upstreamGitHost}`,
		`"${props.service} '${props.repository ?? allowedRepository}'"`,
	].join(' ');
}

describeLiveVmIntegration('live e2e: SSH Git egress policy', () => {
	let upstreamRuntime: {
		readonly managedVm: ManagedVm;
		readonly target: ManagedVmProcessTarget;
	} | null = null;
	let gatewayRuntime: {
		readonly managedVm: ManagedVm;
		readonly target: ManagedVmProcessTarget;
	} | null = null;
	let upstreamSsh: Awaited<ReturnType<ManagedVm['enableSsh']>> | null = null;
	let sshAgentEnvironment: Readonly<Record<string, string>> | null = null;

	afterAll(async () => {
		const cleanupErrors: unknown[] = [];
		try {
			await upstreamSsh?.close();
		} catch (error) {
			cleanupErrors.push(error);
		}
		if (sshAgentEnvironment !== null) {
			try {
				await execFileAsync('ssh-agent', ['-k'], {
					env: { ...process.env, ...sshAgentEnvironment },
				});
			} catch (error) {
				cleanupErrors.push(error);
			}
		}
		const cleanupResults = await Promise.allSettled([
			terminateVmRuntime(gatewayRuntime, 'gateway VM cleanup'),
			terminateVmRuntime(upstreamRuntime, 'upstream VM cleanup'),
		]);
		for (const result of cleanupResults) {
			if (result.status === 'rejected') {
				cleanupErrors.push(result.reason as unknown);
			}
		}
		if (cleanupErrors.length > 0) {
			throw new AggregateError(cleanupErrors, 'SSH Git egress E2E cleanup failed');
		}
		gatewayRuntime = null;
		upstreamRuntime = null;
		upstreamSsh = null;
		sshAgentEnvironment = null;
	});

	it('allows git-upload-pack and denies git-receive-pack at the Gondolin host boundary', async () => {
		const upstreamVm = await managedVmFactory.createManagedVm(
			createLiveVmRequest({ sessionLabel: 'git-ssh-egress-upstream' }),
		);
		upstreamRuntime = {
			managedVm: upstreamVm,
			target: await startVmAndCaptureProcess(upstreamVm),
		};

		const installGitUploadPack = await upstreamVm.exec(
			[
				"cat > /usr/local/bin/git-upload-pack <<'EOF'",
				'#!/bin/sh',
				'printf "upload-pack-allowed:%s\\n" "$1"',
				'EOF',
				'chmod 755 /usr/local/bin/git-upload-pack',
			].join('\n'),
		);
		expect(installGitUploadPack.exitCode).toBe(0);

		const upstreamSshPort = await allocateLocalTcpPortExcluding([crossVmSshFixturePort]);
		upstreamSsh = await upstreamVm.enableSsh({
			user: 'root',
			listenHost: '127.0.0.1',
			listenPort: upstreamSshPort,
		});
		if (!upstreamSsh.identityFile) {
			throw new Error('expected upstream SSH identity file');
		}
		const upstreamTarget = `${upstreamGitHost}:${String(upstreamSsh.port)}`;
		const sshRuntimeRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-git-ssh-egress-'));
		const agentSocket = path.join(sshRuntimeRoot, 'agent.sock');
		const knownHostsFile = path.join(sshRuntimeRoot, 'known_hosts');
		const agentResult = await execFileAsync('ssh-agent', ['-a', agentSocket]);
		const agentPid = /SSH_AGENT_PID=(\d+)/u.exec(agentResult.stdout)?.[1];
		if (agentPid === undefined) {
			throw new Error(`ssh-agent did not report SSH_AGENT_PID: ${agentResult.stdout}`);
		}
		sshAgentEnvironment = { SSH_AGENT_PID: agentPid, SSH_AUTH_SOCK: agentSocket };
		await execFileAsync('ssh-add', [upstreamSsh.identityFile], {
			env: { ...process.env, ...sshAgentEnvironment },
		});
		const knownHostKey = `${upstreamSsh.serverHostKey.algorithm} ${upstreamSsh.serverHostKey.publicKeyBase64}`;
		await writeFile(
			knownHostsFile,
			`${upstreamGitHost} ${knownHostKey}\n[${upstreamGitHost}]:${String(upstreamSsh.port)} ${knownHostKey}\n`,
			{ mode: 0o600 },
		);

		const gatewayVm = await managedVmFactory.createManagedVm(
			createLiveVmRequest({
				sessionLabel: 'git-ssh-egress-gateway',
				sshEgress: {
					agentSocket,
					allowedHosts: [upstreamTarget],
					allowedRepositories: [allowedRepository],
					kind: 'git-read-only',
					knownHostsFile,
				},
			}),
		);
		gatewayRuntime = {
			managedVm: gatewayVm,
			target: await startVmAndCaptureProcess(gatewayVm),
		};

		const receivePackResult = await gatewayVm.exec(
			createGuestGitSshCommand({
				port: upstreamSsh.port,
				service: 'git-receive-pack',
			}),
		);
		expect(receivePackResult.exitCode).toBe(1);
		expect(receivePackResult.stderr).toContain('agent-vm: git push over guest SSH is denied');

		const uploadPackResult = await gatewayVm.exec(
			createGuestGitSshCommand({
				port: upstreamSsh.port,
				service: 'git-upload-pack',
			}),
		);
		if (uploadPackResult.exitCode !== 0) {
			throw new Error(
				[
					`expected git-upload-pack to be allowed, got exit ${String(uploadPackResult.exitCode)}`,
					`stdout:\n${uploadPackResult.stdout}`,
					`stderr:\n${uploadPackResult.stderr}`,
				].join('\n'),
			);
		}
		expect(uploadPackResult.exitCode).toBe(0);
		expect(uploadPackResult.stdout.trim()).toBe(`upload-pack-allowed:${allowedRepository}`);

		const disallowedRepositoryResult = await gatewayVm.exec(
			createGuestGitSshCommand({
				port: upstreamSsh.port,
				repository: 'agent-vm/disallowed.git',
				service: 'git-upload-pack',
			}),
		);
		expect(disallowedRepositoryResult.exitCode).toBe(1);

		const disallowedHostResult = await gatewayVm.exec(
			createGuestGitSshCommand({
				host: 'disallowed.invalid',
				port: upstreamSsh.port,
				service: 'git-upload-pack',
			}),
		);
		expect(disallowedHostResult.exitCode).not.toBe(0);
	}, 90_000);
});
