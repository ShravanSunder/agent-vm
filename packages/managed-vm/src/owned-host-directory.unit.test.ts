import { describe, expect, it, vi } from 'vitest';

import { assertPositiveHostProcessId, createOwnedHostDirectoryController } from './index.js';

const directoryIdentity = {
	canonicalPath: '/srv/agent-vm/work',
	device: 12,
	inode: 34,
} as const;

describe('owned host directory ownership', () => {
	it('closes an acquired directory exactly once', () => {
		const onClose = vi.fn();
		const directory = createOwnedHostDirectoryController({ identity: directoryIdentity, onClose });

		directory.close();
		directory.close();

		expect(directory.state).toBe('closed');
		expect(onClose).toHaveBeenCalledOnce();
		expect(() => directory.consume()).toThrow('cannot be consumed while closed');
	});

	it('transfers once and leaves final cleanup with the adapter owner', () => {
		const onClose = vi.fn();
		const onConsume = vi.fn();
		const directory = createOwnedHostDirectoryController({
			identity: directoryIdentity,
			onClose,
			onConsume,
		});

		const transfer = directory.consume();

		expect(directory.state).toBe('adapter-owned');
		expect(transfer.state).toBe('adapter-owned');
		expect(onConsume).toHaveBeenCalledOnce();
		expect(() => directory.consume()).toThrow('cannot be consumed while adapter-owned');
		expect(() => directory.close()).toThrow('cannot be closed by its former owner');

		transfer.close();
		transfer.close();

		expect(directory.state).toBe('closed');
		expect(transfer.state).toBe('closed');
		expect(onClose).toHaveBeenCalledOnce();
	});

	it('does not report closed when backend resource cleanup fails', () => {
		const onClose = vi
			.fn<() => void>()
			.mockImplementationOnce(() => {
				throw new Error('close failed');
			})
			.mockImplementationOnce(() => {});
		const directory = createOwnedHostDirectoryController({ identity: directoryIdentity, onClose });
		const transfer = directory.consume();

		expect(() => transfer.close()).toThrow('close failed');
		expect(transfer.state).toBe('adapter-owned');

		transfer.close();

		expect(transfer.state).toBe('closed');
		expect(onClose).toHaveBeenCalledTimes(2);
	});

	it('closes exactly once when the consume callback throws', () => {
		const onClose = vi.fn();
		const directory = createOwnedHostDirectoryController({
			identity: directoryIdentity,
			onClose,
			onConsume: () => {
				throw new Error('transfer failed');
			},
		});

		expect(() => directory.consume()).toThrow('transfer failed');
		expect(directory.state).toBe('closed');
		expect(onClose).toHaveBeenCalledOnce();
	});

	it('cannot publish adapter ownership after a reentrant close during transfer', () => {
		const onClose = vi.fn();
		const directory: ReturnType<typeof createOwnedHostDirectoryController> =
			createOwnedHostDirectoryController({
				identity: directoryIdentity,
				onClose,
				onConsume: () => directory.close(),
			});

		expect(() => directory.consume()).toThrow('closed during ownership transfer');
		expect(directory.state).toBe('closed');
		expect(onClose).toHaveBeenCalledOnce();
	});

	it('does not recursively close when the close callback reenters', () => {
		const onClose = vi.fn(() => directory.close());
		const directory: ReturnType<typeof createOwnedHostDirectoryController> =
			createOwnedHostDirectoryController({ identity: directoryIdentity, onClose });

		directory.close();

		expect(directory.state).toBe('closed');
		expect(onClose).toHaveBeenCalledOnce();
	});
});

describe('managed VM host process identity', () => {
	it('accepts only a positive safe integer after start', () => {
		expect(assertPositiveHostProcessId(42)).toBe(42);
		for (const invalidProcessId of [null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
			expect(() => assertPositiveHostProcessId(invalidProcessId)).toThrow(
				'A started managed VM must expose a positive stable host process ID.',
			);
		}
	});

	it('supports absent pre-start identity and requires a stable positive post-start identity', async () => {
		let started = false;
		const getHostProcessId = (): number | null => (started ? 4242 : null);
		const start = async (): Promise<void> => {
			started = true;
		};

		expect(getHostProcessId()).toBeNull();
		await start();
		const firstProcessId = assertPositiveHostProcessId(getHostProcessId());
		const repeatedProcessId = assertPositiveHostProcessId(getHostProcessId());

		expect(firstProcessId).toBe(4242);
		expect(repeatedProcessId).toBe(firstProcessId);
	});
});
