import { expect } from 'vitest';

import type { AgentClientManagementPort } from '#tool-host-core/agent-management/agent-client-management-port';
import { createWorkspaceAgentManagement } from '#tool-host-core/agent-management/workspace-agent-management';
import { workspaceConfigurationSchema } from '#tool-host-core/hosted-configuration/models/hosted-configuration';
import { createVolatileAuthorityStore } from '#tool-host-core/workspace-authority/volatile-authority-store';
import { createWorkspaceAuthority } from '#tool-host-core/workspace-authority/workspace-authority';

const organizationId = '11111111-1111-4111-8111-111111111111';
export const workspaceOne = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const workspaceTwo = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const rejectedId = 'b015079b-19b6-4aa2-9b82-1298efcb2f79';
export const recoveryId = 'b015079b-19b6-4aa2-9b82-1298efcb2f80';
export const clientId = 'agent-one';
const portalOrigin = 'https://portal.invalid';

export function removalFixture(unlinkWorkspaceId: string = workspaceOne): {
	readonly authority: (workspaceId: string) => ReturnType<typeof createWorkspaceAuthority>;
	readonly request: (
		operation: 'unlink' | 'disable',
		requestId?: string,
		selectedWorkspaceId?: string,
	) => Promise<Response>;
	readonly issuer: {
		enabled: boolean;
		readonly links: Set<string>;
		readonly unlinkRequests: string[];
		readonly disableRequests: string[];
		readonly outcomes: Map<string, 'refused' | 'incomplete' | 'complete'>;
	};
	readonly controls: {
		failSwapOnce: boolean;
		raceUnlinkOnce: boolean;
		failBeginOnce: boolean;
		readonly beginRequests: string[];
	};
	readonly add: () => Promise<Response>;
} {
	const authorities = new Map<string, ReturnType<typeof createWorkspaceAuthority>>();
	const issuer = {
		enabled: true,
		links: new Set([workspaceOne, workspaceTwo]),
		unlinkRequests: new Array<string>(),
		disableRequests: new Array<string>(),
		outcomes: new Map<string, 'refused' | 'incomplete' | 'complete'>([[rejectedId, 'refused']]),
	};
	const controls = {
		failSwapOnce: false,
		raceUnlinkOnce: false,
		failBeginOnce: false,
		beginRequests: new Array<string>(),
	};
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
	const signIn: AgentClientManagementPort = {
		humanCheckStatus: async () => ({ kind: 'ready', level: 'remembered-login' }),
		isLiveOwner: async () => true,
		ownsAgentClient: async (input) => input.clientId === clientId,
		registerAndLink: async () => {
			throw new Error('Registration is outside this fixture');
		},
		link: async () => {
			throw new Error('Link is outside this fixture');
		},
		unlink: async (input) => {
			expect(await authority(input.workspaceId).readMembership(clientId)).toBeNull();
			issuer.unlinkRequests.push(input.requestId);
			if (issuer.outcomes.get(input.requestId) === 'refused')
				return { kind: 'refused', reason: 'operation-conflict' };
			if (issuer.outcomes.get(input.requestId) === 'incomplete')
				return { kind: 'incomplete', clientId };
			issuer.links.delete(input.workspaceId);
			return {
				kind: 'unlinked',
				clientId,
				workspaceId: input.workspaceId,
				resource: `${portalOrigin}/workspaces/${input.workspaceId}/mcp`,
			};
		},
		disable: async (input) => {
			await Promise.all(
				[workspaceOne, workspaceTwo].map(async (workspaceId): Promise<void> => {
					expect(await authority(workspaceId).readMembership(clientId)).toBeNull();
				}),
			);
			issuer.disableRequests.push(input.requestId);
			if (issuer.outcomes.get(input.requestId) === 'refused')
				return { kind: 'refused', reason: 'operation-conflict' };
			if (issuer.outcomes.get(input.requestId) === 'incomplete')
				return { kind: 'incomplete', clientId };
			issuer.enabled = false;
			return { kind: 'disabled', clientId };
		},
	};
	const management = createWorkspaceAgentManagement({
		verifier: {
			verify: async () => ({
				kind: 'verified',
				freshness: { kind: 'signature' },
				proof: {
					issuer: 'https://issuer.invalid',
					subject: 'owner-one',
					audience: `${portalOrigin}/management`,
					sessionRef: 'session-one',
					clientId: 'owner-cli',
					expiresAt: 400,
				},
			}),
		},
		signIn,
		toolPortalOrigin: portalOrigin,
		configurations: {
			workspaceIdsForOrganization: async () => [workspaceOne, workspaceTwo],
			read: async () =>
				workspaceConfigurationSchema.parse({
					organizationId,
					workspaceName: 'fixture',
					approvalKeyBinding: 'KEY',
					mcp: { schemaVersion: 1, providers: {} },
					portal: { schemaVersion: 1, profiles: { reader: { namespaces: {} } } },
				}),
		},
		workspaces: {
			forWorkspace: (workspaceId) => ({
				...authority(workspaceId),
				beginAgentRemoval: async (selectedClient, operationId, intent) => {
					controls.beginRequests.push(`${workspaceId}:${operationId}`);
					if (workspaceId === workspaceOne && controls.raceUnlinkOnce) {
						controls.raceUnlinkOnce = false;
						await authority(workspaceId).beginAgentRemoval(selectedClient, operationId, {
							operation: 'unlink',
						});
						await authority(workspaceId).completeAgentRemoval(
							selectedClient,
							operationId,
							'unlink',
						);
					}
					if (workspaceId === workspaceOne && controls.failBeginOnce) {
						controls.failBeginOnce = false;
						throw new Error('Controlled storage failure without a local intent conflict');
					}
					if (
						controls.failSwapOnce &&
						workspaceId === workspaceTwo &&
						intent.replacesPendingRequestId !== undefined
					) {
						controls.failSwapOnce = false;
						throw new Error('Controlled W2 replacement write failure');
					}
					return authority(workspaceId).beginAgentRemoval(selectedClient, operationId, intent);
				},
			}),
		},
	});
	return {
		authority,
		issuer,
		controls,
		add: async () =>
			management.handle(
				new Request(`${portalOrigin}/management/workspaces/${workspaceOne}/agents`, {
					method: 'POST',
					headers: { authorization: 'Bearer owner-proof', 'content-type': 'application/json' },
					body: JSON.stringify({ requestId: recoveryId, clientId, persona: 'reader' }),
				}),
			),
		request: async (operation, requestId, selectedWorkspaceId = unlinkWorkspaceId) =>
			management.handle(
				new Request(
					`${portalOrigin}/management/${operation === 'unlink' ? `workspaces/${selectedWorkspaceId}` : `organizations/${organizationId}`}/agents/${clientId}`,
					{
						method: requestId === undefined ? 'GET' : 'DELETE',
						headers: { authorization: 'Bearer owner-proof', 'content-type': 'application/json' },
						...(requestId === undefined ? {} : { body: JSON.stringify({ requestId }) }),
					},
				),
			),
	};
}
