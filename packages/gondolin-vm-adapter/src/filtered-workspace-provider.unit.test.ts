import {
	MemoryProvider,
	ShadowProvider,
	ERRNO,
	createShadowPathPredicate,
	type ShadowProviderOptions,
	type VirtualProvider,
} from '@earendil-works/gondolin';
import { describe, expect, it, vi } from 'vitest';

import {
	createFilteredWorkspaceProvider,
	type FilteredWorkspaceProviderDependencies,
} from './filtered-workspace-provider.js';
import { createHardenedReadonlyProvider } from './vm-adapter.js';

function writeProviderFile(provider: VirtualProvider, filePath: string, contents: string): void {
	const handle = provider.openSync(filePath, 'w', 0o600);
	handle.writeFileSync(contents);
	handle.closeSync();
}

function createWorkspaceSource(): MemoryProvider {
	const source = new MemoryProvider();
	source.mkdirSync('/notes', { recursive: true });
	source.mkdirSync('/node_modules', { recursive: true });
	source.mkdirSync('/private', { recursive: true });
	source.mkdirSync('/reviewed/skill', { recursive: true });
	writeProviderFile(source, '/notes/visible.txt', 'visible');
	writeProviderFile(source, '/notes/private.txt', 'hidden');
	writeProviderFile(source, '/node_modules/host.js', 'host dependency');
	writeProviderFile(source, '/private/secret.txt', 'secret');
	writeProviderFile(source, '/reviewed-note.txt', 'reviewed note');
	writeProviderFile(source, '/reviewed/skill/SKILL.md', 'reviewed skill');
	return source;
}

function createDependencies(): FilteredWorkspaceProviderDependencies {
	return {
		createMemoryProvider: vi.fn(() => new MemoryProvider()),
		createReadonlyProvider: vi.fn(createHardenedReadonlyProvider),
		createShadowPathPredicate: vi.fn((paths: readonly string[]) =>
			createShadowPathPredicate([...paths]),
		),
		createShadowProvider: vi.fn(
			(provider: VirtualProvider, options: ShadowProviderOptions) =>
				new ShadowProvider(provider, options),
		),
	};
}

describe('filtered workspace Gondolin provider', () => {
	it('confines nested readonly inputs to their selected source subtree', async () => {
		const source = createWorkspaceSource();
		writeProviderFile(source, '/outside.txt', 'outside file');
		source.mkdirSync('/outside-directory', { recursive: true });
		writeProviderFile(source, '/outside-directory/secret.txt', 'outside directory');
		if (!source.symlinkSync) {
			throw new Error('MemoryProvider must support symlinks for this confinement test.');
		}
		source.symlinkSync('../../outside.txt', '/reviewed/skill/relative-file-escape');
		source.symlinkSync('/outside-directory', '/reviewed/skill/absolute-directory-escape');
		const provider = createFilteredWorkspaceProvider({
			baseProvider: source,
			dependencies: createDependencies(),
			policy: {
				hiddenPaths: [],
				readonlyInputs: [
					{
						destinationRelativePath: 'skills/managed',
						sourceRelativePath: 'reviewed/skill',
					},
				],
				temporaryPaths: [],
				visibility: {
					kind: 'positive-paths',
					visiblePaths: ['skills/managed'],
					writablePaths: [],
				},
			},
		});

		await expect(provider.open('/skills/managed/relative-file-escape', 'r')).rejects.toMatchObject({
			code: 'ENOENT',
		});
		await expect(
			provider.readFile?.('/skills/managed/relative-file-escape', 'utf8'),
		).rejects.toMatchObject({ code: 'ENOENT' });
		await expect(provider.stat('/skills/managed/relative-file-escape')).rejects.toMatchObject({
			code: 'ENOENT',
		});
		await expect(provider.realpath?.('/skills/managed/relative-file-escape')).rejects.toMatchObject(
			{
				code: 'ENOENT',
			},
		);
		await expect(
			provider.readdir('/skills/managed/absolute-directory-escape'),
		).rejects.toMatchObject({ code: 'ENOENT' });
		expect(() => provider.openSync('/skills/managed/relative-file-escape', 'r')).toThrow(
			expect.objectContaining({ code: 'ENOENT' }),
		);
		expect(() => provider.statSync('/skills/managed/relative-file-escape')).toThrow(
			expect.objectContaining({ code: 'ENOENT' }),
		);
		expect(() => provider.realpathSync?.('/skills/managed/relative-file-escape')).toThrow(
			expect.objectContaining({ code: 'ENOENT' }),
		);
		expect(() => provider.readdirSync('/skills/managed/absolute-directory-escape')).toThrow(
			expect.objectContaining({ code: 'ENOENT' }),
		);
	});

	it('composes positive visibility, hidden, tmpfs, and exact nested readonly inputs', async () => {
		const source = createWorkspaceSource();
		const dependencies = createDependencies();
		const createReadonlyProviderMock = vi.spyOn(dependencies, 'createReadonlyProvider');
		const createShadowProviderMock = vi.spyOn(dependencies, 'createShadowProvider');
		const provider = createFilteredWorkspaceProvider({
			baseProvider: source,
			dependencies,
			policy: {
				hiddenPaths: ['notes/private.txt'],
				readonlyInputs: [
					{
						destinationRelativePath: 'skills/managed',
						sourceRelativePath: 'reviewed/skill',
					},
				],
				temporaryPaths: ['node_modules'],
				visibility: {
					kind: 'positive-paths',
					visiblePaths: ['node_modules', 'notes', 'reviewed-note.txt', 'skills/managed'],
					writablePaths: ['notes'],
				},
			},
		});

		expect(await provider.readdir('/')).toEqual(['notes', 'reviewed-note.txt', 'skills']);
		expect(await provider.readFile?.('/notes/visible.txt', 'utf8')).toBe('visible');
		await provider.writeFile?.('/notes/new.txt', 'new');
		expect(await source.readFile?.('/notes/new.txt', 'utf8')).toBe('new');
		await expect(provider.writeFile?.('/reviewed-note.txt', 'replace')).rejects.toMatchObject({
			code: 'EROFS',
		});

		await expect(provider.readFile?.('/private/secret.txt', 'utf8')).rejects.toMatchObject({
			errno: ERRNO.ENOENT,
		});
		await expect(provider.readFile?.('/notes/private.txt', 'utf8')).rejects.toMatchObject({
			errno: ERRNO.ENOENT,
		});
		await expect(provider.writeFile?.('/notes/private.txt', 'replace')).rejects.toMatchObject({
			errno: ERRNO.EACCES,
		});

		await expect(provider.readFile?.('/node_modules/host.js', 'utf8')).rejects.toMatchObject({
			code: 'ENOENT',
		});
		await provider.writeFile?.('/node_modules/guest.js', 'guest dependency');
		expect(await provider.readFile?.('/node_modules/guest.js', 'utf8')).toBe('guest dependency');
		expect((await provider.readdir('/')).map(String).toSorted()).toEqual([
			'node_modules',
			'notes',
			'reviewed-note.txt',
			'skills',
		]);
		expect(await source.exists?.('/node_modules/guest.js')).toBe(false);

		expect(await provider.readFile?.('/skills/managed/SKILL.md', 'utf8')).toBe('reviewed skill');
		await expect(provider.writeFile?.('/skills/managed/SKILL.md', 'replace')).rejects.toMatchObject(
			{ code: 'EROFS' },
		);
		await expect(provider.rename('/skills/managed', '/skills/replaced')).rejects.toMatchObject({
			code: 'EROFS',
		});

		expect(createShadowProviderMock).toHaveBeenCalledTimes(3);
		expect(createReadonlyProviderMock).toHaveBeenCalledTimes(2);
		const shadowCallOrder = createShadowProviderMock.mock.invocationCallOrder;
		const readonlyCallOrder = createReadonlyProviderMock.mock.invocationCallOrder;
		const compositionCallOrder = [
			shadowCallOrder[0],
			readonlyCallOrder[0],
			shadowCallOrder[1],
			shadowCallOrder[2],
			readonlyCallOrder[1],
		].filter((callOrder): callOrder is number => callOrder !== undefined);
		expect(compositionCallOrder).toHaveLength(5);
		expect(compositionCallOrder).toEqual(
			compositionCallOrder.toSorted((firstOrder, secondOrder) => firstOrder - secondOrder),
		);
	});

	it.each([
		{ destinationPath: '/notes/async-alias.txt', method: 'link' as const },
		{ destinationPath: '/notes/sync-alias.txt', method: 'linkSync' as const },
	])('allows $method only when both hardlink paths are visible and writable', async (testCase) => {
		const source = createWorkspaceSource();
		const provider = createFilteredWorkspaceProvider({
			baseProvider: source,
			dependencies: createDependencies(),
			policy: {
				hiddenPaths: ['notes/private.txt'],
				readonlyInputs: [],
				temporaryPaths: ['node_modules'],
				visibility: {
					kind: 'positive-paths',
					visiblePaths: ['node_modules', 'notes', 'readonly-destination.txt', 'reviewed-note.txt'],
					writablePaths: ['notes'],
				},
			},
		});

		if (testCase.method === 'link') {
			await provider.link?.('/notes/visible.txt', testCase.destinationPath);
		} else {
			provider.linkSync?.('/notes/visible.txt', testCase.destinationPath);
		}
		writeProviderFile(provider, testCase.destinationPath, 'updated through writable alias');
		expect(await source.readFile?.('/notes/visible.txt', 'utf8')).toBe(
			'updated through writable alias',
		);

		const deniedDirections = [
			['/reviewed-note.txt', '/notes/from-readonly.txt', 'EROFS'],
			['/private/secret.txt', '/notes/from-invisible.txt', 'ENOENT'],
			['/notes/private.txt', '/notes/from-hidden.txt', 'ENOENT'],
			['/notes/visible.txt', '/readonly-destination.txt', 'EROFS'],
			['/notes/visible.txt', '/private/invisible-destination.txt', 'EACCES'],
			['/notes/visible.txt', '/notes/private.txt', 'EACCES'],
		] as const;
		if (testCase.method === 'link') {
			await Promise.all(
				deniedDirections.map(async ([sourcePath, destinationPath, expectedCode]) =>
					expect(provider.link?.(sourcePath, destinationPath)).rejects.toMatchObject({
						code: expectedCode,
					}),
				),
			);
		} else {
			for (const [sourcePath, destinationPath, expectedCode] of deniedDirections) {
				expect(() => provider.linkSync?.(sourcePath, destinationPath)).toThrow(
					expect.objectContaining({ code: expectedCode }),
				);
			}
		}
	});

	it.each([{ method: 'link' as const }, { method: 'linkSync' as const }])(
		'denies $method when a writable source symlink resolves to filtered workspace content',
		async (testCase) => {
			const source = createWorkspaceSource();
			if (!source.symlinkSync) {
				throw new Error('MemoryProvider must support symlinks for this hardlink test.');
			}
			source.symlinkSync('/notes/private.txt', '/notes/hidden-alias.txt');
			source.symlinkSync('/reviewed/skill/SKILL.md', '/notes/readonly-alias.md');
			const provider = createFilteredWorkspaceProvider({
				baseProvider: source,
				dependencies: createDependencies(),
				policy: {
					hiddenPaths: ['notes/private.txt'],
					readonlyInputs: [
						{
							destinationRelativePath: 'skills/managed',
							sourceRelativePath: 'reviewed/skill',
						},
					],
					temporaryPaths: [],
					visibility: {
						kind: 'positive-paths',
						visiblePaths: ['notes', 'skills/managed'],
						writablePaths: ['notes'],
					},
				},
			});
			const deniedHardlinks = [
				['/notes/hidden-alias.txt', '/notes/hidden-hardlink.txt'],
				['/notes/readonly-alias.md', '/notes/readonly-hardlink.md'],
			] as const;

			if (testCase.method === 'link') {
				await Promise.all(
					deniedHardlinks.map(async ([sourcePath, destinationPath]) =>
						expect(provider.link?.(sourcePath, destinationPath)).rejects.toMatchObject({
							errno: ERRNO.ENOENT,
						}),
					),
				);
			} else {
				for (const [sourcePath, destinationPath] of deniedHardlinks) {
					expect(() => provider.linkSync?.(sourcePath, destinationPath)).toThrow(
						expect.objectContaining({ errno: ERRNO.ENOENT }),
					);
				}
			}

			expect(await source.readFile?.('/notes/private.txt', 'utf8')).toBe('hidden');
			expect(await source.readFile?.('/reviewed/skill/SKILL.md', 'utf8')).toBe('reviewed skill');
		},
	);

	it('copies readonly input files to writable destinations without mutating the source', async () => {
		const source = createWorkspaceSource();
		const provider = createFilteredWorkspaceProvider({
			baseProvider: source,
			dependencies: createDependencies(),
			policy: {
				hiddenPaths: [],
				readonlyInputs: [
					{
						destinationRelativePath: 'skills/managed',
						sourceRelativePath: 'reviewed/skill',
					},
				],
				temporaryPaths: [],
				visibility: {
					kind: 'positive-paths',
					visiblePaths: ['notes', 'readonly-destination.txt', 'skills/managed'],
					writablePaths: ['notes'],
				},
			},
		});

		await provider.copyFile?.('/skills/managed/SKILL.md', '/notes/copied-async.md');
		provider.copyFileSync?.('/skills/managed/SKILL.md', '/notes/copied-sync.md');
		expect(await source.readFile?.('/notes/copied-async.md', 'utf8')).toBe('reviewed skill');
		expect(await source.readFile?.('/notes/copied-sync.md', 'utf8')).toBe('reviewed skill');
		expect(await source.readFile?.('/reviewed/skill/SKILL.md', 'utf8')).toBe('reviewed skill');

		await expect(
			provider.copyFile?.('/skills/managed/SKILL.md', '/skills/managed/copied.md'),
		).rejects.toMatchObject({ code: 'EROFS' });
		await expect(
			provider.copyFile?.('/skills/managed/SKILL.md', '/readonly-destination.txt'),
		).rejects.toMatchObject({ code: 'EROFS' });
		await expect(
			provider.copyFile?.('/skills/managed/SKILL.md', '/private/copied.md'),
		).rejects.toMatchObject({ errno: ERRNO.EACCES });
		expect(() =>
			provider.copyFileSync?.('/skills/managed/SKILL.md', '/skills/managed/copied-sync.md'),
		).toThrow(expect.objectContaining({ code: 'EROFS' }));
	});

	it('keeps hidden precedence inside a nested readonly destination', async () => {
		const source = createWorkspaceSource();
		const provider = createFilteredWorkspaceProvider({
			baseProvider: source,
			dependencies: createDependencies(),
			policy: {
				hiddenPaths: ['notes', 'skills/managed/private.txt'],
				readonlyInputs: [
					{
						destinationRelativePath: 'skills/managed',
						sourceRelativePath: 'notes',
					},
				],
				temporaryPaths: ['skills/managed'],
				visibility: { kind: 'whole-root-writable' },
			},
		});

		await expect(provider.readFile?.('/skills/managed/private.txt', 'utf8')).rejects.toMatchObject({
			errno: ERRNO.ENOENT,
		});
		await expect(
			provider.writeFile?.('/skills/managed/private.txt', 'replace'),
		).rejects.toMatchObject({ errno: ERRNO.EACCES });
		await expect(
			provider.writeFile?.('/skills/managed/visible.txt', 'replace'),
		).rejects.toMatchObject({ code: 'EROFS' });
	});
});
