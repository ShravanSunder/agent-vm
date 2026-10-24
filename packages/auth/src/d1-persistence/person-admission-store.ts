import { sessionSchema, userSchema } from 'better-auth/db';
import { z } from 'zod';

const storedUserSchema = userSchema.extend({
	createdAt: z.coerce.date(),
	updatedAt: z.coerce.date(),
	emailVerified: z.union([z.boolean(), z.literal(0), z.literal(1)]).transform(Boolean),
});
const storedSessionSchema = sessionSchema.extend({
	createdAt: z.coerce.date(),
	updatedAt: z.coerce.date(),
	expiresAt: z.coerce.date(),
});
export type LiveOwnerSession = {
	readonly session: z.infer<typeof storedSessionSchema>;
	readonly user: z.infer<typeof storedUserSchema>;
};

/** Primary admission reads, E8/owner binding, and conditional cleanup of aborted provider writes. */
export function createPersonAdmissionStore(props: {
	readonly database: AuthWorkerEnv['DB'];
	readonly ownerEmail: string;
	readonly now: () => number;
}): {
	readonly seedOwnerEntry: () => Promise<void>;
	readonly providerEmailAllowed: (email: string, verified: boolean) => Promise<boolean>;
	readonly ensurePersonActive: (personId: string) => Promise<boolean>;
	readonly readOwnerSession: (
		personId: string,
		sessionId: string,
	) => Promise<LiveOwnerSession | null>;
	readonly isPersonSessionActive: (personId: string, sessionId: string) => Promise<boolean>;
	readonly deleteSession: (sessionId: string) => Promise<void>;
	readonly cleanupUnboundPerson: (personId: string) => Promise<void>;
} {
	function readPrimary(): ReturnType<AuthWorkerEnv['DB']['withSession']> {
		return props.database.withSession('first-primary');
	}
	async function personActive(personId: string): Promise<boolean> {
		const row = await readPrimary()
			.prepare(
				'SELECT COUNT(*) AS bound, SUM(CASE WHEN removed_at IS NOT NULL THEN 1 ELSE 0 END) AS removed FROM allowed_email WHERE person_id = ?',
			)
			.bind(personId)
			.first();
		const state = z.object({ bound: z.number(), removed: z.number().nullable() }).parse(row);
		return state.bound > 0 && state.removed === 0;
	}
	async function sessionActive(personId: string, sessionId: string): Promise<boolean> {
		const row = await readPrimary()
			.prepare('SELECT * FROM session WHERE id = ? AND userId = ?')
			.bind(sessionId, personId)
			.first();
		if (row === null) return false;
		const session = storedSessionSchema.parse(row);
		return session.expiresAt.getTime() > props.now() && (await personActive(personId));
	}
	return {
		async seedOwnerEntry(): Promise<void> {
			await props.database.batch([
				props.database
					.prepare(
						'INSERT OR IGNORE INTO allowed_email (email, person_id, added_by, added_at, removed_at) VALUES (?, NULL, ?, ?, NULL)',
					)
					.bind(props.ownerEmail, 'deployment', props.now()),
				props.database
					.prepare(
						'INSERT OR IGNORE INTO sign_in_audit (id, kind, actor_user_id, request_id, phase, change_kind, target_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
					)
					.bind(
						'deployment-owner-seeded',
						'allowlist-added',
						'deployment',
						'deployment-owner-seeded',
						'outcome',
						'registered',
						props.ownerEmail,
						props.now(),
					),
			]);
		},
		async providerEmailAllowed(email: string, verified: boolean): Promise<boolean> {
			if (!verified) return false;
			const entry = await readPrimary()
				.prepare(
					'SELECT email FROM allowed_email WHERE email = ? AND removed_at IS NULL AND (email = ? OR EXISTS (SELECT 1 FROM deployment_owner))',
				)
				.bind(email.toLowerCase(), props.ownerEmail)
				.first();
			return entry !== null;
		},
		async ensurePersonActive(personId: string): Promise<boolean> {
			const row = await readPrimary()
				.prepare('SELECT * FROM user WHERE id = ?')
				.bind(personId)
				.first();
			if (row === null) return false;
			const user = storedUserSchema.parse(row);
			if (!user.emailVerified) return false;
			if (await personActive(personId)) return true;
			await props.database.batch([
				props.database
					.prepare(
						'UPDATE allowed_email SET person_id = ? WHERE email = ? AND person_id IS NULL AND removed_at IS NULL AND EXISTS (SELECT 1 FROM user WHERE id = ?)',
					)
					.bind(personId, user.email, personId),
				props.database
					.prepare(
						'INSERT OR IGNORE INTO deployment_owner (singleton, user_id, bound_at) SELECT 1, person_id, ? FROM allowed_email WHERE email = ? AND person_id = ? AND removed_at IS NULL',
					)
					.bind(props.now(), props.ownerEmail, personId),
				props.database
					.prepare(
						'INSERT OR IGNORE INTO sign_in_audit (id, kind, actor_user_id, request_id, phase, change_kind, target_id, at) SELECT ?, ?, user_id, ?, ?, ?, user_id, ? FROM deployment_owner WHERE singleton = 1 AND user_id = ?',
					)
					.bind(
						'deployment-owner-bound',
						'owner-bound',
						'deployment-owner-bound',
						'outcome',
						'registered',
						props.now(),
						personId,
					),
			]);
			return personActive(personId);
		},
		isPersonSessionActive: sessionActive,
		async deleteSession(sessionId: string): Promise<void> {
			await props.database.prepare('DELETE FROM session WHERE id = ?').bind(sessionId).run();
		},
		async cleanupUnboundPerson(personId: string): Promise<void> {
			await props.database.batch([
				props.database
					.prepare(
						'DELETE FROM account WHERE userId = ? AND NOT EXISTS (SELECT 1 FROM allowed_email WHERE person_id = ?)',
					)
					.bind(personId, personId),
				props.database
					.prepare(
						'DELETE FROM user WHERE id = ? AND NOT EXISTS (SELECT 1 FROM allowed_email WHERE person_id = ?)',
					)
					.bind(personId, personId),
			]);
		},
		async readOwnerSession(personId: string, sessionId: string): Promise<LiveOwnerSession | null> {
			const owner = await readPrimary()
				.prepare('SELECT user_id FROM deployment_owner WHERE singleton = 1 AND user_id = ?')
				.bind(personId)
				.first();
			if (owner === null || !(await sessionActive(personId, sessionId))) return null;
			const [sessionRow, userRow] = await Promise.all([
				readPrimary()
					.prepare('SELECT * FROM session WHERE id = ? AND userId = ?')
					.bind(sessionId, personId)
					.first(),
				readPrimary().prepare('SELECT * FROM user WHERE id = ?').bind(personId).first(),
			]);
			if (sessionRow === null || userRow === null) return null;
			const session = storedSessionSchema.parse(sessionRow);
			const user = storedUserSchema.parse(userRow);
			if (
				session.expiresAt.getTime() <= props.now() ||
				!user.emailVerified ||
				!(await personActive(personId))
			)
				return null;
			return { session, user };
		},
	};
}
