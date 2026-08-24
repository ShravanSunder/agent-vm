import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
	encodeConfiguredCliPreparedImageIdentity,
	type ControllerExecutionOperation,
} from '@agent-vm/config-contracts';
import type {
	ManagedVm,
	ManagedVmCreateRequest,
	ManagedVmExecProcess,
	ManagedVmExecResult,
} from '@agent-vm/managed-vm';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import type { ConfiguredCliAuthorizedOperation } from './configured-cli-authorization.js';
import { createConfiguredCliManagedVmExecutor } from './configured-cli-managed-vm-executor.js';
import { ConfiguredControllerExecutionError } from './configured-controller-execution-error.js';

const operation = {
	calls: { deny: [], requiresApproval: [], withoutApproval: 'remaining_admitted' },
	commands: [{ flagRules: [], path: ['inspect'] }],
	deniedPatterns: [],
	executablePath: '/usr/local/bin/inspect',
	executionTarget: {
		allowedHosts: [],
		environment: { kind: 'empty' },
		guestCwd: '/run',
		imageReference: encodeConfiguredCliPreparedImageIdentity({
			fingerprint: 'fingerprint-a',
			imageReference: '/images/prepared-a',
			schemaVersion: 1,
		}),
		kind: 'ephemeral_managed_vm',
	},
	kind: 'configured_cli',
	mandatoryArgvPrefix: ['--format', 'json'],
	output: {
		modelVisibleStderr: 'none',
		overflow: 'fail',
		stderrMaxBytes: 1024,
		stdoutMaxBytes: 1024,
	},
	safeHelp: 'Inspect isolated data.',
	stdin: { kind: 'none' },
	timeout: { kind: 'quick' },
} as const satisfies Extract<ControllerExecutionOperation, { kind: 'configured_cli' }>;

function authorizationFor(
	configuredOperation: Extract<ControllerExecutionOperation, { kind: 'configured_cli' }>,
	bindingRevision = 'binding:current',
): ConfiguredCliAuthorizedOperation {
	return {
		evaluation: {
			authorityKind: 'without_approval',
			bindingRevision,
			disposition: 'without_approval',
			fingerprint: `sha256:${'a'.repeat(64)}`,
			operationId: '11111111-1111-4111-8111-111111111111',
			operationName: 'isolated_inspect',
			targetKind: 'ephemeral_managed_vm',
		},
		operation: configuredOperation,
	};
}

const gatewayIdentity = {
	controllerEpoch: 'controller-epoch-a',
	gatewayEpoch: 'gateway-epoch-a',
	parentGatewayVmId: 'gateway-vm-a',
	runtimeEpoch: 'runtime-epoch-a',
} as const;

let testRoot: string;

beforeEach(async () => {
	testRoot = await mkdtemp(path.join(tmpdir(), 'agent-vm-configured-runner-'));
});

afterEach(async () => {
	delete process.env.AGENT_VM_CONFIGURED_VM_REQUIRED_ENV;
	await rm(testRoot, { force: true, recursive: true });
});

function executionResult(): ManagedVmExecResult {
	const stdoutBuffer = Buffer.from('{"isolated":true}', 'utf8');
	const stderrBuffer = Buffer.alloc(0);
	return {
		exitCode: 0,
		json: <TValue>(): TValue => JSON.parse(stdoutBuffer.toString('utf8')) as TValue,
		lines: () => ['{"isolated":true}'],
		ok: true,
		stderr: '',
		stderrBuffer,
		stdout: stdoutBuffer.toString('utf8'),
		stdoutBuffer,
		toString: () => stdoutBuffer.toString('utf8'),
	};
}

function execProcess(result: ManagedVmExecResult): ManagedVmExecProcess {
	const resultPromise = Promise.resolve(result);
	return Object.assign(resultPromise, {
		[Symbol.asyncIterator]: async function* () {},
		end: vi.fn(),
		lines: async function* () {},
		output: async function* () {
			if (result.stdoutBuffer.byteLength > 0) {
				yield { data: result.stdoutBuffer, stream: 'stdout' as const, text: result.stdout };
			}
		},
		resize: vi.fn(),
		result: resultPromise,
		write: vi.fn(),
	});
}

function createManagedVmFixture(): {
	readonly close: ReturnType<typeof vi.fn>;
	readonly createManagedVm: Mock<(request: ManagedVmCreateRequest) => Promise<ManagedVm>>;
	readonly enableIngress: ReturnType<typeof vi.fn>;
	readonly enableSsh: ReturnType<typeof vi.fn>;
	readonly exec: ReturnType<typeof vi.fn>;
	readonly getHostProcessId: ReturnType<typeof vi.fn>;
	readonly vm: ManagedVm;
} {
	const exec = vi.fn(() => execProcess(executionResult()));
	const close = vi.fn(async () => undefined);
	const enableIngress = vi.fn(async () => {
		throw new Error('runner ingress is forbidden');
	});
	const enableSsh = vi.fn(async () => {
		throw new Error('runner SSH is forbidden');
	});
	const getHostProcessId = vi.fn((): number | null => 12_345);
	const vm = {
		close,
		configureIngressRoutes: vi.fn(),
		enableIngress,
		enableSsh,
		exec,
		getHostProcessId,
		id: 'runner-vm-a',
		start: vi.fn(async () => undefined),
	} satisfies ManagedVm;
	return {
		close,
		createManagedVm: vi.fn(async (_request: ManagedVmCreateRequest): Promise<ManagedVm> => vm),
		enableIngress,
		enableSsh,
		exec,
		getHostProcessId,
		vm,
	};
}

describe('configured CLI Managed VM production executor', () => {
	it('preserves proven not-dispatched certainty for an already-aborted signal', async () => {
		const fixture = createManagedVmFixture();
		const execute = createConfiguredCliManagedVmExecutor({
			controllerStateDir: testRoot,
			managedVmExactProcessTermination: { terminateRecordedHostProcess: vi.fn() },
			managedVmFactory: { createManagedVm: fixture.createManagedVm },
			readProcessIdentity: vi.fn(async () => null),
			resolveGatewayIdentity: vi.fn(async () => gatewayIdentity),
		});
		const cancellation = new AbortController();
		cancellation.abort(
			new ConfiguredControllerExecutionError('timeout', 'Controller execution window expired.'),
		);

		await expect(
			execute({
				authorization: authorizationFor(operation),
				input: { argv: ['inspect'], reason: 'pre-create cancellation proof' },
				operation,
				operationName: 'isolated_inspect',
				reloadAuthorization: vi.fn(async () => authorizationFor(operation)),
				signal: cancellation.signal,
				stablePrincipal: 'a'.repeat(64),
				zoneId: 'zone-a',
			}),
		).rejects.toMatchObject({ code: 'not_dispatched' });
		expect(fixture.createManagedVm).not.toHaveBeenCalled();
	});

	it('creates one VM, revalidates after provisioning, executes once, and proves exact containment', async () => {
		const fixture = createManagedVmFixture();
		const terminateRecordedHostProcess = vi.fn(async () => {
			fixture.getHostProcessId.mockReturnValue(null);
			return { hostProcessId: 12_345, kind: 'terminated' as const };
		});
		const reloadAuthorization = vi.fn(async () => authorizationFor(operation));
		const execute = createConfiguredCliManagedVmExecutor({
			controllerStateDir: testRoot,
			managedVmExactProcessTermination: { terminateRecordedHostProcess },
			managedVmFactory: { createManagedVm: fixture.createManagedVm },
			now: () => Date.parse('2026-08-20T12:00:00.000Z'),
			readProcessIdentity: vi.fn(async () => ({
				command: 'qemu-system-aarch64 -name controller-execution',
				lstart: 'Thu Aug 20 12:00:00 2026',
			})),
			resolveGatewayIdentity: vi.fn(async () => gatewayIdentity),
		});

		const result = await execute({
			authorization: authorizationFor(operation),
			input: { argv: ['inspect'], reason: 'integration proof' },
			operation,
			operationName: 'isolated_inspect',
			reloadAuthorization,
			stablePrincipal: 'a'.repeat(64),
			zoneId: 'zone-a',
		});

		expect(result).toEqual({
			exitCode: 0,
			stderrTruncated: false,
			stdout: '{"isolated":true}',
			stdoutTruncated: false,
		});
		expect(fixture.createManagedVm).toHaveBeenCalledOnce();
		expect(fixture.createManagedVm).toHaveBeenCalledWith(
			expect.objectContaining({ imageReference: '/images/prepared-a' }),
		);
		expect(fixture.exec).toHaveBeenCalledOnce();
		expect(reloadAuthorization).toHaveBeenCalledTimes(2);
		expect(fixture.close).toHaveBeenCalledOnce();
		expect(terminateRecordedHostProcess).toHaveBeenCalledOnce();
		expect(fixture.enableSsh).not.toHaveBeenCalled();
		expect(fixture.enableIngress).not.toHaveBeenCalled();
	});

	it('dispatches zero effects when the image changes during final admission', async () => {
		const fixture = createManagedVmFixture();
		const terminateRecordedHostProcess = vi.fn(async () => {
			fixture.getHostProcessId.mockReturnValue(null);
			return { hostProcessId: 12_345, kind: 'terminated' as const };
		});
		const changedOperation = {
			...operation,
			executionTarget: {
				...operation.executionTarget,
				imageReference: encodeConfiguredCliPreparedImageIdentity({
					fingerprint: 'fingerprint-b',
					imageReference: '/images/prepared-b',
					schemaVersion: 1,
				}),
			},
		} satisfies Extract<ControllerExecutionOperation, { kind: 'configured_cli' }>;
		const execute = createConfiguredCliManagedVmExecutor({
			controllerStateDir: testRoot,
			managedVmExactProcessTermination: { terminateRecordedHostProcess },
			managedVmFactory: { createManagedVm: fixture.createManagedVm },
			readProcessIdentity: vi.fn(async () => ({
				command: 'qemu-system-aarch64 -name controller-execution',
				lstart: 'Thu Aug 20 12:00:00 2026',
			})),
			resolveGatewayIdentity: vi.fn(async () => gatewayIdentity),
		});

		await expect(
			execute({
				authorization: authorizationFor(operation),
				input: { argv: ['inspect'], reason: 'stale image proof' },
				operation,
				operationName: 'isolated_inspect',
				reloadAuthorization: vi.fn(async () =>
					authorizationFor(changedOperation, 'binding:changed'),
				),
				stablePrincipal: 'a'.repeat(64),
				zoneId: 'zone-a',
			}),
		).rejects.toMatchObject({ code: 'not_dispatched' });
		expect(fixture.createManagedVm).not.toHaveBeenCalled();
		expect(fixture.exec).not.toHaveBeenCalled();
		expect(fixture.close).not.toHaveBeenCalled();
		expect(terminateRecordedHostProcess).not.toHaveBeenCalled();
	});

	it('creates no VM from an authored or malformed effective image identity', async () => {
		const fixture = createManagedVmFixture();
		const unpreparedOperation = {
			...operation,
			executionTarget: {
				...operation.executionTarget,
				imageReference: '../../vm-images/controller-runners/default/build-config.json',
			},
		} satisfies Extract<ControllerExecutionOperation, { kind: 'configured_cli' }>;
		const execute = createConfiguredCliManagedVmExecutor({
			controllerStateDir: testRoot,
			managedVmExactProcessTermination: { terminateRecordedHostProcess: vi.fn() },
			managedVmFactory: { createManagedVm: fixture.createManagedVm },
			readProcessIdentity: vi.fn(async () => null),
			resolveGatewayIdentity: vi.fn(async () => gatewayIdentity),
		});

		await expect(
			execute({
				authorization: authorizationFor(unpreparedOperation),
				input: { argv: ['inspect'], reason: 'unprepared image proof' },
				operation: unpreparedOperation,
				operationName: 'isolated_inspect',
				reloadAuthorization: vi.fn(async () => authorizationFor(unpreparedOperation)),
				stablePrincipal: 'a'.repeat(64),
				zoneId: 'zone-a',
			}),
		).rejects.toThrow('was not prepared');
		expect(fixture.createManagedVm).not.toHaveBeenCalled();
	});

	it('creates no VM when one inherited environment value is missing', async () => {
		const fixture = createManagedVmFixture();
		const operationWithMissingEnvironment = {
			...operation,
			executionTarget: {
				...operation.executionTarget,
				environment: {
					kind: 'inherit_allowlist',
					names: ['AGENT_VM_CONFIGURED_VM_REQUIRED_ENV'],
				},
			},
		} satisfies Extract<ControllerExecutionOperation, { kind: 'configured_cli' }>;
		const execute = createConfiguredCliManagedVmExecutor({
			controllerStateDir: testRoot,
			managedVmExactProcessTermination: { terminateRecordedHostProcess: vi.fn() },
			managedVmFactory: { createManagedVm: fixture.createManagedVm },
			readProcessIdentity: vi.fn(async () => null),
			resolveGatewayIdentity: vi.fn(async () => gatewayIdentity),
		});

		await expect(
			execute({
				authorization: authorizationFor(operationWithMissingEnvironment),
				input: { argv: ['inspect'], reason: 'missing environment proof' },
				operation: operationWithMissingEnvironment,
				operationName: 'isolated_inspect',
				reloadAuthorization: vi.fn(async () => authorizationFor(operationWithMissingEnvironment)),
				stablePrincipal: 'a'.repeat(64),
				zoneId: 'zone-a',
			}),
		).rejects.toThrow('AGENT_VM_CONFIGURED_VM_REQUIRED_ENV');
		expect(fixture.createManagedVm).not.toHaveBeenCalled();
	});
});
