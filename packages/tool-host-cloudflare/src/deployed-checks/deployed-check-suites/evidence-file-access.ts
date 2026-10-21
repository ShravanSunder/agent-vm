import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { z } from 'zod';

import type { PrivateDeployFile } from '#worker-host/deployed-checks/deploy-configuration/models/private-deploy-file';
import { requireOutsideGitWorkTree } from '#worker-host/deployed-checks/deploy-configuration/private-file-access';
import {
	tailRecordSchema,
	type TailRecord,
} from '#worker-host/deployed-checks/deployed-check-suites/models/deployed-evidence';

export async function writeRunArtifact(
	configuration: PrivateDeployFile,
	name: string,
	value: unknown,
): Promise<void> {
	const directory = await requireOutsideGitWorkTree(configuration.evidenceDirectory);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const file = await requireOutsideGitWorkTree(path.join(directory, name));
	await writeFile(file, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
}
export async function readEvidenceJson<TSchema extends z.ZodType>(
	file: string,
	schema: TSchema,
): Promise<z.output<TSchema>> {
	const canonical = await requireOutsideGitWorkTree(file);
	if (((await stat(canonical)).mode & 0o777) !== 0o600)
		throw new Error('Evidence files must have mode 0600.');
	try {
		return schema.parse(JSON.parse(await readFile(canonical, 'utf8')));
	} catch {
		throw new Error('Evidence file is missing valid observations.');
	}
}
export async function readCurrentRunLogs(
	configuration: PrivateDeployFile,
	runId: string,
	startedAt: number,
	endedAt: number,
): Promise<TailRecord[]> {
	const file = await requireOutsideGitWorkTree(configuration.logFile);
	if (((await stat(file)).mode & 0o777) !== 0o600)
		throw new Error('Log evidence file must have mode 0600.');
	const text = await readFile(file, 'utf8');
	let values: unknown[];
	try {
		const value: unknown = JSON.parse(text);
		values = Array.isArray(value) ? value : [value];
	} catch {
		try {
			values = text
				.split('\n')
				.filter((line) => line.trim() !== '')
				.map((line): unknown => JSON.parse(line));
		} catch {
			throw new Error('Expected Wrangler tail JSON or JSONL, without CLI preamble.');
		}
	}
	const records = values.flatMap((value) => {
		const parsed = tailRecordSchema.safeParse(value);
		return parsed.success ? [parsed.data] : [];
	});
	const current = records.filter((record) => {
		try {
			return (
				new URL(record.event.request.url).searchParams.get('runId') === runId &&
				record.eventTimestamp >= startedAt &&
				record.eventTimestamp <= endedAt
			);
		} catch {
			return false;
		}
	});
	if (current.length === 0)
		throw new Error(
			'No logs from the current run/time window. Capture a fresh tail and rerun the evidence step.',
		);
	return current;
}
