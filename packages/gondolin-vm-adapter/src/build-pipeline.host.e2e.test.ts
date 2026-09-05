import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { buildImageAssetFileNames } from './build-pipeline.js';

const temporaryDirectories: string[] = [];

function startPublisher(options: { readonly cacheDir: string; readonly publisherId: string }): {
	readonly ready: Promise<void>;
	readonly release: () => void;
	readonly result: Promise<{
		readonly built: boolean;
		readonly fingerprint: string;
		readonly imagePath: string;
	}>;
} {
	const childFixturePath = fileURLToPath(
		new URL('./test-fixtures/build-pipeline-publication-child.ts', import.meta.url),
	);
	const childProcess = spawn(
		process.execPath,
		['--import', 'tsx', childFixturePath, options.cacheDir, options.publisherId],
		{ stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
	);
	if (childProcess.stdout === null || childProcess.stderr === null) {
		throw new Error('Expected publisher stdout and stderr pipes.');
	}
	const childStdout = childProcess.stdout;
	const childStderr = childProcess.stderr;
	let resolveReady: (() => void) | undefined;
	const ready = new Promise<void>((resolve) => {
		resolveReady = resolve;
	});
	childProcess.on('message', (message: unknown) => {
		if (
			typeof message === 'object' &&
			message !== null &&
			'type' in message &&
			message.type === 'ready'
		) {
			resolveReady?.();
		}
	});
	const result = new Promise<{
		readonly built: boolean;
		readonly fingerprint: string;
		readonly imagePath: string;
	}>((resolve, reject) => {
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		childStdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
		childStderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
		childProcess.once('error', reject);
		childProcess.once('close', (exitCode) => {
			const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim();
			if (exitCode !== 0) {
				reject(
					new Error(
						`Publisher ${options.publisherId} exited ${String(exitCode)}: ${Buffer.concat(stderrChunks).toString('utf8')}`,
					),
				);
				return;
			}
			resolve(JSON.parse(stdout) as { built: boolean; fingerprint: string; imagePath: string });
		});
	});
	return {
		ready,
		release: () => childProcess.send({ type: 'release' }),
		result,
	};
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map(async (directoryPath) => await fs.rm(directoryPath, { force: true, recursive: true })),
	);
});

describe('shared image publication across processes', () => {
	it('publishes one complete immutable fingerprint when two processes build concurrently', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-image-publication-'));
		temporaryDirectories.push(root);
		const cacheDir = path.join(root, 'vm-images');
		const publishers = ['first', 'second'].map((publisherId) =>
			startPublisher({ cacheDir, publisherId }),
		);
		await Promise.all(publishers.map((publisher) => publisher.ready));
		for (const publisher of publishers) publisher.release();

		const results = await Promise.all(publishers.map((publisher) => publisher.result));
		expect(
			results
				.map((result) => result.built)
				.toSorted((leftBuilt, rightBuilt) => Number(leftBuilt) - Number(rightBuilt)),
		).toEqual([false, true]);
		expect(new Set(results.map((result) => result.fingerprint))).toHaveLength(1);
		expect(new Set(results.map((result) => result.imagePath))).toHaveLength(1);
		const [imagePath] = new Set(results.map((result) => result.imagePath));
		if (imagePath === undefined) throw new Error('Expected one published image path.');
		const assetContents = await Promise.all(
			buildImageAssetFileNames.map(
				async (fileName) => await fs.readFile(path.join(imagePath, fileName), 'utf8'),
			),
		);
		expect(new Set(assetContents).size).toBe(1);
		const cacheEntries = await fs.readdir(cacheDir);
		expect(cacheEntries).toEqual([results[0]?.fingerprint]);
	});
});
