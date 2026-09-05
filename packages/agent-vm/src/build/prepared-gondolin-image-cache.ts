import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
	hasManagedVmImageAssets,
	type ManagedGatewayImageBootProjection,
} from './gondolin-managed-vm-build-tooling.js';
import { computeFingerprintFromConfigPath } from './gondolin-image-builder.js';

const preparedImageSelectionSchemaVersion = 3;
const fingerprintPattern = /^[a-f0-9]{16}$/u;

interface PreparedImageBuildResult {
	readonly built: boolean;
	readonly fingerprint: string;
	readonly imagePath: string;
}

export interface PreparedManagedVmImage extends PreparedImageBuildResult {
	readonly fingerprintInput?: unknown;
	readonly managedGatewayBoot?: ManagedGatewayImageBootProjection;
}

export interface WritePreparedManagedVmImageOptions {
	readonly buildConfigPath: string;
	readonly fingerprint: string;
	readonly fingerprintInput?: unknown;
	readonly imagePath: string;
	readonly managedGatewayBoot?: ManagedGatewayImageBootProjection;
	readonly selectionRecordPath: string;
	readonly sharedImageCacheDir: string;
}

interface PreparedManagedVmImageSelectionRecord {
	readonly fingerprint: string;
	readonly fingerprintInput?: unknown;
	readonly managedGatewayBoot?: ManagedGatewayImageBootProjection;
	readonly recipeIdentity: string;
	readonly schemaVersion: 3;
}

export function configuredImageSelectionRecordPath(options: {
	readonly deploymentGeneratedDir: string;
	readonly family: 'gateway' | 'toolVm';
	readonly profileName: string;
}): string {
	return path.join(
		options.deploymentGeneratedDir,
		'image-selections',
		options.family,
		`${options.profileName}.json`,
	);
}

function parseManagedGatewayBootProjection(
	value: unknown,
): ManagedGatewayImageBootProjection | undefined {
	if (!isRecord(value) || value.kind !== 'managed-gateway-exact-two-role') return undefined;
	if (value.frameworkBootEntry !== 'hermes-framework-service') return undefined;
	if (Object.keys(value).length !== 2) return undefined;
	return {
		frameworkBootEntry: value.frameworkBootEntry,
		kind: value.kind,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function parsePreparedManagedVmImageSelectionRecord(
	value: unknown,
): PreparedManagedVmImageSelectionRecord | undefined {
	if (!isRecord(value) || value.schemaVersion !== preparedImageSelectionSchemaVersion) {
		return undefined;
	}
	if (typeof value.recipeIdentity !== 'string' || value.recipeIdentity.length === 0) {
		return undefined;
	}
	if (typeof value.fingerprint !== 'string' || !fingerprintPattern.test(value.fingerprint)) {
		return undefined;
	}
	const managedGatewayBoot =
		value.managedGatewayBoot === undefined
			? undefined
			: parseManagedGatewayBootProjection(value.managedGatewayBoot);
	if (value.managedGatewayBoot !== undefined && managedGatewayBoot === undefined) return undefined;
	return {
		fingerprint: value.fingerprint,
		...(value.fingerprintInput === undefined ? {} : { fingerprintInput: value.fingerprintInput }),
		...(managedGatewayBoot === undefined ? {} : { managedGatewayBoot }),
		recipeIdentity: value.recipeIdentity,
		schemaVersion: preparedImageSelectionSchemaVersion,
	};
}

function isContainedPath(parentPath: string, candidatePath: string): boolean {
	const relativePath = path.relative(parentPath, candidatePath);
	return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

async function readSelectionRecord(selectionRecordPath: string): Promise<unknown | undefined> {
	try {
		return JSON.parse(await fs.readFile(selectionRecordPath, 'utf8'));
	} catch (error) {
		if (
			(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') ||
			error instanceof SyntaxError
		) {
			return undefined;
		}
		throw error;
	}
}

export async function readPreparedManagedVmImage(options: {
	readonly buildConfigPath: string;
	readonly expectedManagedGatewayBoot?: ManagedGatewayImageBootProjection | undefined;
	readonly selectionRecordPath: string;
	readonly sharedImageCacheDir: string;
}): Promise<PreparedManagedVmImage | undefined> {
	const record = parsePreparedManagedVmImageSelectionRecord(
		await readSelectionRecord(options.selectionRecordPath),
	);
	if (!record) return undefined;
	if (record.managedGatewayBoot?.kind !== options.expectedManagedGatewayBoot?.kind || record.managedGatewayBoot?.frameworkBootEntry !== options.expectedManagedGatewayBoot?.frameworkBootEntry) return undefined;

	let expectedFingerprint: string;
	try {
		const recipeIdentity = await fs.realpath(options.buildConfigPath);
		if (record.recipeIdentity !== recipeIdentity) return undefined;
		expectedFingerprint = await computeFingerprintFromConfigPath(options.buildConfigPath, {
			...(record.fingerprintInput === undefined ? {} : { fingerprintInput: record.fingerprintInput }),
			...(record.managedGatewayBoot === undefined ? {} : { managedGatewayBoot: record.managedGatewayBoot }),
		});
	} catch {
		return undefined;
	}
	if (record.fingerprint !== expectedFingerprint) return undefined;

	const imagePath = path.join(options.sharedImageCacheDir, record.fingerprint);
	if (!isContainedPath(path.resolve(options.sharedImageCacheDir), path.resolve(imagePath))) {
		return undefined;
	}
	if (!(await hasManagedVmImageAssets(imagePath))) return undefined;
	const [canonicalSharedImageCacheDir, canonicalImagePath] = await Promise.all([
		fs.realpath(options.sharedImageCacheDir),
		fs.realpath(imagePath),
	]);
	if (!isContainedPath(canonicalSharedImageCacheDir, canonicalImagePath)) return undefined;

	return {
		built: false,
		fingerprint: record.fingerprint,
		fingerprintInput: record.fingerprintInput,
		imagePath: canonicalImagePath,
		...(record.managedGatewayBoot === undefined
			? {}
			: { managedGatewayBoot: record.managedGatewayBoot }),
	};
}

export async function writePreparedManagedVmImage(
	options: WritePreparedManagedVmImageOptions,
): Promise<void> {
	if (!fingerprintPattern.test(options.fingerprint)) {
		throw new Error(`Invalid managed VM image fingerprint '${options.fingerprint}'.`);
	}
	const expectedImagePath = path.join(options.sharedImageCacheDir, options.fingerprint);
	if (!(await hasManagedVmImageAssets(expectedImagePath))) {
		throw new Error(`Managed VM image artifact is incomplete at '${expectedImagePath}'.`);
	}
	const [
		recipeIdentity,
		canonicalSharedImageCacheDir,
		canonicalImagePath,
		canonicalProvidedImagePath,
	] = await Promise.all([
		fs.realpath(options.buildConfigPath),
		fs.realpath(options.sharedImageCacheDir),
		fs.realpath(expectedImagePath),
		fs.realpath(options.imagePath),
	]);
	if (canonicalProvidedImagePath !== canonicalImagePath) {
		throw new Error(
			`Managed VM image path '${options.imagePath}' does not match shared artifact path '${expectedImagePath}'.`,
		);
	}
	if (!isContainedPath(canonicalSharedImageCacheDir, canonicalImagePath)) {
		throw new Error(`Managed VM image artifact escapes shared image cache: '${canonicalImagePath}'.`);
	}

	const record: PreparedManagedVmImageSelectionRecord = {
		fingerprint: options.fingerprint,
		...(options.fingerprintInput === undefined
			? {}
			: { fingerprintInput: options.fingerprintInput }),
		...(options.managedGatewayBoot === undefined
			? {}
			: { managedGatewayBoot: options.managedGatewayBoot }),
		recipeIdentity,
		schemaVersion: preparedImageSelectionSchemaVersion,
	};
	await fs.mkdir(path.dirname(options.selectionRecordPath), { recursive: true });
	const temporaryRecordPath = `${options.selectionRecordPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
	await fs.writeFile(temporaryRecordPath, `${JSON.stringify(record, null, '\t')}\n`, 'utf8');
	await fs.rename(temporaryRecordPath, options.selectionRecordPath);
}
