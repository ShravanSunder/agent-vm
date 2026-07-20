import { encodeCanonicalJson, type JsonObject, type JsonValue } from '@agent-vm/agent-portal-sdk';
import {
	ControllerHostActionRequestSchema,
	type ControllerExecutionResult,
	type ControllerHostActionRequest,
	type ValidatedCliInvocation,
} from '@agent-vm/controller-execution-contracts';
import type { z } from 'zod';

export interface ControllerHostActionCredentialAuthority {
	readonly credentialProfileId: string;
	readonly custodyMode: 'controller_durable_state' | 'ephemeral_material';
}

export interface ControllerHostActionTrustedAuthority {
	readonly credentials: readonly ControllerHostActionCredentialAuthority[];
	readonly invocation: ValidatedCliInvocation;
	readonly mandatoryArgvPrefix: readonly string[];
	readonly target: {
		readonly kind: 'controller-host';
		readonly osContextId: string;
	};
}

export interface ControllerHostActionExecutionProps<TInput extends JsonObject> {
	readonly authority: ControllerHostActionTrustedAuthority;
	readonly input: TInput;
	readonly request: ControllerHostActionRequest;
}

export interface DefineControllerHostActionProps<
	TInput extends JsonObject,
	TResult extends JsonValue,
> {
	readonly actionName: string;
	readonly execute: (props: ControllerHostActionExecutionProps<TInput>) => Promise<TResult>;
	readonly inputSchema: z.ZodType<TInput>;
}

type ControllerHostActionInputParseResult =
	| { readonly input: JsonObject; readonly kind: 'valid' }
	| { readonly kind: 'invalid' };

export interface RegisteredControllerHostAction {
	readonly actionName: string;
	readonly execute: (props: {
		readonly authority: ControllerHostActionTrustedAuthority;
		readonly input: JsonObject;
		readonly request: ControllerHostActionRequest;
	}) => Promise<JsonValue>;
	readonly parseInput: (input: JsonObject) => ControllerHostActionInputParseResult;
}

export function defineControllerHostAction<TInput extends JsonObject, TResult extends JsonValue>(
	props: DefineControllerHostActionProps<TInput, TResult>,
): RegisteredControllerHostAction {
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

export interface CreateControllerHostActionRegistryOptions {
	readonly actions: readonly RegisteredControllerHostAction[];
	readonly recomputeAuthorization: (
		request: ControllerHostActionRequest,
	) => Promise<ControllerHostActionTrustedAuthority>;
}

export interface ControllerHostActionRegistry {
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

export function createControllerHostActionRegistry(
	options: CreateControllerHostActionRegistryOptions,
): ControllerHostActionRegistry {
	const actionsByName = new Map<string, RegisteredControllerHostAction>();
	for (const action of options.actions) {
		if (actionsByName.has(action.actionName)) {
			throw new Error(`Duplicate controller host action '${action.actionName}'.`);
		}
		actionsByName.set(action.actionName, action);
	}

	return {
		execute: async (request) => {
			const parsedRequest = ControllerHostActionRequestSchema.safeParse(request);
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
			const action = actionsByName.get(validatedRequest.hostActionName);
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
			let authority: ControllerHostActionTrustedAuthority;
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
