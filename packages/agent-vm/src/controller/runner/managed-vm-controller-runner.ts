import { JsonObjectSchema } from '@agent-vm/agent-portal-sdk';
import type { GatewayStablePrincipalDigest } from '@agent-vm/agent-portal-sdk/contracts';
import {
	configuredCliInputSchema,
	type ConfiguredCliInput,
	type ControllerExecutionOperation,
} from '@agent-vm/config-contracts';
import type {
	ControllerExecutionAuthorityBinding,
	ControllerExecutionResult,
} from '@agent-vm/controller-execution-contracts';
import { assertPositiveHostProcessId } from '@agent-vm/managed-vm';
import { z } from 'zod/v4';

import { isManagedVmProcess, type ProcessIdentity } from '../../shared/managed-vm-process.js';
import { ConfiguredControllerExecutionError } from './configured-controller-execution-error.js';
import {
	type ControllerRunnerOperationAuthority,
	type ControllerRunnerOperationLedger,
} from './controller-runner-operation-record.js';

export interface ControllerRunnerAuthorizationSnapshot {
	readonly authorizationFingerprint: string;
	readonly cancellation: {
		readonly timeoutMs: number;
	};
	readonly cwd: { readonly kind: 'fixed'; readonly path: string };
	readonly egress: { readonly allowedHosts: readonly string[] };
	readonly environment: Readonly<Record<string, string>>;
	readonly executablePath: string;
	readonly imageFingerprint: string;
	readonly imageReference: string;
	readonly mandatoryArgvPrefix: readonly string[];
	readonly output: Extract<
		ControllerExecutionOperation,
		{ readonly kind: 'configured_cli' }
	>['output'];
	readonly target: { readonly kind: 'ephemeral_managed_vm'; readonly zoneId: string };
}

const ControllerRunnerDispatchRequestSchema = z
	.object({
		authorizationFingerprint: z.string().min(1).max(512),
		input: configuredCliInputSchema,
		operationId: z
			.string()
			.min(1)
			.max(128)
			.regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
	})
	.strict();

export type ControllerRunnerDispatchRequest = z.infer<typeof ControllerRunnerDispatchRequestSchema>;

export interface ManagedVmControllerRunnerExecRequest {
	readonly argv: readonly string[];
	readonly cwd: string;
	readonly environment: Readonly<Record<string, string>>;
	readonly output: ControllerRunnerAuthorizationSnapshot['output'];
	readonly stdin?: string;
	readonly timeoutMs: number;
}

export interface ManagedVmControllerRunnerExecResult {
	readonly exitCode: number;
	readonly stderrSummary?: string;
	readonly stderrTruncated: boolean;
	readonly stdout: string;
	readonly stdoutTruncated: boolean;
}

export interface ManagedVmControllerRunnerHandle {
	close(identity?: {
		readonly command: string;
		readonly hostProcessId: number;
		readonly processStartIdentity: string;
		readonly vmId: string;
	}): Promise<void>;
	exec(request: ManagedVmControllerRunnerExecRequest): Promise<ManagedVmControllerRunnerExecResult>;
	getHostProcessId(): number | null;
	readonly id: string;
	start(): Promise<void>;
}

export interface ManagedVmControllerRunnerFactory {
	create(
		authorization: ControllerRunnerAuthorizationSnapshot,
	): Promise<ManagedVmControllerRunnerHandle>;
}

export interface ManagedVmControllerRunner {
	execute(request: unknown): Promise<ControllerExecutionResult>;
}

export interface ControllerRunnerCurrentEpochContext {
	readonly controllerEpoch: string;
	readonly gatewayEpoch: string;
	readonly parentGatewayVmId: string;
	readonly runtimeEpoch: string;
}

export interface ControllerRunnerTrustedAuthorityContext extends ControllerRunnerCurrentEpochContext {
	readonly stablePrincipal: GatewayStablePrincipalDigest;
}

export interface CreateManagedVmControllerRunnerOptions {
	readonly createRunnerId: (request: ControllerRunnerDispatchRequest) => string;
	readonly initialAuthorization: ControllerRunnerAuthorizationSnapshot;
	readonly operationLedger: ControllerRunnerOperationLedger;
	readonly readCurrentEpochContext: () => Promise<ControllerRunnerCurrentEpochContext>;
	readonly readProcessIdentity: (hostProcessId: number) => Promise<ProcessIdentity | null>;
	readonly recomputeAuthorization: (
		request: ControllerRunnerDispatchRequest,
	) => Promise<ControllerRunnerAuthorizationSnapshot>;
	readonly runnerFactory: ManagedVmControllerRunnerFactory;
	readonly trustedAuthorityContext: ControllerRunnerTrustedAuthorityContext;
	readonly validatePublicInput: (input: ConfiguredCliInput) => boolean;
}

function containsPublicAuthorityOrPolicyOverride(
	request: ControllerRunnerDispatchRequest,
	validatePublicInput: CreateManagedVmControllerRunnerOptions['validatePublicInput'],
): boolean {
	return !validatePublicInput(request.input);
}

function isCurrentEpochContext(
	expected: ControllerRunnerCurrentEpochContext,
	current: ControllerRunnerCurrentEpochContext,
): boolean {
	return (
		expected.controllerEpoch === current.controllerEpoch &&
		expected.gatewayEpoch === current.gatewayEpoch &&
		expected.parentGatewayVmId === current.parentGatewayVmId &&
		expected.runtimeEpoch === current.runtimeEpoch
	);
}

type ManagedVmControllerRunnerNotDispatchedReason =
	| 'authorization-fingerprint-changed'
	| 'current-epoch-changed'
	| 'duplicate-operation'
	| 'predecessor-owner-unsafe'
	| 'public-authority-or-policy-override'
	| 'runner-setup-failed';

type ManagedVmControllerRunnerAmbiguousReason =
	| 'containment-unproven'
	| 'dispatch-armed'
	| 'dispatch-timeout';

function controllerExecutionBinding(
	request: ControllerRunnerDispatchRequest,
): ControllerExecutionAuthorityBinding {
	return {
		fingerprint: request.authorizationFingerprint,
		operationId: request.operationId,
	};
}

function notDispatchedError(
	reason: ManagedVmControllerRunnerNotDispatchedReason,
): ControllerExecutionResult & { readonly kind: 'not-dispatched' } {
	const errorByReason = {
		'authorization-fingerprint-changed': {
			code: 'not_authorized',
			message: 'Controller runner authority is no longer current.',
		},
		'current-epoch-changed': {
			code: 'not_authorized',
			message: 'Controller runner authority is no longer current.',
		},
		'duplicate-operation': {
			code: 'not_authorized',
			message: 'Controller runner operation is already reserved.',
		},
		'predecessor-owner-unsafe': {
			code: 'not_authorized',
			message: 'Controller runner predecessor containment is not proven.',
		},
		'public-authority-or-policy-override': {
			code: 'validation_failed',
			message: 'Controller runner request did not pass strict public validation.',
		},
		'runner-setup-failed': {
			code: 'execution_failed',
			message: 'Controller runner setup failed before dispatch.',
		},
	} as const satisfies Record<
		ManagedVmControllerRunnerNotDispatchedReason,
		{
			readonly code:
				| 'capability_denied'
				| 'execution_failed'
				| 'not_authorized'
				| 'validation_failed';
			readonly message: string;
		}
	>;
	return {
		certainty: 'proven',
		diagnostics: [],
		error: errorByReason[reason],
		kind: 'not-dispatched',
		reason,
		retryClass: 'safe-before-dispatch',
	};
}

function notDispatchedResult(props: {
	readonly binding?: ControllerExecutionAuthorityBinding;
	readonly reason: ManagedVmControllerRunnerNotDispatchedReason;
}): ControllerExecutionResult {
	return {
		...notDispatchedError(props.reason),
		...(props.binding === undefined ? {} : { binding: props.binding }),
	};
}

function ambiguousResult(props: {
	readonly binding: ControllerExecutionAuthorityBinding;
	readonly reason: ManagedVmControllerRunnerAmbiguousReason;
}): ControllerExecutionResult {
	const messageByReason = {
		'containment-unproven': 'Controller runner containment could not be proven.',
		'dispatch-armed': 'Controller runner dispatch state is unknown after dispatch was armed.',
		'dispatch-timeout': 'Controller runner command timed out after dispatch was armed.',
	} as const satisfies Record<ManagedVmControllerRunnerAmbiguousReason, string>;
	return {
		binding: props.binding,
		certainty: 'side-effects-and-termination-unknown',
		diagnostics: [],
		error: {
			code: props.reason === 'dispatch-timeout' ? 'timeout' : 'execution_failed',
			message: messageByReason[props.reason],
		},
		kind: 'ambiguous',
		reason: props.reason === 'dispatch-timeout' ? 'dispatch-armed' : props.reason,
		retryClass: 'forbidden',
	};
}

export function createManagedVmControllerRunner(
	options: CreateManagedVmControllerRunnerOptions,
): ManagedVmControllerRunner {
	return {
		execute: async (untrustedRequest: unknown): Promise<ControllerExecutionResult> => {
			const parsedRequest = ControllerRunnerDispatchRequestSchema.safeParse(untrustedRequest);
			if (!parsedRequest.success) {
				return notDispatchedResult({ reason: 'public-authority-or-policy-override' });
			}
			const request = parsedRequest.data;
			const binding = controllerExecutionBinding(request);
			if (containsPublicAuthorityOrPolicyOverride(request, options.validatePublicInput)) {
				return notDispatchedResult({
					binding,
					reason: 'public-authority-or-policy-override',
				});
			}
			if (
				options.initialAuthorization.authorizationFingerprint !== request.authorizationFingerprint
			) {
				return notDispatchedResult({
					binding,
					reason: 'authorization-fingerprint-changed',
				});
			}

			const operationAuthority = {
				...options.trustedAuthorityContext,
				executionFingerprint: request.authorizationFingerprint,
				operationId: request.operationId,
				runnerId: options.createRunnerId(request),
			} satisfies ControllerRunnerOperationAuthority;
			const successorAdmission = await options.operationLedger.admitSuccessor({
				parentGatewayVmId: operationAuthority.parentGatewayVmId,
				stablePrincipal: operationAuthority.stablePrincipal,
			});
			if (successorAdmission.kind === 'rejected') {
				return notDispatchedResult({ binding, reason: successorAdmission.reason });
			}
			let runnerVm: ManagedVmControllerRunnerHandle | undefined;
			let runnerIdentity:
				| {
						readonly command: string;
						readonly hostProcessId: number;
						readonly processStartIdentity: string;
						readonly vmId: string;
				  }
				| undefined;
			let dispatchArmed = false;
			let result: ControllerExecutionResult = notDispatchedResult({
				binding,
				reason: 'runner-setup-failed',
			});

			try {
				const reservation = await options.operationLedger.reserve(operationAuthority);
				if (reservation.kind === 'rejected') {
					return notDispatchedResult({ binding, reason: reservation.reason });
				}
				await options.operationLedger.recordCreationStarted({ operationId: request.operationId });
				runnerVm = await options.runnerFactory.create(options.initialAuthorization);
				await options.operationLedger.recordVmCreated({
					operationId: request.operationId,
					vmId: runnerVm.id,
				});
				await runnerVm.start();
				const hostProcessId = assertPositiveHostProcessId(runnerVm.getHostProcessId());
				const processIdentity = await options.readProcessIdentity(hostProcessId);
				if (processIdentity === null || !isManagedVmProcess(processIdentity.command)) {
					throw new Error('Controller runner host process identity is absent or not a managed VM.');
				}
				runnerIdentity = {
					command: processIdentity.command,
					hostProcessId,
					processStartIdentity: processIdentity.lstart,
					vmId: runnerVm.id,
				};
				await options.operationLedger.publishIdentity({
					identity: runnerIdentity,
					operationId: request.operationId,
				});
				await options.operationLedger.recordAdmissionValidated({
					operationId: request.operationId,
				});

				const authorization = await options.recomputeAuthorization(request);
				if (authorization.authorizationFingerprint !== request.authorizationFingerprint) {
					result = notDispatchedResult({
						binding,
						reason: 'authorization-fingerprint-changed',
					});
				} else {
					const currentEpochContext = await options.readCurrentEpochContext();
					if (!isCurrentEpochContext(options.trustedAuthorityContext, currentEpochContext)) {
						result = notDispatchedResult({ binding, reason: 'current-epoch-changed' });
					} else {
						await options.operationLedger.recordDispatchArmed({ operationId: request.operationId });
						dispatchArmed = true;
						await options.operationLedger.recordRunning({ operationId: request.operationId });
						const executionResult = await runnerVm.exec({
							argv: [
								authorization.executablePath,
								...authorization.mandatoryArgvPrefix,
								...request.input.argv,
							],
							cwd: authorization.cwd.path,
							environment: authorization.environment,
							output: authorization.output,
							...(request.input.stdin === undefined ? {} : { stdin: request.input.stdin }),
							timeoutMs: authorization.cancellation.timeoutMs,
						});
						await options.operationLedger.recordResultStreaming({
							operationId: request.operationId,
						});
						await options.operationLedger.recordResult({ operationId: request.operationId });
						result = {
							binding,
							certainty: 'proven',
							completion: 'succeeded',
							diagnostics: [],
							kind: 'completed',
							retryClass: 'forbidden',
							value: JsonObjectSchema.parse(executionResult),
						};
					}
				}
			} catch (error) {
				result = dispatchArmed
					? ambiguousResult({
							binding,
							reason:
								error instanceof ConfiguredControllerExecutionError && error.code === 'timeout'
									? 'dispatch-timeout'
									: 'dispatch-armed',
						})
					: notDispatchedResult({ binding, reason: 'runner-setup-failed' });
			}

			if (runnerVm !== undefined) {
				try {
					await options.operationLedger.recordContainmentStarted({
						operationId: request.operationId,
					});
					await runnerVm.close(runnerIdentity);
					await options.operationLedger.recordContained({ operationId: request.operationId });
				} catch {
					result = ambiguousResult({ binding, reason: 'containment-unproven' });
				}
			}

			return result;
		},
	};
}
