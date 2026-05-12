import { createHash } from 'node:crypto';

import {
	jsonObjectSchema,
	validatePortalToolArguments,
	type JsonObject,
	type PortalToolRecord,
} from '@agent-vm/mcp-portal';

export interface NormalizedPortalApprovalCall {
	readonly arguments: JsonObject;
	readonly id: string;
	readonly namespace: string;
	readonly toolName: string;
}

export interface PortalApprovalGrantKey {
	readonly approvalNonce: string;
	readonly bindingId: string;
	readonly callsHash: string;
}

export interface PortalPersistentApprovalKey {
	readonly bindingId: string;
	readonly callsHash: string;
	readonly sessionId?: string;
}

export interface PortalApprovalGrantOptions {
	readonly clearPersistentSessionOnConsume?: {
		readonly bindingId: string;
		readonly sessionId: string;
	};
}

export type PortalApprovalGrantConsumeResult =
	| {
			readonly clearPersistentSessionOnConsume?: {
				readonly bindingId: string;
				readonly sessionId: string;
			};
			readonly ok: true;
	  }
	| { readonly ok: false };

function stableJsonValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((entry) => stableJsonValue(entry));
	}
	if (typeof value !== 'object' || value === null) {
		return value;
	}

	return Object.fromEntries(
		Object.entries(value)
			.toSorted(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
			.map(([key, entry]) => [key, stableJsonValue(entry)]),
	);
}

export function hashPortalCallArguments(argumentsValue: JsonObject): string {
	return createHash('sha256')
		.update(JSON.stringify(stableJsonValue(argumentsValue)))
		.digest('hex');
}

export function hashPortalApprovalCalls(calls: readonly NormalizedPortalApprovalCall[]): string {
	const semanticCalls = calls.map((call) => ({
		arguments: call.arguments,
		namespace: call.namespace,
		toolName: call.toolName,
	}));
	return createHash('sha256')
		.update(JSON.stringify(stableJsonValue(semanticCalls)))
		.digest('hex');
}

export function normalizePortalApprovalArguments(
	tool: PortalToolRecord,
	argumentsValue: JsonObject,
): JsonObject | null {
	const validation = validatePortalToolArguments(tool, argumentsValue);
	if (!validation.ok) {
		return null;
	}
	const parsedValue = jsonObjectSchema.safeParse(validation.value);
	return parsedValue.success ? parsedValue.data : null;
}

export class InMemoryPortalApprovalBridge {
	private readonly oneTimeGrants = new Set<string>();
	private readonly persistentGrants = new Set<string>();
	private readonly consumeSideEffects = new Map<string, PortalApprovalGrantOptions>();
	private readonly transportSessionPersistentSessions = new Map<string, Set<string>>();

	grant(key: PortalApprovalGrantKey, options: PortalApprovalGrantOptions = {}): void {
		const serializedKey = this.serializeGrantKey(key);
		this.oneTimeGrants.add(serializedKey);
		this.consumeSideEffects.set(serializedKey, options);
	}

	consume(key: PortalApprovalGrantKey): boolean {
		return this.consumeGrant(key).ok;
	}

	consumeGrant(key: PortalApprovalGrantKey): PortalApprovalGrantConsumeResult {
		const serializedKey = this.serializeGrantKey(key);
		if (!this.oneTimeGrants.has(serializedKey)) {
			return { ok: false };
		}
		this.oneTimeGrants.delete(serializedKey);
		const sideEffects = this.consumeSideEffects.get(serializedKey);
		this.consumeSideEffects.delete(serializedKey);
		return {
			...(sideEffects?.clearPersistentSessionOnConsume !== undefined
				? { clearPersistentSessionOnConsume: sideEffects.clearPersistentSessionOnConsume }
				: {}),
			ok: true,
		};
	}

	grantAlways(key: PortalPersistentApprovalKey): void {
		this.persistentGrants.add(this.serializePersistentKey(key));
	}

	hasAlways(key: PortalPersistentApprovalKey): boolean {
		return this.persistentGrants.has(this.serializePersistentKey(key));
	}

	clearBinding(bindingId: string): void {
		for (const key of this.oneTimeGrants) {
			if (key.startsWith(`${bindingId}\n`)) {
				this.oneTimeGrants.delete(key);
				this.consumeSideEffects.delete(key);
			}
		}
		for (const key of this.persistentGrants) {
			if (key.startsWith(`${bindingId}\n`)) {
				this.persistentGrants.delete(key);
			}
		}
		for (const key of this.transportSessionPersistentSessions.keys()) {
			if (key.startsWith(`${bindingId}\n`)) {
				this.transportSessionPersistentSessions.delete(key);
			}
		}
	}

	clearSession(bindingId: string, sessionId: string): void {
		const sessionPrefix = `${bindingId}\n${sessionId}\n`;
		for (const key of this.persistentGrants) {
			if (key.startsWith(sessionPrefix)) {
				this.persistentGrants.delete(key);
			}
		}
	}

	bindTransportSessionToPersistentSession(props: {
		readonly bindingId: string;
		readonly persistentSessionId: string;
		readonly transportSessionId: string;
	}): void {
		const transportSessionKey = this.serializeTransportSessionKey(
			props.bindingId,
			props.transportSessionId,
		);
		const existingSessions = this.transportSessionPersistentSessions.get(transportSessionKey);
		if (existingSessions) {
			existingSessions.add(props.persistentSessionId);
			return;
		}
		this.transportSessionPersistentSessions.set(
			transportSessionKey,
			new Set([props.persistentSessionId]),
		);
	}

	clearTransportSession(bindingId: string, transportSessionId: string): void {
		const transportSessionKey = this.serializeTransportSessionKey(bindingId, transportSessionId);
		const persistentSessions = this.transportSessionPersistentSessions.get(transportSessionKey);
		this.transportSessionPersistentSessions.delete(transportSessionKey);
		if (persistentSessions !== undefined) {
			for (const persistentSessionId of persistentSessions) {
				this.clearSession(bindingId, persistentSessionId);
			}
		}
	}

	private serializeGrantKey(key: PortalApprovalGrantKey): string {
		return `${key.bindingId}\n${key.approvalNonce}\n${key.callsHash}`;
	}

	private serializePersistentKey(key: PortalPersistentApprovalKey): string {
		return `${key.bindingId}\n${key.sessionId ?? ''}\n${key.callsHash}`;
	}

	private serializeTransportSessionKey(bindingId: string, transportSessionId: string): string {
		return `${bindingId}\n${transportSessionId}`;
	}
}
