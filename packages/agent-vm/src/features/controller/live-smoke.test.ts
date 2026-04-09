/**
 * Live smoke test — boots real Gondolin VMs.
 *
 * Run with: pnpm vitest run packages/agent-vm/src/features/controller/live-smoke.test.ts
 *
 * Requires: QEMU installed, ~30s per test, creates real VMs.
 * NOT part of the standard test suite (too slow, needs QEMU).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { createManagedVm } from 'gondolin-core';
import type { ManagedVm } from 'gondolin-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('live smoke: real Gondolin VM', () => {
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

		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gondolin-live-smoke-'));
		fs.writeFileSync(path.join(tmpDir, 'test.txt'), 'vfs_mount_works');

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

		fs.rmSync(tmpDir, { recursive: true, force: true });
	}, 60_000);

	it('should support HTTP mediation with secret injection', async () => {
		if (!vm) throw new Error('VM not available from previous test');

		await vm.close();

		vm = await createManagedVm({
			imagePath: '',
			memory: '512M',
			cpus: 1,
			rootfsMode: 'cow',
			allowedHosts: ['httpbin.org'],
			secrets: {
				TEST_TOKEN: {
					hosts: ['httpbin.org'],
					value: 'real-secret-value-12345',
				},
			},
			vfsMounts: {},
		});

		// The VM sees a placeholder, not the real value
		const envCheck = await vm.exec('echo $TEST_TOKEN');
		expect(envCheck.stdout.trim()).not.toBe('real-secret-value-12345');
		expect(envCheck.stdout.trim()).toContain('GONDOLIN_SECRET_');

		// But when making an HTTP request, the real value is injected
		const curlResult = await vm.exec(
			'curl -sS -H "Authorization: Bearer $TEST_TOKEN" https://httpbin.org/headers',
		);

		// The response should show the real token was injected by the proxy
		expect(curlResult.stdout).toContain('real-secret-value-12345');
		expect(curlResult.exitCode).toBe(0);
	}, 60_000);

	it.skip('should enable ingress and expose a guest HTTP server', async () => {
		// TODO: ingress hangs when reusing a VM created with httpHooks.
		// Ingress works in dedicated VMs — validated in experiments/src/06-ingress-http-ws.test.ts
		if (!vm) throw new Error('VM not available from previous test');

		// Reuse existing VM — start a simple HTTP server inside it
		await vm.exec(
			'node -e "require(\'http\').createServer((req,res)=>{res.writeHead(200);res.end(\'ingress_works\')}).listen(18080)" &',
		);
		// Wait for server to bind
		await new Promise((resolve) => setTimeout(resolve, 2000));

		// Verify server is running inside VM
		await vm.exec(
			'wget -qO- http://127.0.0.1:18080/ 2>/dev/null || echo not_ready',
		);

		// Configure ingress and expose to host
		vm.setIngressRoutes([{ prefix: '/', port: 18080, stripPrefix: true }]);
		const ingress = await vm.enableIngress({ listenPort: 0 });

		// Fetch from host
		const response = await fetch(`http://${ingress.host}:${ingress.port}/`);
		const body = await response.text();

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
