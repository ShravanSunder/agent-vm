import { spawn } from 'node:child_process';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

export type E2eProofLaneId = 'e2e-vm' | 'e2e-vm-mediation';

export interface E2eProofLane {
	readonly args: readonly string[];
	readonly command: string;
	readonly env: Readonly<Record<string, string>>;
	readonly id: E2eProofLaneId;
	readonly label: string;
}

export interface E2eProofLaneResult {
	readonly durationMs: number;
	readonly errorMessage?: string;
	readonly exitCode: number | null;
	readonly lane: E2eProofLane;
	readonly signal: string | null;
	readonly status: 'passed' | 'failed';
}

export interface E2eProofLaneSummary {
	readonly failedCount: number;
	readonly lines: readonly string[];
	readonly ok: boolean;
	readonly passedCount: number;
	readonly totalDurationMs: number;
}

export type E2eProofLaneRunner = (lane: E2eProofLane) => Promise<E2eProofLaneResult>;

interface RunE2eProofLanesOptions {
	readonly laneRunner?: E2eProofLaneRunner;
	readonly now?: () => number;
	readonly runWorkspaceBuild?: () => void;
	readonly stderr?: NodeJS.WritableStream;
	readonly stdout?: NodeJS.WritableStream;
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function createE2eProofLanes(): readonly E2eProofLane[] {
	return [
		{
			args: ['run', 'test:e2e:vm'],
			command: 'pnpm',
			env: { AGENT_VM_E2E_SKIP_WORKSPACE_BUILD: '1' },
			id: 'e2e-vm',
			label: 'Gondolin VM e2e',
		},
		{
			args: ['run', 'test:e2e:vm-mediation'],
			command: 'pnpm',
			env: { AGENT_VM_E2E_SKIP_WORKSPACE_BUILD: '1' },
			id: 'e2e-vm-mediation',
			label: 'HTTP mediation e2e',
		},
	];
}

function formatDuration(durationMs: number): string {
	return `${(durationMs / 1000).toFixed(2)}s`;
}

async function runWorkspaceBuildOnceAsync(): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		let spawnError: Error | undefined;
		const childProcess = spawn('pnpm', ['build'], {
			cwd: repositoryRoot,
			stdio: 'inherit',
		});
		childProcess.on('error', (error) => {
			spawnError = error;
		});
		childProcess.on('close', (exitCode, signal) => {
			if (spawnError !== undefined) {
				reject(spawnError);
				return;
			}
			if (exitCode === 0 && signal === null) {
				resolve();
				return;
			}
			reject(
				new Error(
					signal === null
						? `pnpm build exited with code ${String(exitCode)}.`
						: `pnpm build exited with signal ${signal}.`,
				),
			);
		});
	});
}

export async function runE2eProofLane(
	lane: E2eProofLane,
	now: () => number = () => performance.now(),
): Promise<E2eProofLaneResult> {
	const startTimeMs = now();
	return await new Promise<E2eProofLaneResult>((resolve) => {
		let spawnErrorMessage: string | undefined;
		const childProcess = spawn(lane.command, [...lane.args], {
			cwd: repositoryRoot,
			env: { ...process.env, ...lane.env },
			stdio: 'inherit',
		});
		childProcess.on('error', (error) => {
			spawnErrorMessage = error.message;
		});
		childProcess.on('close', (exitCode, signal) => {
			resolve({
				durationMs: now() - startTimeMs,
				...(spawnErrorMessage === undefined ? {} : { errorMessage: spawnErrorMessage }),
				exitCode,
				lane,
				signal,
				status:
					exitCode === 0 && signal === null && spawnErrorMessage === undefined
						? 'passed'
						: 'failed',
			});
		});
	});
}

export function summarizeE2eProofLaneResults(
	results: readonly E2eProofLaneResult[],
	totalDurationMs: number,
): E2eProofLaneSummary {
	const failedResults = results.filter((result) => result.status === 'failed');
	const passedCount = results.length - failedResults.length;
	const lines = [
		`e2e proof lanes: ${String(passedCount)} passed, ${String(failedResults.length)} failed in ${formatDuration(totalDurationMs)}`,
		...results.map((result) => {
			const marker = result.status === 'passed' ? 'PASS' : 'FAIL';
			const suffix =
				result.status === 'passed'
					? ''
					: result.exitCode === null
						? ` (${result.signal ?? result.errorMessage ?? 'no exit code'})`
						: ` (exit ${String(result.exitCode)})`;
			return `${marker} ${result.lane.id}: ${result.lane.label} ${formatDuration(result.durationMs)}${suffix}`;
		}),
	];
	return {
		failedCount: failedResults.length,
		lines,
		ok: failedResults.length === 0,
		passedCount,
		totalDurationMs,
	};
}

export async function runE2eProofLanes(
	lanes: readonly E2eProofLane[] = createE2eProofLanes(),
	options: RunE2eProofLanesOptions = {},
): Promise<E2eProofLaneSummary> {
	const now = options.now ?? (() => performance.now());
	const laneRunner = options.laneRunner ?? ((lane) => runE2eProofLane(lane));
	const stdout = options.stdout ?? process.stdout;
	const stderr = options.stderr ?? process.stderr;
	const startTimeMs = now();

	if (options.runWorkspaceBuild === undefined) {
		await runWorkspaceBuildOnceAsync();
	} else {
		options.runWorkspaceBuild();
	}

	const results = await Promise.all(lanes.map(async (lane) => await laneRunner(lane)));
	const summary = summarizeE2eProofLaneResults(results, now() - startTimeMs);
	const summaryStream = summary.ok ? stdout : stderr;
	summaryStream.write('\n');
	for (const line of summary.lines) {
		summaryStream.write(`${line}\n`);
	}
	return summary;
}

async function main(): Promise<void> {
	const summary = await runE2eProofLanes();
	if (!summary.ok) {
		process.exit(1);
	}
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	await main();
}
