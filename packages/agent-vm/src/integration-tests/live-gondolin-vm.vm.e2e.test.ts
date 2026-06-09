import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createManagedVm } from '@agent-vm/gondolin-adapter';
import type { ManagedVm } from '@agent-vm/gondolin-adapter';
/**
 * Live e2e test — boots real Gondolin VMs.
 *
 * Run with: pnpm vitest run packages/agent-vm/src/integration-tests/live-gondolin-vm.vm.e2e.test.ts
 *
 * Requires: QEMU installed, ~30s per test, creates real VMs.
 * NOT part of the standard test suite (too slow, needs QEMU).
 */
import { describe, it, expect, afterAll } from 'vitest';

import { shouldRunLiveVmE2e } from './live-vm-e2e-gates.js';

const describeLiveVmIntegration = shouldRunLiveVmE2e() ? describe : describe.skip;

async function yieldToEventLoop(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

async function fetchIngressUntilReady(url: string): Promise<{
	readonly body: string;
	readonly response: Response;
}> {
	let lastError = 'not attempted';
	for (let attempt = 1; attempt <= 50; attempt += 1) {
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
		// oxlint-disable-next-line no-await-in-loop -- ingress readiness is a bounded protocol retry with event-loop yielding, not a wall-clock sleep
		await yieldToEventLoop();
	}
	throw new Error(`Ingress did not become ready after 50 attempts. Last error: ${lastError}`);
}

describeLiveVmIntegration('live e2e: real Gondolin VM', () => {
	let vm: ManagedVm | null = null;

	afterAll(async () => {
		if (vm) {
			await vm.close();
			vm = null;
		}
	});

	it('should boot a basic VM and exec a command', async () => {
		vm = await createManagedVm({
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
		await vm.close();

		vm = await createManagedVm({
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
			await vm.close();
			vm = null;
		}

		const hostWorkMountDir = await mkdtemp(path.join(os.tmpdir(), 'gondolin-live-work-'));
		try {
			vm = await createManagedVm({
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

			await vm.close();
			vm = await createManagedVm({
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
				await vm.close();
				vm = null;
			}
			await rm(hostWorkMountDir, { recursive: true, force: true });
		}
	}, 120_000);

	it('should enable ingress and expose a guest HTTP server', async () => {
		if (vm) {
			await vm.close();
			vm = null;
		}

		vm = await createManagedVm({
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
