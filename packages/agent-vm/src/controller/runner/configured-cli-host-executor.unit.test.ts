import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import type { ControllerExecutionOperation } from '@agent-vm/config-contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({ spawn: spawnMock }));

import { executeConfiguredCliOnControllerHost } from './configured-cli-host-executor.js';
import { ConfiguredControllerExecutionError } from './configured-controller-execution-error.js';

const operation = {
	commands: [{ flagRules: [], path: ['inspect'] }],
	deniedPatterns: [],
	executablePath: '/usr/bin/example-cli',
	executionTarget: {
		cwd: '/var/empty',
		environment: { kind: 'inherit_allowlist', names: ['AGENT_VM_HOST_EXECUTOR_TEST_VALUE'] },
		kind: 'controller_host',
	},
	kind: 'configured_cli',
	mandatoryArgvPrefix: ['--profile', 'managed'],
	output: {
		modelVisibleStderr: 'fixed_safe_summary',
		overflow: 'truncate',
		stderrMaxBytes: 1024,
		stdoutMaxBytes: 1024,
	},
	safeHelp: 'Inspect a host fixture.',
	stdin: { deniedPatterns: [], kind: 'bounded_text', maxBytes: 1024 },
	timeout: { kind: 'quick' },
} as const satisfies Extract<ControllerExecutionOperation, { kind: 'configured_cli' }>;

function createFakeChildProcess(): {
	readonly child: EventEmitter & {
		readonly kill: ReturnType<typeof vi.fn>;
		readonly stderr: PassThrough;
		readonly stdin: PassThrough;
		readonly stdout: PassThrough;
	};
	readonly stdinChunks: Buffer[];
} {
	const stdin = new PassThrough();
	const stdinChunks: Buffer[] = [];
	stdin.on('data', (chunk: Buffer) => stdinChunks.push(chunk));
	return {
		child: Object.assign(new EventEmitter(), {
			kill: vi.fn(() => true),
			stderr: new PassThrough(),
			stdin,
			stdout: new PassThrough(),
		}),
		stdinChunks,
	};
}

afterEach(() => {
	delete process.env.AGENT_VM_HOST_EXECUTOR_TEST_VALUE;
	delete process.env.AGENT_VM_HOST_EXECUTOR_FORBIDDEN;
	spawnMock.mockReset();
});

describe('configured CLI controller-host executor', () => {
	it('preserves proven not-dispatched certainty for an already-aborted signal', async () => {
		process.env.AGENT_VM_HOST_EXECUTOR_TEST_VALUE = 'visible';
		const cancellation = new AbortController();
		cancellation.abort();

		await expect(
			executeConfiguredCliOnControllerHost({
				input: { argv: ['inspect'], reason: 'pre-spawn cancellation proof' },
				operation,
				signal: cancellation.signal,
			}),
		).rejects.toMatchObject({ code: 'not_dispatched' });
		expect(spawnMock).not.toHaveBeenCalled();
	});

	it('spawns exact array argv with fixed cwd, allowlisted environment, bounded stdin, and no shell', async () => {
		process.env.AGENT_VM_HOST_EXECUTOR_TEST_VALUE = 'visible';
		process.env.AGENT_VM_HOST_EXECUTOR_FORBIDDEN = 'hidden';
		const fixture = createFakeChildProcess();
		spawnMock.mockReturnValue(fixture.child);

		const execution = executeConfiguredCliOnControllerHost({
			input: {
				argv: ['inspect', 'target; touch /tmp/forbidden'],
				reason: 'unit proof',
				stdin: 'body',
			},
			operation,
		});
		queueMicrotask(() => {
			fixture.child.emit('spawn');
			fixture.child.stdout.write('stdout-value');
			fixture.child.stderr.write('token=private-value diagnostic');
			fixture.child.emit('close', 0);
		});

		await expect(execution).resolves.toEqual({
			exitCode: 0,
			stderrSummary: '[REDACTED] diagnostic',
			stderrTruncated: false,
			stdout: 'stdout-value',
			stdoutTruncated: false,
		});
		expect(spawnMock).toHaveBeenCalledWith(
			'/usr/bin/example-cli',
			['--profile', 'managed', 'inspect', 'target; touch /tmp/forbidden'],
			{
				cwd: '/var/empty',
				env: { AGENT_VM_HOST_EXECUTOR_TEST_VALUE: 'visible' },
				shell: false,
				stdio: ['pipe', 'pipe', 'pipe'],
			},
		);
		expect(Buffer.concat(fixture.stdinChunks).toString('utf8')).toBe('body');
		expect(fixture.child.kill).not.toHaveBeenCalled();
	});

	it('rejects a denied invocation before process creation', async () => {
		await expect(
			executeConfiguredCliOnControllerHost({
				input: { argv: ['other'], reason: 'invalid path' },
				operation,
			}),
		).rejects.toBeInstanceOf(ConfiguredControllerExecutionError);
		expect(spawnMock).not.toHaveBeenCalled();
	});

	it('rejects a missing inherited environment value before process creation', async () => {
		await expect(
			executeConfiguredCliOnControllerHost({
				input: { argv: ['inspect'], reason: 'missing environment' },
				operation,
			}),
		).rejects.toThrow('AGENT_VM_HOST_EXECUTOR_TEST_VALUE');
		expect(spawnMock).not.toHaveBeenCalled();
	});

	it('observes cancellation registered immediately after spawn returns', async () => {
		process.env.AGENT_VM_HOST_EXECUTOR_TEST_VALUE = 'visible';
		const fixture = createFakeChildProcess();
		spawnMock.mockReturnValue(fixture.child);
		const cancellation = new AbortController();
		const execution = executeConfiguredCliOnControllerHost({
			input: { argv: ['inspect'], reason: 'cancellation race proof' },
			operation,
			signal: cancellation.signal,
		});

		cancellation.abort(
			new ConfiguredControllerExecutionError('cancelled', 'Controller is shutting down.'),
		);

		await expect(execution).rejects.toMatchObject({ code: 'cancelled' });
		expect(fixture.child.kill).toHaveBeenCalledWith('SIGKILL');
	});
});
