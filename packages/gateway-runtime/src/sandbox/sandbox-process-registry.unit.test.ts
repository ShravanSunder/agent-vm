import {
	SandboxProcessCancelResultSchema,
	SandboxProcessLogsResultSchema,
	SandboxProcessStartResultSchema,
	SandboxProcessStatusResultSchema,
	SandboxStreamCloseResultSchema,
	SandboxStreamReadResultSchema,
	SandboxStreamWriteResultSchema,
	type SandboxProcessLogsResult,
	type SandboxProcessStartResult,
} from '@agent-vm/agent-portal-sdk';
import { describe, expect, it, vi } from 'vitest';

import {
	createGatewayRuntimeSandboxOperationAuthority,
	type GatewayRuntimeSandboxOperationContext,
} from './sandbox-operation-authority.js';
import {
	createGatewayRuntimeSandboxProcessRegistry,
	type GatewayRuntimeSandboxProcessRegistry,
} from './sandbox-process-registry.js';
import type {
	ResolvedStrictToolVmSshProcessStartRequest,
	ResolvedStrictToolVmSshShellProcessStartRequest,
	StrictToolVmSshProcessRuntime,
} from './strict-tool-vm-ssh-process-runtime.js';
import type { StrictToolVmSshProcessStartError } from './strict-tool-vm-ssh-process-runtime.js';

const operationContext = {
	activeUseId: 'active-use-12',
	environmentGeneration: 'environment-generation-12',
	gatewayEpoch: 'gateway-epoch-12',
	leafGeneration: 'leaf-generation-12',
	leaseId: 'lease-12',
	sshBindingId: 'ssh-binding-12',
	stablePrincipal: 'a'.repeat(64),
} as const satisfies GatewayRuntimeSandboxOperationContext;

const operation = {
	operationId: 'operation-12',
	owningGeneration: operationContext.environmentGeneration,
} as const;
const process = {
	handleId: 'process-12',
	kind: 'process',
	owningGeneration: operationContext.environmentGeneration,
} as const;
const stdin = {
	channel: 'stdin',
	handleId: 'stdin-12',
	kind: 'stream',
	owningGeneration: operationContext.environmentGeneration,
} as const;
const stdout = {
	channel: 'stdout',
	handleId: 'stdout-12',
	kind: 'stream',
	owningGeneration: operationContext.environmentGeneration,
} as const;
const startRequest = {
	argv: ['/usr/bin/watch', '--fixed'],
	cwd: 'repo',
	maxRuntimeMs: 30_000,
	retainOutputBytes: 4_096,
} as const satisfies ResolvedStrictToolVmSshProcessStartRequest;
const shellStartRequest = {
	command: 'printf "$MODE"',
	cwd: '/workspace',
	environmentVariables: [{ name: 'MODE', value: 'beta' }],
	maxRuntimeMs: 30_000,
	retainOutputBytes: 4_096,
	terminalSize: { columns: 120, rows: 40 },
} as const satisfies ResolvedStrictToolVmSshShellProcessStartRequest;

interface ProcessRuntimeFixture {
	readonly registry: GatewayRuntimeSandboxProcessRegistry;
	readonly runtime: StrictToolVmSshProcessRuntime;
}

function createProcessRuntimeFixture(
	context: GatewayRuntimeSandboxOperationContext = operationContext,
): ProcessRuntimeFixture {
	const processRuntime = {
		cancel: vi.fn(() => ({ kind: 'cancel-request-accepted', operation }) as const),
		closeStream: vi.fn(() => ({ kind: 'closed', stream: stdin }) as const),
		logs: vi.fn(
			(): SandboxProcessLogsResult => ({
				chunks: [
					{
						channel: 'stdout',
						chunk: { byteLength: 3, contentBase64: 'bG9n', encoding: 'base64' },
						sequence: 0,
					},
				],
				kind: 'logs',
				nextCursor: 'cursor-12',
				process,
				truncated: false,
			}),
		),
		read: vi.fn(
			() =>
				({
					chunk: { byteLength: 3, contentBase64: 'bG9n', encoding: 'base64' },
					eof: false,
					kind: 'read',
					nextCursor: 'cursor-12',
					sequence: 0,
					stream: stdout,
				}) as const,
		),
		retire: vi.fn(async (): Promise<void> => undefined),
		start: vi.fn(
			async (): Promise<SandboxProcessStartResult> => ({
				kind: 'started',
				operation,
				process,
				streams: [stdin, stdout],
			}),
		),
		startShell: vi.fn(
			async (): Promise<SandboxProcessStartResult> => ({
				kind: 'started',
				operation,
				process,
				streams: [stdin, stdout],
			}),
		),
		resizeTerminal: vi.fn((): void => undefined),
		status: vi.fn(() => ({ kind: 'running', operation, process }) as const),
		terminalExitCode: vi.fn((): undefined => undefined),
		wait: vi.fn(async () => ({ kind: 'running', operation, process }) as const),
		write: vi.fn(
			async () =>
				({
					bytesWritten: 1,
					kind: 'written',
					sequence: 0,
					stream: stdin,
				}) as const,
		),
	} satisfies StrictToolVmSshProcessRuntime;
	const operationAuthority = createGatewayRuntimeSandboxOperationAuthority(operationContext);
	return {
		registry: createGatewayRuntimeSandboxProcessRegistry({
			operationAuthority,
			operationContext: context,
			processRuntime,
		}),
		runtime: processRuntime,
	};
}

describe('Gateway Runtime canonical sandbox process registry', () => {
	it('reauthorizes and delegates every canonical process and stream operation', async () => {
		const fixture = createProcessRuntimeFixture();

		const started = await fixture.registry.start(startRequest);
		const shellStarted = await fixture.registry.startShell(shellStartRequest);
		const status = fixture.registry.status({ process });
		const waited = await fixture.registry.wait({ process, timeoutMs: 100 });
		const logs = fixture.registry.logs({
			channels: ['stdout', 'stderr'],
			maxBytes: 1_024,
			process,
		});
		const cancelled = fixture.registry.cancel({ process });
		const read = fixture.registry.read({ maxBytes: 128, stream: stdout });
		const written = await fixture.registry.write({
			content: { byteLength: 1, contentBase64: 'YQ==', encoding: 'base64' },
			contentDigest: `sha256:${'c'.repeat(64)}`,
			sequence: 0,
			stream: stdin,
		});
		const closed = fixture.registry.closeStream({ stream: stdin });
		fixture.registry.resizeTerminal({ process, size: { columns: 160, rows: 55 } });

		expect(() => SandboxProcessStartResultSchema.parse(started)).not.toThrow();
		expect(() => SandboxProcessStartResultSchema.parse(shellStarted)).not.toThrow();
		expect(() => SandboxProcessStatusResultSchema.parse(status)).not.toThrow();
		expect(() => SandboxProcessStatusResultSchema.parse(waited)).not.toThrow();
		expect(() => SandboxProcessLogsResultSchema.parse(logs)).not.toThrow();
		expect(() => SandboxProcessCancelResultSchema.parse(cancelled)).not.toThrow();
		expect(() => SandboxStreamReadResultSchema.parse(read)).not.toThrow();
		expect(() => SandboxStreamWriteResultSchema.parse(written)).not.toThrow();
		expect(() => SandboxStreamCloseResultSchema.parse(closed)).not.toThrow();
		expect(fixture.runtime.start).toHaveBeenCalledWith(startRequest);
		expect(fixture.runtime.startShell).toHaveBeenCalledWith(shellStartRequest);
		expect(fixture.runtime.resizeTerminal).toHaveBeenCalledWith({
			process,
			size: { columns: 160, rows: 55 },
		});
		expect(fixture.runtime.status).toHaveBeenCalledWith({ process });
		expect(fixture.runtime.wait).toHaveBeenCalledWith({ process, timeoutMs: 100 });
	});

	it.each([
		['active use', { activeUseId: 'active-use-13' }],
		['environment', { environmentGeneration: 'environment-generation-13' }],
		['Gateway epoch', { gatewayEpoch: 'gateway-epoch-13' }],
		['leaf', { leafGeneration: 'leaf-generation-13' }],
		['lease', { leaseId: 'lease-13' }],
		['SSH binding', { sshBindingId: 'ssh-binding-13' }],
		['stable principal', { stablePrincipal: 'b'.repeat(64) }],
	] as const)('rejects stale %s authority before any runtime call', async (_label, changed) => {
		const fixture = createProcessRuntimeFixture({ ...operationContext, ...changed });

		await expect(fixture.registry.start(startRequest)).rejects.toMatchObject({
			disposition: 'not-dispatched',
			name: 'StrictToolVmSshProcessStartError',
		} satisfies Partial<StrictToolVmSshProcessStartError>);
		expect(fixture.runtime.start).not.toHaveBeenCalled();
	});

	it('checks authority before every runtime lookup or operation', async () => {
		const processRuntime = createProcessRuntimeFixture();
		const authority = createGatewayRuntimeSandboxOperationAuthority(operationContext);
		const registry = createGatewayRuntimeSandboxProcessRegistry({
			operationAuthority: authority,
			operationContext,
			processRuntime: processRuntime.runtime,
		});
		authority.beginReplacement({ replacementLeafGeneration: 'leaf-generation-13' });

		const attempts = [
			async () => await registry.start(startRequest),
			async () => registry.status({ process }),
			async () => await registry.wait({ process, timeoutMs: 100 }),
			async () => registry.logs({ channels: ['stdout'], maxBytes: 100, process }),
			async () => registry.cancel({ process }),
			async () => registry.read({ maxBytes: 100, stream: stdout }),
			async () =>
				await registry.write({
					content: { byteLength: 1, contentBase64: 'YQ==', encoding: 'base64' },
					contentDigest: `sha256:${'c'.repeat(64)}`,
					sequence: 0,
					stream: stdin,
				}),
			async () => registry.closeStream({ stream: stdin }),
		];
		for (const attempt of attempts) {
			// oxlint-disable-next-line no-await-in-loop -- each operation independently proves zero dispatch.
			await expect(attempt()).rejects.toThrow(/authority/i);
		}
		expect(
			Object.values(processRuntime.runtime).every(
				(method) => typeof method !== 'function' || vi.mocked(method).mock.calls.length === 0,
			),
		).toBe(true);
	});

	it('retires once, closes admission first, and never reopens', async () => {
		const fixture = createProcessRuntimeFixture();

		await Promise.all([fixture.registry.retire(), fixture.registry.retire()]);
		await expect(fixture.registry.start(startRequest)).rejects.toThrow(/retired/i);
		expect(() => fixture.registry.status({ process })).toThrow(/retired/i);
		expect(fixture.runtime.retire).toHaveBeenCalledTimes(1);
		expect(fixture.runtime.start).not.toHaveBeenCalled();
		expect(fixture.runtime.status).not.toHaveBeenCalled();
	});

	it.each(['rejected promise', 'synchronous throw'] as const)(
		'caches a %s from runtime retirement while admission stays closed',
		async (failureKind) => {
			const fixture = createProcessRuntimeFixture();
			vi.mocked(fixture.runtime.retire).mockImplementation(() => {
				if (failureKind === 'synchronous throw') throw new Error('retirement failed');
				return Promise.reject(new Error('retirement failed'));
			});

			const firstRetirement = fixture.registry.retire();
			const secondRetirement = fixture.registry.retire();
			expect(firstRetirement).toBe(secondRetirement);
			await expect(firstRetirement).rejects.toThrow('retirement failed');
			await expect(secondRetirement).rejects.toThrow('retirement failed');
			await expect(fixture.registry.start(startRequest)).rejects.toThrow(/retired/i);
			expect(fixture.runtime.retire).toHaveBeenCalledTimes(1);
		},
	);
});
