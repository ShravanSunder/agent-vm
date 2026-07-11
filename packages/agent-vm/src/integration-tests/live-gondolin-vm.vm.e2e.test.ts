import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
	createManagedVm,
	createManagedVmOwnershipReservation,
	type ManagedVm,
	type ManagedVmOwnershipReservationReferenceV1,
} from '@agent-vm/gondolin-adapter';
/**
 * Live e2e test — boots real Gondolin VMs.
 *
 * Run with: pnpm vitest run packages/agent-vm/src/integration-tests/live-gondolin-vm.vm.e2e.test.ts
 *
 * Requires: QEMU installed, ~30s per test, creates real VMs.
 * NOT part of the standard test suite (too slow, needs QEMU).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assertVmDestructionComplete } from '../shared/vm-destruction-receipt.js';
import { waitForProtocolRetryInterval } from './e2e-protocol-wait.js';
import { shouldRunLiveVmE2e } from './live-vm-e2e-gates.js';

const describeLiveVmIntegration = shouldRunLiveVmE2e() ? describe : describe.skip;

const ingressReadyTimeoutMs = 10_000;
const ingressRetryIntervalMs = 100;

async function createStandaloneOwnershipReservation(
	testDeploymentRoot: string,
	vmPurposeLabel: string,
): Promise<ManagedVmOwnershipReservationReferenceV1> {
	const vmIdentity = `${vmPurposeLabel}-${randomUUID()}`;
	const ownershipReservation = await createManagedVmOwnershipReservation({
		controllerEpoch: 'live-gondolin-vm-e2e',
		parentGateway: null,
		reservationId: `reservation-${vmIdentity}`,
		reservationRoot: path.join(testDeploymentRoot, 'state', 'vm-ownership'),
		role: 'standalone',
		sessionLabel: `live-gondolin-vm-${vmPurposeLabel}`,
		vmId: `vm-${vmIdentity}`,
	});
	return ownershipReservation.reference;
}

async function closeVmAndRequireCompleteReceipt(vm: ManagedVm, context: string): Promise<void> {
	const receipt = await vm.close();
	assertVmDestructionComplete(receipt, context);
}

async function fetchIngressUntilReady(url: string): Promise<{
	readonly body: string;
	readonly response: Response;
}> {
	let lastError = 'not attempted';
	const startedAtMs = performance.now();
	while (performance.now() - startedAtMs <= ingressReadyTimeoutMs) {
		try {
			// AbortSignal.timeout is a protocol safety bound for a single ingress request.
			// oxlint-disable-next-line no-await-in-loop -- ingress readiness checks must observe sequential proxy state.
			const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
			// oxlint-disable-next-line no-await-in-loop -- the response body is tied to the sequential request above.
			const body = await response.text();
			if (response.status !== 502) {
				return { body, response };
			}
			lastError = `HTTP ${String(response.status)}: ${body}`;
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}
		// oxlint-disable-next-line no-await-in-loop -- ingress readiness has no event source; use bounded protocol retry backoff.
		await waitForProtocolRetryInterval(ingressRetryIntervalMs);
	}
	throw new Error(
		`Ingress did not become ready within ${String(ingressReadyTimeoutMs)}ms. Last error: ${lastError}`,
	);
}

describeLiveVmIntegration('live e2e: real Gondolin VM', () => {
	let vm: ManagedVm | null = null;
	let testDeploymentRoot: string | null = null;

	beforeAll(async () => {
		testDeploymentRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-gondolin-vm-e2e-'));
	});

	afterAll(async () => {
		if (vm) {
			await closeVmAndRequireCompleteReceipt(vm, 'final Gondolin VM E2E cleanup');
			vm = null;
		}
		if (testDeploymentRoot !== null) {
			await rm(testDeploymentRoot, { force: true, recursive: true });
			testDeploymentRoot = null;
		}
	});

	it('should boot a basic VM and exec a command', async () => {
		if (testDeploymentRoot === null) throw new Error('test deployment root is unavailable');
		vm = await createManagedVm({
			ownershipReservation: await createStandaloneOwnershipReservation(
				testDeploymentRoot,
				'basic-exec',
			),
			imagePath: '', // use default Gondolin image (alpine-base:latest, auto-downloads)
			memory: '512M',
			cpus: 1,
			rootfsMode: 'cow',
			allowedHosts: ['httpbin.org'],
			secrets: {},
			vfsMounts: {},
		});

		const result = await vm.exec('echo hello_from_gondolin && uname -a');

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('hello_from_gondolin');
		expect(result.stdout).toContain('Linux');
	}, 60_000);

	it('should support VFS mounts', async () => {
		if (!vm) throw new Error('VM not available from previous test');

		const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'gondolin-live-e2e-'));
		await writeFile(path.join(tmpDir, 'test.txt'), 'vfs_mount_works');

		// Close previous VM and create one with VFS
		await closeVmAndRequireCompleteReceipt(vm, 'basic exec VM cleanup');
		vm = null;
		if (testDeploymentRoot === null) throw new Error('test deployment root is unavailable');

		vm = await createManagedVm({
			ownershipReservation: await createStandaloneOwnershipReservation(
				testDeploymentRoot,
				'vfs-mount',
			),
			imagePath: '',
			memory: '512M',
			cpus: 1,
			rootfsMode: 'cow',
			allowedHosts: [],
			secrets: {},
			vfsMounts: {
				'/test-mount': {
					kind: 'realfs-readonly',
					hostPath: tmpDir,
				},
			},
		});

		const result = await vm.exec('cat /test-mount/test.txt');

		expect(result.stdout.trim()).toBe('vfs_mount_works');

		await rm(tmpDir, { recursive: true, force: true });
	}, 60_000);

	it('should persist writable RealFS /workspace files across disposable VM lifetimes', async () => {
		if (vm) {
			await closeVmAndRequireCompleteReceipt(vm, 'VFS mount VM cleanup');
			vm = null;
		}
		if (testDeploymentRoot === null) throw new Error('test deployment root is unavailable');

		const hostWorkMountDir = await mkdtemp(path.join(os.tmpdir(), 'gondolin-live-work-'));
		try {
			vm = await createManagedVm({
				ownershipReservation: await createStandaloneOwnershipReservation(
					testDeploymentRoot,
					'realfs-write',
				),
				imagePath: '',
				memory: '512M',
				cpus: 1,
				rootfsMode: 'memory',
				allowedHosts: [],
				secrets: {},
				vfsMounts: {
					'/workspace': {
						kind: 'realfs',
						hostPath: hostWorkMountDir,
					},
				},
			});

			const writeResult = await vm.exec(
				"mkdir -p /workspace/project && printf 'persisted through realfs' > /workspace/project/notes.md",
			);
			expect(writeResult.exitCode).toBe(0);
			await expect(
				readFile(path.join(hostWorkMountDir, 'project', 'notes.md'), 'utf8'),
			).resolves.toBe('persisted through realfs');

			await closeVmAndRequireCompleteReceipt(vm, 'RealFS writer VM cleanup');
			vm = null;
			vm = await createManagedVm({
				ownershipReservation: await createStandaloneOwnershipReservation(
					testDeploymentRoot,
					'realfs-read',
				),
				imagePath: '',
				memory: '512M',
				cpus: 1,
				rootfsMode: 'memory',
				allowedHosts: [],
				secrets: {},
				vfsMounts: {
					'/workspace': {
						kind: 'realfs',
						hostPath: hostWorkMountDir,
					},
				},
			});

			const readResult = await vm.exec('cat /workspace/project/notes.md');
			expect(readResult.exitCode).toBe(0);
			expect(readResult.stdout.trim()).toBe('persisted through realfs');
		} finally {
			if (vm) {
				await closeVmAndRequireCompleteReceipt(vm, 'RealFS reader VM cleanup');
				vm = null;
			}
			await rm(hostWorkMountDir, { recursive: true, force: true });
		}
	}, 120_000);

	it('should enable ingress and expose a guest HTTP server', async () => {
		if (vm) {
			await closeVmAndRequireCompleteReceipt(vm, 'prior Gondolin VM cleanup');
			vm = null;
		}
		if (testDeploymentRoot === null) throw new Error('test deployment root is unavailable');

		vm = await createManagedVm({
			ownershipReservation: await createStandaloneOwnershipReservation(
				testDeploymentRoot,
				'ingress-and-ssh',
			),
			imagePath: '',
			memory: '512M',
			cpus: 1,
			rootfsMode: 'cow',
			allowedHosts: [],
			secrets: {},
			vfsMounts: {},
		});

		await vm.exec(
			"while true; do printf 'HTTP/1.1 200 OK\\r\\nConnection: close\\r\\nContent-Length: 13\\r\\n\\r\\ningress_works' | nc -l -p 18080; done >/tmp/ingress-server.log 2>&1 &",
		);
		const guestResponse = await vm.exec(
			[
				'for attempt in $(seq 1 30); do',
				'  wget -qO- http://127.0.0.1:18080/ && exit 0',
				'  sleep 0.1',
				'done',
				'cat /tmp/ingress-server.log >&2',
				'exit 1',
			].join('\n'),
		);
		if (guestResponse.exitCode !== 0) {
			throw new Error(
				`Guest HTTP server did not respond.\nstdout:\n${guestResponse.stdout}\nstderr:\n${guestResponse.stderr}`,
			);
		}
		expect(guestResponse.stdout.trim()).toBe('ingress_works');

		vm.setIngressRoutes([{ prefix: '/', port: 18080, stripPrefix: true }]);
		const ingress = await vm.enableIngress({ listenPort: 0 });

		const { body, response } = await fetchIngressUntilReady(
			`http://${ingress.host}:${String(ingress.port)}/`,
		);

		expect(response.status).toBe(200);
		expect(body).toBe('ingress_works');
	}, 30_000);

	it('should enable SSH and allow host-to-guest exec', async () => {
		if (!vm) throw new Error('VM not available from previous test');

		const sshAccess = await vm.enableSsh({
			user: 'root',
			listenHost: '127.0.0.1',
			listenPort: 0,
		});

		expect(sshAccess.host).toBe('127.0.0.1');
		expect(sshAccess.port).toBeGreaterThan(0);
		expect(sshAccess.user).toBe('root');
	}, 30_000);
});
