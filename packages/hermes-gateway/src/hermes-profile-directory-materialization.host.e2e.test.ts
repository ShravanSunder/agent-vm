import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	stat,
	symlink,
	writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { GatewayZoneConfig } from '@agent-vm/gateway-lifecycle';
import { afterEach, describe, expect, it } from 'vitest';

import { hermesLifecycle } from './hermes-lifecycle.js';

const createdTemporaryDirectories: string[] = [];
const unusedSecretResolver: Parameters<
	NonNullable<(typeof hermesLifecycle)['prepareHostState']>
>[1] = {
	resolve: async () => {
		throw new Error('Hermes profile materialization must not resolve secrets.');
	},
	resolveAll: async () => {
		throw new Error('Hermes profile materialization must not resolve secrets.');
	},
};

async function createTemporaryStateDirectory(): Promise<string> {
	const temporaryDirectoryPath = await mkdtemp(
		path.join(os.tmpdir(), 'agent-vm-hermes-profile-materialization-'),
	);
	createdTemporaryDirectories.push(temporaryDirectoryPath);
	const stateDirectoryPath = path.join(temporaryDirectoryPath, 'state');
	await mkdir(stateDirectoryPath, { mode: 0o755 });
	return stateDirectoryPath;
}

function createHermesZone(options: {
	readonly agents?: readonly string[];
	readonly profilesByAgent?: Readonly<Record<string, string>>;
	readonly stateDirectoryPath: string;
}): GatewayZoneConfig {
	const profilesByAgent = options.profilesByAgent ?? {
		researcher: 'researcher',
		writer: 'writer',
	};
	return {
		agents: (options.agents ?? Object.keys(profilesByAgent)).map((agentId) => ({ id: agentId })),
		egressHosts: [],
		gateway: {
			config: '/deployment/config/hermes.yaml',
			cpus: 2,
			memory: '4G',
			port: 8642,
			profilesByAgent,
			ssh: { secretEnv: 'never' },
			stateDir: options.stateDirectoryPath,
			type: 'hermes',
			zoneFilesDir: '/deployment/zone-files/hermes',
		},
		id: 'hermes-zone',
		secrets: {},
	};
}

async function expectPathNotToExist(filePath: string): Promise<void> {
	await expect(lstat(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
}

afterEach(async () => {
	await Promise.all(
		createdTemporaryDirectories.splice(0).map(async (temporaryDirectoryPath): Promise<void> => {
			await rm(temporaryDirectoryPath, { force: true, recursive: true });
		}),
	);
});

describe('Hermes profile directory materialization', () => {
	it('creates exactly the sorted configured named profile directories with private modes', async () => {
		const stateDirectoryPath = await createTemporaryStateDirectory();
		const zone = createHermesZone({
			profilesByAgent: { writer: 'writer', researcher: 'researcher' },
			stateDirectoryPath,
		});

		await expect(
			hermesLifecycle.preflightHostState?.(zone, unusedSecretResolver),
		).resolves.toBeUndefined();
		await expectPathNotToExist(path.join(stateDirectoryPath, 'profiles'));
		await hermesLifecycle.prepareHostState?.(zone, unusedSecretResolver);

		const profilesDirectoryPath = path.join(stateDirectoryPath, 'profiles');
		const rootConfigurationPath = path.join(stateDirectoryPath, 'config.yaml');
		expect(await readdir(profilesDirectoryPath)).toEqual(['researcher', 'writer']);
		expect(await readFile(rootConfigurationPath, 'utf8')).toBe('{}\n');
		expect((await stat(rootConfigurationPath)).mode & 0o777).toBe(0o600);
		expect((await stat(profilesDirectoryPath)).mode & 0o777).toBe(0o700);
		expect((await stat(path.join(profilesDirectoryPath, 'researcher'))).mode & 0o777).toBe(0o700);
		expect((await stat(path.join(profilesDirectoryPath, 'writer'))).mode & 0o777).toBe(0o700);
	});

	it('preserves an existing regular root config without changing its bytes or mode', async () => {
		const stateDirectoryPath = await createTemporaryStateDirectory();
		const rootConfigurationPath = path.join(stateDirectoryPath, 'config.yaml');
		await writeFile(rootConfigurationPath, 'existing: configuration\n', { mode: 0o640 });
		const zone = createHermesZone({ stateDirectoryPath });

		await expect(
			hermesLifecycle.preflightHostState?.(zone, unusedSecretResolver),
		).resolves.toBeUndefined();
		await hermesLifecycle.prepareHostState?.(zone, unusedSecretResolver);

		expect(await readFile(rootConfigurationPath, 'utf8')).toBe('existing: configuration\n');
		expect((await stat(rootConfigurationPath)).mode & 0o777).toBe(0o640);
	});

	it('rejects a symlinked root config without following or mutating it', async () => {
		const stateDirectoryPath = await createTemporaryStateDirectory();
		const externalConfigurationPath = path.join(
			path.dirname(stateDirectoryPath),
			'external-config.yaml',
		);
		await writeFile(externalConfigurationPath, 'outside: preserved\n', { mode: 0o640 });
		await symlink(externalConfigurationPath, path.join(stateDirectoryPath, 'config.yaml'));
		const zone = createHermesZone({ stateDirectoryPath });

		await expect(hermesLifecycle.preflightHostState?.(zone, unusedSecretResolver)).rejects.toThrow(
			/root config.*symbolic link/u,
		);
		await expect(hermesLifecycle.prepareHostState?.(zone, unusedSecretResolver)).rejects.toThrow(
			/root config.*symbolic link/u,
		);

		expect(await readFile(externalConfigurationPath, 'utf8')).toBe('outside: preserved\n');
		expect((await stat(externalConfigurationPath)).mode & 0o777).toBe(0o640);
	});

	it('rejects a non-regular root config without replacing it', async () => {
		const stateDirectoryPath = await createTemporaryStateDirectory();
		const rootConfigurationPath = path.join(stateDirectoryPath, 'config.yaml');
		await mkdir(rootConfigurationPath, { mode: 0o710 });
		const zone = createHermesZone({ stateDirectoryPath });

		await expect(hermesLifecycle.preflightHostState?.(zone, unusedSecretResolver)).rejects.toThrow(
			/root config.*regular file/u,
		);
		await expect(hermesLifecycle.prepareHostState?.(zone, unusedSecretResolver)).rejects.toThrow(
			/root config.*regular file/u,
		);

		expect((await stat(rootConfigurationPath)).isDirectory()).toBe(true);
		expect((await stat(rootConfigurationPath)).mode & 0o777).toBe(0o710);
	});

	it('is idempotent and preserves existing directory and sentinel file bytes and modes', async () => {
		const stateDirectoryPath = await createTemporaryStateDirectory();
		const zone = createHermesZone({ stateDirectoryPath });
		await hermesLifecycle.prepareHostState?.(zone, unusedSecretResolver);
		const profilesDirectoryPath = path.join(stateDirectoryPath, 'profiles');
		const researcherDirectoryPath = path.join(profilesDirectoryPath, 'researcher');
		const sentinelFilePath = path.join(researcherDirectoryPath, 'session.db');
		await chmod(profilesDirectoryPath, 0o750);
		await chmod(researcherDirectoryPath, 0o710);
		await writeFile(sentinelFilePath, Buffer.from([0, 1, 2, 255]), { mode: 0o640 });

		await hermesLifecycle.prepareHostState?.(zone, unusedSecretResolver);

		expect(await readFile(sentinelFilePath)).toEqual(Buffer.from([0, 1, 2, 255]));
		expect((await stat(sentinelFilePath)).mode & 0o777).toBe(0o640);
		expect((await stat(researcherDirectoryPath)).mode & 0o777).toBe(0o710);
		expect((await stat(profilesDirectoryPath)).mode & 0o777).toBe(0o750);
	});

	it('adds only a newly configured profile while preserving existing profile contents', async () => {
		const stateDirectoryPath = await createTemporaryStateDirectory();
		const initialZone = createHermesZone({
			profilesByAgent: { researcher: 'researcher' },
			stateDirectoryPath,
		});
		await hermesLifecycle.prepareHostState?.(initialZone, unusedSecretResolver);
		const profilesDirectoryPath = path.join(stateDirectoryPath, 'profiles');
		const researcherDirectoryPath = path.join(profilesDirectoryPath, 'researcher');
		const sentinelFilePath = path.join(researcherDirectoryPath, 'session.json');
		await writeFile(sentinelFilePath, 'preserve-me', { mode: 0o600 });
		await chmod(researcherDirectoryPath, 0o750);
		const expandedZone = createHermesZone({
			profilesByAgent: { writer: 'writer', researcher: 'researcher' },
			stateDirectoryPath,
		});

		await hermesLifecycle.prepareHostState?.(expandedZone, unusedSecretResolver);

		expect(await readdir(profilesDirectoryPath)).toEqual(['researcher', 'writer']);
		expect(await readFile(sentinelFilePath, 'utf8')).toBe('preserve-me');
		expect((await stat(sentinelFilePath)).mode & 0o777).toBe(0o600);
		expect((await stat(researcherDirectoryPath)).mode & 0o777).toBe(0o750);
		expect((await stat(path.join(profilesDirectoryPath, 'writer'))).mode & 0o777).toBe(0o700);
	});

	it.each(['stale', 'default', 'Invalid!'])(
		'rejects unexpected existing profile directory %s without deleting or mutating contents',
		async (unexpectedProfileName) => {
			const stateDirectoryPath = await createTemporaryStateDirectory();
			const profilesDirectoryPath = path.join(stateDirectoryPath, 'profiles');
			const unexpectedDirectoryPath = path.join(profilesDirectoryPath, unexpectedProfileName);
			const sentinelFilePath = path.join(unexpectedDirectoryPath, 'sentinel.bin');
			await mkdir(path.join(profilesDirectoryPath, 'researcher'), {
				mode: 0o750,
				recursive: true,
			});
			await mkdir(unexpectedDirectoryPath, { mode: 0o711 });
			await writeFile(sentinelFilePath, Buffer.from([3, 4, 5]), { mode: 0o640 });
			const zone = createHermesZone({
				profilesByAgent: { researcher: 'researcher' },
				stateDirectoryPath,
			});

			await expect(
				hermesLifecycle.preflightHostState?.(zone, unusedSecretResolver),
			).rejects.toThrow(/unexpected profile entry/u);
			await expect(hermesLifecycle.prepareHostState?.(zone, unusedSecretResolver)).rejects.toThrow(
				/unexpected profile entry/u,
			);

			expect(await readFile(sentinelFilePath)).toEqual(Buffer.from([3, 4, 5]));
			expect((await stat(sentinelFilePath)).mode & 0o777).toBe(0o640);
			expect((await stat(unexpectedDirectoryPath)).mode & 0o777).toBe(0o711);
			expect((await stat(path.join(profilesDirectoryPath, 'researcher'))).mode & 0o777).toBe(0o750);
		},
	);

	it('rejects a file at an expected profile path without overwriting it', async () => {
		const stateDirectoryPath = await createTemporaryStateDirectory();
		const profilesDirectoryPath = path.join(stateDirectoryPath, 'profiles');
		const profileFilePath = path.join(profilesDirectoryPath, 'researcher');
		await mkdir(profilesDirectoryPath, { mode: 0o700 });
		await writeFile(profileFilePath, 'not-a-directory', { mode: 0o640 });
		const zone = createHermesZone({
			profilesByAgent: { researcher: 'researcher' },
			stateDirectoryPath,
		});

		await expect(hermesLifecycle.prepareHostState?.(zone, unusedSecretResolver)).rejects.toThrow(
			/must be a directory/u,
		);

		expect(await readFile(profileFilePath, 'utf8')).toBe('not-a-directory');
		expect((await stat(profileFilePath)).mode & 0o777).toBe(0o640);
	});

	it('rejects a profiles root file without replacing it', async () => {
		const stateDirectoryPath = await createTemporaryStateDirectory();
		const profilesDirectoryPath = path.join(stateDirectoryPath, 'profiles');
		await writeFile(profilesDirectoryPath, 'not-a-directory', { mode: 0o640 });
		const zone = createHermesZone({ stateDirectoryPath });

		await expect(hermesLifecycle.prepareHostState?.(zone, unusedSecretResolver)).rejects.toThrow(
			/profiles root.*must be a directory/u,
		);

		expect(await readFile(profilesDirectoryPath, 'utf8')).toBe('not-a-directory');
		expect((await stat(profilesDirectoryPath)).mode & 0o777).toBe(0o640);
	});

	it('rejects a symlinked profiles root without following or mutating it', async () => {
		const stateDirectoryPath = await createTemporaryStateDirectory();
		const externalDirectoryPath = path.join(path.dirname(stateDirectoryPath), 'external-profiles');
		const externalSentinelPath = path.join(externalDirectoryPath, 'sentinel');
		await mkdir(externalDirectoryPath, { mode: 0o711 });
		await writeFile(externalSentinelPath, 'outside', { mode: 0o640 });
		await symlink(externalDirectoryPath, path.join(stateDirectoryPath, 'profiles'));
		const zone = createHermesZone({ stateDirectoryPath });

		await expect(hermesLifecycle.preflightHostState?.(zone, unusedSecretResolver)).rejects.toThrow(
			/profiles root.*symbolic link/u,
		);
		await expect(hermesLifecycle.prepareHostState?.(zone, unusedSecretResolver)).rejects.toThrow(
			/profiles root.*symbolic link/u,
		);

		expect(await readFile(externalSentinelPath, 'utf8')).toBe('outside');
		expect((await stat(externalSentinelPath)).mode & 0o777).toBe(0o640);
	});

	it('rejects a symlinked expected profile without following or mutating it', async () => {
		const stateDirectoryPath = await createTemporaryStateDirectory();
		const profilesDirectoryPath = path.join(stateDirectoryPath, 'profiles');
		const externalDirectoryPath = path.join(path.dirname(stateDirectoryPath), 'external-profile');
		const externalSentinelPath = path.join(externalDirectoryPath, 'sentinel');
		await mkdir(profilesDirectoryPath, { mode: 0o700 });
		await mkdir(externalDirectoryPath, { mode: 0o711 });
		await writeFile(externalSentinelPath, 'outside', { mode: 0o640 });
		await symlink(externalDirectoryPath, path.join(profilesDirectoryPath, 'researcher'));
		const zone = createHermesZone({
			profilesByAgent: { researcher: 'researcher' },
			stateDirectoryPath,
		});

		await expect(hermesLifecycle.preflightHostState?.(zone, unusedSecretResolver)).rejects.toThrow(
			/profile 'researcher'.*symbolic link/u,
		);
		await expect(hermesLifecycle.prepareHostState?.(zone, unusedSecretResolver)).rejects.toThrow(
			/profile 'researcher'.*symbolic link/u,
		);

		expect(await readFile(externalSentinelPath, 'utf8')).toBe('outside');
		expect((await stat(externalSentinelPath)).mode & 0o777).toBe(0o640);
	});

	it.each([
		{
			agents: ['researcher', 'writer'],
			expectedMessage: /missing configured agent 'writer'/u,
			profilesByAgent: { researcher: 'researcher' },
		},
		{
			agents: ['researcher'],
			expectedMessage: /undeclared agent 'writer'/u,
			profilesByAgent: { researcher: 'researcher', writer: 'writer' },
		},
		{
			agents: ['researcher'],
			expectedMessage: /profile 'Invalid!'.*normalized/u,
			profilesByAgent: { researcher: 'Invalid!' },
		},
		{
			agents: ['researcher'],
			expectedMessage: /profile 'default'.*not admitted/u,
			profilesByAgent: { researcher: 'default' },
		},
		{
			agents: ['researcher', 'writer'],
			expectedMessage: /profile 'shared'.*multiple agents/u,
			profilesByAgent: { researcher: 'shared', writer: 'shared' },
		},
	])(
		'rejects invalid profile assignment input before filesystem mutation',
		async ({ agents, expectedMessage, profilesByAgent }) => {
			const stateDirectoryPath = await createTemporaryStateDirectory();
			const zone = createHermesZone({ agents, profilesByAgent, stateDirectoryPath });

			await expect(hermesLifecycle.prepareHostState?.(zone, unusedSecretResolver)).rejects.toThrow(
				expectedMessage,
			);

			await expectPathNotToExist(path.join(stateDirectoryPath, 'profiles'));
		},
	);
});
