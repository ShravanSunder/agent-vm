import type {
	ManagedVm,
	ManagedVmExecProcess,
	ManagedVmExecResult,
	ManagedVmFactory,
} from '@agent-vm/managed-vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createConfiguredCliManagedVmRunnerFactory } from './configured-cli-managed-vm-factory.js';
import type { ControllerRunnerAuthorizationSnapshot } from './managed-vm-controller-runner.js';

const authorization = {
	authorizationFingerprint: 'fingerprint-a',
	cancellation: { timeoutMs: 5_000 },
	cwd: { kind: 'fixed', path: '/run' },
	egress: { allowedHosts: ['api.example.test'] },
	environment: { INSPECT_MODE: 'safe' },
	executablePath: '/usr/local/bin/inspect',
	imageFingerprint: 'image-fingerprint-a',
	imageReference: '/images/fingerprint-a',
	mandatoryArgvPrefix: ['--format', 'json'],
	output: {
		modelVisibleStderr: 'fixed_safe_summary',
		overflow: 'truncate',
		stderrMaxBytes: 1024,
		stdoutMaxBytes: 1024,
	},
	target: { kind: 'ephemeral_managed_vm', zoneId: 'zone-a' },
} as const satisfies ControllerRunnerAuthorizationSnapshot;

function managedVmExecutionResult(): ManagedVmExecResult {
	const stdoutBuffer = Buffer.from('{"ok":true}', 'utf8');
	const stderrBuffer = Buffer.from('token=private diagnostic', 'utf8');
	return {
		exitCode: 0,
		json: <TValue>(): TValue => JSON.parse(stdoutBuffer.toString('utf8')) as TValue,
		lines: () => ['{"ok":true}'],
		ok: true,
		stderr: stderrBuffer.toString('utf8'),
		stderrBuffer,
		stdout: stdoutBuffer.toString('utf8'),
		stdoutBuffer,
		toString: () => stdoutBuffer.toString('utf8'),
	};
}

function managedVmExecProcess(result: ManagedVmExecResult): ManagedVmExecProcess {
	const resultPromise = Promise.resolve(result);
	return Object.assign(resultPromise, {
		[Symbol.asyncIterator]: async function* () {},
		end: vi.fn(),
		lines: async function* () {},
		output: async function* () {
			if (result.stdoutBuffer.byteLength > 0) {
				yield { data: result.stdoutBuffer, stream: 'stdout' as const, text: result.stdout };
			}
			if (result.stderrBuffer.byteLength > 0) {
				yield { data: result.stderrBuffer, stream: 'stderr' as const, text: result.stderr };
			}
		},
		resize: vi.fn(),
		result: resultPromise,
		write: vi.fn(),
	});
}

afterEach(() => {
	vi.useRealTimers();
});

describe('configured CLI Managed VM factory', () => {
	it('creates one code-owned immutable VM request and executes exact argv with no lease or SSH fields', async () => {
		vi.useFakeTimers();
		let hostProcessId: number | null = 12_345;
		const exec = vi.fn(() => managedVmExecProcess(managedVmExecutionResult()));
		const vm = {
			close: vi.fn(async () => undefined),
			configureIngressRoutes: vi.fn(),
			enableIngress: vi.fn(async () => {
				throw new Error('ephemeral runner must not enable ingress');
			}),
			enableSsh: vi.fn(async () => {
				throw new Error('ephemeral runner must not enable SSH');
			}),
			exec,
			getHostProcessId: vi.fn(() => hostProcessId),
			id: 'runner-vm-a',
			start: vi.fn(async () => undefined),
		} satisfies ManagedVm;
		const createManagedVm = vi.fn(async () => vm);
		const factory = createConfiguredCliManagedVmRunnerFactory({
			exactProcessTermination: {
				terminateRecordedHostProcess: vi.fn(async () => {
					hostProcessId = null;
					return { hostProcessId: 12_345, kind: 'terminated' as const };
				}),
			},
			managedVmFactory: { createManagedVm } satisfies ManagedVmFactory,
			sessionLabel: 'controller-execution-operation-a',
		});

		const handle = await factory.create(authorization);
		await handle.start();
		const result = await handle.exec({
			argv: ['/usr/local/bin/inspect', '--format', 'json', 'inspect'],
			cwd: '/run',
			environment: { INSPECT_MODE: 'safe' },
			output: authorization.output,
			stdin: '{"input":true}',
			timeoutMs: 5_000,
		});

		expect(createManagedVm).toHaveBeenCalledWith({
			allowedHosts: ['api.example.test'],
			environment: { INSPECT_MODE: 'safe' },
			imageReference: '/images/fingerprint-a',
			mediatedSecrets: [],
			mounts: {},
			resources: { cpuCount: 2, memory: '2G' },
			rootfsMode: 'cow',
			sessionLabel: 'controller-execution-operation-a',
			tcpHosts: [],
		});
		expect(exec).toHaveBeenCalledWith(
			['/usr/local/bin/inspect', '--format', 'json', 'inspect'],
			expect.objectContaining({
				cwd: '/run',
				env: { INSPECT_MODE: 'safe' },
				pty: false,
				stdin: '{"input":true}',
			}),
		);
		expect(result).toEqual({
			exitCode: 0,
			stderrSummary: '[REDACTED] diagnostic',
			stderrTruncated: false,
			stdout: '{"ok":true}',
			stdoutTruncated: false,
		});
		expect(vm.enableSsh).not.toHaveBeenCalled();
		expect(vm.enableIngress).not.toHaveBeenCalled();
	});
});
