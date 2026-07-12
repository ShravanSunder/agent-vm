import type { ManagedVmSshServerHostKey } from '@agent-vm/managed-vm';

const ed25519AlgorithmBytes = Buffer.from('ssh-ed25519', 'ascii');
const ed25519PublicKeyByteLength = 32;

function isManagedVmSshServerHostKey(value: unknown): value is ManagedVmSshServerHostKey {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const candidate = value as Record<string, unknown>;
	if (candidate.algorithm !== 'ssh-ed25519' || typeof candidate.publicKeyBase64 !== 'string') {
		return false;
	}
	try {
		const decodedKey = Buffer.from(candidate.publicKeyBase64, 'base64');
		return (
			decodedKey.byteLength ===
				4 + ed25519AlgorithmBytes.byteLength + 4 + ed25519PublicKeyByteLength &&
			decodedKey.readUInt32BE(0) === ed25519AlgorithmBytes.byteLength &&
			decodedKey.subarray(4, 4 + ed25519AlgorithmBytes.byteLength).equals(ed25519AlgorithmBytes) &&
			decodedKey.readUInt32BE(4 + ed25519AlgorithmBytes.byteLength) ===
				ed25519PublicKeyByteLength &&
			decodedKey.toString('base64') === candidate.publicKeyBase64
		);
	} catch {
		return false;
	}
}

export function buildToolVmKnownHostsLine(options: {
	readonly leaseId: string;
	readonly serverHostKey: unknown;
	readonly tcpSlot: number;
}): string {
	if (!isManagedVmSshServerHostKey(options.serverHostKey)) {
		throw new Error(
			`Lease '${options.leaseId}' does not have a valid ssh-ed25519 server host key.`,
		);
	}
	return `tool-${String(options.tcpSlot)}.vm.host ${options.serverHostKey.algorithm} ${options.serverHostKey.publicKeyBase64}`;
}
