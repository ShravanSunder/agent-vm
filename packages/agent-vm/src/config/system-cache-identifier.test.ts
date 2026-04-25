import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
	SYSTEM_CACHE_IDENTIFIER_FILENAME,
	buildDefaultSystemCacheIdentifier,
	captureSystemOsName,
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

	it('returns parsed JSON contents without validating the object shape', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-cache-id-'));
		const filePath = path.join(temporaryDirectoryPath, SYSTEM_CACHE_IDENTIFIER_FILENAME);
		const value = {
			$comment: 'example',
			schemaVersion: 1,
			os: 'linux',
			gitSha: 'abc123',
			extra: { nested: true },
		};
		await fs.writeFile(filePath, `${JSON.stringify(value)}\n`, 'utf8');

		await expect(loadSystemCacheIdentifier({ filePath })).resolves.toEqual(value);

		await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('captures only the supported operating system name', () => {
		expect(captureSystemOsName('darwin')).toBe('darwin');
		expect(captureSystemOsName('linux')).toBe('linux');
		expect(captureSystemOsName('freebsd')).toBe('unknown');
	});

	it('builds the default bare-metal identifier from the platform supplier', () => {
		const identifier = buildDefaultSystemCacheIdentifier({
			platform: () => 'linux',
		});

		expect(identifier).toEqual({
			$comment:
				"System cache identifier. Contents hash into every Gondolin image fingerprint. gitSha='local' is the intentional sentinel for bare-metal dev. Container-host builds usually replace gitSha with a build provenance string such as a commit SHA.",
			schemaVersion: 1,
			os: 'linux',
			hostSystemType: 'bare-metal',
			gitSha: 'local',
		});
	});

	it('builds a container identifier while keeping the operating system host-captured', () => {
		const identifier = buildDefaultSystemCacheIdentifier({
			hostSystemType: 'container',
			platform: () => 'darwin',
		});

		expect(identifier).toEqual({
			$comment:
				"System cache identifier. Contents hash into every Gondolin image fingerprint. gitSha='local' is the intentional sentinel for bare-metal dev. Container-host builds usually replace gitSha with a build provenance string such as a commit SHA.",
			schemaVersion: 1,
			os: 'darwin',
			hostSystemType: 'container',
			gitSha: 'local',
		});
	});

	it('surfaces platform capture failures', () => {
		expect(() =>
			buildDefaultSystemCacheIdentifier({
				platform: () => {
					throw new Error('platform unavailable');
				},
			}),
		).toThrow('platform unavailable');
	});

	it('uses unknown only for unsupported platform names', () => {
		const identifier = buildDefaultSystemCacheIdentifier({
			platform: () => {
				return 'freebsd';
			},
		});

		expect(identifier).toEqual({
			$comment:
				"System cache identifier. Contents hash into every Gondolin image fingerprint. gitSha='local' is the intentional sentinel for bare-metal dev. Container-host builds usually replace gitSha with a build provenance string such as a commit SHA.",
			schemaVersion: 1,
			os: 'unknown',
			hostSystemType: 'bare-metal',
			gitSha: 'local',
		});
	});
});
