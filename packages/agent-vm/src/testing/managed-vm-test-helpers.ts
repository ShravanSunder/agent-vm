import { Readable } from 'node:stream';

import type {
	ManagedExecProcess,
	ManagedExecResult,
	ManagedVm,
	ManagedVmFs,
	SshServerHostKey,
} from '@agent-vm/gondolin-adapter';

import { terminateLiveManagedVm } from '../shared/controller-managed-vm-termination.js';
import {
	isProcessAlive,
	killProcess,
	readProcessCommand,
	readProcessIdentity,
	sleep,
} from '../shared/managed-vm-process.js';

export const TEST_SSH_SERVER_HOST_KEY = {
	algorithm: 'ssh-ed25519',
	publicKeyBase64: 'AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
} satisfies SshServerHostKey;

export interface CapturedManagedVmTermination {
	terminate(): Promise<void>;
}

export async function captureManagedVmTermination(
	managedVm: ManagedVm,
): Promise<CapturedManagedVmTermination> {
	const hostPid = managedVm.getHostPid();
	if (hostPid === null) {
		throw new Error(`Managed VM '${managedVm.id}' has no live runner to capture.`);
	}
	const processIdentity = await readProcessIdentity(hostPid);
	if (processIdentity === null) {
		throw new Error(
			`Managed VM '${managedVm.id}' pid ${String(hostPid)} disappeared before identity capture.`,
		);
	}
	return {
		async terminate(): Promise<void> {
			await terminateLiveManagedVm({
				contextLabel: `test VM '${managedVm.id}'`,
				dependencies: {
					isProcessAlive,
					killProcess,
					readProcessCommand,
					readProcessIdentity,
					sleep,
				},
				target: { hostPid, processIdentity, vmId: managedVm.id },
				vm: managedVm,
			});
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
