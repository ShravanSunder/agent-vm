import { encodeCanonicalJson, type JsonObject, type JsonValue } from '@agent-vm/agent-portal-sdk';
import {
	ControllerExecutionRequestSchema,
	type ControllerExecutionResult,
	type ControllerExecutionRequest,
	type ValidatedCliInvocation,
} from '@agent-vm/controller-execution-contracts';
import type { z } from 'zod';

export interface ControllerExecutionCredentialAuthority {
	readonly credentialProfileId: string;
	readonly custodyMode: 'controller_durable_state' | 'ephemeral_material';
}

export interface ControllerExecutionTrustedAuthority {
	readonly credentials: readonly ControllerExecutionCredentialAuthority[];
	readonly invocation: ValidatedCliInvocation;
	readonly mandatoryArgvPrefix: readonly string[];
	readonly target: {
		readonly kind: 'controller-host';
		readonly osContextId: string;
	};
}

export interface ControllerExecutionExecutionProps<TInput extends JsonObject> {
	readonly authority: ControllerExecutionTrustedAuthority;
	readonly input: TInput;
	readonly request: ControllerExecutionRequest;
}

export interface DefineControllerExecutionProps<
	TInput extends JsonObject,
	TResult extends JsonValue,
> {
	readonly actionName: string;
	readonly execute: (props: ControllerExecutionExecutionProps<TInput>) => Promise<TResult>;
	readonly inputSchema: z.ZodType<TInput>;
}

type ControllerExecutionInputParseResult =
	| { readonly input: JsonObject; readonly kind: 'valid' }
	| { readonly kind: 'invalid' };

export interface RegisteredControllerExecution {
	readonly actionName: string;
	readonly execute: (props: {
		readonly authority: ControllerExecutionTrustedAuthority;
		readonly input: JsonObject;
		readonly request: ControllerExecutionRequest;
	}) => Promise<JsonValue>;
	readonly parseInput: (input: JsonObject) => ControllerExecutionInputParseResult;
}

export function defineControllerExecution<TInput extends JsonObject, TResult extends JsonValue>(
	props: DefineControllerExecutionProps<TInput, TResult>,
): RegisteredControllerExecution {
	if (props.actionName.length === 0) {
		throw new Error('Controller host action name must be non-empty.');
	}
	return {
		actionName: props.actionName,
		execute: async ({ authority, input, request }) => {
			const parsedInput = props.inputSchema.parse(input);
			return await props.execute({ authority, input: parsedInput, request });
		},
		parseInput: (input) => {
			const parsedInput = props.inputSchema.safeParse(input);
			return parsedInput.success ? { input: parsedInput.data, kind: 'valid' } : { kind: 'invalid' };
		},
	};
}

export interface CreateControllerExecutionRegistryOptions {
	readonly actions: readonly RegisteredControllerExecution[];
	readonly recomputeAuthorization: (
		request: ControllerExecutionRequest,
	) => Promise<ControllerExecutionTrustedAuthority>;
}

export interface ControllerExecutionRegistry {
	execute(request: unknown): Promise<ControllerExecutionResult>;
	hasAction(actionName: string): boolean;
	listActionNames(): readonly string[];
}

function rejectedResult(options: {
	readonly code: 'capability_denied' | 'not_authorized' | 'validation_failed';
	readonly message: string;
	readonly reason: Extract<
		ControllerExecutionResult,
		{ readonly kind: 'not-dispatched' }
	>['reason'];
}): ControllerExecutionResult {
	return {
		certainty: 'proven',
		diagnostics: [],
		error: { code: options.code, message: options.message },
		kind: 'not-dispatched',
		reason: options.reason,
		retryClass: 'safe-before-dispatch',
	};
}

function canonicalJsonMatches(left: JsonObject, right: JsonObject): boolean {
	return encodeCanonicalJson(left) === encodeCanonicalJson(right);
}

export function createControllerExecutionRegistry(
	options: CreateControllerExecutionRegistryOptions,
): ControllerExecutionRegistry {
	const actionsByName = new Map<string, RegisteredControllerExecution>();
	for (const action of options.actions) {
		if (actionsByName.has(action.actionName)) {
			throw new Error(`Duplicate controller host action '${action.actionName}'.`);
		}
		actionsByName.set(action.actionName, action);
	}

	return {
		execute: async (request) => {
			const parsedRequest = ControllerExecutionRequestSchema.safeParse(request);
			if (!parsedRequest.success) {
				return rejectedResult({
					code: 'validation_failed',
					message: 'Controller host action request failed strict validation.',
					reason: 'public-authority-or-policy-override',
				});
			}
			const validatedRequest = parsedRequest.data;
			const auditCorrelationId = validatedRequest.dispatch.auditCorrelationId;
			if (
				!canonicalJsonMatches(
					validatedRequest.canonicalArguments,
					validatedRequest.dispatch.canonicalArguments,
				)
			) {
				return rejectedResult({
					code: 'validation_failed',
					message: 'Controller host action arguments do not match the dispatch intent.',
					reason: 'public-authority-or-policy-override',
				});
			}
			const action = actionsByName.get(validatedRequest.operationName);
			if (action === undefined) {
				return rejectedResult({
					code: 'capability_denied',
					message: 'Controller host action is not registered.',
					reason: 'denied',
				});
			}
			const parsedInput = action.parseInput(validatedRequest.canonicalArguments);
			if (parsedInput.kind === 'invalid') {
				return rejectedResult({
					code: 'validation_failed',
					message: 'Controller host action arguments failed capability validation.',
					reason: 'public-authority-or-policy-override',
				});
			}
			let authority: ControllerExecutionTrustedAuthority;
			try {
				authority = await options.recomputeAuthorization(validatedRequest);
			} catch {
				return rejectedResult({
					code: 'not_authorized',
					message: 'Controller host action authority could not be recomputed.',
					reason: 'stale-authority',
				});
			}
			const binding = {
				fingerprint: encodeCanonicalJson(authority.invocation.fingerprint),
				operationId: auditCorrelationId,
			};
			try {
				const value = await action.execute({
					authority,
					input: parsedInput.input,
					request: validatedRequest,
				});
				return {
					binding,
					certainty: 'proven',
					completion: 'succeeded',
					diagnostics: [],
					kind: 'completed',
					retryClass: 'forbidden',
					value,
				};
			} catch {
				return {
					binding,
					certainty: 'side-effects-and-termination-unknown',
					diagnostics: [],
					error: {
						code: 'execution_failed',
						message: 'Controller host action execution state is unknown.',
					},
					kind: 'ambiguous',
					reason: 'dispatch-state-unknown',
					retryClass: 'forbidden',
				};
			}
		},
		hasAction: (actionName): boolean => actionsByName.has(actionName),
		listActionNames: (): readonly string[] => [...actionsByName.keys()],
	};
}
