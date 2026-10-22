import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);
export interface WorkerdSockets {
	readonly pid: number;
	readonly established: number;
	readonly closeWait: number;
}
/** Query only direct workerd children; unrelated process arguments never enter this proof. */
export async function ownedWorkerdPids(): Promise<number[]> {
	try {
		const { stdout } = await executeFile('pgrep', ['-P', String(process.pid), '-x', 'workerd'], {
			timeout: 2000,
		});
		const lines = stdout.trim().split('\n').filter(Boolean);
		if (lines.some((line) => !/^[1-9]\d*$/u.test(line)))
			throw new Error('Invalid owned workerd PID output.');
		return lines.map(Number).toSorted((left, right) => left - right);
	} catch (error: unknown) {
		if (
			typeof error === 'object' &&
			error !== null &&
			'code' in error &&
			error.code === 1 &&
			'stdout' in error &&
			error.stdout === '' &&
			'stderr' in error &&
			error.stderr === ''
		)
			return [];
		const field = (name: string): unknown =>
			typeof error === 'object' && error !== null && name in error
				? Reflect.get(error, name)
				: undefined;
		// Never include a process table or arbitrary command arguments in failure logs.
		throw new Error(
			`Owned workerd PID query failed: ${JSON.stringify({
				code: field('code'),
				signal: field('signal'),
				killed: field('killed'),
				stderr: field('stderr'),
			})}`,
			{ cause: error },
		);
	}
}
export async function workerdSockets(pids: readonly number[]): Promise<WorkerdSockets[]> {
	return Promise.all(
		pids.map(async (pid) => {
			const { stdout } = await executeFile(
				'lsof',
				['-nP', '-a', '-p', String(pid), '-iTCP', '-F', 'pT'],
				{ timeout: 2000, maxBuffer: 4 * 1024 * 1024 },
			).catch((error: unknown) => {
				// lsof exits 1 with empty output when a newly spawned process has no TCP sockets.
				if (
					typeof error === 'object' &&
					error !== null &&
					'code' in error &&
					error.code === 1 &&
					'stdout' in error &&
					error.stdout === '' &&
					'stderr' in error &&
					error.stderr === ''
				)
					return { stdout: '' };
				throw error;
			});
			return {
				pid,
				established: stdout.split('\n').filter((line) => line === 'TST=ESTABLISHED').length,
				closeWait: stdout.split('\n').filter((line) => line === 'TST=CLOSE_WAIT').length,
			};
		}),
	);
}

/** All local workerd workloads fail closed before consuming the host's loopback port range. */
export function startWorkerdSocketGuard(): {
	readonly stop: () => Promise<void>;
	readonly check: () => void;
} {
	let stopped = false;
	let failure: Error | undefined;
	let checking: Promise<void> | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	async function inspect(): Promise<void> {
		try {
			const pids = await ownedWorkerdPids();
			const snapshots = await workerdSockets(pids);
			if (snapshots.some((item) => item.closeWait > 2000 || item.established > 2000)) {
				failure = new Error(
					`Owned workerd socket guard exceeded 2000: ${JSON.stringify(snapshots)}`,
				);
				process.stderr.write(`${failure.message}\n`);
				for (const pid of pids) {
					try {
						process.kill(pid, 'SIGKILL');
					} catch {
						/* Already exited. */
					}
				}
			}
		} catch (error) {
			if (!stopped)
				failure = error instanceof Error ? error : new Error('Socket guard unavailable.');
		} finally {
			if (!stopped && failure === undefined) timer = setTimeout(schedule, 100);
		}
	}
	function schedule(): void {
		checking = inspect();
	}
	schedule();
	return {
		check: () => {
			if (failure !== undefined) throw failure;
		},
		stop: async () => {
			stopped = true;
			clearTimeout(timer);
			await checking;
			if (failure !== undefined) throw failure;
		},
	};
}
