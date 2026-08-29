import type { ArtifactReference } from '@agent-vm/agent-portal-sdk';
import type {
	GatewayRuntimeToolPortalDispatchAuthorityForBackendKind,
	GatewayRuntimeTrustedInvocationContext,
} from '@agent-vm/gateway-control-contracts';
import { describe, expect, it, vi } from 'vitest';

import type { GatewayRuntimeArtifactCurrentAuthorityRegistry } from '../artifacts/artifact-read-authority.js';
import type {
	GatewayRuntimeArtifactAuthorization,
	GatewayRuntimeArtifactStore,
} from '../artifacts/artifact-store.js';
import { createGatewayRuntimeToolVmRunnerArtifactWriter } from './tool-vm-runner-artifact-writer.js';
import type {
	GatewayRuntimeToolVmRunnerArtifactWriter,
	GatewayRuntimeToolVmRunnerArtifactWriteRequest,
} from './tool-vm-runner-backend-port.js';

const trustedContext = {
	correlation: {
		runId: 'run-artifact-writer-a',
		sessionId: 'session-artifact-writer-a',
		toolCallId: 'tool-call-artifact-writer-a',
	},
	principal: {
		agentId: 'agent-artifact-writer-a',
		frameworkIdentity: { kind: 'hermes', profileName: 'agent-artifact-writer-a' },
		profileAssignmentRevision: 'profile-assignment-a',
		toolPortalProfileId: 'builder-a',
	},
	requester: { authenticatedSubjectId: 'subject-artifact-writer-a' },
} as const satisfies GatewayRuntimeTrustedInvocationContext;

const directDispatchAuthority = {
	backendKind: 'tool_vm_runner',
	fingerprint: `sha256:${'a'.repeat(64)}`,
	kind: 'without-approval',
	operationId: '10000000-0000-4000-8000-000000000001',
} as const satisfies GatewayRuntimeToolPortalDispatchAuthorityForBackendKind<'tool_vm_runner'>;

const approvalDispatchAuthority = {
	backendKind: 'tool_vm_runner',
	grant: {
		approvalId: '20000000-0000-4000-8000-000000000002',
		authorityContext: {
			controllerEpoch: 'controller-epoch-a',
			frameworkEpoch: 'framework-epoch-a',
			gatewayEpoch: 'gateway-epoch-a',
			runtimeEpoch: 'runtime-epoch-a',
			zoneId: 'zone-a',
		},
		backendKind: 'tool_vm_runner',
		expiresAt: '2026-07-16T20:00:00.000Z',
		fingerprint: `sha256:${'b'.repeat(64)}`,
		grantId: '30000000-0000-4000-8000-000000000003',
		operationId: '40000000-0000-4000-8000-000000000004',
		stablePrincipal: 'c'.repeat(64),
	},
	kind: 'approval-grant',
} as const satisfies GatewayRuntimeToolPortalDispatchAuthorityForBackendKind<'tool_vm_runner'>;

const committedReference = {
	byteLength: 4,
	expiresAt: '2026-07-16T20:00:00.000Z',
	fingerprint: `sha256:${'d'.repeat(64)}`,
	id: 'artifact-a',
	mediaType: 'application/octet-stream',
} as const satisfies ArtifactReference;

interface ArtifactStoreFixtureControls {
	abortError?: Error;
	commitError?: Error;
	commitReference?: ArtifactReference;
	registerResult?: ReturnType<GatewayRuntimeArtifactCurrentAuthorityRegistry['register']>;
	writeError?: Error;
}

interface ArtifactStoreFixture {
	readonly abort: ReturnType<typeof vi.fn<() => Promise<void>>>;
	readonly artifactStore: GatewayRuntimeArtifactStore;
	readonly beginWrite: ReturnType<typeof vi.fn<GatewayRuntimeArtifactStore['beginWrite']>>;
	readonly commit: ReturnType<typeof vi.fn<() => Promise<ArtifactReference>>>;
	readonly controls: ArtifactStoreFixtureControls;
	readonly registerArtifactAuthority: ReturnType<
		typeof vi.fn<GatewayRuntimeArtifactCurrentAuthorityRegistry['register']>
	>;
	readonly write: ReturnType<typeof vi.fn<(chunk: Uint8Array) => Promise<void>>>;
}

function createArtifactStoreFixture(): ArtifactStoreFixture {
	const controls: ArtifactStoreFixtureControls = {};
	const abort = vi.fn(async (): Promise<void> => {
		if (controls.abortError !== undefined) throw controls.abortError;
	});
	const commit = vi.fn(async (): Promise<ArtifactReference> => {
		if (controls.commitError !== undefined) throw controls.commitError;
		return controls.commitReference ?? committedReference;
	});
	const write = vi.fn(async (_chunk: Uint8Array): Promise<void> => {
		if (controls.writeError !== undefined) throw controls.writeError;
	});
	const beginWrite = vi.fn<GatewayRuntimeArtifactStore['beginWrite']>(async () => ({
		abort,
		artifactId: committedReference.id,
		commit,
		write,
	}));
	const registerArtifactAuthority = vi.fn<
		GatewayRuntimeArtifactCurrentAuthorityRegistry['register']
	>(() => controls.registerResult ?? { kind: 'registered' });
	return {
		abort,
		artifactStore: {
			beginWrite,
			inspectCounters: () => ({
				activeReservations: 0,
				artifactCount: 0,
				committedBytes: 0,
				orphanedArtifactCount: 0,
				orphanedBytes: 0,
				reservedBytes: 0,
				retired: false,
			}),
			read: async () => {
				throw new Error('Artifact reads are outside this fixture.');
			},
			retireEpoch: async (): Promise<void> => undefined,
		},
		beginWrite,
		commit,
		controls,
		registerArtifactAuthority,
		write,
	};
}

function artifactWriteRequest(props?: {
	readonly bytes?: Uint8Array;
	readonly dispatchAuthority?: GatewayRuntimeToolPortalDispatchAuthorityForBackendKind<'tool_vm_runner'>;
	readonly operationId?: string;
	readonly surfaceClass?: 'mcp' | 'protected_uds';
}): GatewayRuntimeToolVmRunnerArtifactWriteRequest {
	const dispatchAuthority = props?.dispatchAuthority ?? directDispatchAuthority;
	const authorityOperationId =
		dispatchAuthority.kind === 'without-approval'
			? dispatchAuthority.operationId
			: dispatchAuthority.grant.operationId;
	return {
		bytes: props?.bytes ?? Uint8Array.from([1, 2, 3, 4]),
		capability: { name: 'read_file', namespace: 'sandbox' },
		dispatchAuthority,
		mediaType: 'application/octet-stream',
		operationId: props?.operationId ?? authorityOperationId,
		owningGeneration: 'tool-vm-generation-a',
		role: 'file',
		surfaceClass: props?.surfaceClass ?? 'protected_uds',
		trustedContext,
	};
}

function expectedAuthorization(props: {
	readonly executionFingerprint: string;
	readonly operationId: string;
	readonly surfaceClass: 'mcp' | 'protected_uds';
}): GatewayRuntimeArtifactAuthorization {
	return {
		...trustedContext.principal,
		capability: { name: 'read_file', namespace: 'sandbox' },
		executionFingerprint: props.executionFingerprint,
		operationId: props.operationId,
		owningGeneration: 'tool-vm-generation-a',
		surfaceClass: props.surfaceClass,
	};
}

function createWriter(
	fixture: ArtifactStoreFixture,
	lifetimeMs: number = 60_000,
): GatewayRuntimeToolVmRunnerArtifactWriter {
	return createGatewayRuntimeToolVmRunnerArtifactWriter({
		artifactStore: fixture.artifactStore,
		lifetimeMs,
		registerArtifactAuthority: fixture.registerArtifactAuthority,
	});
}

describe('Tool VM runner artifact writer', () => {
	it('registers exact direct-dispatch authorization metadata before reserving bytes', async () => {
		// Arrange
		const fixture = createArtifactStoreFixture();
		const writer = createWriter(fixture);
		const request = artifactWriteRequest();

		// Act
		await writer.write(request);

		// Assert
		const authorization = expectedAuthorization({
			executionFingerprint: directDispatchAuthority.fingerprint,
			operationId: directDispatchAuthority.operationId,
			surfaceClass: 'protected_uds',
		});
		expect(fixture.registerArtifactAuthority).toHaveBeenCalledWith(authorization);
		expect(fixture.beginWrite).toHaveBeenCalledWith({
			authorization,
			lifetimeMs: 60_000,
			maximumBytes: request.bytes.byteLength,
			mediaType: request.mediaType,
		});
		expect(fixture.registerArtifactAuthority.mock.invocationCallOrder[0]).toBeLessThan(
			fixture.beginWrite.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
		);
	});

	it('derives approval-grant fingerprint and operation metadata without accepting caller substitutes', async () => {
		// Arrange
		const fixture = createArtifactStoreFixture();
		const writer = createWriter(fixture);
		const request = artifactWriteRequest({
			dispatchAuthority: approvalDispatchAuthority,
			surfaceClass: 'mcp',
		});

		// Act
		await writer.write(request);

		// Assert
		const authorization = expectedAuthorization({
			executionFingerprint: approvalDispatchAuthority.grant.fingerprint,
			operationId: approvalDispatchAuthority.grant.operationId,
			surfaceClass: 'mcp',
		});
		expect(fixture.registerArtifactAuthority).toHaveBeenCalledWith(authorization);
		expect(fixture.beginWrite).toHaveBeenCalledWith({
			authorization,
			lifetimeMs: 60_000,
			maximumBytes: request.bytes.byteLength,
			mediaType: request.mediaType,
		});
	});

	it('rejects an operation mismatch before authority registration or storage', async () => {
		// Arrange
		const fixture = createArtifactStoreFixture();
		const writer = createWriter(fixture);
		const request = artifactWriteRequest({
			operationId: '50000000-0000-4000-8000-000000000005',
		});

		// Act
		const result = writer.write(request);

		// Assert
		await expect(result).rejects.toThrow('operation does not match dispatch authority');
		expect(fixture.registerArtifactAuthority).not.toHaveBeenCalled();
		expect(fixture.beginWrite).not.toHaveBeenCalled();
	});

	it('does not create storage when current-authority registration is rejected', async () => {
		// Arrange
		const fixture = createArtifactStoreFixture();
		fixture.controls.registerResult = { kind: 'rejected', reason: 'owning-generation' };
		const writer = createWriter(fixture);

		// Act
		const result = writer.write(artifactWriteRequest());

		// Assert
		await expect(result).rejects.toThrow('artifact authority is not current');
		expect(fixture.registerArtifactAuthority).toHaveBeenCalledTimes(1);
		expect(fixture.beginWrite).not.toHaveBeenCalled();
	});

	it('writes the exact bytes and commits the resulting reference', async () => {
		// Arrange
		const fixture = createArtifactStoreFixture();
		const writer = createWriter(fixture, 45_000);
		const bytes = Uint8Array.from([9, 8, 7]);

		// Act
		const reference = await writer.write(artifactWriteRequest({ bytes }));

		// Assert
		expect(fixture.beginWrite).toHaveBeenCalledWith(
			expect.objectContaining({
				lifetimeMs: 45_000,
				maximumBytes: bytes.byteLength,
				mediaType: 'application/octet-stream',
			}),
		);
		expect(fixture.write).toHaveBeenCalledTimes(1);
		expect(fixture.write).toHaveBeenCalledWith(bytes);
		expect(fixture.commit).toHaveBeenCalledTimes(1);
		expect(reference).toBe(committedReference);
	});

	it('reserves the store minimum for zero-byte output without writing extra bytes', async () => {
		// Arrange
		const fixture = createArtifactStoreFixture();
		const writer = createWriter(fixture);
		const bytes = new Uint8Array(0);
		fixture.controls.commitReference = { ...committedReference, byteLength: 0 };

		// Act
		const reference = await writer.write(artifactWriteRequest({ bytes }));

		// Assert
		expect(fixture.beginWrite).toHaveBeenCalledWith(expect.objectContaining({ maximumBytes: 1 }));
		expect(fixture.write).toHaveBeenCalledTimes(1);
		expect(fixture.write).toHaveBeenCalledWith(bytes);
		expect(fixture.write.mock.calls[0]?.[0]).toHaveLength(0);
		expect(reference.byteLength).toBe(0);
	});

	it('best-effort aborts a failed write without masking the original error', async () => {
		// Arrange
		const fixture = createArtifactStoreFixture();
		const writeError = new Error('original write failure');
		fixture.controls.writeError = writeError;
		fixture.controls.abortError = new Error('secondary abort failure');
		const writer = createWriter(fixture);

		// Act
		const result = writer.write(artifactWriteRequest());

		// Assert
		await expect(result).rejects.toBe(writeError);
		expect(fixture.abort).toHaveBeenCalledTimes(1);
		expect(fixture.commit).not.toHaveBeenCalled();
	});

	it('best-effort aborts a failed commit without masking the original error', async () => {
		// Arrange
		const fixture = createArtifactStoreFixture();
		const commitError = new Error('original commit failure');
		fixture.controls.commitError = commitError;
		fixture.controls.abortError = new Error('secondary abort failure');
		const writer = createWriter(fixture);

		// Act
		const result = writer.write(artifactWriteRequest());

		// Assert
		await expect(result).rejects.toBe(commitError);
		expect(fixture.abort).toHaveBeenCalledTimes(1);
	});

	it.each([0, -1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
		'rejects invalid bounded lifetime %s during construction',
		(invalidLifetimeMs) => {
			// Arrange
			const fixture = createArtifactStoreFixture();

			// Act
			const construct = (): unknown => createWriter(fixture, invalidLifetimeMs);

			// Assert
			expect(construct).toThrow('positive safe integer');
			expect(fixture.registerArtifactAuthority).not.toHaveBeenCalled();
			expect(fixture.beginWrite).not.toHaveBeenCalled();
		},
	);
});
