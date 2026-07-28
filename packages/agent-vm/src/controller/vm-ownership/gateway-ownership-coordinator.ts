export {
	GatewayOwnershipCoordinatorError,
	type GatewayOwnershipCoordinatorErrorCode,
} from './gateway-ownership-errors.js';
import { GatewayOwnershipCoordinatorError } from './gateway-ownership-errors.js';
import {
	gatewayEpochIdentitySchema,
	gatewayEpochSeedSchema,
	gatewayIdentitiesEqual,
	stableAgentIdentitySchema,
	type GatewayEpochIdentity,
	type GatewayEpochSeed,
	type GatewayMembershipSnapshot,
	type GatewayMembershipState,
	type ToolVmMembershipSnapshot,
	type ToolVmMembershipState,
} from './vm-ownership-contracts.js';

interface ChildCompletion {
	readonly promise: Promise<boolean>;
	resolve(complete: boolean): void;
}

function createChildCompletion(): ChildCompletion {
	let resolvePromise: ((complete: boolean) => void) | undefined;
	const promise = new Promise<boolean>((resolve) => {
		resolvePromise = resolve;
	});
	let resolved = false;
	return {
		promise,
		resolve(complete): void {
			if (resolved) {
				return;
			}
			resolved = true;
			resolvePromise?.(complete);
		},
	};
}

interface MutableToolVmMembership {
	readonly agentId: string;
	completion: ChildCompletion;
	readonly leafId: string;
	state: ToolVmMembershipState;
	toolVmId?: string;
}

interface MutableGatewayMembership {
	readonly childrenByLeafId: Map<string, MutableToolVmMembership>;
	readonly leafIdByAgentId: Map<string, string>;
	readonly seed: GatewayEpochSeed;
	identity?: GatewayEpochIdentity;
	sealResult?: GatewaySealResult;
	state: GatewayMembershipState;
}

export interface GatewayEpochSeedHandle {
	readonly seed: GatewayEpochSeed;
	attachGatewayVm(gatewayVmId: string): GatewayEpochIdentity;
}

export interface ToolVmMembershipHandle {
	readonly agentId: string;
	readonly leafId: string;
	attachToolVm(toolVmId: string): void;
	beginDestroying(): void;
	commitCurrent(): void;
	recordAccessFenced(): void;
	recordDestroyed(): void;
	recordUnavailable(): void;
	snapshot(): ToolVmMembershipSnapshot;
}

export interface GatewaySealResult {
	readonly barrier: Promise<{
		readonly gatewayEpochId: string;
		readonly kind: 'children-destroyed';
	}>;
	readonly childLeafIds: readonly string[];
}

export interface GatewayOwnershipCoordinator {
	beginGatewayEpoch(options: {
		readonly bootId: string;
		readonly gatewayEpochId?: string;
		readonly generationId: string;
		readonly zoneId: string;
	}): GatewayEpochSeedHandle;
	abandonUnattachedGatewaySeed(expectedSeed: GatewayEpochSeed): void;
	admitProvisionalToolVm(options: {
		readonly agentId: string;
		readonly expectedGateway: GatewayEpochIdentity;
		readonly leafId: string;
	}): ToolVmMembershipHandle;
	recordGatewayDestroyUnavailable(expectedGateway: GatewayEpochIdentity): void;
	resolveGatewayEpoch(expected: GatewayEpochSeed): GatewayEpochIdentity;
	retireGateway(expectedGateway: GatewayEpochIdentity): Promise<void>;
	sealGatewayEpoch(expectedGateway: GatewayEpochIdentity): GatewaySealResult;
	snapshotGateway(expectedGateway: GatewayEpochIdentity): GatewayMembershipSnapshot;
}

interface CreateGatewayOwnershipCoordinatorOptions {
	readonly controllerEpoch: string;
	readonly createGatewayEpochId: () => string;
}

function requireBoundedIdentity(value: string, fieldName: string): string {
	const parsed = gatewayEpochIdentitySchema.shape.gatewayVmId.safeParse(value);
	if (!parsed.success) {
		throw new Error(`${fieldName} must be a bounded opaque identity.`);
	}
	return parsed.data;
}

function childSnapshot(child: MutableToolVmMembership): ToolVmMembershipSnapshot {
	return {
		agentId: child.agentId,
		leafId: child.leafId,
		state: child.state,
		...(child.toolVmId === undefined ? {} : { toolVmId: child.toolVmId }),
	};
}

function gatewaySnapshot(gateway: MutableGatewayMembership): GatewayMembershipSnapshot {
	return {
		children: [...gateway.childrenByLeafId.values()].map(childSnapshot),
		...(gateway.identity === undefined ? {} : { identity: structuredClone(gateway.identity) }),
		seed: structuredClone(gateway.seed),
		state: gateway.state,
	};
}

function clearCurrentLeafMapping(
	gateway: MutableGatewayMembership,
	child: MutableToolVmMembership,
): void {
	if (gateway.leafIdByAgentId.get(child.agentId) === child.leafId) {
		gateway.leafIdByAgentId.delete(child.agentId);
	}
}

function blockingSameAgentPredecessor(
	gateway: MutableGatewayMembership,
	child: MutableToolVmMembership,
): MutableToolVmMembership | undefined {
	return [...gateway.childrenByLeafId.values()].find(
		(candidate) =>
			candidate !== child &&
			candidate.agentId === child.agentId &&
			(candidate.state === 'destroying' || candidate.state === 'owner-unsafe'),
	);
}

export function createGatewayOwnershipCoordinator(
	options: CreateGatewayOwnershipCoordinatorOptions,
): GatewayOwnershipCoordinator {
	const currentGatewayByZone = new Map<string, MutableGatewayMembership>();

	const requireGatewayForSeed = (expected: GatewayEpochSeed): MutableGatewayMembership => {
		const parsedExpected = gatewayEpochSeedSchema.safeParse({
			bootId: expected.bootId,
			controllerEpoch: expected.controllerEpoch,
			gatewayEpochId: expected.gatewayEpochId,
			generationId: expected.generationId,
			zoneId: expected.zoneId,
		});
		if (!parsedExpected.success) {
			throw new GatewayOwnershipCoordinatorError('gateway-identity-mismatch');
		}
		const currentGateway = currentGatewayByZone.get(parsedExpected.data.zoneId);
		if (currentGateway === undefined) {
			throw new GatewayOwnershipCoordinatorError('gateway-not-current');
		}
		if (
			currentGateway.seed.bootId !== parsedExpected.data.bootId ||
			currentGateway.seed.controllerEpoch !== parsedExpected.data.controllerEpoch ||
			currentGateway.seed.gatewayEpochId !== parsedExpected.data.gatewayEpochId ||
			currentGateway.seed.generationId !== parsedExpected.data.generationId
		) {
			throw new GatewayOwnershipCoordinatorError('gateway-identity-mismatch');
		}
		return currentGateway;
	};

	const requireGateway = (expected: GatewayEpochIdentity): MutableGatewayMembership => {
		const parsedExpected = gatewayEpochIdentitySchema.safeParse(expected);
		if (!parsedExpected.success) {
			throw new GatewayOwnershipCoordinatorError('gateway-identity-mismatch');
		}
		const currentGateway = requireGatewayForSeed(parsedExpected.data);
		if (currentGateway.identity === undefined) {
			throw new GatewayOwnershipCoordinatorError('gateway-not-attached');
		}
		if (!gatewayIdentitiesEqual(currentGateway.identity, parsedExpected.data)) {
			throw new GatewayOwnershipCoordinatorError('gateway-identity-mismatch');
		}
		return currentGateway;
	};

	const requireOperationalGateway = (expected: GatewayEpochIdentity): MutableGatewayMembership => {
		const gateway = requireGateway(expected);
		if (gateway.state === 'owner-unsafe') {
			throw new GatewayOwnershipCoordinatorError('owner-unsafe');
		}
		return gateway;
	};

	return {
		abandonUnattachedGatewaySeed(expectedSeed): void {
			const gateway = requireGatewayForSeed(expectedSeed);
			if (gateway.identity !== undefined) {
				throw new GatewayOwnershipCoordinatorError('gateway-already-attached');
			}
			if (gateway.state !== 'seeded') {
				throw new GatewayOwnershipCoordinatorError('gateway-not-current');
			}
			gateway.state = 'retired';
		},

		beginGatewayEpoch(beginOptions): GatewayEpochSeedHandle {
			const existingGateway = currentGatewayByZone.get(beginOptions.zoneId);
			if (existingGateway !== undefined && existingGateway.state !== 'retired') {
				throw new GatewayOwnershipCoordinatorError(
					existingGateway.state === 'owner-unsafe' ? 'owner-unsafe' : 'gateway-already-current',
				);
			}
			const seed = gatewayEpochSeedSchema.parse({
				bootId: beginOptions.bootId,
				controllerEpoch: options.controllerEpoch,
				gatewayEpochId: beginOptions.gatewayEpochId ?? options.createGatewayEpochId(),
				generationId: beginOptions.generationId,
				zoneId: beginOptions.zoneId,
			});
			const gateway: MutableGatewayMembership = {
				childrenByLeafId: new Map(),
				leafIdByAgentId: new Map(),
				seed,
				state: 'seeded',
			};
			currentGatewayByZone.set(seed.zoneId, gateway);
			return {
				seed: structuredClone(seed),
				attachGatewayVm(gatewayVmId): GatewayEpochIdentity {
					if (gateway.identity !== undefined || gateway.state !== 'seeded') {
						throw new GatewayOwnershipCoordinatorError('gateway-already-attached');
					}
					const identity = gatewayEpochIdentitySchema.parse({
						...seed,
						gatewayVmId: requireBoundedIdentity(gatewayVmId, 'gatewayVmId'),
					});
					gateway.identity = identity;
					gateway.state = 'admitting';
					return structuredClone(identity);
				},
			};
		},

		admitProvisionalToolVm(admitOptions): ToolVmMembershipHandle {
			const gateway = requireOperationalGateway(admitOptions.expectedGateway);
			if (gateway.state === 'seeded') {
				throw new GatewayOwnershipCoordinatorError('gateway-not-attached');
			}
			if (gateway.state !== 'admitting') {
				throw new GatewayOwnershipCoordinatorError('gateway-not-admitting');
			}
			const agent = stableAgentIdentitySchema.parse({
				agentId: admitOptions.agentId,
				zoneId: admitOptions.expectedGateway.zoneId,
			});
			const leafId = requireBoundedIdentity(admitOptions.leafId, 'leafId');
			if (gateway.leafIdByAgentId.has(agent.agentId)) {
				throw new GatewayOwnershipCoordinatorError('agent-already-admitted');
			}
			if (
				[...gateway.childrenByLeafId.values()].some(
					(child) => child.agentId === agent.agentId && child.state === 'owner-unsafe',
				)
			) {
				throw new GatewayOwnershipCoordinatorError('owner-unsafe');
			}
			if (gateway.childrenByLeafId.has(leafId)) {
				throw new GatewayOwnershipCoordinatorError('leaf-already-admitted');
			}
			const child: MutableToolVmMembership = {
				agentId: agent.agentId,
				completion: createChildCompletion(),
				leafId,
				state: 'provisional',
			};
			gateway.childrenByLeafId.set(leafId, child);
			gateway.leafIdByAgentId.set(agent.agentId, leafId);

			const requireCurrentChild = (): MutableToolVmMembership => {
				const currentGateway = requireGateway(admitOptions.expectedGateway);
				const currentChild = currentGateway.childrenByLeafId.get(leafId);
				if (currentChild !== child) {
					throw new GatewayOwnershipCoordinatorError('child-identity-mismatch');
				}
				return currentChild;
			};

			return {
				agentId: agent.agentId,
				leafId,
				attachToolVm(toolVmId): void {
					const currentChild = requireCurrentChild();
					if (currentChild.toolVmId !== undefined) {
						throw new GatewayOwnershipCoordinatorError('child-vm-already-attached');
					}
					currentChild.toolVmId = requireBoundedIdentity(toolVmId, 'toolVmId');
				},
				beginDestroying(): void {
					const currentChild = requireCurrentChild();
					if (currentChild.state === 'retiring') {
						return;
					}
					if (currentChild.state === 'destroyed') {
						throw new GatewayOwnershipCoordinatorError('child-not-current');
					}
					if (currentChild.state === 'owner-unsafe') {
						currentChild.completion = createChildCompletion();
					}
					currentChild.state = 'destroying';
					clearCurrentLeafMapping(gateway, currentChild);
				},
				commitCurrent(): void {
					const currentGateway = requireOperationalGateway(admitOptions.expectedGateway);
					const currentChild = requireCurrentChild();
					if (currentGateway.state !== 'admitting') {
						throw new GatewayOwnershipCoordinatorError('gateway-not-admitting');
					}
					if (currentChild.toolVmId === undefined) {
						throw new GatewayOwnershipCoordinatorError('child-vm-not-attached');
					}
					if (currentChild.state !== 'provisional') {
						throw new GatewayOwnershipCoordinatorError('child-not-current');
					}
					const blockingPredecessor = blockingSameAgentPredecessor(currentGateway, currentChild);
					if (blockingPredecessor?.state === 'owner-unsafe') {
						throw new GatewayOwnershipCoordinatorError('owner-unsafe');
					}
					if (blockingPredecessor !== undefined) {
						throw new GatewayOwnershipCoordinatorError('agent-already-admitted');
					}
					currentChild.state = 'current';
				},
				recordAccessFenced(): void {
					const currentChild = requireCurrentChild();
					if (currentChild.state === 'retiring') {
						return;
					}
					if (currentChild.state !== 'destroying') {
						throw new GatewayOwnershipCoordinatorError('child-not-current');
					}
					currentChild.state = 'retiring';
					clearCurrentLeafMapping(gateway, currentChild);
				},
				recordDestroyed(): void {
					const currentChild = requireCurrentChild();
					if (currentChild.state !== 'destroying' && currentChild.state !== 'retiring') {
						throw new GatewayOwnershipCoordinatorError('child-not-current');
					}
					currentChild.state = 'destroyed';
					clearCurrentLeafMapping(gateway, currentChild);
					currentChild.completion.resolve(true);
				},
				recordUnavailable(): void {
					const currentChild = requireCurrentChild();
					if (currentChild.state === 'destroyed') {
						throw new GatewayOwnershipCoordinatorError('child-not-current');
					}
					if (currentChild.state === 'retiring') {
						return;
					}
					currentChild.state = 'owner-unsafe';
					currentChild.completion.resolve(false);
				},
				snapshot(): ToolVmMembershipSnapshot {
					return childSnapshot(requireCurrentChild());
				},
			};
		},

		recordGatewayDestroyUnavailable(expectedGateway): void {
			const gateway = requireGateway(expectedGateway);
			gateway.state = 'owner-unsafe';
		},

		resolveGatewayEpoch(expected): GatewayEpochIdentity {
			const gateway = requireGatewayForSeed(expected);
			if (gateway.state === 'owner-unsafe') {
				throw new GatewayOwnershipCoordinatorError('owner-unsafe');
			}
			if (gateway.identity === undefined) {
				throw new GatewayOwnershipCoordinatorError('gateway-not-attached');
			}
			return structuredClone(gateway.identity);
		},

		async retireGateway(expectedGateway): Promise<void> {
			const gateway = requireOperationalGateway(expectedGateway);
			if (gateway.state !== 'sealed' || gateway.sealResult === undefined) {
				throw new GatewayOwnershipCoordinatorError('gateway-not-sealed');
			}
			try {
				await gateway.sealResult.barrier;
			} catch (error) {
				gateway.state = 'owner-unsafe';
				throw new GatewayOwnershipCoordinatorError('owner-unsafe', { cause: error });
			}
			gateway.state = 'retired';
		},

		sealGatewayEpoch(expectedGateway): GatewaySealResult {
			const gateway = requireOperationalGateway(expectedGateway);
			if (gateway.sealResult !== undefined) {
				return gateway.sealResult;
			}
			if (gateway.state !== 'admitting') {
				throw new GatewayOwnershipCoordinatorError('gateway-not-admitting');
			}
			gateway.state = 'sealed';
			const pendingChildren = [...gateway.childrenByLeafId.values()].filter(
				(child) => child.state !== 'destroyed',
			);
			const childLeafIds = pendingChildren.map((child) => child.leafId);
			const barrier = Promise.all(pendingChildren.map((child) => child.completion.promise)).then(
				(completions) => {
					if (completions.some((complete) => !complete)) {
						throw new GatewayOwnershipCoordinatorError('owner-unsafe');
					}
					return {
						gatewayEpochId: expectedGateway.gatewayEpochId,
						kind: 'children-destroyed' as const,
					};
				},
			);
			gateway.sealResult = { barrier, childLeafIds };
			return gateway.sealResult;
		},

		snapshotGateway(expectedGateway): GatewayMembershipSnapshot {
			return gatewaySnapshot(requireGateway(expectedGateway));
		},
	};
}
