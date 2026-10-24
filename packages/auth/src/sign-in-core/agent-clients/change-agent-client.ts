import type {
	AgentClientChangeResult,
	AgentRegistration,
} from '#auth/sign-in-core/agent-clients/agent-registration';
import type { AgentAuditChange } from '#auth/sign-in-core/security-audit/agent-client-audit';

export interface AgentClientRecords {
	readonly clientExists: (clientId: string) => Promise<boolean>;
	readonly read: (clientId: string) => Promise<AgentRegistration | null>;
	readonly record: (change: AgentAuditChange, phase: 'intent' | 'outcome') => Promise<void>;
	readonly complete: (change: AgentAuditChange) => Promise<boolean>;
}
export interface AgentClientProvider {
	readonly create: () => Promise<{ readonly clientId: string; readonly clientSecret: string }>;
	readonly link: () => Promise<void>;
	readonly rotate: () => Promise<string>;
	readonly disable: () => Promise<void>;
}
export interface AgentClientOperationPorts {
	readonly records: AgentClientRecords;
	readonly provider: Pick<AgentClientProvider, 'disable'>;
	readonly clientId: string;
	readonly organizationId: string;
	readonly actorUserId: string;
	readonly requestId: string;
}
export interface AgentClientChangePorts extends Omit<AgentClientOperationPorts, 'provider'> {
	readonly provider: AgentClientProvider;
	readonly audience: string;
}

/** A partial registration has no releasable secret. An owner retry rotates the lost secret. */
export async function registerAgentClient(
	props: AgentClientChangePorts,
): Promise<AgentClientChangeResult> {
	const audit = {
		requestId: props.requestId,
		actorUserId: props.actorUserId,
		clientId: props.clientId,
		change: 'registered',
	} satisfies AgentAuditChange;
	try {
		await props.records.record(audit, 'intent');
		const existing = await props.records.clientExists(props.clientId);
		let secret: string | undefined;
		if (!existing) {
			const created = await props.provider.create();
			if (created.clientId !== props.clientId)
				return { kind: 'incomplete', clientId: props.clientId };
			secret = created.clientSecret;
		}
		await props.provider.link();
		await props.records.record(audit, 'outcome');
		const registration = await props.records.read(props.clientId);
		if (
			registration === null ||
			registration.disabled ||
			!registration.registrationComplete ||
			registration.metadata.organizationId !== props.organizationId ||
			!registration.resourceIds.includes(props.audience) ||
			!(await props.records.complete(audit))
		)
			return { kind: 'incomplete', clientId: props.clientId };
		if (existing) {
			const rotation = { ...audit, change: 'rotated' } satisfies AgentAuditChange;
			await props.records.record(rotation, 'intent');
			secret = await props.provider.rotate();
			await props.records.record(rotation, 'outcome');
			const rotated = await props.records.read(props.clientId);
			if (rotated === null || rotated.disabled || !(await props.records.complete(rotation)))
				return { kind: 'incomplete', clientId: props.clientId };
		}
		if (secret === undefined) return { kind: 'incomplete', clientId: props.clientId };
		return { kind: 'registered', clientId: props.clientId, clientSecret: secret };
	} catch {
		return { kind: 'incomplete', clientId: props.clientId };
	}
}

/** Admission removal is the Gateway's earlier step; this function owns only E9 retirement. */
export async function disableAgentClient(
	props: AgentClientOperationPorts,
): Promise<AgentClientChangeResult> {
	const audit = {
		requestId: props.requestId,
		actorUserId: props.actorUserId,
		clientId: props.clientId,
		change: 'retired',
	} satisfies AgentAuditChange;
	try {
		await props.records.record(audit, 'intent');
		const current = await props.records.read(props.clientId);
		if (current === null || current.metadata.organizationId !== props.organizationId)
			return { kind: 'refused', reason: 'invalid-client' };
		await props.provider.disable();
		await props.records.record(audit, 'outcome');
		const disabled = await props.records.read(props.clientId);
		if (disabled === null || !disabled.disabled || !(await props.records.complete(audit)))
			return { kind: 'incomplete', clientId: props.clientId };
		return { kind: 'disabled', clientId: props.clientId };
	} catch {
		return { kind: 'incomplete', clientId: props.clientId };
	}
}
