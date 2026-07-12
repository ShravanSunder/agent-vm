import { readFile } from 'node:fs/promises';
import net from 'node:net';

import {
	createGitReadOnlySshEgressOptions,
	createManagedVm,
	type ManagedSshEgressOptions,
	type ManagedVm,
} from '@agent-vm/gondolin-adapter';
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

async function startVmAndCaptureProcess(managedVm: ManagedVm): Promise<ManagedVmProcessTarget> {
	await managedVm.start();
	const hostPid = managedVm.getHostPid();
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
	readonly port: number;
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
		`git@${upstreamGitHost}`,
		`"${props.service} '${allowedRepository}'"`,
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

	afterAll(async () => {
		const cleanupErrors: unknown[] = [];
		try {
			await upstreamSsh?.close();
		} catch (error) {
			cleanupErrors.push(error);
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
	});

	it('allows git-upload-pack and denies git-receive-pack at the Gondolin host boundary', async () => {
		const upstreamVm = await createManagedVm({
			imagePath: '',
			memory: '512M',
			cpus: 1,
			rootfsMode: 'cow',
			allowedHosts: [],
			secrets: {},
			vfsMounts: {},
		});
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
		const upstreamIdentityPem = await readFile(upstreamSsh.identityFile, 'utf8');
		const upstreamTarget = `${upstreamGitHost}:${String(upstreamSsh.port)}`;
		const sshEgress = {
			...createGitReadOnlySshEgressOptions({
				allowedHosts: [upstreamTarget],
				allowedRepos: [allowedRepository],
			}),
			credentials: {
				[upstreamTarget]: {
					username: 'root',
					privateKey: upstreamIdentityPem,
				},
			},
			hostVerifier: () => true,
			upstreamReadyTimeoutMs: 5_000,
		} satisfies ManagedSshEgressOptions;

		const gatewayVm = await createManagedVm({
			imagePath: '',
			memory: '512M',
			cpus: 1,
			rootfsMode: 'cow',
			allowedHosts: [],
			secrets: {},
			sshEgress,
			vfsMounts: {},
		});
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
	}, 90_000);
});
