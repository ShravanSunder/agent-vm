import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import {
	encodeConfiguredCliPreparedImageIdentity,
	type ControllerExecutionOperation,
} from '@agent-vm/config-contracts';
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
					imageReference: encodeConfiguredCliPreparedImageIdentity({
						fingerprint: imageFixture.preparedImage.fingerprint,
						imageReference: imageFixture.preparedImage.imagePath,
						schemaVersion: 1,
					}),
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
				timeout: { kind: 'open' },
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

			const controllerStateDir = path.join(imageFixture.project.tempRoot, 'controller-state');
			const result = await execute({
				input: { argv: ['isolated'], reason: 'real VM proof', timeoutMs: 60_000 },
				operation,
				operationName: 'isolated_runner_proof',
				reloadOperation: async () => operation,
				stablePrincipal: 'a'.repeat(64),
				zoneId: 'configured-runner-zone',
			}).catch(async (error: unknown): Promise<never> => {
				const recordsDirectory = path.join(
					controllerStateDir,
					'controller-runners',
					imageFixture.vm.id,
				);
				const recordNames = await readdir(recordsDirectory).catch(() => []);
				const recordContents = await Promise.all(
					recordNames.map(async (recordName) => ({
						record: await readFile(path.join(recordsDirectory, recordName), 'utf8'),
						recordName,
					})),
				);
				throw new Error(
					`Configured runner failed with operation records: ${JSON.stringify(recordContents)}`,
					{ cause: error },
				);
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
