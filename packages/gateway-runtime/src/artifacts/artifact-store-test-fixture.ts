import type { GatewayRuntimeTrustedInvocationPrincipal } from '@agent-vm/agent-portal-sdk';
import type {
	ArtifactReference,
	PortalArtifactReadRequest,
	PortalArtifactReadResult,
} from '@agent-vm/agent-portal-sdk/artifact-surface';
import { deriveGatewayControlStablePrincipal } from '@agent-vm/gateway-control-contracts';
import { expect, vi } from 'vitest';

type ArtifactStoreErrorCode =
	| 'not-found'
	| 'not-authorized'
	| 'expired'
	| 'range'
	| 'capacity'
	| 'write-cancelled'
	| 'write-failed'
	| 'cleanup-failed'
	| 'retired';

interface ArtifactAuthorization {
	readonly agentId: string;
	readonly capability: { readonly name: string; readonly namespace: string };
	readonly executionFingerprint: string;
	readonly frameworkIdentity: GatewayRuntimeTrustedInvocationPrincipal['frameworkIdentity'];
	readonly operationId: string;
	readonly owningGeneration: string;
	readonly profileAssignmentRevision: string;
	readonly surfaceClass: 'mcp' | 'protected_uds';
	readonly toolPortalProfileId: string;
}

type ArtifactStablePrincipal = GatewayRuntimeTrustedInvocationPrincipal;

type ArtifactReadCaller =
	| {
			readonly principal: ArtifactStablePrincipal;
			readonly surfaceClass: 'mcp';
	  }
	| {
			readonly principal: ArtifactStablePrincipal;
			readonly surfaceClass: 'protected_uds';
	  };

type ArtifactReadAuthorityDecision =
	| { readonly kind: 'authorized' }
	| {
			readonly kind: 'denied';
			readonly reason: 'current-authority' | 'principal' | 'surface';
	  };

interface ArtifactReadAuthorityResolver {
	readonly authorize: (props: {
		readonly caller: ArtifactReadCaller;
		readonly storedAuthorization: ArtifactAuthorization;
	}) => ArtifactReadAuthorityDecision;
}

interface ArtifactStorageWriter {
	readonly commit: () => Promise<void>;
	readonly discard: () => Promise<void>;
	readonly write: (chunk: Uint8Array, signal?: AbortSignal) => Promise<void>;
}

interface ArtifactStorageBackend {
	readonly createWriter: (artifactId: string) => Promise<ArtifactStorageWriter>;
	readonly readRange: (props: {
		readonly artifactId: string;
		readonly maxBytes: number;
		readonly offsetBytes: number;
	}) => Promise<Uint8Array>;
	readonly remove: (artifactId: string) => Promise<void>;
}

interface ArtifactStoreCounters {
	readonly activeReservations: number;
	readonly artifactCount: number;
	readonly committedBytes: number;
	readonly orphanedArtifactCount: number;
	readonly orphanedBytes: number;
	readonly reservedBytes: number;
	readonly retired: boolean;
}

interface ArtifactStoreLimits {
	readonly maximumArtifactBytes: number;
	readonly maximumArtifactCount: number;
	readonly maximumLifetimeMs: number;
	readonly maximumTotalBytes: number;
}

interface ArtifactWriteHandle {
	readonly artifactId: string;
	readonly abort: () => Promise<void>;
	readonly commit: () => Promise<ArtifactReference>;
	readonly write: (chunk: Uint8Array, signal?: AbortSignal) => Promise<void>;
}

interface GatewayRuntimeArtifactStore {
	readonly beginWrite: (props: {
		readonly authorization: ArtifactAuthorization;
		readonly lifetimeMs: number;
		readonly maximumBytes: number;
		readonly mediaType?: string;
	}) => Promise<ArtifactWriteHandle>;
	readonly inspectCounters: () => ArtifactStoreCounters;
	readonly read: (props: {
		readonly caller: ArtifactReadCaller;
		readonly request: PortalArtifactReadRequest;
	}) => Promise<PortalArtifactReadResult>;
	readonly retireEpoch: () => Promise<void>;
}

interface GatewayRuntimeArtifactStoreErrorLike extends Error {
	readonly code: ArtifactStoreErrorCode;
}

interface ArtifactStoreModule {
	readonly GatewayRuntimeArtifactStoreError: new (
		...constructorArguments: never[]
	) => GatewayRuntimeArtifactStoreErrorLike;
	readonly createGatewayRuntimeArtifactStore: (props: {
		readonly authorityResolver: ArtifactReadAuthorityResolver;
		readonly createArtifactId?: () => string;
		readonly epochId: string;
		readonly limits: ArtifactStoreLimits;
		readonly now?: () => number;
		readonly storageBackend: ArtifactStorageBackend;
	}) => GatewayRuntimeArtifactStore;
}

interface StorageControls {
	beforeRemove: ((artifactId: string) => Promise<void>) | undefined;
	beforeWrite: (() => Promise<void>) | undefined;
	failCommit: Error | undefined;
	failCreateWriter: Error | undefined;
	failDiscard: Error | undefined;
	failRemove: Error | undefined;
	failWriteAfterPersistCall: number | undefined;
	failWriteCall: number | undefined;
}

interface RecordingStorage {
	readonly backend: ArtifactStorageBackend;
	readonly bytesByArtifactId: Map<string, Uint8Array>;
	readonly controls: StorageControls;
	readonly discardedArtifactIds: string[];
	readonly readRequests: {
		readonly artifactId: string;
		readonly maxBytes: number;
		readonly offsetBytes: number;
	}[];
	readonly removedArtifactIds: string[];
	readonly writerWriteCalls: Uint8Array[];
}

interface AuthorityResolverControls {
	currentAuthorization: ArtifactAuthorization;
}

interface RecordingAuthorityResolver {
	readonly calls: {
		readonly caller: ArtifactReadCaller;
		readonly storedAuthorization: ArtifactAuthorization;
	}[];
	readonly controls: AuthorityResolverControls;
	readonly resolver: ArtifactReadAuthorityResolver;
}

interface StoreFixture {
	readonly authority: RecordingAuthorityResolver;
	readonly module: ArtifactStoreModule;
	readonly storage: RecordingStorage;
	readonly store: GatewayRuntimeArtifactStore;
}

interface DeferredSignal {
	readonly promise: Promise<void>;
	readonly resolve: () => void;
}

const artifactStoreModuleSpecifier = './artifact-store.js';
const fixedNowMilliseconds = Date.parse('2026-07-13T12:00:00.000Z');
const defaultLimits: ArtifactStoreLimits = {
	maximumArtifactBytes: 32,
	maximumArtifactCount: 4,
	maximumLifetimeMs: 1_000,
	maximumTotalBytes: 64,
};

const baseAuthorization = {
	agentId: 'agent-a',
	capability: { name: 'read_thing', namespace: 'upstream-mock' },
	executionFingerprint: 'execution-fingerprint-a',
	frameworkIdentity: { agentId: 'agent-a', kind: 'openclaw' },
	operationId: 'operation-a',
	owningGeneration: 'generation-a',
	profileAssignmentRevision: 'profile-revision-a',
	surfaceClass: 'mcp',
	toolPortalProfileId: 'code-builder',
} as const satisfies ArtifactAuthorization;

const baseCaller = {
	principal: {
		agentId: baseAuthorization.agentId,
		frameworkIdentity: baseAuthorization.frameworkIdentity,
		profileAssignmentRevision: baseAuthorization.profileAssignmentRevision,
		toolPortalProfileId: baseAuthorization.toolPortalProfileId,
	},
	surfaceClass: baseAuthorization.surfaceClass,
} as const satisfies ArtifactReadCaller;

function isArtifactStoreModule(value: unknown): value is ArtifactStoreModule {
	return (
		typeof value === 'object' &&
		value !== null &&
		'createGatewayRuntimeArtifactStore' in value &&
		typeof value.createGatewayRuntimeArtifactStore === 'function' &&
		'GatewayRuntimeArtifactStoreError' in value &&
		typeof value.GatewayRuntimeArtifactStoreError === 'function'
	);
}

async function loadArtifactStoreModule(): Promise<ArtifactStoreModule> {
	const moduleExports: unknown = await import(artifactStoreModuleSpecifier);
	if (!isArtifactStoreModule(moduleExports)) {
		throw new Error('Artifact store module does not expose the frozen Slice 4 API.');
	}
	return moduleExports;
}

function concatenateChunks(chunks: readonly Uint8Array[]): Uint8Array {
	const combined = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
	let offset = 0;
	for (const chunk of chunks) {
		combined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return combined;
}

function createDeferredSignal(): DeferredSignal {
	let resolveSignal: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		resolveSignal = resolve;
	});
	if (resolveSignal === undefined) {
		throw new Error('Deferred test signal was not initialized.');
	}
	return { promise, resolve: resolveSignal };
}

function authorizationMatchesCaller(
	authorization: ArtifactAuthorization,
	caller: ArtifactReadCaller,
): boolean {
	return (
		authorization.surfaceClass === caller.surfaceClass &&
		deriveGatewayControlStablePrincipal({ principal: authorization }) ===
			deriveGatewayControlStablePrincipal({ principal: caller.principal })
	);
}

function authorizationsMatch(left: ArtifactAuthorization, right: ArtifactAuthorization): boolean {
	return (
		deriveGatewayControlStablePrincipal({ principal: left }) ===
			deriveGatewayControlStablePrincipal({ principal: right }) &&
		left.capability.name === right.capability.name &&
		left.capability.namespace === right.capability.namespace &&
		left.executionFingerprint === right.executionFingerprint &&
		left.operationId === right.operationId &&
		left.owningGeneration === right.owningGeneration &&
		left.surfaceClass === right.surfaceClass
	);
}

function createRecordingAuthorityResolver(): RecordingAuthorityResolver {
	const calls: RecordingAuthorityResolver['calls'] = [];
	const controls: AuthorityResolverControls = {
		currentAuthorization: {
			...baseAuthorization,
			capability: { ...baseAuthorization.capability },
		},
	};
	const resolver: ArtifactReadAuthorityResolver = {
		authorize: vi.fn((props): ArtifactReadAuthorityDecision => {
			calls.push(props);
			if (props.storedAuthorization.surfaceClass !== props.caller.surfaceClass) {
				return { kind: 'denied', reason: 'surface' };
			}
			if (!authorizationMatchesCaller(props.storedAuthorization, props.caller)) {
				return { kind: 'denied', reason: 'principal' };
			}
			if (!authorizationsMatch(props.storedAuthorization, controls.currentAuthorization)) {
				return { kind: 'denied', reason: 'current-authority' };
			}
			return { kind: 'authorized' };
		}),
	};
	return { calls, controls, resolver };
}

function createRecordingStorage(): RecordingStorage {
	const bytesByArtifactId = new Map<string, Uint8Array>();
	const discardedArtifactIds: string[] = [];
	const readRequests: RecordingStorage['readRequests'] = [];
	const removedArtifactIds: string[] = [];
	const writerWriteCalls: Uint8Array[] = [];
	const controls: StorageControls = {
		beforeRemove: undefined,
		beforeWrite: undefined,
		failCommit: undefined,
		failCreateWriter: undefined,
		failDiscard: undefined,
		failRemove: undefined,
		failWriteAfterPersistCall: undefined,
		failWriteCall: undefined,
	};
	let writeCallCount = 0;
	const backend: ArtifactStorageBackend = {
		createWriter: vi.fn(async (artifactId: string): Promise<ArtifactStorageWriter> => {
			if (controls.failCreateWriter !== undefined) {
				throw controls.failCreateWriter;
			}
			const chunks: Uint8Array[] = [];
			return {
				commit: vi.fn(async (): Promise<void> => {
					if (controls.failCommit !== undefined) {
						throw controls.failCommit;
					}
					bytesByArtifactId.set(artifactId, concatenateChunks(chunks));
				}),
				discard: vi.fn(async (): Promise<void> => {
					if (controls.failDiscard !== undefined) {
						throw controls.failDiscard;
					}
					discardedArtifactIds.push(artifactId);
				}),
				write: vi.fn(async (chunk: Uint8Array): Promise<void> => {
					writeCallCount += 1;
					if (controls.failWriteCall === writeCallCount) {
						throw new Error('/private/artifacts write failed with secret-token');
					}
					await controls.beforeWrite?.();
					const retainedChunk = Uint8Array.from(chunk);
					writerWriteCalls.push(retainedChunk);
					chunks.push(retainedChunk);
					if (controls.failWriteAfterPersistCall === writeCallCount) {
						throw new Error('/private/artifacts write failed after persisting secret-token');
					}
				}),
			};
		}),
		readRange: vi.fn(async (request): Promise<Uint8Array> => {
			readRequests.push(request);
			const bytes = bytesByArtifactId.get(request.artifactId);
			if (bytes === undefined) {
				throw new Error('/private/artifacts missing secret-token');
			}
			return bytes.slice(request.offsetBytes, request.offsetBytes + request.maxBytes);
		}),
		remove: vi.fn(async (artifactId: string): Promise<void> => {
			await controls.beforeRemove?.(artifactId);
			if (controls.failRemove !== undefined) {
				throw controls.failRemove;
			}
			removedArtifactIds.push(artifactId);
			bytesByArtifactId.delete(artifactId);
		}),
	};
	return {
		backend,
		bytesByArtifactId,
		controls,
		discardedArtifactIds,
		readRequests,
		removedArtifactIds,
		writerWriteCalls,
	};
}

async function createStoreFixture(
	props: {
		readonly authority?: RecordingAuthorityResolver;
		readonly createArtifactId?: () => string;
		readonly epochId?: string;
		readonly limits?: Partial<ArtifactStoreLimits>;
		readonly now?: () => number;
		readonly storage?: RecordingStorage;
	} = {},
): Promise<StoreFixture> {
	const module = await loadArtifactStoreModule();
	const authority = props.authority ?? createRecordingAuthorityResolver();
	const storage = props.storage ?? createRecordingStorage();
	let artifactSequence = 0;
	const store = module.createGatewayRuntimeArtifactStore({
		authorityResolver: authority.resolver,
		createArtifactId: props.createArtifactId ?? (() => `artifact-${String(++artifactSequence)}`),
		epochId: props.epochId ?? 'gateway-epoch-a',
		limits: { ...defaultLimits, ...props.limits },
		now: props.now ?? (() => fixedNowMilliseconds),
		storageBackend: storage.backend,
	});
	return { authority, module, storage, store };
}

async function writeArtifact(
	fixture: StoreFixture,
	bytes: Uint8Array,
	props: { readonly lifetimeMs?: number; readonly maximumBytes?: number } = {},
): Promise<ArtifactReference> {
	const handle = await fixture.store.beginWrite({
		authorization: baseAuthorization,
		lifetimeMs: props.lifetimeMs ?? 500,
		maximumBytes: props.maximumBytes ?? bytes.byteLength,
		mediaType: 'application/octet-stream',
	});
	await handle.write(bytes);
	return await handle.commit();
}

async function expectStoreError(
	module: ArtifactStoreModule,
	operation: () => unknown,
	expectedCode: ArtifactStoreErrorCode,
): Promise<GatewayRuntimeArtifactStoreErrorLike> {
	try {
		await operation();
	} catch (error: unknown) {
		expect(error).toBeInstanceOf(module.GatewayRuntimeArtifactStoreError);
		if (!(error instanceof module.GatewayRuntimeArtifactStoreError)) {
			throw error;
		}
		expect(error.code).toBe(expectedCode);
		return error;
	}
	throw new Error(`Expected GatewayRuntimeArtifactStoreError with code ${expectedCode}.`);
}

function readRequest(
	reference: ArtifactReference,
	overrides: Partial<Omit<PortalArtifactReadRequest, 'reference'>> = {},
): PortalArtifactReadRequest {
	return { maxBytes: reference.byteLength || 1, offsetBytes: 0, reference, ...overrides };
}

const callerMutations = [
	{
		label: 'agent',
		mutate: () => ({
			...baseCaller,
			principal: { ...baseCaller.principal, agentId: 'agent-b' },
		}),
	},
	{
		label: 'framework identity',
		mutate: () => ({
			...baseCaller,
			principal: {
				...baseCaller.principal,
				frameworkIdentity: { kind: 'hermes', profileName: 'agent-a-profile' },
			},
		}),
	},
	{
		label: 'profile assignment revision',
		mutate: () => ({
			...baseCaller,
			principal: {
				...baseCaller.principal,
				profileAssignmentRevision: 'profile-revision-b',
			},
		}),
	},
	{
		label: 'Tool Portal profile',
		mutate: () => ({
			...baseCaller,
			principal: { ...baseCaller.principal, toolPortalProfileId: 'privileged' },
		}),
	},
] as const satisfies readonly {
	readonly label: string;
	readonly mutate: () => ArtifactReadCaller;
}[];

const currentAuthorityMutations = [
	{
		label: 'capability namespace',
		mutate: () => ({
			...baseAuthorization,
			capability: { ...baseAuthorization.capability, namespace: 'other-provider' },
		}),
	},
	{
		label: 'capability name',
		mutate: () => ({
			...baseAuthorization,
			capability: { ...baseAuthorization.capability, name: 'write_thing' },
		}),
	},
	{ label: 'operation', mutate: () => ({ ...baseAuthorization, operationId: 'operation-b' }) },
	{
		label: 'owning generation',
		mutate: () => ({ ...baseAuthorization, owningGeneration: 'generation-b' }),
	},
	{
		label: 'execution fingerprint',
		mutate: () => ({ ...baseAuthorization, executionFingerprint: 'execution-fingerprint-b' }),
	},
] as const satisfies readonly {
	readonly label: string;
	readonly mutate: () => ArtifactAuthorization;
}[];

export {
	type ArtifactAuthorization,
	type ArtifactReadCaller,
	type ArtifactStoreErrorCode,
	type RecordingStorage,
	type StoreFixture,
	baseAuthorization,
	baseCaller,
	callerMutations,
	createDeferredSignal,
	createRecordingAuthorityResolver,
	createRecordingStorage,
	createStoreFixture,
	currentAuthorityMutations,
	defaultLimits,
	expectStoreError,
	fixedNowMilliseconds,
	loadArtifactStoreModule,
	readRequest,
	writeArtifact,
};
