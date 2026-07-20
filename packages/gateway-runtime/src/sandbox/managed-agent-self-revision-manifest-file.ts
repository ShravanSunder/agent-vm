import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import {
	MANAGED_AGENT_SELF_REVISION_MANIFEST_RELATIVE_PATH,
	type ManagedAgentSelfRevisionManifest,
} from './managed-agent-self-coherence.js';

export const MANAGED_AGENT_SELF_REVISION_MANIFEST_FILE_NAME =
	MANAGED_AGENT_SELF_REVISION_MANIFEST_RELATIVE_PATH;
const MANAGED_AGENT_SELF_REVISION_MANIFEST_SCHEMA_VERSION = 1;
const MANAGED_AGENT_SELF_REVISION_MANIFEST_MAXIMUM_BYTES = 4 * 1024;
const MANAGED_AGENT_SELF_ASSIGNMENT_REVISION_MAXIMUM_CHARACTERS = 256;
const sha256DigestPattern = /^sha256:[0-9a-f]{64}$/u;

export interface ManagedAgentSelfManifestWritableFile {
	close(): Promise<void>;
	sync(): Promise<void>;
	writeFile(content: string, encoding: 'utf8'): Promise<void>;
}

export interface ManagedAgentSelfManifestDirectory {
	close(): Promise<void>;
	sync(): Promise<void>;
}

export interface ManagedAgentSelfManifestFileOperations {
	openDirectory(directoryPath: string): Promise<ManagedAgentSelfManifestDirectory>;
	openTemporaryFile(temporaryFilePath: string): Promise<ManagedAgentSelfManifestWritableFile>;
	rename(temporaryFilePath: string, destinationFilePath: string): Promise<void>;
	remove(temporaryFilePath: string): Promise<void>;
}

const defaultFileOperations: ManagedAgentSelfManifestFileOperations = {
	openDirectory: async (directoryPath) => await open(directoryPath, constants.O_RDONLY),
	openTemporaryFile: async (temporaryFilePath) => await open(temporaryFilePath, 'wx', 0o600),
	rename,
	remove: async (temporaryFilePath) => await rm(temporaryFilePath, { force: true }),
};

function isUnknownRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseManagedAgentSelfRevisionManifest(value: unknown): ManagedAgentSelfRevisionManifest {
	if (!isUnknownRecord(value)) {
		throw new Error('Managed agent self revision manifest must be an object.');
	}
	const record = value;
	const expectedKeys = ['contentDigest', 'profileAssignmentRevision', 'revision', 'schemaVersion'];
	if (
		Object.keys(record).length !== expectedKeys.length ||
		expectedKeys.some((expectedKey) => !(expectedKey in record))
	) {
		throw new Error('Managed agent self revision manifest has an invalid field set.');
	}
	if (record.schemaVersion !== MANAGED_AGENT_SELF_REVISION_MANIFEST_SCHEMA_VERSION) {
		throw new Error('Managed agent self revision manifest has an unsupported schema version.');
	}
	if (typeof record.contentDigest !== 'string' || !sha256DigestPattern.test(record.contentDigest)) {
		throw new Error('Managed agent self revision manifest has an invalid content digest.');
	}
	if (
		typeof record.profileAssignmentRevision !== 'string' ||
		record.profileAssignmentRevision.length === 0 ||
		record.profileAssignmentRevision.length >
			MANAGED_AGENT_SELF_ASSIGNMENT_REVISION_MAXIMUM_CHARACTERS
	) {
		throw new Error('Managed agent self revision manifest has an invalid assignment revision.');
	}
	if (!Number.isSafeInteger(record.revision) || Number(record.revision) <= 0) {
		throw new Error('Managed agent self revision manifest has an invalid revision.');
	}
	return Object.freeze({
		contentDigest: record.contentDigest,
		profileAssignmentRevision: record.profileAssignmentRevision,
		revision: Number(record.revision),
	});
}

function serializeManagedAgentSelfRevisionManifest(
	manifest: ManagedAgentSelfRevisionManifest,
): string {
	const validatedManifest = parseManagedAgentSelfRevisionManifest({
		...manifest,
		schemaVersion: MANAGED_AGENT_SELF_REVISION_MANIFEST_SCHEMA_VERSION,
	});
	const serializedManifest = `${JSON.stringify({
		contentDigest: validatedManifest.contentDigest,
		profileAssignmentRevision: validatedManifest.profileAssignmentRevision,
		revision: validatedManifest.revision,
		schemaVersion: MANAGED_AGENT_SELF_REVISION_MANIFEST_SCHEMA_VERSION,
	})}\n`;
	if (
		Buffer.byteLength(serializedManifest, 'utf8') >
		MANAGED_AGENT_SELF_REVISION_MANIFEST_MAXIMUM_BYTES
	) {
		throw new Error('Managed agent self revision manifest exceeds its bounded byte count.');
	}
	return serializedManifest;
}

function resolveManifestPath(workspaceRoot: string): string {
	if (typeof workspaceRoot !== 'string' || !path.isAbsolute(workspaceRoot)) {
		throw new Error('Managed agent workspace root must be absolute.');
	}
	return path.join(workspaceRoot, MANAGED_AGENT_SELF_REVISION_MANIFEST_FILE_NAME);
}

export async function writeManagedAgentSelfRevisionManifestFile(
	options: {
		readonly manifest: ManagedAgentSelfRevisionManifest;
		readonly workspaceRoot: string;
	},
	dependencies: { readonly fileOperations?: ManagedAgentSelfManifestFileOperations } = {},
): Promise<void> {
	const destinationFilePath = resolveManifestPath(options.workspaceRoot);
	const temporaryFilePath = `${destinationFilePath}.${process.pid}.${randomUUID()}.tmp`;
	const serializedManifest = serializeManagedAgentSelfRevisionManifest(options.manifest);
	const fileOperations = dependencies.fileOperations ?? defaultFileOperations;
	try {
		const temporaryFile = await fileOperations.openTemporaryFile(temporaryFilePath);
		try {
			await temporaryFile.writeFile(serializedManifest, 'utf8');
			await temporaryFile.sync();
		} finally {
			await temporaryFile.close();
		}
		await fileOperations.rename(temporaryFilePath, destinationFilePath);
		const parentDirectory = await fileOperations.openDirectory(options.workspaceRoot);
		try {
			await parentDirectory.sync();
		} finally {
			await parentDirectory.close();
		}
	} finally {
		await fileOperations.remove(temporaryFilePath);
	}
}

export async function readManagedAgentSelfRevisionManifestFile(options: {
	readonly workspaceRoot: string;
}): Promise<ManagedAgentSelfRevisionManifest> {
	const manifestPath = resolveManifestPath(options.workspaceRoot);
	const manifestFile = await open(manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const contentBuffer = Buffer.alloc(MANAGED_AGENT_SELF_REVISION_MANIFEST_MAXIMUM_BYTES + 1);
		const readResult = await manifestFile.read(contentBuffer, 0, contentBuffer.byteLength, 0);
		if (readResult.bytesRead > MANAGED_AGENT_SELF_REVISION_MANIFEST_MAXIMUM_BYTES) {
			throw new Error('Managed agent self revision manifest exceeds its bounded byte count.');
		}
		let parsedValue: unknown;
		try {
			parsedValue = JSON.parse(contentBuffer.subarray(0, readResult.bytesRead).toString('utf8'));
		} catch (error) {
			throw new Error('Managed agent self revision manifest is not valid JSON.', { cause: error });
		}
		return parseManagedAgentSelfRevisionManifest(parsedValue);
	} finally {
		await manifestFile.close();
	}
}
