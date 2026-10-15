import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	classifyPortalCompositionResponseFailure as classifyResponse,
	collectPortalCompositionFailureFacts as collectFacts,
	rethrowPortalCompositionFailure as rethrowFailure,
	type PortalCompositionFileInput,
	type PortalCompositionFileReader,
} from './portal-composition-failure-diagnostics.js';
import { requestPortalCompositionHermesTurn } from './portal-composition-hermes-e2e-support.js';

const privateMarker = 'synthetic-private-diagnostic-marker';

function installTurnResponse(response: Response): void {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
			if (init?.method === 'POST') return response;
			return Response.json({ kind: 'ok', latestEvents: [] });
		}),
	);
}

function requestFailingTurn(): Promise<string> {
	return requestPortalCompositionHermesTurn({
		agentId: 'fixture',
		apiServerKey: privateMarker,
		controllerUrl: 'http://controller.invalid',
		gatewayPort: 1,
		modelName: 'fixture',
		prompt: privateMarker,
		sessionId: privateMarker,
		zoneId: 'fixture',
	});
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe('Portal composition failure diagnostics at the request boundary', () => {
	it('reports the known ingress response without exposing the request context', async () => {
		installTurnResponse(
			new Response('bad gateway\n', { status: 502, headers: { 'content-type': 'text/plain' } }),
		);
		const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

		await expect(requestFailingTurn()).rejects.toThrow(/HTTP 502/u);

		const output = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');
		expect(output).toContain('gondolin-bad-gateway');
		expect(output).not.toContain(privateMarker);
	});

	it('preserves the HTTP failure when body cancellation never settles', async () => {
		vi.useFakeTimers();
		const response = new Response(
			new ReadableStream<Uint8Array>({
				cancel: () => new Promise<void>(() => undefined),
			}),
			{ status: 502 },
		);
		installTurnResponse(response);
		vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
		let observedError: unknown;
		void requestFailingTurn().catch((error: unknown) => {
			observedError = error;
		});

		await vi.advanceTimersByTimeAsync(1_000);

		expect(observedError).toBeInstanceOf(Error);
		expect(String(observedError)).toContain('HTTP 502');
	});
});

const paths = {
	hostEffectPath: '/synthetic/host-effect',
	concurrencyOrderPath: '/synthetic/concurrency',
	lossOrderPath: '/synthetic/loss-order',
	lossPidPath: '/synthetic/loss-pid',
	lossFastTimestampPath: '/synthetic/loss-time',
};
const originPath = '/synthetic/workspace/portal-composition-tool-vm-origin.json';
const progress = {
	executeCodeToolCallsPrepared: 1,
	finalResponseIssued: false,
	firstExecuteCodeMarkerAccepted: false,
	firstExecuteCodeResultObserved: false,
	generatedTerminalToolCallsPrepared: 0,
	generatedTerminalResultPresent: false,
	promptedModelRequests: 1,
	secondExecuteCodeResultPresent: false,
};
const workspaceRequest = {
	sessionLabel: privateMarker,
	mounts: {
		'/workspace': {
			kind: 'owned-filtered-workspace',
			directory: { identity: { canonicalPath: '/synthetic/workspace' } },
		},
	},
};
function content(text: string): PortalCompositionFileInput {
	return { kind: 'content', text };
}
function reader(
	files: ReadonlyMap<string, PortalCompositionFileInput>,
): PortalCompositionFileReader {
	return async (filename: string): Promise<PortalCompositionFileInput> =>
		files.get(filename) ?? { kind: 'absent' };
}
const defaults = {
	paths,
	modelProgress: () => progress,
	mcpCalls: [],
	vmRequests: [workspaceRequest],
};
function incomplete(flags: unknown): string {
	return JSON.stringify({
		error: { code: 'agent_incomplete', message: privateMarker, hermes: flags },
		privateMarker,
	});
}

describe('closed bounded response classification', () => {
	it.each([
		['bad gateway\n', 'text/plain; charset=utf-8', 'gondolin-bad-gateway'],
		['bad gateway\n\n', 'text/plain', 'unknown'],
		['bad gateway\n', 'application/octet-stream', 'unknown'],
		[
			incomplete({ completed: false, partial: true, failed: true }),
			'application/json',
			'hermes-agent-incomplete',
		],
		[
			incomplete({ completed: false, partial: 'true', failed: true }),
			'application/json',
			'unknown',
		],
		[incomplete({ completed: false, failed: true }), 'application/json', 'unknown'],
		['{invalid ' + privateMarker, 'application/json', 'parse-failed'],
	] as const)(
		'classifies %s with %s without exposing input',
		async (body, contentType, expectedKind) => {
			const evidence = await classifyResponse(
				new Response(body, {
					status: 502,
					headers: { 'content-type': contentType, 'x-hermes-session-key': privateMarker },
				}),
			);
			expect(evidence.kind).toBe(expectedKind);
			expect(JSON.stringify(evidence)).not.toContain(privateMarker);
			expect(JSON.stringify(evidence)).not.toContain('session-key');
			if (evidence.kind === 'hermes-agent-incomplete') {
				expect(evidence).toEqual({
					kind: expectedKind,
					contentTypeClass: 'json',
					retainedBodyBytes: Buffer.byteLength(body),
					completed: false,
					partial: true,
					failed: true,
				});
			}
		},
	);
	it('retains at most 4096 bytes from a large chunk', async () => {
		expect(await classifyResponse(new Response(privateMarker.repeat(5000)))).toEqual({
			kind: 'truncated',
			contentTypeClass: 'text/plain',
			retainedBodyBytes: 4096,
		});
	});
	it('bounds an endless series of empty chunks', async () => {
		const body = new ReadableStream<Uint8Array>({
			pull: (controller): void => controller.enqueue(new Uint8Array()),
		});
		expect(await classifyResponse(new Response(body))).toEqual({
			kind: 'truncated',
			contentTypeClass: 'other',
			retainedBodyBytes: 0,
		});
	});
	it('projects only fixed state when reading and cancellation fail', async () => {
		const body = new ReadableStream<Uint8Array>({
			start: (controller): void => controller.error(new Error(privateMarker)),
		});
		expect(await classifyResponse(new Response(body))).toEqual({
			kind: 'read-failed',
			contentTypeClass: 'other',
			retainedBodyBytes: 0,
		});
	});
	it('handles an absent body without claiming a read failure', async () => {
		expect(await classifyResponse(new Response(null))).toEqual({
			kind: 'unknown',
			contentTypeClass: 'other',
			retainedBodyBytes: 0,
		});
	});
	it('caps a hanging read at 1000ms despite hanging cancellation', async () => {
		vi.useFakeTimers();
		const body = new ReadableStream<Uint8Array>({
			start: (controller): void => controller.enqueue(new TextEncoder().encode(privateMarker)),
			cancel: () => new Promise<void>(() => undefined),
		});
		let settled = false;
		const pending = classifyResponse(new Response(body)).then((value) => {
			settled = true;
			return value;
		});
		await vi.advanceTimersByTimeAsync(999);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(await pending).toEqual({
			kind: 'read-failed',
			contentTypeClass: 'other',
			retainedBodyBytes: privateMarker.length,
		});
	});
	it('preserves the HTTP failure when diagnostic output throws', async () => {
		installTurnResponse(new Response('bad gateway\n', { status: 502 }));
		vi.spyOn(process.stderr, 'write').mockImplementation(() => {
			throw new Error(privateMarker);
		});
		await expect(requestFailingTurn()).rejects.toThrow(
			/Portal composition Hermes turn failed with HTTP 502/u,
		);
	});
	it('does not observe a successful turn', async () => {
		installTurnResponse(new Response('successful-turn'));
		const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
		expect(await requestFailingTurn()).toBe('successful-turn');
		expect(stderr.mock.calls).toEqual([]);
	});
});

describe('bounded projection of existing fixture facts', () => {
	it('retains known phases while excluding private fields, labels, arguments and paths', async () => {
		const files = new Map<string, PortalCompositionFileInput>([
			[
				originPath,
				content(
					JSON.stringify({
						interpreter: '/opt/agent-vm-tools/bin/python3.13',
						hostSentinelVisible: false,
						privateMarker,
					}),
				),
			],
			[
				paths.hostEffectPath,
				content(JSON.stringify({ destination: 'controller-host', argv: [privateMarker] })),
			],
			[
				paths.concurrencyOrderPath,
				content(
					'prepared\nslow-admitted\n' +
						privateMarker +
						'\nfast-completed\nrelease-started\nslow-completed\n',
				),
			],
			[paths.lossOrderPath, content('loss-prepared\nloss-admitted\nloss-fast\n')],
			[paths.lossPidPath, content(privateMarker)],
			[paths.lossFastTimestampPath, content(privateMarker)],
		]);
		const mcpCalls = [
			{ name: 'read_thing', argumentsValue: privateMarker },
			{ name: privateMarker },
			{ name: 'write_thing' },
		];
		const evidence = await collectFacts({
			...defaults,
			modelProgress: () => ({ ...progress, privateMarker }),
			mcpCalls,
			readFile: reader(files),
			vmRequests: [
				workspaceRequest,
				{ sessionLabel: 'credentialed-runtime-' + privateMarker, mounts: {} },
				{ sessionLabel: privateMarker, mounts: {} },
			],
		});
		expect(evidence.model).toEqual({ kind: 'present-valid', progress });
		expect(evidence.mcp).toEqual({
			names: ['read_thing', 'write_thing'],
			unknownCount: 1,
			collectionTruncated: false,
		});
		expect(evidence.vmRequests).toEqual({
			toolVmWorkspace: 1,
			credentialedRuntime: 1,
			other: 1,
			collectionTruncated: false,
		});
		expect(evidence.origin).toEqual({
			kind: 'present-valid',
			interpreterIsManaged: true,
			hostSentinelVisible: false,
		});
		expect(evidence.hostEffect).toEqual({ kind: 'present-valid', destinationControllerHost: true });
		expect(evidence.concurrencyOrder).toEqual({
			kind: 'present',
			tokens: ['prepared', 'slow-admitted', 'fast-completed', 'release-started', 'slow-completed'],
			unknownCount: 1,
			collectionTruncated: false,
		});
		expect(evidence.lossOrder.tokens).toEqual(['loss-prepared', 'loss-admitted', 'loss-fast']);
		expect(evidence.lossPid).toEqual({ kind: 'present' });
		expect(evidence.lossTimestamp).toEqual({ kind: 'present' });
		for (const forbidden of [privateMarker, '/synthetic', 'argumentsValue', 'sessionLabel', 'argv'])
			expect(JSON.stringify(evidence)).not.toContain(forbidden);
	});
	it.each([
		[{ kind: 'absent' }, 'absent'],
		[{ kind: 'read-failed' }, 'read-failed'],
		[{ kind: 'truncated' }, 'malformed'],
		[content('{invalid ' + privateMarker), 'malformed'],
		[
			content(JSON.stringify({ interpreter: privateMarker, hostSentinelVisible: 'false' })),
			'malformed',
		],
	] satisfies readonly (readonly [PortalCompositionFileInput, string])[])(
		'distinguishes origin input %j',
		async (input, expectedKind) => {
			const evidence = await collectFacts({
				...defaults,
				readFile: reader(new Map([[originPath, input]])),
			});
			expect(evidence.origin).toEqual({ kind: expectedKind });
			expect(JSON.stringify(evidence)).not.toContain(privateMarker);
		},
	);
	it('separates no observed workspace request from an absent origin', async () => {
		expect(
			(await collectFacts({ ...defaults, vmRequests: [], readFile: reader(new Map()) })).origin,
		).toEqual({ kind: 'no-tool-vm-workspace-request' });
	});
	it('returns booleans for unknown interpreter and host destination', async () => {
		const files = new Map([
			[
				originPath,
				content(JSON.stringify({ interpreter: privateMarker, hostSentinelVisible: true })),
			],
			[
				paths.hostEffectPath,
				content(JSON.stringify({ destination: privateMarker, argv: [privateMarker] })),
			],
		]);
		const evidence = await collectFacts({ ...defaults, readFile: reader(files) });
		expect(evidence.origin).toEqual({
			kind: 'present-valid',
			interpreterIsManaged: false,
			hostSentinelVisible: true,
		});
		expect(evidence.hostEffect).toEqual({
			kind: 'present-valid',
			destinationControllerHost: false,
		});
		expect(JSON.stringify(evidence)).not.toContain(privateMarker);
	});
	it('caps file bytes, input collections, ordered tokens and model counters', async () => {
		const evidence = await collectFacts({
			...defaults,
			modelProgress: () => ({ ...progress, executeCodeToolCallsPrepared: 999999 }),
			mcpCalls: Array.from({ length: 500 }, () => ({ name: privateMarker })),
			vmRequests: Array.from({ length: 500 }, () => workspaceRequest),
			readFile: reader(
				new Map([
					[originPath, content(privateMarker.repeat(5000))],
					[paths.concurrencyOrderPath, content('prepared\n'.repeat(100))],
				]),
			),
		});
		expect(evidence.origin).toEqual({ kind: 'malformed' });
		expect(evidence.mcp).toEqual({ names: [], unknownCount: 64, collectionTruncated: true });
		expect(evidence.vmRequests).toEqual({
			toolVmWorkspace: 64,
			credentialedRuntime: 0,
			other: 0,
			collectionTruncated: true,
		});
		expect(evidence.concurrencyOrder.tokens).toHaveLength(64);
		expect(evidence.concurrencyOrder.collectionTruncated).toBe(true);
		expect(evidence.model).toEqual({
			kind: 'present-valid',
			progress: { ...progress, executeCodeToolCallsPrepared: 1000 },
		});
	});
	it('separates unavailable model observation from a failed read', async () => {
		const options = { ...defaults, readFile: reader(new Map()) };
		expect((await collectFacts({ ...options, modelProgress: () => undefined })).model).toEqual({
			kind: 'unavailable',
		});
		expect(
			(
				await collectFacts({
					...options,
					modelProgress: () => {
						throw new Error(privateMarker);
					},
				})
			).model,
		).toEqual({ kind: 'read-failed' });
	});
	it('projects reader rejections without private error text', async () => {
		const evidence = await collectFacts({
			...defaults,
			readFile: async (): Promise<PortalCompositionFileInput> => {
				throw new Error(privateMarker);
			},
		});
		expect(evidence.origin).toEqual({ kind: 'read-failed' });
		expect(evidence.hostEffect).toEqual({ kind: 'read-failed' });
		expect(evidence.lossPid).toEqual({ kind: 'read-failed' });
		expect(JSON.stringify(evidence)).not.toContain(privateMarker);
	});
	it('rethrows the identical original error if collection or output fails', async () => {
		const original = new Error('original-turn-error');
		const emitted: unknown[] = [];
		await expect(
			rethrowFailure(original, {
				...defaults,
				get mcpCalls(): readonly { readonly name: string }[] {
					throw new Error(privateMarker);
				},
				emit: (value: unknown): void => {
					emitted.push(value);
				},
			}),
		).rejects.toBe(original);
		expect(emitted).toEqual([{ kind: 'diagnostic-read-failed' }]);
		await expect(
			rethrowFailure(original, {
				...defaults,
				readFile: reader(new Map()),
				emit: (): void => {
					throw new Error(privateMarker);
				},
			}),
		).rejects.toBe(original);
	});
	it('bounds hanging file observations and preserves the original error', async () => {
		vi.useFakeTimers();
		const original = new Error('original-turn-error');
		let observed: unknown;
		const emitted: unknown[] = [];
		const pending = rethrowFailure(original, {
			...defaults,
			readFile: () => new Promise<PortalCompositionFileInput>(() => undefined),
			emit: (value: unknown): void => {
				emitted.push(value);
			},
		}).catch((error: unknown) => {
			observed = error;
		});
		await vi.advanceTimersByTimeAsync(999);
		expect(observed).toBeUndefined();
		await vi.advanceTimersByTimeAsync(1);
		await pending;
		expect(observed).toBe(original);
		expect(JSON.stringify(emitted)).toContain('read-failed');
		expect(JSON.stringify(emitted)).not.toContain(privateMarker);
	});

	it('treats an invalid observed workspace capability as a failed read, not no request', async () => {
		const evidence = await collectFacts({
			...defaults,
			vmRequests: [
				{
					sessionLabel: 'fixture',
					mounts: {
						'/workspace': {
							kind: 'owned-filtered-workspace',
							directory: { identity: { canonicalPath: '/synthetic/../outside' } },
						},
					},
				},
			],
			readFile: reader(new Map()),
		});
		expect(evidence.vmRequests.toolVmWorkspace).toBe(1);
		expect(evidence.origin).toEqual({ kind: 'read-failed' });
	});

	it('records PID and timestamp presence without judging their contents', async () => {
		const evidence = await collectFacts({
			...defaults,
			readFile: reader(
				new Map([
					[paths.lossPidPath, { kind: 'truncated' }],
					[paths.lossFastTimestampPath, content('')],
				]),
			),
		});
		expect(evidence.lossPid).toEqual({ kind: 'present' });
		expect(evidence.lossTimestamp).toEqual({ kind: 'present' });
	});

	it('preserves the original error when an output dependency getter throws', async () => {
		const original = new Error('original-turn-error');
		await expect(
			rethrowFailure(original, {
				...defaults,
				readFile: reader(new Map()),
				get emit(): (value: unknown) => void {
					throw new Error(privateMarker);
				},
			}),
		).rejects.toBe(original);
	});
});
