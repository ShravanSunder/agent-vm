import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import type { VmOwnershipDeploymentIdentity } from '../controller/vm-ownership/vm-ownership-contracts.js';
import {
	createVmOwnershipJournal,
	type GatewayMembershipRecord,
} from '../controller/vm-ownership/vm-ownership-journal.js';

const TEST_DEPLOYMENT_IDENTITY = {
	configPath: '/deployments/sunfam/config/system.jsonc',
	controllerPort: 18_800,
	projectNamespace: 'sunfam-test-deployment',
} satisfies VmOwnershipDeploymentIdentity;

interface JournalWorkerSuccess {
	readonly record: GatewayMembershipRecord;
	readonly status: 'success';
}

interface JournalWorkerFailure {
	readonly errorCode: string;
	readonly errorMessage: string;
	readonly status: 'failure';
}

type JournalWorkerResult = JournalWorkerFailure | JournalWorkerSuccess;

interface JournalWorkerRunMessage {
	readonly action: 'create' | 'replace';
	readonly expectedRevision?: number;
	readonly lockAction?: 'hold';
	readonly record: GatewayMembershipRecord;
	readonly stateDirectory: string;
}

interface JournalWorkerOperationCompletion {
	readonly exitCode?: number | null;
	readonly exitSignal?: NodeJS.Signals | null;
	readonly result?: JournalWorkerResult;
	readonly status: 'exit' | 'result';
}

interface JournalWorkerLockOperation {
	readonly completion: Promise<JournalWorkerOperationCompletion>;
	readonly lockAcquired: Promise<void>;
	readonly releaseLock: () => void;
	readonly terminateLockOwner: () => void;
}

interface JournalWorker {
	readonly ready: Promise<void>;
	readonly startLockOperation: (message: JournalWorkerRunMessage) => JournalWorkerLockOperation;
	readonly run: (message: JournalWorkerRunMessage) => Promise<JournalWorkerResult>;
}

const repositoryRoot = path.resolve(import.meta.dirname, '../../../..');
const journalModuleUrl = pathToFileURL(
	path.resolve(import.meta.dirname, '../controller/vm-ownership/vm-ownership-journal.ts'),
).href;
const temporaryDirectories: string[] = [];
const activeWorkers = new Set<ReturnType<typeof spawn>>();

const journalWorkerProgram = String.raw`
const journalModuleUrl = process.argv[1];
const { createVmOwnershipJournal } = await import(journalModuleUrl);

function send(message, callback) {
  if (process.send === undefined) {
    throw new Error('Journal worker requires an IPC channel.');
  }
  process.send(message, callback);
}

function errorField(error, fieldName, fallback) {
  return typeof error === 'object' && error !== null && fieldName in error
    ? String(error[fieldName])
    : fallback;
}

process.once('message', async (message) => {
  const journalOptions = {
    nowMs: () => message.record.updatedAtMs,
    stateDirectory: message.stateDirectory,
    ...(message.lockAction === undefined ? {} : {
      onCrossProcessLockAcquired: async () => {
        await new Promise((resolve, reject) => {
          send({ status: 'lock-acquired' }, (error) => {
            if (error !== null) {
              reject(error);
              return;
            }
            process.once('message', (releaseMessage) => {
              if (releaseMessage?.type !== 'release-lock') {
                reject(new Error('Journal worker received an invalid lock-release message.'));
                return;
              }
              resolve();
            });
          });
        });
      },
    }),
  };
  const journal = createVmOwnershipJournal(journalOptions);
  try {
    const record = message.action === 'create'
      ? await journal.createGatewayMembership(message.record)
      : await journal.replaceGatewayMembership({
          expectedRevision: message.expectedRevision,
          record: message.record,
        });
    send({ record, status: 'success' });
  } catch (error) {
    send({
      errorCode: errorField(error, 'code', 'unknown'),
      errorMessage: errorField(error, 'message', String(error)),
      status: 'failure',
    });
  } finally {
    process.disconnect();
  }
});

send({ status: 'ready' });
`;

afterEach(async () => {
	for (const worker of activeWorkers) {
		worker.kill();
	}
	activeWorkers.clear();
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((temporaryDirectory) => rm(temporaryDirectory, { force: true, recursive: true })),
	);
});

async function createTemporaryStateDirectory(): Promise<string> {
	const stateDirectory = await mkdtemp(
		path.join(tmpdir(), 'agent-vm-ownership-journal-concurrency-'),
	);
	temporaryDirectories.push(stateDirectory);
	return stateDirectory;
}

function createMembershipRecord(options: {
	readonly gatewayEpochId: string;
	readonly reservationPath: string;
	readonly state?: GatewayMembershipRecord['state'];
}): GatewayMembershipRecord {
	const controllerEpoch = 'controller-epoch-concurrency';
	const gatewayVmId = `vm-${options.gatewayEpochId}`;
	const zoneId = 'sunfam';
	return {
		children: [],
		controllerEpoch,
		createdAtMs: 1_720_000_000_000,
		gateway: {
			bootId: `boot-${options.gatewayEpochId}`,
			controllerEpoch,
			gatewayEpochId: options.gatewayEpochId,
			gatewayVmId,
			generationId: `generation-${options.gatewayEpochId}`,
			zoneId,
		},
		gatewayReservation: {
			controllerEpoch,
			expectedRevision: 1,
			parentGateway: null,
			principal: { ...TEST_DEPLOYMENT_IDENTITY, kind: 'gateway-zone', zoneId },
			reservationId: `reservation-${options.gatewayEpochId}`,
			reservationPath: options.reservationPath,
			role: 'gateway',
			sessionLabel: `gateway:${options.gatewayEpochId}`,
			vmId: gatewayVmId,
		},
		revision: 1,
		schemaVersion: 1,
		state: options.state ?? 'admitting',
		updatedAtMs: 1_720_000_000_000,
	};
}

function isReadyMessage(message: unknown): boolean {
	return (
		typeof message === 'object' &&
		message !== null &&
		'status' in message &&
		message.status === 'ready'
	);
}

function isLockAcquiredMessage(message: unknown): boolean {
	return (
		typeof message === 'object' &&
		message !== null &&
		'status' in message &&
		message.status === 'lock-acquired'
	);
}

function isJournalWorkerResult(message: unknown): message is JournalWorkerResult {
	return (
		typeof message === 'object' &&
		message !== null &&
		'status' in message &&
		(message.status === 'success' || message.status === 'failure')
	);
}

function spawnJournalWorker(): JournalWorker {
	const child = spawn(
		process.execPath,
		['--import', 'tsx', '--input-type=module', '--eval', journalWorkerProgram, journalModuleUrl],
		{
			cwd: repositoryRoot,
			stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
		},
	);
	activeWorkers.add(child);
	child.once('exit', () => activeWorkers.delete(child));

	let stderr = '';
	child.stderr?.setEncoding('utf8');
	child.stderr?.on('data', (chunk: string) => {
		stderr += chunk;
	});

	const ready = new Promise<void>((resolve, reject) => {
		const handleMessage = (message: unknown): void => {
			if (isReadyMessage(message)) {
				child.off('message', handleMessage);
				child.off('error', reject);
				child.off('exit', handlePrematureExit);
				resolve();
			}
		};
		const handlePrematureExit = (exitCode: number | null): void => {
			child.off('message', handleMessage);
			reject(
				new Error(
					`Journal worker exited before its ready barrier (code=${String(exitCode)}): ${stderr}`,
				),
			);
		};
		child.on('message', handleMessage);
		child.once('error', reject);
		child.once('exit', handlePrematureExit);
	});

	return {
		ready,
		startLockOperation: (message): JournalWorkerLockOperation => {
			let lockAcquired = false;
			let resolveLockAcquired: (() => void) | undefined;
			let rejectLockAcquired: ((error: Error) => void) | undefined;
			const lockAcquiredPromise = new Promise<void>((resolve, reject) => {
				resolveLockAcquired = resolve;
				rejectLockAcquired = reject;
			});
			const completion = new Promise<JournalWorkerOperationCompletion>((resolve, reject) => {
				const cleanup = (): void => {
					child.off('message', handleMessage);
					child.off('error', handleError);
					child.off('exit', handleExit);
				};
				const handleError = (error: Error): void => {
					cleanup();
					rejectLockAcquired?.(error);
					reject(error);
				};
				const handleExit = (exitCode: number | null, exitSignal: NodeJS.Signals | null): void => {
					cleanup();
					if (!lockAcquired) {
						rejectLockAcquired?.(
							new Error(
								`Journal operation exited before acquiring its cross-process lock (code=${String(exitCode)}): ${stderr}`,
							),
						);
					}
					resolve({ exitCode, exitSignal, status: 'exit' });
				};
				const handleMessage = (candidate: unknown): void => {
					if (isLockAcquiredMessage(candidate)) {
						lockAcquired = true;
						resolveLockAcquired?.();
						return;
					}
					if (isJournalWorkerResult(candidate)) {
						cleanup();
						if (!lockAcquired) {
							rejectLockAcquired?.(
								new Error(
									`Journal operation returned before acquiring its cross-process lock: ${JSON.stringify(candidate)}`,
								),
							);
						}
						resolve({ result: candidate, status: 'result' });
					}
				};
				child.on('message', handleMessage);
				child.once('error', handleError);
				child.once('exit', handleExit);
				child.send(message);
			});
			return {
				completion,
				lockAcquired: lockAcquiredPromise,
				releaseLock: (): void => {
					child.send({ type: 'release-lock' });
				},
				terminateLockOwner: (): void => {
					child.kill('SIGKILL');
				},
			};
		},
		run: async (message): Promise<JournalWorkerResult> => {
			return await new Promise<JournalWorkerResult>((resolve, reject) => {
				const handleMessage = (candidate: unknown): void => {
					if (isJournalWorkerResult(candidate)) {
						child.off('message', handleMessage);
						child.off('error', reject);
						child.off('exit', handlePrematureExit);
						resolve(candidate);
					}
				};
				const handlePrematureExit = (exitCode: number | null): void => {
					child.off('message', handleMessage);
					reject(
						new Error(
							`Journal worker exited before returning a result (code=${String(exitCode)}): ${stderr}`,
						),
					);
				};
				child.on('message', handleMessage);
				child.once('error', reject);
				child.once('exit', handlePrematureExit);
				child.send(message);
			});
		},
	};
}

function createInspectionJournal(
	stateDirectory: string,
): ReturnType<typeof createVmOwnershipJournal> {
	return createVmOwnershipJournal({
		nowMs: () => 1_720_000_000_000,
		onCrossProcessLockAcquired: async (): Promise<void> => {},
		stateDirectory,
	});
}

function requireOperationResult(completion: JournalWorkerOperationCompletion): JournalWorkerResult {
	if (completion.status !== 'result' || completion.result === undefined) {
		throw new Error(`Expected journal worker result, received ${JSON.stringify(completion)}`);
	}
	return completion.result;
}

describe('VM ownership journal cross-process concurrency', () => {
	it('refuses a same-zone Gateway contender while another process holds the journal lock', async () => {
		// Arrange
		const stateDirectory = await createTemporaryStateDirectory();
		const inspectionJournal = createInspectionJournal(stateDirectory);
		await inspectionJournal.ensureStorage();
		const ownerRecord = createMembershipRecord({
			gatewayEpochId: 'gateway-epoch-owner',
			reservationPath: inspectionJournal.reservationPathFor('reservation-gateway-epoch-owner'),
		});
		const contenderRecord = createMembershipRecord({
			gatewayEpochId: 'gateway-epoch-contender',
			reservationPath: inspectionJournal.reservationPathFor('reservation-gateway-epoch-contender'),
		});
		const ownerWorker = spawnJournalWorker();
		const contenderWorker = spawnJournalWorker();
		await Promise.all([ownerWorker.ready, contenderWorker.ready]);

		// Act
		const ownerOperation = ownerWorker.startLockOperation({
			action: 'create',
			lockAction: 'hold',
			record: ownerRecord,
			stateDirectory,
		});
		await ownerOperation.lockAcquired;
		const contenderResult = await contenderWorker.run({
			action: 'create',
			record: contenderRecord,
			stateDirectory,
		});

		// Assert while the owner remains paused inside the cross-process lock.
		expect(contenderResult).toMatchObject({
			errorCode: 'membership-lock-conflict',
			status: 'failure',
		});

		// Act / Assert after releasing the lock owner.
		ownerOperation.releaseLock();
		const ownerResult = requireOperationResult(await ownerOperation.completion);
		expect(ownerResult).toEqual({ record: ownerRecord, status: 'success' });
		await expect(inspectionJournal.loadAllGatewayMemberships()).resolves.toEqual([ownerRecord]);
	});

	it('refuses a same-revision replacement contender while another process holds the journal lock', async () => {
		// Arrange
		const stateDirectory = await createTemporaryStateDirectory();
		const inspectionJournal = createInspectionJournal(stateDirectory);
		const initialRecord = createMembershipRecord({
			gatewayEpochId: 'gateway-epoch-replace',
			reservationPath: inspectionJournal.reservationPathFor('reservation-gateway-epoch-replace'),
		});
		await inspectionJournal.createGatewayMembership(initialRecord);
		const ownerReplacement = {
			...initialRecord,
			revision: 2,
			state: 'sealed' as const,
			updatedAtMs: 1_720_000_000_001,
		} satisfies GatewayMembershipRecord;
		const contenderReplacement = {
			...initialRecord,
			revision: 2,
			state: 'owner-unsafe' as const,
			updatedAtMs: 1_720_000_000_002,
		} satisfies GatewayMembershipRecord;
		const ownerWorker = spawnJournalWorker();
		const contenderWorker = spawnJournalWorker();
		await Promise.all([ownerWorker.ready, contenderWorker.ready]);

		// Act
		const ownerOperation = ownerWorker.startLockOperation({
			action: 'replace',
			expectedRevision: initialRecord.revision,
			lockAction: 'hold',
			record: ownerReplacement,
			stateDirectory,
		});
		await ownerOperation.lockAcquired;
		const contenderResult = await contenderWorker.run({
			action: 'replace',
			expectedRevision: initialRecord.revision,
			record: contenderReplacement,
			stateDirectory,
		});

		// Assert while the owner remains paused inside the cross-process lock.
		expect(contenderResult).toMatchObject({
			errorCode: 'membership-lock-conflict',
			status: 'failure',
		});

		// Act / Assert after releasing the lock owner.
		ownerOperation.releaseLock();
		const ownerResult = requireOperationResult(await ownerOperation.completion);
		expect(ownerResult).toEqual({ record: ownerReplacement, status: 'success' });
		await expect(
			inspectionJournal.loadGatewayMembership(initialRecord.gateway.gatewayEpochId),
		).resolves.toEqual(ownerReplacement);
	});

	it('releases the cross-process journal lock when its owner process crashes', async () => {
		// Arrange
		const stateDirectory = await createTemporaryStateDirectory();
		const inspectionJournal = createInspectionJournal(stateDirectory);
		const initialRecord = createMembershipRecord({
			gatewayEpochId: 'gateway-epoch-crash-release',
			reservationPath: inspectionJournal.reservationPathFor(
				'reservation-gateway-epoch-crash-release',
			),
		});
		await inspectionJournal.createGatewayMembership(initialRecord);
		const abandonedReplacement = {
			...initialRecord,
			revision: 2,
			state: 'sealed' as const,
			updatedAtMs: 1_720_000_000_003,
		} satisfies GatewayMembershipRecord;
		const recoveryReplacement = {
			...initialRecord,
			revision: 2,
			state: 'owner-unsafe' as const,
			updatedAtMs: 1_720_000_000_004,
		} satisfies GatewayMembershipRecord;
		const crashingWorker = spawnJournalWorker();
		await crashingWorker.ready;

		// Act: kill the owner while it is paused inside the acquired-lock callback.
		const crashingOperation = crashingWorker.startLockOperation({
			action: 'replace',
			expectedRevision: initialRecord.revision,
			lockAction: 'hold',
			record: abandonedReplacement,
			stateDirectory,
		});
		await crashingOperation.lockAcquired;
		crashingOperation.terminateLockOwner();
		await expect(crashingOperation.completion).resolves.toEqual({
			exitCode: null,
			exitSignal: 'SIGKILL',
			status: 'exit',
		});
		const recoveryWorker = spawnJournalWorker();
		await recoveryWorker.ready;
		const recoveryResult = await recoveryWorker.run({
			action: 'replace',
			expectedRevision: initialRecord.revision,
			record: recoveryReplacement,
			stateDirectory,
		});

		// Assert
		expect(recoveryResult).toEqual({ record: recoveryReplacement, status: 'success' });
		await expect(
			inspectionJournal.loadGatewayMembership(initialRecord.gateway.gatewayEpochId),
		).resolves.toEqual(recoveryReplacement);
	});
});
