import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

import { encodeCanonicalJson, JsonObjectSchema } from '@agent-vm/agent-portal-sdk';
import type { GatewayStablePrincipalDigest } from '@agent-vm/agent-portal-sdk/contracts';
import {
	resolveConfiguredCliTimeout,
	type ConfiguredCliInput,
	type ControllerExecutionOperation,
} from '@agent-vm/config-contracts';
import { GatewayControlConfiguredCliControllerExecutionResultSchema } from '@agent-vm/gateway-control-contracts';
import type {
	ManagedVmExactProcessTerminationCapability,
	ManagedVmFactory,
} from '@agent-vm/managed-vm';
import { validateCliAllowanceInvocation } from '@agent-vm/tool-portal/cli-allowances';

import type { ProcessIdentity } from '../../shared/managed-vm-process.js';
import { createConfiguredCliManagedVmRunnerFactory } from './configured-cli-managed-vm-factory.js';
import { ConfiguredControllerExecutionError } from './configured-controller-execution-error.js';
import {
	createControllerRunnerOperationLedger,
	type ControllerRunnerHostProcessIdentity,
	type ControllerRunnerOperationLedger,
	type ControllerRunnerRecoverableRecord,
} from './controller-runner-operation-record.js';
import {
	createManagedVmControllerRunner,
	type ControllerRunnerAuthorizationSnapshot,
	type ControllerRunnerCurrentEpochContext,
} from './managed-vm-controller-runner.js';

type ConfiguredCliOperation = Extract<ControllerExecutionOperation, { kind: 'configured_cli' }>;
export interface ConfiguredCliManagedVmGatewayIdentity extends ControllerRunnerCurrentEpochContext {}

export interface CreateConfiguredCliManagedVmExecutorProps {
	readonly controllerStateDir: string;
	readonly managedVmExactProcessTermination: ManagedVmExactProcessTerminationCapability;
	readonly managedVmFactory: ManagedVmFactory;
	readonly now?: () => number;
	readonly readProcessIdentity: (hostProcessId: number) => Promise<ProcessIdentity | null>;
	readonly resolveGatewayIdentity: (
		zoneId: string,
	) => Promise<ConfiguredCliManagedVmGatewayIdentity>;
}

function resolveEnvironment(
	policy: ConfiguredCliOperation['executionTarget']['environment'],
): Readonly<Record<string, string>> {
	if (policy.kind === 'empty') return {};
	return Object.fromEntries(
		policy.names.flatMap((name) => {
			const value = process.env[name];
			return value === undefined ? [] : [[name, value]];
		}),
	);
}

function digestJson(value: unknown): string {
	const jsonValue = JsonObjectSchema.parse(value);
	return `sha256:${createHash('sha256').update(encodeCanonicalJson(jsonValue)).digest('hex')}`;
}

function authorizationSnapshot(props: {
	readonly input: ConfiguredCliInput;
	readonly operation: ConfiguredCliOperation;
	readonly operationName: string;
	readonly zoneId: string;
}): ControllerRunnerAuthorizationSnapshot {
	if (props.operation.executionTarget.kind !== 'ephemeral_managed_vm') {
		throw new ConfiguredControllerExecutionError(
			'validation_failed',
			'Configured CLI operation is not an ephemeral Managed VM target.',
		);
	}
	const timeout = resolveConfiguredCliTimeout({
		input: props.input,
		kind: props.operation.timeout.kind,
	});
	return {
		authorizationFingerprint: digestJson({
			input: props.input,
			operation: props.operation,
			operationName: props.operationName,
			resolvedTimeoutMs: timeout.resolvedTimeoutMs,
			zoneId: props.zoneId,
		}),
		cancellation: { timeoutMs: timeout.resolvedTimeoutMs },
		cwd: { kind: 'fixed', path: props.operation.executionTarget.guestCwd },
		egress: { allowedHosts: props.operation.executionTarget.allowedHosts },
		environment: resolveEnvironment(props.operation.executionTarget.environment),
		executablePath: props.operation.executablePath,
		imageFingerprint: digestJson({
			imageReference: props.operation.executionTarget.imageReference,
		}),
		imageReference: props.operation.executionTarget.imageReference,
		mandatoryArgvPrefix: props.operation.mandatoryArgvPrefix,
		output: props.operation.output,
		target: { kind: 'ephemeral_managed_vm', zoneId: props.zoneId },
	};
}

function identityFromRecoverableRecord(
	record: ControllerRunnerRecoverableRecord,
): ControllerRunnerHostProcessIdentity | null {
	return 'identity' in record ? record.identity : null;
}

export function createConfiguredCliManagedVmExecutor(
	props: CreateConfiguredCliManagedVmExecutorProps,
): (request: {
	readonly input: ConfiguredCliInput;
	readonly operation: ConfiguredCliOperation;
	readonly operationName: string;
	readonly reloadOperation: () => Promise<ConfiguredCliOperation>;
	readonly stablePrincipal: GatewayStablePrincipalDigest;
	readonly zoneId: string;
}) => Promise<{
	readonly exitCode: number;
	readonly stderrSummary?: string;
	readonly stderrTruncated: boolean;
	readonly stdout: string;
	readonly stdoutTruncated: boolean;
}> {
	const now = props.now ?? Date.now;
	const ledgersByControllerEpochAndZone = new Map<
		string,
		Promise<ControllerRunnerOperationLedger>
	>();

	const resolveLedger = async (
		identity: ConfiguredCliManagedVmGatewayIdentity,
	): Promise<ControllerRunnerOperationLedger> => {
		const key = `${identity.controllerEpoch}\u0000${identity.parentGatewayVmId}`;
		const existing = ledgersByControllerEpochAndZone.get(key);
		if (existing !== undefined) return await existing;
		const created = (async (): Promise<ControllerRunnerOperationLedger> => {
			const ledger = createControllerRunnerOperationLedger({
				containPredecessor: async (record) => {
					const recordedIdentity = identityFromRecoverableRecord(record);
					if (recordedIdentity === null) {
						return record.kind === 'reserved' || record.kind === 'creation-started'
							? { kind: 'contained' as const }
							: {
									kind: 'owner-unsafe' as const,
									reason: 'runner process identity was not durably published',
								};
					}
					try {
						await props.managedVmExactProcessTermination.terminateRecordedHostProcess({
							contextLabel: 'configured controller execution predecessor',
							identity: recordedIdentity,
						});
						return { kind: 'contained' as const };
					} catch {
						return {
							kind: 'owner-unsafe' as const,
							reason: 'exact runner process termination could not be proven',
						};
					}
				},
				controllerEpoch: identity.controllerEpoch,
				recordsDirectoryPath: path.join(
					props.controllerStateDir,
					'controller-runners',
					identity.parentGatewayVmId,
				),
				runtime: { clock: { now: () => new Date(now()) } },
			});
			await ledger.recover();
			return ledger;
		})();
		ledgersByControllerEpochAndZone.set(key, created);
		return await created;
	};

	return async (request) => {
		if (request.operation.executionTarget.kind !== 'ephemeral_managed_vm') {
			throw new ConfiguredControllerExecutionError(
				'validation_failed',
				'Configured CLI operation is not an ephemeral Managed VM target.',
			);
		}
		const validation = validateCliAllowanceInvocation({
			allowance: request.operation,
			input: request.input,
		});
		if (!validation.ok) {
			throw new ConfiguredControllerExecutionError('validation_failed', validation.error.message);
		}
		const gatewayIdentity = await props.resolveGatewayIdentity(request.zoneId);
		const initialAuthorization = authorizationSnapshot({
			input: request.input,
			operation: request.operation,
			operationName: request.operationName,
			zoneId: request.zoneId,
		});
		const operationId = randomUUID();
		const runner = createManagedVmControllerRunner({
			createRunnerId: () => `controller-execution-${operationId}`,
			initialAuthorization,
			operationLedger: await resolveLedger(gatewayIdentity),
			readCurrentEpochContext: async () => await props.resolveGatewayIdentity(request.zoneId),
			readProcessIdentity: props.readProcessIdentity,
			recomputeAuthorization: async () => {
				const currentOperation = await request.reloadOperation();
				return authorizationSnapshot({
					input: request.input,
					operation: currentOperation,
					operationName: request.operationName,
					zoneId: request.zoneId,
				});
			},
			runnerFactory: createConfiguredCliManagedVmRunnerFactory({
				exactProcessTermination: props.managedVmExactProcessTermination,
				managedVmFactory: props.managedVmFactory,
				sessionLabel: `controller-execution-${operationId}`,
			}),
			trustedAuthorityContext: { ...gatewayIdentity, stablePrincipal: request.stablePrincipal },
			validatePublicInput: (input) =>
				validateCliAllowanceInvocation({ allowance: request.operation, input }).ok,
		});
		const result = await runner.execute({
			authorizationFingerprint: initialAuthorization.authorizationFingerprint,
			input: request.input,
			operationId,
		});
		if (result.kind !== 'completed') {
			throw new ConfiguredControllerExecutionError(
				result.kind === 'not-dispatched'
					? 'not_dispatched'
					: result.error.code === 'timeout'
						? 'timeout'
						: 'execution_failed',
				'Configured Managed VM execution did not complete.',
			);
		}
		const parsedResult = GatewayControlConfiguredCliControllerExecutionResultSchema.parse({
			kind: 'configured_cli',
			operationName: request.operationName,
			result: result.value,
		}).result;
		return {
			exitCode: parsedResult.exitCode,
			...(parsedResult.stderrSummary === undefined
				? {}
				: { stderrSummary: parsedResult.stderrSummary }),
			stderrTruncated: parsedResult.stderrTruncated,
			stdout: parsedResult.stdout,
			stdoutTruncated: parsedResult.stdoutTruncated,
		};
	};
}
