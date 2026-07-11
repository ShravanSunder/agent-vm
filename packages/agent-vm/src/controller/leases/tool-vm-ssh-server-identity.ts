import { isSshServerHostKey } from '@agent-vm/gondolin-adapter';

export function buildToolVmKnownHostsLine(options: {
	readonly leaseId: string;
	readonly serverHostKey: unknown;
	readonly tcpSlot: number;
}): string {
	if (!isSshServerHostKey(options.serverHostKey)) {
		throw new Error(
			`Lease '${options.leaseId}' does not have a valid ssh-ed25519 server host key.`,
		);
	}
	return `tool-${String(options.tcpSlot)}.vm.host ${options.serverHostKey.algorithm} ${options.serverHostKey.publicKeyBase64}`;
}
