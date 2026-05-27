import fs from 'node:fs/promises';
import path from 'node:path';

import { hasBuiltImageAssets, type BuildImageResult } from '@agent-vm/gondolin-adapter';

const preparedImageRecordFileName = 'prepared-image.json';
const preparedImageRecordSchemaVersion = 1;

export interface PreparedGondolinImage extends BuildImageResult {
	readonly fingerprintInput?: unknown;
}

export interface WritePreparedGondolinImageOptions {
	readonly buildConfigPath: string;
	readonly cacheDir: string;
	readonly fingerprint: string;
	readonly fingerprintInput?: unknown;
	readonly imagePath: string;
}

interface PreparedGondolinImageRecord {
	readonly buildConfigPath: string;
	readonly fingerprint: string;
	readonly fingerprintInput?: unknown;
	readonly imagePath: string;
	readonly schemaVersion: 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function preparedImageRecordPath(cacheDir: string): string {
	return path.join(cacheDir, preparedImageRecordFileName);
}

function parsePreparedGondolinImageRecord(value: unknown): PreparedGondolinImageRecord | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	if (value.schemaVersion !== preparedImageRecordSchemaVersion) {
		return undefined;
	}
	if (typeof value.buildConfigPath !== 'string' || value.buildConfigPath.length === 0) {
		return undefined;
	}
	if (typeof value.fingerprint !== 'string' || value.fingerprint.length === 0) {
		return undefined;
	}
	if (typeof value.imagePath !== 'string' || value.imagePath.length === 0) {
		return undefined;
	}
	return {
		buildConfigPath: value.buildConfigPath,
		fingerprint: value.fingerprint,
		...(value.fingerprintInput === undefined ? {} : { fingerprintInput: value.fingerprintInput }),
		imagePath: value.imagePath,
		schemaVersion: preparedImageRecordSchemaVersion,
	};
}

export async function readPreparedGondolinImage(options: {
	readonly buildConfigPath: string;
	readonly cacheDir: string;
}): Promise<PreparedGondolinImage | undefined> {
	let parsedRecord: unknown;
	try {
		parsedRecord = JSON.parse(await fs.readFile(preparedImageRecordPath(options.cacheDir), 'utf8'));
	} catch (error) {
		if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
			return undefined;
		}
		throw error;
	}

	const record = parsePreparedGondolinImageRecord(parsedRecord);
	if (!record) {
		return undefined;
	}
	if (path.resolve(record.buildConfigPath) !== path.resolve(options.buildConfigPath)) {
		return undefined;
	}

	const imagePath = path.join(options.cacheDir, record.fingerprint);
	if (path.resolve(record.imagePath) !== path.resolve(imagePath)) {
		return undefined;
	}
	if (!(await hasBuiltImageAssets(imagePath))) {
		return undefined;
	}

	return {
		built: false,
		fingerprint: record.fingerprint,
		fingerprintInput: record.fingerprintInput,
		imagePath,
	};
}

export async function writePreparedGondolinImage(
	options: WritePreparedGondolinImageOptions,
): Promise<void> {
	if (!(await hasBuiltImageAssets(options.imagePath))) {
		return;
	}
	await fs.mkdir(options.cacheDir, { recursive: true });
	const record: PreparedGondolinImageRecord = {
		buildConfigPath: path.resolve(options.buildConfigPath),
		fingerprint: options.fingerprint,
		...(options.fingerprintInput === undefined
			? {}
			: { fingerprintInput: options.fingerprintInput }),
		imagePath: path.resolve(options.imagePath),
		schemaVersion: preparedImageRecordSchemaVersion,
	};
	const recordPath = preparedImageRecordPath(options.cacheDir);
	const temporaryRecordPath = `${recordPath}.${process.pid}.tmp`;
	await fs.writeFile(temporaryRecordPath, `${JSON.stringify(record, null, "\t")}\n`, 'utf8');
	await fs.rename(temporaryRecordPath, recordPath);
}
