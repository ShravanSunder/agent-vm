import path from 'node:path';

import {
	PortalArtifactReadRequestSchema,
	PortalCallRequestSchema,
	type PortalCallResult,
} from '@agent-vm/agent-portal-sdk';
import { describe, expect, it } from 'vitest';

import {
	createStockGatewayRuntimeSandboxVmHarness,
	type StockGatewayRuntimeSandboxVmHarness,
} from './gateway-runtime-sandbox-vm-test-fixture.js';
import { shouldRunLiveVmE2e } from './live-vm-e2e-gates.js';

const describeLiveVmIntegration = shouldRunLiveVmE2e() ? describe : describe.skip;

async function callConfiguredProofCapability(
	harness: StockGatewayRuntimeSandboxVmHarness,
): Promise<PortalCallResult> {
	const request = PortalCallRequestSchema.parse({
		calls: [
			{
				arguments: {},
				id: 'stock-sandbox-call',
				name: 'write_configured_proof',
				namespace: 'sandbox',
			},
		],
		requestId: 'stock-sandbox-private-uds-proof',
	});
	const result: PortalCallResult = await harness.gatewayRuntimeClient().portal.call(request, {
		trustedContext: harness.trustedInvocationContext(),
	});
	const firstItem = result.items[0];
	if (firstItem?.outcome.kind !== 'completed') {
		throw new Error('Managed private-UDS Tool Portal call did not complete.');
	}
	return result;
}

describeLiveVmIntegration('Gateway runtime sandbox stock VM proof', () => {
	it('reaches a stock Tool VM from managed private UDS through strict-pinned SSH', async () => {
		const harness = await createStockGatewayRuntimeSandboxVmHarness();

		try {
			const result = await callConfiguredProofCapability(harness);
			const client = harness.gatewayRuntimeClient();
			const trustedOptions = { trustedContext: harness.trustedInvocationContext() };
			const environment = await client.sandbox.environment.open({}, trustedOptions);
			const directShellProcess = await client.sandbox.process.start(
				{
					command: 'printf "%s" "$DIRECT_SHELL_MARKER" > /work/direct-shell-proof.txt',
					environment: environment.environment,
					environmentVariables: [{ name: 'DIRECT_SHELL_MARKER', value: 'stock-vm-direct-shell' }],
					maxRuntimeMs: 5_000,
					retainOutputBytes: 4_096,
				},
				trustedOptions,
			);
			if (directShellProcess.kind !== 'started') {
				throw new Error('Managed private-UDS direct shell process did not start.');
			}
			const directShellOutcome = await client.sandbox.process.wait(
				{ process: directShellProcess.process, timeoutMs: 5_000 },
				trustedOptions,
			);
			const firstItem = result.items[0];
			if (firstItem?.status !== 'ok' || firstItem.artifacts?.[0] === undefined) {
				throw new Error('Managed private-UDS Tool Portal call did not return stdout custody.');
			}
			const stdoutArtifact = firstItem.artifacts[0];
			const artifactRead = await harness.gatewayRuntimeClient().artifacts.read(
				PortalArtifactReadRequestSchema.parse({
					maxBytes: stdoutArtifact.byteLength,
					offsetBytes: 0,
					reference: stdoutArtifact,
				}),
				{ trustedContext: harness.trustedInvocationContext() },
			);

			expect(firstItem.outcome).toMatchObject({ kind: 'completed' });
			expect(Buffer.from(artifactRead.contentBase64, 'base64').toString('utf8')).toBe(
				'stock-vm-output',
			);
			expect(await harness.readToolVmFile('/work/proof.txt')).toBe('stock-vm');
			expect(directShellOutcome).toMatchObject({
				kind: 'terminal',
				outcome: { completion: 'succeeded', kind: 'completed' },
			});
			expect(await harness.readToolVmFile('/work/direct-shell-proof.txt')).toBe(
				'stock-vm-direct-shell',
			);
			const workspaceRootfsEvidence = await harness.proveWorkspaceRootfsSeparation();
			expect(workspaceRootfsEvidence.hostWorkspaceRoot).toMatch(/\/agents\/gateway-agent$/u);
			expect(workspaceRootfsEvidence.hostToGuestWorkspace).toEqual({
				content: 'host-workspace-visible-at-workspace',
				guestPath: '/workspace/host-to-guest-workspace-coherence.txt',
			});
			expect(workspaceRootfsEvidence.guestToHostWorkspace).toEqual({
				content: 'guest-workspace-visible-at-host-workspace',
				hostFilePath: path.join(
					workspaceRootfsEvidence.hostWorkspaceRoot,
					'guest-to-host-workspace-coherence.txt',
				),
			});
			expect(workspaceRootfsEvidence.guestRootfs).toEqual({
				content: 'guest-rootfs-visible-only-at-work',
				guestPath: '/work/guest-rootfs-only.txt',
			});
			expect(workspaceRootfsEvidence.storageSeparation).toEqual({
				guestWorkMissingHostWorkspaceFile: true,
				hostWorkspaceMissingGuestWorkFile: true,
			});
			expect(workspaceRootfsEvidence.authorityAbsence).toEqual({
				guestAgentPathAbsent: true,
				guestSelfPathAbsent: true,
				guestWholeZonePathAbsent: true,
			});
			const transportEvidence = harness.transportEvidence();
			expect(transportEvidence).toEqual({
				strictHostKeyVerified: true,
				strictSshPayloadByteCount: expect.any(Number),
			});
			expect(transportEvidence.strictSshPayloadByteCount).toBeGreaterThan(0);
		} finally {
			await harness.dispose();
		}
	});

	it('contains the predecessor, preserves /workspace, and replaces rootfs /work', async () => {
		const harness = await createStockGatewayRuntimeSandboxVmHarness();

		try {
			const predecessor = await harness.acquireSandbox();
			const predecessorWriter = await predecessor.startWriter('/work/replacement-fence.txt');
			const activeSshOperation = await predecessor.startCancellableSshOperation(
				'/work/active-ssh-operation.ready',
			);
			await harness.appendReplacementWorkspaceProof('workspace-a\n');
			await harness.writeDisposableRootfsProof();
			expect(await predecessorWriter.status()).toEqual({ kind: 'running' });
			expect(await predecessor.readFile('/work/replacement-fence.txt')).toBe('pre-fence-a\n');
			expect(await harness.readReplacementWorkspaceProof()).toBe('workspace-a\n');
			expect(await harness.disposableRootfsProofExists()).toBe(true);
			expect(await harness.hostWorkspaceContainsDisposableRootfsProof()).toBe(false);
			const replacement = await harness.replaceToolVmLeaf();

			expect(replacement.predecessorQuiescence).toBe('proven');
			expect(replacement.sameWorkspaceMountReusedAfterContainment).toBe(true);
			expect(replacement.predecessorContainment).toEqual({
				managedVmCloseCompleted: true,
				oldEndpointReconnectRejected: true,
				oldStrictSshClientRejected: true,
			});
			expect(replacement.predecessorCredentialRejectedBySuccessor).toBe(true);
			expect(await activeSshOperation.wait()).toEqual({ kind: 'cancelled' });
			expect(await predecessorWriter.status()).toEqual({ kind: 'stale-process-handle' });
			expect(await predecessorWriter.write(Buffer.from('stale-handle-write'))).toEqual({
				kind: 'stale-process-handle',
			});
			expect(await predecessorWriter.cancel()).toEqual({ kind: 'stale-process-handle' });
			await expect(predecessor.append('/work/replacement-fence.txt', 'stale')).rejects.toThrow(
				/stale generation/iu,
			);
			await expect(replacement.successor.readFile('/work/replacement-fence.txt')).rejects.toThrow(
				/Strict SSH stock sandbox read failed/u,
			);
			expect(await harness.readReplacementWorkspaceProof()).toBe('workspace-a\n');
			expect(await harness.disposableRootfsProofExists()).toBe(false);
			expect(await harness.hostWorkspaceContainsDisposableRootfsProof()).toBe(false);
			await replacement.successor.append('/work/successor-progress.txt', 'successor-b\n');
			await harness.appendReplacementWorkspaceProof('workspace-b\n');
			expect(await replacement.successor.readFile('/work/successor-progress.txt')).toBe(
				'successor-b\n',
			);
			expect(await harness.readReplacementWorkspaceProof()).toBe('workspace-a\nworkspace-b\n');
		} finally {
			await harness.dispose();
		}
	});
});
