import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import type {
	ManagedVm,
	ManagedVmExactProcessTerminationCapability,
	ManagedVmFactory,
	ManagedVmOwnedDirectoryCapability,
	OwnedHostDirectory,
} from '@agent-vm/managed-vm';
import type { SecretResolver } from '@agent-vm/secret-management';

import { terminateLiveManagedVm } from '../../shared/controller-managed-vm-termination.js';
import type { ProcessIdentity } from '../../shared/managed-vm-process.js';
import type { OperationFileRetentionBudget } from '../files/operation-file-retention-budget.js';
import { OperationFolderAccessError } from '../files/operation-folder-guest-access.js';
import type { SharedStagingDirectoryStore } from '../files/shared-staging-directory-store.js';
import { ConfiguredControllerExecutionError } from '../runner/configured-controller-execution-error.js';
import {
	createUnstartedCredentialedManagedVm,
	executeCredentialedManagedVmCommand,
	finalizeCredentialedManagedVm,
} from './credentialed-managed-vm.js';
import type {
	CredentialedRuntimeOwnerIdentity,
	CredentialedRuntimeMaterialization,
	InvalidateCredentialedRuntimeMaterialResult,
	CredentialedRuntimeManager,
} from './credentialed-runtime-manager-contracts.js';
import {
	runtimeMaterialMatchesInvalidation,
	type CredentialedRuntimeOAuthAuthorization,
} from './credentialed-runtime-material-scope.js';
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
import { createSharedStagingOperationSession } from './shared-staging-operation-session.js';
export type {
	CredentialedRuntimeOwnerIdentity,
	CredentialedRuntimeDynamicHttpMediation,
	CredentialedRuntimeMaterialization,
	AcquireCredentialedRuntimeCommandResult,
	CredentialedRuntimeCommandOutcome,
	CredentialedRuntimeCommandHandle,
	RetireCredentialedRuntimeResult,
	InvalidateCredentialedRuntimeMaterialResult,
	CredentialedRuntimeManager,
} from './credentialed-runtime-manager-contracts.js';

export const CredentialedRuntimeIdleTtlMs = 15 * 60 * 1000;

interface ActiveCommand {
	readonly abortController: AbortController;
	readonly finished: Promise<void>;
	readonly operationId: string;
	readonly resolveFinished: () => void;
	readonly startedAtMs: number;
}

interface LiveCredentialedRuntime {
	readonly staging:
		| { readonly store: SharedStagingDirectoryStore; readonly producerId: string }
		| undefined;
	readonly oauthAuthorization: CredentialedRuntimeOAuthAuthorization | undefined;
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

export function createCredentialedRuntimeManager(props: {
	readonly sharedStaging?: {
		readonly getStore: (zoneId: string, agentId: string) => Promise<SharedStagingDirectoryStore>;
		readonly ownedDirectories: ManagedVmOwnedDirectoryCapability;
	};
	readonly retentionBudget: OperationFileRetentionBudget;
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
			if (live.staging !== undefined)
				await live.staging.store.retireProducer(live.staging.producerId);
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
		const materializationFailureReason =
			'materializeResolution' in request ? request.materializationFailureReason : undefined;
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
				} catch (error) {
					let reason = 'credentialed runtime materialization failed';
					try {
						reason = materializationFailureReason?.(error) ?? reason;
					} catch {
						// A failure classifier cannot weaken the generic safe fallback.
					}
					return {
						kind: 'not-dispatched',
						reason,
					};
				}
				try {
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
							!isDeepStrictEqual(
								live.oauthAuthorization,
								materialization.dynamicHttpMediation?.authorization,
							) ||
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
						let staging: LiveCredentialedRuntime['staging'];
						let producerDirectory: OwnedHostDirectory | undefined;
						try {
							if (props.sharedStaging !== undefined) {
								const store = await props.sharedStaging.getStore(
									resolution.zoneId,
									resolution.agentId,
								);
								const producerId = randomUUID();
								const hostRoot = await store.prepareProducerRoot(producerId);
								producerDirectory =
									props.sharedStaging.ownedDirectories.openHostDirectory(hostRoot);
								staging = { store, producerId };
							}
							const created = await createUnstartedCredentialedManagedVm({
								...(producerDirectory === undefined ? {} : { producerDirectory }),
								...(materialization.dynamicHttpMediation === undefined
									? {}
									: { dynamicHttpMediation: materialization.dynamicHttpMediation }),
								managedVmFactory: props.managedVmFactory,
								resolution,
								secretResolver: props.secretResolver,
								sessionLabel: `credentialed-runtime-${randomUUID()}`,
							});
							vm = created.vm;
							commandEnvironment = created.commandEnvironment;
						} catch {
							await recordWriter.delete(resolution.zoneId, recordId);
							return { kind: 'not-dispatched', reason: 'credentialed runtime creation failed' };
						} finally {
							if (producerDirectory?.state === 'acquired') producerDirectory.close();
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
							staging,
							oauthAuthorization:
								materialization.dynamicHttpMediation?.authorization === undefined
									? undefined
									: structuredClone(materialization.dynamicHttpMediation.authorization),
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
						if (finalAuthorized && request.finalMaterialAuthorization !== undefined) {
							try {
								finalAuthorized = request.finalMaterialAuthorization() && !admissionInvalidated();
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
						if (finalAuthorized && request.finalMaterialAuthorization !== undefined) {
							try {
								finalAuthorized = request.finalMaterialAuthorization() && !admissionInvalidated();
							} catch {
								finalAuthorized = false;
							}
						}
						if (!finalAuthorized) {
							const contained = await retireLiveUnderLock(key, live, 'final authorization changed');
							return contained
								? { kind: 'not-dispatched', reason: 'credentialed runtime authority changed' }
								: { kind: 'owner-unsafe', reason: 'stale runtime containment failed' };
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
					let folderPrepared = false;
					let folderFailed = false;
					let folderReady = false;
					let operationCwd: string | undefined;
					let folderStaging = false;
					let commandStarted = false;
					let commandFinished = false;
					const commandResolution = resolution;
					return {
						command: {
							prepareSharedStagingOperation: async ({ maximumBytes, authorityIsCurrent }) => {
								if (completed || commandStarted || folderPrepared || live.staging === undefined)
									throw new OperationFolderAccessError('unavailable');
								folderPrepared = true;
								const folder = await createSharedStagingOperationSession({
									store: live.staging.store,
									producerId: live.staging.producerId,
									operationId: request.operationId,
									maximumBytes,
									authorityIsCurrent,
									signal: activeCommand.abortController.signal,
								});
								folderReady = true;
								operationCwd = folder.root;
								return {
									root: folder.root,
									stageInput: async (relativePath, contents, expected) => {
										if (commandStarted || completed || folderFailed || folderStaging)
											throw new OperationFolderAccessError('unavailable');
										folderStaging = true;
										try {
											await folder.stageInput(relativePath, contents, expected);
										} catch (error) {
											folderFailed = true;
											throw error;
										} finally {
											folderStaging = false;
										}
									},
									publish: async (publication) => {
										if (!commandFinished || completed)
											throw new OperationFolderAccessError('unavailable');
										return await folder.publish(publication);
									},
								};
							},
							complete: async (outcome): Promise<void> => {
								if (completed) return;
								completed = true;
								try {
									await locks.runExclusive(key, async () => {
										const current = liveByKey.get(key);
										if (
											current === undefined ||
											current.activeCommand?.operationId !== request.operationId
										) {
											return;
										}
										delete current.activeCommand;
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
								} finally {
									activeCommand.resolveFinished();
								}
							},
							exec: async (input, options = {}) => {
								if (
									completed ||
									commandStarted ||
									folderFailed ||
									folderStaging ||
									(folderPrepared && !folderReady) ||
									admissionInvalidated() ||
									live.retireAfterActiveReason !== undefined ||
									request.finalMaterialAuthorization?.() === false
								)
									throw new ConfiguredControllerExecutionError(
										'not_dispatched',
										'Credentialed command authority is no longer current.',
									);
								commandStarted = true;
								const result = await executeCredentialedManagedVmCommand({
									commandEnvironment: live.commandEnvironment,
									...(operationCwd === undefined ? {} : { operationCwd }),
									input,
									resolution: commandResolution,
									signal:
										options.signal === undefined
											? activeCommand.abortController.signal
											: AbortSignal.any([activeCommand.abortController.signal, options.signal]),
									vm: live.vm,
								});
								commandFinished = true;
								return result;
							},
						},
						kind: 'acquired',
					};
				} finally {
					materialization.dynamicHttpMediation?.secretValue.fill(0);
				}
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
		invalidateMaterial: async (request): Promise<InvalidateCredentialedRuntimeMaterialResult> => {
			const key = runtimeKey(request);
			const matches = (live: LiveCredentialedRuntime): boolean =>
				runtimeMaterialMatchesInvalidation({
					scope: request.scope,
					authorization: live.oauthAuthorization,
					isOAuthRuntime: live.resolution.projection.kind === 'oauth_http_mediation',
				});
			let active: ActiveCommand | undefined;
			const first = await locks.runExclusive(key, async () => {
				if (ownerUnsafeKeys.has(key)) return { kind: 'owner-unsafe' as const };
				const live = liveByKey.get(key);
				if (live === undefined) return { kind: 'absent' as const };
				if (!matches(live)) return { kind: 'absent' as const };
				if (live.activeCommand !== undefined) {
					active = live.activeCommand;
					live.retireAfterActiveReason = request.reason;
					return { kind: 'wait-active' as const };
				}
				return (await retireLiveUnderLock(key, live, request.reason))
					? { kind: 'retired' as const }
					: { kind: 'owner-unsafe' as const };
			});
			if (first.kind !== 'wait-active') return first;
			if (active === undefined) {
				throw new Error('Credentialed runtime invalidation lost its active command identity.');
			}
			await active.finished;
			return await locks.runExclusive(key, async () => {
				if (ownerUnsafeKeys.has(key)) return { kind: 'owner-unsafe' };
				const live = liveByKey.get(key);
				if (live === undefined) return { kind: 'retired' };
				if (!matches(live)) return { kind: 'absent' };
				return (await retireLiveUnderLock(key, live, request.reason))
					? { kind: 'retired' }
					: { kind: 'owner-unsafe' };
			});
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
		recoverZone: async (zoneId): Promise<{ readonly kind: 'contained' | 'owner-unsafe' }> => {
			for (const unsafeIdentity of await containCredentialedRuntimeRecords({
				exactProcessTermination: props.exactProcessTermination,
				now,
				recordsDirectoryPath: recordWriter.recordsDirectoryPath(zoneId),
			})) {
				const key = runtimeKey(unsafeIdentity);
				ownerUnsafeKeys.add(key);
				registerRuntimeKeyForZone(zoneId, key);
			}
			return {
				kind: [...(runtimeKeysByZoneId.get(zoneId) ?? [])].some((key) => ownerUnsafeKeys.has(key))
					? 'owner-unsafe'
					: 'contained',
			};
		},
		retire,
	};
}
