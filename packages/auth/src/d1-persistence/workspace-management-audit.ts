import { z } from 'zod';

import type { AgentManagementOperation } from '#auth/sign-in-core/agent-clients/agent-registration';

export class ManagementOperationConflict extends Error {}

interface WorkspaceManagementAuditEvent {
	readonly requestId: string;
	readonly actorUserId: string;
	readonly kind: 'client-management' | 'resource-changed' | 'client-link-changed';
	readonly change: string;
	readonly targetId: string;
	readonly phase: 'intent' | 'outcome';
}
const auditIdentitySchema = z.object({
	kind: z.string(),
	actor_user_id: z.string(),
	request_id: z.string(),
	phase: z.string(),
	change_kind: z.string(),
	target_id: z.string(),
});

function operationTarget(operation: AgentManagementOperation, clientId: string): string {
	return JSON.stringify({
		kind: operation.kind,
		organizationId: operation.organizationId,
		clientId,
		...(operation.kind === 'disable' ? {} : { workspaceId: operation.workspaceId }),
	});
}
function operationEvent(
	operation: AgentManagementOperation,
	actorUserId: string,
	clientId: string,
): Omit<WorkspaceManagementAuditEvent, 'phase'> {
	return {
		requestId: operation.requestId,
		actorUserId,
		kind: 'client-management',
		change: operation.kind,
		targetId: operationTarget(operation, clientId),
	};
}

/** Reserves one request's exact intent and reads every resource/link audit write back before success. */
export function createWorkspaceManagementAudit(props: {
	readonly database: AuthWorkerEnv['DB'];
	readonly now: () => number;
}): {
	readonly checkOperation: (
		operation: AgentManagementOperation,
		actorUserId: string,
		clientId: string,
	) => Promise<void>;
	readonly reserve: (
		operation: AgentManagementOperation,
		actorUserId: string,
		clientId: string,
	) => Promise<void>;
	readonly finish: (
		operation: AgentManagementOperation,
		actorUserId: string,
		clientId: string,
	) => Promise<void>;
	readonly record: (event: WorkspaceManagementAuditEvent) => Promise<void>;
} {
	async function record(event: WorkspaceManagementAuditEvent): Promise<void> {
		const id = `${event.requestId}:${event.kind}:${event.phase}`;
		await props.database
			.prepare(
				'INSERT OR IGNORE INTO sign_in_audit (id, kind, actor_user_id, request_id, phase, change_kind, target_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
			)
			.bind(
				id,
				event.kind,
				event.actorUserId,
				event.requestId,
				event.phase,
				event.change,
				event.targetId,
				props.now(),
			)
			.run();
		const row = await props.database
			.withSession('first-primary')
			.prepare(
				'SELECT kind, actor_user_id, request_id, phase, change_kind, target_id FROM sign_in_audit WHERE id = ?',
			)
			.bind(id)
			.first();
		const actual = auditIdentitySchema.parse(row);
		if (
			actual.kind !== event.kind ||
			actual.actor_user_id !== event.actorUserId ||
			actual.request_id !== event.requestId ||
			actual.phase !== event.phase ||
			actual.change_kind !== event.change ||
			actual.target_id !== event.targetId
		)
			throw new ManagementOperationConflict(
				'Management request identity conflicts with its recorded intent',
			);
	}

	return {
		record,
		async checkOperation(
			operation: AgentManagementOperation,
			actorUserId: string,
			clientId: string,
		): Promise<void> {
			const row = await props.database
				.withSession('first-primary')
				.prepare(
					'SELECT kind, actor_user_id, request_id, phase, change_kind, target_id FROM sign_in_audit WHERE id = ?',
				)
				.bind(`${operation.requestId}:client-management:intent`)
				.first();
			if (row === null) return;
			const actual = auditIdentitySchema.parse(row);
			if (
				actual.kind !== 'client-management' ||
				actual.actor_user_id !== actorUserId ||
				actual.request_id !== operation.requestId ||
				actual.phase !== 'intent' ||
				actual.change_kind !== operation.kind ||
				actual.target_id !== operationTarget(operation, clientId)
			)
				throw new ManagementOperationConflict(
					'Management request identity conflicts with its recorded intent',
				);
		},
		reserve: async (operation, actorUserId, clientId): Promise<void> =>
			record({ ...operationEvent(operation, actorUserId, clientId), phase: 'intent' }),
		finish: async (operation, actorUserId, clientId): Promise<void> =>
			record({ ...operationEvent(operation, actorUserId, clientId), phase: 'outcome' }),
	};
}
