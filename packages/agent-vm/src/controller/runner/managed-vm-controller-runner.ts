import type { GatewayStablePrincipalDigest } from '@agent-vm/agent-portal-sdk/contracts';
import type {
	ControllerExecutionAuthorityBinding,
	ControllerExecutionResult,
} from '@agent-vm/controller-execution-contracts';
import { assertPositiveHostProcessId } from '@agent-vm/managed-vm';
import { z } from 'zod/v4';

import { isManagedVmProcess, type ProcessIdentity } from '../../shared/managed-vm-process.js';
import {
	type ControllerRunnerOperationAuthority,
	type ControllerRunnerOperationLedger,
} from './controller-runner-operation-record.js';

export interface ControllerRunnerAuthorizationSnapshot {
	readonly artifacts: {
		readonly allowedArtifactIds: readonly string[];
		readonly maxBytes: number;
	};
	readonly authorizationFingerprint: string;
	readonly cancellation: {
		readonly deadlineMs: number;
		readonly mode: 'controller-safety-cancel';
	};
	readonly credentials: readonly {
		readonly credentialId: string;
		readonly injection: 'host-process' | 'http-mediation';
	}[];
	readonly cwd: { readonly kind: 'fixed'; readonly path: string };
	readonly egress: { readonly allowedHosts: readonly string[] };
	readonly environment: Readonly<Record<string, string>>;
	readonly executablePath: string;
	readonly mandatoryArgvPrefix: readonly string[];
	readonly output: {
		readonly stderr: 'discard' | 'stream';
		readonly stdout: 'discard' | 'stream';
		readonly windowBytes: number;
	};
	readonly target: { readonly kind: 'new-runner-vm'; readonly zoneId: string };
}

const ControllerRunnerDispatchRequestSchema = z
	.object({
		arguments: z.array(z.string().min(1).max(4096)).min(1).max(100).readonly(),
		authorizationFingerprint: z.string().min(1).max(512),
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
	readonly authorization: ControllerRunnerAuthorizationSnapshot;
	readonly operationId: string;
}

export interface ManagedVmControllerRunnerExecResult {
	readonly exitCode: number;
}

export interface ManagedVmControllerRunnerHandle {
	close(): Promise<void>;
	exec(request: ManagedVmControllerRunnerExecRequest): Promise<ManagedVmControllerRunnerExecResult>;
	getHostProcessId(): number | null;
	readonly id: string;
	start(): Promise<void>;
}

export interface ManagedVmControllerRunnerFactory {
	create(): Promise<ManagedVmControllerRunnerHandle>;
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
	readonly operationLedger: ControllerRunnerOperationLedger;
	readonly readCurrentEpochContext: () => Promise<ControllerRunnerCurrentEpochContext>;
	readonly readProcessIdentity: (hostProcessId: number) => Promise<ProcessIdentity | null>;
	readonly recomputeAuthorization: (
		request: ControllerRunnerDispatchRequest,
	) => Promise<ControllerRunnerAuthorizationSnapshot>;
	readonly runnerFactory: ManagedVmControllerRunnerFactory;
	readonly trustedAuthorityContext: ControllerRunnerTrustedAuthorityContext;
	readonly validatePublicArguments: (argumentsToValidate: readonly string[]) => boolean;
}

function containsPublicAuthorityOrPolicyOverride(
	request: ControllerRunnerDispatchRequest,
	validatePublicArguments: CreateManagedVmControllerRunnerOptions['validatePublicArguments'],
): boolean {
	return !validatePublicArguments(request.arguments);
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

type ManagedVmControllerRunnerAmbiguousReason = 'containment-unproven' | 'dispatch-armed';

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
	} as const satisfies Record<ManagedVmControllerRunnerAmbiguousReason, string>;
	return {
		binding: props.binding,
		certainty: 'side-effects-and-termination-unknown',
		diagnostics: [],
		error: { code: 'execution_failed', message: messageByReason[props.reason] },
		kind: 'ambiguous',
		reason: props.reason,
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
			if (containsPublicAuthorityOrPolicyOverride(request, options.validatePublicArguments)) {
				return notDispatchedResult({
					binding,
					reason: 'public-authority-or-policy-override',
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
				runnerVm = await options.runnerFactory.create();
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
				await options.operationLedger.publishIdentity({
					identity: {
						command: processIdentity.command,
						hostProcessId,
						processStartIdentity: processIdentity.lstart,
						vmId: runnerVm.id,
					},
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
								...request.arguments,
							],
							authorization,
							operationId: request.operationId,
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
							value: { exitCode: executionResult.exitCode },
						};
					}
				}
			} catch {
				result = dispatchArmed
					? ambiguousResult({ binding, reason: 'dispatch-armed' })
					: notDispatchedResult({ binding, reason: 'runner-setup-failed' });
			}

			if (runnerVm !== undefined) {
				try {
					await options.operationLedger.recordContainmentStarted({
						operationId: request.operationId,
					});
					await runnerVm.close();
					await options.operationLedger.recordContained({ operationId: request.operationId });
				} catch {
					result = ambiguousResult({ binding, reason: 'containment-unproven' });
				}
			}

			return result;
		},
	};
}
