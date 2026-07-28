import type { JsonObject, JsonValue } from '../contract-primitives/index.js';
import {
	PortalCallRequestSchema,
	type PortalCallRequest,
} from '../portal-call-surface/models/portal-call-request-schema.js';
import {
	PortalCallResultSchema,
	type PortalCallResult,
} from '../portal-call-surface/models/portal-call-result-schema.js';

export interface CreatePortalCallRequestFixtureProps {
	readonly arguments?: JsonObject;
	readonly id?: string;
	readonly namespace?: string;
	readonly requestId?: string;
	readonly name?: string;
}

export interface CreatePortalCallResultFixtureProps {
	readonly id?: string;
	readonly value?: JsonValue;
}

export function createPortalCallRequestFixture(
	props: CreatePortalCallRequestFixtureProps = {},
): PortalCallRequest {
	return PortalCallRequestSchema.parse({
		calls: [
			{
				arguments: props.arguments ?? {},
				id: props.id ?? 'call-1',
				namespace: props.namespace ?? 'github',
				name: props.name ?? 'get_issue',
			},
		],
		requestId: props.requestId,
	});
}

export function createPortalCallResultFixture(
	props: CreatePortalCallResultFixtureProps = {},
): PortalCallResult {
	return PortalCallResultSchema.parse({
		items: [
			{
				id: props.id ?? 'call-1',
				operationId: 'operation-1',
				outcome: {
					certainty: 'proven',
					completion: 'succeeded',
					kind: 'completed',
					retryClass: 'forbidden',
				},
				owningGeneration: 'tool-vm-generation-1',
				status: 'ok',
				value: props.value ?? {},
			},
		],
		ok: true,
	});
}
