import { Readable } from 'node:stream';

import type {
	ManagedExecProcess,
	ManagedExecResult,
	ManagedVmFs,
	VmDestroyTargetV1,
	VmDestroyReceiptV1,
	VmOwnershipReservationReferenceV1,
} from '@agent-vm/gondolin-adapter';

export interface ManagedVmTestIdentityOptions {
	readonly controllerEpoch?: string;
	readonly parentGateway?: VmDestroyTargetV1['parentGateway'];
	readonly reservationId?: string;
	readonly role?: VmDestroyTargetV1['role'];
}

export function createTestVmOwnershipReservationReference(
	vmId = 'managed-vm-test',
	options: ManagedVmTestIdentityOptions = {},
): VmOwnershipReservationReferenceV1 {
	return {
		expectedContractVersion: 1,
		expectedRevision: 1,
		reservationId: options.reservationId ?? `reservation-${vmId}`,
		reservationPath: `/tmp/agent-vm-tests/vm-ownership/${options.reservationId ?? `reservation-${vmId}`}/reservation.json`,
	};
}

export function createTestVmDestroyTarget(
	vmId = 'managed-vm-test',
	options: ManagedVmTestIdentityOptions = {},
): VmDestroyTargetV1 {
	const reservationReference = createTestVmOwnershipReservationReference(vmId, options);
	return {
		contractVersion: 1,
		controllerEpoch: options.controllerEpoch ?? 'controller-epoch-test',
		ownerProcess: {
			command: 'agent-vm-test',
			pid: process.pid,
			startCookie: 'agent-vm-test-process',
		},
		parentGateway: options.parentGateway ?? null,
		reservationId: reservationReference.reservationId,
		reservationPath: reservationReference.reservationPath,
		resources: {
			disposableStoragePaths: [],
			ingressListener: false,
			ingressSockets: false,
			retainedStoragePaths: [],
			sshListener: false,
			sshSessions: false,
		},
		role: options.role ?? 'standalone',
		runner: {
			backend: 'qemu',
			discoveryIdentity: `agent-vm-test:${vmId}`,
			executable: '/usr/bin/qemu-system-aarch64',
		},
		sessionLabel: `agent-vm-test:${vmId}`,
		vmId,
	};
}

export function createCompleteVmDestroyReceipt(
	vmId = 'managed-vm-test',
	options: ManagedVmTestIdentityOptions = {},
): VmDestroyReceiptV1 {
	return {
		contractVersion: 1,
		reservationId: options.reservationId ?? `reservation-${vmId}`,
		vmId,
		controllerEpoch: options.controllerEpoch ?? 'controller-epoch-test',
		parentGateway: options.parentGateway ?? null,
		role: options.role ?? 'standalone',
		requestedRunner: {
			backend: 'qemu',
			executableName: 'qemu-system-aarch64',
			discoveryIdentity: `runner-${vmId}`,
		},
		complete: true,
		completedAt: '2026-07-10T00:00:00.000Z',
		resources: {
			exactRunner: { status: 'destroyed' },
			ingressListener: { status: 'already-absent' },
			ingressSockets: { status: 'already-absent' },
			sshListener: { status: 'already-absent' },
			sshSessions: { status: 'already-absent' },
			sessionIpc: { status: 'destroyed' },
			qmp: { status: 'destroyed' },
			disposableStorage: { status: 'destroyed' },
		},
	};
}

export interface ManagedExecProcessStubOptions {
	readonly beforeResolve?: () => void;
	readonly exitCode?: number;
	readonly stderr?: string;
	readonly stdout?: string;
	readonly waitFor?: Promise<void>;
}

/* oxlint-disable typescript/no-unnecessary-type-parameters, typescript/no-unsafe-type-assertion, typescript-eslint/no-unsafe-type-assertion, unicorn/no-thenable -- Test doubles only
   need the PromiseLike/stream surface exercised by agent-vm tests. Gondolin's
   concrete ExecProcess and ExecResult classes carry private fields, so a
   structural test double needs a narrow assertion at the boundary. */
export function createManagedExecProcessStub(
	options: ManagedExecProcessStubOptions = {},
): ManagedExecProcess {
	const stdout = options.stdout ?? '';
	const stderr = options.stderr ?? '';
	const execResult = {
		exitCode: options.exitCode ?? 0,
		stderr,
		stdout,
		stderrBuffer: Buffer.from(stderr),
		stdoutBuffer: Buffer.from(stdout),
		get ok(): boolean {
			return this.exitCode === 0;
		},
		json<TValue = unknown>(): TValue {
			return JSON.parse(stdout) as TValue;
		},
		lines(): string[] {
			return stdout.split(/\r?\n/u);
		},
		toString(): string {
			return stdout;
		},
	} as ManagedExecResult;
	const resultPromise = (async (): Promise<ManagedExecResult> => {
		options.beforeResolve?.();
		await options.waitFor;
		return execResult;
	})();
	return {
		[Symbol.asyncIterator]: async function* (): AsyncIterator<string> {
			yield stdout;
		},
		catch: resultPromise.catch.bind(resultPromise),
		finally: resultPromise.finally.bind(resultPromise),
		stderr: Readable.from([stderr]),
		stdout: Readable.from([stdout]),
		then: resultPromise.then.bind(resultPromise),
	} as ManagedExecProcess;
}
/* oxlint-enable typescript/no-unnecessary-type-parameters, typescript/no-unsafe-type-assertion, typescript-eslint/no-unsafe-type-assertion, unicorn/no-thenable */

async function readManagedVmFsStubFile(
	_filePath: string,
	options?: { readonly encoding?: BufferEncoding | null },
): Promise<Buffer | string> {
	return options?.encoding ? '' : Buffer.from('');
}

export function createManagedVmFsStub(): ManagedVmFs {
	return {
		access: async () => {},
		deleteFile: async () => {},
		listDir: async () => [],
		mkdir: async () => {},
		/* oxlint-disable-next-line typescript/no-unsafe-type-assertion -- VmFs.readFile is
		   overloaded; the stub handles text and buffer modes and asserts at the overload boundary. */
		readFile: readManagedVmFsStubFile as unknown as ManagedVmFs['readFile'],
		readFileStream: async () => Readable.from([]),
		rename: async () => {},
		stat: async () => {
			throw new Error('stat not implemented in ManagedVm test stub');
		},
		writeFile: async () => {},
	};
}
