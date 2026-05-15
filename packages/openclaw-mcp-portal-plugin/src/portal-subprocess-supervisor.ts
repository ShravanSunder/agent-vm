import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

export interface PortalSubprocessLogger {
	readonly error: (message: string) => void;
	readonly info: (message: string) => void;
	readonly warn: (message: string) => void;
}

export type PortalSubprocessSpawnFunction = (
	command: string,
	args: readonly string[],
	options: SpawnOptions,
) => ChildProcess;

export interface CreatePortalSubprocessSupervisorProps {
	readonly backoffSteps?: readonly number[];
	readonly binPath: string;
	readonly configDir: string;
	readonly fetchFn?: typeof fetch;
	readonly healthPollIntervalMs?: number;
	readonly healthTimeoutMs?: number;
	readonly host: string;
	readonly hmacEnv: Readonly<Record<string, string>>;
	readonly logger: PortalSubprocessLogger;
	readonly maxRestarts?: number;
	readonly onFatal?: (reason: string) => void;
	readonly port: number;
	readonly spawnFn?: PortalSubprocessSpawnFunction;
	readonly stopGraceMs?: number;
}

export interface PortalSubprocessSupervisor {
	readonly isAlive: () => boolean;
	readonly start: () => Promise<void>;
	readonly stop: () => Promise<void>;
}

const defaultBackoffSteps = [200, 400, 800, 1_600, 3_200, 5_000] as const;
const inheritedPortalEnvNames = ['HOME', 'PATH', 'TEMP', 'TMP', 'TMPDIR'] as const;

function createPortalSubprocessEnv(
	hmacEnv: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
	const env: Record<string, string> = {};
	for (const name of inheritedPortalEnvNames) {
		const value = process.env[name];
		if (value !== undefined) {
			env[name] = value;
		}
	}
	return { ...env, ...hmacEnv };
}

function logSubprocessOutput(props: {
	readonly chunk: Buffer | string;
	readonly logger: PortalSubprocessLogger;
	readonly streamName: 'stderr' | 'stdout';
}): void {
	const text = String(props.chunk);
	for (const line of text.split(/\r?\n/u)) {
		if (line.length === 0) {
			continue;
		}
		const message = `[mcp-portal ${props.streamName}] ${line}`;
		if (props.streamName === 'stderr') {
			props.logger.warn(message);
		} else {
			props.logger.info(message);
		}
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) {
				return;
			}
			settled = true;
			child.off('exit', handleExit);
			resolve(false);
		}, timeoutMs);
		const handleExit = (): void => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			resolve(true);
		};
		child.once('exit', handleExit);
	});
}

interface WaitForHealthProps {
	readonly fetchFn: typeof fetch;
	readonly host: string;
	readonly intervalMs: number;
	readonly port: number;
	readonly timeoutMs: number;
}

async function waitForHealthAttempt(props: {
	readonly fetchFn: typeof fetch;
	readonly host: string;
	readonly intervalMs: number;
	readonly lastError: unknown;
	readonly port: number;
	readonly startedAt: number;
	readonly timeoutMs: number;
}): Promise<void> {
	if (Date.now() - props.startedAt > props.timeoutMs) {
		const message =
			props.lastError instanceof Error ? props.lastError.message : String(props.lastError);
		throw new Error(`Timed out waiting for MCP Portal health: ${message}`);
	}
	try {
		const response = await props.fetchFn(`http://${props.host}:${String(props.port)}/health`);
		if (response.ok) {
			return;
		}
		await delay(props.intervalMs);
		return waitForHealthAttempt({
			...props,
			lastError: new Error(`health returned ${String(response.status)}`),
		});
	} catch (error) {
		await delay(props.intervalMs);
		return waitForHealthAttempt({ ...props, lastError: error });
	}
}

async function waitForHealth(props: WaitForHealthProps): Promise<void> {
	const startedAt = Date.now();
	return waitForHealthAttempt({ ...props, lastError: undefined, startedAt });
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

interface SpawnedPortalChild {
	readonly child: ChildProcess;
	readonly enableAutoRestart: () => void;
	readonly earlyFailure: Promise<never>;
}

export function createPortalSubprocessSupervisor(
	props: CreatePortalSubprocessSupervisorProps,
): PortalSubprocessSupervisor {
	const spawnFn: PortalSubprocessSpawnFunction =
		props.spawnFn ?? ((command, args, options) => spawn(command, [...args], options));
	const fetchFn = props.fetchFn ?? fetch;
	const healthPollIntervalMs = props.healthPollIntervalMs ?? 200;
	const healthTimeoutMs = props.healthTimeoutMs ?? 10_000;
	const stopGraceMs = props.stopGraceMs ?? 5_000;
	const maxRestarts = props.maxRestarts ?? 5;
	const backoffSteps = props.backoffSteps ?? defaultBackoffSteps;
	let child: ChildProcess | null = null;
	let stopping = false;
	let restartCount = 0;

	const spawnChild = (): SpawnedPortalChild => {
		const nextChild = spawnFn(props.binPath, ['--config-dir', props.configDir], {
			env: createPortalSubprocessEnv(props.hmacEnv),
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let autoRestartEnabled = false;
		let failureHandled = false;
		let rejectEarlyFailure: ((error: Error) => void) | undefined;
		const earlyFailure = new Promise<never>((_resolve, reject) => {
			rejectEarlyFailure = reject;
		});
		const rejectBeforeHealth = (error: Error): void => {
			if (rejectEarlyFailure === undefined) {
				throw new Error('MCP Portal early-failure rejector was not initialized.');
			}
			rejectEarlyFailure(error);
		};
		child = nextChild;
		nextChild.stdout?.on('data', (chunk: Buffer | string) => {
			logSubprocessOutput({ chunk, logger: props.logger, streamName: 'stdout' });
		});
		nextChild.stdout?.on('error', (error: Error) => {
			props.logger.warn(`[mcp-portal stdout] stream error: ${error.message}`);
		});
		nextChild.stderr?.on('data', (chunk: Buffer | string) => {
			logSubprocessOutput({ chunk, logger: props.logger, streamName: 'stderr' });
		});
		nextChild.stderr?.on('error', (error: Error) => {
			props.logger.warn(`[mcp-portal stderr] stream error: ${error.message}`);
		});
		nextChild.on('error', (error: Error) => {
			props.logger.error(`[mcp-portal] subprocess spawn failed: ${error.message}`);
			if (failureHandled) {
				return;
			}
			failureHandled = true;
			if (child === nextChild) {
				child = null;
			}
			if (stopping) {
				return;
			}
			if (autoRestartEnabled) {
				void scheduleRestart();
			} else {
				rejectBeforeHealth(error);
			}
		});
		nextChild.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
			if (failureHandled) {
				return;
			}
			failureHandled = true;
			if (child === nextChild) {
				child = null;
			}
			if (stopping) {
				return;
			}
			if (autoRestartEnabled) {
				void scheduleRestart();
			} else {
				rejectBeforeHealth(
					new Error(
						`MCP Portal subprocess exited before health check completed (code=${String(code)} signal=${String(signal)}).`,
					),
				);
			}
		});
		return {
			child: nextChild,
			earlyFailure,
			enableAutoRestart: () => {
				autoRestartEnabled = true;
			},
		};
	};

	const spawnChildAndWaitForHealth = async (): Promise<void> => {
		const spawnedChild = spawnChild();
		try {
			await Promise.race([
				waitForHealth({
					fetchFn,
					host: props.host,
					intervalMs: healthPollIntervalMs,
					port: props.port,
					timeoutMs: healthTimeoutMs,
				}),
				spawnedChild.earlyFailure,
			]);
		} catch (error) {
			if (child === spawnedChild.child) {
				child = null;
				if (!spawnedChild.child.killed) {
					spawnedChild.child.kill('SIGTERM');
				}
			}
			throw error;
		}
		spawnedChild.enableAutoRestart();
		restartCount = 0;
		props.logger.info('[mcp-portal] subprocess is healthy.');
	};

	const scheduleRestart = async (): Promise<void> => {
		restartCount += 1;
		if (restartCount > maxRestarts) {
			props.logger.error('[mcp-portal] subprocess restart limit exhausted.');
			props.onFatal?.('backoff-exhausted');
			return;
		}
		const backoffIndex = Math.min(restartCount - 1, backoffSteps.length - 1);
		const backoffMs = backoffSteps[backoffIndex] ?? backoffSteps[backoffSteps.length - 1] ?? 5_000;
		props.logger.warn(`[mcp-portal] subprocess exited; restarting in ${String(backoffMs)}ms.`);
		await delay(backoffMs);
		if (stopping) {
			return;
		}
		try {
			await spawnChildAndWaitForHealth();
		} catch (error) {
			props.logger.error(`[mcp-portal] subprocess restart failed: ${errorMessage(error)}`);
			if (!stopping) {
				await scheduleRestart();
			}
		}
	};

	return {
		isAlive: () => child !== null && !child.killed,
		start: async () => {
			stopping = false;
			await spawnChildAndWaitForHealth();
		},
		stop: async () => {
			stopping = true;
			const activeChild = child;
			child = null;
			if (activeChild === null || activeChild.killed) {
				return;
			}
			activeChild.kill('SIGTERM');
			const exited = await waitForExit(activeChild, stopGraceMs);
			if (!exited && !activeChild.killed) {
				activeChild.kill('SIGKILL');
			}
		},
	};
}
