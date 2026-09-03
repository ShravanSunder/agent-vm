import { randomBytes } from 'node:crypto';

import {
	decodeConfiguredCliPreparedImageIdentity,
	resolveConfiguredCliTimeout,
	type ControllerConfiguredCliInput,
} from '@agent-vm/config-contracts';
import type {
	ManagedVm,
	ManagedVmFactory,
	ManagedVmMediatedSecretDescriptor,
} from '@agent-vm/managed-vm';
import type { SecretResolver } from '@agent-vm/secret-management';

import { resolveConfiguredCliEnvironment } from '../runner/configured-cli-environment.js';
import { projectConfiguredCliBufferedOutput } from '../runner/configured-cli-output.js';
import { ConfiguredControllerExecutionError } from '../runner/configured-controller-execution-error.js';
import {
	CredentialedRuntimeCredentialRoot,
	materializeCredentialFiles,
	resolveCredentialEnvironment,
} from './credential-file-materializer.js';
import type { CredentialedRuntimeDynamicHttpMediation } from './credentialed-runtime-manager.js';
import type { CredentialedRuntimeResolution } from './credentialed-runtime-registry.js';

const credentialedRuntimeResources = {
	cpuCount: 2,
	memory: '2G',
} as const;

export async function createUnstartedCredentialedManagedVm(props: {
	readonly dynamicHttpMediation?: CredentialedRuntimeDynamicHttpMediation | undefined;
	readonly managedVmFactory: ManagedVmFactory;
	readonly resolution: CredentialedRuntimeResolution;
	readonly secretResolver: SecretResolver;
	readonly sessionLabel: string;
}): Promise<{
	readonly commandEnvironment: Readonly<Record<string, string>>;
	readonly vm: ManagedVm;
}> {
	const target = props.resolution.operation.executionTarget;
	if (target.kind !== 'ephemeral_managed_vm') {
		throw new ConfiguredControllerExecutionError(
			'validation_failed',
			'Credentialed runtime operation is not a Managed VM target.',
		);
	}
	const preparedImage = decodeConfiguredCliPreparedImageIdentity(target.imageReference);
	const ordinaryEnvironment = resolveConfiguredCliEnvironment(target.environment);
	const projection = props.resolution.projection;
	let commandEnvironment: Readonly<Record<string, string>>;
	let mediatedSecrets: readonly ManagedVmMediatedSecretDescriptor[];
	if (projection.kind === 'file_binding') {
		if (props.dynamicHttpMediation !== undefined) {
			throw new Error('File-backed credentialed runtimes reject dynamic HTTP mediation.');
		}
		commandEnvironment = resolveCredentialEnvironment(props.resolution);
		mediatedSecrets = [];
	} else if (projection.kind === 'http_mediation') {
		if (props.dynamicHttpMediation !== undefined) {
			throw new Error('Static credentialed runtimes reject dynamic HTTP mediation.');
		}
		const resolved = await props.secretResolver.resolveAll(
			Object.fromEntries(
				Object.entries(projection.environment).map(([environmentName, source]) => [
					environmentName,
					source.secret,
				]),
			),
		);
		const environment: Record<string, string> = {};
		mediatedSecrets = Object.entries(projection.environment).map(
			([environmentVariable, source]): ManagedVmMediatedSecretDescriptor => {
				const value = resolved[environmentVariable];
				if (value === undefined) {
					throw new Error('Credentialed runtime mediated credential resolution failed.');
				}
				const guestPlaceholder = `GONDOLIN_SECRET_${randomBytes(24).toString('hex')}`;
				environment[environmentVariable] = guestPlaceholder;
				return {
					allowedHosts: source.hosts,
					environmentVariable,
					guestPlaceholder,
					value,
				};
			},
		);
		commandEnvironment = Object.freeze(environment);
	} else {
		const dynamicMediation = props.dynamicHttpMediation;
		if (
			dynamicMediation !== undefined &&
			dynamicMediation.environmentName !== projection.environmentName
		) {
			throw new Error('OAuth credentialed runtime mediation material is unavailable.');
		}
		if (dynamicMediation === undefined) {
			commandEnvironment = Object.freeze({});
			mediatedSecrets = [];
			return {
				commandEnvironment,
				vm: await props.managedVmFactory.createManagedVm({
					allowedHosts: target.allowedHosts,
					environment: ordinaryEnvironment,
					imageReference: preparedImage.imageReference,
					mediatedSecrets,
					mounts: {},
					resources: credentialedRuntimeResources,
					rootfsMode: 'cow',
					sessionLabel: props.sessionLabel,
					tcpHosts: [],
				}),
			};
		}
		const targetAllowedHosts = new Set(target.allowedHosts);
		if (dynamicMediation.allowedHosts.some((host) => !targetAllowedHosts.has(host))) {
			throw new Error(
				'OAuth mediation material includes a host outside the runtime egress policy.',
			);
		}
		commandEnvironment = Object.freeze({
			[projection.environmentName]: dynamicMediation.placeholderValue,
		});
		mediatedSecrets = [
			{
				allowedHosts: dynamicMediation.allowedHosts,
				environmentVariable: projection.environmentName,
				guestPlaceholder: dynamicMediation.placeholderValue,
				value: new TextDecoder('utf-8', { fatal: true }).decode(dynamicMediation.secretValue),
			},
		];
	}
	const vm = await props.managedVmFactory.createManagedVm({
		allowedHosts: target.allowedHosts,
		environment: { ...ordinaryEnvironment, ...commandEnvironment },
		imageReference: preparedImage.imageReference,
		mediatedSecrets,
		mounts:
			projection.kind === 'file_binding'
				? {
						[CredentialedRuntimeCredentialRoot]: {
							access: 'read-only',
							kind: 'finalizable-memory',
						},
					}
				: {},
		resources: credentialedRuntimeResources,
		rootfsMode: 'cow',
		sessionLabel: props.sessionLabel,
		tcpHosts: [],
	});
	return { commandEnvironment, vm };
}

export async function finalizeCredentialedManagedVm(props: {
	readonly resolution: CredentialedRuntimeResolution;
	readonly secretResolver: SecretResolver;
	readonly vm: ManagedVm;
}): Promise<void> {
	if (props.resolution.projection.kind !== 'file_binding') return;
	await materializeCredentialFiles(props);
}

export interface CredentialedManagedVmCommandResult {
	readonly exitCode: number;
	readonly stderrSummary?: string;
	readonly stderrTruncated: boolean;
	readonly stdout: string;
	readonly stdoutTruncated: boolean;
}

export async function executeCredentialedManagedVmCommand(props: {
	readonly input: ControllerConfiguredCliInput;
	readonly commandEnvironment: Readonly<Record<string, string>>;
	readonly resolution: CredentialedRuntimeResolution;
	readonly signal?: AbortSignal;
	readonly vm: ManagedVm;
}): Promise<CredentialedManagedVmCommandResult> {
	const operation = props.resolution.operation;
	const target = operation.executionTarget;
	if (target.kind !== 'ephemeral_managed_vm') {
		throw new ConfiguredControllerExecutionError(
			'validation_failed',
			'Credentialed runtime operation is not a Managed VM target.',
		);
	}
	const timeout = resolveConfiguredCliTimeout({
		input: props.input,
		kind: operation.timeout.kind,
	});
	const commandTimeout = new AbortController();
	const commandTimer = setTimeout(
		() =>
			commandTimeout.abort(
				new ConfiguredControllerExecutionError(
					'timeout',
					'Configured Managed VM execution timed out.',
				),
			),
		timeout.resolvedTimeoutMs,
	);
	const executionSignal =
		props.signal === undefined
			? commandTimeout.signal
			: AbortSignal.any([commandTimeout.signal, props.signal]);
	try {
		if (executionSignal.aborted) {
			throw executionSignal.reason instanceof Error
				? executionSignal.reason
				: new ConfiguredControllerExecutionError(
						'not_dispatched',
						'Configured Managed VM execution was cancelled before guest process creation.',
					);
		}
		const process = props.vm.exec(
			[operation.executablePath, ...operation.mandatoryArgvPrefix, ...props.input.argv],
			{
				cwd: target.guestCwd,
				env: {
					...resolveConfiguredCliEnvironment(target.environment),
					...props.commandEnvironment,
				},
				output: {
					stderr: { kind: 'pipe' },
					stdout: { kind: 'pipe' },
					windowBytes: Math.max(operation.output.stderrMaxBytes, operation.output.stdoutMaxBytes),
				},
				pty: false,
				signal: executionSignal,
				...(props.input.stdin === undefined ? {} : { stdin: props.input.stdin }),
			},
		);
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;
		const drainOutput = async (): Promise<void> => {
			for await (const chunk of process.output()) {
				const chunks = chunk.stream === 'stdout' ? stdoutChunks : stderrChunks;
				const currentBytes = chunk.stream === 'stdout' ? stdoutBytes : stderrBytes;
				const maximumBytes =
					chunk.stream === 'stdout'
						? operation.output.stdoutMaxBytes
						: operation.output.stderrMaxBytes;
				const retainedBytes = Math.max(0, maximumBytes + 1 - currentBytes);
				if (retainedBytes > 0) {
					chunks.push(Buffer.from(chunk.data).subarray(0, retainedBytes));
				}
				if (chunk.stream === 'stdout') stdoutBytes += chunk.data.byteLength;
				else stderrBytes += chunk.data.byteLength;
			}
		};
		const [execution] = await Promise.all([process.result, drainOutput()]);
		return projectConfiguredCliBufferedOutput({
			exitCode: execution.exitCode,
			output: operation.output,
			stderr: Buffer.concat(stderrChunks),
			stdout: Buffer.concat(stdoutChunks),
		});
	} catch (error) {
		if (executionSignal.aborted) {
			throw executionSignal.reason instanceof ConfiguredControllerExecutionError
				? executionSignal.reason
				: new ConfiguredControllerExecutionError(
						'cancelled',
						'Configured Managed VM execution was cancelled.',
					);
		}
		throw error;
	} finally {
		clearTimeout(commandTimer);
	}
}
