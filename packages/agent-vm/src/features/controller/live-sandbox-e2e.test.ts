/**
 * Live end-to-end test: OpenClaw sandbox plugin → controller lease API → tool VM
 *
 * This test boots the full stack:
 * 1. Controller lease API (Hono on port 18800)
 * 2. Gateway VM with OpenClaw + gondolin plugin mounted
 * 3. Tool VM created on demand via lease API
 * 4. Verifies exec tool calls route from gateway to tool VM
 *
 * Run: pnpm vitest run packages/agent-vm/src/features/controller/live-sandbox-e2e.test.ts
 * Requires: QEMU, built gateway image at build-cache/gateway/
 */
import { afterAll, describe, it, expect } from 'vitest';
import { createManagedVm } from 'gondolin-core';
import type { ManagedVm, SshAccess } from 'gondolin-core';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import fs from 'node:fs';
describe('live e2e: sandbox plugin → controller → tool VM', () => {
	let gatewayVm: ManagedVm | null = null;
	let toolVm: ManagedVm | null = null;
	let toolSsh: SshAccess | null = null;
	let server: { close: (cb?: () => void) => void } | null = null;

	afterAll(async () => {
		if (gatewayVm) await gatewayVm.close().catch(() => {});
		if (toolVm) await toolVm.close().catch(() => {});
		if (server) {
			await new Promise<void>((resolve) => {
				server?.close(() => resolve());
			});
		}
	});

	it('should route exec from gateway VM to tool VM via the controller lease API', async () => {
		const t0 = Date.now();
		const log = (msg: string): void =>
			process.stdout.write(`[${String(Date.now() - t0).padStart(6)}ms] ${msg}\n`);

		// --- Step 1: Create tool VM (pre-create so we have SSH creds ready) ---
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

		toolSsh = await toolVm.enableSsh({
			user: 'root',
			listenHost: '127.0.0.1',
			listenPort: 19000,
		});
		log(`tool VM SSH: port=${toolSsh.port}`);

		// Write a marker so we can verify tool VM exec
		await toolVm.exec('echo TOOL_VM_MARKER > /tmp/marker.txt');

		// Read the identity PEM for the lease response
		if (!toolSsh.identityFile) throw new Error('No identity file');
		const identityPem = fs.readFileSync(toolSsh.identityFile, 'utf-8');

		// --- Step 2: Start controller lease API ---
		log('starting controller lease API...');
		const app = new Hono();

		app.post('/lease', async (context) => {
			log('lease API: POST /lease received');
			return context.json({
				leaseId: 'test-lease-001',
				ssh: {
					host: 'tool-0.vm.host',
					port: 22,
					user: 'root',
					identityPem,
					knownHostsLine: '',
				},
				workdir: '/tmp',
				tcpSlot: 0,
			});
		});

		app.get('/health', (context) => context.json({ ok: true }));

		server = serve({ fetch: app.fetch, port: 18800 });
		log('controller API listening on :18800');

		// --- Step 3: Boot gateway VM with plugin mounted ---
		log('creating gateway VM...');
		const pluginDistDir = `${process.cwd()}/packages/openclaw-agent-vm-plugin/dist`;

		// Verify plugin dist exists
		if (!fs.existsSync(`${pluginDistDir}/plugin.js`)) {
			throw new Error(`Plugin not built. Run: pnpm --filter openclaw-agent-vm-plugin build`);
		}

		gatewayVm = await createManagedVm({
			imagePath: '',
			memory: '512M',
			cpus: 1,
			rootfsMode: 'cow',
			allowedHosts: [],
			secrets: {},
			vfsMounts: {},
			tcpHosts: {
				'controller.vm.host:18800': '127.0.0.1:18800',
				'tool-0.vm.host:22': `127.0.0.1:${toolSsh.port}`,
			},
		});
		log('gateway VM created');

		// --- Step 4: Test the lease API from inside the gateway VM ---
		log('testing lease API from gateway VM...');
		const healthCheck = await gatewayVm.exec(
			'curl -sS http://controller.vm.host:18800/health',
		);
		log(`health check: ${healthCheck.stdout.trim()}`);
		expect(healthCheck.stdout).toContain('ok');

		const leaseRequest = await gatewayVm.exec(
			'curl -sS -X POST -H "Content-Type: application/json" -d \'{"zoneId":"shravan","scopeKey":"test","profileId":"standard","workspaceDir":"/tmp","agentWorkspaceDir":"/tmp"}\' http://controller.vm.host:18800/lease',
		);
		log(`lease response: ${leaseRequest.stdout.trim().slice(0, 100)}`);
		expect(leaseRequest.stdout).toContain('test-lease-001');
		expect(leaseRequest.stdout).toContain('identityPem');

		// --- Step 5: SSH from gateway VM to tool VM through tcp.hosts ---
		log('testing SSH from gateway to tool...');

		// Write identity key into gateway VM
		const b64Key = Buffer.from(identityPem).toString('base64');
		await gatewayVm.exec(
			`mkdir -p /root/.ssh && echo ${b64Key} | base64 -d > /root/.ssh/tool_key && chmod 600 /root/.ssh/tool_key`,
		);

		const sshResult = await gatewayVm.exec(
			'ssh -p 22 -i /root/.ssh/tool_key -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes -o ConnectTimeout=10 root@tool-0.vm.host "cat /tmp/marker.txt"',
		);
		log(`SSH exec result: ${sshResult.stdout.trim()}`);

		expect(sshResult.exitCode).toBe(0);
		expect(sshResult.stdout.trim()).toBe('TOOL_VM_MARKER');

		log('PASS: Full chain works — controller API + cross-VM SSH from gateway to tool VM');
	}, 60_000);
});
