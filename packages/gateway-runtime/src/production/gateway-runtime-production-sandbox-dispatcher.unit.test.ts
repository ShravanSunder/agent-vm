import { createHash } from 'node:crypto';

import type {
	GatewayRuntimeTrustedInvocationContext,
	SandboxProcessStartResult,
} from '@agent-vm/agent-portal-sdk';
import {
	SANDBOX_MAXIMUM_BINARY_BYTES,
	SandboxEnvironmentOpenResultSchema,
	SandboxExecStartResultSchema,
	SandboxExecWaitResultSchema,
	SandboxFsListResultSchema,
	SandboxFsMkdirResultSchema,
	SandboxFsRemoveResultSchema,
	SandboxFsStatResultSchema,
	SandboxRetainedResultLookupResultSchema,
	SandboxTerminalAttachResultSchema,
} from '@agent-vm/agent-portal-sdk';
import { deriveGatewayControlStablePrincipal } from '@agent-vm/gateway-control-contracts';
import type { FileEntry } from 'ssh2';
import { describe, expect, it, vi } from 'vitest';

import type { GatewayRuntimeToolVmRunnerOperationGroup } from '../backends/tool-vm-runner-backend-port.js';
import { createGatewayRuntimeSandboxOperationAuthority } from '../sandbox/sandbox-operation-authority.js';
import type { GatewayRuntimeSandboxProcessRegistry } from '../sandbox/sandbox-process-registry.js';
import type { StrictToolVmSshClient } from '../sandbox/strict-tool-vm-ssh-client.js';
import { createGatewayRuntimeProductionSandboxDispatcher } from './gateway-runtime-production-sandbox-dispatcher.js';

const trustedContext = {
	principal: {
		agentId: 'agent-a',
		frameworkIdentity: { kind: 'hermes', profileName: 'agent-a' },
		profileAssignmentRevision: 'profile-assignment-a-1',
		toolPortalProfileId: 'profile-a',
	},
	requester: { authenticatedSubjectId: 'subject-a' },
} satisfies GatewayRuntimeTrustedInvocationContext;

const operationContext = {
	activeUseId: 'active-use-a',
	environmentGeneration: 'environment-generation-a',
	gatewayEpoch: 'gateway-epoch-a',
	leafGeneration: 'leaf-generation-a',
	leaseId: 'lease-a',
	sshBindingId: 'ssh-binding-a',
	stablePrincipal: deriveGatewayControlStablePrincipal({ principal: trustedContext.principal }),
} as const;

function processStartResult(index: number): SandboxProcessStartResult {
	return {
		kind: 'started',
		operation: {
			operationId: `operation-${String(index)}`,
			owningGeneration: operationContext.environmentGeneration,
		},
		process: {
			handleId: `process-${String(index)}`,
			kind: 'process',
			owningGeneration: operationContext.environmentGeneration,
		},
		streams: [
			{
				channel: 'stdin',
				handleId: `stdin-${String(index)}`,
				kind: 'stream',
				owningGeneration: operationContext.environmentGeneration,
			},
			{
				channel: 'stdout',
				handleId: `stdout-${String(index)}`,
				kind: 'stream',
				owningGeneration: operationContext.environmentGeneration,
			},
		],
	};
}

function missingPathError(): Error {
	return new Error('Strict SSH SFTP operation failed.', {
		cause: Object.assign(new Error('missing'), { code: 'ENOENT' }),
	});
}

function directoryEntry(props: {
	readonly byteLength?: number;
	readonly filename: string;
	readonly kind: 'directory' | 'file' | 'symlink';
}): FileEntry {
	const modePrefix = props.kind === 'directory' ? 'd' : props.kind === 'symlink' ? 'l' : '-';
	return {
		attrs: {
			atime: 0,
			gid: 0,
			mode: 0,
			mtime: 0,
			size: props.byteLength ?? 0,
			uid: 0,
		},
		filename: props.filename,
		longname: `${modePrefix}rw-r--r--`,
	};
}

interface DispatcherFixture {
	readonly binding: GatewayRuntimeToolVmRunnerOperationGroup;
	readonly acquisitionAcquire: ReturnType<typeof vi.fn>;
	readonly dispatcher: ReturnType<typeof createGatewayRuntimeProductionSandboxDispatcher>;
	readonly processRegistry: GatewayRuntimeSandboxProcessRegistry;
	readonly strictSshClient: StrictToolVmSshClient;
}

function createDispatcherFixture(): DispatcherFixture {
	let nextProcess = 0;
	const processRegistry = {
		cancel: vi.fn(({ process }) => ({
			kind: 'cancel-request-accepted' as const,
			operation: {
				operationId: `operation-for-${process.handleId}`,
				owningGeneration: process.owningGeneration,
			},
		})),
		closeStream: vi.fn(({ stream }) => ({ kind: 'closed' as const, stream })),
		logs: vi.fn(({ process }) => ({
			chunks: [],
			kind: 'logs' as const,
			process,
			truncated: false,
		})),
		read: vi.fn(({ stream }) => ({
			chunk: { byteLength: 0, contentBase64: '', encoding: 'base64' as const },
			eof: false,
			kind: 'read' as const,
			sequence: 0,
			stream,
		})),
		resizeTerminal: vi.fn(),
		retire: vi.fn(async (): Promise<void> => undefined),
		start: vi.fn(async () => processStartResult(++nextProcess)),
		startShell: vi.fn(async () => processStartResult(++nextProcess)),
		status: vi.fn(({ process }) => ({
			kind: 'running' as const,
			operation: {
				operationId: `operation-for-${process.handleId}`,
				owningGeneration: process.owningGeneration,
			},
			process,
		})),
		terminalExitCode: vi.fn(() => 0),
		wait: vi.fn(async ({ process }) => ({
			kind: 'terminal' as const,
			operation: {
				operationId: `operation-for-${process.handleId}`,
				owningGeneration: process.owningGeneration,
			},
			outcome: {
				certainty: 'proven' as const,
				completion: 'succeeded' as const,
				kind: 'completed' as const,
				retryClass: 'forbidden' as const,
			},
			process,
		})),
		write: vi.fn(async ({ sequence, stream, content }) => ({
			bytesWritten: content.byteLength,
			kind: 'written' as const,
			sequence,
			stream,
		})),
	} satisfies GatewayRuntimeSandboxProcessRegistry;
	const strictSshClient = {
		close: vi.fn(),
		connect: vi.fn(async (): Promise<void> => undefined),
		execute: vi.fn(async () => ({
			exitCode: 0,
			kind: 'exited' as const,
			stderr: new Uint8Array(),
			stdout: new Uint8Array(),
		})),
		guestListDirectory: vi.fn(async () => []),
		guestMkdir: vi.fn(async (): Promise<void> => undefined),
		guestReadFile: vi.fn(async () => Uint8Array.from(Buffer.from('file-content'))),
		guestRemove: vi.fn(async (): Promise<void> => undefined),
		guestRename: vi.fn(async (): Promise<void> => undefined),
		guestStat: vi.fn(async () => ({ byteLength: 12, kind: 'file' as const })),
		guestWriteFile: vi.fn(async (): Promise<void> => undefined),
		listDirectory: vi.fn(async () => []),
		mkdir: vi.fn(async (): Promise<void> => undefined),
		observeTransportFailure: vi.fn(() => ({ unsubscribe: (): void => undefined })),
		readFile: vi.fn(async () => new Uint8Array()),
		remove: vi.fn(async (): Promise<void> => undefined),
		rename: vi.fn(async (): Promise<void> => undefined),
		stat: vi.fn(async () => ({ byteLength: 0, kind: 'file' as const })),
		writeFile: vi.fn(async (): Promise<void> => undefined),
	} satisfies StrictToolVmSshClient;
	const operationAuthority = createGatewayRuntimeSandboxOperationAuthority(operationContext);
	const retireGroup = vi.fn(async (): Promise<void> => undefined);
	const binding = {
		endActiveUse: vi.fn(async (): Promise<void> => undefined),
		environmentGeneration: operationContext.environmentGeneration,
		kind: 'bound',
		operationAuthority,
		operationContext,
		processRegistry,
		retireGroup,
		strictSshClient,
	} satisfies GatewayRuntimeToolVmRunnerOperationGroup;
	const acquisitionAcquire = vi.fn(async () => binding);
	return {
		acquisitionAcquire,
		binding,
		dispatcher: createGatewayRuntimeProductionSandboxDispatcher({
			acquisitionPort: { acquire: acquisitionAcquire },
		}),
		processRegistry,
		strictSshClient,
	};
}

function dispatchRequest(
	fixture: DispatcherFixture,
	method: Parameters<DispatcherFixture['dispatcher']['dispatch']>[0]['method'],
	publicRequest: unknown,
	signal: AbortSignal = new AbortController().signal,
): Promise<unknown> {
	return fixture.dispatcher.dispatch({
		connectionId: 'connection-a',
		method,
		publicRequest,
		signal,
		trustedContext,
	});
}

describe('Gateway Runtime production Sandbox dispatcher', () => {
	it('dispatches direct shell command, guest cwd, and environment without capability lookup', async () => {
		// Arrange
		const fixture = createDispatcherFixture();
		const opened = await fixture.dispatcher.dispatch({
			connectionId: 'connection-a',
			method: 'sandbox.environment.open',
			publicRequest: { logicalCwd: 'repo' },
			signal: new AbortController().signal,
			trustedContext,
		});
		if (typeof opened !== 'object' || opened === null || !('environment' in opened)) {
			throw new Error('Sandbox environment did not open.');
		}
		const environment = opened.environment;

		// Act
		const result = await dispatchRequest(fixture, 'sandbox.exec.start', {
			command: 'pnpm test --filter agent-a',
			cwd: '/workspace',
			environment,
			environmentVariables: [{ name: 'MODE', value: 'beta' }],
			mode: { kind: 'direct' },
			timeoutMs: 5_000,
		});

		// Assert
		expect(result).toMatchObject({ kind: 'started', mode: 'direct' });
		expect(fixture.processRegistry.startShell).toHaveBeenCalledWith({
			command: 'pnpm test --filter agent-a',
			cwd: '/workspace',
			environmentVariables: [{ name: 'MODE', value: 'beta' }],
			maxRuntimeMs: 5_000,
			retainOutputBytes: 16 * 1_024 * 1_024,
		});
		expect(fixture.processRegistry.start).not.toHaveBeenCalled();
		expect(JSON.stringify(result)).not.toContain('capability');
	});

	it('owns one active-use group for an environment and retires it after descendants drain', async () => {
		// Arrange
		const fixture = createDispatcherFixture();
		const opened = await dispatchRequest(fixture, 'sandbox.environment.open', {});
		if (typeof opened !== 'object' || opened === null || !('environment' in opened)) {
			throw new Error('Sandbox environment did not open.');
		}

		// Act
		await dispatchRequest(fixture, 'sandbox.fs.stat', {
			environment: opened.environment,
			path: '/workspace/file',
		});
		const started = await dispatchRequest(fixture, 'sandbox.exec.start', {
			command: 'printf descendant',
			environment: opened.environment,
			mode: { kind: 'direct' },
			timeoutMs: 5_000,
		});
		const parsedStarted = SandboxExecStartResultSchema.parse(started);
		if (parsedStarted.kind !== 'started' || parsedStarted.mode !== 'direct') {
			throw new Error('Sandbox descendant process did not start directly.');
		}
		const descendantStream = parsedStarted.streams[0];
		if (descendantStream === undefined) throw new Error('Sandbox descendant stream is missing.');
		await dispatchRequest(fixture, 'sandbox.stream.read', {
			maxBytes: 16,
			stream: descendantStream,
		});
		const closed = await dispatchRequest(fixture, 'sandbox.environment.close', {
			environment: opened.environment,
		});
		const alreadyClosed = await dispatchRequest(fixture, 'sandbox.environment.close', {
			environment: opened.environment,
		});

		// Assert
		expect(closed).toMatchObject({ kind: 'closed' });
		expect(alreadyClosed).toMatchObject({ kind: 'already-closed' });
		expect(fixture.acquisitionAcquire).toHaveBeenCalledTimes(1);
		expect(fixture.processRegistry.retire).toHaveBeenCalledTimes(1);
		expect(fixture.binding.retireGroup).toHaveBeenCalledWith('completed');
		expect(vi.mocked(fixture.processRegistry.retire).mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(fixture.binding.retireGroup).mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
		);
		await expect(
			dispatchRequest(fixture, 'sandbox.exec.wait', {
				operation: parsedStarted.operation,
				timeoutMs: 1_000,
			}),
		).rejects.toThrow(/stale|different environment group/i);
	});

	it('isolates environment handles across independently acquired groups', async () => {
		// Arrange
		const groupA = createDispatcherFixture();
		const groupB = createDispatcherFixture();
		const operationContextB = {
			...operationContext,
			activeUseId: 'active-use-b',
			environmentGeneration: 'environment-generation-b',
		} as const;
		const acquisitionB = {
			...groupB.binding,
			environmentGeneration: operationContextB.environmentGeneration,
			operationAuthority: createGatewayRuntimeSandboxOperationAuthority(operationContextB),
			operationContext: operationContextB,
		} satisfies GatewayRuntimeToolVmRunnerOperationGroup;
		const acquire = vi
			.fn()
			.mockResolvedValueOnce(groupA.binding)
			.mockResolvedValueOnce(acquisitionB);
		const dispatcher = createGatewayRuntimeProductionSandboxDispatcher({
			acquisitionPort: { acquire },
		});
		const dispatch = async (
			method: Parameters<typeof dispatcher.dispatch>[0]['method'],
			publicRequest: unknown,
		): Promise<unknown> =>
			await dispatcher.dispatch({
				connectionId: 'connection-a',
				method,
				publicRequest,
				signal: new AbortController().signal,
				trustedContext,
			});

		// Act
		const openedA = await dispatch('sandbox.environment.open', {});
		const openedB = await dispatch('sandbox.environment.open', {});
		const parsedOpenedA = SandboxEnvironmentOpenResultSchema.parse(openedA);
		const parsedOpenedB = SandboxEnvironmentOpenResultSchema.parse(openedB);
		await dispatch('sandbox.fs.stat', {
			environment: parsedOpenedA.environment,
			path: '/workspace/a',
		});
		await dispatch('sandbox.fs.stat', {
			environment: parsedOpenedB.environment,
			path: '/workspace/b',
		});

		// Assert
		expect(groupA.strictSshClient.guestStat).toHaveBeenCalledWith({ path: '/workspace/a' });
		expect(groupB.strictSshClient.guestStat).toHaveBeenCalledWith({ path: '/workspace/b' });
		expect(acquire).toHaveBeenCalledTimes(2);
		await expect(
			dispatch('sandbox.fs.stat', {
				environment: {
					...parsedOpenedA.environment,
					owningGeneration: operationContextB.environmentGeneration,
				},
				path: '/workspace/crossed',
			}),
		).rejects.toThrow(/stale|different environment group/i);
	});

	it('retires every open environment group when the dispatcher retires', async () => {
		// Arrange
		const fixture = createDispatcherFixture();
		await dispatchRequest(fixture, 'sandbox.environment.open', {});

		// Act
		await fixture.dispatcher.retire();
		await fixture.dispatcher.retire();

		// Assert
		expect(fixture.processRegistry.retire).toHaveBeenCalledTimes(1);
		expect(fixture.binding.retireGroup).toHaveBeenCalledTimes(1);
		expect(fixture.binding.retireGroup).toHaveBeenCalledWith('cancelled');
		expect(fixture.binding.endActiveUse).not.toHaveBeenCalled();
		expect(fixture.acquisitionAcquire).toHaveBeenCalledTimes(1);
	});

	it('waits for an in-flight filesystem descendant before retiring its environment group', async () => {
		// Arrange
		const fixture = createDispatcherFixture();
		const opened = SandboxEnvironmentOpenResultSchema.parse(
			await dispatchRequest(fixture, 'sandbox.environment.open', {}),
		);
		const statStarted = Promise.withResolvers<void>();
		const statResult = Promise.withResolvers<{
			readonly byteLength: number;
			readonly kind: 'file';
		}>();
		vi.mocked(fixture.strictSshClient.guestStat).mockImplementationOnce(async () => {
			statStarted.resolve();
			return await statResult.promise;
		});

		// Act
		const pendingStat = dispatchRequest(fixture, 'sandbox.fs.stat', {
			environment: opened.environment,
			path: '/workspace/in-flight',
		});
		await statStarted.promise;
		const pendingClose = dispatchRequest(fixture, 'sandbox.environment.close', {
			environment: opened.environment,
		});

		// Assert
		expect(fixture.binding.retireGroup).not.toHaveBeenCalled();
		statResult.resolve({ byteLength: 1, kind: 'file' });
		await expect(pendingStat).resolves.toMatchObject({ kind: 'stat' });
		await expect(pendingClose).resolves.toMatchObject({ kind: 'closed' });
		expect(fixture.binding.retireGroup).toHaveBeenCalledWith('completed');
	});

	it('resolves relative filesystem paths from environment cwd and preserves absolute guest paths', async () => {
		// Arrange
		const fixture = createDispatcherFixture();
		const opened = await fixture.dispatcher.dispatch({
			connectionId: 'connection-a',
			method: 'sandbox.environment.open',
			publicRequest: { logicalCwd: 'repo' },
			signal: new AbortController().signal,
			trustedContext,
		});
		if (typeof opened !== 'object' || opened === null || !('environment' in opened)) {
			throw new Error('Sandbox environment did not open.');
		}

		// Act
		const relativeRead = await dispatchRequest(fixture, 'sandbox.fs.read', {
			environment: opened.environment,
			maxBytes: 4,
			offsetBytes: 0,
			path: 'src/index.ts',
		});
		await dispatchRequest(fixture, 'sandbox.fs.stat', {
			environment: opened.environment,
			path: '/workspace/memory/notes.md',
		});

		// Assert
		expect(fixture.strictSshClient.guestReadFile).toHaveBeenCalledWith({
			path: '/work/repo/src/index.ts',
		});
		expect(fixture.strictSshClient.guestStat).toHaveBeenCalledWith({
			path: '/workspace/memory/notes.md',
		});
		expect(relativeRead).toMatchObject({ path: '/work/repo/src/index.ts' });
	});

	it('enforces operation-aware filesystem roots before SSH dispatch', async () => {
		// Arrange
		const fixture = createDispatcherFixture();
		const opened = await dispatchRequest(fixture, 'sandbox.environment.open', {});
		if (typeof opened !== 'object' || opened === null || !('environment' in opened)) {
			throw new Error('Sandbox environment did not open.');
		}

		// Act and assert
		for (const rejectedPath of [
			'/zone/private',
			'/agent-vm/agents.md',
			'/etc/passwd',
			'/controller-state/leases.json',
			'/workspace-sibling/private',
			'/work/../etc/passwd',
			'/work/repo/../other-agent',
			'/work/nul\0suffix',
		]) {
			// oxlint-disable-next-line no-await-in-loop -- Each rejected path is checked against the same untouched SSH fixture.
			await expect(
				dispatchRequest(fixture, 'sandbox.fs.stat', {
					environment: opened.environment,
					path: rejectedPath,
				}),
			).rejects.toThrow();
		}
		await expect(
			dispatchRequest(fixture, 'sandbox.fs.write', {
				atomic: false,
				content: { byteLength: 1, contentBase64: 'eA==', encoding: 'base64' },
				environment: opened.environment,
				path: '/agent-vm/agents.md',
			}),
		).rejects.toThrow(/outside|operation-admitted/i);
		await expect(
			dispatchRequest(fixture, 'sandbox.fs.rename', {
				destinationPath: '/agent-vm/replaced.md',
				environment: opened.environment,
				replace: false,
				sourcePath: '/workspace/source.md',
			}),
		).rejects.toThrow(/outside|operation-admitted/i);
		expect(fixture.strictSshClient.guestWriteFile).not.toHaveBeenCalled();
		expect(fixture.strictSshClient.guestRename).not.toHaveBeenCalled();
	});

	it('rejects write allocations beyond the canonical filesystem byte ceiling', async () => {
		// Arrange
		const fixture = createDispatcherFixture();
		const opened = await dispatchRequest(fixture, 'sandbox.environment.open', {});
		if (typeof opened !== 'object' || opened === null || !('environment' in opened)) {
			throw new Error('Sandbox environment did not open.');
		}

		// Act and assert
		await expect(
			dispatchRequest(fixture, 'sandbox.fs.write', {
				atomic: false,
				content: { byteLength: 1, contentBase64: 'eA==', encoding: 'base64' },
				environment: opened.environment,
				offsetBytes: SANDBOX_MAXIMUM_BINARY_BYTES,
				path: '/workspace/huge-offset.bin',
			}),
		).rejects.toThrow(/byte ceiling|maximum/i);
		vi.mocked(fixture.strictSshClient.guestStat).mockResolvedValueOnce({
			byteLength: SANDBOX_MAXIMUM_BINARY_BYTES + 1,
			kind: 'file',
		});
		await expect(
			dispatchRequest(fixture, 'sandbox.fs.write', {
				atomic: false,
				content: { byteLength: 1, contentBase64: 'eA==', encoding: 'base64' },
				environment: opened.environment,
				offsetBytes: 0,
				path: '/workspace/oversized-existing.bin',
			}),
		).rejects.toThrow(/byte ceiling|maximum/i);
		expect(fixture.strictSshClient.guestReadFile).not.toHaveBeenCalled();
		expect(fixture.strictSshClient.guestWriteFile).not.toHaveBeenCalled();
	});

	it('rejects recursive removal trees beyond the entry and depth bounds before deletion', async () => {
		// Arrange
		const entryFixture = createDispatcherFixture();
		const entryEnvironment = await dispatchRequest(entryFixture, 'sandbox.environment.open', {});
		if (
			typeof entryEnvironment !== 'object' ||
			entryEnvironment === null ||
			!('environment' in entryEnvironment)
		) {
			throw new Error('Sandbox environment did not open.');
		}
		vi.mocked(entryFixture.strictSshClient.guestStat).mockImplementation(async ({ path }) => ({
			byteLength: 0,
			kind: path === '/workspace/tree' ? 'directory' : 'file',
		}));
		vi.mocked(entryFixture.strictSshClient.guestListDirectory).mockResolvedValue(
			Array.from({ length: 1_000 }, (_, index) =>
				directoryEntry({ filename: `entry-${String(index)}`, kind: 'file' }),
			),
		);

		// Act and assert
		await expect(
			dispatchRequest(entryFixture, 'sandbox.fs.remove', {
				environment: entryEnvironment.environment,
				path: '/workspace/tree',
				recursive: true,
			}),
		).rejects.toThrow(/entry bound/i);
		expect(entryFixture.strictSshClient.guestRemove).not.toHaveBeenCalled();

		const depthFixture = createDispatcherFixture();
		const depthEnvironment = await dispatchRequest(depthFixture, 'sandbox.environment.open', {});
		if (
			typeof depthEnvironment !== 'object' ||
			depthEnvironment === null ||
			!('environment' in depthEnvironment)
		) {
			throw new Error('Sandbox environment did not open.');
		}
		vi.mocked(depthFixture.strictSshClient.guestStat).mockResolvedValue({
			byteLength: 0,
			kind: 'directory',
		});
		vi.mocked(depthFixture.strictSshClient.guestListDirectory).mockImplementation(
			async ({ path }) =>
				path.split('/').length < 40
					? [directoryEntry({ filename: 'child', kind: 'directory' })]
					: [],
		);
		await expect(
			dispatchRequest(depthFixture, 'sandbox.fs.remove', {
				environment: depthEnvironment.environment,
				path: '/workspace/tree',
				recursive: true,
			}),
		).rejects.toThrow(/depth bound/i);
		expect(depthFixture.strictSshClient.guestRemove).not.toHaveBeenCalled();
	});

	it('rejects recursive removal when its traversal time bound expires', async () => {
		// Arrange
		const fixture = createDispatcherFixture();
		const opened = await dispatchRequest(fixture, 'sandbox.environment.open', {});
		if (typeof opened !== 'object' || opened === null || !('environment' in opened)) {
			throw new Error('Sandbox environment did not open.');
		}
		vi.mocked(fixture.strictSshClient.guestStat).mockResolvedValue({
			byteLength: 0,
			kind: 'directory',
		});
		const dateNow = vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(60_001);

		// Act and assert
		await expect(
			dispatchRequest(fixture, 'sandbox.fs.remove', {
				environment: opened.environment,
				path: '/workspace/tree',
				recursive: true,
			}),
		).rejects.toThrow(/time bound/i);
		expect(fixture.strictSshClient.guestListDirectory).not.toHaveBeenCalled();
		expect(fixture.strictSshClient.guestRemove).not.toHaveBeenCalled();
		dateNow.mockRestore();
	});

	it('rejects an aborted filesystem request before binding or SSH dispatch', async () => {
		// Arrange
		const fixture = createDispatcherFixture();
		const cancellation = new AbortController();
		cancellation.abort(new Error('caller cancelled filesystem request'));

		// Act and assert
		await expect(
			dispatchRequest(
				fixture,
				'sandbox.fs.stat',
				{
					environment: {
						handleId: 'environment-unused',
						kind: 'environment',
						owningGeneration: operationContext.environmentGeneration,
					},
					path: '/workspace/file',
				},
				cancellation.signal,
			),
		).rejects.toThrow(/caller cancelled/i);
		expect(fixture.strictSshClient.connect).not.toHaveBeenCalled();
		expect(fixture.strictSshClient.guestStat).not.toHaveBeenCalled();
	});

	it('reports cancellation after a filesystem side effect as an ambiguous mutation', async () => {
		// Arrange
		const fixture = createDispatcherFixture();
		const opened = await dispatchRequest(fixture, 'sandbox.environment.open', {});
		if (typeof opened !== 'object' || opened === null || !('environment' in opened)) {
			throw new Error('Sandbox environment did not open.');
		}
		const cancellation = new AbortController();
		vi.mocked(fixture.strictSshClient.guestWriteFile).mockImplementationOnce(async () => {
			cancellation.abort(new Error('caller cancelled during write'));
		});

		// Act and assert
		await expect(
			dispatchRequest(
				fixture,
				'sandbox.fs.write',
				{
					atomic: false,
					content: { byteLength: 1, contentBase64: 'eA==', encoding: 'base64' },
					environment: opened.environment,
					path: '/workspace/file',
				},
				cancellation.signal,
			),
		).rejects.toThrow(/ambiguous outcome.*side effects may have completed/i);
		expect(fixture.strictSshClient.guestWriteFile).toHaveBeenCalledTimes(1);
	});

	it('starts, streams, attaches, and resizes terminal work through one fenced process registry', async () => {
		// Arrange
		const fixture = createDispatcherFixture();
		const opened = await fixture.dispatcher.dispatch({
			connectionId: 'connection-a',
			method: 'sandbox.environment.open',
			publicRequest: {},
			signal: new AbortController().signal,
			trustedContext,
		});
		if (typeof opened !== 'object' || opened === null || !('environment' in opened)) {
			throw new Error('Sandbox environment did not open.');
		}
		const reserved = await dispatchRequest(fixture, 'sandbox.exec.start', {
			command: 'bash',
			environment: opened.environment,
			mode: { attachTimeoutMs: 10_000, kind: 'attachment-reserved', terminal: true },
			timeoutMs: 60_000,
		});
		if (
			typeof reserved !== 'object' ||
			reserved === null ||
			!('operation' in reserved) ||
			!('terminal' in reserved)
		) {
			throw new Error('Sandbox terminal was not reserved.');
		}

		// Act
		const attached = await dispatchRequest(fixture, 'sandbox.terminal.attach', {
			operation: reserved.operation,
			size: { columns: 120, rows: 40 },
		});
		await dispatchRequest(fixture, 'sandbox.terminal.resize', {
			size: { columns: 160, rows: 50 },
			terminal: reserved.terminal,
		});

		// Assert
		expect(attached).toMatchObject({ kind: 'attached', terminal: reserved.terminal });
		expect(fixture.processRegistry.startShell).toHaveBeenLastCalledWith(
			expect.objectContaining({
				command: 'bash',
				cwd: '/work',
				terminalSize: { columns: 120, rows: 40 },
			}),
		);
		expect(fixture.processRegistry.resizeTerminal).toHaveBeenCalledWith({
			process: processStartResult(1).process,
			size: { columns: 160, rows: 50 },
		});
	});

	it('rejects stale generations and cross-agent reuse before process dispatch', async () => {
		// Arrange
		const fixture = createDispatcherFixture();
		const opened = await fixture.dispatcher.dispatch({
			connectionId: 'connection-a',
			method: 'sandbox.environment.open',
			publicRequest: {},
			signal: new AbortController().signal,
			trustedContext,
		});
		if (typeof opened !== 'object' || opened === null || !('environment' in opened)) {
			throw new Error('Sandbox environment did not open.');
		}
		const otherAgentContext = {
			...trustedContext,
			principal: {
				...trustedContext.principal,
				agentId: 'agent-b',
				frameworkIdentity: { kind: 'hermes' as const, profileName: 'agent-b' },
			},
		} satisfies GatewayRuntimeTrustedInvocationContext;

		// Act and assert
		await expect(
			fixture.dispatcher.dispatch({
				connectionId: 'connection-b',
				method: 'sandbox.fs.stat',
				publicRequest: { environment: opened.environment, path: '/workspace/file' },
				signal: new AbortController().signal,
				trustedContext: otherAgentContext,
			}),
		).rejects.toThrow(/stale|different environment group/i);
		fixture.binding.operationAuthority.beginReplacement({
			replacementLeafGeneration: 'leaf-generation-b',
		});
		await expect(
			dispatchRequest(fixture, 'sandbox.fs.stat', {
				environment: opened.environment,
				path: '/workspace/file',
			}),
		).rejects.toThrow(/retired, unavailable, or stale/i);
		expect(fixture.acquisitionAcquire).toHaveBeenCalledTimes(1);
		expect(fixture.processRegistry.startShell).not.toHaveBeenCalled();
	});

	it('reports a replaced environment after its Tool VM binding is invalidated', async () => {
		// Arrange
		const fixture = createDispatcherFixture();
		const opened = SandboxEnvironmentOpenResultSchema.parse(
			await dispatchRequest(fixture, 'sandbox.environment.open', {}),
		);
		fixture.binding.operationAuthority.beginReplacement({
			replacementLeafGeneration: 'leaf-generation-b',
		});

		// Act
		const status = await dispatchRequest(fixture, 'sandbox.environment.status', {
			environment: opened.environment,
		});

		// Assert
		expect(status).toMatchObject({
			environment: opened.environment,
			kind: 'replaced',
		});
		expect(fixture.acquisitionAcquire).toHaveBeenCalledTimes(1);
	});

	it('rejects reuse of one active-use acquisition for a second environment', async () => {
		// Arrange
		const fixture = createDispatcherFixture();
		const dispatcher = createGatewayRuntimeProductionSandboxDispatcher({
			acquisitionPort: { acquire: vi.fn(async () => fixture.binding) },
		});

		// Act
		const first = await dispatcher.dispatch({
			connectionId: 'connection-a',
			method: 'sandbox.environment.open',
			publicRequest: {},
			signal: new AbortController().signal,
			trustedContext,
		});
		// Assert
		expect(first).toMatchObject({ kind: 'opened' });
		await expect(
			dispatcher.dispatch({
				connectionId: 'connection-a',
				method: 'sandbox.environment.open',
				publicRequest: {},
				signal: new AbortController().signal,
				trustedContext,
			}),
		).rejects.toThrow(/active-use group was acquired more than once/i);
		expect(fixture.strictSshClient.connect).toHaveBeenCalledTimes(1);
	});

	it('returns only terminal exec wait results and rejects a bounded wait that remains running', async () => {
		// Arrange
		const fixture = createDispatcherFixture();
		const opened = await dispatchRequest(fixture, 'sandbox.environment.open', {});
		if (typeof opened !== 'object' || opened === null || !('environment' in opened)) {
			throw new Error('Sandbox environment did not open.');
		}
		const started = await dispatchRequest(fixture, 'sandbox.exec.start', {
			command: 'sleep 30',
			environment: opened.environment,
			mode: { kind: 'direct' },
			timeoutMs: 60_000,
		});
		if (typeof started !== 'object' || started === null || !('operation' in started)) {
			throw new Error('Sandbox execution did not start.');
		}

		// Act and assert
		const terminal = await dispatchRequest(fixture, 'sandbox.exec.wait', {
			operation: started.operation,
			timeoutMs: 1_000,
		});
		expect(() => SandboxExecWaitResultSchema.parse(terminal)).not.toThrow();
		expect(terminal).toMatchObject({ exitCode: 0 });
		vi.mocked(fixture.processRegistry.wait).mockResolvedValueOnce({
			kind: 'running',
			operation: processStartResult(1).operation,
			process: processStartResult(1).process,
		});
		await expect(
			dispatchRequest(fixture, 'sandbox.exec.wait', {
				operation: started.operation,
				timeoutMs: 1_000,
			}),
		).rejects.toThrow(/deadline expired.*running/i);
	});

	it('removes evicted process aliases while retaining authority for current records', async () => {
		// Arrange
		const fixture = createDispatcherFixture();
		const opened = SandboxEnvironmentOpenResultSchema.parse(
			await dispatchRequest(fixture, 'sandbox.environment.open', {}),
		);
		const evictedProcessHandleIds = new Set<string>();
		vi.mocked(fixture.processRegistry.status).mockImplementation(({ process }) => {
			if (evictedProcessHandleIds.has(process.handleId)) {
				throw new Error('Strict SSH process handle is forged, stale, or unavailable.');
			}
			return {
				kind: 'running',
				operation: {
					operationId: `operation-for-${process.handleId}`,
					owningGeneration: process.owningGeneration,
				},
				process,
			};
		});
		const startedRecords: Array<ReturnType<typeof processStartResult>> = [];

		// Act
		for (let index = 0; index < 16; index += 1) {
			const previous = startedRecords.at(-1);
			if (previous !== undefined) evictedProcessHandleIds.add(previous.process.handleId);
			const started = SandboxExecStartResultSchema.parse(
				// oxlint-disable-next-line no-await-in-loop -- Each successful start triggers reconciliation against the preceding simulated eviction.
				await dispatchRequest(fixture, 'sandbox.exec.start', {
					command: `printf ${String(index)}`,
					environment: opened.environment,
					mode: { kind: 'direct' },
					timeoutMs: 5_000,
				}),
			);
			if (started.kind !== 'started' || started.mode !== 'direct') {
				throw new Error('Sandbox execution did not start directly.');
			}
			startedRecords.push({
				kind: 'started',
				operation: started.operation,
				process: processStartResult(index + 1).process,
				streams: started.streams,
			});
		}
		const evictedRecords = startedRecords.slice(0, -1);
		const oldest = evictedRecords[0];
		const current = startedRecords.at(-1);
		if (oldest === undefined || current === undefined)
			throw new Error('Process records are missing.');
		const statusCallCountBeforeRejectedAliases = vi.mocked(fixture.processRegistry.status).mock
			.calls.length;

		// Assert
		await Promise.all(
			evictedRecords.map(async (record) => {
				await expect(
					dispatchRequest(fixture, 'sandbox.process.status', { process: record.process }),
				).rejects.toThrow(/stale|different environment group/i);
				await expect(
					dispatchRequest(fixture, 'sandbox.stream.read', {
						maxBytes: 16,
						stream: record.streams[1],
					}),
				).rejects.toThrow(/stale|different environment group/i);
			}),
		);
		expect(vi.mocked(fixture.processRegistry.status)).toHaveBeenCalledTimes(
			statusCallCountBeforeRejectedAliases,
		);
		const waitCallCountBeforeRejectedOperation = vi.mocked(fixture.processRegistry.wait).mock.calls
			.length;
		await expect(
			dispatchRequest(fixture, 'sandbox.exec.wait', {
				operation: oldest.operation,
				timeoutMs: 1_000,
			}),
		).rejects.toThrow(/stale|different environment group/i);
		expect(fixture.processRegistry.wait).toHaveBeenCalledTimes(
			waitCallCountBeforeRejectedOperation,
		);
		const retained = await dispatchRequest(fixture, 'sandbox.retained-result.lookup', {
			operation: oldest.operation,
		});
		expect(SandboxRetainedResultLookupResultSchema.parse(retained)).toEqual({
			kind: 'unavailable',
			reason: 'not-retained-or-not-authorized',
		});
		await expect(
			dispatchRequest(fixture, 'sandbox.process.status', { process: current.process }),
		).resolves.toMatchObject({ kind: 'running', process: current.process });

		const reserved = SandboxExecStartResultSchema.parse(
			await dispatchRequest(fixture, 'sandbox.exec.start', {
				command: 'bash',
				environment: opened.environment,
				mode: { attachTimeoutMs: 10_000, kind: 'attachment-reserved', terminal: true },
				timeoutMs: 60_000,
			}),
		);
		if (reserved.kind !== 'started' || reserved.mode !== 'attachment-reserved') {
			throw new Error('Sandbox terminal was not reserved.');
		}
		SandboxTerminalAttachResultSchema.parse(
			await dispatchRequest(fixture, 'sandbox.terminal.attach', {
				operation: reserved.operation,
				size: { columns: 120, rows: 40 },
			}),
		);
		evictedProcessHandleIds.add(processStartResult(17).process.handleId);
		await dispatchRequest(fixture, 'sandbox.exec.start', {
			command: 'printf current',
			environment: opened.environment,
			mode: { kind: 'direct' },
			timeoutMs: 5_000,
		});
		const resizeCallCountBeforeRejectedTerminal = vi.mocked(fixture.processRegistry.resizeTerminal)
			.mock.calls.length;
		await expect(
			dispatchRequest(fixture, 'sandbox.terminal.resize', {
				size: { columns: 160, rows: 50 },
				terminal: reserved.terminal,
			}),
		).rejects.toThrow(/stale|different environment group/i);
		expect(fixture.processRegistry.resizeTerminal).toHaveBeenCalledTimes(
			resizeCallCountBeforeRejectedTerminal,
		);
	});

	it.each([1, 127])('returns the exact proven exec exit code %i', async (exitCode) => {
		// Arrange
		const fixture = createDispatcherFixture();
		vi.mocked(fixture.processRegistry.terminalExitCode).mockReturnValue(exitCode);
		const opened = await dispatchRequest(fixture, 'sandbox.environment.open', {});
		if (typeof opened !== 'object' || opened === null || !('environment' in opened)) {
			throw new Error('Sandbox environment did not open.');
		}
		const started = await dispatchRequest(fixture, 'sandbox.exec.start', {
			command: 'exit',
			environment: opened.environment,
			mode: { kind: 'direct' },
			timeoutMs: 60_000,
		});
		if (typeof started !== 'object' || started === null || !('operation' in started)) {
			throw new Error('Sandbox execution did not start.');
		}

		// Act
		const terminal = await dispatchRequest(fixture, 'sandbox.exec.wait', {
			operation: started.operation,
			timeoutMs: 1_000,
		});

		// Assert
		expect(terminal).toMatchObject({ exitCode });
	});

	it.each([
		{
			certainty: 'proven-terminated',
			kind: 'cancelled-proven',
			retryClass: 'manual-only',
		},
		{
			certainty: 'proven-terminated',
			kind: 'timed-out-proven',
			retryClass: 'manual-only',
		},
		{
			certainty: 'side-effects-and-termination-unknown',
			kind: 'ambiguous',
			retryClass: 'forbidden',
		},
	] as const)('omits exit code for the $kind exec outcome', async (outcome) => {
		// Arrange
		const fixture = createDispatcherFixture();
		vi.mocked(fixture.processRegistry.terminalExitCode).mockReturnValue(undefined);
		const opened = await dispatchRequest(fixture, 'sandbox.environment.open', {});
		if (typeof opened !== 'object' || opened === null || !('environment' in opened)) {
			throw new Error('Sandbox environment did not open.');
		}
		const started = await dispatchRequest(fixture, 'sandbox.exec.start', {
			command: 'exit',
			environment: opened.environment,
			mode: { kind: 'direct' },
			timeoutMs: 60_000,
		});
		if (typeof started !== 'object' || started === null || !('operation' in started)) {
			throw new Error('Sandbox execution did not start.');
		}
		vi.mocked(fixture.processRegistry.wait).mockResolvedValueOnce({
			kind: 'terminal',
			operation: processStartResult(1).operation,
			outcome,
			process: processStartResult(1).process,
		});

		// Act
		const terminal = await dispatchRequest(fixture, 'sandbox.exec.wait', {
			operation: started.operation,
			timeoutMs: 1_000,
		});

		// Assert
		expect(terminal).not.toHaveProperty('exitCode');
		if (outcome.kind === 'ambiguous') {
			expect(fixture.processRegistry.terminalExitCode).not.toHaveBeenCalled();
		}
	});

	it('recursively lists guest entries with stable bounded cursors', async () => {
		// Arrange
		const fixture = createDispatcherFixture();
		const opened = await dispatchRequest(fixture, 'sandbox.environment.open', {});
		if (typeof opened !== 'object' || opened === null || !('environment' in opened)) {
			throw new Error('Sandbox environment did not open.');
		}
		vi.mocked(fixture.strictSshClient.guestListDirectory).mockImplementation(async ({ path }) =>
			path === '/workspace'
				? [
						directoryEntry({ filename: 'src', kind: 'directory' }),
						directoryEntry({ byteLength: 4, filename: 'README.md', kind: 'file' }),
					]
				: [directoryEntry({ byteLength: 8, filename: 'index.ts', kind: 'file' })],
		);

		// Act
		const first = await dispatchRequest(fixture, 'sandbox.fs.list', {
			environment: opened.environment,
			maxDepth: 2,
			maxEntries: 2,
			path: '/workspace',
		});
		const parsedFirst = SandboxFsListResultSchema.parse(first);
		const second = await dispatchRequest(fixture, 'sandbox.fs.list', {
			cursor: parsedFirst.nextCursor,
			environment: opened.environment,
			maxDepth: 2,
			maxEntries: 2,
			path: '/workspace',
		});
		const parsedSecond = SandboxFsListResultSchema.parse(second);

		// Assert
		expect(parsedFirst.entries.map((entry) => entry.path)).toEqual([
			'/workspace/README.md',
			'/workspace/src',
		]);
		expect(parsedFirst.nextCursor).toBe('sandbox-list:2');
		expect(parsedSecond.entries.map((entry) => entry.path)).toEqual(['/workspace/src/index.ts']);
		expect(parsedSecond.nextCursor).toBeUndefined();
	});

	it('reports filesystem absence, truthful mkdir, and recursive removal', async () => {
		// Arrange
		const fixture = createDispatcherFixture();
		const opened = await dispatchRequest(fixture, 'sandbox.environment.open', {});
		if (typeof opened !== 'object' || opened === null || !('environment' in opened)) {
			throw new Error('Sandbox environment did not open.');
		}
		vi.mocked(fixture.strictSshClient.guestStat).mockImplementation(async ({ path }) => {
			if (path === '/workspace/missing' || path === '/workspace/new') throw missingPathError();
			return { byteLength: 0, kind: path === '/workspace/tree/file' ? 'file' : 'directory' };
		});
		vi.mocked(fixture.strictSshClient.guestListDirectory).mockImplementation(async ({ path }) =>
			path === '/workspace/tree' ? [directoryEntry({ filename: 'file', kind: 'file' })] : [],
		);

		// Act
		const missing = await dispatchRequest(fixture, 'sandbox.fs.stat', {
			environment: opened.environment,
			path: '/workspace/missing',
		});
		const existingDirectory = await dispatchRequest(fixture, 'sandbox.fs.mkdir', {
			environment: opened.environment,
			path: '/workspace',
			recursive: false,
		});
		const createdDirectory = await dispatchRequest(fixture, 'sandbox.fs.mkdir', {
			environment: opened.environment,
			path: '/workspace/new',
			recursive: false,
		});
		const removed = await dispatchRequest(fixture, 'sandbox.fs.remove', {
			environment: opened.environment,
			path: '/workspace/tree',
			recursive: true,
		});

		// Assert
		expect(SandboxFsStatResultSchema.parse(missing)).toEqual({
			kind: 'not-found',
			path: '/workspace/missing',
		});
		expect(SandboxFsMkdirResultSchema.parse(existingDirectory)).toMatchObject({ created: false });
		expect(SandboxFsMkdirResultSchema.parse(createdDirectory)).toMatchObject({ created: true });
		expect(SandboxFsRemoveResultSchema.parse(removed)).toMatchObject({ removed: true });
		expect(fixture.strictSshClient.guestRemove).toHaveBeenNthCalledWith(1, {
			kind: 'file',
			path: '/workspace/tree/file',
		});
		expect(fixture.strictSshClient.guestRemove).toHaveBeenNthCalledWith(2, {
			kind: 'directory',
			path: '/workspace/tree',
		});
	});

	it('removes an atomic-write temporary file when rename fails', async () => {
		// Arrange
		const fixture = createDispatcherFixture();
		const opened = await dispatchRequest(fixture, 'sandbox.environment.open', {});
		if (typeof opened !== 'object' || opened === null || !('environment' in opened)) {
			throw new Error('Sandbox environment did not open.');
		}
		vi.mocked(fixture.strictSshClient.guestRename).mockRejectedValueOnce(
			new Error('rename failed'),
		);

		// Act and assert
		await expect(
			dispatchRequest(fixture, 'sandbox.fs.write', {
				atomic: true,
				content: { byteLength: 1, contentBase64: 'eA==', encoding: 'base64' },
				environment: opened.environment,
				path: '/workspace/file',
			}),
		).rejects.toThrow(/rename failed/i);
		const writtenPath = vi.mocked(fixture.strictSshClient.guestWriteFile).mock.calls[0]?.[0].path;
		expect(writtenPath).toMatch(/^\/workspace\/file\.agent-vm-.+\.tmp$/u);
		expect(fixture.strictSshClient.guestRemove).toHaveBeenCalledWith({
			kind: 'file',
			path: writtenPath,
		});
	});

	it('computes write content digests over the dispatched bytes', async () => {
		// Arrange
		const fixture = createDispatcherFixture();
		const opened = await fixture.dispatcher.dispatch({
			connectionId: 'connection-a',
			method: 'sandbox.environment.open',
			publicRequest: {},
			signal: new AbortController().signal,
			trustedContext,
		});
		if (typeof opened !== 'object' || opened === null || !('environment' in opened)) {
			throw new Error('Sandbox environment did not open.');
		}
		const content = Buffer.from('hello');

		// Act
		const result = await dispatchRequest(fixture, 'sandbox.fs.write', {
			atomic: false,
			content: {
				byteLength: content.byteLength,
				contentBase64: content.toString('base64'),
				encoding: 'base64',
			},
			environment: opened.environment,
			path: '/workspace/hello.txt',
		});

		// Assert
		expect(result).toMatchObject({
			contentDigest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
			path: '/workspace/hello.txt',
		});
	});
});
