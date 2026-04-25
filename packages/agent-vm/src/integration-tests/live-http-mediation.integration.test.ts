import { createManagedVm, type ManagedVm } from '@agent-vm/gondolin-adapter';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TEST_SECRET_VALUE = 'agent-vm-http-mediation-test-secret';

describe('live HTTP mediation', () => {
	let vm: ManagedVm | null = null;

	beforeAll(async () => {
		vm = await createManagedVm({
			imagePath: '',
			memory: '512M',
			cpus: 1,
			rootfsMode: 'cow',
			allowedHosts: ['httpbin.org'],
			secrets: {
				TEST_TOKEN: {
					hosts: ['httpbin.org'],
					value: TEST_SECRET_VALUE,
				},
			},
			vfsMounts: {},
			sessionLabel: 'agent-vm-live-http-mediation-test',
		});
	}, 60_000);

	afterAll(async () => {
		if (vm) {
			await vm.close();
			vm = null;
		}
	});

	it('keeps the real secret out of the VM env and injects it for an allowed host', async () => {
		if (!vm) throw new Error('VM was not initialized.');

		const envCheck = await vm.exec('printf "%s" "$TEST_TOKEN"');

		expect(envCheck.exitCode).toBe(0);
		expect(envCheck.stdout.trim()).toContain('GONDOLIN_SECRET_');
		expect(envCheck.stdout.trim()).not.toBe(TEST_SECRET_VALUE);

		const curlResult = await vm.exec(
			'curl -sS --max-time 10 -H "Authorization: Bearer $TEST_TOKEN" https://httpbin.org/headers',
		);

		expect(curlResult.exitCode).toBe(0);
		const parsedResponse = JSON.parse(curlResult.stdout) as {
			readonly headers?: { readonly Authorization?: string };
		};
		expect(parsedResponse.headers?.Authorization).toBe(`Bearer ${TEST_SECRET_VALUE}`);
	}, 30_000);

	it('blocks requests to hosts outside the allowlist', async () => {
		if (!vm) throw new Error('VM was not initialized.');

		const curlResult = await vm.exec(
			'curl -sS --max-time 10 -o /tmp/example-denied.txt -w "%{http_code}" https://example.com/; printf "\\n"; cat /tmp/example-denied.txt',
		);

		expect(curlResult.exitCode).toBe(0);
		expect(curlResult.stdout.startsWith('403\n')).toBe(true);
		expect(curlResult.stdout).toContain('403 Forbidden');
	}, 30_000);
});
