import path from 'node:path';

import type { ManagedVm, ManagedVmFinalizableMemoryFile } from '@agent-vm/managed-vm';
import type { SecretRef, SecretResolver } from '@agent-vm/secret-management';

import type { CredentialedRuntimeResolution } from './credentialed-runtime-registry.js';

export const CredentialedRuntimeCredentialRoot = '/run/agent-vm/credentials';

const maximumCredentialFileBytes = 1_048_576;
const maximumCredentialTotalBytes = 4_194_304;
const credentialFileMode = 0o600;

export interface CredentialFileMaterializationResult {
	readonly environment: Readonly<Record<string, string>>;
}

function credentialMaterializationError(): Error {
	return new Error('Credentialed runtime credential materialization failed.');
}

function isCanonicalUtf8(value: string, encoded: Uint8Array): boolean {
	return Buffer.from(encoded).toString('utf8') === value;
}

export function resolveCredentialEnvironment(
	resolution: CredentialedRuntimeResolution,
): Readonly<Record<string, string>> {
	const relativePathBySource = new Map(
		resolution.fileMappings.map((mapping) => [mapping.source, mapping.path] as const),
	);
	const environment: Record<string, string> = {};
	for (const [environmentName, value] of Object.entries(resolution.credentialEnvironment)) {
		if (value.kind === 'credential_root') {
			environment[environmentName] = CredentialedRuntimeCredentialRoot;
			continue;
		}
		const relativePath = relativePathBySource.get(value.source);
		if (relativePath === undefined) throw credentialMaterializationError();
		environment[environmentName] = path.posix.join(CredentialedRuntimeCredentialRoot, relativePath);
	}
	return Object.freeze(environment);
}

export async function materializeCredentialFiles(props: {
	readonly resolution: CredentialedRuntimeResolution;
	readonly secretResolver: SecretResolver;
	readonly vm: ManagedVm;
}): Promise<CredentialFileMaterializationResult> {
	if (props.vm.finalizeMemoryMount === undefined) {
		throw new Error('Credentialed runtime requires finalizable memory mount support.');
	}
	const refs: Record<string, SecretRef> = {};
	for (const mapping of props.resolution.fileMappings) {
		const ref = props.resolution.credentialBinding.files[mapping.source];
		if (ref === undefined) throw credentialMaterializationError();
		refs[mapping.source] = ref;
	}

	let resolved: Record<string, string>;
	try {
		resolved = await props.secretResolver.resolveAll(refs);
	} catch {
		throw credentialMaterializationError();
	}
	if (
		Object.keys(resolved).length !== Object.keys(refs).length ||
		Object.keys(resolved).some((source) => refs[source] === undefined)
	) {
		throw credentialMaterializationError();
	}

	let totalBytes = 0;
	const files: ManagedVmFinalizableMemoryFile[] = [];
	for (const mapping of props.resolution.fileMappings) {
		const value = resolved[mapping.source];
		if (value === undefined) throw credentialMaterializationError();
		const contents = new TextEncoder().encode(value);
		if (!isCanonicalUtf8(value, contents) || contents.byteLength > maximumCredentialFileBytes) {
			throw credentialMaterializationError();
		}
		totalBytes += contents.byteLength;
		if (totalBytes > maximumCredentialTotalBytes) throw credentialMaterializationError();
		files.push({ contents, mode: credentialFileMode, relativePath: mapping.path });
	}
	const environment = resolveCredentialEnvironment(props.resolution);

	try {
		await props.vm.finalizeMemoryMount({
			files,
			guestPath: CredentialedRuntimeCredentialRoot,
		});
	} catch {
		throw credentialMaterializationError();
	}
	return { environment };
}
