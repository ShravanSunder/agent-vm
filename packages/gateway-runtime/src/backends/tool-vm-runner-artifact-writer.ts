import type { ArtifactReference } from '@agent-vm/agent-portal-sdk';

import type { GatewayRuntimeArtifactCurrentAuthorityRegistry } from '../artifacts/artifact-read-authority.js';
import {
	gatewayRuntimeArtifactStablePrincipalFromTrustedContext,
	type GatewayRuntimeArtifactAuthorization,
	type GatewayRuntimeArtifactStore,
} from '../artifacts/artifact-store.js';
import type {
	GatewayRuntimeToolVmRunnerArtifactWriter,
	GatewayRuntimeToolVmRunnerArtifactWriteRequest,
} from './tool-vm-runner-backend-port.js';

export interface CreateGatewayRuntimeToolVmRunnerArtifactWriterProps {
	readonly artifactStore: GatewayRuntimeArtifactStore;
	readonly lifetimeMs: number;
	readonly registerArtifactAuthority: GatewayRuntimeArtifactCurrentAuthorityRegistry['register'];
}

function dispatchAuthorityBinding(request: GatewayRuntimeToolVmRunnerArtifactWriteRequest): {
	readonly executionFingerprint: string;
	readonly operationId: string;
} {
	return request.dispatchAuthority.kind === 'without-approval'
		? {
				executionFingerprint: request.dispatchAuthority.fingerprint,
				operationId: request.dispatchAuthority.operationId,
			}
		: {
				executionFingerprint: request.dispatchAuthority.grant.fingerprint,
				operationId: request.dispatchAuthority.grant.operationId,
			};
}

async function bestEffortAbort(abort: () => Promise<void>, originalError: unknown): Promise<never> {
	try {
		await abort();
	} catch {
		// The original persistence failure remains authoritative.
	}
	throw originalError;
}

export function createGatewayRuntimeToolVmRunnerArtifactWriter(
	props: CreateGatewayRuntimeToolVmRunnerArtifactWriterProps,
): GatewayRuntimeToolVmRunnerArtifactWriter {
	if (!Number.isSafeInteger(props.lifetimeMs) || props.lifetimeMs <= 0) {
		throw new RangeError('Tool VM runner artifact lifetime must be a positive safe integer.');
	}

	return {
		write: async (
			request: GatewayRuntimeToolVmRunnerArtifactWriteRequest,
		): Promise<ArtifactReference> => {
			const authorityBinding = dispatchAuthorityBinding(request);
			if (request.operationId !== authorityBinding.operationId) {
				throw new Error('Tool VM runner artifact operation does not match dispatch authority.');
			}
			const authorization = {
				...gatewayRuntimeArtifactStablePrincipalFromTrustedContext(request.trustedContext),
				capability: request.capability,
				executionFingerprint: authorityBinding.executionFingerprint,
				operationId: authorityBinding.operationId,
				owningGeneration: request.owningGeneration,
				surfaceClass: request.surfaceClass,
			} satisfies GatewayRuntimeArtifactAuthorization;
			const registration = props.registerArtifactAuthority(authorization);
			if (registration.kind === 'rejected') {
				throw new Error('Tool VM runner artifact authority is not current.');
			}
			const writeHandle = await props.artifactStore.beginWrite({
				authorization,
				lifetimeMs: props.lifetimeMs,
				maximumBytes: Math.max(1, request.bytes.byteLength),
				mediaType: request.mediaType,
			});
			try {
				await writeHandle.write(request.bytes);
			} catch (error) {
				return await bestEffortAbort(writeHandle.abort, error);
			}
			try {
				return await writeHandle.commit();
			} catch (error) {
				return await bestEffortAbort(writeHandle.abort, error);
			}
		},
	};
}
