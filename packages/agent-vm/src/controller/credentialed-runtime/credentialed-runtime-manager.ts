import { createHash, randomUUID } from 'node:crypto';

import type { ControllerConfiguredCliInput } from '@agent-vm/config-contracts';
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
	type CredentialedRuntimeRecordWriter,
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

export interface CredentialedRuntimeDynamicHttpMediation {
	readonly allowedHosts: readonly string[];
	readonly credentialId: string;
	readonly environmentName: string;
	readonly kind: 'dynamic_http_mediation';
	readonly materialRevision: string;
	readonly placeholderValue: string;
	readonly secretValue: Uint8Array;
}

export interface CredentialedRuntimeMaterialization {
	readonly dynamicHttpMediation?: CredentialedRuntimeDynamicHttpMediation | undefined;
	readonly resolution: CredentialedRuntimeResolution;
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
		input: ControllerConfiguredCliInput,
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
	readonly commandEnvironment: Readonly<Record<string, string>>;
	readonly createdAtMs: number;
	readonly identity: CredentialedRuntimeProcessIdentity;
	lastUsedAtMs: number;
	readonly ownerIdentity: CredentialedRuntimeOwnerIdentity;
	readonly recordId: string;
	readonly resolution: CredentialedRuntimeResolution;
	retireAfterActiveReason?: string;
	readonly vm: ManagedVm;
}

function runtimeKey(props: { readonly agentId: string; readonly zoneId: string }): string {
	return [props.zoneId, props.agentId].join('\0');
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

function processIdentitiesEqual(
	left: ProcessIdentity,
	right: CredentialedRuntimeProcessIdentity,
): boolean {
	return left.command === right.command && left.lstart === right.processStartIdentity;
}

export interface CredentialedRuntimeManager {
	acquireCommand(
		request: {
			readonly admissionSignal?: AbortSignal;
			readonly finalAuthorization: () => Promise<boolean>;
			readonly operationId: string;
			readonly ownerIdentity: CredentialedRuntimeOwnerIdentity;
		} & (
			| { readonly resolution: CredentialedRuntimeResolution }
			| {
					readonly materializeResolution: () => Promise<CredentialedRuntimeMaterialization>;
					readonly runtimeIdentity: { readonly agentId: string; readonly zoneId: string };
			  }
		),
	): Promise<AcquireCredentialedRuntimeCommandResult>;
	closeZone(zoneId: string): Promise<void>;
	openZone(zoneId: string): void;
	reapExpired(): Promise<void>;
	recoverZone(zoneId: string): Promise<void>;
	retire(request: {
		readonly agentId: string;
		readonly force: boolean;
		readonly zoneId: string;
	}): Promise<RetireCredentialedRuntimeResult>;
}

export function createCredentialedRuntimeManager(props: {
	readonly controllerStateDir: string;
	readonly exactProcessTermination: ManagedVmExactProcessTerminationCapability;
	readonly managedVmFactory: ManagedVmFactory;
	readonly now?: () => number;
	readonly readProcessIdentity: (hostProcessId: number) => Promise<ProcessIdentity | null>;
	readonly recordWriter?: CredentialedRuntimeRecordWriter;
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
	const reservedAcquisitionKeys = new Set<string>();
	const liveByKey = new Map<string, LiveCredentialedRuntime>();
	const ownerUnsafeKeys = new Set<string>();
	const closedZoneIds = new Set<string>();
	const runtimeKeysByZoneId = new Map<string, Set<string>>();
	const recordWriter =
		props.recordWriter ??
		createCredentialedRuntimeRecordWriter({ controllerStateDir: props.controllerStateDir });
	const registerRuntimeKeyForZone = (zoneId: string, key: string): void => {
		let zoneKeys = runtimeKeysByZoneId.get(zoneId);
		if (zoneKeys === undefined) {
			zoneKeys = new Set<string>();
			runtimeKeysByZoneId.set(zoneId, zoneKeys);
		}
		zoneKeys.add(key);
	};

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
		try {
			await recordWriter.write(context, ({ common, generation }) => ({
				...common,
				generation,
				identity: live.identity,
				kind: 'retiring',
				reason,
				updatedAtMs: now(),
				vmId: live.vm.id,
			}));
		} catch {
			// Exact containment must still run while the live VM handle and process identity are owned.
		}
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
			liveByKey.delete(key);
			try {
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
			} catch {
				ownerUnsafeKeys.add(key);
				return false;
			}
			return true;
		} catch {
			liveByKey.delete(key);
			ownerUnsafeKeys.add(key);
			try {
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
			} catch {
				// The in-memory owner-unsafe fence remains authoritative for this controller lifetime.
			}
			return false;
		}
	};

	const containUnstartedCreation = async (propsForContainment: {
		readonly context: RuntimeRecordContext;
		readonly vm: ManagedVm;
	}): Promise<boolean> => {
		try {
			await propsForContainment.vm.close();
		} catch {
			try {
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
			} catch {
				// The caller installs the in-memory owner-unsafe fence when durable evidence also fails.
			}
			return false;
		}
		try {
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
			// The VM is closed, but failed durable cleanup must fence this key until recovery.
			return false;
		}
	};

	const acquireCommand: CredentialedRuntimeManager['acquireCommand'] = async (request) => {
		const requestedRuntimeIdentity =
			'resolution' in request ? request.resolution : request.runtimeIdentity;
		const key = runtimeKey(requestedRuntimeIdentity);
		const admissionInvalidated = (): boolean =>
			request.admissionSignal?.aborted === true ||
			closedZoneIds.has(requestedRuntimeIdentity.zoneId);
		if (admissionInvalidated()) {
			return { kind: 'not-dispatched', reason: 'credentialed runtime zone is stopping' };
		}
		if (reservedAcquisitionKeys.has(key) || liveByKey.get(key)?.activeCommand !== undefined) {
			return { kind: 'busy', retryable: true };
		}
		reservedAcquisitionKeys.add(key);
		registerRuntimeKeyForZone(requestedRuntimeIdentity.zoneId, key);
		try {
			return await locks.runExclusive(key, async () => {
				if (admissionInvalidated()) {
					return { kind: 'not-dispatched', reason: 'credentialed runtime zone is stopping' };
				}
				if (ownerUnsafeKeys.has(key)) {
					return { kind: 'owner-unsafe', reason: 'credentialed runtime ownership is unsafe' };
				}
				let materialization: CredentialedRuntimeMaterialization;
				try {
					materialization =
						'resolution' in request
							? { resolution: request.resolution }
							: await request.materializeResolution();
				} catch {
					return {
						kind: 'not-dispatched',
						reason: 'credentialed runtime materialization failed',
					};
				}
				const { resolution } = materialization;
				if (
					resolution.agentId !== requestedRuntimeIdentity.agentId ||
					resolution.zoneId !== requestedRuntimeIdentity.zoneId
				) {
					return {
						kind: 'not-dispatched',
						reason: 'credentialed runtime materialization changed its owner',
					};
				}
				let live = liveByKey.get(key);
				if (live?.activeCommand !== undefined) {
					if (
						live.resolution.agentRuntimeRevision !== resolution.agentRuntimeRevision ||
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
				if (live !== undefined) {
					let currentProcessIdentity: ProcessIdentity | null = null;
					try {
						currentProcessIdentity = await props.readProcessIdentity(live.identity.hostProcessId);
					} catch {
						currentProcessIdentity = null;
					}
					if (
						currentProcessIdentity === null ||
						!processIdentitiesEqual(currentProcessIdentity, live.identity)
					) {
						const contained = await retireLiveUnderLock(
							key,
							live,
							'credentialed runtime process identity is no longer current',
						);
						if (!contained) {
							return { kind: 'owner-unsafe', reason: 'credentialed runtime health is unsafe' };
						}
						live = undefined;
					}
				}
				if (
					live !== undefined &&
					(live.resolution.agentRuntimeRevision !== resolution.agentRuntimeRevision ||
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
						resolution,
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
					let commandEnvironment: Readonly<Record<string, string>>;
					try {
						let created: Awaited<ReturnType<typeof createUnstartedCredentialedManagedVm>>;
						try {
							created = await createUnstartedCredentialedManagedVm({
								...(materialization.dynamicHttpMediation === undefined
									? {}
									: { dynamicHttpMediation: materialization.dynamicHttpMediation }),
								managedVmFactory: props.managedVmFactory,
								resolution,
								secretResolver: props.secretResolver,
								sessionLabel: `credentialed-runtime-${randomUUID()}`,
							});
						} finally {
							materialization.dynamicHttpMediation?.secretValue.fill(0);
						}
						vm = created.vm;
						commandEnvironment = created.commandEnvironment;
					} catch {
						await recordWriter.delete(resolution.zoneId, recordId);
						return { kind: 'not-dispatched', reason: 'credentialed runtime creation failed' };
					}
					try {
						await recordWriter.write(context, ({ common, generation }) => ({
							...common,
							generation,
							kind: 'vm-created',
							updatedAtMs: now(),
							vmId: vm.id,
						}));
					} catch {
						const contained = await containUnstartedCreation({ context, vm });
						if (!contained) ownerUnsafeKeys.add(key);
						return contained
							? { kind: 'not-dispatched', reason: 'credentialed runtime record failed' }
							: { kind: 'owner-unsafe', reason: 'credentialed runtime record is unsafe' };
					}
					try {
						await finalizeCredentialedManagedVm({
							resolution,
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
					let processIdentity: ProcessIdentity | null = null;
					if (hostProcessId !== null) {
						try {
							processIdentity = await props.readProcessIdentity(hostProcessId);
						} catch {
							processIdentity = null;
						}
					}
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
					const createdLive: LiveCredentialedRuntime = {
						commandEnvironment,
						createdAtMs: now(),
						identity,
						lastUsedAtMs: now(),
						ownerIdentity: request.ownerIdentity,
						recordId,
						resolution,
						vm,
					};
					try {
						await recordWriter.write(context, ({ common, generation }) => ({
							...common,
							generation,
							identity,
							kind: 'identity-published',
							updatedAtMs: now(),
							vmId: vm.id,
						}));
					} catch {
						const contained = await retireLiveUnderLock(
							key,
							createdLive,
							'credentialed runtime identity publication failed',
						);
						return contained
							? { kind: 'not-dispatched', reason: 'credentialed runtime record failed' }
							: { kind: 'owner-unsafe', reason: 'credentialed runtime record is unsafe' };
					}
					let finalAuthorized = false;
					if (!admissionInvalidated()) {
						try {
							finalAuthorized = (await request.finalAuthorization()) && !admissionInvalidated();
						} catch {
							finalAuthorized = false;
						}
					}
					live = createdLive;
					liveByKey.set(key, live);
					if (!finalAuthorized) {
						const contained = await retireLiveUnderLock(key, live, 'final authorization changed');
						return contained
							? { kind: 'not-dispatched', reason: 'credentialed runtime authority changed' }
							: { kind: 'owner-unsafe', reason: 'stale runtime containment failed' };
					}
				} else {
					let finalAuthorized = false;
					if (!admissionInvalidated()) {
						try {
							finalAuthorized = (await request.finalAuthorization()) && !admissionInvalidated();
						} catch {
							finalAuthorized = false;
						}
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
				const context = {
					ownerIdentity: live.ownerIdentity,
					recordId: live.recordId,
					resolution: live.resolution,
				};
				live.activeCommand = activeCommand;
				try {
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
				} catch {
					delete live.activeCommand;
					activeCommand.resolveFinished();
					const contained = await retireLiveUnderLock(
						key,
						live,
						'credentialed runtime active publication failed',
					);
					return contained
						? { kind: 'not-dispatched', reason: 'credentialed runtime record failed' }
						: { kind: 'owner-unsafe', reason: 'credentialed runtime record is unsafe' };
				}
				if (admissionInvalidated()) {
					delete live.activeCommand;
					activeCommand.resolveFinished();
					const contained = await retireLiveUnderLock(
						key,
						live,
						'credentialed runtime admission invalidated during active publication',
					);
					return contained
						? { kind: 'not-dispatched', reason: 'credentialed runtime authority changed' }
						: { kind: 'owner-unsafe', reason: 'stale runtime containment failed' };
				}

				let completed = false;
				const commandResolution = resolution;
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
								try {
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
								} catch {
									await retireLiveUnderLock(
										key,
										current,
										'credentialed runtime idle publication failed',
									);
								}
							});
						},
						exec: async (input, options = {}) =>
							await executeCredentialedManagedVmCommand({
								commandEnvironment: live.commandEnvironment,
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
		} finally {
			reservedAcquisitionKeys.delete(key);
		}
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
			closedZoneIds.add(zoneId);
			const keys = [...(runtimeKeysByZoneId.get(zoneId) ?? [])];
			let containmentOwnerUnsafe = false;
			for (const key of keys) {
				// oxlint-disable-next-line no-await-in-loop -- the zone fence drains each known key deterministically
				const active = await locks.runExclusive(key, async () => {
					const live = liveByKey.get(key);
					if (live?.activeCommand === undefined) return undefined;
					live.retireAfterActiveReason = 'zone closed';
					live.activeCommand.abortController.abort(new Error('Credentialed runtime zone closed.'));
					return live.activeCommand;
				});
				if (active !== undefined) {
					// oxlint-disable-next-line no-await-in-loop -- completion releases the key before exact containment
					await active.finished;
				}
				// oxlint-disable-next-line no-await-in-loop -- zone close containment is deliberately sequential
				const contained = await locks.runExclusive(key, async () => {
					if (ownerUnsafeKeys.has(key)) return false;
					const current = liveByKey.get(key);
					return current === undefined
						? true
						: await retireLiveUnderLock(key, current, 'zone closed');
				});
				if (!contained) {
					containmentOwnerUnsafe = true;
				}
			}
			if (containmentOwnerUnsafe) {
				throw new Error(`Credentialed runtime zone '${zoneId}' containment is owner-unsafe.`);
			}
		},
		openZone: (zoneId): void => {
			closedZoneIds.delete(zoneId);
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
				const key = runtimeKey(unsafeIdentity);
				ownerUnsafeKeys.add(key);
				registerRuntimeKeyForZone(zoneId, key);
			}
		},
		retire,
	};
}
