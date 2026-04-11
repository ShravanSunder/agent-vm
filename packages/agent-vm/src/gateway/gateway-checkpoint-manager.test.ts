import { describe, expect, it, vi } from 'vitest';

import {
	decryptCheckpointFile,
	encryptCheckpointFile,
	resolveCheckpointPath,
	shouldUseCheckpoint,
} from './gateway-checkpoint-manager.js';

describe('gateway-checkpoint-manager', () => {
	it('resolveCheckpointPath returns a path under the checkpoints directory', () => {
		expect(resolveCheckpointPath('./checkpoints', 'shravan', 'abc123')).toBe(
			'checkpoints/shravan/gateway-abc123.qcow2',
		);
	});

	it('shouldUseCheckpoint returns false when the checkpoint does not exist', () => {
		expect(shouldUseCheckpoint('/nonexistent/path.qcow2')).toBe(false);
	});
});

describe('checkpoint encryption', () => {
	it('encryptCheckpointFile calls encryption.encrypt with the correct paths', async () => {
		const mockEncrypt = vi.fn(async () => {});

		await encryptCheckpointFile('/tmp/gateway.qcow2', {
			decrypt: vi.fn(),
			encrypt: mockEncrypt,
		});

		expect(mockEncrypt).toHaveBeenCalledWith('/tmp/gateway.qcow2', '/tmp/gateway.qcow2.age');
	});

	it('decryptCheckpointFile calls encryption.decrypt with the correct paths', async () => {
		const mockDecrypt = vi.fn(async () => {});

		await decryptCheckpointFile('/tmp/gateway.qcow2.age', {
			decrypt: mockDecrypt,
			encrypt: vi.fn(),
		});

		expect(mockDecrypt).toHaveBeenCalledWith('/tmp/gateway.qcow2.age', '/tmp/gateway.qcow2');
	});
});
