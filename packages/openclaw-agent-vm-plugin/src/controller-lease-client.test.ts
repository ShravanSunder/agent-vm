import { readFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import {
	type ControllerLeaseRequestError,
	type OpenClawGondolinLeaseRequest,
	createLeaseClient,
} from './controller-lease-client.js';
import type { ControllerRequestPolicy } from './controller-request-policy.js';

const OPENCLAW_TOOL_VM_WORKSPACE_MOUNT = '/workspace';

function createLeaseRequest(
	overrides: Partial<OpenClawGondolinLeaseRequest> = {},
): OpenClawGondolinLeaseRequest {
	return {
		agentId: 'main',
		agentWorkspaceDir: '/home/openclaw/work',
		profileId: 'standard',
		sessionKey: 'agent:main:session-abc',
		workMountDir: '/home/openclaw/work',
		zoneId: 'shravan',
		...overrides,
	};
}

function createSingleAttemptPolicy(timeoutMs: number): ControllerRequestPolicy {
	return {
		idempotency: 'safe-mutation',
		maxAttempts: 1,
		retryBaseDelayMs: 0,
		retryEnabled: false,
		retryStatuses: [],
		timeoutMs,
	};
}

describe('createLeaseClient', () => {
	it('keeps raw fetch calls inside the controller request policy boundary', async () => {
		const leaseClientSource = await readFile(
			new URL('./controller-lease-client.ts', import.meta.url),
			{
				encoding: 'utf8',
			},
		);
		const requestPolicySource = await readFile(
			new URL('./controller-request-policy.ts', import.meta.url),
			{
				encoding: 'utf8',
			},
		);

		expect(leaseClientSource).not.toContain('fetchImpl(');
		expect(requestPolicySource).toContain('@agent-vm/gateway-interface');
	});

	it('requests, renews, peeks, and releases leases through the controller API', async () => {
		const requests: { body: string | undefined; method: string; url: string }[] = [];
		const leaseClient = createLeaseClient({
			controllerUrl: 'http://controller.vm.host:18800',
			fetchImpl: async (input, init) => {
				const url =
					typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
				requests.push({
					body: typeof init?.body === 'string' ? init.body : undefined,
					method: init?.method ?? 'GET',
					url,
				});

				const responseBody = url.endsWith('/peek')
					? {
							agentId: 'main',
							createdAt: 1,
							idleTtlMs: 6_000_000,
							lastUsedAt: 1,
							leaseId: '01890f00-0000-7000-8000-000000000000',
							profileId: 'standard',
							ssh: { host: '127.0.0.1', port: 19000, user: 'sandbox' },
							tcpSlot: 0,
							transport: 'ssh-sandbox',
							workdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
							zoneId: 'shravan',
						}
					: {
							agentId: 'main',
							idleTtlMs: 6_000_000,
							leaseId: '01890f00-0000-7000-8000-000000000000',
							ssh: {
								host: 'tool-0.vm.host',
								identityPem: 'pem',
								knownHostsLine: 'known-hosts',
								port: 22,
								user: 'sandbox',
							},
							tcpSlot: 0,
							transport: 'ssh-sandbox',
							workdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
						};

				return new Response(JSON.stringify(responseBody), {
					headers: {
						'content-type': 'application/json',
					},
					status: 200,
				});
			},
		});

		const lease = await leaseClient.requestLease(createLeaseRequest());
		expect(lease.transport).toBe('ssh-sandbox');
		if (!leaseClient.publishOpenClawRuntimeStatus) {
			throw new Error('Expected runtime status publisher.');
		}
		await leaseClient.publishOpenClawRuntimeStatus({
			pluginId: 'gondolin',
			zoneId: 'shravan',
			findings: [
				{
					id: 'openclaw-tool-vm-agents-defaults-sandbox-backend-shravan-defaults',
					ok: true,
					hint: 'agents.defaults.sandbox.backend=gondolin',
				},
			],
		});
		const renewedLease = await leaseClient.renewLease('lease-123');
		const peekedLease = await leaseClient.peekLease('lease-123');
		expect(renewedLease.transport).toBe('ssh-sandbox');
		expect(peekedLease.transport).toBe('ssh-sandbox');
		await leaseClient.releaseLease('lease-123');

		expect(requests[0]?.body).toBeDefined();
		expect(JSON.parse(requests[0]?.body ?? '{}')).toEqual({
			agentId: 'main',
			agentWorkspaceDir: '/home/openclaw/work',
			profileId: 'standard',
			sessionKey: 'agent:main:session-abc',
			workMountDir: '/home/openclaw/work',
			zoneId: 'shravan',
		});
		expect(JSON.parse(requests[0]?.body ?? '{}')).not.toHaveProperty('scopeKey');
		expect(JSON.parse(requests[0]?.body ?? '{}')).not.toHaveProperty('sandbox');
		expect(requests).toEqual([
			{
				body: expect.any(String),
				method: 'POST',
				url: 'http://controller.vm.host:18800/lease',
			},
			{
				body: expect.any(String),
				method: 'POST',
				url: 'http://controller.vm.host:18800/zones/shravan/openclaw-runtime-status',
			},
			{
				body: undefined,
				method: 'POST',
				url: 'http://controller.vm.host:18800/lease/lease-123/renew',
			},
			{
				body: undefined,
				method: 'GET',
				url: 'http://controller.vm.host:18800/lease/lease-123/peek',
			},
			{
				body: undefined,
				method: 'DELETE',
				url: 'http://controller.vm.host:18800/lease/lease-123',
			},
		]);
	});

	it('starts, heartbeats, and ends active uses through the controller API', async () => {
		const requests: { body: string | undefined; method: string; url: string }[] = [];
		const leaseClient = createLeaseClient({
			controllerUrl: 'http://controller.vm.host:18800',
			fetchImpl: async (input, init) => {
				const url =
					typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
				requests.push({
					body: typeof init?.body === 'string' ? init.body : undefined,
					method: init?.method ?? 'GET',
					url,
				});
				const responseBody = url.endsWith('/heartbeat')
					? { expiresAt: 6_000, heartbeatAfterMs: 1_000 }
					: {
							expiresAt: 5_000,
							heartbeatAfterMs: 1_000,
							useId: '01890f00-0000-7000-8000-000000000000',
						};
				return new Response(JSON.stringify(responseBody), {
					headers: { 'content-type': 'application/json' },
					status: 200,
				});
			},
		});

		await leaseClient.startActiveUse('lease-123', {
			correlation: { toolName: 'shell' },
			useId: '01890f00-0000-7000-8000-000000000000',
		});
		await leaseClient.heartbeatActiveUse('lease-123', '01890f00-0000-7000-8000-000000000000', {});
		await leaseClient.endActiveUse('lease-123', '01890f00-0000-7000-8000-000000000000', {
			outcome: 'completed',
		});

		expect(requests).toEqual([
			{
				body: JSON.stringify({
					correlation: { toolName: 'shell' },
					useId: '01890f00-0000-7000-8000-000000000000',
				}),
				method: 'POST',
				url: 'http://controller.vm.host:18800/lease/lease-123/uses',
			},
			{
				body: JSON.stringify({}),
				method: 'POST',
				url: 'http://controller.vm.host:18800/lease/lease-123/uses/01890f00-0000-7000-8000-000000000000/heartbeat',
			},
			{
				body: JSON.stringify({ outcome: 'completed' }),
				method: 'DELETE',
				url: 'http://controller.vm.host:18800/lease/lease-123/uses/01890f00-0000-7000-8000-000000000000',
			},
		]);
	});

	it('sends active-use heartbeat operation reports to the controller', async () => {
		const requests: { readonly init?: RequestInit }[] = [];
		const leaseClient = createLeaseClient({
			controllerUrl: 'http://controller.vm.host:18800',
			fetchImpl: async (_input, init) => {
				requests.push(init === undefined ? {} : { init });
				return new Response(JSON.stringify({ expiresAt: 10_000, heartbeatAfterMs: 1_000 }), {
					status: 200,
				});
			},
		});

		await leaseClient.heartbeatActiveUse(
			'01890f00-0000-7000-8000-000000000000',
			'01890f00-0000-7000-8000-000000000001',
			{
				report: {
					observedAtMs: 1_000,
					phase: 'failed',
					ssh: {
						failure: {
							kind: 'ssh-command-timed-out',
							message: 'SSH command exceeded 30000ms.',
						},
					},
				},
			},
		);

		const requestBody = requests[0]?.init?.body;
		expect(typeof requestBody).toBe('string');
		if (typeof requestBody !== 'string') {
			throw new Error('Expected heartbeat request body to be serialized JSON');
		}
		expect(JSON.parse(requestBody)).toEqual({
			report: {
				observedAtMs: 1_000,
				phase: 'failed',
				ssh: {
					failure: {
						kind: 'ssh-command-timed-out',
						message: 'SSH command exceeded 30000ms.',
					},
				},
			},
		});
	});

	it('aborts a hung active-use heartbeat at the configured request timeout', async () => {
		vi.useFakeTimers();
		try {
			let heartbeatSignal: AbortSignal | undefined;
			let settledError: unknown;
			const fetchImpl = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
				heartbeatSignal = init?.signal ?? undefined;
				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () => {
						reject(new DOMException('The operation was aborted.', 'AbortError'));
					});
				});
			});
			const leaseClientOptions = {
				controllerUrl: 'http://controller.vm.host:18800',
				fetchImpl,
				requestPolicy: {
					...createSingleAttemptPolicy(25),
				},
			} satisfies Parameters<typeof createLeaseClient>[0];
			const leaseClient = createLeaseClient(leaseClientOptions);

			void leaseClient
				.heartbeatActiveUse('lease-123', '01890f00-0000-7000-8000-000000000000', {})
				.catch((error: unknown) => {
					settledError = error;
				});

			await Promise.resolve();
			await vi.advanceTimersByTimeAsync(25);
			await Promise.resolve();

			expect(fetchImpl).toHaveBeenCalledTimes(1);
			expect(heartbeatSignal?.aborted).toBe(true);
			expect(settledError).toMatchObject({
				code: 'controller-request-timeout',
				operation: 'lease-heartbeat',
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it('drains successful OpenClaw runtime status response bodies', async () => {
		const response = new Response(JSON.stringify({ ok: true, zoneId: 'shravan' }), {
			headers: { 'content-type': 'application/json' },
			status: 200,
		});
		const leaseClient = createLeaseClient({
			controllerUrl: 'http://controller.vm.host:18800',
			fetchImpl: async () => response,
		});

		await leaseClient.publishOpenClawRuntimeStatus?.({
			findings: [],
			pluginId: 'gondolin',
			zoneId: 'shravan',
		});

		await expect(response.text()).rejects.toThrow();
	});

	it('passes timeout signals to every controller operation', async () => {
		const requests: {
			readonly method: string;
			readonly signal: AbortSignal | undefined;
			readonly url: string;
		}[] = [];
		const leaseResponseBody = {
			agentId: 'main',
			idleTtlMs: 6_000_000,
			leaseId: '01890f00-0000-7000-8000-000000000000',
			ssh: {
				host: 'tool-0.vm.host',
				identityPem: 'pem',
				knownHostsLine: 'known-hosts',
				port: 22,
				user: 'sandbox',
			},
			tcpSlot: 0,
			transport: 'ssh-sandbox',
			workdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
		};
		const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url =
				typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
			const method = init?.method ?? 'GET';
			requests.push({ method, signal: init?.signal ?? undefined, url });

			if (url.endsWith('/peek')) {
				return new Response(
					JSON.stringify({
						...leaseResponseBody,
						createdAt: 1,
						lastUsedAt: 1,
						profileId: 'standard',
						ssh: { host: '127.0.0.1', port: 19000, user: 'sandbox' },
						zoneId: 'shravan',
					}),
					{ headers: { 'content-type': 'application/json' }, status: 200 },
				);
			}
			if (url.endsWith('/heartbeat')) {
				return new Response(JSON.stringify({ expiresAt: 10_000, heartbeatAfterMs: 1_000 }), {
					headers: { 'content-type': 'application/json' },
					status: 200,
				});
			}
			if (url.endsWith('/uses') && method === 'POST') {
				return new Response(
					JSON.stringify({
						expiresAt: 10_000,
						heartbeatAfterMs: 1_000,
						useId: '01890f00-0000-7000-8000-000000000000',
					}),
					{ headers: { 'content-type': 'application/json' }, status: 200 },
				);
			}
			if (method === 'DELETE') {
				return new Response(null, { status: 204 });
			}
			if (url.endsWith('/openclaw-runtime-status')) {
				return new Response(JSON.stringify({ ok: true }), { status: 200 });
			}
			return new Response(JSON.stringify(leaseResponseBody), {
				headers: { 'content-type': 'application/json' },
				status: 200,
			});
		});
		const leaseClient = createLeaseClient({
			controllerUrl: 'http://controller.vm.host:18800',
			fetchImpl,
			requestPolicy: {
				...createSingleAttemptPolicy(500),
			},
		});

		await leaseClient.requestLease(createLeaseRequest());
		await leaseClient.renewLease('lease-123');
		await leaseClient.peekLease('lease-123');
		await leaseClient.startActiveUse('lease-123', {
			useId: '01890f00-0000-7000-8000-000000000000',
		});
		await leaseClient.heartbeatActiveUse('lease-123', '01890f00-0000-7000-8000-000000000000', {});
		await leaseClient.endActiveUse('lease-123', '01890f00-0000-7000-8000-000000000000', {
			outcome: 'completed',
		});
		await leaseClient.releaseLease('lease-123');
		await leaseClient.publishOpenClawRuntimeStatus?.({
			findings: [],
			pluginId: 'gondolin',
			zoneId: 'shravan',
		});

		expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(
			[
				'POST /lease',
				'POST /lease/lease-123/renew',
				'GET /lease/lease-123/peek',
				'POST /lease/lease-123/uses',
				'POST /lease/lease-123/uses/01890f00-0000-7000-8000-000000000000/heartbeat',
				'DELETE /lease/lease-123/uses/01890f00-0000-7000-8000-000000000000',
				'DELETE /lease/lease-123',
				'POST /zones/shravan/openclaw-runtime-status',
			],
		);
		expect(requests.every((request) => request.signal instanceof AbortSignal)).toBe(true);
		expect(requests.every((request) => request.signal?.aborted === false)).toBe(true);
	});

	it.each([
		{
			expectedOperation: 'lease-create',
			run: async (leaseClient: ReturnType<typeof createLeaseClient>) =>
				await leaseClient.requestLease(createLeaseRequest()),
		},
		{
			expectedOperation: 'lease-renew',
			run: async (leaseClient: ReturnType<typeof createLeaseClient>) =>
				await leaseClient.renewLease('lease-123'),
		},
		{
			expectedOperation: 'lease-peek',
			run: async (leaseClient: ReturnType<typeof createLeaseClient>) =>
				await leaseClient.peekLease('lease-123'),
		},
		{
			expectedOperation: 'lease-use-start',
			run: async (leaseClient: ReturnType<typeof createLeaseClient>) =>
				await leaseClient.startActiveUse('lease-123', {
					useId: '01890f00-0000-7000-8000-000000000000',
				}),
		},
		{
			expectedOperation: 'lease-heartbeat',
			run: async (leaseClient: ReturnType<typeof createLeaseClient>) =>
				await leaseClient.heartbeatActiveUse(
					'lease-123',
					'01890f00-0000-7000-8000-000000000000',
					{},
				),
		},
		{
			expectedOperation: 'lease-use-end',
			run: async (leaseClient: ReturnType<typeof createLeaseClient>) =>
				await leaseClient.endActiveUse('lease-123', '01890f00-0000-7000-8000-000000000000', {
					outcome: 'completed',
				}),
		},
		{
			expectedOperation: 'lease-release',
			run: async (leaseClient: ReturnType<typeof createLeaseClient>) =>
				await leaseClient.releaseLease('lease-123'),
		},
		{
			expectedOperation: 'openclaw-runtime-status',
			run: async (leaseClient: ReturnType<typeof createLeaseClient>) =>
				await leaseClient.publishOpenClawRuntimeStatus?.({
					findings: [],
					pluginId: 'gondolin',
					zoneId: 'shravan',
				}),
		},
	])('labels timeout errors for $expectedOperation', async ({ expectedOperation, run }) => {
		vi.useFakeTimers();
		try {
			let settledError: unknown;
			const fetchImpl = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () => {
						reject(new DOMException('The operation was aborted.', 'AbortError'));
					});
				});
			});
			const leaseClient = createLeaseClient({
				controllerUrl: 'http://controller.vm.host:18800',
				fetchImpl,
				requestPolicy: {
					...createSingleAttemptPolicy(25),
				},
			});

			void run(leaseClient).catch((error: unknown) => {
				settledError = error;
			});

			await Promise.resolve();
			await vi.advanceTimersByTimeAsync(25);
			await Promise.resolve();

			expect(fetchImpl).toHaveBeenCalledTimes(1);
			expect(settledError).toMatchObject({
				code: 'controller-request-timeout',
				operation: expectedOperation,
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it('throws TypeError when the controller returns an invalid lease response', async () => {
		const leaseClient = createLeaseClient({
			controllerUrl: 'http://controller.vm.host:18800',
			fetchImpl: async () =>
				new Response(JSON.stringify({ error: 'bad request' }), {
					headers: { 'content-type': 'application/json' },
					status: 200,
				}),
		});

		await expect(
			leaseClient.requestLease(
				createLeaseRequest({ agentWorkspaceDir: '/work', workMountDir: '/work' }),
			),
		).rejects.toThrow('Controller lease API returned an invalid response');
	});

	it('surfaces agent lease compatibility conflicts without retrying or releasing', async () => {
		const fetchImpl = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						error: 'agent-tool-vm-lease-compatibility-conflict',
						guidance:
							'Managed OpenClaw/Gondolin reuses one Tool VM per zone and agent. Release the existing lease or use a compatible profile/workspace/workdir.',
						message:
							"existing Tool VM lease for agent 'beta' is not compatible with this request; mismatched fields: profileId",
						received: {
							agentId: 'beta',
							mismatchedFields: ['profileId'],
							zoneId: 'shravan',
						},
					}),
					{ headers: { 'content-type': 'application/json' }, status: 409 },
				),
		);
		const leaseClient = createLeaseClient({
			controllerUrl: 'http://controller.vm.host:18800',
			fetchImpl,
		});

		await expect(
			leaseClient.requestLease(
				createLeaseRequest({
					agentId: 'beta',
					sessionKey: 'agent:beta:discord:channel:123',
				}),
			),
		).rejects.toThrow(
			/existing Tool VM lease for agent 'beta' is not compatible.*Guidance: Managed OpenClaw\/Gondolin/u,
		);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it('rejects lease responses missing the transport discriminator', async () => {
		const leaseClient = createLeaseClient({
			controllerUrl: 'http://controller.vm.host:18800',
			fetchImpl: async () =>
				new Response(
					JSON.stringify({
						leaseId: 'lease-1',
						ssh: {
							host: 'tool-0.vm.host',
							identityPem: 'pem',
							knownHostsLine: 'known-hosts',
							port: 22,
							user: 'root',
						},
						tcpSlot: 0,
						workdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
					}),
					{ headers: { 'content-type': 'application/json' }, status: 200 },
				),
		});

		await expect(
			leaseClient.requestLease(
				createLeaseRequest({
					agentWorkspaceDir: '/workspace',
					workMountDir: '/workspace',
					zoneId: 'default',
				}),
			),
		).rejects.toThrow('Controller lease API returned an invalid response');
	});

	it('strips trailing slash from controller url', async () => {
		const requests: string[] = [];
		const leaseClient = createLeaseClient({
			controllerUrl: 'http://controller.vm.host:18800/',
			fetchImpl: async (input) => {
				requests.push(
					typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
				);
				return new Response(
					JSON.stringify({
						agentId: 'main',
						idleTtlMs: 6_000_000,
						leaseId: '01890f00-0000-7000-8000-000000000001',
						ssh: { host: 'h', identityPem: 'p', knownHostsLine: '', port: 22, user: 'u' },
						tcpSlot: 0,
						transport: 'ssh-sandbox',
						workdir: '/w',
					}),
					{ headers: { 'content-type': 'application/json' }, status: 200 },
				);
			},
		});

		await leaseClient.requestLease(
			createLeaseRequest({ agentWorkspaceDir: '/work', workMountDir: '/work' }),
		);

		expect(requests[0]).toBe('http://controller.vm.host:18800/lease');
	});

	it('throws when lease renew returns a non-ok response', async () => {
		const leaseClient = createLeaseClient({
			controllerUrl: 'http://controller.vm.host:18800',
			fetchImpl: async () =>
				new Response(JSON.stringify({ error: 'missing lease' }), {
					headers: { 'content-type': 'application/json' },
					status: 404,
				}),
		});

		await expect(leaseClient.renewLease('lease-missing')).rejects.toMatchObject({
			bodyText: JSON.stringify({ error: 'missing lease' }),
			kind: 'client-error',
			responseBody: { error: 'missing lease' },
			status: 404,
		} satisfies Partial<ControllerLeaseRequestError>);
	});

	it('throws when lease release returns a missing lease response', async () => {
		const leaseClient = createLeaseClient({
			controllerUrl: 'http://controller.vm.host:18800',
			fetchImpl: async () =>
				new Response(JSON.stringify({ error: 'missing lease' }), {
					headers: { 'content-type': 'application/json' },
					status: 404,
				}),
		});

		await expect(leaseClient.releaseLease('lease-missing')).rejects.toMatchObject({
			bodyText: JSON.stringify({ error: 'missing lease' }),
			kind: 'client-error',
			responseBody: { error: 'missing lease' },
			status: 404,
		} satisfies Partial<ControllerLeaseRequestError>);
	});

	it('throws when lease release returns a controller server error', async () => {
		const leaseClient = createLeaseClient({
			controllerUrl: 'http://controller.vm.host:18800',
			fetchImpl: async () =>
				new Response(JSON.stringify({ error: 'lease-release-failed', diagnosticId: 'diag-2' }), {
					headers: { 'content-type': 'application/json' },
					status: 503,
				}),
		});

		await expect(leaseClient.releaseLease('lease-unavailable')).rejects.toMatchObject({
			kind: 'server-error',
			responseBody: {
				diagnosticId: 'diag-2',
				error: 'lease-release-failed',
			},
			status: 503,
		} satisfies Partial<ControllerLeaseRequestError>);
	});

	it('preserves controller validation issues for bad lease requests', async () => {
		const issues = Array.from({ length: 3 }, (_, index) => ({
			code: 'custom',
			message: `validation issue ${String(index)}`,
			path: ['workMountDir'],
		}));
		const leaseClient = createLeaseClient({
			controllerUrl: 'http://controller.vm.host:18800',
			fetchImpl: async () =>
				new Response(JSON.stringify({ error: 'invalid-lease-request', issues }), {
					headers: { 'content-type': 'application/json' },
					status: 400,
				}),
		});

		await expect(
			leaseClient.requestLease(
				createLeaseRequest({ agentWorkspaceDir: '/work', workMountDir: '/work' }),
			),
		).rejects.toMatchObject({
			kind: 'client-error',
			responseBody: {
				error: 'invalid-lease-request',
				issues,
			},
			status: 400,
		} satisfies Partial<ControllerLeaseRequestError>);
	});

	it('includes structured controller message and guidance in thrown lease request errors', async () => {
		const leaseClient = createLeaseClient({
			controllerUrl: 'http://controller.vm.host:18800',
			fetchImpl: async () =>
				new Response(
					JSON.stringify({
						error: 'invalid-tool-vm-sandbox-contract',
						message: 'Invalid OpenClaw sandbox contract: scope must be agent, received session.',
						guidance:
							'Managed OpenClaw/Gondolin requires backend="gondolin", mode="all", scope="agent", and workspaceAccess="rw".',
					}),
					{
						headers: { 'content-type': 'application/json' },
						status: 400,
					},
				),
		});

		await expect(leaseClient.requestLease(createLeaseRequest())).rejects.toThrow(
			/Invalid OpenClaw sandbox contract: scope must be agent, received session\..*Guidance: Managed OpenClaw\/Gondolin requires backend="gondolin"/u,
		);
	});

	it('distinguishes controller server failures from bad lease requests', async () => {
		const leaseClient = createLeaseClient({
			controllerUrl: 'http://controller.vm.host:18800',
			fetchImpl: async () =>
				new Response(JSON.stringify({ error: 'lease-creation-failed', diagnosticId: 'diag-1' }), {
					headers: { 'content-type': 'application/json' },
					status: 503,
				}),
		});

		await expect(
			leaseClient.requestLease(
				createLeaseRequest({ agentWorkspaceDir: '/work', workMountDir: '/work' }),
			),
		).rejects.toMatchObject({
			kind: 'server-error',
			responseBody: {
				diagnosticId: 'diag-1',
				error: 'lease-creation-failed',
			},
			status: 503,
		} satisfies Partial<ControllerLeaseRequestError>);
	});

	it('passes an AbortSignal into active-use heartbeat requests', async () => {
		let heartbeatSignal: AbortSignal | undefined;
		const leaseClient = createLeaseClient({
			controllerUrl: 'http://controller.vm.host:18800',
			fetchImpl: async (_input, init) => {
				heartbeatSignal = init?.signal ?? undefined;
				return new Response(JSON.stringify({ expiresAt: 6_000, heartbeatAfterMs: 1_000 }), {
					headers: { 'content-type': 'application/json' },
					status: 200,
				});
			},
		});

		await leaseClient.heartbeatActiveUse('lease-123', '01890f00-0000-7000-8000-000000000000', {});

		expect(heartbeatSignal).toBeInstanceOf(AbortSignal);
	});

	it('retries lease renew on retryable HTTP status before succeeding', async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'busy' }), { status: 503 }))
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						agentId: 'main',
						idleTtlMs: 6_000_000,
						leaseId: '01890f00-0000-7000-8000-000000000000',
						ssh: {
							host: 'tool-0.vm.host',
							identityPem: 'pem',
							knownHostsLine: 'known-hosts',
							port: 22,
							user: 'sandbox',
						},
						tcpSlot: 0,
						transport: 'ssh-sandbox',
						workdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
					}),
					{ headers: { 'content-type': 'application/json' }, status: 200 },
				),
			);
		const leaseClient = createLeaseClient({
			controllerUrl: 'http://controller.vm.host:18800',
			fetchImpl,
		});

		await expect(leaseClient.renewLease('lease-123')).resolves.toMatchObject({
			transport: 'ssh-sandbox',
		});
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it('does not retry unsafe lease creation on retryable HTTP status', async () => {
		const fetchImpl = vi.fn(
			async () => new Response(JSON.stringify({ error: 'busy' }), { status: 503 }),
		);
		const leaseClient = createLeaseClient({
			controllerUrl: 'http://controller.vm.host:18800',
			fetchImpl,
		});

		await expect(leaseClient.requestLease(createLeaseRequest())).rejects.toMatchObject({
			kind: 'server-error',
			status: 503,
		} satisfies Partial<ControllerLeaseRequestError>);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it('drains successful runtime-status responses that return JSON bodies', async () => {
		const response = new Response(JSON.stringify({ ok: true }), { status: 200 });
		const leaseClient = createLeaseClient({
			controllerUrl: 'http://controller.vm.host:18800',
			fetchImpl: async () => response,
		});

		if (!leaseClient.publishOpenClawRuntimeStatus) {
			throw new Error('Expected runtime status publisher.');
		}
		await leaseClient.publishOpenClawRuntimeStatus({
			findings: [],
			pluginId: 'gondolin',
			zoneId: 'shravan',
		});

		expect(response.bodyUsed).toBe(true);
	});
});
