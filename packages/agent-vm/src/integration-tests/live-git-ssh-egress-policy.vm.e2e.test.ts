import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import {
	createGitReadOnlySshEgressOptions,
	createManagedVm,
	createManagedVmOwnershipReservation,
	type ManagedSshEgressOptions,
	type ManagedVm,
	type ManagedVmOwnershipReservationReferenceV1,
} from '@agent-vm/gondolin-adapter';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assertVmDestructionComplete } from '../shared/vm-destruction-receipt.js';
import { shouldRunLiveVmE2e } from './live-vm-e2e-gates.js';

const describeLiveVmIntegration = shouldRunLiveVmE2e() ? describe : describe.skip;

const upstreamGitHost = '127.0.0.1.sslip.io';
const allowedRepository = 'agent-vm/read-only-fixture.git';
const crossVmSshFixturePort = 19100;

async function createStandaloneOwnershipReservation(
	testDeploymentRoot: string,
	vmRoleLabel: string,
): Promise<ManagedVmOwnershipReservationReferenceV1> {
	const vmIdentity = `${vmRoleLabel}-${randomUUID()}`;
	const ownershipReservation = await createManagedVmOwnershipReservation({
		controllerEpoch: 'live-git-ssh-egress-policy-e2e',
		parentGateway: null,
		reservationId: `reservation-${vmIdentity}`,
		reservationRoot: path.join(testDeploymentRoot, 'state', 'vm-ownership'),
		role: 'standalone',
		sessionLabel: `live-git-ssh-egress-${vmRoleLabel}`,
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
	let upstreamVm: ManagedVm | null = null;
	let gatewayVm: ManagedVm | null = null;
	let testDeploymentRoot: string | null = null;

	beforeAll(async () => {
		testDeploymentRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-git-ssh-egress-e2e-'));
	});

	afterAll(async () => {
		const cleanupResults = await Promise.allSettled([
			closeVmAndRequireCompleteReceipt(gatewayVm, 'gateway VM cleanup'),
			closeVmAndRequireCompleteReceipt(upstreamVm, 'upstream VM cleanup'),
		]);
		const cleanupErrors: unknown[] = [];
		for (const result of cleanupResults) {
			if (result.status === 'rejected') {
				cleanupErrors.push(result.reason as unknown);
			}
		}
		if (cleanupErrors.length > 0) {
			throw new AggregateError(cleanupErrors, 'SSH Git egress E2E cleanup failed');
		}
		gatewayVm = null;
		upstreamVm = null;
		if (testDeploymentRoot !== null) {
			await rm(testDeploymentRoot, { force: true, recursive: true });
			testDeploymentRoot = null;
		}
	});

	it('allows git-upload-pack and denies git-receive-pack at the Gondolin host boundary', async () => {
		if (testDeploymentRoot === null) throw new Error('test deployment root is unavailable');
		upstreamVm = await createManagedVm({
			ownershipReservation: await createStandaloneOwnershipReservation(
				testDeploymentRoot,
				'upstream',
			),
			imagePath: '',
			memory: '512M',
			cpus: 1,
			rootfsMode: 'cow',
			allowedHosts: [],
			secrets: {},
			vfsMounts: {},
		});

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
		const upstreamSsh = await upstreamVm.enableSsh({
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
			sshEgress,
			vfsMounts: {},
		});

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
