import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
	SYSTEM_CACHE_IDENTIFIER_FILENAME,
	buildDefaultSystemCacheIdentifier,
	loadSystemCacheIdentifier,
	resolveSystemCacheIdentifierPath,
} from './system-cache-identifier.js';

describe('system cache identifier', () => {
	it('resolves next to system.json', () => {
		expect(resolveSystemCacheIdentifierPath('/tmp/project/config/system.json')).toBe(
			`/tmp/project/config/${SYSTEM_CACHE_IDENTIFIER_FILENAME}`,
		);
	});

	it('fails when the identifier file is missing', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-cache-id-'));
		const filePath = path.join(temporaryDirectoryPath, SYSTEM_CACHE_IDENTIFIER_FILENAME);

		await expect(loadSystemCacheIdentifier({ filePath })).rejects.toThrow(
			`Missing system cache identifier '${filePath}'`,
		);

		await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('fails when the identifier file is malformed', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-cache-id-'));
		const filePath = path.join(temporaryDirectoryPath, SYSTEM_CACHE_IDENTIFIER_FILENAME);
		await fs.writeFile(filePath, '{not-json', 'utf8');

		await expect(loadSystemCacheIdentifier({ filePath })).rejects.toThrow(
			`Failed to parse system cache identifier '${filePath}'`,
		);

		await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('keeps legacy identifier contents permissive while validating object shape', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-cache-id-'));
		const filePath = path.join(temporaryDirectoryPath, SYSTEM_CACHE_IDENTIFIER_FILENAME);
		const value = {
			$comment: 'example',
			gitSha: 'abc123',
			extra: { nested: true },
		};
		await fs.writeFile(filePath, `${JSON.stringify(value)}\n`, 'utf8');

		await expect(loadSystemCacheIdentifier({ filePath })).resolves.toEqual(value);

		await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('fails closed when a versioned identifier is missing v1 fields', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-cache-id-'));
		const filePath = path.join(temporaryDirectoryPath, SYSTEM_CACHE_IDENTIFIER_FILENAME);
		await fs.writeFile(
			filePath,
			`${JSON.stringify({
				$comment: 'example',
				schemaVersion: 1,
				hostSystemType: 'bare-metal',
			})}\n`,
			'utf8',
		);

		await expect(loadSystemCacheIdentifier({ filePath })).rejects.toThrow(
			`Invalid system cache identifier '${filePath}': v1 schema mismatch.`,
		);

		await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('fails when the identifier file is not a JSON object', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-cache-id-'));
		const filePath = path.join(temporaryDirectoryPath, SYSTEM_CACHE_IDENTIFIER_FILENAME);
		await fs.writeFile(filePath, '"not-an-object"\n', 'utf8');

		await expect(loadSystemCacheIdentifier({ filePath })).rejects.toThrow(
			`Invalid system cache identifier '${filePath}'`,
		);

		await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('rejects obsolete versioned v1 identifier fields', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-cache-id-'));
		const filePath = path.join(temporaryDirectoryPath, SYSTEM_CACHE_IDENTIFIER_FILENAME);
		await fs.writeFile(
			filePath,
			`${JSON.stringify({
				$comment: 'example',
				schemaVersion: 1,
				os: 'windows',
				hostSystemType: 'bare-metal',
				cacheProfile: 'default',
				cacheFormat: 'gondolin-cache-v1',
			})}\n`,
			'utf8',
		);

		await expect(loadSystemCacheIdentifier({ filePath })).rejects.toThrow(
			`Invalid system cache identifier '${filePath}'`,
		);

		await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('loads a valid v1 identifier with the image cache format', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-cache-id-'));
		const filePath = path.join(temporaryDirectoryPath, SYSTEM_CACHE_IDENTIFIER_FILENAME);
		const value = {
			$comment: 'example',
			schemaVersion: 1,
			hostSystemType: 'container',
			imageCacheFormat: 'gondolin-image-cache-v1',
		};
		await fs.writeFile(filePath, `${JSON.stringify(value)}\n`, 'utf8');

		await expect(loadSystemCacheIdentifier({ filePath })).resolves.toEqual(value);

		await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('builds the default bare-metal identifier', () => {
		const identifier = buildDefaultSystemCacheIdentifier();

		expect(identifier).toEqual({
			$comment:
				'Cache compatibility identifier. Contents hash into Gondolin image fingerprints. Change imageCacheFormat when the image cache contract changes.',
			schemaVersion: 1,
			hostSystemType: 'bare-metal',
			imageCacheFormat: 'gondolin-image-cache-v1',
		});
		expect(identifier).not.toHaveProperty('os');
		expect(identifier).not.toHaveProperty('cacheProfile');
		expect(identifier).not.toHaveProperty('cacheFormat');
	});

	it('builds a container identifier without host operating system capture', () => {
		const identifier = buildDefaultSystemCacheIdentifier({
			hostSystemType: 'container',
		});

		expect(identifier).toEqual({
			$comment:
				'Cache compatibility identifier. Contents hash into Gondolin image fingerprints. Change imageCacheFormat when the image cache contract changes.',
			schemaVersion: 1,
			hostSystemType: 'container',
			imageCacheFormat: 'gondolin-image-cache-v1',
		});
		expect(identifier).not.toHaveProperty('os');
		expect(identifier).not.toHaveProperty('cacheProfile');
		expect(identifier).not.toHaveProperty('cacheFormat');
	});

	it('supports overriding the image cache format', () => {
		const identifier = buildDefaultSystemCacheIdentifier({
			imageCacheFormat: 'gondolin-image-cache-v2',
		});

		expect(identifier).toEqual({
			$comment:
				'Cache compatibility identifier. Contents hash into Gondolin image fingerprints. Change imageCacheFormat when the image cache contract changes.',
			schemaVersion: 1,
			hostSystemType: 'bare-metal',
			imageCacheFormat: 'gondolin-image-cache-v2',
		});
	});
});
