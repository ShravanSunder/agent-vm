import type {
	GatewayZoneCleanupFailure,
	GatewayZoneCleanupFailureStage,
	GatewayZoneDestroyResult,
} from './gateway-zone-support.js';

export interface GatewayZoneCleanupPhase {
	readonly cleanup: () => Promise<void>;
	readonly stage: GatewayZoneCleanupFailureStage;
}

export interface CreateGatewayZoneDestructionTransactionOptions {
	readonly destroyExactGateway: () => Promise<void>;
	readonly gatewayLabel: string;
	readonly postDestructionCleanup: readonly GatewayZoneCleanupPhase[];
	readonly withdrawAdmission: readonly GatewayZoneCleanupPhase[];
}

export interface GatewayZoneDestructionTransaction {
	destroyGateway(): Promise<GatewayZoneDestroyResult>;
}

function assertUniqueCleanupStages(
	phases: readonly GatewayZoneCleanupPhase[],
): readonly GatewayZoneCleanupPhase[] {
	const observedStages = new Set<GatewayZoneCleanupFailureStage>();
	for (const phase of phases) {
		if (observedStages.has(phase.stage)) {
			throw new Error(`Gateway cleanup stage '${phase.stage}' must be unique.`);
		}
		observedStages.add(phase.stage);
	}
	return phases;
}

async function runIncompleteCleanupPhases(options: {
	readonly completedStages: ReadonlySet<GatewayZoneCleanupFailureStage>;
	readonly markCompleted: (stage: GatewayZoneCleanupFailureStage) => void;
	readonly phases: readonly GatewayZoneCleanupPhase[];
}): Promise<readonly GatewayZoneCleanupFailure[]> {
	const failures: GatewayZoneCleanupFailure[] = [];
	for (const phase of options.phases) {
		if (options.completedStages.has(phase.stage)) continue;
		try {
			// oxlint-disable-next-line no-await-in-loop -- lifecycle phases have a required order.
			await phase.cleanup();
			options.markCompleted(phase.stage);
		} catch (error: unknown) {
			failures.push({ error, stage: phase.stage });
		}
	}
	return failures;
}

export function createGatewayZoneDestructionTransaction(
	options: CreateGatewayZoneDestructionTransactionOptions,
): GatewayZoneDestructionTransaction {
	const withdrawalPhases = assertUniqueCleanupStages(options.withdrawAdmission);
	const postDestructionPhases = assertUniqueCleanupStages(options.postDestructionCleanup);
	const allStages = [...withdrawalPhases, ...postDestructionPhases];
	assertUniqueCleanupStages(allStages);

	const completedStages = new Set<GatewayZoneCleanupFailureStage>();
	let exactDestructionCompleted = false;
	let exactDestructionFailure: unknown;
	let finalResult: GatewayZoneDestroyResult | undefined;
	let inFlightAttempt: Promise<GatewayZoneDestroyResult> | undefined;

	const runAttempt = async (): Promise<GatewayZoneDestroyResult> => {
		const withdrawalFailures = await runIncompleteCleanupPhases({
			completedStages,
			markCompleted: (stage) => completedStages.add(stage),
			phases: withdrawalPhases,
		});

		if (!exactDestructionCompleted) {
			try {
				await options.destroyExactGateway();
				exactDestructionCompleted = true;
			} catch (error: unknown) {
				exactDestructionFailure =
					withdrawalFailures.length === 0
						? error
						: new AggregateError(
								[...withdrawalFailures.map((failure) => failure.error), error],
								`${options.gatewayLabel} admission withdrawal and exact destruction did not complete.`,
								{ cause: error },
							);
				throw exactDestructionFailure;
			}
		}

		const postDestructionFailures = await runIncompleteCleanupPhases({
			completedStages,
			markCompleted: (stage) => completedStages.add(stage),
			phases: postDestructionPhases,
		});
		const cleanupFailures = [...withdrawalFailures, ...postDestructionFailures];
		const [firstCleanupFailure, ...remainingCleanupFailures] = cleanupFailures;
		if (firstCleanupFailure !== undefined) {
			return {
				cleanupFailures: [firstCleanupFailure, ...remainingCleanupFailures],
				kind: 'destroyed-cleanup-incomplete',
			};
		}

		finalResult = { kind: 'destroyed-clean' };
		return finalResult;
	};

	return {
		destroyGateway(): Promise<GatewayZoneDestroyResult> {
			if (finalResult !== undefined) return Promise.resolve(finalResult);
			if (exactDestructionFailure !== undefined) {
				return Promise.reject(exactDestructionFailure);
			}
			if (inFlightAttempt !== undefined) return inFlightAttempt;

			const attempt = runAttempt();
			const trackedAttempt = attempt.finally(() => {
				if (inFlightAttempt === trackedAttempt) inFlightAttempt = undefined;
			});
			inFlightAttempt = trackedAttempt;
			return trackedAttempt;
		},
	};
}
