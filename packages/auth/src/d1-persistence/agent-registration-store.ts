import { z } from 'zod';

import {
	agentRegistrationSchema,
	type AgentRegistration,
} from '#auth/sign-in-core/agent-clients/agent-registration';
import type {
	SignInSqlDatabase,
	SignInSqlSession,
} from '#auth/sign-in-core/models/sign-in-database';
import type { AgentAuditChange } from '#auth/sign-in-core/security-audit/agent-client-audit';

function jsonColumn(value: unknown): unknown {
	return typeof value === 'string' ? JSON.parse(value) : value;
}
const clientRowSchema = z.object({
	clientId: z.string(),
	metadata: z.preprocess(jsonColumn, agentRegistrationSchema.shape.metadata),
	grantTypes: z.preprocess(jsonColumn, agentRegistrationSchema.shape.grantTypes),
	clientCredentialsScopes: z.preprocess(
		jsonColumn,
		agentRegistrationSchema.shape.clientCredentialsScopes,
	),
	tokenEndpointAuthMethod: agentRegistrationSchema.shape.tokenEndpointAuthMethod,
	disabled: z.union([z.boolean(), z.literal(0), z.literal(1), z.null()]).transform(Boolean),
});

/** Client rows belong to Better Auth. This adapter reads them and writes only our audit records. */
export function createAgentRegistrationStore(props: {
	readonly database: SignInSqlDatabase;
	readonly now: () => number;
}): {
	readonly clientExists: (clientId: string) => Promise<boolean>;
	readonly read: (clientId: string) => Promise<AgentRegistration | null>;
	readonly record: (change: AgentAuditChange, phase: 'intent' | 'outcome') => Promise<void>;
	readonly complete: (change: AgentAuditChange) => Promise<boolean>;
} {
	function readPrimary(): SignInSqlSession {
		return props.database.primary();
	}
	async function hasRecord(
		change: AgentAuditChange,
		phase: 'intent' | 'outcome',
	): Promise<boolean> {
		const row = await readPrimary()
			.prepare('SELECT actor_user_id, target_id, change_kind FROM sign_in_audit WHERE id = ?')
			.bind(`${change.requestId}:${change.change}:${phase}`)
			.first();
		if (row === null) return false;
		const record = z
			.object({ actor_user_id: z.string(), target_id: z.string(), change_kind: z.string() })
			.parse(row);
		if (
			record.actor_user_id !== change.actorUserId ||
			record.target_id !== change.clientId ||
			record.change_kind !== change.change
		)
			throw new Error('Management operation identity conflicts with its recorded change');
		return true;
	}
	return {
		async clientExists(clientId: string): Promise<boolean> {
			return (
				(await readPrimary()
					.prepare('SELECT clientId FROM oauthClient WHERE clientId = ?')
					.bind(clientId)
					.first()) !== null
			);
		},
		async read(clientId: string): Promise<AgentRegistration | null> {
			const row = await readPrimary()
				.prepare(
					'SELECT clientId, metadata, grantTypes, clientCredentialsScopes, tokenEndpointAuthMethod, disabled FROM oauthClient WHERE clientId = ?',
				)
				.bind(clientId)
				.first();
			if (row === null) return null;
			const client = clientRowSchema.parse(row);
			const links = await readPrimary()
				.prepare(
					'SELECT resourceId FROM oauthClientResource WHERE clientId = ? ORDER BY resourceId',
				)
				.bind(clientId)
				.all();
			const resourceIds = z
				.array(z.object({ resourceId: z.string() }))
				.parse(links.results)
				.map((link) => link.resourceId);
			// E9 identity survives unlinking its last workspace; links are independent E11 state.
			const completion = await readPrimary()
				.prepare(
					"SELECT id FROM sign_in_audit WHERE kind = 'client-changed' AND target_id = ? AND change_kind = 'registered' AND phase = 'outcome' LIMIT 1",
				)
				.bind(clientId)
				.first();
			return agentRegistrationSchema.parse({
				...client,
				resourceIds,
				registrationComplete: completion !== null,
			});
		},
		async record(change: AgentAuditChange, phase: 'intent' | 'outcome'): Promise<void> {
			await props.database
				.prepare(
					'INSERT OR IGNORE INTO sign_in_audit (id, kind, actor_user_id, request_id, phase, change_kind, target_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
				)
				.bind(
					`${change.requestId}:${change.change}:${phase}`,
					'client-changed',
					change.actorUserId,
					change.requestId,
					phase,
					change.change,
					change.clientId,
					props.now(),
				)
				.run();
			if (!(await hasRecord(change, phase)))
				throw new Error('Management record not readable after write');
		},
		async complete(change: AgentAuditChange): Promise<boolean> {
			return (await hasRecord(change, 'intent')) && (await hasRecord(change, 'outcome'));
		},
	};
}
