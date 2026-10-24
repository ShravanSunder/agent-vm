import { z } from 'zod';

export const managementClientReadbackSql = 'SELECT * FROM oauthClient ORDER BY clientId';
export const managementAuditReadbackSql =
	'SELECT id, kind, actor_user_id, request_id, phase, change_kind, target_id, at FROM sign_in_audit ORDER BY id';

const auditRowSchema = z.strictObject({
	id: z.string().min(1),
	kind: z.string().min(1),
	actor_user_id: z.string().min(1),
	request_id: z.string().min(1),
	phase: z.string().min(1),
	change_kind: z.string().min(1),
	target_id: z.string().min(1),
	at: z.number().int(),
});

export function requireManagementRefusalReadback(props: {
	readonly beforeProtected: unknown;
	readonly afterProtected: unknown;
	readonly beforeAudit: unknown;
	readonly afterAudit: unknown;
	readonly attributableActors: readonly string[];
	readonly forbiddenValues: readonly string[];
}): void {
	if (JSON.stringify(props.beforeProtected) !== JSON.stringify(props.afterProtected))
		throw new Error('Protected issuer/client/credential/admission state changed');
	const before = z.array(auditRowSchema).parse(props.beforeAudit);
	const after = z.array(auditRowSchema).parse(props.afterAudit);
	const afterById = new Map(after.map((row) => [row.id, row]));
	if (afterById.size !== after.length) throw new Error('Duplicate audit identity');
	for (const row of before)
		if (JSON.stringify(afterById.get(row.id)) !== JSON.stringify(row))
			throw new Error('Existing audit record was deleted or changed');
	const beforeIds = new Set(before.map((row) => row.id));
	for (const row of after.filter((record) => !beforeIds.has(record.id))) {
		const refused =
			row.change_kind === 'refused' ||
			(row.kind === 'sign-in' && ['failed', 'not-allowed'].includes(row.change_kind));
		if (
			row.phase !== 'outcome' ||
			!refused ||
			!props.attributableActors.includes(row.actor_user_id)
		)
			throw new Error('Audit append is not an attributable refusal outcome');
		if (props.forbiddenValues.some((value) => value !== '' && JSON.stringify(row).includes(value)))
			throw new Error('Audit append contains credential or proof material');
	}
}
