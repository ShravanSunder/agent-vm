import { describe, expect, it } from 'vitest';

import { createGatewayRuntimeSandboxIntegrationHarness } from './gateway-runtime-sandbox-test-fixture.js';

describe('Gateway runtime sandbox strict SSH integration', () => {
	it('keeps command, file, process, and stream bytes on strict SSH', async () => {
		const harness = createGatewayRuntimeSandboxIntegrationHarness();

		await harness.callSandboxCapability({
			arguments: { commandName: 'configured-health-check' },
			capability: 'exec',
		});
		await harness.callSandboxCapability({
			arguments: { path: 'README.md' },
			capability: 'read_file',
		});
		await harness.callSandboxCapability({
			arguments: { handleId: 'p-1' },
			capability: 'process_logs',
		});

		expect(harness.strictSsh.transferredByteCount).toBeGreaterThan(0);
		expect(harness.controllerExecution.transferredByteCount).toBe(0);
		expect(harness.socketIo.transferredByteCount).toBe(0);
		expect(harness.otlp.transferredByteCount).toBe(0);
	});

	it('rejects an old strict host key and every old handle after leaf replacement', async () => {
		const harness = createGatewayRuntimeSandboxIntegrationHarness();
		const predecessor = await harness.acquireSandbox();
		const processHandle = await predecessor.startConfiguredBackgroundCapability({
			capabilityName: 'configured-background-task',
		});
		const streamHandle = await predecessor.openStream({ path: 'large.bin' });

		const successor = await harness.replaceToolVmLeaf();

		await expect(
			predecessor.invokeConfiguredCapability({ capabilityName: 'configured-health-check' }),
		).resolves.toEqual({
			kind: 'strict-host-key-rejected',
		});
		await expect(processHandle.status()).resolves.toEqual({ kind: 'stale-process-handle' });
		await expect(streamHandle.read()).resolves.toEqual({ kind: 'stale-stream-handle' });
		await expect(
			successor.invokeConfiguredCapability({ capabilityName: 'configured-health-check' }),
		).resolves.toMatchObject({ kind: 'completed' });
	});

	it('positively fences an active predecessor writer before successor mount rebind', async () => {
		const harness = createGatewayRuntimeSandboxIntegrationHarness();
		const writer = await harness.startPredecessorWriter({ path: '/work/fence.txt' });

		const replacement = await harness.replaceToolVmLeaf();

		expect(replacement.events).toEqual([
			'predecessor-use-revoked',
			'predecessor-writer-stopped',
			'predecessor-quiescence-proven',
			'fresh-owned-host-directory-acquired',
			'successor-mounted',
		]);
		await expect(writer.status()).resolves.toEqual({ kind: 'stale-process-handle' });
		expect(await replacement.successor.readFile('fence.txt')).not.toContain(
			'predecessor-after-rebind',
		);
	});
});
