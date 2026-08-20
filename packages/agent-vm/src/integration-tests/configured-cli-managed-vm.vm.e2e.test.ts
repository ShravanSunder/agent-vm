import path from 'node:path';

import type { ControllerExecutionOperation } from '@agent-vm/config-contracts';
import { describe, expect, it } from 'vitest';

import { createManagedVmRuntimeComposition } from '../composition/gondolin-managed-vm-provider.js';
import { createConfiguredCliManagedVmExecutor } from '../controller/runner/configured-cli-managed-vm-executor.js';
import { readProcessIdentity } from '../shared/managed-vm-process.js';
import { shouldRunLiveVmE2e } from './live-vm-e2e-gates.js';
import { startManagedGatewayImageBootFixture } from './managed-gateway-image-boot-test-fixture.js';

const describeLiveConfiguredRunner = shouldRunLiveVmE2e() ? describe : describe.skip;

describeLiveConfiguredRunner('configured CLI one-shot Managed VM', () => {
	it('executes once in a separately created immutable-image VM and proves containment', async () => {
		const imageFixture = await startManagedGatewayImageBootFixture({
			sessionLabel: 'configured-cli-runner-image-fixture',
		});
		try {
			const managedVm = createManagedVmRuntimeComposition();
			const operation = {
				commands: [{ flagRules: [], path: ['isolated'] }],
				deniedPatterns: [],
				executablePath: '/usr/bin/printf',
				executionTarget: {
					allowedHosts: [],
					environment: { kind: 'empty' },
					guestCwd: '/tmp',
					imageReference: imageFixture.preparedImage.imagePath,
					kind: 'ephemeral_managed_vm',
				},
				kind: 'configured_cli',
				mandatoryArgvPrefix: ['runner-output:%s'],
				output: {
					modelVisibleStderr: 'none',
					overflow: 'fail',
					stderrMaxBytes: 4096,
					stdoutMaxBytes: 4096,
				},
				safeHelp: 'Run the isolated Managed VM proof.',
				stdin: { kind: 'none' },
				timeout: { kind: 'quick' },
			} as const satisfies Extract<ControllerExecutionOperation, { kind: 'configured_cli' }>;
			const execute = createConfiguredCliManagedVmExecutor({
				controllerStateDir: path.join(imageFixture.project.tempRoot, 'controller-state'),
				managedVmExactProcessTermination: managedVm.managedVmExactProcessTermination,
				managedVmFactory: managedVm.managedVmFactory,
				readProcessIdentity,
				resolveGatewayIdentity: async () => ({
					controllerEpoch: 'controller-epoch-configured-runner',
					gatewayEpoch: 'gateway-epoch-configured-runner',
					parentGatewayVmId: imageFixture.vm.id,
					runtimeEpoch: 'runtime-epoch-configured-runner',
				}),
			});

			const result = await execute({
				input: { argv: ['isolated'], reason: 'real VM proof' },
				operation,
				operationName: 'isolated_runner_proof',
				reloadOperation: async () => operation,
				stablePrincipal: 'a'.repeat(64),
				zoneId: 'configured-runner-zone',
			});

			expect(result).toEqual({
				exitCode: 0,
				stderrTruncated: false,
				stdout: 'runner-output:isolated',
				stdoutTruncated: false,
			});
		} finally {
			await imageFixture.close();
		}
	}, 300_000);
});
