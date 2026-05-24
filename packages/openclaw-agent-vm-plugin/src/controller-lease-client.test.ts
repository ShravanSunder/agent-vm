import { describe, expect, it, vi } from 'vitest';

import {
	type ControllerLeaseRequestError,
	type OpenClawGondolinLeaseRequest,
	createLeaseClient,
} from './controller-lease-client.js';

const OPENCLAW_TOOL_VM_WORKSPACE_MOUNT = '/workspace';

function createLeaseRequest(
	overrides: Partial<OpenClawGondolinLeaseRequest> = {},
): OpenClawGondolinLeaseRequest {
	return {
		agentId: 'main',
		agentWorkspaceDir: '/home/openclaw/work',
		profileId: 'standard',
		sandbox: {
			backend: 'gondolin',
			mode: 'all',
			scope: 'agent',
			workspaceAccess: 'rw',
		},
		scopeKey: 'agent:main',
		sessionKey: 'agent:main:session-abc',
		workMountDir: '/home/openclaw/work',
		zoneId: 'shravan',
		...overrides,
	};
}

describe('createLeaseClient', () => {
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
							lastUsedAt: 1,
							leaseId: 'lease-123',
							profileId: 'standard',
							scopeKey: 'agent:main:session-abc',
							ssh: { host: '127.0.0.1', port: 19000, user: 'sandbox' },
							tcpSlot: 0,
							transport: 'ssh-sandbox',
							workdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
							zoneId: 'shravan',
						}
					: {
							agentId: 'main',
							leaseId: 'lease-123',
							scopeKey: 'agent:main',
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

		const lease = await leaseClient.requestLease(
			createLeaseRequest({
				scopeKey: 'agent:main',
				workMountDir: '/home/openclaw/work',
			}),
		);
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
			sandbox: {
				backend: 'gondolin',
				mode: 'all',
				scope: 'agent',
				workspaceAccess: 'rw',
			},
			scopeKey: 'agent:main',
			sessionKey: 'agent:main:session-abc',
			workMountDir: '/home/openclaw/work',
			zoneId: 'shravan',
		});
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
		await leaseClient.heartbeatActiveUse('lease-123', '01890f00-0000-7000-8000-000000000000');
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
				body: undefined,
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
					scopeKey: 'agent:beta:discord:channel:123',
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
						leaseId: 'lease-1',
						scopeKey: 'agent:main',
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
});
