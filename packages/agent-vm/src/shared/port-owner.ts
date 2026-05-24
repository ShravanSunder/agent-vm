import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface PortOwner {
	readonly command: string;
	readonly pid: number;
}

export interface ExecFileOutput {
	readonly stderr: string;
	readonly stdout: string;
}

export type ExecFileFunction = (file: string, args: readonly string[]) => Promise<ExecFileOutput>;

export interface ReadTcpListenPortOwnerDependencies {
	readonly execFile?: ExecFileFunction;
}

export class PortOwnerDependencyError extends Error {
	public constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = 'PortOwnerDependencyError';
	}
}

function errorCode(error: unknown): string | number | undefined {
	if (typeof error !== 'object' || error === null || !('code' in error)) {
		return undefined;
	}
	const code = error.code;
	return typeof code === 'string' || typeof code === 'number' ? code : undefined;
}

export function parseLsofPortOwnerOutput(output: string): PortOwner | null {
	const lines = output
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	const pidLine = lines.find((line) => line.startsWith('p'));
	const commandLine = lines.find((line) => line.startsWith('c'));
	if (!pidLine || !commandLine) {
		return null;
	}
	const pid = Number.parseInt(pidLine.slice(1), 10);
	if (!Number.isInteger(pid) || pid <= 0) {
		return null;
	}
	const command = commandLine.slice(1);
	if (command.length === 0) {
		return null;
	}
	return { command, pid };
}

export async function readTcpListenPortOwner(
	port: number,
	dependencies: ReadTcpListenPortOwnerDependencies = {},
): Promise<PortOwner | null> {
	const runExecFile = dependencies.execFile ?? execFileAsync;
	try {
		const { stdout } = await runExecFile('lsof', [
			'-nP',
			`-iTCP:${String(port)}`,
			'-sTCP:LISTEN',
			'-F',
			'pc',
		]);
		return parseLsofPortOwnerOutput(stdout);
	} catch (error) {
		const code = errorCode(error);
		if (code === 1) {
			return null;
		}
		if (code === 'ENOENT') {
			throw new PortOwnerDependencyError(
				`Tool VM/gateway recovery requires 'lsof' on PATH to verify TCP listener ownership for port ${String(port)}.`,
				{ cause: error },
			);
		}
		throw error;
	}
}
