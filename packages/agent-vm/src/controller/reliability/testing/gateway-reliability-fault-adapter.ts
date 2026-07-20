import type {
	ManagedVmExecCommand,
	ManagedVmExecOptions,
	ManagedVmExecProcess,
} from '@agent-vm/managed-vm';

export type ManagedGatewaySiblingFaultRole = 'framework' | 'tool-portal';

export interface GatewayReliabilityFaultVmOperations {
	readonly id: string;
	exec(command: ManagedVmExecCommand, options?: ManagedVmExecOptions): ManagedVmExecProcess;
}

export interface ManagedGatewaySiblingProcessIdentity {
	readonly processId: number;
	readonly startIdentity: string;
}

export interface ManagedGatewaySiblingTerminationReceipt extends ManagedGatewaySiblingProcessIdentity {
	readonly gatewayVmId: string;
	readonly role: ManagedGatewaySiblingFaultRole;
}

function assertGuestPort(guestPort: number): void {
	if (!Number.isSafeInteger(guestPort) || guestPort <= 0 || guestPort > 65_535) {
		throw new Error(`Managed Gateway sibling guest port '${String(guestPort)}' is invalid.`);
	}
}

function parseProcessIdentityOutput(
	output: string,
	role: ManagedGatewaySiblingFaultRole,
): ManagedGatewaySiblingProcessIdentity {
	const [processIdText, startIdentity] = output.trim().split(/\s+/u);
	const processId = Number(processIdText);
	if (
		!Number.isSafeInteger(processId) ||
		processId <= 0 ||
		startIdentity === undefined ||
		!/^\d+$/u.test(startIdentity)
	) {
		throw new Error(`Managed Gateway ${role} sibling identity output was invalid: ${output}`);
	}
	return { processId, startIdentity };
}

export async function readManagedGatewaySiblingProcessIdentity(options: {
	readonly gatewayVm: GatewayReliabilityFaultVmOperations;
	readonly guestPort: number;
	readonly role: ManagedGatewaySiblingFaultRole;
}): Promise<ManagedGatewaySiblingProcessIdentity> {
	assertGuestPort(options.guestPort);
	const result = await options.gatewayVm.exec(`
set -eu
port_hex="$(printf '%04X' ${String(options.guestPort)})"
socket_inode="$(awk -v port=":$port_hex" '$2 ~ port && $4 == "0A" { print $10; exit }' /proc/net/tcp /proc/net/tcp6 2>/dev/null || true)"
service_pid=""
if [ -n "$socket_inode" ]; then
  for fd in /proc/[0-9]*/fd/*; do
    target="$(readlink "$fd" 2>/dev/null || true)"
    if [ "$target" = "socket:[$socket_inode]" ]; then
      service_pid="$(echo "$fd" | cut -d / -f 3)"
      break
    fi
  done
fi
test -n "$service_pid"
start_identity="$(sed -E 's/^[0-9]+ \\(.*\\) //' "/proc/$service_pid/stat" | awk '{ print $20 }')"
printf '%s %s\\n' "$service_pid" "$start_identity"
`);
	if (!result.ok) {
		throw new Error(
			`Managed Gateway ${options.role} sibling identity read failed: exit=${String(result.exitCode)} stderr=${result.stderr}`,
		);
	}
	return parseProcessIdentityOutput(result.stdout, options.role);
}

export async function terminateManagedGatewaySibling(options: {
	readonly gatewayVm: GatewayReliabilityFaultVmOperations;
	readonly identity: ManagedGatewaySiblingProcessIdentity;
	readonly role: ManagedGatewaySiblingFaultRole;
}): Promise<ManagedGatewaySiblingTerminationReceipt> {
	if (
		!Number.isSafeInteger(options.identity.processId) ||
		options.identity.processId <= 0 ||
		!/^\d+$/u.test(options.identity.startIdentity)
	) {
		throw new Error('Managed Gateway sibling fault identity is invalid.');
	}
	const result = await options.gatewayVm.exec(`
set -eu
process_id=${String(options.identity.processId)}
expected_start_identity=${options.identity.startIdentity}
observed_start_identity="$(sed -E 's/^[0-9]+ \\(.*\\) //' "/proc/$process_id/stat" | awk '{ print $20 }')"
if [ "$observed_start_identity" != "$expected_start_identity" ]; then
  echo "refusing to signal a process whose start identity changed" >&2
  exit 1
fi
kill -KILL "$process_id"
printf '%s %s\\n' "$process_id" "$observed_start_identity"
`);
	if (!result.ok) {
		throw new Error(
			`Managed Gateway ${options.role} sibling termination failed: exit=${String(result.exitCode)} stderr=${result.stderr}`,
		);
	}
	const terminatedIdentity = parseProcessIdentityOutput(result.stdout, options.role);
	if (
		terminatedIdentity.processId !== options.identity.processId ||
		terminatedIdentity.startIdentity !== options.identity.startIdentity
	) {
		throw new Error(`Managed Gateway ${options.role} sibling termination receipt was invalid.`);
	}
	return {
		...terminatedIdentity,
		gatewayVmId: options.gatewayVm.id,
		role: options.role,
	};
}
