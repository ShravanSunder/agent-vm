import type { ManagedVmCreateRequest, ManagedVmFileTransferCapability } from '@agent-vm/managed-vm';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

const createNativeManagedVmMock = vi.hoisted(() => vi.fn());
vi.mock('./vm-adapter.js', async (importOriginal) => {
	const originalModule = await importOriginal<typeof import('./vm-adapter.js')>();
	return { ...originalModule, createManagedVm: createNativeManagedVmMock };
});

import { createGondolinManagedVmProvider } from './managed-vm-provider.js';

const createRequest = {
	allowedHosts: [],
	environment: {},
	imageReference: '/images/test',
	mediatedSecrets: [],
	mounts: {},
	resources: { cpuCount: 1, memory: '1G' },
	rootfsMode: 'cow',
	sessionLabel: 'file-transfer-test',
	tcpHosts: [],
} satisfies ManagedVmCreateRequest;

interface NativeFileMocks {
	readonly mkdir: Mock<() => Promise<void>>;
	readonly writeFile: Mock<
		(
			path: string,
			contents: AsyncIterable<Uint8Array>,
			options: { signal?: AbortSignal },
		) => Promise<void>
	>;
}

async function createFileTransferFixture(): Promise<{
	readonly fileTransfer: ManagedVmFileTransferCapability;
	readonly nativeFs: NativeFileMocks;
}> {
	const nativeFs = {
		mkdir: vi.fn<() => Promise<void>>(),
		writeFile:
			vi.fn<
				(
					path: string,
					contents: AsyncIterable<Uint8Array>,
					options: { signal?: AbortSignal },
				) => Promise<void>
			>(),
	};
	createNativeManagedVmMock.mockResolvedValue({ fs: nativeFs, id: 'file-transfer-vm' });
	const vm = await createGondolinManagedVmProvider().factory.createManagedVm(createRequest);
	expect(vm.fileTransfer).toBeDefined();
	if (vm.fileTransfer === undefined) {
		throw new Error('Gondolin omitted its file transfer capability.');
	}
	return { fileTransfer: vm.fileTransfer, nativeFs };
}

describe('ManagedVm streamed file transfer adapter', () => {
	afterEach(() => createNativeManagedVmMock.mockReset());

	it('leaves byte pulling to the native writer and awaits destination completion', async () => {
		// Arrange: production-sized data is never needed to test demand ownership.
		const { fileTransfer, nativeFs } = await createFileTransferFixture();
		const inputChunk = Uint8Array.from([0, 255, 128, 1]);
		let pullCount = 0;
		const contents = (async function* (): AsyncIterable<Uint8Array> {
			pullCount += 1;
			yield inputChunk;
		})();
		const destinationCompletion = Promise.withResolvers<void>();
		nativeFs.writeFile.mockReturnValue(destinationCompletion.promise);
		const abortController = new AbortController();

		// Act: the adapter must hand off the iterable, not collect or eagerly drain it.
		let completed = false;
		const write = fileTransfer
			.writeFileStream({
				contents,
				guestPath: '/tmp/operation/input.part',
				signal: abortController.signal,
			})
			.then(() => {
				completed = true;
			});
		expect(pullCount).toBe(0);
		expect(completed).toBe(false);
		expect(nativeFs.writeFile).toHaveBeenCalledWith('/tmp/operation/input.part', contents, {
			signal: abortController.signal,
		});
		const handedOffInput = nativeFs.writeFile.mock.calls[0]?.[1];
		expect(handedOffInput).toBe(contents);
		const nextChunk = await handedOffInput?.[Symbol.asyncIterator]().next();
		expect(nextChunk?.value).toBe(inputChunk);
		expect(pullCount).toBe(1);
		destinationCompletion.resolve();
		await write;

		// Assert: caller completion follows the native completion.
		expect(completed).toBe(true);
	});

	it('propagates input failures without converting bytes to text', async () => {
		// Arrange
		const { fileTransfer, nativeFs } = await createFileTransferFixture();
		const inputFailure = new Error('source stopped');
		const contents = (async function* (): AsyncIterable<Uint8Array> {
			yield Uint8Array.from([255]);
			throw inputFailure;
		})();
		nativeFs.writeFile.mockImplementation(async (_path, input) => {
			for await (const chunk of input) {
				expect(chunk).toEqual(Uint8Array.from([255]));
			}
		});

		// Act / Assert
		await expect(
			fileTransfer.writeFileStream({ contents, guestPath: '/tmp/operation/input.part' }),
		).rejects.toBe(inputFailure);
	});

	it('propagates destination failures without consuming the source', async () => {
		// Arrange
		const { fileTransfer, nativeFs } = await createFileTransferFixture();
		const destinationFailure = new Error('destination unavailable');
		nativeFs.writeFile.mockRejectedValue(destinationFailure);
		const next = vi.fn<() => AsyncIterator<Uint8Array>>();
		const contents = { [Symbol.asyncIterator]: next };

		// Act / Assert
		await expect(
			fileTransfer.writeFileStream({ contents, guestPath: '/tmp/operation/input.part' }),
		).rejects.toBe(destinationFailure);
		expect(next).not.toHaveBeenCalled();
	});

	it('creates a fresh private directory nonrecursively and preserves conflicts', async () => {
		// Arrange
		const { fileTransfer, nativeFs } = await createFileTransferFixture();
		const signal = new AbortController().signal;
		nativeFs.mkdir.mockResolvedValueOnce(undefined);
		const conflict = new Error('directory already exists');
		nativeFs.mkdir.mockRejectedValueOnce(conflict);

		// Act
		await fileTransfer.createDirectory({ guestPath: '/tmp/operation', signal });

		// Assert
		expect(nativeFs.mkdir).toHaveBeenCalledWith('/tmp/operation', {
			mode: 0o700,
			recursive: false,
			signal,
		});
		await expect(
			fileTransfer.createDirectory({ guestPath: '/tmp/operation', signal }),
		).rejects.toBe(conflict);
	});
});
