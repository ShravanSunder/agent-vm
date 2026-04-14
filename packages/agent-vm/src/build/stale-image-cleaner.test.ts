import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
	deleteStaleImageDirectories,
	findStaleImageDirectories,
} from './stale-image-cleaner.js';

const createdDirectories: string[] = [];

afterEach(() => {
	for (const directoryPath of createdDirectories.splice(0)) {
		fs.rmSync(directoryPath, { force: true, recursive: true });
	}
});

function createTemporaryDirectory(): string {
	const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-vm-stale-images-'));
	createdDirectories.push(temporaryDirectory);
	return temporaryDirectory;
}

describe('findStaleImageDirectories', () => {
	it('returns only stale fingerprint directories for each image type', () => {
		const cacheDirectory = createTemporaryDirectory();
		const currentGatewayDirectory = path.join(cacheDirectory, 'images', 'gateway', 'current-gateway');
		const staleGatewayDirectory = path.join(cacheDirectory, 'images', 'gateway', 'stale-gateway');
		const currentToolDirectory = path.join(cacheDirectory, 'images', 'tool', 'current-tool');
		const staleToolDirectory = path.join(cacheDirectory, 'images', 'tool', 'stale-tool');
		fs.mkdirSync(currentGatewayDirectory, { recursive: true });
		fs.mkdirSync(staleGatewayDirectory, { recursive: true });
		fs.mkdirSync(currentToolDirectory, { recursive: true });
		fs.mkdirSync(staleToolDirectory, { recursive: true });
		fs.writeFileSync(path.join(staleGatewayDirectory, 'manifest.json'), 'gateway');
		fs.writeFileSync(path.join(staleToolDirectory, 'manifest.json'), 'tool');

		const staleEntries = findStaleImageDirectories({
			cacheDir: cacheDirectory,
			currentFingerprints: {
				gateway: 'current-gateway',
				tool: 'current-tool',
			},
		});

		expect(staleEntries.map((entry) => `${entry.imageType}/${entry.name}`)).toEqual([
			'gateway/stale-gateway',
			'tool/stale-tool',
		]);
		expect(staleEntries.every((entry) => entry.sizeBytes > 0)).toBe(true);
	});

	it('returns an empty list when the cache tree does not exist', () => {
		expect(
			findStaleImageDirectories({
				cacheDir: path.join(createTemporaryDirectory(), 'missing-cache'),
				currentFingerprints: {
					gateway: 'gateway',
					tool: 'tool',
				},
			}),
		).toEqual([]);
	});
});

describe('deleteStaleImageDirectories', () => {
	it('removes every provided stale image directory', () => {
		const cacheDirectory = createTemporaryDirectory();
		const staleDirectory = path.join(cacheDirectory, 'images', 'gateway', 'stale-gateway');
		fs.mkdirSync(staleDirectory, { recursive: true });
		fs.writeFileSync(path.join(staleDirectory, 'manifest.json'), 'gateway');

		deleteStaleImageDirectories([
			{
				absolutePath: staleDirectory,
				imageType: 'gateway',
				name: 'stale-gateway',
				sizeBytes: 7,
			},
		]);

		expect(fs.existsSync(staleDirectory)).toBe(false);
	});
});
