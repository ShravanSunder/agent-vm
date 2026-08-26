import { createHash, randomUUID } from 'node:crypto';

import type { ConfiguredCliInput } from '@agent-vm/config-contracts';
import type {
	ManagedVm,
	ManagedVmExactProcessTerminationCapability,
	ManagedVmFactory,
} from '@agent-vm/managed-vm';
import type { SecretResolver } from '@agent-vm/secret-management';

import { terminateLiveManagedVm } from '../../shared/controller-managed-vm-termination.js';
import type { ProcessIdentity } from '../../shared/managed-vm-process.js';
import {
	createUnstartedCredentialedManagedVm,
	executeCredentialedManagedVmCommand,
	finalizeCredentialedManagedVm,
	type CredentialedManagedVmCommandResult,
} from './credentialed-managed-vm.js';
import {
	createCredentialedRuntimeRecordWriter,
	type RuntimeRecordContext,
} from './credentialed-runtime-record-writer.js';
import {
	containCredentialedRuntimeRecords,
	type CredentialedRuntimeProcessIdentity,
} from './credentialed-runtime-record.js';
import type { CredentialedRuntimeResolution } from './credentialed-runtime-registry.js';
import { createKeyedAsyncLock } from './keyed-async-lock.js';

export const CredentialedRuntimeIdleTtlMs = 15 * 60 * 1000;

export interface CredentialedRuntimeOwnerIdentity {
	readonly controllerEpoch: string;
	readonly gatewayEpoch: string;
	readonly parentGatewayVmId: string;
	readonly runtimeEpoch: string;
	readonly stablePrincipal: string;
}

export type AcquireCredentialedRuntimeCommandResult =
	| { readonly command: CredentialedRuntimeCommandHandle; readonly kind: 'acquired' }
	| { readonly kind: 'busy'; readonly retryable: true }
	| { readonly kind: 'not-dispatched'; readonly reason: string }
	| { readonly kind: 'owner-unsafe'; readonly reason: string };

export type CredentialedRuntimeCommandOutcome =
	| { readonly kind: 'completed' }
	| { readonly kind: 'retire'; readonly reason: string };

export interface CredentialedRuntimeCommandHandle {
	complete(outcome: CredentialedRuntimeCommandOutcome): Promise<void>;
	exec(
		input: ConfiguredCliInput,
		options?: { readonly signal?: AbortSignal },
	): Promise<CredentialedManagedVmCommandResult>;
}

export type RetireCredentialedRuntimeResult =
	| { readonly kind: 'retired' }
	| { readonly kind: 'absent' }
	| { readonly kind: 'active'; readonly retryable: true }
	| { readonly kind: 'owner-unsafe'; readonly retryable: false };

interface ActiveCommand {
	readonly abortController: AbortController;
	readonly finished: Promise<void>;
	readonly operationId: string;
	readonly resolveFinished: () => void;
	readonly startedAtMs: number;
}

interface LiveCredentialedRuntime {
	activeCommand?: ActiveCommand;
	readonly createdAtMs: number;
	readonly identity: CredentialedRuntimeProcessIdentity;
	lastUsedAtMs: number;
	readonly ownerIdentity: CredentialedRuntimeOwnerIdentity;
	readonly recordId: string;
	readonly resolution: CredentialedRuntimeResolution;
	retireAfterActiveReason?: string;
	readonly vm: ManagedVm;
}

function runtimeKey(props: {
	readonly agentId: string;
	readonly runtimeId: string;
	readonly zoneId: string;
}): string {
	return [props.zoneId, props.agentId, props.runtimeId].join('\0');
}

function runtimeRecordId(key: string): string {
	return `credentialed-${createHash('sha256').update(key).digest('hex')}`;
}

function ownerIdentitiesEqual(
	left: CredentialedRuntimeOwnerIdentity,
	right: CredentialedRuntimeOwnerIdentity,
): boolean {
	return (
		left.controllerEpoch === right.controllerEpoch &&
		left.gatewayEpoch === right.gatewayEpoch &&
		left.parentGatewayVmId === right.parentGatewayVmId &&
		left.runtimeEpoch === right.runtimeEpoch &&
		left.stablePrincipal === right.stablePrincipal
	);
}

export interface CredentialedRuntimeManager {
	acquireCommand(request: {
		readonly finalAuthorization: () => Promise<boolean>;
		readonly operationId: string;
		readonly ownerIdentity: CredentialedRuntimeOwnerIdentity;
		readonly resolution: CredentialedRuntimeResolution;
	}): Promise<AcquireCredentialedRuntimeCommandResult>;
	closeZone(zoneId: string): Promise<void>;
	reapExpired(): Promise<void>;
	recoverZone(zoneId: string): Promise<void>;
	retire(request: {
		readonly agentId: string;
		readonly force: boolean;
		readonly runtimeId: string;
		readonly zoneId: string;
	}): Promise<RetireCredentialedRuntimeResult>;
}

export function createCredentialedRuntimeManager(props: {
	readonly controllerStateDir: string;
	readonly exactProcessTermination: ManagedVmExactProcessTerminationCapability;
	readonly managedVmFactory: ManagedVmFactory;
	readonly now?: () => number;
	readonly readProcessIdentity: (hostProcessId: number) => Promise<ProcessIdentity | null>;
	readonly secretResolver: SecretResolver;
	readonly sleep?: (delayMs: number) => Promise<void>;
}): CredentialedRuntimeManager {
	const now = props.now ?? Date.now;
	const sleep =
		props.sleep ??
		(async (delayMs: number): Promise<void> => {
			await new Promise<void>((resolve) => {
				setTimeout(resolve, delayMs);
			});
		});
	const locks = createKeyedAsyncLock();
	const liveByKey = new Map<string, LiveCredentialedRuntime>();
	const ownerUnsafeKeys = new Set<string>();
	const recordWriter = createCredentialedRuntimeRecordWriter({
		controllerStateDir: props.controllerStateDir,
	});

	const retireLiveUnderLock = async (
		key: string,
		live: LiveCredentialedRuntime,
		reason: string,
	): Promise<boolean> => {
		const context = {
			ownerIdentity: live.ownerIdentity,
			recordId: live.recordId,
			resolution: live.resolution,
		};
		await recordWriter.write(context, ({ common, generation }) => ({
			...common,
			generation,
			identity: live.identity,
			kind: 'retiring',
			reason,
			updatedAtMs: now(),
			vmId: live.vm.id,
		}));
		try {
			await terminateLiveManagedVm({
				exactProcessTermination: props.exactProcessTermination,
				sleep,
				target: {
					hostPid: live.identity.hostProcessId,
					processIdentity: {
						command: live.identity.command,
						lstart: live.identity.processStartIdentity,
					},
					vmId: live.identity.vmId,
				},
				vm: live.vm,
			});
			await recordWriter.write(context, ({ common, generation }) => ({
				...common,
				containment: 'proven',
				generation,
				identity: live.identity,
				kind: 'contained-terminal',
				updatedAtMs: now(),
				vmId: live.vm.id,
			}));
			await recordWriter.delete(live.resolution.zoneId, live.recordId);
			liveByKey.delete(key);
			return true;
		} catch {
			await recordWriter.write(context, ({ common, generation }) => ({
				...common,
				containment: 'unproven',
				generation,
				identity: live.identity,
				kind: 'owner-unsafe',
				reason: 'exact credentialed runtime termination could not be proven',
				updatedAtMs: now(),
				vmId: live.vm.id,
			}));
			liveByKey.delete(key);
			ownerUnsafeKeys.add(key);
			return false;
		}
	};

	const containUnstartedCreation = async (propsForContainment: {
		readonly context: RuntimeRecordContext;
		readonly vm: ManagedVm;
	}): Promise<boolean> => {
		try {
			await propsForContainment.vm.close();
			await recordWriter.write(propsForContainment.context, ({ common, generation }) => ({
				...common,
				containment: 'proven',
				generation,
				identity: null,
				kind: 'contained-terminal',
				updatedAtMs: now(),
				vmId: propsForContainment.vm.id,
			}));
			await recordWriter.delete(
				propsForContainment.context.resolution.zoneId,
				propsForContainment.context.recordId,
			);
			return true;
		} catch {
			await recordWriter.write(propsForContainment.context, ({ common, generation }) => ({
				...common,
				containment: 'unproven',
				generation,
				identity: null,
				kind: 'owner-unsafe',
				reason: 'unstarted credentialed runtime containment could not be proven',
				updatedAtMs: now(),
				vmId: propsForContainment.vm.id,
			}));
			return false;
		}
	};

	const acquireCommand: CredentialedRuntimeManager['acquireCommand'] = async (request) => {
		const key = runtimeKey(request.resolution);
		return await locks.runExclusive(key, async () => {
			if (ownerUnsafeKeys.has(key)) {
				return { kind: 'owner-unsafe', reason: 'credentialed runtime ownership is unsafe' };
			}
			let live = liveByKey.get(key);
			if (live?.activeCommand !== undefined) {
				if (
					live.resolution.groupRevision !== request.resolution.groupRevision ||
					!ownerIdentitiesEqual(live.ownerIdentity, request.ownerIdentity)
				) {
					live.retireAfterActiveReason = 'runtime compatibility changed while active';
					return {
						kind: 'not-dispatched',
						reason: 'active credentialed runtime is no longer compatible',
					};
				}
				return { kind: 'busy', retryable: true };
			}
			if (
				live !== undefined &&
				(live.resolution.groupRevision !== request.resolution.groupRevision ||
					!ownerIdentitiesEqual(live.ownerIdentity, request.ownerIdentity) ||
					now() - live.lastUsedAtMs >= CredentialedRuntimeIdleTtlMs)
			) {
				const contained = await retireLiveUnderLock(
					key,
					live,
					'runtime incompatible or idle-expired',
				);
				if (!contained) {
					return { kind: 'owner-unsafe', reason: 'credentialed runtime retirement failed' };
				}
				live = undefined;
			}

			if (live === undefined) {
				const recordId = runtimeRecordId(key);
				const context = {
					ownerIdentity: request.ownerIdentity,
					recordId,
					resolution: request.resolution,
				};
				await recordWriter.write(context, ({ common, generation }) => ({
					...common,
					generation,
					kind: 'reserved',
					updatedAtMs: now(),
				}));
				await recordWriter.write(context, ({ common, generation }) => ({
					...common,
					generation,
					kind: 'creation-started',
					updatedAtMs: now(),
				}));
				let vm: ManagedVm;
				try {
					vm = await createUnstartedCredentialedManagedVm({
						managedVmFactory: props.managedVmFactory,
						resolution: request.resolution,
						sessionLabel: `credentialed-runtime-${randomUUID()}`,
					});
				} catch {
					await recordWriter.delete(request.resolution.zoneId, recordId);
					return { kind: 'not-dispatched', reason: 'credentialed runtime creation failed' };
				}
				await recordWriter.write(context, ({ common, generation }) => ({
					...common,
					generation,
					kind: 'vm-created',
					updatedAtMs: now(),
					vmId: vm.id,
				}));
				try {
					await finalizeCredentialedManagedVm({
						resolution: request.resolution,
						secretResolver: props.secretResolver,
						vm,
					});
					await vm.start();
				} catch {
					const contained = await containUnstartedCreation({ context, vm });
					if (!contained) ownerUnsafeKeys.add(key);
					return contained
						? { kind: 'not-dispatched', reason: 'credentialed runtime setup failed' }
						: { kind: 'owner-unsafe', reason: 'credentialed runtime setup containment failed' };
				}
				const hostProcessId = vm.getHostProcessId();
				const processIdentity =
					hostProcessId === null ? null : await props.readProcessIdentity(hostProcessId);
				if (hostProcessId === null || processIdentity === null) {
					const contained = await containUnstartedCreation({ context, vm });
					if (!contained) ownerUnsafeKeys.add(key);
					return contained
						? { kind: 'not-dispatched', reason: 'credentialed runtime identity unavailable' }
						: { kind: 'owner-unsafe', reason: 'credentialed runtime identity is unsafe' };
				}
				const identity = {
					command: processIdentity.command,
					hostProcessId,
					processStartIdentity: processIdentity.lstart,
					vmId: vm.id,
				};
				await recordWriter.write(context, ({ common, generation }) => ({
					...common,
					generation,
					identity,
					kind: 'identity-published',
					updatedAtMs: now(),
					vmId: vm.id,
				}));
				let finalAuthorized = false;
				try {
					finalAuthorized = await request.finalAuthorization();
				} catch {
					finalAuthorized = false;
				}
				live = {
					createdAtMs: now(),
					identity,
					lastUsedAtMs: now(),
					ownerIdentity: request.ownerIdentity,
					recordId,
					resolution: request.resolution,
					vm,
				};
				liveByKey.set(key, live);
				if (!finalAuthorized) {
					const contained = await retireLiveUnderLock(key, live, 'final authorization changed');
					return contained
						? { kind: 'not-dispatched', reason: 'credentialed runtime authority changed' }
						: { kind: 'owner-unsafe', reason: 'stale runtime containment failed' };
				}
			} else {
				let finalAuthorized = false;
				try {
					finalAuthorized = await request.finalAuthorization();
				} catch {
					finalAuthorized = false;
				}
				if (!finalAuthorized) {
					return { kind: 'not-dispatched', reason: 'credentialed runtime authority changed' };
				}
			}

			let resolveFinished: (() => void) | undefined;
			const finished = new Promise<void>((resolve) => {
				resolveFinished = resolve;
			});
			const activeCommand: ActiveCommand = {
				abortController: new AbortController(),
				finished,
				operationId: request.operationId,
				resolveFinished: () => resolveFinished?.(),
				startedAtMs: now(),
			};
			live.activeCommand = activeCommand;
			const context = {
				ownerIdentity: live.ownerIdentity,
				recordId: live.recordId,
				resolution: live.resolution,
			};
			await recordWriter.write(context, ({ common, generation }) => ({
				...common,
				activeOperationId: request.operationId,
				generation,
				identity: live.identity,
				kind: 'current-active',
				startedAtMs: activeCommand.startedAtMs,
				updatedAtMs: now(),
				vmId: live.vm.id,
			}));

			let completed = false;
			const commandResolution = request.resolution;
			return {
				command: {
					complete: async (outcome): Promise<void> => {
						if (completed) return;
						completed = true;
						await locks.runExclusive(key, async () => {
							const current = liveByKey.get(key);
							if (
								current === undefined ||
								current.activeCommand?.operationId !== request.operationId
							) {
								activeCommand.resolveFinished();
								return;
							}
							delete current.activeCommand;
							activeCommand.resolveFinished();
							const retirementReason =
								outcome.kind === 'retire' ? outcome.reason : current.retireAfterActiveReason;
							if (retirementReason !== undefined) {
								await retireLiveUnderLock(key, current, retirementReason);
								return;
							}
							current.lastUsedAtMs = now();
							await recordWriter.write(context, ({ common, generation }) => ({
								...common,
								generation,
								identity: current.identity,
								idleExpiresAtMs: current.lastUsedAtMs + CredentialedRuntimeIdleTtlMs,
								kind: 'current-idle',
								lastUsedAtMs: current.lastUsedAtMs,
								updatedAtMs: now(),
								vmId: current.vm.id,
							}));
						});
					},
					exec: async (input, options = {}) =>
						await executeCredentialedManagedVmCommand({
							input,
							resolution: commandResolution,
							signal:
								options.signal === undefined
									? activeCommand.abortController.signal
									: AbortSignal.any([activeCommand.abortController.signal, options.signal]),
							vm: live.vm,
						}),
				},
				kind: 'acquired',
			};
		});
	};

	const retire: CredentialedRuntimeManager['retire'] = async (request) => {
		const key = runtimeKey(request);
		let active: ActiveCommand | undefined;
		const first = await locks.runExclusive(key, async () => {
			if (ownerUnsafeKeys.has(key)) return { kind: 'owner-unsafe' as const };
			const live = liveByKey.get(key);
			if (live === undefined) return { kind: 'absent' as const };
			if (live.activeCommand !== undefined) {
				if (!request.force) return { kind: 'active' as const };
				active = live.activeCommand;
				live.retireAfterActiveReason = 'operator force retirement';
				live.activeCommand.abortController.abort(
					new Error('Credentialed runtime was force-retired by an operator.'),
				);
				return { kind: 'wait-active' as const };
			}
			return (await retireLiveUnderLock(key, live, 'operator retirement'))
				? { kind: 'retired' as const }
				: { kind: 'owner-unsafe' as const };
		});
		if (first.kind === 'active') return { kind: 'active', retryable: true };
		if (first.kind === 'owner-unsafe') return { kind: 'owner-unsafe', retryable: false };
		if (first.kind !== 'wait-active') return first;
		await active?.finished;
		return await locks.runExclusive(key, async () => {
			if (ownerUnsafeKeys.has(key)) return { kind: 'owner-unsafe', retryable: false };
			const live = liveByKey.get(key);
			if (live === undefined) return { kind: 'retired' };
			return (await retireLiveUnderLock(key, live, 'operator force retirement'))
				? { kind: 'retired' }
				: { kind: 'owner-unsafe', retryable: false };
		});
	};

	return {
		acquireCommand,
		closeZone: async (zoneId): Promise<void> => {
			const keys = [...liveByKey.entries()]
				.filter(([, live]) => live.resolution.zoneId === zoneId)
				.map(([key]) => key);
			for (const key of keys) {
				const live = liveByKey.get(key);
				if (live?.activeCommand !== undefined) {
					live.retireAfterActiveReason = 'zone closed';
					live.activeCommand.abortController.abort(new Error('Credentialed runtime zone closed.'));
					// oxlint-disable-next-line no-await-in-loop -- zone close must contain runtimes sequentially
					await live.activeCommand.finished;
				}
				// oxlint-disable-next-line no-await-in-loop -- zone close containment is sequential
				await locks.runExclusive(key, async () => {
					const current = liveByKey.get(key);
					if (current !== undefined) await retireLiveUnderLock(key, current, 'zone closed');
				});
			}
		},
		reapExpired: async (): Promise<void> => {
			const cutoff = now() - CredentialedRuntimeIdleTtlMs;
			const candidates = [...liveByKey.entries()]
				.filter(([, live]) => live.activeCommand === undefined && live.lastUsedAtMs <= cutoff)
				.map(([key]) => key);
			for (const key of candidates) {
				// oxlint-disable-next-line no-await-in-loop -- retirement containment is deliberately sequential
				await locks.runExclusive(key, async () => {
					const live = liveByKey.get(key);
					if (
						live !== undefined &&
						live.activeCommand === undefined &&
						live.lastUsedAtMs <= cutoff
					) {
						await retireLiveUnderLock(key, live, 'idle timeout');
					}
				});
			}
		},
		recoverZone: async (zoneId): Promise<void> => {
			for (const unsafeIdentity of await containCredentialedRuntimeRecords({
				exactProcessTermination: props.exactProcessTermination,
				now,
				recordsDirectoryPath: recordWriter.recordsDirectoryPath(zoneId),
			})) {
				ownerUnsafeKeys.add(runtimeKey(unsafeIdentity));
			}
		},
		retire,
	};
}
