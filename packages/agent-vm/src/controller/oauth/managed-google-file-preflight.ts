import { isDeepStrictEqual } from 'node:util';

import {
	configuredGoogleOperationKey,
	resolveCompiledGoogleCommand,
	type CompiledOAuthPolicy,
} from '@agent-vm/config-contracts';
import {
	gogFileInputSnapshotSchema,
	type GogFileInputSnapshot,
	type ManagedGooglePreflightResult,
} from '@agent-vm/oauth-broker-contracts';

import type { ManagedGoogleInvocationRequest } from './google-permission-policy-service.js';

/** Host-owned preflight. Only metadata survives hashing; the existing call fingerprint binds it. */
export async function resolveManagedGoogleFilePreflight(props: {
	readonly compiled: CompiledOAuthPolicy;
	readonly request: ManagedGoogleInvocationRequest;
	readonly resolvePolicy: (request: ManagedGoogleInvocationRequest) => ManagedGooglePreflightResult;
	readonly readFileInputs: (paths: readonly string[]) => Promise<GogFileInputSnapshot>;
}): Promise<ManagedGooglePreflightResult> {
	const request = structuredClone(props.request);
	const initial = structuredClone(props.resolvePolicy(request));
	if (initial.kind !== 'ready') return initial;
	const commandSet =
		props.compiled.commandSetsByConfiguredOperation[
			configuredGoogleOperationKey(request.profileId, request.namespaceId, request.operationName)
		];
	if (commandSet === undefined) return { kind: 'unavailable' };
	const classification = resolveCompiledGoogleCommand(commandSet, request.input.argv);
	if (classification.kind !== 'oauth') return { kind: 'unavailable' };
	const paths = classification.files?.inputs ?? [];
	if (paths.length === 0) return initial;
	try {
		const fileInputs = gogFileInputSnapshotSchema.parse(await props.readFileInputs(paths));
		if (
			!isDeepStrictEqual(
				fileInputs.files.map((file) => file.relativePath),
				paths,
			)
		)
			return { kind: 'unavailable' };
		// Hashing yields. A policy/default/account change during the read cannot
		// become a new silent grant attached to the old preflight.
		if (!isDeepStrictEqual(initial, props.resolvePolicy(request))) return { kind: 'unavailable' };
		return { ...initial, fileInputs };
	} catch {
		return { kind: 'unavailable' };
	}
}
