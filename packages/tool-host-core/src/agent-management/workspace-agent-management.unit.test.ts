import { createPersonTokenVerifier } from '@agent-collaboration/tool-access/contracts';
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { describe, expect, it } from 'vitest';

import type { AgentClientManagementPort } from '#tool-host-core/agent-management/agent-client-management-port';
import { createWorkspaceAgentManagement } from '#tool-host-core/agent-management/workspace-agent-management';
import { workspaceConfigurationSchema } from '#tool-host-core/hosted-configuration/models/hosted-configuration';
import { createVolatileAuthorityStore } from '#tool-host-core/workspace-authority/volatile-authority-store';
import { createWorkspaceAuthority } from '#tool-host-core/workspace-authority/workspace-authority';

const organizationId = '11111111-1111-4111-8111-111111111111';
const foreignOrganization = '22222222-2222-4222-8222-222222222222';
const workspaceOne = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceTwo = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const foreignWorkspace = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const requestId = 'b015079b-19b6-4aa2-9b82-1298efcb2f79';
const issuer = 'https://issuer.invalid';
const toolPortalOrigin = 'https://portal.invalid';
const audience = `${toolPortalOrigin}/management`;
const resource = (workspaceId: string): string =>
	`${toolPortalOrigin}/workspaces/${workspaceId}/mcp`;

async function fixture(): Promise<{
	request: (props: {
		readonly method?: string;
		readonly clientId?: string;
		readonly workspaceId?: string;
		readonly retire?: boolean;
		readonly organizationId?: string;
		readonly claims?: JWTPayload;
		readonly body?: unknown;
	}) => Promise<Response>;
	authority: (workspaceId: string) => ReturnType<typeof createWorkspaceAuthority>;
	state: {
		active: boolean;
		failDisable: boolean;
		failUnlink: boolean;
		failAdmission: boolean;
		failCompletion: boolean;
		mismatch: boolean;
		expireOwnerAfterWrite: boolean;
		strongerLevel: 'fresh-verified-uv' | 'exact-operation-binding' | null;
		signInCalls: number;
		mutations: string[];
		unlinkMemberships: ({ readonly persona: string } | null)[];
	};
}> {
	const keys = await generateKeyPair('EdDSA');
	const jwks = { keys: [{ ...(await exportJWK(keys.publicKey)), alg: 'EdDSA', kid: 'key-one' }] };
	const authorities = new Map<string, ReturnType<typeof createWorkspaceAuthority>>();
	function authority(workspaceId: string): ReturnType<typeof createWorkspaceAuthority> {
		let current = authorities.get(workspaceId);
		if (current === undefined) {
			current = createWorkspaceAuthority({
				store: createVolatileAuthorityStore(),
				clock: { nowMs: () => 100 },
				cap: 1024,
			});
			authorities.set(workspaceId, current);
		}
		return current;
	}
	const state: {
		active: boolean;
		failDisable: boolean;
		failUnlink: boolean;
		failAdmission: boolean;
		failCompletion: boolean;
		mismatch: boolean;
		expireOwnerAfterWrite: boolean;
		strongerLevel: 'fresh-verified-uv' | 'exact-operation-binding' | null;
		signInCalls: number;
		mutations: string[];
		unlinkMemberships: ({ readonly persona: string } | null)[];
	} = {
		active: true,
		failDisable: false,
		failUnlink: false,
		failAdmission: false,
		failCompletion: false,
		mismatch: false,
		expireOwnerAfterWrite: false,
		strongerLevel: null,
		signInCalls: 0,
		mutations: [],
		unlinkMemberships: [],
	};
	const signIn: AgentClientManagementPort = {
		humanCheckStatus: async () => {
			state.signInCalls += 1;
			return state.strongerLevel === null
				? { kind: 'ready', level: 'remembered-login' }
				: { kind: 'not-implemented', level: state.strongerLevel };
		},
		isLiveOwner: async () => {
			state.signInCalls += 1;
			return state.active;
		},
		ownsAgentClient: async ({ clientId }) => {
			state.signInCalls += 1;
			return clientId === 'agent-one';
		},
		registerAndLink: async ({ workspaceId }) => {
			state.signInCalls += 1;
			state.mutations.push('register-and-link');
			return {
				kind: 'registered',
				clientId: 'agent-one',
				clientSecret: 'once-only-secret',
				workspaceId,
				resource: state.mismatch ? 'https://other.invalid/resource' : resource(workspaceId),
			};
		},
		link: async ({ clientId, workspaceId }) => {
			state.signInCalls += 1;
			state.mutations.push('link');
			return { kind: 'linked', clientId, workspaceId, resource: resource(workspaceId) };
		},
		unlink: async ({ clientId, workspaceId }) => {
			state.signInCalls += 1;
			state.mutations.push('unlink');
			const observedMembership = await authority(workspaceId).readMembership(clientId);
			state.unlinkMemberships.push(observedMembership);
			expect(observedMembership).toBeNull();
			return state.failUnlink
				? { kind: 'incomplete', clientId }
				: { kind: 'unlinked', clientId, workspaceId, resource: resource(workspaceId) };
		},
		disable: async (operation) => {
			state.signInCalls += 1;
			state.mutations.push('disable');
			expect(operation).not.toHaveProperty('workspaceId');
			expect(await authority(workspaceOne).readMembership(operation.clientId)).toBeNull();
			expect(await authority(workspaceTwo).readMembership(operation.clientId)).toBeNull();
			return state.failDisable
				? { kind: 'incomplete', clientId: operation.clientId }
				: { kind: 'disabled', clientId: operation.clientId };
		},
	};
	const { handle } = createWorkspaceAgentManagement({
		verifier: createPersonTokenVerifier({
			deployment: issuer,
			audience,
			jwksUrl: new URL(`${issuer}/jwks`),
			now: () => 100_000,
			jwksFetch: async () => Response.json(jwks),
		}),
		signIn,
		toolPortalOrigin,
		configurations: {
			workspaceIdsForOrganization: async (selected) =>
				selected === organizationId ? [workspaceOne, workspaceTwo] : [],
			read: async (workspaceId) =>
				workspaceConfigurationSchema.parse({
					organizationId: workspaceId === foreignWorkspace ? foreignOrganization : organizationId,
					workspaceName: 'fixture',
					approvalKeyBinding: 'KEY',
					mcp: { schemaVersion: 1, providers: {} },
					portal: { schemaVersion: 1, profiles: { reader: { namespaces: {} } } },
				}),
		},
		workspaces: {
			forWorkspace: (workspaceId) => ({
				...authority(workspaceId),
				completeAgentRemoval: async (
					clientId: string,
					operationRequestId: string,
					operation: 'unlink' | 'disable',
				): Promise<void> => {
					if (state.failCompletion && workspaceId === workspaceTwo) {
						state.failCompletion = false;
						throw new Error('Controlled completion failure');
					}
					await authority(workspaceId).completeAgentRemoval(
						clientId,
						operationRequestId,
						operation,
					);
				},
				setMembership: async (clientId, persona) => {
					state.mutations.push(`member:${workspaceId}`);
					if (state.failAdmission) throw new Error('Controlled membership write failure');
					await authority(workspaceId).setMembership(clientId, persona);
					if (state.expireOwnerAfterWrite) state.active = false;
				},
			}),
		},
	});
	return {
		authority,
		state,
		async request(input): Promise<Response> {
			const token = await new SignJWT({
				iss: issuer,
				sub: 'owner-one',
				aud: audience,
				sid: 'session-one',
				iat: 100,
				exp: 400,
				client_id: 'owner-cli',
				azp: 'owner-cli',
				scope: 'tool-portal:management',
				jti: 'token-one',
				...input.claims,
			})
				.setProtectedHeader({ alg: 'EdDSA', typ: 'at+jwt', kid: 'key-one' })
				.sign(keys.privateKey);
			const path = input.retire
				? `organizations/${input.organizationId ?? organizationId}`
				: `workspaces/${input.workspaceId ?? workspaceOne}`;
			const method = input.method ?? 'POST';
			return handle(
				new Request(
					`${toolPortalOrigin}/management/${path}/agents${input.clientId === undefined ? '' : `/${input.clientId}`}`,
					{
						method,
						headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
						...(method === 'GET'
							? {}
							: {
									body: JSON.stringify(
										input.body ??
											(method === 'POST' ? { requestId, persona: 'reader' } : { requestId }),
									),
								}),
					},
				),
			);
		},
	};
}

// Real signature verification, coordinator and atomic decisions; sign-in/storage are contract doubles.
describe('workspace agent management', () => {
	it.each(['fresh-verified-uv', 'exact-operation-binding'] as const)(
		'refuses unimplemented %s without downgrade or writes',
		async (level) => {
			const target = await fixture();
			target.state.strongerLevel = level;
			await target.authority(workspaceOne).setMembership('agent-one', 'reader');
			const responses = await Promise.all(
				['POST', 'GET', 'DELETE'].map((method) =>
					target.request({ method, ...(method === 'POST' ? {} : { clientId: 'agent-one' }) }),
				),
			);
			expect(responses.map((response) => response.status)).toEqual([501, 501, 501]);
			expect(await responses[0]?.json()).toEqual({
				error: 'management-human-check-not-implemented',
				level,
			});
			expect(target.state.mutations).toEqual([]);
			expect(await target.authority(workspaceOne).readAgentRemoval('agent-one')).toBeNull();
			expect(await target.authority(workspaceOne).readMembership('agent-one')).toEqual({
				persona: 'reader',
			});
		},
	);
	it('releases registration credential only after link, membership and readback', async () => {
		const target = await fixture();
		const response = await target.request({});
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(await response.json()).toEqual({
			kind: 'registered',
			clientId: 'agent-one',
			clientSecret: 'once-only-secret',
			workspaceId: workspaceOne,
			resource: resource(workspaceOne),
		});
		expect(target.state.mutations).toEqual(['register-and-link', `member:${workspaceOne}`]);
		expect(await target.authority(workspaceOne).readMembership('agent-one')).toEqual({
			persona: 'reader',
		});
	});
	it.each(['membership failure', 'owner removed'] as const)(
		'releases no credential after %s',
		async (mode) => {
			const target = await fixture();
			target.state.failAdmission = mode === 'membership failure';
			target.state.expireOwnerAfterWrite = mode === 'owner removed';
			const response = await target.request({});
			expect(response.status).toBe(503);
			expect(await response.text()).not.toContain('once-only-secret');
		},
	);
	it('refuses configuration-origin mismatch before membership', async () => {
		const target = await fixture();
		target.state.mismatch = true;
		expect((await target.request({})).status).toBe(503);
		expect(await target.authority(workspaceOne).readMembership('agent-one')).toBeNull();
		expect(target.state.mutations).toEqual(['register-and-link']);
	});
	it('links an existing client without registration, rotation or credential release', async () => {
		const target = await fixture();
		const response = await target.request({
			body: { requestId, persona: 'reader', clientId: 'agent-one' },
		});
		expect(await response.json()).toEqual({
			kind: 'linked',
			clientId: 'agent-one',
			workspaceId: workspaceOne,
			resource: resource(workspaceOne),
		});
		expect(target.state.mutations).toEqual(['link', `member:${workspaceOne}`]);
	});
	it('removes membership before unlink, keeps pending and retries on authorized status', async () => {
		const target = await fixture();
		await target.authority(workspaceOne).setMembership('agent-one', 'reader');
		await target.authority(workspaceTwo).setMembership('agent-one', 'reader');
		target.state.failUnlink = true;
		const removal = await target.request({ method: 'DELETE', clientId: 'agent-one' });
		expect(target.state.unlinkMemberships).toEqual([null]);
		expect(removal.status).toBe(202);
		expect(await target.authority(workspaceOne).readMembership('agent-one')).toBeNull();
		expect(await target.authority(workspaceTwo).readMembership('agent-one')).toEqual({
			persona: 'reader',
		});
		expect(await target.authority(workspaceOne).readAgentRemoval('agent-one')).toEqual({
			kind: 'pending',
			operation: 'unlink',
			requestId,
		});
		target.state.failUnlink = false;
		expect((await target.request({ method: 'GET', clientId: 'agent-one' })).status).toBe(200);
		expect(await target.authority(workspaceOne).readAgentRemoval('agent-one')).toEqual({
			kind: 'complete',
			operation: 'unlink',
			requestId,
		});
		expect(target.state.unlinkMemberships).toEqual([null, null]);
		expect(target.state.mutations).toEqual(['unlink', 'unlink']);
	});
	it('removes every configured organization membership before disable, never unlinks, and retries', async () => {
		const target = await fixture();
		await Promise.all(
			[workspaceOne, workspaceTwo, foreignWorkspace].map((workspaceId) =>
				target.authority(workspaceId).setMembership('agent-one', 'reader'),
			),
		);
		target.state.failDisable = true;
		expect(
			(await target.request({ method: 'DELETE', clientId: 'agent-one', retire: true })).status,
		).toBe(202);
		expect(await target.authority(foreignWorkspace).readMembership('agent-one')).toEqual({
			persona: 'reader',
		});
		target.state.failDisable = false;
		expect(
			await (await target.request({ method: 'GET', clientId: 'agent-one', retire: true })).json(),
		).toEqual({ kind: 'removed', clientId: 'agent-one' });
		expect(
			await Promise.all(
				[workspaceOne, workspaceTwo].map((workspaceId) =>
					target.authority(workspaceId).readAgentRemoval('agent-one'),
				),
			),
		).toEqual([
			{ kind: 'complete', operation: 'disable', requestId },
			{ kind: 'complete', operation: 'disable', requestId },
		]);
		expect(target.state.mutations).toEqual(['disable', 'disable']);
	});
	it('retries every workspace when retirement completion fails after the first workspace completed', async () => {
		const target = await fixture();
		target.state.failCompletion = true;
		expect(
			(await target.request({ method: 'DELETE', clientId: 'agent-one', retire: true })).status,
		).toBe(503);
		expect((await target.authority(workspaceOne).readAgentRemoval('agent-one'))?.kind).toBe(
			'complete',
		);
		expect((await target.authority(workspaceTwo).readAgentRemoval('agent-one'))?.kind).toBe(
			'pending',
		);
		expect(
			(await target.request({ method: 'GET', clientId: 'agent-one', retire: true })).status,
		).toBe(200);
		expect((await target.authority(workspaceTwo).readAgentRemoval('agent-one'))?.kind).toBe(
			'complete',
		);
		expect(target.state.mutations).toEqual(['disable', 'disable']);
	});

	it('retirement supersedes a pending unlink without calling it', async () => {
		const target = await fixture();
		await target.authority(workspaceOne).setMembership('agent-one', 'reader');
		await target.authority(workspaceOne).beginAgentRemoval('agent-one', requestId, 'unlink');
		const retirementId = 'b015079b-19b6-4aa2-9b82-1298efcb2f80';
		expect(
			(
				await target.request({
					method: 'DELETE',
					clientId: 'agent-one',
					retire: true,
					body: { requestId: retirementId },
				})
			).status,
		).toBe(200);
		expect(target.state.mutations).toEqual(['disable']);
		expect(await target.authority(workspaceOne).readMembership('agent-one')).toBeNull();
		expect(await target.authority(workspaceOne).readAgentRemoval('agent-one')).toEqual({
			kind: 'complete',
			operation: 'disable',
			requestId: retirementId,
		});
	});
	it('a stale unlink retry after retirement reads retired completion and never unlinks', async () => {
		const target = await fixture();
		await target.authority(workspaceOne).beginAgentRemoval('agent-one', requestId, 'unlink');
		const retirementId = 'b015079b-19b6-4aa2-9b82-1298efcb2f80';
		expect(
			(
				await target.request({
					method: 'DELETE',
					clientId: 'agent-one',
					retire: true,
					body: { requestId: retirementId },
				})
			).status,
		).toBe(200);
		expect(
			await (
				await target.request({ method: 'DELETE', clientId: 'agent-one', body: { requestId } })
			).json(),
		).toEqual({ kind: 'removed', clientId: 'agent-one' });
		expect(target.state.mutations).toEqual(['disable']);
	});

	it('retires a client with zero links or memberships without a fabricated workspace', async () => {
		const target = await fixture();
		expect(
			(await target.request({ method: 'DELETE', clientId: 'agent-one', retire: true })).status,
		).toBe(200);
		expect(target.state.mutations).toEqual(['disable']);
	});
	it.each(['DELETE', 'GET'])(
		'refuses an organization with no configured workspace before any sign-in call on %s',
		async (method) => {
			const target = await fixture();
			expect(
				(
					await target.request({
						method,
						retire: true,
						clientId: 'agent-one',
						organizationId: foreignOrganization,
					})
				).status,
			).toBe(403);
			expect(target.state.signInCalls).toBe(0);
			expect(target.state.mutations).toEqual([]);
		},
	);
	it.each(
		['POST', 'DELETE', 'GET'].flatMap((method) =>
			['tool-portal:agent', 'tool-portal:management'].map((scope) => ({ method, scope })),
		),
	)('refuses $scope without a person session on $method', async ({ method, scope }) => {
		const target = await fixture();
		await target.authority(workspaceOne).setMembership('agent-one', 'reader');
		expect(
			(
				await target.request({
					method,
					...(method === 'POST' ? {} : { clientId: 'agent-one' }),
					claims: { sid: undefined, sub: 'agent-one', scope },
				})
			).status,
		).toBe(403);
		expect(target.state.mutations).toEqual([]);
		expect(await target.authority(workspaceOne).readAgentRemoval('agent-one')).toBeNull();
		expect(await target.authority(workspaceOne).readMembership('agent-one')).toEqual({
			persona: 'reader',
		});
	});
	it('refuses a removed owner on every route with no mutation', async () => {
		const target = await fixture();
		target.state.active = false;
		await target.authority(workspaceOne).setMembership('agent-one', 'reader');
		expect(
			await Promise.all(
				['POST', 'DELETE', 'GET'].map(
					async (method) =>
						(
							await target.request({
								method,
								...(method === 'POST' ? {} : { clientId: 'agent-one' }),
							})
						).status,
				),
			),
		).toEqual([403, 403, 403]);
		expect(target.state.mutations).toEqual([]);
		expect(await target.authority(workspaceOne).readAgentRemoval('agent-one')).toBeNull();
		expect(await target.authority(workspaceOne).readMembership('agent-one')).toEqual({
			persona: 'reader',
		});
	});
	it('rejects caller-supplied identity and unknown persona before writes', async () => {
		const target = await fixture();
		expect(
			await Promise.all(
				[
					{ requestId, persona: 'reader', actor: 'owner-one', organizationId, owner: true },
					{ requestId, persona: 'unknown' },
				].map(async (body) => (await target.request({ body })).status),
			),
		).toEqual([400, 400]);
		expect(target.state.mutations).toEqual([]);
	});
	it('refuses foreign clients before membership removal or pending state', async () => {
		const target = await fixture();
		expect((await target.request({ method: 'DELETE', clientId: 'foreign-agent' })).status).toBe(
			403,
		);
		expect(await target.authority(workspaceOne).readAgentRemoval('foreign-agent')).toBeNull();
		expect(target.state.mutations).toEqual([]);
	});
});
