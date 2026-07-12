import { describe, expect, it } from 'vitest';

import { buildToolVmKnownHostsLine } from './tool-vm-ssh-server-identity.js';

const algorithm = Buffer.from('ssh-ed25519', 'ascii');
const algorithmLength = Buffer.alloc(4);
algorithmLength.writeUInt32BE(algorithm.byteLength);
const publicKey = Buffer.alloc(32, 7);
const publicKeyLength = Buffer.alloc(4);
publicKeyLength.writeUInt32BE(publicKey.byteLength);
const validEd25519PublicKey = Buffer.concat([
	algorithmLength,
	algorithm,
	publicKeyLength,
	publicKey,
]).toString('base64');

describe('buildToolVmKnownHostsLine', () => {
	it('renders an exact managed VM Ed25519 host key', () => {
		expect(
			buildToolVmKnownHostsLine({
				leaseId: 'lease-1',
				serverHostKey: {
					algorithm: 'ssh-ed25519',
					publicKeyBase64: validEd25519PublicKey,
				},
				tcpSlot: 3,
			}),
		).toBe(`tool-3.vm.host ssh-ed25519 ${validEd25519PublicKey}`);
	});

	it.each([
		undefined,
		{ algorithm: 'ssh-rsa', publicKeyBase64: validEd25519PublicKey },
		{ algorithm: 'ssh-ed25519', publicKeyBase64: 'not-base64' },
		{ algorithm: 'ssh-ed25519', publicKeyBase64: Buffer.alloc(31).toString('base64') },
	])('rejects malformed or non-Ed25519 host key identity', (serverHostKey) => {
		expect(() =>
			buildToolVmKnownHostsLine({ leaseId: 'lease-1', serverHostKey, tcpSlot: 3 }),
		).toThrow("Lease 'lease-1' does not have a valid ssh-ed25519 server host key.");
	});
});
