import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MemoryProvider, type VirtualProvider } from '@earendil-works/gondolin';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	assertPinnedRealFsRoot,
	closePinnedRealFsRoot,
	createPinnedRealFsProvider,
	pinRealFsRoot,
	type PinnedRealFsRoot,
} from './pinned-realfs.js';

const createdDirectories: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const directoryPath of createdDirectories.splice(0)) {
		fs.rmSync(directoryPath, { recursive: true, force: true });
	}
});

function createTemporaryDirectory(): string {
	const directoryPath = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-vm-pinned-realfs-'));
	createdDirectories.push(directoryPath);
	return directoryPath;
}

function createProvider(): VirtualProvider {
	return new MemoryProvider();
}

describe('pinned RealFS roots', () => {
	it('pins the directory identity and closes the pinned fd', () => {
		const hostRealFsDirectory = path.join(createTemporaryDirectory(), 'realfs-root');
		fs.mkdirSync(hostRealFsDirectory);

		const root = pinRealFsRoot(hostRealFsDirectory);

		expect(root.realPath).toBe(fs.realpathSync(hostRealFsDirectory));
		expect(fs.fstatSync(root.fd).isDirectory()).toBe(true);

		const closeSyncSpy = vi.spyOn(fs, 'closeSync');
		closePinnedRealFsRoot(root);

		expect(closeSyncSpy).toHaveBeenCalledExactlyOnceWith(root.fd);
	});

	it('terminally closes one root capability once and cannot act on a reused fd', () => {
		const reusedFd = 42;
		const root = {
			device: 1,
			fd: reusedFd,
			hostPath: '/tmp/pinned-root',
			inode: 2,
			realPath: '/tmp/pinned-root',
		} satisfies PinnedRealFsRoot;
		const closeSyncSpy = vi.spyOn(fs, 'closeSync').mockImplementation(() => undefined);

		closePinnedRealFsRoot(root);
		closePinnedRealFsRoot(root);

		expect(closeSyncSpy).toHaveBeenCalledExactlyOnceWith(reusedFd);
	});

	it('detects a root path swap before provider operations reach Gondolin RealFS', () => {
		const temporaryDirectory = createTemporaryDirectory();
		const hostRealFsDirectory = path.join(temporaryDirectory, 'realfs-root');
		const movedHostRealFsDirectory = path.join(temporaryDirectory, 'realfs-root-old');
		fs.mkdirSync(hostRealFsDirectory);
		const root = pinRealFsRoot(hostRealFsDirectory);
		const provider = createProvider();
		const readdirSyncSpy = vi.spyOn(provider, 'readdirSync');
		const pinnedProvider = createPinnedRealFsProvider({
			createRealFsProvider: () => provider,
			root,
		});

		fs.renameSync(hostRealFsDirectory, movedHostRealFsDirectory);
		fs.mkdirSync(hostRealFsDirectory);

		expect(() => pinnedProvider.readdirSync('/')).toThrow(/Pinned RealFS root changed/u);
		expect(readdirSyncSpy).not.toHaveBeenCalled();

		closePinnedRealFsRoot(root);
	});

	it('rejects a final symlink when pinning a RealFS root', () => {
		const temporaryDirectory = createTemporaryDirectory();
		const hostRealFsDirectory = path.join(temporaryDirectory, 'realfs-root');
		const symlinkPath = path.join(temporaryDirectory, 'realfs-root-link');
		fs.mkdirSync(hostRealFsDirectory);
		fs.symlinkSync(hostRealFsDirectory, symlinkPath);

		expect(() => pinRealFsRoot(symlinkPath)).toThrow();
	});

	it('allows provider operations while the root identity is unchanged', () => {
		const hostRealFsDirectory = path.join(createTemporaryDirectory(), 'realfs-root');
		fs.mkdirSync(hostRealFsDirectory);
		const root = pinRealFsRoot(hostRealFsDirectory);
		const provider = createProvider();
		const readdirSyncSpy = vi.spyOn(provider, 'readdirSync');
		const pinnedProvider = createPinnedRealFsProvider({
			createRealFsProvider: () => provider,
			root,
		});

		assertPinnedRealFsRoot(root);
		pinnedProvider.readdirSync('/');

		expect(readdirSyncSpy).toHaveBeenCalledWith('/');

		closePinnedRealFsRoot(root);
	});
});
